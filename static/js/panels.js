/* Process / TCP connection / systemd service panels with in-page actions. */
(function () {
  "use strict";

  var S = window.SysMon;
  var PROC_INTERVAL = 5000;
  var CONN_INTERVAL = 5000;
  var SVC_INTERVAL = 15000;
  var svcCache = [];

  function debounce(fn, delay) {
    var timer = null;
    return function () {
      var args = arguments;
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () { timer = null; fn.apply(null, args); }, delay);
    };
  }

  /* ---------------- processes ---------------- */

  function loadProcesses() {
    var sortNode = S.el("proc-sort");
    var sort = sortNode ? sortNode.value : "cpu";
    return S.getJSON("/api/processes?limit=10&sort=" + encodeURIComponent(sort)).then(function (payload) {
      var body = S.el("proc-body");
      var rows = payload.processes || [];
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" class="text-secondary small">无数据</td></tr>';
        return;
      }
      var html = "";
      rows.forEach(function (row) {
        html += '<tr>' +
          '<td class="text-secondary small">' + row.pid + '</td>' +
          '<td class="text-truncate proc-name" title="' + S.escapeHtml(row.cmdline) + '">' + S.escapeHtml(row.name) + '</td>' +
          '<td class="text-secondary small">' + S.escapeHtml(row.username) + '</td>' +
          '<td class="text-end">' + S.fmtNum(row.cpu_percent, 1) + '%</td>' +
          '<td class="text-end">' + S.fmtNum(row.mem_percent, 1) + '%</td>' +
          '<td class="text-end text-nowrap">' +
          '<button class="btn btn-sm btn-outline-warning" data-proc="' + row.pid + '" data-proc-name="' + S.escapeHtml(row.name) + '">结束</button>' +
          '<button class="btn btn-sm btn-outline-danger ms-1" data-kill="' + row.pid + '" data-proc-name="' + S.escapeHtml(row.name) + '">强杀</button>' +
          '</td></tr>';
      });
      body.innerHTML = html;
      body.querySelectorAll("[data-proc]").forEach(function (button) {
        button.addEventListener("click", function () { signalProcess(button, "TERM"); });
      });
      body.querySelectorAll("[data-kill]").forEach(function (button) {
        button.addEventListener("click", function () { signalProcess(button, "KILL"); });
      });
      S.setText("proc-status", "更新于 " + new Date().toLocaleTimeString() + " · 系统共 " + payload.total + " 个进程");
    }).catch(function (err) {
      S.setText("proc-status", "加载失败: " + err.message);
    });
  }

  function signalProcess(button, sig) {
    var pid = Number(button.getAttribute("data-proc") || button.getAttribute("data-kill"));
    var name = button.getAttribute("data-proc-name") || "";
    var label = sig === "KILL" ? "强制杀死 (SIGKILL)" : "结束 (SIGTERM)";
    if (!window.confirm(label + " 进程 " + name + " (PID " + pid + ")？")) { return; }
    S.sendJSON("/api/processes/" + pid + "/signal", "POST", { signal: sig }).then(function (res) {
      if (res.alive) {
        S.toast("已发送 " + res.signal + "，PID " + pid + " 仍在运行（当前状态 " + res.status + "）", "warning");
      } else {
        S.toast("PID " + pid + " (" + name + ") 已退出", "success");
      }
      loadProcesses();
    }).catch(function (err) {
      S.toast("操作失败: " + err.message, "danger");
    });
  }

  /* ---------------- TCP connections ---------------- */

  function loadConnections() {
    return S.getJSON("/api/connections?limit=200").then(function (payload) {
      var summary = payload.summary || {};
      var summaryHtml = "";
      Object.keys(summary).sort().forEach(function (state) {
        summaryHtml += '<span class="badge text-bg-secondary conn-badge">' + S.escapeHtml(state) +
          ' <span class="badge text-bg-dark">' + summary[state] + '</span></span>';
      });
      S.el("conn-summary").innerHTML = summaryHtml;
      S.setText("conn-total", "共 " + payload.total + " 条" + (payload.truncated ? "（仅显示前 200）" : ""));

      var body = S.el("conn-body");
      var rows = payload.connections || [];
      var html = "";
      rows.forEach(function (row) {
        var badge = row.status === "ESTABLISHED" ? "text-bg-success"
          : (row.status === "LISTEN" ? "text-bg-info" : "text-bg-secondary");
        var closable = row.status !== "LISTEN" && row.remote_ip;
        var spec = [row.local_ip, row.local_port, row.remote_ip, row.remote_port, row.status].join("|");
        html += '<tr>' +
          '<td><span class="badge ' + badge + '">' + S.escapeHtml(row.status) + '</span></td>' +
          '<td class="small">' + S.escapeHtml((row.local_ip || "") + ":" + (row.local_port || "")) + '</td>' +
          '<td class="small text-secondary">' + (row.remote_ip ? S.escapeHtml(row.remote_ip + ":" + row.remote_port) : "-") + '</td>' +
          '<td class="small text-secondary text-truncate proc-name">' + S.escapeHtml(row.process || (row.pid ? "pid " + row.pid : "-")) + '</td>' +
          '<td class="text-end">' + (closable
            ? '<button class="btn btn-sm btn-outline-danger" data-close="' + S.escapeHtml(spec) + '">关闭</button>'
            : '<span class="text-secondary small">-</span>') +
          '</td></tr>';
      });
      body.innerHTML = html || '<tr><td colspan="5" class="text-secondary small">无连接</td></tr>';
      body.querySelectorAll("[data-close]").forEach(function (button) {
        button.addEventListener("click", function () { closeConnection(button.getAttribute("data-close")); });
      });
      S.setText("conn-status", (payload.destroy_supported === false
        ? "本内核不支持直接销毁连接（CONFIG_INET_DIAG_DESTROY 未启用），关闭时将改为结束所属进程 · "
        : "") + "更新于 " + new Date().toLocaleTimeString());
    }).catch(function (err) {
      S.setText("conn-status", "加载失败: " + err.message);
    });
  }

  function closeConnection(spec) {
    var parts = String(spec).split("|");
    var payload = {
      local_ip: parts[0] || null,
      local_port: parts[1] ? Number(parts[1]) : null,
      remote_ip: parts[2] || null,
      remote_port: parts[3] ? Number(parts[3]) : null,
      status: parts[4] || null
    };
    var label = payload.local_ip + ":" + payload.local_port + " → " + payload.remote_ip + ":" + payload.remote_port;
    if (!window.confirm("关闭 TCP 连接 " + label + "？\n（可能中断对方正在进行的会话）")) { return; }
    sendClose(payload, label, false);
  }

  function sendClose(payload, label, killOwner) {
    var body = {
      local_ip: payload.local_ip, local_port: payload.local_port,
      remote_ip: payload.remote_ip, remote_port: payload.remote_port,
      status: payload.status, mode: killOwner ? "kill-owner" : "destroy"
    };
    S.sendJSON("/api/connections/close", "POST", body).then(function (res) {
      if (res.mode === "kill-owner") {
        S.toast("已向 " + (res.owner_name || "进程") + " (PID " + res.owner_pid + ") 发送 " + res.signal +
          (res.checked ? "，连接已断开" : "，但连接仍在"), res.checked ? "success" : "warning");
        loadConnections();
        return;
      }
      if (res.checked) {
        S.toast("连接已关闭: " + label, "success");
        loadConnections();
        return;
      }
      if (res.destroy_supported === false) {
        var owner = (res.owner_name || "未知进程") + (res.owner_pid ? " (PID " + res.owner_pid + ")" : "");
        if (res.owner_pid && window.confirm("本内核未启用 CONFIG_INET_DIAG_DESTROY，无法直接销毁连接。\n是否结束占用该连接的进程 " + owner + "？")) {
          sendClose(payload, label, true);
          return;
        }
        S.toast("内核不支持直接关闭连接，已取消", "warning");
        return;
      }
      S.toast("已发送关闭请求，但连接仍然存在", "warning");
      loadConnections();
    }).catch(function (err) {
      S.toast("关闭失败: " + err.message, "danger");
    });
  }

  /* ---------------- systemd services ---------------- */

  function loadServices() {
    var searchNode = S.el("svc-search");
    var query = searchNode ? searchNode.value.trim() : "";
    return S.getJSON("/api/services?limit=400&query=" + encodeURIComponent(query)).then(function (payload) {
      svcCache = payload.services || [];
      renderServices();
      S.setText("svc-status", "共 " + payload.total + " 个服务" + (payload.truncated ? "（仅显示前 400）" : "") +
        " · 更新于 " + new Date().toLocaleTimeString());
    }).catch(function (err) {
      S.setText("svc-status", "加载失败: " + err.message);
    });
  }

  function renderServices() {
    var body = S.el("svc-body");
    var html = "";
    svcCache.forEach(function (svc) {
      var badge = svc.active === "active" ? "text-bg-success"
        : (svc.active === "failed" ? "text-bg-danger" : "text-bg-secondary");
      html += '<tr>' +
        '<td class="text-truncate svc-name" title="' + S.escapeHtml(svc.description || svc.unit) + '"><code>' + S.escapeHtml(svc.unit) + '</code></td>' +
        '<td><span class="badge ' + badge + '">' + S.escapeHtml((svc.active || "?") + " / " + (svc.sub || "?")) + '</span></td>' +
        '<td class="small text-secondary">' + S.escapeHtml(svc.file_state || "-") + '</td>' +
        '<td class="text-end text-nowrap">' +
        '<button class="btn btn-sm btn-outline-success me-1" data-svc="' + S.escapeHtml(svc.unit) + '" data-action="start">启动</button>' +
        '<button class="btn btn-sm btn-outline-warning me-1" data-svc="' + S.escapeHtml(svc.unit) + '" data-action="restart">重启</button>' +
        '<button class="btn btn-sm btn-outline-danger" data-svc="' + S.escapeHtml(svc.unit) + '" data-action="stop">停止</button>' +
        '</td></tr>';
    });
    body.innerHTML = html || '<tr><td colspan="4" class="text-secondary small">无匹配服务</td></tr>';
    body.querySelectorAll("[data-svc]").forEach(function (button) {
      button.addEventListener("click", function () {
        serviceAction(button.getAttribute("data-svc"), button.getAttribute("data-action"));
      });
    });
  }

  function serviceAction(unit, action) {
    var labels = { start: "启动", stop: "停止", restart: "重启" };
    var label = labels[action] || action;
    if (!window.confirm(label + " 服务 " + unit + "？")) { return; }
    S.sendJSON("/api/services/" + encodeURIComponent(unit) + "/action", "POST", { action: action }).then(function (res) {
      S.toast(unit + " " + label + (res.ok ? "成功" : "失败: " + (res.output || "未知错误")), res.ok ? "success" : "danger");
      setTimeout(loadServices, 600);
    }).catch(function (err) {
      S.toast("操作失败: " + err.message, "danger");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    S.el("proc-refresh").addEventListener("click", loadProcesses);
    S.el("proc-sort").addEventListener("change", loadProcesses);
    S.el("conn-refresh").addEventListener("click", loadConnections);
    S.el("svc-refresh").addEventListener("click", loadServices);
    S.el("svc-search").addEventListener("input", debounce(loadServices, 350));

    loadProcesses();
    loadConnections();
    loadServices();

    setInterval(function () { if (!document.hidden) { loadProcesses(); } }, PROC_INTERVAL);
    setInterval(function () { if (!document.hidden) { loadConnections(); } }, CONN_INTERVAL);
    setInterval(function () { if (!document.hidden) { loadServices(); } }, SVC_INTERVAL);
  });
})();

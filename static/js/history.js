/* History page: range queries, trend chart and alert rule management. */
(function () {
  "use strict";

  var S = window.SysMon;
  var chart = null;
  var palette = ["#38bdf8", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];
  var meta = null;

  function isoFromRange(seconds) {
    var now = new Date();
    var start = new Date(now.getTime() - seconds * 1000);
    var local = new Date(start.getTime() - start.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function nowLocalIso() {
    var now = new Date();
    var local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }

  function applyRange(seconds) {
    S.el("start-time").value = isoFromRange(seconds);
    S.el("end-time").value = nowLocalIso();
  }

  function selectedMetrics() {
    var select = S.el("metric-select");
    return Array.prototype.slice.call(select.selectedOptions, 0, 3).map(function (opt) { return opt.value; });
  }

  function buildChart() {
    if (typeof echarts === "undefined") { return; }
    chart = echarts.init(S.el("chart-history"));
    var option = S.lineChartDefaults();
    option.xAxis.type = "time";   // history points are [timestamp, value]
    option.series = [];
    chart.setOption(option);
    window.addEventListener("resize", function () { if (chart) { chart.resize(); } });
  }

  function query() {
    var metrics = selectedMetrics();
    S.setText("query-status", "查询中…");
    if (!metrics.length) { S.setText("query-status", "请选择至少一个指标"); return; }
    var start = S.el("start-time").value;
    var end = S.el("end-time").value;
    var startMs = start ? new Date(start).getTime() : null;
    var endMs = end ? new Date(end).getTime() : null;

    var series = [];
    Promise.all(metrics.map(function (metric, index) {
      var url = "/api/history?metric=" + encodeURIComponent(metric) + "&limit=2000";
      if (startMs) { url += "&start=" + startMs; }
      if (endMs) { url += "&end=" + endMs; }
      return S.getJSON(url).then(function (data) { return { metric: metric, data: data, color: palette[index % palette.length] }; });
    })).then(function (results) {
      results.forEach(function (entry) {
        var points = entry.data.points || [];
        series.push({
          name: entry.metric,
          type: "line",
          smooth: true,
          showSymbol: false,
          data: points,
          lineStyle: { width: 2, color: entry.color },
          itemStyle: { color: entry.color }
        });
      });
      var first = results[0] ? results[0].data : null;
      if (first) {
        S.setText("chart-range", S.fmtClock(first.start) + " → " + S.fmtClock(first.end) + "（" + first.total + " 条原始样本）");
      }
      // Merge, never notMerge: replacing the option drops the axes and makes
      // ECharts 5.5 throw when the x axis type is set afterwards.
      chart.setOption({
        series: series,
        tooltip: {
          trigger: "axis",
          formatter: function (params) {
            if (!params || !params.length) { return ""; }
            var lines = [S.fmtClock(params[0].value[0])];
            params.forEach(function (item) {
              lines.push(item.marker + " " + item.seriesName + ": " + S.fmtNum(item.value[1], 2));
            });
            return lines.join("<br>");
          }
        }
      });
      S.setText("query-status", "完成 · " + series.length + " 个序列");
    }).catch(function (err) {
      S.setText("query-status", "查询失败: " + err.message);
    });
  }

  function renderRules(payload) {
    var body = S.el("rules-body");
    var html = "";
    (payload.rules || []).forEach(function (rule) {
      html += '<tr class="rule-row">' +
        '<td>' + rule.id + '</td>' +
        '<td><code>' + S.escapeHtml(rule.metric) + '</code></td>' +
        '<td>' + S.escapeHtml(rule.op) + ' ' + S.escapeHtml(rule.threshold) + '</td>' +
        '<td>' + rule.duration_s + '</td>' +
        '<td>' + (rule.enabled ? '<span class="badge text-bg-success">开</span>' : '<span class="badge text-bg-secondary">关</span>') + '</td>' +
        '<td class="text-secondary small">' + S.escapeHtml(rule.note) + '</td>' +
        '<td class="text-end text-nowrap">' +
        '<button class="btn btn-sm btn-outline-light me-1" data-toggle="' + rule.id + '" data-enabled="' + (rule.enabled ? "1" : "0") + '">' + (rule.enabled ? "停用" : "启用") + '</button>' +
        '<button class="btn btn-sm btn-outline-danger" data-delete="' + rule.id + '">删除</button>' +
        '</td></tr>';
    });
    body.innerHTML = html || '<tr><td colspan="7" class="text-secondary small">暂无规则</td></tr>';

    body.querySelectorAll("[data-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var id = Number(button.getAttribute("data-toggle"));
        var enabled = button.getAttribute("data-enabled") === "1";
        S.sendJSON("/api/alerts/" + id, "PATCH", { enabled: !enabled }).then(loadRules).catch(showError);
      });
    });
    body.querySelectorAll("[data-delete]").forEach(function (button) {
      button.addEventListener("click", function () {
        var id = Number(button.getAttribute("data-delete"));
        if (!window.confirm("删除规则 #" + id + "？")) { return; }
        S.sendJSON("/api/alerts/" + id, "DELETE").then(loadRules).catch(showError);
      });
    });
  }

  function showError(err) {
    S.setText("rules-status", "错误: " + (err && err.message ? err.message : err));
  }

  function loadRules() {
    return S.getJSON("/api/alerts").then(function (payload) {
      renderRules(payload);
      S.setText("rules-status", (payload.rules || []).length + " 条规则");
    }).catch(showError);
  }

  function fillOptions() {
    return S.getJSON("/api/meta").then(function (payload) {
      meta = payload;
      var metricSelect = S.el("metric-select");
      metricSelect.innerHTML = payload.metrics.map(function (name) {
        return '<option value="' + S.escapeHtml(name) + '">' + S.escapeHtml(name) + '</option>';
      }).join("");
      ["cpu.total", "mem.percent", "net.down_bps"].forEach(function (name) {
        var option = metricSelect.querySelector('option[value="' + name + '"]');
        if (option) { option.selected = true; }
      });

      S.el("rule-metric").innerHTML = payload.alert_metrics.map(function (name) {
        return '<option value="' + S.escapeHtml(name) + '">' + S.escapeHtml(name) + '</option>';
      }).join("");
      S.el("rule-op").innerHTML = payload.operators.map(function (op) {
        return '<option value="' + S.escapeHtml(op) + '">' + S.escapeHtml(op) + '</option>';
      }).join("");
    });
  }

  function addRule(event) {
    event.preventDefault();
    var payload = {
      metric: S.el("rule-metric").value,
      op: S.el("rule-op").value,
      threshold: Number(S.el("rule-threshold").value),
      duration_s: Number(S.el("rule-duration").value || 0),
      note: S.el("rule-note").value,
      enabled: true
    };
    S.sendJSON("/api/alerts", "POST", payload).then(function () {
      S.el("rule-note").value = "";
      S.setText("form-error", "已添加");
      loadRules();
    }).catch(function (err) { S.setText("form-error", "添加失败: " + err.message); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    buildChart();
    applyRange(3600);
    document.querySelectorAll("#range-presets button").forEach(function (button) {
      button.addEventListener("click", function () { applyRange(Number(button.getAttribute("data-range"))); });
    });
    S.el("query-btn").addEventListener("click", query);
    S.el("rule-form").addEventListener("submit", addRule);
    fillOptions().then(function () { loadRules(); query(); }).catch(showError);
  });
})();

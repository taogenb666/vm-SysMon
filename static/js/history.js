/* History page: range queries, trend chart and alert rule management. */
(function () {
  "use strict";

  var S = window.SysMon;
  var chart = null;
  var palette = ["#38bdf8", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];
  var meta = null;

  // The API returns raw numbers, so every metric is mapped to a unit kind and
  // rendered with its own formatter (axis labels, tooltip and legend).
  var UNIT_KINDS = {
    "cpu.total": "percent", "mem.percent": "percent", "swap.percent": "percent", "gpu.util": "percent",
    "mem.total": "bytes", "mem.used": "bytes", "mem.avail": "bytes", "mem.cached": "bytes",
    "swap.total": "bytes", "swap.used": "bytes",
    "disk.read_bps": "rate", "disk.write_bps": "rate", "net.up_bps": "rate", "net.down_bps": "rate",
    "gpu.mem_used": "mbytes", "gpu.mem_total": "mbytes",
    "cpu.temp": "temp", "gpu.temp": "temp", "gpu.power": "power", "fan.rpm": "rpm",
    "load.1": "load", "load.5": "load", "load.15": "load",
    "disk.read_iops": "iops", "disk.write_iops": "iops",
    "sys.uptime": "duration",
    "sys.proc_count": "count", "sys.user_count": "count", "net.conns": "count"
  };
  var UNIT_LABELS = {
    percent: "%", bytes: "B", rate: "B/s", mbytes: "MB", temp: "°C", power: "W",
    rpm: "RPM", load: "load", iops: "IOPS", duration: "时长", count: "个", plain: ""
  };
  var seriesMetric = {};

  function unitKind(metric) { return UNIT_KINDS[metric] || "plain"; }

  function formatValue(metric, value) {
    if (value === null || value === undefined || isNaN(value)) { return "--"; }
    var kind = unitKind(metric);
    if (kind === "percent") { return S.fmtNum(value, 1) + "%"; }
    if (kind === "bytes") { return S.fmtBytes(value, 1); }
    if (kind === "rate") { return S.fmtBps(value); }
    if (kind === "mbytes") { return S.fmtNum(value, 1) + " MB"; }
    if (kind === "temp") { return S.fmtNum(value, 1) + " °C"; }
    if (kind === "power") { return S.fmtNum(value, 1) + " W"; }
    if (kind === "rpm") { return S.fmtNum(value, 0) + " RPM"; }
    if (kind === "duration") { return S.fmtDuration(value); }
    if (kind === "count") { return S.fmtNum(value, 0); }
    if (kind === "iops") { return S.fmtNum(value, 2) + " IOPS"; }
    if (kind === "load") { return S.fmtNum(value, 2); }
    return S.fmtNum(value, 2);
  }

  function axisLabel(kind, value) {
    if (kind === "percent") { return S.fmtNum(value, 0) + "%"; }
    if (kind === "bytes" || kind === "rate") { return S.fmtBytes(value, 0); }
    if (kind === "mbytes") { return S.fmtNum(value, 0) + "M"; }
    if (kind === "temp") { return S.fmtNum(value, 0) + "°"; }
    if (kind === "power") { return S.fmtNum(value, 0) + "W"; }
    if (kind === "count") { return S.fmtNum(value, 0); }
    if (kind === "duration") { return S.fmtDuration(value); }
    return value;
  }

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
    option.xAxis.type = "time";        // history points are [timestamp, value]
    option.yAxis = [option.yAxis];     // array form: a query may add a second axis
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
      seriesMetric = {};
      var kinds = [];
      results.forEach(function (entry) {
        var kind = unitKind(entry.metric);
        if (kinds.indexOf(kind) === -1) { kinds.push(kind); }
      });
      results.forEach(function (entry) {
        var kind = unitKind(entry.metric);
        var label = UNIT_LABELS[kind];
        var name = label ? entry.metric + " (" + label + ")" : entry.metric;
        seriesMetric[name] = entry.metric;
        series.push({
          name: name,
          type: "line",
          smooth: true,
          showSymbol: false,
          yAxisIndex: kinds.indexOf(kind) === 0 ? 0 : 1,
          data: entry.data.points || [],
          lineStyle: { width: 2, color: entry.color },
          itemStyle: { color: entry.color }
        });
      });
      var first = results[0] ? results[0].data : null;
      if (first) {
        S.setText("chart-range", S.fmtClock(first.start) + " → " + S.fmtClock(first.end) + "（" + first.total + " 条原始样本）");
      }
      var axes = [{
        type: "value",
        name: UNIT_LABELS[kinds[0]] || "",
        nameTextStyle: { color: "#94a3b8" },
        scale: kinds[0] !== "percent",
        axisLabel: { color: "#94a3b8", formatter: function (value) { return axisLabel(kinds[0], value); } }
      }];
      if (kinds.length > 1) {
        axes.push({
          type: "value",
          position: "right",
          name: UNIT_LABELS[kinds[1]] || "",
          nameTextStyle: { color: "#94a3b8" },
          scale: true,
          axisLabel: { color: "#94a3b8", formatter: function (value) { return axisLabel(kinds[1], value); } }
        });
      }
      // replaceMerge (never notMerge) discards series and axes that are no
      // longer selected, while the base option's grid and time axis survive.
      chart.setOption({
        series: series,
        yAxis: axes,
        tooltip: {
          trigger: "axis",
          formatter: function (params) {
            if (!params || !params.length) { return ""; }
            var lines = [S.fmtClock(params[0].value[0])];
            params.forEach(function (item) {
              var metric = seriesMetric[item.seriesName] || item.seriesName;
              lines.push(item.marker + " " + item.seriesName + ": " + formatValue(metric, item.value[1]));
            });
            return lines.join("<br>");
          }
        }
      }, { replaceMerge: ["series", "yAxis"] });
      S.setText("query-status", "完成 · " + series.length + " 个序列" + (kinds.length > 1 ? "（左右双轴，各自单位）" : ""));
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

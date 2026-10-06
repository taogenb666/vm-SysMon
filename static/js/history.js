/* History page: range queries, trend chart and alert rule management. */
(function () {
  "use strict";

  var S = window.SysMon;
  var chart = null;
  var palette = ["#38bdf8", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];
  var meta = null;

  // Each group keeps its own hue family, so a whole category still reads as
  // "one colour world". Only four, deliberately far-apart shades are used per
  // family: eight shades of one hue could not be told apart (the previous set
  // had a closest pair distance of 26/255). Once the shades run out, the dash
  // style changes instead, so no two curves ever look identical.
  var GROUP_STYLES = {
    "CPU":  ["#38bdf8", "#1d4ed8", "#a5f3fc", "#312e81"],
    "内存": ["#a855f7", "#4c1d95", "#f0abfc", "#c026d3"],
    "磁盘": ["#f59e0b", "#78350f", "#fde047", "#ea580c"],
    "网络": ["#22c55e", "#14532d", "#a3e635", "#14b8a6"],
    "GPU":  ["#ef4444", "#7f1d1d", "#fb7185", "#f97316"],
    "系统": ["#94a3b8", "#1e293b", "#e2e8f0"],
    "其他": ["#e2e8f0", "#64748b"]
  };
  var LINE_TYPES = ["solid", "dashed", "dotted"];
  var metricStyle = {};

  function buildMetricColors(groups) {
    (groups || []).forEach(function (group) {
      var shades = GROUP_STYLES[group.label] || GROUP_STYLES["其他"];
      (group.metrics || []).forEach(function (name, index) {
        metricStyle[name] = {
          color: shades[index % shades.length],
          // A second lap through the same shade switches the dash style.
          type: LINE_TYPES[Math.floor(index / shades.length) % LINE_TYPES.length]
        };
      });
    });
  }
  function styleFor(metric, fallbackIndex) {
    return metricStyle[metric] || { color: palette[fallbackIndex % palette.length], type: "solid" };
  }

  // Options with no samples stay in the list but are greyed out: the same build
  // may well have data for them on another host (GPU, hwmon sensors, ...).
  function optionGroupsHtml(groups, counts, ready) {
    return (groups || []).map(function (group) {
      return '<optgroup label="' + S.escapeHtml(group.label) + '">' +
        (group.metrics || []).map(function (name) {
          var missing = !!(ready && counts &&
            Object.prototype.hasOwnProperty.call(counts, name) && counts[name] === 0);
          return '<option value="' + S.escapeHtml(name) + '"' + (missing ? ' disabled' : '') + '>' +
            S.escapeHtml(name) + (missing ? '（无数据）' : '') + '</option>';
        }).join("") +
        '</optgroup>';
    }).join("");
  }

  // Clicking a category plots every metric of that category at once. Groups
  // whose metrics all lack samples here stay visible but disabled, exactly like
  // the individual options do.
  function renderGroupButtons(groups, counts, ready) {
    var host = S.el("group-buttons");
    if (!host) { return; }
    host.innerHTML = (groups || []).map(function (group) {
      var usable = (group.metrics || []).filter(function (name) {
        return !(ready && counts && Object.prototype.hasOwnProperty.call(counts, name) && counts[name] === 0);
      });
      var disabled = usable.length === 0;
      return '<button type="button" class="btn btn-sm btn-outline-info" data-group="' +
        S.escapeHtml(group.label) + '"' + (disabled ? ' disabled title="本机无数据"' : '') + '>' +
        S.escapeHtml(group.label) + ' <span class="text-secondary">' + usable.length + '</span></button>';
    }).join("");
    host.querySelectorAll("[data-group]").forEach(function (button) {
      button.addEventListener("click", function () { selectGroup(button.getAttribute("data-group")); });
    });
  }

  function selectGroup(label) {
    var select = S.el("metric-select");
    var wanted = [];
    Array.prototype.forEach.call(select.querySelectorAll("optgroup"), function (group) {
      if (group.getAttribute("label") !== label) { return; }
      Array.prototype.forEach.call(group.querySelectorAll("option"), function (option) {
        if (!option.disabled) { wanted.push(option.value); }
      });
    });
    Array.prototype.forEach.call(select.options, function (option) {
      option.selected = wanted.indexOf(option.value) !== -1;
    });
    query();
  }

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
    return Array.prototype.slice.call(select.selectedOptions, 0, 12).map(function (opt) { return opt.value; });
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
      return S.getJSON(url).then(function (data) { return { metric: metric, data: data, style: styleFor(metric, index) }; });
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
          yAxisIndex: kinds.indexOf(kind),
          data: entry.data.points || [],
          lineStyle: { width: 2, color: entry.style.color, type: entry.style.type },
          itemStyle: { color: entry.style.color }
        });
      });
      var first = results[0] ? results[0].data : null;
      if (first) {
        S.setText("chart-range", S.fmtClock(first.start) + " → " + S.fmtClock(first.end) + "（" + first.total + " 条原始样本）");
      }
      // One axis per unit kind, alternating sides and offset when a whole
      // category brings several units at once (CPU can span % / load / °C / RPM).
      var axes = kinds.map(function (kind, index) {
        return {
          type: "value",
          position: index % 2 === 0 ? "left" : "right",
          offset: Math.floor(index / 2) * 46,
          name: UNIT_LABELS[kind] || "",
          nameTextStyle: { color: "#94a3b8" },
          scale: kind !== "percent",
          axisLabel: { color: "#94a3b8", formatter: function (value) { return axisLabel(kind, value); } }
        };
      });
      var leftAxes = 0;
      var rightAxes = 0;
      kinds.forEach(function (kind, index) { if (index % 2 === 0) { leftAxes++; } else { rightAxes++; } });
      var grid = {
        left: 52 + Math.max(0, leftAxes - 1) * 46,
        right: 20 + (rightAxes ? 46 + Math.max(0, rightAxes - 1) * 46 : 0),
        top: 34,
        bottom: 30
      };
      // replaceMerge (never notMerge) discards series and axes that are no
      // longer selected, while the base option's time axis survives.
      chart.setOption({
        grid: grid,
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
      }, { replaceMerge: ["series", "yAxis", "grid"] });
      S.setText("query-status", "完成 · " + series.length + " 个序列 · " + kinds.length + " 个单位轴");
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
      var groups = payload.metric_groups || [{ label: "指标", metrics: payload.metrics || [] }];
      var counts = payload.metric_samples || {};
      // Too few samples means the collector just started: nothing is greyed yet.
      var ready = (payload.total_samples || 0) >= 20;
      buildMetricColors(groups);
      metricSelect.innerHTML = optionGroupsHtml(groups, counts, ready);
      renderGroupButtons(groups, counts, ready);
      ["cpu.total", "mem.percent", "net.down_bps"].forEach(function (name) {
        var option = metricSelect.querySelector('option[value="' + name + '"]');
        if (option) { option.selected = true; }
      });
      if (!metricSelect.selectedOptions.length) {
        var firstEnabled = metricSelect.querySelector("option:not([disabled])");
        if (firstEnabled) { firstEnabled.selected = true; }
      }

      var alertGroups = payload.alert_metric_groups || [{ label: "指标", metrics: payload.alert_metrics || [] }];
      S.el("rule-metric").innerHTML = optionGroupsHtml(alertGroups, counts, ready);
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

    // There is no query button any more: every control re-queries on its own.
    document.querySelectorAll("#range-presets button").forEach(function (button) {
      button.addEventListener("click", function () {
        applyRange(Number(button.getAttribute("data-range")));
        query();
      });
    });
    ["start-time", "end-time"].forEach(function (id) {
      S.el(id).addEventListener("change", function () { query(); });
    });

    // Clicking a metric renders it straight away. The tiny delay only coalesces
    // the rapid events of a Ctrl+click multi-select into one request.
    var pending = null;
    S.el("metric-select").addEventListener("change", function () {
      if (pending) { clearTimeout(pending); }
      pending = setTimeout(function () { pending = null; query(); }, 120);
    });

    S.el("rule-form").addEventListener("submit", addRule);
    fillOptions().then(function () { loadRules(); query(); }).catch(showError);
  });
})();

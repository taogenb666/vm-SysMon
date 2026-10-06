/* Real-time dashboard: consumes the live stream and renders cards + charts. */
(function () {
  "use strict";

  var S = window.SysMon;
  var WINDOW_POINTS = 150;
  var state = { time: [], cpu: [], mem: [], up: [], down: [] };
  var cpuChart = null;
  var netChart = null;
  var socket = null;
  var events = null;
  var retries = 0;
  var reconnectTimer = null;

  function setConn(text, cls) {
    var node = S.el("conn-state");
    if (!node) { return; }
    node.textContent = text;
    node.className = "badge " + cls;
  }

  function initCharts() {
    if (typeof echarts === "undefined") { return; }
    cpuChart = echarts.init(S.el("chart-cpu"));
    netChart = echarts.init(S.el("chart-net"));

    var cpuOption = S.lineChartDefaults();
    cpuOption.yAxis.max = 100;
    cpuOption.series = [
      { name: "CPU %", type: "line", smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.18 }, lineStyle: { width: 2, color: "#38bdf8" }, itemStyle: { color: "#38bdf8" } },
      { name: "内存 %", type: "line", smooth: true, showSymbol: false, data: [], lineStyle: { width: 2, color: "#a855f7" }, itemStyle: { color: "#a855f7" } }
    ];
    cpuChart.setOption(cpuOption);

    var netOption = S.lineChartDefaults();
    netOption.yAxis.axisLabel.formatter = function (value) { return S.fmtBytes(value, 0); };
    netOption.series = [
      { name: "下载", type: "line", smooth: true, showSymbol: false, data: [], areaStyle: { opacity: 0.18 }, lineStyle: { width: 2, color: "#22c55e" }, itemStyle: { color: "#22c55e" } },
      { name: "上传", type: "line", smooth: true, showSymbol: false, data: [], lineStyle: { width: 2, color: "#f59e0b" }, itemStyle: { color: "#f59e0b" } }
    ];
    netChart.setOption(netOption);

    window.addEventListener("resize", function () {
      if (cpuChart) { cpuChart.resize(); }
      if (netChart) { netChart.resize(); }
    });
  }

  function pushSeries(snapshot) {
    var label = S.fmtShortTime(snapshot.ts);
    state.time.push(label);
    state.cpu.push((snapshot.cpu || {}).total || 0);
    state.mem.push((snapshot.memory || {}).percent || 0);
    state.up.push((snapshot.net || {}).total_up_bps || 0);
    state.down.push((snapshot.net || {}).total_down_bps || 0);

    Object.keys(state).forEach(function (key) {
      while (state[key].length > WINDOW_POINTS) { state[key].shift(); }
    });

    if (cpuChart) {
      cpuChart.setOption({
        xAxis: { data: state.time },
        series: [{ data: state.cpu }, { data: state.mem }]
      });
    }
    if (netChart) {
      netChart.setOption({
        xAxis: { data: state.time },
        series: [{ data: state.down }, { data: state.up }]
      });
    }
  }

  function renderSystem(system) {
    if (!system) { return; }
    S.setText("sys-host", system.hostname);
    S.setText("sys-hostname", system.hostname);
    S.setText("sys-distro", system.distro);
    S.setText("sys-kernel", system.kernel);
    S.setText("sys-arch", system.arch);
    S.setText("sys-uptime", S.fmtDuration(system.uptime));
    S.setText("sys-procs", system.proc_count + " / " + (system.users ? system.users.length : 0));
    S.setText("sys-users", (system.user_count || 0) + " 人");
  }

  function renderCpu(cpu) {
    if (!cpu) { return; }
    S.setText("cpu-total", S.fmtNum(cpu.total, 1));
    S.setProgress("cpu-bar", cpu.total);
    S.setText("cpu-cores", (cpu.cores_physical || "?") + "C / " + (cpu.cores_logical || "?") + "T");
    var load = cpu.load || [];
    S.setText("cpu-load", load.map(function (v) { return S.fmtNum(v, 2); }).join(" / "));
    S.setText("cpu-temp", cpu.temp_c === null ? "无传感器" : S.fmtNum(cpu.temp_c, 1) + " °C");
    S.setText("cpu-freq", cpu.freq_mhz === null ? "--" : S.fmtNum(cpu.freq_mhz, 0) + " MHz");
    S.sparkBars("core-bars", cpu.per_core, 100);
  }

  function renderMemory(memory) {
    if (!memory) { return; }
    S.setText("mem-percent", S.fmtNum(memory.percent, 1));
    S.setProgress("mem-bar", memory.percent);
    S.setText("mem-total", S.fmtBytes(memory.total));
    S.setText("mem-used", S.fmtBytes(memory.used));
    S.setText("mem-avail", S.fmtBytes(memory.available));
    S.setText("mem-cached", S.fmtBytes(memory.cached) + " / " + S.fmtBytes(memory.buffers));
    var swap = memory.swap || {};
    S.setText("swap-text", S.fmtBytes(swap.used) + " / " + S.fmtBytes(swap.total));
    S.setProgress("swap-bar", swap.percent);
  }

  function renderGpu(gpu) {
    var body = S.el("gpu-body");
    if (!body) { return; }
    if (!gpu) { body.innerHTML = '<div class="text-secondary small">无数据</div>'; return; }
    S.setText("gpu-source", gpu.source || "--");
    if (!gpu.available) {
      var name = gpu.name ? S.escapeHtml(gpu.name) : "未检测到独立 GPU";
      body.innerHTML = '<div class="text-secondary small">' + name + '</div>' +
        '<div class="kv mt-2"><span>状态</span><span>无可用遥测</span></div>';
      return;
    }
    var memPct = (gpu.mem_total_mb && gpu.mem_used_mb) ? (gpu.mem_used_mb / gpu.mem_total_mb) * 100 : 0;
    body.innerHTML =
      '<div class="text-secondary small text-truncate" title="' + S.escapeHtml(gpu.name) + '">' + S.escapeHtml(gpu.name) + '</div>' +
      '<div class="metric-big mt-1"><span>' + S.fmtNum(gpu.util_percent, 0) + '</span><small>% 使用率</small></div>' +
      '<div class="progress metric-bar"><div class="progress-bar ' + S.barClass(gpu.util_percent) + '" style="width:' + Math.min(100, gpu.util_percent || 0) + '%"></div></div>' +
      '<div class="kv"><span>显存</span><span>' + S.fmtBytes((gpu.mem_used_mb || 0) * 1048576) + ' / ' + S.fmtBytes((gpu.mem_total_mb || 0) * 1048576) + '</span></div>' +
      '<div class="kv"><span>温度</span><span>' + (gpu.temp_c === null ? "--" : S.fmtNum(gpu.temp_c, 0) + " °C") + '</span></div>' +
      '<div class="kv"><span>功耗</span><span>' + (gpu.power_w === null ? "--" : S.fmtNum(gpu.power_w, 0) + " W") + (gpu.power_limit_w ? " / " + S.fmtNum(gpu.power_limit_w, 0) + " W" : "") + '</span></div>' +
      '<div class="progress metric-bar thin"><div class="progress-bar bg-info" style="width:' + Math.min(100, memPct).toFixed(1) + '%"></div></div>';
  }

  function renderDisks(disks, diskIo) {
    if (diskIo) {
      S.setText("disk-read", S.fmtBytes(diskIo.read_bps, 1));
      S.setText("disk-write", S.fmtBytes(diskIo.write_bps, 1));
      S.setText("disk-iops", S.fmtNum(diskIo.read_iops, 1) + " / " + S.fmtNum(diskIo.write_iops, 1));
    }
    var list = S.el("disk-list");
    if (!list) { return; }
    var html = "";
    (disks || []).forEach(function (disk) {
      html += '<div class="mt-2">' +
        '<div class="kv"><span class="text-truncate" title="' + S.escapeHtml(disk.mountpoint) + '">' + S.escapeHtml(disk.mountpoint) + '</span>' +
        '<span>' + S.fmtBytes(disk.used) + ' / ' + S.fmtBytes(disk.total) + '</span></div>' +
        '<div class="progress metric-bar thin"><div class="progress-bar ' + S.barClass(disk.percent) + '" style="width:' + Math.min(100, disk.percent || 0) + '%"></div></div>' +
        '</div>';
    });
    list.innerHTML = html || '<div class="text-secondary small">无分区</div>';
  }

  function renderNet(net) {
    if (!net) { return; }
    S.setText("net-conns", "连接数 " + (net.connections === null ? "--" : net.connections));
    var body = S.el("net-table");
    if (!body) { return; }
    var html = "";
    (net.interfaces || []).forEach(function (iface) {
      html += '<tr>' +
        '<td>' + S.escapeHtml(iface.name) + '</td>' +
        '<td class="text-secondary small">' + S.escapeHtml((iface.addresses || []).join(", ") || "-") + '</td>' +
        '<td class="text-end text-warning">' + S.fmtBps(iface.up_bps) + '</td>' +
        '<td class="text-end text-success">' + S.fmtBps(iface.down_bps) + '</td>' +
        '<td class="text-end text-secondary small">' + S.fmtBytes(iface.bytes_sent) + ' / ' + S.fmtBytes(iface.bytes_recv) + '</td>' +
        '</tr>';
    });
    body.innerHTML = html || '<tr><td colspan="5" class="text-secondary small">无网卡</td></tr>';
  }

  function renderSensors(sensors) {
    var body = S.el("sensors-body");
    if (!body) { return; }
    var html = "";
    (sensors.temperatures || []).forEach(function (temp) {
      html += '<tr><td>' + S.escapeHtml(temp.chip) + '</td><td class="text-secondary small">' + S.escapeHtml(temp.label) + '</td>' +
        '<td class="text-end">' + S.fmtNum(temp.current, 1) + ' °C</td>' +
        '<td class="text-end text-secondary small">' + S.fmtNum(temp.high, 0) + ' / ' + S.fmtNum(temp.critical, 0) + '</td></tr>';
    });
    (sensors.fans || []).forEach(function (fan) {
      html += '<tr><td>' + S.escapeHtml(fan.chip) + '</td><td class="text-secondary small">' + S.escapeHtml(fan.label) + '</td>' +
        '<td class="text-end">' + S.fmtNum(fan.rpm, 0) + ' RPM</td><td class="text-end text-secondary small">-</td></tr>';
    });
    body.innerHTML = html || '<tr><td colspan="4" class="text-secondary small">无传感器数据</td></tr>';
  }

  function renderAlerts(alerts) {
    var body = S.el("alerts-body");
    var badge = S.el("alert-count");
    alerts = alerts || [];
    if (badge) {
      badge.textContent = alerts.length;
      badge.className = "badge " + (alerts.length ? "text-bg-danger" : "text-bg-secondary");
    }
    if (!body) { return; }
    if (!alerts.length) {
      body.innerHTML = '<div class="text-secondary small">暂无告警</div>';
      return;
    }
    var html = "";
    alerts.forEach(function (alert) {
      html += '<div class="alert alert-danger py-1 px-2 mb-1 small">' +
        '<strong>' + S.escapeHtml(alert.metric) + '</strong> ' + S.escapeHtml(alert.op) + ' ' + S.escapeHtml(alert.threshold) +
        ' <span class="badge text-bg-light">当前 ' + S.fmtNum(alert.value, 1) + '</span>' +
        '<div class="text-secondary">自 ' + S.fmtShortTime(alert.since * 1000) + ' 起' + (alert.note ? " · " + S.escapeHtml(alert.note) : "") + '</div>' +
        '</div>';
    });
    body.innerHTML = html;
  }

  function render(snapshot) {
    if (!snapshot) { return; }
    S.setText("sys-time", S.fmtClock(snapshot.ts));
    renderSystem(snapshot.system);
    renderCpu(snapshot.cpu);
    renderMemory(snapshot.memory);
    renderGpu(snapshot.gpu);
    renderDisks(snapshot.disks, snapshot.disk_io);
    renderNet(snapshot.net);
    renderSensors(snapshot.sensors || {});
    renderAlerts(snapshot.alerts);
    pushSeries(snapshot);
  }

  function scheduleReconnect() {
    if (reconnectTimer) { return; }
    var delay = Math.min(15000, 1000 * Math.pow(2, Math.min(retries, 4)));
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function useSSE() {
    if (events || typeof EventSource === "undefined") { scheduleReconnect(); return; }
    setConn("SSE 已连接", "text-bg-info");
    events = new EventSource("/api/stream");
    events.onmessage = function (event) {
      try { render(JSON.parse(event.data)); } catch (err) { /* ignore bad frame */ }
    };
    events.onerror = function () { /* EventSource retries automatically */ };
  }

  function connect() {
    if (typeof WebSocket === "undefined") { useSSE(); return; }
    if (socket) { try { socket.close(); } catch (err) { /* noop */ } socket = null; }
    var protocol = window.location.protocol === "https:" ? "wss://" : "ws://";
    try {
      socket = new WebSocket(protocol + window.location.host + "/ws/live");
    } catch (err) {
      retries += 1;
      setConn("连接失败，重试中…", "text-bg-warning");
      scheduleReconnect();
      return;
    }
    socket.onopen = function () {
      retries = 0;
      setConn("实时连接", "text-bg-success");
    };
    socket.onmessage = function (event) {
      try { render(JSON.parse(event.data)); } catch (err) { /* ignore bad frame */ }
    };
    socket.onclose = function () {
      retries += 1;
      if (retries >= 3) {
        setConn("降级为 SSE", "text-bg-warning");
        useSSE();
        return;
      }
      setConn("重连中…", "text-bg-warning");
      scheduleReconnect();
    };
    socket.onerror = function () { setConn("连接异常", "text-bg-warning"); };
  }

  document.addEventListener("DOMContentLoaded", function () {
    initCharts();
    connect();
    setInterval(function () {
      if (!socket || socket.readyState !== WebSocket.OPEN) { return; }
    }, 10000);
  });
})();

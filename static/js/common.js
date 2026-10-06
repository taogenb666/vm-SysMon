/* Shared helpers for SysMon pages. */
(function (global) {
  "use strict";

  var UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var node = el(id);
    if (node) {
      node.textContent = (text === null || text === undefined || text === "") ? "--" : String(text);
    }
  }

  function isNum(value) {
    return value !== null && value !== undefined && value !== "" && !isNaN(Number(value));
  }

  function fmtBytes(value, digits) {
    if (!isNum(value)) { return "--"; }
    var n = Number(value);
    var i = 0;
    while (Math.abs(n) >= 1024 && i < UNITS.length - 1) { n = n / 1024; i += 1; }
    var d = (digits === undefined) ? (i === 0 ? 0 : 1) : digits;
    return n.toFixed(d) + " " + UNITS[i];
  }

  function fmtBps(value) {
    return fmtBytes(value) + "/s";
  }

  function fmtPct(value, digits) {
    if (!isNum(value)) { return "--"; }
    return Number(value).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function fmtNum(value, digits) {
    if (!isNum(value)) { return "--"; }
    return Number(value).toFixed(digits === undefined ? 1 : digits);
  }

  function fmtDuration(seconds) {
    if (!isNum(seconds)) { return "--"; }
    var s = Math.floor(Number(seconds));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    var parts = [];
    if (d) { parts.push(d + " 天"); }
    if (h) { parts.push(h + " 小时"); }
    if (m) { parts.push(m + " 分"); }
    parts.push(s + " 秒");
    return parts.join(" ");
  }

  function fmtClock(ms) {
    if (!isNum(ms)) { return "--"; }
    return new Date(Number(ms)).toLocaleString();
  }

  function fmtShortTime(ms) {
    if (!isNum(ms)) { return "--"; }
    var date = new Date(Number(ms));
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function barClass(pct) {
    if (Number(pct) >= 90) { return "bg-danger"; }
    if (Number(pct) >= 75) { return "bg-warning"; }
    return "bg-success";
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) { return ""; }
    return String(value).replace(/[&<>"']/g, function (ch) {
      var map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
      return map[ch];
    });
  }

  function getJSON(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (body) {
          throw new Error("HTTP " + res.status + " " + body.slice(0, 200));
        });
      }
      return res.json();
    });
  }

  function sendJSON(url, method, body) {
    var init = { method: method, headers: { "Content-Type": "application/json", Accept: "application/json" } };
    if (body !== undefined && body !== null) { init.body = JSON.stringify(body); }
    return fetch(url, init).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error("HTTP " + res.status + " " + text.slice(0, 200));
        });
      }
      if (res.status === 204) { return null; }
      return res.json();
    });
  }

  function setProgress(barId, percent) {
    var node = el(barId);
    if (!node) { return; }
    var value = isNum(percent) ? Math.max(0, Math.min(100, Number(percent))) : 0;
    node.style.width = value + "%";
    node.className = "progress-bar " + barClass(value);
  }

  function sparkBars(containerId, values, max) {
    var node = el(containerId);
    if (!node) { return; }
    var top = isNum(max) ? Number(max) : 100;
    var html = "";
    (values || []).forEach(function (value, index) {
      var pct = isNum(value) ? Math.max(1, Math.min(100, (Number(value) / top) * 100)) : 1;
      html += '<div class="core" title="CPU' + index + ': ' + fmtPct(value) + '"><i style="height:' + pct.toFixed(1) + '%"></i></div>';
    });
    node.innerHTML = html;
  }

  function lineChartDefaults() {
    return {
      backgroundColor: "transparent",
      animationDuration: 250,
      grid: { left: 48, right: 16, top: 30, bottom: 28 },
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { color: "#cbd5e1" } },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: [],
        axisLine: { lineStyle: { color: "rgba(148,163,184,0.4)" } },
        axisLabel: { color: "#94a3b8" }
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "rgba(148,163,184,0.12)" } },
        axisLabel: { color: "#94a3b8" }
      }
    };
  }

  function toast(message, kind) {
    var node = el("sysmon-toast");
    if (!node) { return; }
    node.className = "sysmon-toast show text-bg-" + (kind || "info");
    node.textContent = message;
    if (global.__sysmonToastTimer) { clearTimeout(global.__sysmonToastTimer); }
    global.__sysmonToastTimer = setTimeout(function () {
      node.className = "sysmon-toast";
    }, 4000);
  }

  global.SysMon = {
    el: el,
    toast: toast,
    setText: setText,
    isNum: isNum,
    fmtBytes: fmtBytes,
    fmtBps: fmtBps,
    fmtPct: fmtPct,
    fmtNum: fmtNum,
    fmtDuration: fmtDuration,
    fmtClock: fmtClock,
    fmtShortTime: fmtShortTime,
    barClass: barClass,
    escapeHtml: escapeHtml,
    getJSON: getJSON,
    sendJSON: sendJSON,
    setProgress: setProgress,
    sparkBars: sparkBars,
    lineChartDefaults: lineChartDefaults
  };
})(window);

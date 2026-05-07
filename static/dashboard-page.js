/* global window, document */
(function () {
  "use strict";

  var columnStorageKey = "dashboard.hiddenColumns";
  var compactModeStorageKey = "dashboard.compactCardsMode";
  var dashboardPreferencesStorageKey = "dashboard.preferences";
  var dashboardRefreshPausedStorageKey = "dashboard.refreshPaused";
  var trendModeStorageKey = "dashboard.trendMode";
  var operatorPalette = {
    halotel: "#fb923c",
    airtel: "#ef4444",
    yas: "#facc15",
    vodacom: "#3b82f6",
    default: "#06b6d4",
  };
  var dashboardState = window.DashboardPageState || {
    refreshTimerId: null,
    isPaused: false,
    preferencesApplied: false,
  };
  var hiddenColumns = new Set();

  window.DashboardPageState = dashboardState;

  function readJsonStorage(key, fallbackValue) {
    try {
      var stored = JSON.parse(window.localStorage.getItem(key) || JSON.stringify(fallbackValue));
      return stored && typeof stored === "object" ? stored : fallbackValue;
    } catch (_error) {
      return fallbackValue;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_error) {}
  }

  function getDashboardRoot() {
    return document.getElementById("dashboard-page-root");
  }

  function loadHiddenColumns() {
    var persisted = readJsonStorage(columnStorageKey, []);
    hiddenColumns.clear();
    if (!Array.isArray(persisted)) {
      return;
    }
    persisted.forEach(function (columnName) {
      hiddenColumns.add(columnName);
    });
  }

  function persistHiddenColumns() {
    writeJsonStorage(columnStorageKey, Array.from(hiddenColumns));
  }

  function readDashboardPreferences() {
    return readJsonStorage(dashboardPreferencesStorageKey, {});
  }

  function writeDashboardPreferences(preferences) {
    writeJsonStorage(dashboardPreferencesStorageKey, preferences || {});
  }

  function readRefreshPausedPreference() {
    try {
      return window.localStorage.getItem(dashboardRefreshPausedStorageKey) === "true";
    } catch (_error) {
      return false;
    }
  }

  function writeRefreshPausedPreference(isPaused) {
    try {
      window.localStorage.setItem(dashboardRefreshPausedStorageKey, isPaused ? "true" : "false");
    } catch (_error) {}
  }

  function normalizeOperatorKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function parseAmountValue(value) {
    var numeric = parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function formatTrendValue(value) {
    var amount = Number(value || 0);
    var absolute = Math.abs(amount);
    var sign = amount < 0 ? "-" : "";
    if (absolute >= 1000000000) {
      return sign + "TZS " + (absolute / 1000000000).toFixed(1).replace(/\.0$/, "") + "B";
    }
    if (absolute >= 1000000) {
      return sign + "TZS " + (absolute / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    }
    if (absolute >= 1000) {
      return sign + "TZS " + (absolute / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    }
    return sign + "TZS " + Math.round(absolute).toLocaleString();
  }

  function getCanvasContext(canvas) {
    var rect;
    var context;
    var width;
    var height;
    var dpr;
    if (!canvas) {
      return null;
    }

    rect = canvas.getBoundingClientRect();
    width = Math.max(Math.round(rect.width || 0), 220);
    height = Number(canvas.getAttribute("height") || 220);
    dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    return {
      context: context,
      width: width,
      height: height,
    };
  }

  function drawEmptyState(canvas, message) {
    var chart = getCanvasContext(canvas);
    if (!chart) {
      return;
    }
    chart.context.fillStyle = "rgba(15, 24, 41, 0.45)";
    chart.context.font = "600 14px Plus Jakarta Sans, sans-serif";
    chart.context.textAlign = "center";
    chart.context.fillText(message, chart.width / 2, chart.height / 2);
  }

  function readTrendMode() {
    try {
      return window.localStorage.getItem(trendModeStorageKey) === "monthly" ? "monthly" : "daily";
    } catch (_error) {
      return "daily";
    }
  }

  function writeTrendMode(mode) {
    try {
      window.localStorage.setItem(trendModeStorageKey, mode === "monthly" ? "monthly" : "daily");
    } catch (_error) {}
  }

  function readDashboardTrendData(root) {
    var script = root ? root.querySelector("#dashboard-trend-data") : null;
    if (!script) {
      return {};
    }
    try {
      return JSON.parse(script.textContent || "{}");
    } catch (_error) {
      return {};
    }
  }

  function collectDashboardChartData(root) {
    var rows = Array.prototype.slice.call(root.querySelectorAll(".transaction-table tbody tr"));
    var operatorCounts = { halotel: 0, airtel: 0, yas: 0, vodacom: 0 };

    rows.forEach(function (row) {
      var operatorCell = row.querySelector(".operator-pill");
      var operatorKey = normalizeOperatorKey(operatorCell ? operatorCell.textContent : "");

      if (Object.prototype.hasOwnProperty.call(operatorCounts, operatorKey)) {
        operatorCounts[operatorKey] += 1;
      }
    });

    return {
      operatorLabels: ["halotel", "airtel", "yas", "vodacom"].filter(function (key) {
        return operatorCounts[key] > 0;
      }),
      operatorValues: ["halotel", "airtel", "yas", "vodacom"].filter(function (key) {
        return operatorCounts[key] > 0;
      }).map(function (key) {
        return operatorCounts[key];
      }),
    };
  }

  function drawSmoothPath(context, points) {
    if (points.length === 1) {
      context.moveTo(points[0].x, points[0].y);
      return;
    }
    context.moveTo(points[0].x, points[0].y);
    points.forEach(function (point, index) {
      var nextPoint;
      var midX;
      var midY;
      if (index === 0) {
        return;
      }
      nextPoint = points[index - 1];
      midX = (nextPoint.x + point.x) / 2;
      midY = (nextPoint.y + point.y) / 2;
      context.quadraticCurveTo(nextPoint.x, nextPoint.y, midX, midY);
      if (index === points.length - 1) {
        context.quadraticCurveTo(point.x, point.y, point.x, point.y);
      }
    });
  }

  function shouldLabelTrendPoint(points, index) {
    var point = points[index];
    var previous = points[index - 1];
    var next = points[index + 1];
    if (!point || point.value <= 0) {
      return false;
    }
    if (points.length <= 7) {
      return true;
    }
    if (index === points.length - 1) {
      return true;
    }
    if (previous && next && ((point.value >= previous.value && point.value >= next.value) || (point.value <= previous.value && point.value <= next.value))) {
      return true;
    }
    return false;
  }

  function drawTrendValueLabel(context, point, label, color, chartWidth, chartHeight, yOffset) {
    var textWidth;
    var labelX = Math.max(34, Math.min(chartWidth - 34, point.x));
    var labelY = Math.max(16, Math.min(chartHeight - 38, point.y + yOffset));
    context.save();
    context.font = "800 10px Plus Jakarta Sans, sans-serif";
    textWidth = context.measureText(label).width + 12;
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.strokeStyle = "rgba(15, 24, 41, 0.08)";
    context.lineWidth = 1;
    if (typeof context.roundRect === "function") {
      context.beginPath();
      context.roundRect(labelX - textWidth / 2, labelY - 10, textWidth, 16, 8);
      context.fill();
      context.stroke();
    } else {
      context.fillRect(labelX - textWidth / 2, labelY - 10, textWidth, 16);
    }
    context.fillStyle = color;
    context.textAlign = "center";
    context.fillText(label, labelX, labelY + 2);
    context.restore();
  }

  function drawTrendLine(context, points, color, shadowColor, chartWidth, chartHeight, labelOffset) {
    if (!points.length) {
      return;
    }
    context.save();
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = color;
    context.shadowColor = shadowColor;
    context.shadowBlur = 10;
    context.beginPath();
    drawSmoothPath(context, points);
    context.stroke();
    context.restore();

    points.forEach(function (point, index) {
      context.beginPath();
      context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = "#ffffff";
      context.stroke();
      if (shouldLabelTrendPoint(points, index)) {
        drawTrendValueLabel(context, point, formatTrendValue(point.value), color, chartWidth, chartHeight, labelOffset);
      }
    });
  }

  function sumTrendValues(values) {
    return (values || []).reduce(function (total, value) {
      return total + Number(value || 0);
    }, 0);
  }

  function updateTrendInsights(root, trendSeries) {
    var sentTotal;
    var receivedTotal;
    var netTotal;
    var sentNode;
    var receivedNode;
    var netNode;
    if (!root) {
      return;
    }
    sentTotal = sumTrendValues((trendSeries && trendSeries.sent) || []);
    receivedTotal = sumTrendValues((trendSeries && trendSeries.received) || []);
    netTotal = receivedTotal - sentTotal;
    sentNode = root.querySelector('[data-trend-total="sent"]');
    receivedNode = root.querySelector('[data-trend-total="received"]');
    netNode = root.querySelector('[data-trend-total="net"]');
    if (sentNode) {
      sentNode.textContent = formatTrendValue(sentTotal);
    }
    if (receivedNode) {
      receivedNode.textContent = formatTrendValue(receivedTotal);
    }
    if (netNode) {
      netNode.textContent = formatTrendValue(netTotal);
    }
  }

  function drawTrendChart(canvas, trendSeries) {
    var chart = getCanvasContext(canvas);
    var context;
    var padding;
    var innerWidth;
    var innerHeight;
    var maxValue;
    var range;
    var labels;
    var sentValues;
    var receivedValues;
    var allValues;
    var sentPoints;
    var receivedPoints;

    if (!chart) {
      return;
    }
    labels = (trendSeries && trendSeries.labels) || [];
    sentValues = (trendSeries && trendSeries.sent) || [];
    receivedValues = (trendSeries && trendSeries.received) || [];
    allValues = sentValues.concat(receivedValues).map(function (value) {
      return Number(value || 0);
    });

    if (!labels.length || !allValues.some(function (value) { return value > 0; })) {
      drawEmptyState(canvas, "Sent and received trend appears when matching transactions are available.");
      return;
    }

    context = chart.context;
    padding = { top: 26, right: 22, bottom: 34, left: 58 };
    innerWidth = chart.width - padding.left - padding.right;
    innerHeight = chart.height - padding.top - padding.bottom;
    maxValue = Math.max.apply(null, allValues);
    range = Math.max(maxValue, 1);

    context.strokeStyle = "rgba(15, 24, 41, 0.08)";
    context.lineWidth = 1;
    [0, 0.33, 0.66, 1].forEach(function (step) {
      var y = padding.top + innerHeight * step;
      var value = range - range * step;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(chart.width - padding.right, y);
      context.stroke();
      context.fillStyle = "rgba(15, 24, 41, 0.48)";
      context.font = "800 10px Plus Jakarta Sans, sans-serif";
      context.textAlign = "right";
      context.fillText(formatTrendValue(value).replace("TZS ", ""), padding.left - 8, y + 3);
    });

    function buildPoints(values) {
      return values.map(function (value, index) {
        return {
          x: padding.left + (innerWidth * index) / Math.max(labels.length - 1, 1),
          y: padding.top + innerHeight - (Number(value || 0) / range) * innerHeight,
          value: Number(value || 0),
        };
      });
    }

    sentPoints = buildPoints(sentValues);
    receivedPoints = buildPoints(receivedValues);
    drawTrendLine(context, sentPoints, "#06b6d4", "rgba(6, 182, 212, 0.35)", chart.width, chart.height, -10);
    drawTrendLine(context, receivedPoints, "#1cdc8b", "rgba(28, 220, 139, 0.35)", chart.width, chart.height, 18);

    context.fillStyle = "rgba(15, 24, 41, 0.54)";
    context.font = "700 11px Plus Jakarta Sans, sans-serif";
    context.textAlign = "center";
    labels.forEach(function (label, index) {
      var x = padding.left + (innerWidth * index) / Math.max(labels.length - 1, 1);
      context.fillText(label, x, chart.height - 10);
    });
  }

  function syncTrendModeControls(root, mode) {
    var note = root.querySelector("[data-trend-note]");
    root.querySelectorAll("[data-trend-mode]").forEach(function (button) {
      var isActive = button.getAttribute("data-trend-mode") === mode;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    if (note) {
      note.textContent = mode === "monthly"
        ? "Last 6 months, filtered by current search controls"
        : "Last 7 days, filtered by current search controls";
    }
  }

  function initTrendModeControls(root) {
    root.querySelectorAll("[data-trend-mode]").forEach(function (button) {
      if (button.getAttribute("data-trend-bound") === "true") {
        return;
      }
      button.setAttribute("data-trend-bound", "true");
      button.addEventListener("click", function () {
        var mode = button.getAttribute("data-trend-mode") === "monthly" ? "monthly" : "daily";
        writeTrendMode(mode);
        renderDashboardCharts(root);
      });
    });
  }

  function drawOperatorChart(canvas, labels, values) {
    var chart = getCanvasContext(canvas);
    var context;
    var padding;
    var innerWidth;
    var innerHeight;
    var maxValue;
    var barWidth;
    if (!chart) {
      return;
    }
    if (!values || values.length === 0) {
      drawEmptyState(canvas, "Operator distribution appears when transactions are available.");
      return;
    }

    context = chart.context;
    padding = { top: 18, right: 12, bottom: 34, left: 12 };
    innerWidth = chart.width - padding.left - padding.right;
    innerHeight = chart.height - padding.top - padding.bottom;
    maxValue = Math.max.apply(null, values) || 1;
    barWidth = innerWidth / Math.max(values.length, 1) - 18;

    function drawRoundedBar(x, y, width, height, radius) {
      if (typeof context.roundRect === "function") {
        context.beginPath();
        context.roundRect(x, y, width, height, radius);
        context.fill();
        return;
      }
      context.beginPath();
      context.moveTo(x + radius, y);
      context.lineTo(x + width - radius, y);
      context.quadraticCurveTo(x + width, y, x + width, y + radius);
      context.lineTo(x + width, y + height - radius);
      context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      context.lineTo(x + radius, y + height);
      context.quadraticCurveTo(x, y + height, x, y + height - radius);
      context.lineTo(x, y + radius);
      context.quadraticCurveTo(x, y, x + radius, y);
      context.closePath();
      context.fill();
    }

    values.forEach(function (value, index) {
      var x = padding.left + index * (barWidth + 18) + 9;
      var barHeight = (value / maxValue) * (innerHeight - 12);
      var y = padding.top + innerHeight - barHeight;
      var label = labels[index];
      var fill = operatorPalette[label] || operatorPalette.default;

      context.fillStyle = fill;
      drawRoundedBar(x, y, Math.max(barWidth, 34), barHeight, 14);

      context.fillStyle = "rgba(15, 24, 41, 0.64)";
      context.font = "700 11px Plus Jakarta Sans, sans-serif";
      context.textAlign = "center";
      context.fillText(String(value), x + Math.max(barWidth, 34) / 2, y - 8);
      context.fillText(label.charAt(0).toUpperCase() + label.slice(1), x + Math.max(barWidth, 34) / 2, chart.height - 10);
    });
  }

  function renderDashboardCharts(root) {
    var chartData;
    var trendData;
    var trendMode;
    if (!root) {
      return;
    }
    chartData = collectDashboardChartData(root);
    trendData = readDashboardTrendData(root);
    trendMode = readTrendMode();
    syncTrendModeControls(root, trendMode);
    updateTrendInsights(root, trendData[trendMode] || trendData.daily || {});
    drawTrendChart(root.querySelector("#dashboard-volume-chart"), trendData[trendMode] || trendData.daily || {});
    drawOperatorChart(root.querySelector("#dashboard-operator-chart"), chartData.operatorLabels, chartData.operatorValues);
  }

  function buildDashboardPreferences(root) {
    var form = root.querySelector(".list-controls");
    var preferences = {
      period: "today",
      q: "",
      operator: "",
      operation: "",
      per_page: "15",
      sort_by: "date",
      sort_dir: "desc",
    };

    if (!form) {
      return preferences;
    }

    preferences.period = (form.querySelector('[name="period"]') || {}).value || "today";
    preferences.q = (form.querySelector('[name="q"]') || {}).value || "";
    preferences.operator = (form.querySelector('[name="operator"]') || {}).value || "";
    preferences.operation = (form.querySelector('[name="operation"]') || {}).value || "";
    preferences.per_page = (form.querySelector('[name="per_page"]') || {}).value || "15";
    preferences.sort_by = (form.querySelector('[name="sort_by"]') || {}).value || "date";
    preferences.sort_dir = (form.querySelector('[name="sort_dir"]') || {}).value || "desc";
    return preferences;
  }

  function persistDashboardPreferences(root) {
    writeDashboardPreferences(buildDashboardPreferences(root));
  }

  function hasCustomDashboardPreferences(preferences) {
    return !!(
      (preferences.q || "").trim() ||
      (preferences.operator || "").trim() ||
      (preferences.operation || "").trim() ||
      String(preferences.per_page || "15") !== "15" ||
      String(preferences.period || "today") !== "today" ||
      String(preferences.sort_by || "date") !== "date" ||
      String(preferences.sort_dir || "desc") !== "desc"
    );
  }

  function buildDashboardUrlFromPreferences(root, preferences) {
    var form = root.querySelector(".list-controls");
    var url = new URL((form && form.getAttribute("action")) || "/dashboard", window.location.origin);

    if (!preferences) {
      return url;
    }

    if (preferences.period) {
      url.searchParams.set("period", preferences.period);
    }
    if (preferences.q) {
      url.searchParams.set("q", preferences.q);
    }
    if (preferences.operator) {
      url.searchParams.set("operator", preferences.operator);
    }
    if (preferences.operation) {
      url.searchParams.set("operation", preferences.operation);
    }
    if (preferences.per_page) {
      url.searchParams.set("per_page", preferences.per_page);
    }
    if (preferences.sort_by) {
      url.searchParams.set("sort_by", preferences.sort_by);
    }
    if (preferences.sort_dir) {
      url.searchParams.set("sort_dir", preferences.sort_dir);
    }

    return url;
  }

  function maybeApplyStoredDashboardPreferences(root) {
    var preferences = readDashboardPreferences();
    var currentUrl = new URL(window.location.href);
    var targetUrl;
    var hasExplicitFilters;

    if (dashboardState.preferencesApplied || !hasCustomDashboardPreferences(preferences)) {
      return false;
    }

    hasExplicitFilters = ["period", "q", "operator", "operation", "per_page", "sort_by", "sort_dir"].some(function (key) {
      return currentUrl.searchParams.has(key);
    });

    if (hasExplicitFilters) {
      return false;
    }

    targetUrl = buildDashboardUrlFromPreferences(root, preferences);
    if (targetUrl.toString() === currentUrl.toString()) {
      return false;
    }

    dashboardState.preferencesApplied = true;
    if (window.CodexUX && typeof window.CodexUX.fetchAndSwap === "function") {
      window.CodexUX.fetchAndSwap(targetUrl.toString(), "#dashboard-page-root", false, {
        restoreFocus: false,
        notify: false,
        suppressToast: true,
        replaceHistory: true,
      }).catch(function () {
        window.location.assign(targetUrl.toString());
      });
      return true;
    }

    window.location.assign(targetUrl.toString());
    return true;
  }

  function applyColumnVisibility(root) {
    root.querySelectorAll("[data-col]").forEach(function (cell) {
      var columnName = cell.getAttribute("data-col");
      cell.classList.toggle("col-hidden", hiddenColumns.has(columnName));
    });
  }

  function bindColumnToggles(root) {
    root.querySelectorAll("[data-col-toggle]").forEach(function (toggle) {
      var columnName = toggle.getAttribute("data-col-toggle");
      if (toggle.getAttribute("data-col-toggle-bound") === "true") {
        toggle.checked = !hiddenColumns.has(columnName);
        return;
      }

      toggle.checked = !hiddenColumns.has(columnName);
      toggle.setAttribute("data-col-toggle-bound", "true");
      toggle.addEventListener("change", function () {
        if (toggle.checked) {
          hiddenColumns.delete(columnName);
        } else {
          hiddenColumns.add(columnName);
        }
        persistHiddenColumns();
        applyColumnVisibility(root);
      });
    });
  }

  function getCompactCardsEnabled() {
    var compactCardsEnabled = !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);

    try {
      var storedValue = window.localStorage.getItem(compactModeStorageKey);
      if (storedValue === "on" || storedValue === "off") {
        compactCardsEnabled = storedValue === "on";
      }
    } catch (_error) {}

    return compactCardsEnabled;
  }

  function saveCompactCardsEnabled(isEnabled) {
    try {
      window.localStorage.setItem(compactModeStorageKey, isEnabled ? "on" : "off");
    } catch (_error) {}
  }

  function applyCompactMode(root, isEnabled) {
    var compactToggle = root.querySelector("#compact-mode-toggle");

    document.body.classList.toggle("compact-cards-mode", isEnabled);
    root.classList.toggle("compact-cards-mode", isEnabled);

    if (!compactToggle) {
      return;
    }

    compactToggle.textContent = isEnabled ? "Standard rows" : "Compact cards";
    compactToggle.setAttribute("aria-pressed", isEnabled ? "true" : "false");
  }

  function bindCompactModeToggle(root) {
    var compactToggle = root.querySelector("#compact-mode-toggle");
    var compactCardsEnabled = getCompactCardsEnabled();

    applyCompactMode(root, compactCardsEnabled);

    if (!compactToggle) {
      return;
    }

    if (compactToggle.getAttribute("data-compact-toggle-bound") === "true") {
      return;
    }

    compactToggle.setAttribute("data-compact-toggle-bound", "true");
    compactToggle.addEventListener("click", function () {
      compactCardsEnabled = !compactCardsEnabled;
      saveCompactCardsEnabled(compactCardsEnabled);
      applyCompactMode(root, compactCardsEnabled);
    });
  }

  function bindSavedViewControls(root) {
    var resetButton = root.querySelector("[data-dashboard-reset-preferences='true']");
    if (!resetButton || resetButton.getAttribute("data-dashboard-reset-bound") === "true") {
      return;
    }
    resetButton.setAttribute("data-dashboard-reset-bound", "true");
    resetButton.addEventListener("click", function () {
      try {
        window.localStorage.removeItem(dashboardPreferencesStorageKey);
      } catch (_error) {}
      window.location.assign("/dashboard");
    });
  }

  function clearRefreshTimer() {
    if (!dashboardState.refreshTimerId) {
      return;
    }
    window.clearInterval(dashboardState.refreshTimerId);
    dashboardState.refreshTimerId = null;
  }

  function initAutoRefresh(root) {
    var countdownEl = root.querySelector("#refresh-countdown");
    var toggleBtn = root.querySelector("#refresh-toggle");
    var totalSeconds = 30;
    var remainingSeconds = totalSeconds;
    var didReload = false;

    function renderCountdown() {
      if (!countdownEl) {
        return;
      }
      countdownEl.textContent = dashboardState.isPaused ? "paused" : remainingSeconds + "s";
    }

    function reloadDashboard() {
      var reloadUrl = new URL(window.location.href);
      reloadUrl.searchParams.delete("refresh");

      if (window.CodexUX && typeof window.CodexUX.fetchAndSwap === "function") {
        window.CodexUX.fetchAndSwap(reloadUrl.toString(), "#dashboard-page-root", false, {
          restoreFocus: false,
          notify: false,
          suppressToast: true,
          replaceHistory: true,
        }).catch(function () {
          window.location.assign(reloadUrl.toString());
        });
        return;
      }

      window.location.assign(reloadUrl.toString());
    }

    function tick() {
      if (didReload || dashboardState.isPaused) {
        return;
      }

      remainingSeconds -= 1;
      if (remainingSeconds <= 0) {
        didReload = true;
        clearRefreshTimer();
        reloadDashboard();
        return;
      }

      renderCountdown();
    }

    clearRefreshTimer();
    renderCountdown();

    if (toggleBtn && toggleBtn.getAttribute("data-refresh-toggle-bound") !== "true") {
      toggleBtn.setAttribute("data-refresh-toggle-bound", "true");
      toggleBtn.addEventListener("click", function () {
        dashboardState.isPaused = !dashboardState.isPaused;
        writeRefreshPausedPreference(dashboardState.isPaused);
        toggleBtn.textContent = dashboardState.isPaused ? "Resume" : "Pause";
        toggleBtn.setAttribute("aria-pressed", dashboardState.isPaused ? "true" : "false");
        renderCountdown();
      });
    }

    if (toggleBtn) {
      toggleBtn.textContent = dashboardState.isPaused ? "Resume" : "Pause";
      toggleBtn.setAttribute("aria-pressed", dashboardState.isPaused ? "true" : "false");
    }

    dashboardState.refreshTimerId = window.setInterval(tick, 1000);
  }

  function initDashboardPage() {
    var root = getDashboardRoot();

    if (!root) {
      clearRefreshTimer();
      return;
    }

    dashboardState.isPaused = readRefreshPausedPreference();

    if (maybeApplyStoredDashboardPreferences(root)) {
      return;
    }

    loadHiddenColumns();
    bindColumnToggles(root);
    applyColumnVisibility(root);
    bindCompactModeToggle(root);
    bindSavedViewControls(root);
    initTrendModeControls(root);
    persistDashboardPreferences(root);
    renderDashboardCharts(root);
    initAutoRefresh(root);
  }

  if (!window.DashboardPageListenerBound) {
    window.addEventListener("ux:content-updated", function (event) {
      if (!event.detail || event.detail.target !== "#dashboard-page-root") {
        return;
      }
      initDashboardPage();
    });

    window.addEventListener("resize", function () {
      var root = getDashboardRoot();
      if (!root) {
        return;
      }
      window.clearTimeout(window.DashboardChartResizeTimer || 0);
      window.DashboardChartResizeTimer = window.setTimeout(function () {
        renderDashboardCharts(root);
      }, 120);
    });
    window.DashboardPageListenerBound = true;
  }

  initDashboardPage();
})();

/* global window, document */
(function () {
  "use strict";

  var columnStorageKey = "dashboard.hiddenColumns";
  var compactModeStorageKey = "dashboard.compactCardsMode";
  var dashboardPreferencesStorageKey = "dashboard.preferences";
  var dashboardRefreshPausedStorageKey = "dashboard.refreshPaused";
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

  function collectDashboardChartData(root) {
    var rows = Array.prototype.slice.call(root.querySelectorAll(".transaction-table tbody tr"));
    var trendPoints = [];
    var operatorCounts = { halotel: 0, airtel: 0, yas: 0, vodacom: 0 };

    rows.forEach(function (row) {
      var amountCell = row.querySelector("[data-col='amount']");
      var dateCell = row.querySelector("[data-col='date']");
      var operatorCell = row.querySelector(".operator-pill");
      var amountValue = parseAmountValue(amountCell ? amountCell.textContent : "");
      var dateLabel = dateCell ? String(dateCell.textContent || "").trim() : "";
      var operatorKey = normalizeOperatorKey(operatorCell ? operatorCell.textContent : "");

      if (amountValue > 0) {
        trendPoints.push({
          label: dateLabel ? dateLabel.slice(0, 10) : "Row " + String(trendPoints.length + 1),
          value: amountValue,
        });
      }
      if (Object.prototype.hasOwnProperty.call(operatorCounts, operatorKey)) {
        operatorCounts[operatorKey] += 1;
      }
    });

    trendPoints = trendPoints.slice(0, 8).reverse();

    return {
      trendLabels: trendPoints.map(function (point) {
        return point.label;
      }),
      trendValues: trendPoints.map(function (point) {
        return point.value;
      }),
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

  function drawLineChart(canvas, labels, values) {
    var chart = getCanvasContext(canvas);
    var context;
    var padding;
    var innerWidth;
    var innerHeight;
    var maxValue;
    var minValue;
    var range;
    var gradient;

    if (!chart) {
      return;
    }
    if (!values || values.length === 0) {
      drawEmptyState(canvas, "Add more transactions to plot the trend.");
      return;
    }

    context = chart.context;
    padding = { top: 18, right: 18, bottom: 30, left: 18 };
    innerWidth = chart.width - padding.left - padding.right;
    innerHeight = chart.height - padding.top - padding.bottom;
    maxValue = Math.max.apply(null, values);
    minValue = Math.min.apply(null, values);
    range = Math.max(maxValue - minValue, maxValue || 1);

    context.strokeStyle = "rgba(15, 24, 41, 0.08)";
    context.lineWidth = 1;
    [0, 0.33, 0.66, 1].forEach(function (step) {
      var y = padding.top + innerHeight * step;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(chart.width - padding.right, y);
      context.stroke();
    });

    gradient = context.createLinearGradient(0, padding.top, 0, padding.top + innerHeight);
    gradient.addColorStop(0, "rgba(6, 182, 212, 0.24)");
    gradient.addColorStop(1, "rgba(6, 182, 212, 0)");

    context.beginPath();
    values.forEach(function (value, index) {
      var x = padding.left + (innerWidth * index) / Math.max(values.length - 1, 1);
      var y = padding.top + innerHeight - ((value - minValue) / range) * innerHeight;
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });

    context.lineWidth = 3;
    context.strokeStyle = operatorPalette.default;
    context.stroke();

    context.lineTo(chart.width - padding.right, chart.height - padding.bottom);
    context.lineTo(padding.left, chart.height - padding.bottom);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();

    context.fillStyle = "rgba(15, 24, 41, 0.54)";
    context.font = "700 11px Plus Jakarta Sans, sans-serif";
    context.textAlign = "center";
    labels.forEach(function (label, index) {
      var x = padding.left + (innerWidth * index) / Math.max(labels.length - 1, 1);
      context.fillText(label, x, chart.height - 10);
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
    if (!root) {
      return;
    }
    chartData = collectDashboardChartData(root);
    drawLineChart(root.querySelector("#dashboard-volume-chart"), chartData.trendLabels, chartData.trendValues);
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

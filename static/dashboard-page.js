/* global window, document */
(function () {
  "use strict";

  var columnStorageKey = "dashboard.hiddenColumns";
  var compactModeStorageKey = "dashboard.compactCardsMode";
  var dashboardPreferencesStorageKey = "dashboard.preferences";
  var dashboardRefreshPausedStorageKey = "dashboard.refreshPaused";
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
    initAutoRefresh(root);
  }

  if (!window.DashboardPageListenerBound) {
    window.addEventListener("ux:content-updated", function (event) {
      if (!event.detail || event.detail.target !== "#dashboard-page-root") {
        return;
      }
      initDashboardPage();
    });
    window.DashboardPageListenerBound = true;
  }

  initDashboardPage();
})();

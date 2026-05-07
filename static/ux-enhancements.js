/* global window, document, fetch, FormData, URL, DOMParser, history, CustomEvent, HTMLElement, HTMLFormElement */
(function () {
  "use strict";

  var autoSubmitTimers = new WeakMap();
  var toastHideTimers = new WeakMap();
  var liveRegion = null;
  var toastStack = null;
  var sidebarStorageKey = "app.sidebarCollapsed";
  var themeStorageKey = "app.theme";
  var installPromptStorageKey = "app.installPromptDismissedAt";
  var settingsTabStorageKey = "settings.activeTab";
  var settingsPreferenceStorageKey = "settings.preferences";
  var recentTransfersStorageKey = "sendMoney.recentTransfers";
  var pendingRecentTransferStorageKey = "sendMoney.pendingRecentTransfer";
  var maxRecentTransfers = 5;
  var deferredInstallPrompt = null;
  var approvalPollTimer = null;
  var approvalTimeoutTimer = null;
  var approvalDecisionInFlight = false;
  var approvalPollIntervalMs = 3000;
  var approvalAutoRejectMs = 60000;
  var activeApprovalContext = null;
  var balanceStatusPollTimer = null;
  var pendingTransferConfirmationPayload = null;
  var transferConfirmationOpener = null;
  var pendingFragmentRequests = new Map();
  var commandPaletteState = {
    commands: [],
    filteredCommands: [],
    activeIndex: 0,
    opener: null,
  };
  var detailDrawerState = {
    opener: null,
    row: null,
  };

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function normalizeUrl(url) {
    return new URL(url || window.location.href, window.location.origin).toString();
  }

  function getCsrfToken() {
    var tokenMeta = document.querySelector('meta[name="csrf-token"]');
    return tokenMeta ? tokenMeta.getAttribute("content") || "" : "";
  }

  function inferFragmentTarget(url) {
    var pathname = new URL(url || window.location.href, window.location.origin).pathname;

    if (pathname === "/" || pathname === "/dashboard") {
      return "#dashboard-page-root";
    }
    if (pathname === "/messages") {
      return "#messages-page-root";
    }
    if (pathname === "/settings") {
      return "#settings-page-root";
    }
    if (pathname === "/send-money") {
      return "#send-money-page-root";
    }
    if (pathname === "/recent-transfers") {
      return "#recent-transfers-page-root";
    }
    if (pathname === "/requests") {
      return "#requests-page-root";
    }
    if (pathname === "/balance") {
      return "#balance-page-root";
    }
    return "";
  }

  function writeHistoryState(url, targetSelector, shouldReplace) {
    var normalizedUrl = normalizeUrl(url);
    if (!targetSelector) {
      return;
    }
    if (shouldReplace) {
      history.replaceState({ url: normalizedUrl, target: targetSelector }, "", normalizedUrl);
      return;
    }
    history.pushState({ url: normalizedUrl, target: targetSelector }, "", normalizedUrl);
  }

  function syncCurrentHistoryState() {
    var targetSelector = inferFragmentTarget(window.location.href);
    if (!targetSelector) {
      return;
    }
    writeHistoryState(window.location.href, targetSelector, true);
  }

  function syncNavigationState(nextDoc) {
    var nextBody = nextDoc.querySelector("body");
    var nextSidebar = nextDoc.querySelector("#app-sidebar");
    var currentSidebar = document.querySelector("#app-sidebar");
    var nextBottomNav = nextDoc.querySelector(".mobile-bottom-nav");
    var currentBottomNav = document.querySelector(".mobile-bottom-nav");

    if (nextBody) {
      Array.prototype.slice.call(document.body.classList).forEach(function (className) {
        if (className.indexOf("page-") === 0) {
          document.body.classList.remove(className);
        }
      });
      Array.prototype.slice.call(nextBody.classList).forEach(function (className) {
        if (className.indexOf("page-") === 0) {
          document.body.classList.add(className);
        }
      });
    }
    if (nextSidebar && currentSidebar) {
      currentSidebar.replaceWith(nextSidebar);
      initSidebarToggle();
    }
    if (nextBottomNav && currentBottomNav) {
      currentBottomNav.replaceWith(nextBottomNav);
    }
  }

  function ensureHeadAssets(nextDoc) {
    var existingStyles = new Set(
      Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"][href]')).map(function (link) {
        return link.href;
      })
    );
    var existingScripts = new Set(
      Array.prototype.slice.call(document.querySelectorAll("script[src]")).map(function (script) {
        return script.src;
      })
    );

    nextDoc.querySelectorAll('link[rel="stylesheet"][href]').forEach(function (link) {
      var href = link.href;
      var nextLink;
      if (!href || existingStyles.has(href)) {
        return;
      }
      nextLink = document.createElement("link");
      nextLink.rel = "stylesheet";
      nextLink.href = href;
      document.head.appendChild(nextLink);
      existingStyles.add(href);
    });

    nextDoc.querySelectorAll("script[src]").forEach(function (script) {
      var src = script.src;
      var nextScript;
      if (!src || existingScripts.has(src)) {
        return;
      }
      nextScript = document.createElement("script");
      nextScript.src = src;
      if (script.type) {
        nextScript.type = script.type;
      }
      document.body.appendChild(nextScript);
      existingScripts.add(src);
    });
  }

  function beginPendingRequest(targetSelector, requestUrl) {
    var previousRequest = pendingFragmentRequests.get(targetSelector);
    var controller = new AbortController();

    if (previousRequest && previousRequest.controller) {
      previousRequest.controller.abort();
    }

    pendingFragmentRequests.set(targetSelector, { controller: controller, url: requestUrl });
    return controller;
  }

  function isLatestPendingRequest(targetSelector, controller) {
    var activeRequest = pendingFragmentRequests.get(targetSelector);
    return !!activeRequest && activeRequest.controller === controller;
  }

  function clearPendingRequest(targetSelector, controller) {
    if (!isLatestPendingRequest(targetSelector, controller)) {
      return false;
    }
    pendingFragmentRequests.delete(targetSelector);
    return true;
  }

  function removeAsyncErrorPanel(target) {
    if (!target) {
      return;
    }
    Array.prototype.slice.call(target.children).forEach(function (panel) {
      if (!panel.classList || !panel.classList.contains("async-error-panel")) {
        return;
      }
      panel.remove();
    });
  }

  function setFragmentLoadingState(target, isLoading) {
    var overlay;
    if (!target) {
      return;
    }
    overlay = Array.prototype.slice.call(target.children).find(function (child) {
      return child.classList && child.classList.contains("async-loading-overlay");
    });
    target.classList.toggle("has-async-loading", !!isLoading);
    if (!isLoading) {
      if (overlay) {
        overlay.remove();
      }
      return;
    }
    removeAsyncErrorPanel(target);
    if (overlay) {
      return;
    }
    overlay = document.createElement("div");
    overlay.className = "async-loading-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = "<span></span><span></span><span></span>";
    target.appendChild(overlay);
  }

  function showAsyncErrorPanel(target, message) {
    var panel;
    if (!target) {
      return;
    }
    removeAsyncErrorPanel(target);
    panel = document.createElement("div");
    panel.className = "async-error-panel";
    panel.setAttribute("role", "alert");
    panel.innerHTML =
      "<div><strong>Unable to refresh this view</strong><p></p></div>" +
      '<button type="button" data-async-error-dismiss="true">Dismiss</button>';
    panel.querySelector("p").textContent = message || "Check the connection and try again.";
    target.prepend(panel);
  }

  function replaceTargetFromHtml(targetSelector, html) {
    var current = document.querySelector(targetSelector);
    var nextTitle;
    if (!current) {
      return false;
    }
    var nextDoc = parseHtml(html);
    var next = nextDoc.querySelector(targetSelector);
    if (!next) {
      return false;
    }
    nextTitle = nextDoc.querySelector("title");
    if (nextTitle && nextTitle.textContent) {
      document.title = nextTitle.textContent;
    }
    current.replaceWith(next);
    return true;
  }

  function replacePageShellFromHtml(html) {
    var currentMain = document.querySelector("#main-content");
    var nextDoc = parseHtml(html);
    var nextMain = nextDoc.querySelector("#main-content");
    var nextTitle = nextDoc.querySelector("title");

    if (!currentMain || !nextMain) {
      return false;
    }
    ensureHeadAssets(nextDoc);
    if (nextTitle && nextTitle.textContent) {
      document.title = nextTitle.textContent;
    }
    currentMain.replaceWith(nextMain);
    syncNavigationState(nextDoc);
    return true;
  }

  function setBusyState(element, isBusy) {
    if (!element) {
      return;
    }
    element.classList.toggle("is-busy", !!isBusy);
    element.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  function setElementLoadingState(element, isLoading) {
    if (!element) {
      return;
    }
    element.classList.toggle("is-loading", isLoading);
    setBusyState(element, isLoading);
    if (element.tagName === "BUTTON" || element.tagName === "INPUT") {
      element.disabled = !!isLoading;
      return;
    }
    if (element.tagName === "A") {
      element.setAttribute("aria-disabled", isLoading ? "true" : "false");
    }
  }

  function ensureLiveRegion() {
    if (liveRegion || !document.body) {
      return liveRegion;
    }
    liveRegion = document.createElement("div");
    liveRegion.className = "sr-only ux-live-region";
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    document.body.appendChild(liveRegion);
    return liveRegion;
  }

  function announceStatus(message) {
    var region;
    if (!message) {
      return;
    }
    region = ensureLiveRegion();
    if (!region) {
      return;
    }
    region.textContent = "";
    window.setTimeout(function () {
      region.textContent = message;
    }, 20);
  }

  function ensureToastStack() {
    if (toastStack || !document.body) {
      return toastStack;
    }
    toastStack = document.createElement("div");
    toastStack.className = "toast-stack";
    toastStack.setAttribute("aria-live", "polite");
    toastStack.setAttribute("aria-atomic", "false");
    document.body.appendChild(toastStack);
    return toastStack;
  }

  function showToast(message, level) {
    var stack = ensureToastStack();
    var toast;
    if (!stack || !message) {
      return;
    }

    toast = document.createElement("div");
    toast.className = "ux-toast" + (level ? " " + level : "");
    toast.textContent = message;
    stack.appendChild(toast);

    toastHideTimers.set(
      toast,
      window.setTimeout(function () {
        removeToast(toast);
      }, 4200)
    );
  }

  function removeToast(toast) {
    if (!toast) {
      return;
    }
    if (toastHideTimers.has(toast)) {
      window.clearTimeout(toastHideTimers.get(toast));
      toastHideTimers.delete(toast);
    }
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }

  function clearToasts() {
    var stack = ensureToastStack();
    var hasToasts = false;
    if (!stack) {
      return false;
    }
    Array.prototype.slice.call(stack.children).forEach(function (toast) {
      hasToasts = true;
      removeToast(toast);
    });
    return hasToasts;
  }

  function isStandaloneApp() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function shouldShowInstallPrompt() {
    var dismissedAt = Number(window.localStorage.getItem(installPromptStorageKey) || 0);
    var sevenDays = 7 * 24 * 60 * 60 * 1000;
    return !dismissedAt || Date.now() - dismissedAt > sevenDays;
  }

  function isIosSafariInstallPath() {
    var userAgent = window.navigator.userAgent || "";
    var isIos = /iphone|ipad|ipod/i.test(userAgent);
    var isSafari = /safari/i.test(userAgent) && !/crios|fxios|edgios/i.test(userAgent);
    return isIos && isSafari && !isStandaloneApp();
  }

  function setInstallPromptVisible(isVisible, isIosHint) {
    var card = document.querySelector("[data-install-card='true']");
    var button = document.querySelector("[data-install-app='true']");
    var confirm = document.querySelector("[data-install-confirm='true']");
    var help = document.querySelector("[data-install-help]");

    if (button) {
      button.hidden = !isVisible || !!isIosHint;
    }
    if (!card) {
      return;
    }
    card.hidden = !isVisible;
    card.classList.toggle("is-ios-hint", !!isIosHint);
    if (help) {
      help.textContent = isIosHint
        ? "Tap Share, then Add to Home Screen to install this app on iPhone."
        : "Open it from your phone home screen with a faster app-like experience.";
    }
    if (confirm) {
      confirm.textContent = isIosHint ? "Got it" : "Install";
    }
  }

  function dismissInstallPrompt() {
    window.localStorage.setItem(installPromptStorageKey, String(Date.now()));
    setInstallPromptVisible(false, false);
  }

  function promptAppInstall() {
    if (isIosSafariInstallPath()) {
      dismissInstallPrompt();
      return;
    }
    if (!deferredInstallPrompt) {
      showToast("Install will appear when your browser says this device is ready.", "success");
      return;
    }
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function (choice) {
      if (choice && choice.outcome === "accepted") {
        showToast("TransferFlow is installing.", "success");
      }
      deferredInstallPrompt = null;
      setInstallPromptVisible(false, false);
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in window.navigator) || !window.isSecureContext) {
      return;
    }
    window.navigator.serviceWorker.register("/service-worker.js").catch(function () {});
  }

  function initInstallPrompt() {
    var installButton = document.querySelector("[data-install-app='true']");
    var confirmButton = document.querySelector("[data-install-confirm='true']");
    var dismissButton = document.querySelector("[data-install-dismiss='true']");

    registerServiceWorker();

    if (isStandaloneApp()) {
      setInstallPromptVisible(false, false);
      return;
    }

    if (installButton && installButton.getAttribute("data-install-bound") !== "true") {
      installButton.setAttribute("data-install-bound", "true");
      installButton.addEventListener("click", promptAppInstall);
    }
    if (confirmButton && confirmButton.getAttribute("data-install-bound") !== "true") {
      confirmButton.setAttribute("data-install-bound", "true");
      confirmButton.addEventListener("click", promptAppInstall);
    }
    if (dismissButton && dismissButton.getAttribute("data-install-bound") !== "true") {
      dismissButton.setAttribute("data-install-bound", "true");
      dismissButton.addEventListener("click", dismissInstallPrompt);
    }

    if (isIosSafariInstallPath() && shouldShowInstallPrompt()) {
      setInstallPromptVisible(true, true);
    }
  }

  function createRipple(effectTarget, event) {
    var rect;
    var ripple;
    var size;
    if (!effectTarget || !event || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    rect = effectTarget.getBoundingClientRect();
    size = Math.max(rect.width, rect.height);
    ripple = document.createElement("span");
    ripple.className = "ui-ripple";
    ripple.style.width = size + "px";
    ripple.style.height = size + "px";
    ripple.style.left = event.clientX - rect.left - size / 2 + "px";
    ripple.style.top = event.clientY - rect.top - size / 2 + "px";
    Array.prototype.slice.call(effectTarget.querySelectorAll(".ui-ripple")).forEach(function (existingRipple) {
      existingRipple.remove();
    });
    effectTarget.appendChild(ripple);
    window.setTimeout(function () {
      ripple.remove();
    }, 450);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getStoredThemePreference() {
    try {
      return window.localStorage.getItem(themeStorageKey) || "";
    } catch (_storageError) {
      return "";
    }
  }

  function getResolvedTheme() {
    var storedTheme = getStoredThemePreference();
    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme;
    }
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }

  function applyTheme(theme, shouldPersist) {
    var normalizedTheme = theme === "dark" ? "dark" : "light";
    var isDark = normalizedTheme === "dark";
    document.documentElement.classList.toggle("theme-dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    if (document.body) {
      document.body.classList.toggle("theme-dark", isDark);
    }
    document.querySelectorAll("[data-theme-toggle='true']").forEach(function (button) {
      var label = button.querySelector("[data-theme-label]");
      button.setAttribute("aria-pressed", isDark ? "true" : "false");
      button.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
      if (label) {
        label.textContent = isDark ? "Light mode" : "Dark mode";
      }
    });
    if (shouldPersist === false) {
      return;
    }
    try {
      window.localStorage.setItem(themeStorageKey, normalizedTheme);
    } catch (_storageError) {}
  }

  function toggleTheme() {
    var nextTheme = document.documentElement.classList.contains("theme-dark") ? "light" : "dark";
    applyTheme(nextTheme, true);
    showToast(nextTheme === "dark" ? "Dark mode enabled." : "Light mode enabled.", "success");
    announceStatus(nextTheme === "dark" ? "Dark mode enabled." : "Light mode enabled.");
  }

  function syncModalShellState() {
    var shell = document.querySelector(".app-shell");
    var hasModalOpen =
      document.body.classList.contains("command-palette-open") ||
      document.body.classList.contains("detail-drawer-open") ||
      document.body.classList.contains("transfer-approval-open");
    if (!shell) {
      return;
    }
    try {
      shell.inert = hasModalOpen;
    } catch (_inertError) {}
    if (hasModalOpen) {
      shell.setAttribute("aria-hidden", "true");
      return;
    }
    shell.removeAttribute("aria-hidden");
  }

  function getCommandPaletteElements() {
    return {
      root: document.querySelector("[data-command-palette='true']"),
      overlay: document.querySelector("[data-command-overlay='true']"),
      input: document.querySelector("[data-command-palette-input='true']"),
      list: document.querySelector("[data-command-palette-list='true']"),
    };
  }

  function getDetailDrawerElements() {
    return {
      root: document.querySelector("[data-detail-drawer='true']"),
      overlay: document.querySelector("[data-detail-overlay='true']"),
      chip: document.querySelector("[data-detail-chip]"),
      eyebrow: document.querySelector("[data-detail-eyebrow]"),
      title: document.querySelector("[data-detail-title]"),
      summary: document.querySelector("[data-detail-summary]"),
      fields: document.querySelector("[data-detail-fields]"),
      copyAllButton: document.querySelector("[data-detail-copy-all='true']"),
      closeButton: document.querySelector("[data-detail-close='true']"),
    };
  }

  function updateCommandPaletteToggleState(isOpen) {
    document.querySelectorAll("[data-command-palette-toggle='true']").forEach(function (button) {
      button.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  function buildCommandPaletteCommands() {
    var commands = [
      {
        icon: "D",
        group: "Navigate",
        title: "Open dashboard",
        subtitle: "Review KPIs, charts, and transaction activity.",
        keywords: "dashboard home kpi charts transactions overview",
        url: "/dashboard",
      },
      {
        icon: "S",
        group: "Navigate",
        title: "Open send money",
        subtitle: "Create and confirm a transfer request.",
        keywords: "send money transfer payment payout",
        url: "/send-money",
      },
      {
        icon: "R",
        group: "Navigate",
        title: "Open recent transfers",
        subtitle: "Reuse saved transfer details.",
        keywords: "recent transfers repeat recipients reuse",
        url: "/recent-transfers",
      },
      {
        icon: "Q",
        group: "Navigate",
        title: "Open requests",
        subtitle: "Monitor live request queue.",
        keywords: "requests queue approvals pending getrequests",
        url: "/requests",
      },
      {
        icon: "B",
        group: "Navigate",
        title: "Open balance",
        subtitle: "Review the latest balance per operator.",
        keywords: "balance operator balances latest wallet float",
        url: "/balance",
      },
      {
        icon: "M",
        group: "Navigate",
        title: "Open messages",
        subtitle: "Inspect inbound messages and sender context.",
        keywords: "messages inbox sms sender logs",
        url: "/messages",
      },
      {
        icon: "⚙",
        group: "Navigate",
        title: "Open settings",
        subtitle: "Manage tabs, preferences, and operator controls.",
        keywords: "settings config preferences operators",
        url: "/settings",
      },
      {
        icon: "↻",
        group: "Actions",
        title: "Refresh current page",
        subtitle: "Reload the current view without losing context.",
        keywords: "refresh reload sync update current page",
        onRun: function () {
          var targetSelector = inferFragmentTarget(window.location.href);
          if (targetSelector && document.querySelector(targetSelector)) {
            fetchAndSwap(window.location.href, targetSelector, false, {
              notify: true,
              replaceHistory: true,
            }).catch(function () {
              window.location.reload();
            });
            return;
          }
          window.location.reload();
        },
      },
      {
        icon: "◐",
        group: "Appearance",
        title: document.documentElement.classList.contains("theme-dark") ? "Switch to light mode" : "Switch to dark mode",
        subtitle: "Toggle the control center color theme.",
        keywords: "theme dark mode light mode appearance",
        onRun: function () {
          toggleTheme();
        },
      },
    ];

    if (getFocusableSearchField()) {
      commands.splice(4, 0, {
        icon: "/",
        group: "Actions",
        title: "Focus page search",
        subtitle: "Jump to the active page search or filter input.",
        keywords: "search filter focus query slash",
        onRun: function () {
          var searchField = getFocusableSearchField();
          if (!searchField) {
            return;
          }
          searchField.focus();
        },
      });
    }

    return commands;
  }

  function filterCommandPaletteCommands(query) {
    var tokens = String(query || "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length === 0) {
      return commandPaletteState.commands.slice();
    }

    return commandPaletteState.commands.filter(function (command) {
      var haystack = [command.title, command.subtitle, command.group, command.keywords].join(" ").toLowerCase();
      return tokens.every(function (token) {
        return haystack.indexOf(token) !== -1;
      });
    });
  }

  function setCommandPaletteActiveIndex(index) {
    var elements = getCommandPaletteElements();
    var items = elements.list ? elements.list.querySelectorAll("[data-command-index]") : [];
    var activeItem;

    if (!items.length) {
      commandPaletteState.activeIndex = 0;
      if (elements.input) {
        elements.input.removeAttribute("aria-activedescendant");
      }
      return;
    }

    commandPaletteState.activeIndex = Math.max(0, Math.min(index, items.length - 1));
    items.forEach(function (item, itemIndex) {
      var isActive = itemIndex === commandPaletteState.activeIndex;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    activeItem = items[commandPaletteState.activeIndex];
    if (elements.input && activeItem) {
      if (!activeItem.id) {
        activeItem.id = "command-item-" + commandPaletteState.activeIndex;
      }
      elements.input.setAttribute("aria-activedescendant", activeItem.id);
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }

  function renderCommandPalette(query) {
    var elements = getCommandPaletteElements();
    if (!elements.list) {
      return;
    }

    commandPaletteState.filteredCommands = filterCommandPaletteCommands(query);
    if (commandPaletteState.filteredCommands.length === 0) {
      elements.list.innerHTML = '<div class="command-empty">No matching actions. Try a page name, action, or keyword.</div>';
      if (elements.input) {
        elements.input.removeAttribute("aria-activedescendant");
      }
      return;
    }

    if (commandPaletteState.activeIndex >= commandPaletteState.filteredCommands.length) {
      commandPaletteState.activeIndex = 0;
    }

    elements.list.innerHTML = commandPaletteState.filteredCommands
      .map(function (command, index) {
        return (
          '<button class="command-item' + (index === commandPaletteState.activeIndex ? " active" : "") + '" type="button" role="option" aria-selected="' + (index === commandPaletteState.activeIndex ? "true" : "false") + '" data-command-index="' + index + '">' +
            '<span class="command-item-icon" aria-hidden="true">' + escapeHtml(command.icon || "•") + "</span>" +
            '<span class="command-item-copy">' +
              '<span class="command-item-group">' + escapeHtml(command.group || "Action") + "</span>" +
              '<strong class="command-item-title">' + escapeHtml(command.title || "Untitled action") + "</strong>" +
              '<span class="command-item-subtitle">' + escapeHtml(command.subtitle || "") + "</span>" +
            "</span>" +
            '<span aria-hidden="true"><kbd>↵</kbd></span>' +
          "</button>"
        );
      })
      .join("");

    setCommandPaletteActiveIndex(commandPaletteState.activeIndex);
  }

  function runCommandPaletteCommand(command) {
    var url;
    var targetSelector;
    if (!command) {
      return;
    }

    closeCommandPalette(false);
    if (typeof command.onRun === "function") {
      command.onRun();
      return;
    }

    if (!command.url) {
      return;
    }

    url = normalizeUrl(command.url);
    targetSelector = inferFragmentTarget(url);
    if (targetSelector && document.querySelector(targetSelector)) {
      fetchAndSwap(url, targetSelector, true, { notify: true }).catch(function () {
        window.location.assign(url);
      });
      return;
    }

    window.location.assign(url);
  }

  function openCommandPalette(opener) {
    var elements = getCommandPaletteElements();
    if (!elements.root || !elements.overlay || !elements.input || !elements.list) {
      return false;
    }

    closeDetailDrawer(false);
    setDrawerState(false);
    commandPaletteState.opener = opener || document.activeElement;
    commandPaletteState.commands = buildCommandPaletteCommands();
    commandPaletteState.filteredCommands = commandPaletteState.commands.slice();
    commandPaletteState.activeIndex = 0;
    elements.root.hidden = false;
    elements.overlay.hidden = false;
    document.body.classList.add("command-palette-open");
    updateCommandPaletteToggleState(true);
    syncModalShellState();
    elements.input.value = "";
    syncFloatingField(elements.input);
    renderCommandPalette("");
    elements.input.focus();
    announceStatus("Command palette opened.");
    return true;
  }

  function closeCommandPalette(shouldRestoreFocus) {
    var elements = getCommandPaletteElements();
    var opener = commandPaletteState.opener;
    if (!document.body.classList.contains("command-palette-open")) {
      return false;
    }
    if (elements.root) {
      elements.root.hidden = true;
    }
    if (elements.overlay) {
      elements.overlay.hidden = true;
    }
    document.body.classList.remove("command-palette-open");
    updateCommandPaletteToggleState(false);
    syncModalShellState();
    if (shouldRestoreFocus !== false && opener && typeof opener.focus === "function") {
      opener.focus();
    }
    return true;
  }

  function parseDetailPayload(trigger) {
    var rawPayload = trigger ? trigger.getAttribute("data-detail-payload") : "";
    if (!rawPayload) {
      return null;
    }
    try {
      return JSON.parse(rawPayload);
    } catch (_parseError) {
      return null;
    }
  }

  function renderDetailDrawer(payload) {
    var elements = getDetailDrawerElements();
    var fields = Array.isArray(payload && payload.fields) ? payload.fields : [];
    if (!elements.root || !elements.fields) {
      return;
    }

    if (elements.eyebrow) {
      elements.eyebrow.textContent = payload && payload.eyebrow ? payload.eyebrow : "Details";
    }
    if (elements.title) {
      elements.title.textContent = payload && payload.title ? payload.title : "Record details";
    }
    if (elements.summary) {
      elements.summary.textContent = payload && payload.summary ? payload.summary : "Review the selected record.";
    }
    if (elements.chip) {
      if (payload && payload.tone_label) {
        elements.chip.hidden = false;
        elements.chip.textContent = payload.tone_label;
        elements.chip.setAttribute("data-tone", payload.tone || "info");
      } else {
        elements.chip.hidden = true;
        elements.chip.textContent = "";
        elements.chip.removeAttribute("data-tone");
      }
    }
    if (elements.copyAllButton) {
      elements.copyAllButton.hidden = fields.length === 0;
    }

    elements.fields.innerHTML = fields
      .map(function (field) {
        var label = field && field.label != null ? field.label : "";
        var value = field && field.value != null && String(field.value) !== "" ? field.value : "-";
        return (
          '<div class="detail-field">' +
            "<dt>" + escapeHtml(label) + "</dt>" +
            "<dd><span class=\"detail-value\">" + escapeHtml(value) + "</span><button class=\"detail-copy-btn\" type=\"button\" data-detail-copy-field=\"true\">Copy</button></dd>" +
          "</div>"
        );
      })
      .join("");
  }

  function buildDetailCopyText() {
    var payload = detailDrawerState.payload || {};
    var lines = [];
    if (payload.title) {
      lines.push(payload.title);
    }
    if (payload.summary) {
      lines.push(payload.summary);
    }
    (Array.isArray(payload.fields) ? payload.fields : []).forEach(function (field) {
      var label = field && field.label != null ? field.label : "";
      var value = field && field.value != null && String(field.value) !== "" ? field.value : "-";
      lines.push(label + ": " + value);
    });
    return lines.filter(Boolean).join("\n");
  }

  function openDetailDrawer(trigger) {
    var payload = parseDetailPayload(trigger);
    var elements = getDetailDrawerElements();
    if (!payload || !elements.root || !elements.overlay) {
      return false;
    }

    closeCommandPalette(false);
    setDrawerState(false);
    closeDetailDrawer(false);
    detailDrawerState.opener = trigger || document.activeElement;
    detailDrawerState.row = trigger ? trigger.closest("tr") : null;
    detailDrawerState.payload = payload;
    if (detailDrawerState.row) {
      detailDrawerState.row.classList.add("is-selected");
    }
    renderDetailDrawer(payload);
    elements.root.hidden = false;
    elements.overlay.hidden = false;
    document.body.classList.add("detail-drawer-open");
    syncModalShellState();
    if (elements.closeButton) {
      elements.closeButton.focus();
    }
    announceStatus((payload.title || "Details") + " opened.");
    return true;
  }

  function closeDetailDrawer(shouldRestoreFocus) {
    var elements = getDetailDrawerElements();
    var opener = detailDrawerState.opener;
    if (!document.body.classList.contains("detail-drawer-open")) {
      return false;
    }
    if (detailDrawerState.row) {
      detailDrawerState.row.classList.remove("is-selected");
    }
    detailDrawerState.row = null;
    detailDrawerState.opener = null;
    detailDrawerState.payload = null;
    if (elements.root) {
      elements.root.hidden = true;
    }
    if (elements.overlay) {
      elements.overlay.hidden = true;
    }
    document.body.classList.remove("detail-drawer-open");
    syncModalShellState();
    if (shouldRestoreFocus !== false && opener && typeof opener.focus === "function") {
      opener.focus();
    }
    return true;
  }

  function getFocusableSearchField() {
    return (
      document.querySelector("#dashboard-page-root [name='q']") ||
      document.querySelector("#messages-page-root [name='q']") ||
      document.querySelector("#send-money-form [name='receiver_phone_number']")
    );
  }

  function syncFloatingField(field) {
    var wrapper;
    var value;
    if (!field) {
      return;
    }
    wrapper = field.closest(".floating-field");
    if (!wrapper) {
      return;
    }
    value = String(field.value || "").trim();
    if (field.tagName === "SELECT") {
      value = field.value;
    }
    wrapper.classList.toggle("has-value", !!value);
  }

  function initFloatingFields(scopeRoot) {
    var root = scopeRoot && scopeRoot.querySelector ? scopeRoot : document;
    root.querySelectorAll(".floating-field input, .floating-field select").forEach(function (field) {
      syncFloatingField(field);
      if (field.getAttribute("data-floating-bound") === "true") {
        return;
      }
      field.setAttribute("data-floating-bound", "true");
      ["input", "change", "blur"].forEach(function (eventName) {
        field.addEventListener(eventName, function () {
          syncFloatingField(field);
        });
      });
    });
  }

  function readSettingsPreferences() {
    try {
      var stored = JSON.parse(window.localStorage.getItem(settingsPreferenceStorageKey) || "{}");
      return stored && typeof stored === "object" ? stored : {};
    } catch (_storageError) {
      return {};
    }
  }

  function writeSettingsPreferences(preferences) {
    try {
      window.localStorage.setItem(settingsPreferenceStorageKey, JSON.stringify(preferences || {}));
    } catch (_storageError) {}
  }

  function updatePreferenceToggleState(button, isEnabled) {
    if (!button) {
      return;
    }
    button.classList.toggle("on", !!isEnabled);
    button.classList.toggle("off", !isEnabled);
    button.setAttribute("aria-pressed", isEnabled ? "true" : "false");
  }

  function initPreferenceToggles(scopeRoot) {
    var preferences = readSettingsPreferences();
    var root = scopeRoot && scopeRoot.querySelector ? scopeRoot : document;

    root.querySelectorAll("[data-preference-toggle]").forEach(function (button) {
      var key = button.getAttribute("data-preference-toggle");
      var defaultState = button.getAttribute("data-default-state") === "true";
      var currentState = Object.prototype.hasOwnProperty.call(preferences, key) ? !!preferences[key] : defaultState;

      updatePreferenceToggleState(button, currentState);
      if (button.getAttribute("data-preference-bound") === "true") {
        return;
      }

      button.setAttribute("data-preference-bound", "true");
      button.addEventListener("click", function () {
        currentState = !button.classList.contains("on");
        preferences[key] = currentState;
        writeSettingsPreferences(preferences);
        updatePreferenceToggleState(button, currentState);
        showToast("Preference updated.", "success");
        announceStatus("Preference updated.");
      });
    });
  }

  function updateSenderStatusRow(button, isActive) {
    var row = button ? button.closest("[data-sender-config-row]") : null;
    var statusPill = row ? row.querySelector("[data-sender-status-pill]") : null;
    if (!button) {
      return;
    }
    button.classList.toggle("on", !!isActive);
    button.classList.toggle("off", !isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    button.setAttribute("aria-label", (isActive ? "Deactivate " : "Activate ") + (button.getAttribute("data-sender-number") || "sender"));
    if (statusPill) {
      statusPill.classList.toggle("active", !!isActive);
      statusPill.classList.toggle("inactive", !isActive);
      statusPill.textContent = isActive ? "Active" : "Inactive";
    }
  }

  function initSenderStatusToggles(scopeRoot) {
    var root = scopeRoot && scopeRoot.querySelector ? scopeRoot : document;
    root.querySelectorAll("[data-sender-status-toggle='true']").forEach(function (button) {
      if (button.getAttribute("data-sender-status-bound") === "true") {
        return;
      }
      button.setAttribute("data-sender-status-bound", "true");
      button.addEventListener("click", async function () {
        var nextState = !button.classList.contains("on");
        var previousState = !nextState;
        var senderNumber = button.getAttribute("data-sender-number") || "";

        updateSenderStatusRow(button, nextState);
        setElementLoadingState(button, true);
        try {
          var response = await fetch("/api/sender-configurations/status", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRF-Token": getCsrfToken(),
            },
            body: JSON.stringify({
              sender_number: senderNumber,
              is_active: nextState,
            }),
          });
          var result = {};
          try {
            result = await response.json();
          } catch (_jsonError) {
            result = {};
          }
          if (!response.ok || result.ok === false) {
            throw new Error(result.error || "Unable to update sender status.");
          }
          showToast(result.message || "Sender configuration updated.", "success");
          announceStatus(result.message || "Sender configuration updated.");
        } catch (error) {
          updateSenderStatusRow(button, previousState);
          showToast(error.message || "Unable to update sender status.", "error");
          announceStatus(error.message || "Unable to update sender status.");
        } finally {
          setElementLoadingState(button, false);
        }
      });
    });
  }

  function formatDateForInput(date) {
    var adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return adjusted.toISOString().slice(0, 10);
  }

  function applyMessagesDateRange(button) {
    var form = button ? button.closest("form") : null;
    var fromField;
    var toField;
    var presetValue;
    var today;
    var startDate;
    if (!form) {
      return false;
    }

    fromField = form.querySelector('[name="from_date"]');
    toField = form.querySelector('[name="to_date"]');
    if (!fromField || !toField) {
      return false;
    }

    presetValue = button.getAttribute("data-range-days");
    if (presetValue === "clear") {
      fromField.value = "";
      toField.value = "";
    } else {
      today = new Date();
      startDate = new Date(today);
      if (presetValue !== "0") {
        startDate.setDate(today.getDate() - (Number(presetValue) - 1));
      }
      fromField.value = formatDateForInput(startDate);
      toField.value = formatDateForInput(today);
    }

    initFloatingFields(form);
    form.requestSubmit();
    return true;
  }

  function closeOpenDetails() {
    var didClose = false;
    document.querySelectorAll("details[open]").forEach(function (detail) {
      detail.open = false;
      didClose = true;
    });
    return didClose;
  }

  function setDrawerState(isOpen) {
    var overlay = document.querySelector("[data-drawer-overlay='true']");
    document.body.classList.toggle("nav-drawer-open", !!isOpen);
    if (overlay) {
      overlay.hidden = !isOpen;
    }
    document.querySelectorAll("[data-drawer-toggle='true']").forEach(function (button) {
      button.setAttribute("aria-expanded", isOpen ? "true" : "false");
      button.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
    });
  }

  function setMobileMoreState(isOpen) {
    var toggle = document.getElementById("mobile-more-toggle");
    document.body.classList.toggle("mobile-more-open", !!isOpen);
    if (toggle) {
      toggle.checked = !!isOpen;
    }
  }

  function focusUpdatedContent(targetSelector) {
    var target = document.querySelector(targetSelector);
    if (!target || typeof target.focus !== "function") {
      return;
    }
    try {
      target.focus({ preventScroll: false });
    } catch (_focusError) {
      target.focus();
    }
  }

  async function fetchAndSwap(url, targetSelector, pushHistory, options) {
    var settings = options || {};
    var requestUrl = normalizeUrl(url);
    var currentTarget = document.querySelector(targetSelector);
    var controller = beginPendingRequest(targetSelector, requestUrl);
    var response;
    var html;
    var nextTarget;

    setBusyState(currentTarget, true);
    setFragmentLoadingState(currentTarget, true);

    try {
      response = await fetch(requestUrl, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: controller.signal,
      });
      html = await response.text();
      if (!isLatestPendingRequest(targetSelector, controller)) {
        return false;
      }
      if (!response.ok) {
        throw new Error("Request failed (" + response.status + ").");
      }
      if (!replaceTargetFromHtml(targetSelector, html)) {
        throw new Error("Unable to update page section.");
      }
      if (pushHistory) {
        writeHistoryState(requestUrl, targetSelector, false);
      } else if (settings.replaceHistory) {
        writeHistoryState(requestUrl, targetSelector, true);
      }
      nextTarget = document.querySelector(targetSelector);
      if (clearPendingRequest(targetSelector, controller)) {
        setBusyState(nextTarget, false);
        setFragmentLoadingState(nextTarget, false);
      }
      if (settings.restoreFocus !== false) {
        focusUpdatedContent(targetSelector);
      }
      if (settings.notify !== false) {
        announceStatus(settings.message || "Content updated.");
      }
      window.dispatchEvent(new CustomEvent("ux:content-updated", { detail: { target: targetSelector } }));
      return true;
    } catch (error) {
      if (clearPendingRequest(targetSelector, controller)) {
        setBusyState(currentTarget, false);
        setFragmentLoadingState(currentTarget, false);
      }
      if (error && error.name === "AbortError") {
        return false;
      }
      announceStatus(error && error.message ? error.message : "Request failed.");
      if (!settings.suppressToast) {
        showToast(error && error.message ? error.message : "Request failed.", "error");
      }
      showAsyncErrorPanel(currentTarget, error && error.message ? error.message : "Request failed.");
      throw error;
    }
  }

  async function fetchAndSwapPage(url, pushHistory, options) {
    var settings = options || {};
    var requestUrl = normalizeUrl(url);
    var currentMain = document.querySelector("#main-content");
    var targetSelector = inferFragmentTarget(requestUrl);
    var controller = beginPendingRequest("#main-content", requestUrl);
    var response;
    var html;

    setBusyState(currentMain, true);
    setFragmentLoadingState(currentMain, true);

    try {
      response = await fetch(requestUrl, {
        headers: {
          Accept: "text/html",
        },
        signal: controller.signal,
      });
      html = await response.text();
      if (!isLatestPendingRequest("#main-content", controller)) {
        return false;
      }
      if (!response.ok) {
        throw new Error("Request failed (" + response.status + ").");
      }
      if (!replacePageShellFromHtml(html)) {
        throw new Error("Unable to update page.");
      }
      if (pushHistory) {
        writeHistoryState(requestUrl, targetSelector, false);
      } else if (settings.replaceHistory) {
        writeHistoryState(requestUrl, targetSelector, true);
      }
      if (clearPendingRequest("#main-content", controller)) {
        setBusyState(document.querySelector("#main-content"), false);
        setFragmentLoadingState(document.querySelector("#main-content"), false);
      }
      if (settings.restoreFocus !== false) {
        focusUpdatedContent(targetSelector || "#main-content");
      }
      if (settings.notify !== false) {
        announceStatus(settings.message || "Content updated.");
      }
      window.dispatchEvent(new CustomEvent("ux:content-updated", { detail: { target: targetSelector || "#main-content" } }));
      return true;
    } catch (error) {
      if (clearPendingRequest("#main-content", controller)) {
        setBusyState(currentMain, false);
        setFragmentLoadingState(currentMain, false);
      }
      if (error && error.name === "AbortError") {
        return false;
      }
      announceStatus(error && error.message ? error.message : "Request failed.");
      if (!settings.suppressToast) {
        showToast(error && error.message ? error.message : "Request failed.", "error");
      }
      showAsyncErrorPanel(currentMain, error && error.message ? error.message : "Request failed.");
      throw error;
    }
  }

  window.CodexUX = window.CodexUX || {};
  window.CodexUX.fetchAndSwap = fetchAndSwap;
  window.CodexUX.fetchAndSwapPage = fetchAndSwapPage;
  window.CodexUX.inferFragmentTarget = inferFragmentTarget;
  window.CodexUX.replaceHistoryState = function (url, targetSelector) {
    writeHistoryState(url || window.location.href, targetSelector || inferFragmentTarget(url), true);
  };
  window.CodexUX.syncHistoryState = syncCurrentHistoryState;

  function buildGetUrl(form) {
    var action = form.getAttribute("action") || window.location.pathname;
    var url = new URL(action, window.location.origin);
    var formData = new FormData(form);
    url.search = "";

    formData.forEach(function (value, key) {
      var normalizedValue = String(value == null ? "" : value).trim();
      if (!normalizedValue) {
        return;
      }
      url.searchParams.append(key, normalizedValue);
    });
    return url.toString();
  }

  function clearScheduledAutoSubmit(form) {
    if (!form || !autoSubmitTimers.has(form)) {
      return;
    }
    window.clearTimeout(autoSubmitTimers.get(form));
    autoSubmitTimers.delete(form);
  }

  function scheduleAutoSubmit(form, delay) {
    if (!form) {
      return;
    }
    clearScheduledAutoSubmit(form);
    autoSubmitTimers.set(form, window.setTimeout(function () {
      autoSubmitTimers.delete(form);
      form.requestSubmit();
    }, delay || 250));
  }

  function normalizePhone(value) {
    var digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 9) {
      return "+255" + digits;
    }
    if (digits.length === 10 && digits.charAt(0) === "0") {
      return "+255" + digits.slice(1);
    }
    if (digits.length === 12 && digits.indexOf("255") === 0) {
      return "+" + digits;
    }
    return "";
  }

  function normalizeReceiverPhone(value) {
    var digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.indexOf("255") === 0) {
      digits = "0" + digits.slice(3);
    } else if (digits.length === 9) {
      digits = "0" + digits;
    }
    return digits.length === 10 && digits.charAt(0) === "0" ? digits : "";
  }

  function normalizeLocalPhone(value) {
    return normalizeReceiverPhone(value);
  }

  function inferMobileOperatorName(phoneNumber) {
    var digits = String(phoneNumber || "").replace(/\D/g, "");
    var national;
    var prefix;
    if (digits.indexOf("255") === 0) {
      national = digits.slice(3);
    } else if (digits.charAt(0) === "0") {
      national = digits.slice(1);
    } else {
      national = digits;
    }
    prefix = national.slice(0, 2);
    if (prefix === "61" || prefix === "62") {
      return "Halotel";
    }
    if (prefix === "68" || prefix === "69" || prefix === "78") {
      return "Airtel";
    }
    if (prefix === "65" || prefix === "67" || prefix === "71" || prefix === "77") {
      return "Yas";
    }
    if (prefix === "74" || prefix === "75" || prefix === "76" || prefix === "79") {
      return "Vodacom";
    }
    return "";
  }

  function formatCurrencyAmount(value) {
    var numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      numeric = 0;
    }
    return "TZS " + numeric.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatTransferTime(value) {
    var parsed = value ? new Date(value) : new Date();
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
      parsed = new Date();
    }
    return parsed.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getRecentTransfers() {
    try {
      var stored = JSON.parse(window.localStorage.getItem(recentTransfersStorageKey) || "[]");
      return Array.isArray(stored) ? stored : [];
    } catch (_storageError) {
      return [];
    }
  }

  function saveRecentTransfers(items) {
    try {
      window.localStorage.setItem(recentTransfersStorageKey, JSON.stringify(items || []));
    } catch (_storageError) {}
  }

  function savePendingRecentTransfer(item) {
    try {
      window.localStorage.setItem(pendingRecentTransferStorageKey, JSON.stringify(item || {}));
    } catch (_storageError) {}
  }

  function takePendingRecentTransfer() {
    var item = null;
    try {
      item = JSON.parse(window.localStorage.getItem(pendingRecentTransferStorageKey) || "null");
      window.localStorage.removeItem(pendingRecentTransferStorageKey);
    } catch (_storageError) {
      item = null;
    }
    return item && typeof item === "object" ? item : null;
  }

  function addRecentTransfer(record) {
    var items = getRecentTransfers();
    var key = [record.sender_mobile_number, record.receiver_phone_number, String(record.amount_value || record.amount || "")].join("|");
    items = items.filter(function (item) {
      var itemKey = [item.sender_mobile_number, item.receiver_phone_number, String(item.amount_value || item.amount || "")].join("|");
      return itemKey !== key;
    });
    items.unshift(record);
    saveRecentTransfers(items.slice(0, maxRecentTransfers));
  }

  function removeRecentTransfer(index) {
    var items = getRecentTransfers();
    if (index < 0 || index >= items.length) {
      return false;
    }
    items.splice(index, 1);
    saveRecentTransfers(items);
    return true;
  }

  function getRecentTransferSearchQuery() {
    var searchField = document.querySelector("[data-recent-transfer-search='true']");
    return searchField ? String(searchField.value || "").trim().toLowerCase() : "";
  }

  function getRecentTransferSearchText(item) {
    var receiverOperator = item.receiver_mobile_operator || inferMobileOperatorName(item.receiver_phone_number);
    var senderOperator = item.mobile_operator || inferMobileOperatorName(item.sender_mobile_number);
    return [
      item.sender_mobile_number,
      item.receiver_phone_number,
      item.amount_value,
      item.amount,
      item.client_code,
      senderOperator,
      receiverOperator,
      item.reference,
      item.status,
    ].join(" ").toLowerCase();
  }

  function getOperatorBadgeTone(operatorName) {
    var normalized = String(operatorName || "").toLowerCase();
    if (normalized.indexOf("voda") !== -1) {
      return "vodacom";
    }
    if (normalized.indexOf("airtel") !== -1) {
      return "airtel";
    }
    if (normalized.indexOf("halotel") !== -1) {
      return "halotel";
    }
    if (normalized.indexOf("yas") !== -1 || normalized.indexOf("tigo") !== -1) {
      return "yas";
    }
    return "neutral";
  }

  function renderOperatorBadge(operatorName) {
    if (!operatorName) {
      return "";
    }
    return '<span class="operator-badge operator-badge-' + getOperatorBadgeTone(operatorName) + '">' + escapeHtml(operatorName) + "</span>";
  }

  function buildRecentTransferDetailPayload(item) {
    var receiverOperator = item.receiver_mobile_operator || inferMobileOperatorName(item.receiver_phone_number) || "-";
    var senderOperator = item.mobile_operator || inferMobileOperatorName(item.sender_mobile_number) || "-";
    return {
      eyebrow: "Recent transfer",
      title: item.receiver_phone_number || "Saved transfer",
      summary: "Saved locally after a successful transfer request.",
      tone: "info",
      tone_label: item.status || "Saved",
      fields: [
        { label: "Receiver", value: item.receiver_phone_number || "-" },
        { label: "Receiver operator", value: receiverOperator },
        { label: "Sender", value: item.sender_mobile_number || "-" },
        { label: "Sender operator", value: senderOperator },
        { label: "Client code", value: item.client_code || "-" },
        { label: "Amount", value: formatCurrencyAmount(item.amount_value || item.amount || 0) },
        { label: "Reference", value: item.reference || "-" },
        { label: "Saved", value: formatTransferTime(item.submitted_at) },
      ],
    };
  }

  function renderRecentTransfers() {
    var list = document.getElementById("recent-transfer-list");
    var items = getRecentTransfers();
    var query = getRecentTransferSearchQuery();
    var filteredItems;
    if (!list) {
      return;
    }
    if (items.length === 0) {
      list.innerHTML =
        '<div class="recent-transfer-empty-state">' +
          '<strong>No recent transfers yet.</strong>' +
          '<p>Successful transfer requests will appear here for quick reuse.</p>' +
          '<a class="filter-btn" href="/send-money">New transfer</a>' +
        "</div>";
      return;
    }

    filteredItems = items
      .map(function (item, index) {
        return { item: item, index: index };
      })
      .filter(function (entry) {
        return !query || getRecentTransferSearchText(entry.item).indexOf(query) !== -1;
      });

    if (filteredItems.length === 0) {
      list.innerHTML =
        '<div class="recent-transfer-empty-state">' +
          '<strong>No matching transfers.</strong>' +
          '<p>Try a receiver number, sender number, amount, or operator.</p>' +
        "</div>";
      return;
    }

    list.innerHTML = filteredItems
      .map(function (entry) {
        var item = entry.item;
        var index = entry.index;
        var receiverOperator = item.receiver_mobile_operator || inferMobileOperatorName(item.receiver_phone_number);
        var senderOperator = item.mobile_operator || inferMobileOperatorName(item.sender_mobile_number);
        var detailPayload = escapeHtml(JSON.stringify(buildRecentTransferDetailPayload(item)));
        return (
          '<article class="recent-transfer-item">' +
            '<div class="recent-transfer-meta">' +
              '<strong>' + escapeHtml(item.receiver_phone_number || "-") + '</strong>' +
              '<span>' + escapeHtml(item.sender_mobile_number || "-") + "</span>" +
              '<span class="recent-transfer-badges">' + renderOperatorBadge(receiverOperator) + renderOperatorBadge(senderOperator) + "</span>" +
            "</div>" +
            '<div class="recent-transfer-side">' +
              '<strong>' + formatCurrencyAmount(item.amount_value || item.amount || 0) + "</strong>" +
              '<span>' + formatTransferTime(item.submitted_at) + "</span>" +
            "</div>" +
            '<div class="recent-transfer-actions">' +
              '<button class="filter-btn recent-transfer-action primary" type="button" data-reuse-transfer="' + index + '">Reuse</button>' +
              '<button class="filter-btn recent-transfer-action" type="button" data-detail-trigger="true" data-detail-payload="' + detailPayload + '">Details</button>' +
              '<button class="filter-btn recent-transfer-action danger" type="button" data-remove-transfer="' + index + '">Remove</button>' +
            "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function fillSendMoneyFormFromRecent(sendMoneyForm, recentItem) {
    var senderField;
    var senderValue;
    var senderLocalValue;
    if (!sendMoneyForm || !recentItem) {
      return false;
    }
    senderField = sendMoneyForm.querySelector('[name="sender_mobile_number"]');
    senderValue = normalizePhone(recentItem.sender_mobile_number) || recentItem.sender_mobile_number || "";
    senderLocalValue = normalizeLocalPhone(recentItem.sender_mobile_number);
    if (senderField) {
      senderField.value = senderValue;
      if (!senderField.value && senderLocalValue) {
        senderField.value = senderLocalValue;
      }
    }
    sendMoneyForm.querySelector('[name="receiver_phone_number"]').value = recentItem.receiver_phone_number || "";
    sendMoneyForm.querySelector('[name="amount"]').value = recentItem.amount_value || recentItem.amount || "";
    initFloatingFields(sendMoneyForm);
    syncSenderDetails(sendMoneyForm);
    syncReceiverDetails(sendMoneyForm);
    setFormFeedback(sendMoneyForm, "Recent transfer loaded. Review and submit when ready.", "info");
    announceStatus("Recent transfer loaded.");
    return true;
  }

  function applyPendingRecentTransfer() {
    var sendMoneyForm = document.getElementById("send-money-form");
    var pendingItem;
    if (!sendMoneyForm) {
      return;
    }
    pendingItem = takePendingRecentTransfer();
    if (pendingItem) {
      fillSendMoneyFormFromRecent(sendMoneyForm, pendingItem);
    }
  }

  function getSelectedSenderDetails(form) {
    var senderField = form ? form.querySelector('[name="sender_mobile_number"]') : null;
    var selectedOption = senderField && senderField.options ? senderField.options[senderField.selectedIndex] : null;
    return {
      client_code: selectedOption ? String(selectedOption.getAttribute("data-client-code") || "").trim() : "",
      mobile_operator: selectedOption ? String(selectedOption.getAttribute("data-mobile-operator") || "").trim() : "",
      request_path: selectedOption ? String(selectedOption.getAttribute("data-request-path") || "").trim() : "",
    };
  }

  function syncSenderDetails(form) {
    var details = getSelectedSenderDetails(form);
    var strip = form ? form.querySelector("[data-sender-detail-strip]") : null;
    var clientCode = form ? form.querySelector("[data-sender-client-code]") : null;
    var mobileOperator = form ? form.querySelector("[data-sender-mobile-operator]") : null;
    var hasDetails = !!(details.client_code || details.mobile_operator);

    if (strip) {
      strip.hidden = !hasDetails;
    }
    if (clientCode) {
      clientCode.textContent = details.client_code || "-";
    }
    if (mobileOperator) {
      mobileOperator.textContent = details.mobile_operator || "-";
    }
  }

  function syncReceiverDetails(form) {
    var receiverField = form ? form.querySelector('[name="receiver_phone_number"]') : null;
    var normalizedReceiver = normalizeReceiverPhone(receiverField && receiverField.value);
    var receiverOperator = normalizedReceiver ? inferMobileOperatorName(normalizedReceiver) : "";
    var strip = form ? form.querySelector("[data-receiver-detail-strip]") : null;
    var mobileOperator = form ? form.querySelector("[data-receiver-mobile-operator]") : null;

    if (strip) {
      strip.hidden = !receiverOperator;
    }
    if (mobileOperator) {
      mobileOperator.textContent = receiverOperator || "-";
    }
    return receiverOperator;
  }

  function getTransferConfirmationElements() {
    var modal = document.querySelector("[data-transfer-confirmation-modal]");
    return {
      modal: modal,
      sender: modal ? modal.querySelector("[data-confirmation-sender]") : null,
      client: modal ? modal.querySelector("[data-confirmation-client]") : null,
      receiver: modal ? modal.querySelector("[data-confirmation-receiver]") : null,
      operator: modal ? modal.querySelector("[data-confirmation-operator]") : null,
      amount: modal ? modal.querySelector("[data-confirmation-amount]") : null,
      confirmButton: modal ? modal.querySelector("[data-confirmation-submit='true']") : null,
    };
  }

  function closeTransferConfirmationModal(shouldRestoreFocus) {
    var elements = getTransferConfirmationElements();
    if (elements.modal) {
      elements.modal.hidden = true;
    }
    pendingTransferConfirmationPayload = null;
    document.body.classList.remove("transfer-confirmation-open");
    if (shouldRestoreFocus !== false && transferConfirmationOpener && typeof transferConfirmationOpener.focus === "function") {
      transferConfirmationOpener.focus();
    }
    transferConfirmationOpener = null;
  }

  function showTransferConfirmationModal(form, payload) {
    var elements = getTransferConfirmationElements();
    if (!elements.modal) {
      return submitTransferPayload(form, payload);
    }
    pendingTransferConfirmationPayload = payload;
    transferConfirmationOpener = form ? form.querySelector('[type="submit"]') : document.activeElement;
    if (elements.sender) {
      elements.sender.textContent = payload.sender_local_number || payload.sender_mobile_number || "-";
    }
    if (elements.client) {
      elements.client.textContent = payload.client_code || "-";
    }
    if (elements.receiver) {
      elements.receiver.textContent = payload.receiver_phone_number || "-";
    }
    if (elements.operator) {
      elements.operator.textContent = payload.receiver_mobile_operator || payload.mobile_operator || "-";
    }
    if (elements.amount) {
      elements.amount.textContent = formatCurrencyAmount(payload.amount);
    }
    elements.modal.hidden = false;
    document.body.classList.add("transfer-confirmation-open");
    setFormFeedback(form, "Review the transfer summary before sending.", "info");
    announceStatus("Review transfer details before sending.");
    if (elements.confirmButton) {
      elements.confirmButton.focus();
    }
    return undefined;
  }

  function confirmTransferSubmission() {
    var form = document.getElementById("send-money-form");
    var payload = pendingTransferConfirmationPayload;
    if (!form || !payload) {
      closeTransferConfirmationModal(false);
      return;
    }
    closeTransferConfirmationModal(false);
    submitTransferPayload(form, payload);
  }

  function buildTransferReceipt(result, payload) {
    var receipt = result && result.receipt && typeof result.receipt === "object" ? result.receipt : {};
    return {
      sender_mobile_number: receipt.sender_mobile_number || payload.sender_mobile_number,
      client_code: receipt.client_code || payload.client_code || "-",
      mobile_operator: receipt.mobile_operator || payload.mobile_operator || "-",
      receiver_phone_number: receipt.receiver_phone_number || payload.receiver_phone_number,
      receiver_mobile_operator: receipt.receiver_mobile_operator || payload.receiver_mobile_operator || "-",
      amount: receipt.amount || formatCurrencyAmount(payload.amount),
      amount_value: Number(receipt.amount_value || payload.amount || 0),
      submitted_at: receipt.submitted_at || new Date().toISOString(),
      reference: receipt.reference || "-",
      status: receipt.status || ("HTTP " + String(result && result.upstream_status ? result.upstream_status : 200)),
    };
  }

  function renderTransferReceipt(form, receipt) {
    var receiptCard = form.querySelector("#transfer-receipt");
    var badge = receiptCard ? receiptCard.querySelector("[data-receipt-badge]") : null;
    var badgeLabel;
    if (!receiptCard) {
      return;
    }
    receiptCard.hidden = false;
    receiptCard.querySelector("[data-receipt-sender]").textContent = receipt.sender_mobile_number;
    receiptCard.querySelector("[data-receipt-client-code]").textContent = receipt.client_code || "-";
    receiptCard.querySelector("[data-receipt-mobile-operator]").textContent = receipt.mobile_operator || "-";
    receiptCard.querySelector("[data-receipt-receiver]").textContent = receipt.receiver_phone_number;
    receiptCard.querySelector("[data-receipt-amount]").textContent = receipt.amount;
    receiptCard.querySelector("[data-receipt-time]").textContent = formatTransferTime(receipt.submitted_at);
    receiptCard.querySelector("[data-receipt-reference]").textContent = receipt.reference || "-";
    receiptCard.querySelector("[data-receipt-status]").textContent = receipt.status || "-";
    if (badge) {
      badgeLabel = /fail|error|declin/i.test(String(receipt.status || "")) ? "Failed" : "Sent";
      badge.classList.remove("status-badge-success", "status-badge-danger", "status-badge-loading");
      badge.classList.add(badgeLabel === "Failed" ? "status-badge-danger" : "status-badge-success");
      badge.lastElementChild.textContent = badgeLabel;
    }
  }

  function stopApprovalPolling() {
    if (approvalPollTimer) {
      window.clearInterval(approvalPollTimer);
      approvalPollTimer = null;
    }
    if (approvalTimeoutTimer) {
      window.clearTimeout(approvalTimeoutTimer);
      approvalTimeoutTimer = null;
    }
  }

  function getApprovalModalElements() {
    var modals = document.querySelectorAll("[data-transfer-approval-modal]");
    var modal = modals.length ? modals[modals.length - 1] : null;
    var staleModals;
    if (modal && document.body && modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    staleModals = Array.prototype.slice.call(modals).filter(function (candidate) {
      return candidate !== modal;
    });
    staleModals.forEach(function (candidate) {
      if (candidate.parentNode) {
        candidate.parentNode.removeChild(candidate);
      }
    });
    return {
      modal: modal,
      message: modal ? modal.querySelector("[data-approval-message]") : null,
      note: modal ? modal.querySelector("[data-approval-note]") : null,
      approveButton: modal ? modal.querySelector("[data-approval-decision='APPROVED']") : null,
      rejectButton: modal ? modal.querySelector("[data-approval-decision='REJECTED']") : null,
      closeButton: modal ? modal.querySelector("[data-approval-close='true']") : null,
    };
  }

  function showApprovalModal(message) {
    var elements = getApprovalModalElements();
    if (!elements.modal) {
      return;
    }
    if (elements.message) {
      elements.message.textContent = message || "Approval required.";
    }
    elements.modal.hidden = false;
    document.body.classList.add("transfer-approval-open");
    syncModalShellState();
    if (elements.approveButton) {
      elements.approveButton.focus();
    }
  }

  function hasApprovalTrackingContext(approvalContext) {
    return Boolean(approvalContext && approvalContext.request_id && approvalContext.owner_token);
  }

  function setApprovalDecisionControlsEnabled(isEnabled) {
    var elements = getApprovalModalElements();
    [elements.approveButton, elements.rejectButton].forEach(function (button) {
      if (!button) {
        return;
      }
      button.disabled = !isEnabled;
      button.setAttribute("aria-disabled", isEnabled ? "false" : "true");
    });
  }

  function hideApprovalModal() {
    var elements = getApprovalModalElements();
    if (elements.modal) {
      elements.modal.hidden = true;
    }
    document.body.classList.remove("transfer-approval-open");
    syncModalShellState();
  }

  function buildApprovalRequestPayload() {
    if (!activeApprovalContext) {
      return null;
    }
    return {
      request_id: activeApprovalContext.request_id,
      owner_token: activeApprovalContext.owner_token,
      initiated_by: activeApprovalContext.initiated_by,
      client_request_id: activeApprovalContext.client_request_id,
    };
  }

  async function pollApprovalStatusOnce(form) {
    var requestPayload = buildApprovalRequestPayload();
    var pollUrl = activeApprovalContext && activeApprovalContext.poll_url ? activeApprovalContext.poll_url : "/api/send-money/approval-status";
    var response;
    var result = {};
    if (!requestPayload || approvalDecisionInFlight) {
      return;
    }
    response = await fetch(pollUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": getCsrfToken(),
      },
      body: JSON.stringify(requestPayload),
    });
    try {
      result = await response.json();
    } catch (_jsonError) {
      result = {};
    }
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || "Unable to poll approval status.");
    }
    if (approvalDecisionInFlight) {
      return;
    }
    if (result.approval_status === "APPROVED" || result.approval_status === "REJECTED") {
      stopApprovalPolling();
      hideApprovalModal();
      setFormFeedback(form, result.message || "Approval decision already recorded.", result.approval_status === "APPROVED" ? "success" : "error");
      showToast(result.message || "Approval decision already recorded.", result.approval_status === "APPROVED" ? "success" : "error");
      return;
    }
    if (result.prompt_text) {
      stopApprovalPolling();
      showApprovalModal(result.prompt_text);
      setApprovalDecisionControlsEnabled(true);
      setFormFeedback(form, "Approval prompt received. Approve or reject to continue.", "info");
      announceStatus("Approval prompt received.");
      return;
    }
    showApprovalModal(result.message || "Waiting for the device to execute the transfer and send the approval prompt.");
    setApprovalDecisionControlsEnabled(false);
    if (form) {
      setFormFeedback(form, "Transfer request created. Waiting for server reply. Auto-rejects after 1 minute with no prompt.", "info");
    }
  }

  function autoRejectApprovalAfterTimeout(form) {
    if (!hasApprovalTrackingContext(activeApprovalContext) || approvalDecisionInFlight) {
      return;
    }
    showApprovalModal("No approval prompt was received within 1 minute. Auto-rejecting this transfer now.");
    setApprovalDecisionControlsEnabled(false);
    setFormFeedback(form, "No approval prompt was received within 1 minute. Auto-rejecting transfer.", "error");
    announceStatus("No approval prompt received. Auto-rejecting transfer.");
    submitApprovalDecision("REJECTED", {
      form: form,
      note: "Auto rejected after 1 minute with no approval prompt.",
      auto: true,
    });
  }

  function startApprovalPolling(form, approvalContext) {
    stopApprovalPolling();
    approvalDecisionInFlight = false;
    activeApprovalContext = approvalContext || null;
    showApprovalModal("Waiting for the device to execute the transfer and send the approval prompt. This will auto-reject after 1 minute if no prompt arrives.");
    setApprovalDecisionControlsEnabled(false);

    if (!hasApprovalTrackingContext(activeApprovalContext)) {
      setFormFeedback(
        form,
        "Transfer request created, but approval tracking details were missing. Open Requests to review the approval prompt.",
        "error"
      );
      showApprovalModal("Transfer request created, but approval tracking details were missing. Open Requests to review the approval prompt.");
      showToast("Transfer request created, but approval tracking details were missing.", "error");
      announceStatus("Transfer request created, but approval tracking details were missing.");
      return;
    }

    setFormFeedback(form, "Transfer request created. Polling every 3 seconds. Auto-rejects after 1 minute with no prompt.", "info");
    pollApprovalStatusOnce(form).catch(function (error) {
      setFormFeedback(form, error.message || "Approval polling failed. Retrying until timeout.", "error");
    });
    approvalPollTimer = window.setInterval(function () {
      pollApprovalStatusOnce(form).catch(function (error) {
        setFormFeedback(form, error.message || "Approval polling failed. Retrying until timeout.", "error");
      });
    }, approvalPollIntervalMs);
    approvalTimeoutTimer = window.setTimeout(function () {
      autoRejectApprovalAfterTimeout(form);
    }, approvalAutoRejectMs);
  }

  async function submitApprovalDecision(decision, options) {
    var requestPayload = buildApprovalRequestPayload();
    var elements = getApprovalModalElements();
    var decisionOptions = options || {};
    var note = decisionOptions.note != null ? decisionOptions.note : elements.note ? elements.note.value : "";
    var decisionUrl = activeApprovalContext && activeApprovalContext.decision_url ? activeApprovalContext.decision_url : "/api/send-money/approval-decision";
    var response;
    var result = {};
    if (!requestPayload || approvalDecisionInFlight) {
      return;
    }
    approvalDecisionInFlight = true;
    requestPayload.decision = decision;
    requestPayload.note = note;
    setElementLoadingState(elements.approveButton, true);
    setElementLoadingState(elements.rejectButton, true);
    try {
      response = await fetch(decisionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify(requestPayload),
      });
      try {
        result = await response.json();
      } catch (_jsonError) {
        result = {};
      }
      if (!response.ok || result.ok === false) {
        throw new Error(result.error || "Unable to submit approval decision.");
      }
      stopApprovalPolling();
      hideApprovalModal();
      document.querySelectorAll("[data-receipt-status]").forEach(function (statusEl) {
        statusEl.textContent = decision === "APPROVED" ? "Approved" : "Rejected";
      });
      document.querySelectorAll("[data-receipt-badge]").forEach(function (badge) {
        badge.classList.remove("status-badge-success", "status-badge-danger", "status-badge-loading");
        badge.classList.add(decision === "APPROVED" ? "status-badge-success" : "status-badge-danger");
        if (badge.lastElementChild) {
          badge.lastElementChild.textContent = decision === "APPROVED" ? "Approved" : "Rejected";
        }
      });
      showToast(result.message || "Approval decision submitted.", decision === "APPROVED" ? "success" : "error");
      announceStatus(result.message || "Approval decision submitted.");
      if (decisionOptions.form) {
        setFormFeedback(
          decisionOptions.form,
          result.message || (decisionOptions.auto ? "Transfer auto-rejected after timeout." : "Approval decision submitted."),
          decision === "APPROVED" ? "success" : "error"
        );
      }
    } catch (error) {
      showToast(error.message || "Unable to submit approval decision.", "error");
      if (decisionOptions.form) {
        setFormFeedback(decisionOptions.form, error.message || "Unable to submit approval decision.", "error");
      }
      approvalDecisionInFlight = false;
    } finally {
      setElementLoadingState(elements.approveButton, false);
      setElementLoadingState(elements.rejectButton, false);
    }
  }

  function copyTextToClipboard(text) {
    if (window.navigator && window.navigator.clipboard && typeof window.navigator.clipboard.writeText === "function") {
      return window.navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      var helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "absolute";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      helper.setSelectionRange(0, helper.value.length);
      try {
        document.execCommand("copy");
        document.body.removeChild(helper);
        resolve();
      } catch (error) {
        document.body.removeChild(helper);
        reject(error);
      }
    });
  }

  function ensureFieldId(field) {
    var existingId;
    var base;
    if (!field) {
      return "";
    }
    existingId = field.getAttribute("id");
    if (existingId) {
      return existingId;
    }
    base = String(field.getAttribute("name") || "field").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    existingId = base + "-input";
    field.setAttribute("id", existingId);
    return existingId;
  }

  function addDescribedByToken(field, token) {
    var values;
    if (!field || !token) {
      return;
    }
    values = String(field.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean);
    if (values.indexOf(token) === -1) {
      values.push(token);
    }
    if (values.length > 0) {
      field.setAttribute("aria-describedby", values.join(" "));
    }
  }

  function removeDescribedByToken(field, token) {
    var values;
    if (!field || !token) {
      return;
    }
    values = String(field.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .filter(function (value) {
        return value !== token;
      });
    if (values.length > 0) {
      field.setAttribute("aria-describedby", values.join(" "));
      return;
    }
    field.removeAttribute("aria-describedby");
  }

  function clearFieldError(field) {
    var fieldId;
    var errorId;
    if (!field) {
      return;
    }
    field.setAttribute("aria-invalid", "false");
    fieldId = ensureFieldId(field);
    errorId = fieldId ? fieldId + "-error" : "";
    var fieldWrap = field.closest(".send-input-wrap");
    if (fieldWrap) {
      fieldWrap.classList.remove("invalid");
    }
    var fieldLabel = field.closest("label");
    if (!fieldLabel) {
      return;
    }
    var errorEl = fieldLabel.querySelector(".field-error");
    if (errorEl) {
      errorEl.remove();
    }
    removeDescribedByToken(field, errorId);
  }

  function setFieldError(field, message) {
    var fieldId;
    var errorId;
    if (!field) {
      return;
    }
    fieldId = ensureFieldId(field);
    errorId = fieldId ? fieldId + "-error" : "";
    field.setAttribute("aria-invalid", "true");
    var fieldWrap = field.closest(".send-input-wrap");
    if (fieldWrap) {
      fieldWrap.classList.add("invalid");
    }
    var fieldLabel = field.closest("label");
    if (!fieldLabel) {
      return;
    }

    var errorEl = fieldLabel.querySelector(".field-error");
    if (!errorEl) {
      errorEl = document.createElement("small");
      errorEl.className = "field-error";
      fieldLabel.appendChild(errorEl);
    }
    if (errorId) {
      errorEl.id = errorId;
    }
    errorEl.setAttribute("role", "alert");
    errorEl.textContent = message;
    addDescribedByToken(field, errorId);
  }

  function setFormFeedback(form, message, level) {
    if (!form) {
      return;
    }
    var feedback = form.querySelector(".form-feedback");
    if (!feedback) {
      return;
    }
    feedback.textContent = message || "";
    feedback.classList.remove("success", "error", "info");
    feedback.setAttribute("role", level === "error" ? "alert" : "status");
    if (level) {
      feedback.classList.add(level);
    }
  }

  function applyApiFieldErrors(form, errors) {
    var firstInvalidField = null;
    if (!errors || typeof errors !== "object") {
      return firstInvalidField;
    }
    Object.keys(errors).forEach(function (name) {
      var field = form.querySelector('[name="' + name + '"]');
      if (!field && (name === "client_code" || name === "mobile_operator")) {
        field = form.querySelector('[name="sender_mobile_number"]');
      }
      if (!field) {
        return;
      }
      setFieldError(field, String(errors[name]));
      if (!firstInvalidField) {
        firstInvalidField = field;
      }
    });
    return firstInvalidField;
  }

  function validateSendMoneyForm(form) {
    var senderField = form.querySelector('[name="sender_mobile_number"]');
    var receiverField = form.querySelector('[name="receiver_phone_number"]');
    var amountField = form.querySelector('[name="amount"]');
    var senderDetails = getSelectedSenderDetails(form);
    var firstInvalidField = null;

    [senderField, receiverField, amountField].forEach(clearFieldError);
    setFormFeedback(form, "", "");

    var hasErrors = false;
    var normalizedSender = normalizePhone(senderField && senderField.value);
    var normalizedSenderLocal = normalizeLocalPhone(senderField && senderField.value);
    var normalizedReceiver = normalizeReceiverPhone(receiverField && receiverField.value);
    var receiverOperator = normalizedReceiver ? inferMobileOperatorName(normalizedReceiver) : "";
    var amount = amountField ? parseFloat(String(amountField.value || "").trim()) : NaN;

    if (!normalizedSender || !normalizedSenderLocal) {
      hasErrors = true;
      setFieldError(senderField, "Choose a valid sender number.");
      firstInvalidField = firstInvalidField || senderField;
    }
    if (normalizedSender && (!senderDetails.client_code || senderDetails.client_code === "-" || !senderDetails.mobile_operator || senderDetails.mobile_operator === "-" || !senderDetails.request_path || senderDetails.request_path === "-")) {
      hasErrors = true;
      setFieldError(senderField, "Selected sender must include client code, mobile operator, and transfer path.");
      firstInvalidField = firstInvalidField || senderField;
    }
    if (!normalizedReceiver) {
      hasErrors = true;
      setFieldError(receiverField, "Enter a valid receiver number.");
      firstInvalidField = firstInvalidField || receiverField;
    } else if (!receiverOperator) {
      hasErrors = true;
      setFieldError(receiverField, "Receiver operator could not be detected from this number.");
      firstInvalidField = firstInvalidField || receiverField;
    } else if (senderDetails.mobile_operator && senderDetails.mobile_operator !== "-" && receiverOperator.toLowerCase() !== senderDetails.mobile_operator.toLowerCase()) {
      hasErrors = true;
      setFieldError(receiverField, "Cross-operator transfer is not allowed. Receiver is " + receiverOperator + ", but sender is " + senderDetails.mobile_operator + ".");
      firstInvalidField = firstInvalidField || receiverField;
    }
    if (receiverField && normalizedReceiver && receiverField.value !== normalizedReceiver) {
      receiverField.value = normalizedReceiver;
      syncFloatingField(receiverField);
    }
    if (!Number.isFinite(amount) || amount < 1000) {
      hasErrors = true;
      setFieldError(amountField, "Enter an amount of at least 1,000.");
      firstInvalidField = firstInvalidField || amountField;
    }

    if (hasErrors) {
      setFormFeedback(form, "Please correct the highlighted fields.", "error");
      announceStatus("Please correct the highlighted fields.");
      if (firstInvalidField && typeof firstInvalidField.focus === "function") {
        firstInvalidField.focus();
      }
      return null;
    }

    return {
      sender_mobile_number: normalizedSender,
      sender_local_number: normalizedSenderLocal,
      client_code: senderDetails.client_code,
      mobile_operator: senderDetails.mobile_operator,
      receiver_phone_number: normalizedReceiver,
      receiver_mobile_operator: receiverOperator,
      amount: Number(amount.toFixed(2)),
    };
  }

  async function submitTransferPayload(form, payload) {
    var invalidField;
    var submitBtn = form.querySelector('[type="submit"]');
    setElementLoadingState(form, true);
    setElementLoadingState(submitBtn, true);
    setFormFeedback(form, "Sending request and waiting for server reply...", "info");
    announceStatus("Sending request and waiting for server reply.");

    try {
      var response = await fetch(form.getAttribute("data-ajax-post") || "/api/send-money", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-Token": getCsrfToken(),
        },
        body: JSON.stringify(payload),
      });
      var result = {};
      try {
        result = await response.json();
      } catch (_jsonError) {
        result = {};
      }

      if (!response.ok || result.ok === false) {
        invalidField = applyApiFieldErrors(form, result.errors);
        if (invalidField && typeof invalidField.focus === "function") {
          invalidField.focus();
        }
        throw new Error(result.error || "Unable to submit transfer request.");
      }

      var receipt = buildTransferReceipt(result, payload);
      setFormFeedback(form, result.message || "Transfer request submitted successfully.", "success");
      showToast(result.message || "Transfer request submitted successfully.", "success");
      announceStatus(result.message || "Transfer request submitted successfully.");
      renderTransferReceipt(form, receipt);
      addRecentTransfer(receipt);
      renderRecentTransfers();
      if (result.auto_approval && result.auto_approval.applied) {
        stopApprovalPolling();
        hideApprovalModal();
        setFormFeedback(form, result.auto_approval.message || "Transfer auto-approved for trusted receiver.", "success");
        showToast(result.auto_approval.message || "Transfer auto-approved for trusted receiver.", "success");
        announceStatus(result.auto_approval.message || "Transfer auto-approved for trusted receiver.");
        return;
      }
      startApprovalPolling(form, result.approval);
    } catch (error) {
      setFormFeedback(form, error.message || "Transfer request failed.", "error");
      showToast(error.message || "Transfer request failed.", "error");
      announceStatus(error.message || "Transfer request failed.");
    } finally {
      setElementLoadingState(form, false);
      setElementLoadingState(submitBtn, false);
    }
  }

  async function handleSendMoneySubmit(form) {
    var payload = validateSendMoneyForm(form);
    if (!payload) {
      return;
    }

    return showTransferConfirmationModal(form, payload);
  }

  function updateSidebarState(button, isCollapsed) {
    var label = button ? button.querySelector("span") : null;
    document.body.classList.toggle("sidebar-collapsed", isCollapsed);
    if (!button) {
      return;
    }
    button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    button.setAttribute("aria-label", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
    button.setAttribute("title", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
    if (label) {
      label.textContent = isCollapsed ? "Expand panel" : "Collapse panel";
    }
  }

  function initSidebarToggle() {
    var button = document.querySelector("[data-sidebar-toggle='true']");
    var drawerButton = document.querySelector("[data-drawer-toggle='true']");
    var overlay = document.querySelector("[data-drawer-overlay='true']");
    var isCollapsed = false;
    if (!button && !drawerButton) {
      return;
    }
    if (button && button.getAttribute("data-sidebar-bound") === "true") {
      updateSidebarState(button, document.body.classList.contains("sidebar-collapsed"));
    }
    if (button && button.getAttribute("data-sidebar-bound") !== "true") {
      try {
        isCollapsed = window.localStorage.getItem(sidebarStorageKey) === "collapsed";
      } catch (_storageError) {}
      updateSidebarState(button, isCollapsed);
      button.setAttribute("data-sidebar-bound", "true");
      button.addEventListener("click", function () {
        isCollapsed = !document.body.classList.contains("sidebar-collapsed");
        updateSidebarState(button, isCollapsed);
        try {
          window.localStorage.setItem(sidebarStorageKey, isCollapsed ? "collapsed" : "expanded");
        } catch (_storageError) {}
      });
    }
    if (drawerButton && drawerButton.getAttribute("data-drawer-bound") !== "true") {
      drawerButton.setAttribute("data-drawer-bound", "true");
      drawerButton.addEventListener("click", function () {
        setDrawerState(!document.body.classList.contains("nav-drawer-open"));
      });
    }
    if (overlay && overlay.getAttribute("data-overlay-bound") !== "true") {
      overlay.setAttribute("data-overlay-bound", "true");
      overlay.addEventListener("click", function () {
        setDrawerState(false);
      });
    }
    if (!window.CodexNavigationResizeBound) {
      window.addEventListener("resize", function () {
        if (window.innerWidth > 1000) {
          setDrawerState(false);
        }
      });
      window.CodexNavigationResizeBound = true;
    }
  }

  function initThemeControls() {
    applyTheme(getResolvedTheme(), false);
    if (window.CodexThemeMediaBound || !window.matchMedia) {
      return;
    }
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof media.addEventListener !== "function") {
      return;
    }
    media.addEventListener("change", function (event) {
      if (getStoredThemePreference()) {
        return;
      }
      applyTheme(event.matches ? "dark" : "light", false);
    });
    window.CodexThemeMediaBound = true;
  }

  function initCommandPalette() {
    var elements = getCommandPaletteElements();
    if (!elements.root || !elements.input || !elements.list) {
      return;
    }
    if (elements.input.getAttribute("data-command-bound") === "true") {
      return;
    }

    elements.input.setAttribute("data-command-bound", "true");
    elements.input.addEventListener("input", function () {
      commandPaletteState.activeIndex = 0;
      renderCommandPalette(elements.input.value);
    });
    elements.input.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandPaletteActiveIndex(commandPaletteState.activeIndex + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandPaletteActiveIndex(commandPaletteState.activeIndex - 1);
        return;
      }
      if (event.key === "Enter") {
        if (!commandPaletteState.filteredCommands.length) {
          return;
        }
        event.preventDefault();
        runCommandPaletteCommand(commandPaletteState.filteredCommands[commandPaletteState.activeIndex]);
      }
    });
  }

  function activateSettingsTab(root, tabValue, shouldPersist) {
    var tabs;
    var panels;
    var activeFound = false;
    if (!root) {
      return;
    }
    tabs = root.querySelectorAll("[data-settings-tab]");
    panels = root.querySelectorAll("[data-settings-panel]");

    tabs.forEach(function (tab) {
      var isActive = tab.getAttribute("data-settings-tab") === tabValue;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      tab.setAttribute("tabindex", isActive ? "0" : "-1");
      if (isActive) {
        activeFound = true;
      }
    });

    panels.forEach(function (panel) {
      var isActive = panel.getAttribute("data-settings-panel") === tabValue;
      panel.classList.toggle("active", isActive);
      panel.hidden = !isActive;
    });

    if (!activeFound && tabs.length > 0) {
      activateSettingsTab(root, tabs[0].getAttribute("data-settings-tab"), shouldPersist);
      return;
    }

    if (shouldPersist && activeFound) {
      try {
        window.localStorage.setItem(settingsTabStorageKey, tabValue);
      } catch (_storageError) {}
    }
  }

  function initSettingsTabs(scopeRoot) {
    var root = scopeRoot && scopeRoot.querySelector ? scopeRoot.querySelector("#settings-page-root") : null;
    var storedTab = "";
    if (!root) {
      return;
    }

    root.querySelectorAll("[data-settings-tab]").forEach(function (tab) {
      if (tab.getAttribute("data-settings-tab-bound") === "true") {
        return;
      }
      tab.setAttribute("data-settings-tab-bound", "true");
      tab.addEventListener("click", function () {
        activateSettingsTab(root, tab.getAttribute("data-settings-tab"), true);
      });
      tab.addEventListener("keydown", function (event) {
        var tabs = Array.prototype.slice.call(root.querySelectorAll("[data-settings-tab]"));
        var currentIndex = tabs.indexOf(tab);
        var nextIndex = currentIndex;

        if (event.key === "ArrowRight") {
          nextIndex = (currentIndex + 1) % tabs.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = tabs.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        tabs[nextIndex].focus();
        activateSettingsTab(root, tabs[nextIndex].getAttribute("data-settings-tab"), true);
      });
    });

    try {
      storedTab = window.localStorage.getItem(settingsTabStorageKey) || "";
    } catch (_storageError) {}
    activateSettingsTab(root, storedTab || root.querySelector("[data-settings-tab]").getAttribute("data-settings-tab"), false);
  }

  function normalizeClientStatusKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function updateBalanceClientStatus(statusPayload) {
    var clients = statusPayload && statusPayload.clients ? statusPayload.clients : {};
    var normalizedClients = {};

    Object.keys(clients).forEach(function (key) {
      normalizedClients[normalizeClientStatusKey(key)] = clients[key];
    });

    document.querySelectorAll("[data-client-status-badge]").forEach(function (badge) {
      var clientCode = badge.getAttribute("data-client-code");
      var status = normalizedClients[normalizeClientStatusKey(clientCode)] || {};
      var label = status.label || "Offline";
      var isOnline = status.status === "online" || status.is_online === true;
      var labelEl = badge.querySelector("[data-client-status-label]");
      var card = badge.closest(".balance-card");
      var lastSeenEl = card ? card.querySelector("[data-client-last-seen]") : null;

      badge.classList.toggle("client-status-online", isOnline);
      badge.classList.toggle("client-status-offline", !isOnline);
      if (labelEl) {
        labelEl.textContent = label;
      }
      if (lastSeenEl) {
        lastSeenEl.textContent = "Last log " + (status.last_seen || "No logs in the last 10 minutes");
      }
    });
  }

  function refreshBalanceClientStatus() {
    if (!document.querySelector("#balance-page-root")) {
      return Promise.resolve();
    }
    return fetch("/api/client-status", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || "Unable to refresh client status.");
          }
          updateBalanceClientStatus(payload);
        });
      })
      .catch(function () {});
  }

  function initBalanceClientStatusPolling() {
    if (!document.querySelector("#balance-page-root")) {
      if (balanceStatusPollTimer) {
        window.clearInterval(balanceStatusPollTimer);
        balanceStatusPollTimer = null;
      }
      return;
    }
    refreshBalanceClientStatus();
    if (balanceStatusPollTimer) {
      return;
    }
    balanceStatusPollTimer = window.setInterval(refreshBalanceClientStatus, 60000);
  }

  document.addEventListener("click", function (event) {
    var themeToggleBtn = event.target.closest("[data-theme-toggle='true']");
    var commandPaletteToggle = event.target.closest("[data-command-palette-toggle='true']");
    var commandPaletteClose = event.target.closest("[data-command-palette-close='true']");
    var commandItem = event.target.closest("[data-command-index]");
    var detailTrigger = event.target.closest("[data-detail-trigger='true']");
    var detailCloseBtn = event.target.closest("[data-detail-close='true']");
    var commandOverlay = event.target.closest("[data-command-overlay='true']");
    var detailOverlay = event.target.closest("[data-detail-overlay='true']");
    var messageToggle = event.target.closest("[data-message-toggle='true']");
    var copyMessageBtn = event.target.closest("[data-copy-message='true']");
    var reuseTransferBtn = event.target.closest("[data-reuse-transfer]");
    var removeTransferBtn = event.target.closest("[data-remove-transfer]");
    var rangePresetBtn = event.target.closest("[data-range-days]");
    var approvalDecisionBtn = event.target.closest("[data-approval-decision]");
    var approvalCloseBtn = event.target.closest("[data-approval-close='true']");
    var confirmationCloseBtn = event.target.closest("[data-confirmation-close='true']");
    var confirmationSubmitBtn = event.target.closest("[data-confirmation-submit='true']");
    var asyncErrorDismissBtn = event.target.closest("[data-async-error-dismiss='true']");
    var detailCopyAllBtn = event.target.closest("[data-detail-copy-all='true']");
    var detailCopyFieldBtn = event.target.closest("[data-detail-copy-field='true']");
    var mobileMoreToggle = event.target.closest(".mobile-more-button");
    var mobileMoreClose = event.target.closest(".mobile-more-head label, .mobile-more-scrim");
    var mobileMoreLink = event.target.closest(".mobile-more-item[href]");
    var mobileNavLink = event.target.closest(".mobile-bottom-nav-item[href]");

    if (themeToggleBtn) {
      event.preventDefault();
      toggleTheme();
      return;
    }

    if (mobileMoreToggle) {
      setTimeout(function () {
        setMobileMoreState(document.getElementById("mobile-more-toggle") && document.getElementById("mobile-more-toggle").checked);
      }, 0);
      return;
    }

    if (mobileMoreClose) {
      setMobileMoreState(false);
      return;
    }

    if (mobileMoreLink) {
      setMobileMoreState(false);
    }

    if (mobileNavLink) {
      var mobileNavHref = mobileNavLink.getAttribute("href");
      var mobileNavUrl;
      var mobileNavTarget;
      if (
        mobileNavHref &&
        mobileNavHref.indexOf("#") !== 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        event.button === 0
      ) {
        mobileNavUrl = new URL(mobileNavHref, window.location.origin);
        if (mobileNavUrl.origin === window.location.origin && mobileNavUrl.toString() !== window.location.href) {
          event.preventDefault();
          mobileNavTarget = inferFragmentTarget(mobileNavUrl.toString());
          setElementLoadingState(mobileNavLink, true);
          fetchAndSwapPage(mobileNavUrl.toString(), true, { notify: false })
            .catch(function () {
              window.location.assign(mobileNavUrl.toString());
            })
            .finally(function () {
              setElementLoadingState(mobileNavLink, false);
            });
          return;
        }
        if (mobileNavTarget && document.querySelector(mobileNavTarget)) {
          event.preventDefault();
          fetchAndSwap(mobileNavUrl.toString(), mobileNavTarget, true, { notify: false }).catch(function () {
            window.location.assign(mobileNavUrl.toString());
          });
          return;
        }
      }
    }

    if (commandPaletteToggle) {
      event.preventDefault();
      if (document.body.classList.contains("command-palette-open")) {
        closeCommandPalette();
        return;
      }
      openCommandPalette(commandPaletteToggle);
      return;
    }

    if (asyncErrorDismissBtn) {
      event.preventDefault();
      var asyncErrorPanel = asyncErrorDismissBtn.closest(".async-error-panel");
      if (asyncErrorPanel) {
        asyncErrorPanel.remove();
      }
      return;
    }

    if (commandPaletteClose || commandOverlay) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }

    if (commandItem) {
      event.preventDefault();
      runCommandPaletteCommand(commandPaletteState.filteredCommands[Number(commandItem.getAttribute("data-command-index"))]);
      return;
    }

    if (detailTrigger) {
      event.preventDefault();
      openDetailDrawer(detailTrigger);
      return;
    }

    if (detailCloseBtn || detailOverlay) {
      event.preventDefault();
      closeDetailDrawer();
      return;
    }

    if (detailCopyAllBtn) {
      event.preventDefault();
      copyTextToClipboard(buildDetailCopyText())
        .then(function () {
          showToast("Details copied.", "success");
          announceStatus("Details copied.");
        })
        .catch(function () {
          showToast("Unable to copy details.", "error");
        });
      return;
    }

    if (detailCopyFieldBtn) {
      event.preventDefault();
      var detailField = detailCopyFieldBtn.closest(".detail-field");
      var detailValue = detailField ? detailField.querySelector(".detail-value") : null;
      copyTextToClipboard(detailValue ? detailValue.textContent || "" : "")
        .then(function () {
          showToast("Field copied.", "success");
          announceStatus("Field copied.");
        })
        .catch(function () {
          showToast("Unable to copy field.", "error");
        });
      return;
    }

    if (rangePresetBtn) {
      event.preventDefault();
      applyMessagesDateRange(rangePresetBtn);
      return;
    }

    if (approvalCloseBtn) {
      event.preventDefault();
      hideApprovalModal();
      return;
    }

    if (confirmationCloseBtn) {
      event.preventDefault();
      closeTransferConfirmationModal(true);
      return;
    }

    if (confirmationSubmitBtn) {
      event.preventDefault();
      confirmTransferSubmission();
      return;
    }

    if (approvalDecisionBtn) {
      event.preventDefault();
      submitApprovalDecision(approvalDecisionBtn.getAttribute("data-approval-decision"));
      return;
    }

    if (messageToggle) {
      var bodyCell = messageToggle.closest(".messages-body-cell");
      var isExpanded;
      if (!bodyCell) {
        return;
      }
      isExpanded = !bodyCell.classList.contains("is-expanded");
      bodyCell.classList.toggle("is-expanded", isExpanded);
      messageToggle.textContent = isExpanded ? "Collapse" : "Expand";
      messageToggle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
      return;
    }

    if (copyMessageBtn) {
      var copyTextEl = copyMessageBtn.closest(".messages-body-cell");
      var messageTextEl = copyTextEl ? copyTextEl.querySelector("[data-message-text]") : null;
      if (!messageTextEl) {
        return;
      }
      copyTextToClipboard(messageTextEl.textContent || "")
        .then(function () {
          showToast("Message copied.", "success");
          announceStatus("Message copied.");
        })
        .catch(function () {
          showToast("Unable to copy message.", "error");
        });
      return;
    }

    if (removeTransferBtn) {
      var removeIndex = Number(removeTransferBtn.getAttribute("data-remove-transfer"));
      event.preventDefault();
      if (removeRecentTransfer(removeIndex)) {
        renderRecentTransfers();
        showToast("Recent transfer removed.", "success");
        announceStatus("Recent transfer removed.");
      }
      return;
    }

    if (reuseTransferBtn) {
      var recentIndex = Number(reuseTransferBtn.getAttribute("data-reuse-transfer"));
      var recentItems = getRecentTransfers();
      var recentItem = recentItems[recentIndex];
      var sendMoneyForm = document.getElementById("send-money-form");
      if (!recentItem) {
        return;
      }
      if (sendMoneyForm) {
        fillSendMoneyFormFromRecent(sendMoneyForm, recentItem);
        return;
      }
      savePendingRecentTransfer(recentItem);
      window.location.assign("/send-money");
      return;
    }

    var link = event.target.closest("a[data-ajax-link='true']");
    if (!link) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    var href = link.getAttribute("href");
    if (!href || href.indexOf("#") === 0) {
      return;
    }

    var url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      return;
    }

    var targetSelector = link.getAttribute("data-ajax-target");
    if (!targetSelector) {
      return;
    }

    event.preventDefault();
    setDrawerState(false);
    setElementLoadingState(link, true);
    fetchAndSwap(url.toString(), targetSelector, true, { notify: true })
      .catch(function () {
        window.location.assign(url.toString());
      })
      .finally(function () {
        setElementLoadingState(link, false);
      });
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    if (form.id === "send-money-form") {
      event.preventDefault();
      handleSendMoneySubmit(form);
      return;
    }

    if (form.getAttribute("data-ajax-form") !== "true") {
      return;
    }
    event.preventDefault();

    var targetSelector = form.getAttribute("data-ajax-target");
    if (!targetSelector) {
      form.submit();
      return;
    }

    var method = String(form.getAttribute("method") || "GET").toUpperCase();
    if (method !== "GET") {
      form.submit();
      return;
    }

    var url = buildGetUrl(form);
    setElementLoadingState(form, true);
    fetchAndSwap(url, targetSelector, true, { notify: true })
      .catch(function () {
        window.location.assign(url);
      })
      .finally(function () {
        setElementLoadingState(form, false);
      });
  });

  document.addEventListener("change", function (event) {
    var field = event.target;
    if (!(field instanceof HTMLElement)) {
      return;
    }

    if (field.matches(".floating-field input, .floating-field select")) {
      syncFloatingField(field);
    }

    var sendForm = field.closest("#send-money-form");
    if (sendForm && field.matches("input, select")) {
      clearFieldError(field);
      if (field.matches('[name="sender_mobile_number"]')) {
        syncSenderDetails(sendForm);
      }
      if (field.matches('[name="receiver_phone_number"]')) {
        syncReceiverDetails(sendForm);
      }
      return;
    }

    var autoForm = field.closest("form[data-auto-submit='true']");
    if (!autoForm) {
      return;
    }
    if (field.matches("input[type='date'], select")) {
      scheduleAutoSubmit(autoForm, 250);
    }
  });

  document.addEventListener("input", function (event) {
    var field = event.target;
    var form;
    var hadAppliedQuery;
    if (!(field instanceof HTMLElement)) {
      return;
    }
    if (field.matches("[data-recent-transfer-search='true']")) {
      renderRecentTransfers();
      return;
    }
    if (!field.matches("form[data-ajax-form='true'] input[name='q']")) {
      return;
    }

    form = field.closest("form[data-ajax-form='true']");
    if (!form) {
      return;
    }

    if (String(field.value || "").trim()) {
      clearScheduledAutoSubmit(form);
      return;
    }

    hadAppliedQuery = !!String(field.defaultValue || "").trim();
    if (!hadAppliedQuery) {
      return;
    }

    scheduleAutoSubmit(form, 250);
  });

  window.addEventListener("ux:content-updated", function (event) {
    closeDetailDrawer(false);
    initThemeControls();
    initInstallPrompt();
    initCommandPalette();
    initFloatingFields(document);
    initPreferenceToggles(document);
    initSenderStatusToggles(document);
    renderRecentTransfers();
    applyPendingRecentTransfer();
    initBalanceClientStatusPolling();
    if (event.detail && event.detail.target === "#settings-page-root") {
      initSettingsTabs(document);
    }
  });

  document.addEventListener("pointerdown", function (event) {
    var target = event.target.closest(".ghost-btn, .filter-btn, .send-submit, .settings-tab, .page-btn, .nav-item, .mobile-bottom-nav-item, .toggle-switch, .menu-toggle, .message-action-btn, .quick-sender-chip, .switch-btn, .range-chip, .collapse-btn, .topbar-utility, .panel-close-btn, .command-item, .row-action-btn, .install-confirm-btn, .install-dismiss-btn, .sender-status-toggle, .approval-approve-btn, .approval-reject-btn");
    if (!target) {
      return;
    }
    createRipple(target, event);
  });

  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (shouldShowInstallPrompt()) {
      setInstallPromptVisible(true, false);
    }
  });

  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    setInstallPromptVisible(false, false);
    showToast("TransferFlow installed.", "success");
  });

  document.addEventListener("keydown", function (event) {
    var activeElement = document.activeElement;
    var searchField;
    var isTextInput =
      activeElement &&
      activeElement.matches("input, select, textarea, [contenteditable='true']");

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (document.body.classList.contains("command-palette-open")) {
        closeCommandPalette();
        return;
      }
      openCommandPalette(activeElement);
      return;
    }

    if (activeElement && activeElement.classList && activeElement.classList.contains("mobile-more-button") && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setMobileMoreState(!document.body.classList.contains("mobile-more-open"));
      return;
    }

    if (event.key === "Escape") {
      if (document.body.classList.contains("transfer-approval-open")) {
        hideApprovalModal();
        event.preventDefault();
        return;
      }
      if (document.body.classList.contains("transfer-confirmation-open")) {
        closeTransferConfirmationModal(true);
        event.preventDefault();
        return;
      }
      if (document.body.classList.contains("command-palette-open")) {
        closeCommandPalette();
        event.preventDefault();
        return;
      }
      if (document.body.classList.contains("detail-drawer-open")) {
        closeDetailDrawer();
        event.preventDefault();
        return;
      }
      if (document.body.classList.contains("mobile-more-open")) {
        setMobileMoreState(false);
        event.preventDefault();
        return;
      }
      if (document.body.classList.contains("nav-drawer-open")) {
        setDrawerState(false);
        event.preventDefault();
        return;
      }
      if (closeOpenDetails()) {
        event.preventDefault();
        return;
      }
      if (clearToasts()) {
        event.preventDefault();
      }
      return;
    }

    if (
      event.key === "/" &&
      activeElement &&
      !isTextInput
    ) {
      searchField = getFocusableSearchField();
      if (searchField) {
        event.preventDefault();
        searchField.focus();
      }
    }
  });

  window.addEventListener("popstate", function (event) {
    var state = event.state || {};
    var targetSelector = state.target || inferFragmentTarget(window.location.href);
    var stateUrl = state.url || window.location.href;

    if (!targetSelector) {
      window.location.reload();
      return;
    }

    if (!document.querySelector(targetSelector)) {
      fetchAndSwapPage(stateUrl, false, {
        restoreFocus: false,
        notify: false,
        suppressToast: true,
        replaceHistory: true,
      }).catch(function () {
        window.location.reload();
      });
      return;
    }

    fetchAndSwap(stateUrl, targetSelector, false, {
      restoreFocus: false,
      notify: false,
      suppressToast: true,
      replaceHistory: true,
    }).catch(function () {
      window.location.reload();
    });
  });

  initThemeControls();
  initInstallPrompt();
  initCommandPalette();
  initSidebarToggle();
  initSettingsTabs(document);
  initPreferenceToggles(document);
  initSenderStatusToggles(document);
  initFloatingFields(document);
  syncSenderDetails(document.getElementById("send-money-form"));
  syncReceiverDetails(document.getElementById("send-money-form"));
  renderRecentTransfers();
  applyPendingRecentTransfer();
  initBalanceClientStatusPolling();
  syncCurrentHistoryState();
})();

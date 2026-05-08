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
  var deferredInstallPrompt = null;
  var balanceStatusPollTimer = null;
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
    if (element.matches && element.matches(".nav-item, .mobile-bottom-nav-item, .mobile-more-item")) {
      element.setAttribute("aria-busy", isLoading ? "true" : "false");
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
        showToast("WakalaAdmin is installing.", "success");
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
    var nextState = !!isOpen;
    document.body.classList.toggle("mobile-more-open", !!isOpen);
    if (toggle) {
      toggle.checked = nextState;
    }
    document.querySelectorAll(".mobile-more-button").forEach(function (button) {
      button.setAttribute("aria-expanded", nextState ? "true" : "false");
      button.setAttribute("aria-label", nextState ? "Close more navigation" : "Open more navigation");
    });
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
  window.CodexUX.getCsrfToken = getCsrfToken;
  window.CodexUX.escapeHtml = escapeHtml;
  window.CodexUX.initFloatingFields = initFloatingFields;
  window.CodexUX.syncFloatingField = syncFloatingField;
  window.CodexUX.setElementLoadingState = setElementLoadingState;
  window.CodexUX.showToast = showToast;
  window.CodexUX.announceStatus = announceStatus;
  window.CodexUX.syncModalShellState = syncModalShellState;

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
    var rangePresetBtn = event.target.closest("[data-range-days]");
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
      event.preventDefault();
      setMobileMoreState(!document.body.classList.contains("mobile-more-open"));
      return;
    }

    if (mobileMoreClose) {
      event.preventDefault();
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
    showToast("WakalaAdmin installed.", "success");
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
  initBalanceClientStatusPolling();
  syncCurrentHistoryState();
})();

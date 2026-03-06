/* global window, document, fetch, FormData, URL, DOMParser, history, CustomEvent, HTMLElement, HTMLFormElement */
(function () {
  "use strict";

  var autoSubmitTimers = new WeakMap();
  var toastHideTimers = new WeakMap();
  var liveRegion = null;
  var toastStack = null;
  var sidebarStorageKey = "app.sidebarCollapsed";
  var settingsTabStorageKey = "settings.activeTab";
  var recentTransfersStorageKey = "sendMoney.recentTransfers";
  var maxRecentTransfers = 5;
  var pendingFragmentRequests = new Map();

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function normalizeUrl(url) {
    return new URL(url || window.location.href, window.location.origin).toString();
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

  function replaceTargetFromHtml(targetSelector, html) {
    var current = document.querySelector(targetSelector);
    if (!current) {
      return false;
    }
    var nextDoc = parseHtml(html);
    var next = nextDoc.querySelector(targetSelector);
    if (!next) {
      return false;
    }
    current.replaceWith(next);
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
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
        toastHideTimers.delete(toast);
      }, 4200)
    );
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
      }
      if (error && error.name === "AbortError") {
        return false;
      }
      announceStatus(error && error.message ? error.message : "Request failed.");
      if (!settings.suppressToast) {
        showToast(error && error.message ? error.message : "Request failed.", "error");
      }
      throw error;
    }
  }

  window.CodexUX = window.CodexUX || {};
  window.CodexUX.fetchAndSwap = fetchAndSwap;
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

  function renderRecentTransfers() {
    var list = document.getElementById("recent-transfer-list");
    var items = getRecentTransfers();
    if (!list) {
      return;
    }
    if (items.length === 0) {
      list.innerHTML = '<p class="recent-transfer-empty">No recent transfers yet.</p>';
      return;
    }

    list.innerHTML = items
      .map(function (item, index) {
        return (
          '<button class="recent-transfer-item" type="button" data-reuse-transfer="' + index + '">' +
            '<span class="recent-transfer-meta"><strong>' + item.receiver_phone_number + '</strong><span>' + item.sender_mobile_number + '</span></span>' +
            '<span class="recent-transfer-side"><strong>' + formatCurrencyAmount(item.amount_value || item.amount || 0) + '</strong><span>' + formatTransferTime(item.submitted_at) + '</span></span>' +
          "</button>"
        );
      })
      .join("");
  }

  function buildTransferReceipt(result, payload) {
    var receipt = result && result.receipt && typeof result.receipt === "object" ? result.receipt : {};
    return {
      sender_mobile_number: receipt.sender_mobile_number || payload.sender_mobile_number,
      receiver_phone_number: receipt.receiver_phone_number || payload.receiver_phone_number,
      amount: receipt.amount || formatCurrencyAmount(payload.amount),
      amount_value: Number(receipt.amount_value || payload.amount || 0),
      submitted_at: receipt.submitted_at || new Date().toISOString(),
      reference: receipt.reference || "-",
      status: receipt.status || ("HTTP " + String(result && result.upstream_status ? result.upstream_status : 200)),
    };
  }

  function toggleTransferSubmitButtons(form, isConfirming) {
    var primaryBtn = form.querySelector('[type="submit"]');
    var confirmation = form.querySelector("#transfer-confirmation");
    if (primaryBtn) {
      primaryBtn.hidden = !!isConfirming;
    }
    if (confirmation) {
      confirmation.hidden = !isConfirming;
    }
  }

  function resetTransferConfirmation(form) {
    if (!form) {
      return;
    }
    form._pendingTransferPayload = null;
    toggleTransferSubmitButtons(form, false);
  }

  function showTransferConfirmation(form, payload) {
    var confirmation = form.querySelector("#transfer-confirmation");
    if (!confirmation) {
      return false;
    }

    form._pendingTransferPayload = payload;
    confirmation.querySelector("[data-confirm-sender]").textContent = payload.sender_mobile_number;
    confirmation.querySelector("[data-confirm-receiver]").textContent = payload.receiver_phone_number;
    confirmation.querySelector("[data-confirm-amount]").textContent = formatCurrencyAmount(payload.amount);
    toggleTransferSubmitButtons(form, true);
    setFormFeedback(form, "Review the transfer details and confirm to continue.", "info");
    announceStatus("Review the transfer details and confirm to continue.");
    return true;
  }

  function renderTransferReceipt(form, receipt) {
    var receiptCard = form.querySelector("#transfer-receipt");
    if (!receiptCard) {
      return;
    }
    receiptCard.hidden = false;
    receiptCard.querySelector("[data-receipt-sender]").textContent = receipt.sender_mobile_number;
    receiptCard.querySelector("[data-receipt-receiver]").textContent = receipt.receiver_phone_number;
    receiptCard.querySelector("[data-receipt-amount]").textContent = receipt.amount;
    receiptCard.querySelector("[data-receipt-time]").textContent = formatTransferTime(receipt.submitted_at);
    receiptCard.querySelector("[data-receipt-reference]").textContent = receipt.reference || "-";
    receiptCard.querySelector("[data-receipt-status]").textContent = receipt.status || "-";
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
    var firstInvalidField = null;

    [senderField, receiverField, amountField].forEach(clearFieldError);
    setFormFeedback(form, "", "");

    var hasErrors = false;
    var normalizedSender = normalizePhone(senderField && senderField.value);
    var normalizedReceiver = normalizePhone(receiverField && receiverField.value);
    var amount = amountField ? parseFloat(String(amountField.value || "").trim()) : NaN;

    if (!normalizedSender) {
      hasErrors = true;
      setFieldError(senderField, "Choose a valid sender number.");
      firstInvalidField = firstInvalidField || senderField;
    }
    if (!normalizedReceiver) {
      hasErrors = true;
      setFieldError(receiverField, "Enter a valid receiver number.");
      firstInvalidField = firstInvalidField || receiverField;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      hasErrors = true;
      setFieldError(amountField, "Enter an amount greater than zero.");
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
      receiver_phone_number: normalizedReceiver,
      amount: Number(amount.toFixed(2)),
    };
  }

  async function submitTransferPayload(form, payload) {
    var invalidField;
    var submitBtn = form.querySelector('[type="submit"]');
    var confirmBtn = form.querySelector('[data-confirm-submit="true"]');
    setElementLoadingState(form, true);
    setElementLoadingState(submitBtn, true);
    setElementLoadingState(confirmBtn, true);
    setFormFeedback(form, "Submitting transfer...", "info");
    announceStatus("Submitting transfer.");

    try {
      var response = await fetch(form.getAttribute("data-ajax-post") || "/api/send-money", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
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
      resetTransferConfirmation(form);
      form.reset();
      [form.querySelector('[name="sender_mobile_number"]'), form.querySelector('[name="receiver_phone_number"]'), form.querySelector('[name="amount"]')].forEach(clearFieldError);
    } catch (error) {
      setFormFeedback(form, error.message || "Transfer request failed.", "error");
      showToast(error.message || "Transfer request failed.", "error");
      announceStatus(error.message || "Transfer request failed.");
    } finally {
      setElementLoadingState(form, false);
      setElementLoadingState(submitBtn, false);
      setElementLoadingState(confirmBtn, false);
    }
  }

  async function handleSendMoneySubmit(form) {
    var payload = validateSendMoneyForm(form);
    if (!payload) {
      return;
    }

    if (showTransferConfirmation(form, payload)) {
      return;
    }

    return submitTransferPayload(form, payload);
  }

  function updateSidebarState(button, isCollapsed) {
    document.body.classList.toggle("sidebar-collapsed", isCollapsed);
    if (!button) {
      return;
    }
    button.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    button.setAttribute("aria-label", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
    button.setAttribute("title", isCollapsed ? "Expand sidebar" : "Collapse sidebar");
  }

  function initSidebarToggle() {
    var button = document.querySelector("[data-sidebar-toggle='true']");
    var isCollapsed = false;
    if (!button) {
      return;
    }
    if (button.getAttribute("data-sidebar-bound") === "true") {
      updateSidebarState(button, document.body.classList.contains("sidebar-collapsed"));
      return;
    }
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

  document.addEventListener("click", function (event) {
    var messageToggle = event.target.closest("[data-message-toggle='true']");
    var copyMessageBtn = event.target.closest("[data-copy-message='true']");
    var confirmSubmitBtn = event.target.closest("[data-confirm-submit='true']");
    var confirmEditBtn = event.target.closest("[data-confirm-edit='true']");
    var reuseTransferBtn = event.target.closest("[data-reuse-transfer]");

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

    if (confirmEditBtn) {
      var editForm = confirmEditBtn.closest("#send-money-form");
      resetTransferConfirmation(editForm);
      setFormFeedback(editForm, "Update the transfer details and submit again.", "info");
      return;
    }

    if (confirmSubmitBtn) {
      var confirmForm = confirmSubmitBtn.closest("#send-money-form");
      event.preventDefault();
      if (!confirmForm || !confirmForm._pendingTransferPayload) {
        handleSendMoneySubmit(confirmForm);
        return;
      }
      submitTransferPayload(confirmForm, confirmForm._pendingTransferPayload);
      return;
    }

    if (reuseTransferBtn) {
      var recentIndex = Number(reuseTransferBtn.getAttribute("data-reuse-transfer"));
      var recentItems = getRecentTransfers();
      var recentItem = recentItems[recentIndex];
      var sendMoneyForm = document.getElementById("send-money-form");
      if (!recentItem || !sendMoneyForm) {
        return;
      }
      sendMoneyForm.querySelector('[name="sender_mobile_number"]').value = recentItem.sender_mobile_number || "";
      sendMoneyForm.querySelector('[name="receiver_phone_number"]').value = recentItem.receiver_phone_number || "";
      sendMoneyForm.querySelector('[name="amount"]').value = recentItem.amount_value || recentItem.amount || "";
      resetTransferConfirmation(sendMoneyForm);
      setFormFeedback(sendMoneyForm, "Recent transfer loaded. Review and submit when ready.", "info");
      announceStatus("Recent transfer loaded.");
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

    var sendForm = field.closest("#send-money-form");
    if (sendForm && field.matches("input, select")) {
      clearFieldError(field);
      resetTransferConfirmation(sendForm);
      return;
    }

    var autoForm = field.closest("form[data-auto-submit='true']");
    if (!autoForm) {
      return;
    }
    if (field.matches("input[type='date'], select")) {
      if (autoSubmitTimers.has(autoForm)) {
        window.clearTimeout(autoSubmitTimers.get(autoForm));
      }
      autoSubmitTimers.set(autoForm, window.setTimeout(function () {
        autoSubmitTimers.delete(autoForm);
        autoForm.requestSubmit();
      }, 250));
    }
  });

  window.addEventListener("ux:content-updated", function (event) {
    if (event.detail && event.detail.target === "#settings-page-root") {
      initSettingsTabs(document);
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

    fetchAndSwap(stateUrl, targetSelector, false, {
      restoreFocus: false,
      notify: false,
      suppressToast: true,
      replaceHistory: true,
    }).catch(function () {
      window.location.reload();
    });
  });

  initSidebarToggle();
  initSettingsTabs(document);
  renderRecentTransfers();
  syncCurrentHistoryState();
})();

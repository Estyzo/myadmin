/* global window, document, fetch, URL, HTMLElement, HTMLFormElement */
(function () {
  "use strict";

  var ux = window.CodexUX || {};
  var recentTransfersStorageKey = "sendMoney.recentTransfers";
  var pendingRecentTransferStorageKey = "sendMoney.pendingRecentTransfer";
  var maxRecentTransfers = 5;
  var approvalPollTimer = null;
  var approvalTimeoutTimer = null;
  var approvalDecisionInFlight = false;
  var approvalPollIntervalMs = 3000;
  var approvalAutoRejectMs = 60000;
  var activeApprovalContext = null;
  var pendingTransferConfirmationPayload = null;
  var transferConfirmationOpener = null;

  var getCsrfToken = ux.getCsrfToken || function () { return ""; };
  var escapeHtml = ux.escapeHtml || function (value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
  var initFloatingFields = ux.initFloatingFields || function () {};
  var syncFloatingField = ux.syncFloatingField || function () {};
  var setElementLoadingState = ux.setElementLoadingState || function () {};
  var showToast = ux.showToast || function () {};
  var announceStatus = ux.announceStatus || function () {};
  var syncModalShellState = ux.syncModalShellState || function () {};

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


  function initSendMoneyPage() {
    syncSenderDetails(document.getElementById("send-money-form"));
    syncReceiverDetails(document.getElementById("send-money-form"));
    renderRecentTransfers();
    applyPendingRecentTransfer();
  }

  document.addEventListener("click", function (event) {
    var reuseTransferBtn = event.target.closest("[data-reuse-transfer]");
    var removeTransferBtn = event.target.closest("[data-remove-transfer]");
    var approvalDecisionBtn = event.target.closest("[data-approval-decision]");
    var approvalCloseBtn = event.target.closest("[data-approval-close='true']");
    var confirmationCloseBtn = event.target.closest("[data-confirmation-close='true']");
    var confirmationSubmitBtn = event.target.closest("[data-confirmation-submit='true']");

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
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id !== "send-money-form") {
      return;
    }
    event.preventDefault();
    handleSendMoneySubmit(form);
  });

  document.addEventListener("change", function (event) {
    var field = event.target;
    var sendForm;
    if (!(field instanceof HTMLElement)) {
      return;
    }
    sendForm = field.closest("#send-money-form");
    if (!sendForm || !field.matches("input, select")) {
      return;
    }
    clearFieldError(field);
    if (field.matches('[name="sender_mobile_number"]')) {
      syncSenderDetails(sendForm);
    }
    if (field.matches('[name="receiver_phone_number"]')) {
      syncReceiverDetails(sendForm);
    }
  });

  document.addEventListener("input", function (event) {
    var field = event.target;
    if (field instanceof HTMLElement && field.matches("[data-recent-transfer-search='true']")) {
      renderRecentTransfers();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") {
      return;
    }
    if (document.body.classList.contains("transfer-approval-open")) {
      hideApprovalModal();
      event.preventDefault();
      return;
    }
    if (document.body.classList.contains("transfer-confirmation-open")) {
      closeTransferConfirmationModal(true);
      event.preventDefault();
    }
  });

  window.addEventListener("ux:content-updated", initSendMoneyPage);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSendMoneyPage);
  } else {
    initSendMoneyPage();
  }
})();

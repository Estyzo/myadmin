/* global window, document, fetch */
(function () {
  "use strict";

  var requestPollTimer = null;
  var lastRenderedSignature = "";
  var requestsState = {
    items: [],
    page: 1,
    perPage: 10,
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getRoot() {
    return document.querySelector("[data-requests-page='true']");
  }

  function getSearchQuery(root) {
    var field = root ? root.querySelector("[data-requests-search='true']") : null;
    return field ? String(field.value || "").trim().toLowerCase() : "";
  }

  function getFieldValue(root, selector) {
    var field = root ? root.querySelector(selector) : null;
    return field ? String(field.value || "").trim() : "";
  }

  function normalizeStatusClass(status) {
    return String(status || "pending").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "pending";
  }

  function requestSearchText(item) {
    return [
      item.id,
      item.status,
      item.approvalStatus,
      item.action,
      item.sender,
      item.receiver,
      item.amount,
      item.client,
      item.operator,
      item.message,
    ].join(" ").toLowerCase();
  }

  function isApprovedStatus(status) {
    return /approved|approve|success|completed|complete/i.test(String(status || ""));
  }

  function isRejectedStatus(status) {
    return /rejected|reject|failed|fail|declined|decline|error/i.test(String(status || ""));
  }

  function getUniqueOptions(items, key) {
    var seen = new Set();
    return items
      .map(function (item) {
        return String(item[key] || "").trim();
      })
      .filter(function (value) {
        if (!value || value === "-" || seen.has(value.toLowerCase())) {
          return false;
        }
        seen.add(value.toLowerCase());
        return true;
      })
      .sort(function (a, b) {
        return a.localeCompare(b);
      });
  }

  function syncSelectOptions(select, options, label) {
    var currentValue;
    if (!select) {
      return;
    }
    currentValue = select.value;
    select.innerHTML =
      '<option value=""></option>' +
      options
        .map(function (option) {
          return '<option value="' + escapeHtml(option) + '">' + escapeHtml(option) + "</option>";
        })
        .join("");
    select.value = options.indexOf(currentValue) === -1 ? "" : currentValue;
    select.setAttribute("aria-label", label);
  }

  function syncFilterOptions(root, items) {
    syncSelectOptions(root.querySelector("[data-requests-operator-filter='true']"), getUniqueOptions(items, "operator"), "Filter by operator");
    syncSelectOptions(root.querySelector("[data-requests-client-filter='true']"), getUniqueOptions(items, "client"), "Filter by client");
    if (window.CodexUX && typeof window.CodexUX.initFloatingFields === "function") {
      window.CodexUX.initFloatingFields(root);
    }
  }

  function getFilteredRequests(root) {
    var query = getSearchQuery(root);
    var operator = getFieldValue(root, "[data-requests-operator-filter='true']").toLowerCase();
    var client = getFieldValue(root, "[data-requests-client-filter='true']").toLowerCase();
    var fromDate = getFieldValue(root, "[data-requests-from-date='true']");
    var toDate = getFieldValue(root, "[data-requests-to-date='true']");
    return requestsState.items.filter(function (item) {
      var itemOperator = String(item.operator || "").trim().toLowerCase();
      var itemClient = String(item.client || "").trim().toLowerCase();
      var itemDate = String(item.created_date || "").slice(0, 10);
      if (query && requestSearchText(item).indexOf(query) === -1) {
        return false;
      }
      if (operator && itemOperator !== operator) {
        return false;
      }
      if (client && itemClient !== client) {
        return false;
      }
      if (fromDate && (!itemDate || itemDate < fromDate)) {
        return false;
      }
      if (toDate && (!itemDate || itemDate > toDate)) {
        return false;
      }
      return true;
    });
  }

  function renderSummary(root, items) {
    var totalEl = root.querySelector("[data-requests-summary-total]");
    var approvedEl = root.querySelector("[data-requests-summary-approved]");
    var rejectedEl = root.querySelector("[data-requests-summary-rejected]");
    var approved = items.filter(function (item) {
      return isApprovedStatus(item.approvalStatus || item.status);
    }).length;
    var rejected = items.filter(function (item) {
      return isRejectedStatus(item.approvalStatus || item.status);
    }).length;
    if (totalEl) {
      totalEl.textContent = String(items.length);
    }
    if (approvedEl) {
      approvedEl.textContent = String(approved);
    }
    if (rejectedEl) {
      rejectedEl.textContent = String(rejected);
    }
  }

  function setStatus(root, level, title, copy) {
    var badge = root ? root.querySelector("[data-requests-status-badge]") : null;
    var titleEl = root ? root.querySelector("[data-requests-status-title]") : null;
    var copyEl = root ? root.querySelector("[data-requests-status-copy]") : null;
    if (badge) {
      badge.classList.remove("status-badge-success", "status-badge-danger", "status-badge-loading");
      badge.classList.add(level === "error" ? "status-badge-danger" : level === "success" ? "status-badge-success" : "status-badge-loading");
    }
    if (titleEl) {
      titleEl.textContent = title || "Polling";
    }
    if (copyEl) {
      copyEl.textContent = copy || "";
    }
  }

  function renderRequests(root) {
    var list = root.querySelector("[data-requests-list]");
    var countEl = root.querySelector("[data-requests-count]");
    var pagination = root.querySelector("[data-requests-pagination]");
    var paginationInfo = root.querySelector("[data-requests-pagination-info]");
    var pageCurrent = root.querySelector("[data-requests-page-current]");
    var prevButton = root.querySelector("[data-requests-page-prev='true']");
    var nextButton = root.querySelector("[data-requests-page-next='true']");
    var filtered = getFilteredRequests(root);
    var totalPages = Math.max(1, Math.ceil(filtered.length / requestsState.perPage));
    var startIndex;
    var pageItems;
    var signature;

    if (requestsState.page > totalPages) {
      requestsState.page = totalPages;
    }
    startIndex = (requestsState.page - 1) * requestsState.perPage;
    pageItems = filtered.slice(startIndex, startIndex + requestsState.perPage);
    signature = JSON.stringify({ filters: filtered.map(function (item) { return item.id + item.status + item.created_sort; }), page: requestsState.page });

    if (!list || signature === lastRenderedSignature) {
      return;
    }
    lastRenderedSignature = signature;
    if (countEl) {
      countEl.textContent = "(" + filtered.length + ")";
    }
    if (pagination) {
      pagination.hidden = filtered.length <= requestsState.perPage;
    }
    if (paginationInfo) {
      paginationInfo.textContent = filtered.length
        ? "Showing " + (startIndex + 1) + "-" + Math.min(startIndex + requestsState.perPage, filtered.length) + " of " + filtered.length + " requests"
        : "Showing 0 requests";
    }
    if (pageCurrent) {
      pageCurrent.textContent = "Page " + requestsState.page + " of " + totalPages;
    }
    if (prevButton) {
      prevButton.disabled = requestsState.page <= 1;
      prevButton.classList.toggle("disabled", requestsState.page <= 1);
    }
    if (nextButton) {
      nextButton.disabled = requestsState.page >= totalPages;
      nextButton.classList.toggle("disabled", requestsState.page >= totalPages);
    }

    if (!filtered.length) {
      list.innerHTML =
        '<div class="requests-empty-state">' +
          "<strong>" + (requestsState.items.length ? "No matching requests." : "No requests found.") + "</strong>" +
          "<p>" + (requestsState.items.length ? "Try changing the search, operator, client, or date filters." : "The request endpoint returned an empty list.") + "</p>" +
        "</div>";
      return;
    }

    list.innerHTML = pageItems
      .map(function (item) {
        var statusClass = normalizeStatusClass(item.status);
        var approvalStatus = item.approvalStatus || "-";
        var approvalStatusClass = normalizeStatusClass(approvalStatus);
        return (
          '<article class="request-card">' +
            '<div class="request-card-main">' +
              '<div class="request-card-title">' +
                "<strong>" + escapeHtml(item.id || "-") + "</strong>" +
                '<span class="request-status-pill ' + statusClass + '">' + escapeHtml(item.status || "Pending") + "</span>" +
                '<span class="request-approval-pill ' + approvalStatusClass + '">Approval: ' + escapeHtml(approvalStatus) + "</span>" +
              "</div>" +
              '<p class="request-card-message">' + escapeHtml(item.message || "-") + "</p>" +
              '<div class="request-card-meta">' +
                '<span class="request-chip">Sender: ' + escapeHtml(item.sender || "-") + "</span>" +
                '<span class="request-chip">Receiver: ' + escapeHtml(item.receiver || "-") + "</span>" +
                '<span class="request-chip">Client: ' + escapeHtml(item.client || "-") + "</span>" +
                '<span class="request-chip">Operator: ' + escapeHtml(item.operator || "-") + "</span>" +
                '<span class="request-chip">approvalStatus: ' + escapeHtml(approvalStatus) + "</span>" +
              "</div>" +
            "</div>" +
            '<div class="request-card-side">' +
              "<strong>" + escapeHtml(item.amount || "-") + "</strong>" +
              "<span>" + escapeHtml([item.date_label, item.time_label].filter(Boolean).join(" · ") || "-") + "</span>" +
              "<span>" + escapeHtml(item.action || "-") + "</span>" +
            "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  async function pollRequests(root, manual) {
    var url = root.getAttribute("data-requests-api-url") || "/api/getrequests";
    var response;
    var payload = {};

    setStatus(root, "loading", manual ? "Refreshing" : "Polling", "Checking the request endpoint.");
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      try {
        payload = await response.json();
      } catch (_jsonError) {
        payload = {};
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "Unable to load requests.");
      }
      requestsState.items = Array.isArray(payload.data) ? payload.data : [];
      syncFilterOptions(root, requestsState.items);
      renderSummary(root, requestsState.items);
      renderRequests(root);
      setStatus(root, "success", "Live", "Showing " + (payload.meta && payload.meta.count != null ? payload.meta.count : 0) + " requests. Last updated " + ((payload.meta && payload.meta.last_updated) || "now") + ".");
    } catch (error) {
      setStatus(root, "error", "Request Sync Failed", error.message || "Unable to load requests.");
    }
  }

  function initRequestsPage() {
    var root = getRoot();
    var searchField;
    var filterFields;
    var refreshButton;
    var prevButton;
    var nextButton;
    if (requestPollTimer) {
      window.clearInterval(requestPollTimer);
      requestPollTimer = null;
    }
    if (!root) {
      return;
    }

    lastRenderedSignature = "";
    searchField = root.querySelector("[data-requests-search='true']");
    filterFields = root.querySelectorAll("[data-requests-operator-filter='true'], [data-requests-client-filter='true'], [data-requests-from-date='true'], [data-requests-to-date='true']");
    refreshButton = root.querySelector("[data-requests-refresh='true']");
    prevButton = root.querySelector("[data-requests-page-prev='true']");
    nextButton = root.querySelector("[data-requests-page-next='true']");

    if (searchField && searchField.getAttribute("data-requests-search-bound") !== "true") {
      searchField.setAttribute("data-requests-search-bound", "true");
      searchField.addEventListener("input", function () {
        requestsState.page = 1;
        lastRenderedSignature = "";
        renderRequests(root);
      });
    }
    filterFields.forEach(function (field) {
      if (field.getAttribute("data-requests-filter-bound") === "true") {
        return;
      }
      field.setAttribute("data-requests-filter-bound", "true");
      field.addEventListener("change", function () {
        requestsState.page = 1;
        lastRenderedSignature = "";
        renderRequests(root);
      });
    });
    if (refreshButton && refreshButton.getAttribute("data-requests-refresh-bound") !== "true") {
      refreshButton.setAttribute("data-requests-refresh-bound", "true");
      refreshButton.addEventListener("click", function () {
        pollRequests(root, true);
      });
    }
    if (prevButton && prevButton.getAttribute("data-requests-page-bound") !== "true") {
      prevButton.setAttribute("data-requests-page-bound", "true");
      prevButton.addEventListener("click", function () {
        if (requestsState.page > 1) {
          requestsState.page -= 1;
          lastRenderedSignature = "";
          renderRequests(root);
        }
      });
    }
    if (nextButton && nextButton.getAttribute("data-requests-page-bound") !== "true") {
      nextButton.setAttribute("data-requests-page-bound", "true");
      nextButton.addEventListener("click", function () {
        requestsState.page += 1;
        lastRenderedSignature = "";
        renderRequests(root);
      });
    }

    pollRequests(root, false);
    requestPollTimer = window.setInterval(function () {
      pollRequests(root, false);
    }, 30000);
  }

  if (!window.RequestsPageListenerBound) {
    window.addEventListener("ux:content-updated", function (event) {
      if (!event.detail || event.detail.target !== "#requests-page-root") {
        if (!getRoot() && requestPollTimer) {
          window.clearInterval(requestPollTimer);
          requestPollTimer = null;
        }
        return;
      }
      initRequestsPage();
    });
    window.RequestsPageListenerBound = true;
  }

  initRequestsPage();
})();

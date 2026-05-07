/* global document */
(function () {
  "use strict";

  function formatDate(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function addDays(date, days) {
    var next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
  }

  function setDefaultDates(root) {
    var today = new Date();
    root.querySelectorAll("[data-default-today]").forEach(function (input) {
      if (!input.value) {
        input.value = formatDate(today);
      }
    });
    root.querySelectorAll("[data-default-plus-days]").forEach(function (input) {
      var days = Number(input.getAttribute("data-default-plus-days") || 0);
      if (!input.value) {
        input.value = formatDate(addDays(today, days));
      }
    });
  }

  function syncCommissionSources(root) {
    var typeSelect = root.querySelector("[data-commission-source-type]");
    var sourceSelect = root.querySelector("[data-commission-source]");
    var selectedType;
    var firstVisibleValue = "";
    if (!typeSelect || !sourceSelect) {
      return;
    }
    selectedType = typeSelect.value === "bank" ? "bank" : "mobile";
    Array.prototype.forEach.call(sourceSelect.options, function (option) {
      var isVisible = option.getAttribute("data-source-type") === selectedType;
      option.hidden = !isVisible;
      option.disabled = !isVisible;
      if (isVisible && !firstVisibleValue) {
        firstVisibleValue = option.value;
      }
    });
    if (!sourceSelect.selectedOptions.length || sourceSelect.selectedOptions[0].disabled) {
      sourceSelect.value = firstVisibleValue;
    }
  }

  function bindCommissionSourceType(root) {
    var typeSelect = root.querySelector("[data-commission-source-type]");
    if (!typeSelect || typeSelect.getAttribute("data-bound") === "true") {
      return;
    }
    typeSelect.setAttribute("data-bound", "true");
    typeSelect.addEventListener("change", function () {
      syncCommissionSources(root);
    });
  }

  function bindLoanIssuedDate(root) {
    var issuedInput = root.querySelector("[data-loan-issued]");
    var dueInput = root.querySelector("[data-loan-due]");
    if (!issuedInput || !dueInput || issuedInput.getAttribute("data-due-bound") === "true") {
      return;
    }
    issuedInput.setAttribute("data-due-bound", "true");
    issuedInput.addEventListener("change", function () {
      if (issuedInput.value) {
        dueInput.value = formatDate(addDays(new Date(issuedInput.value + "T00:00:00"), 7));
      }
    });
  }

  function initOperationsPage() {
    var root = document.querySelector(".operations-page");
    if (!root) {
      return;
    }
    setDefaultDates(root);
    syncCommissionSources(root);
    bindCommissionSourceType(root);
    bindLoanIssuedDate(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOperationsPage);
  } else {
    initOperationsPage();
  }
})();

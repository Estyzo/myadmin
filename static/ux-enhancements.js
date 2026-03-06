/* global window, document, fetch, FormData, URL, DOMParser, history, CustomEvent */
(function () {
  "use strict";

  var autoSubmitTimers = new WeakMap();

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
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

  function setElementLoadingState(element, isLoading) {
    if (!element) {
      return;
    }
    element.classList.toggle("is-loading", isLoading);
    if (element.tagName === "BUTTON" || element.tagName === "INPUT") {
      element.disabled = !!isLoading;
    }
  }

  async function fetchAndSwap(url, targetSelector, pushHistory) {
    var response = await fetch(url, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    var html = await response.text();
    if (!response.ok) {
      throw new Error("Request failed (" + response.status + ").");
    }
    if (!replaceTargetFromHtml(targetSelector, html)) {
      throw new Error("Unable to update page section.");
    }
    if (pushHistory) {
      history.pushState({ url: url }, "", url);
    }
    window.dispatchEvent(new CustomEvent("ux:content-updated", { detail: { target: targetSelector } }));
  }

  window.CodexUX = window.CodexUX || {};
  window.CodexUX.fetchAndSwap = fetchAndSwap;

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

  function clearFieldError(field) {
    if (!field) {
      return;
    }
    field.setAttribute("aria-invalid", "false");
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
  }

  function setFieldError(field, message) {
    if (!field) {
      return;
    }
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
    errorEl.textContent = message;
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
    if (level) {
      feedback.classList.add(level);
    }
  }

  function applyApiFieldErrors(form, errors) {
    if (!errors || typeof errors !== "object") {
      return;
    }
    Object.keys(errors).forEach(function (name) {
      var field = form.querySelector('[name="' + name + '"]');
      if (!field) {
        return;
      }
      setFieldError(field, String(errors[name]));
    });
  }

  function validateSendMoneyForm(form) {
    var senderField = form.querySelector('[name="sender_mobile_number"]');
    var receiverField = form.querySelector('[name="receiver_phone_number"]');
    var amountField = form.querySelector('[name="amount"]');

    [senderField, receiverField, amountField].forEach(clearFieldError);
    setFormFeedback(form, "", "");

    var hasErrors = false;
    var normalizedSender = normalizePhone(senderField && senderField.value);
    var normalizedReceiver = normalizePhone(receiverField && receiverField.value);
    var amount = amountField ? parseFloat(String(amountField.value || "").trim()) : NaN;

    if (!normalizedSender) {
      hasErrors = true;
      setFieldError(senderField, "Choose a valid sender number.");
    }
    if (!normalizedReceiver) {
      hasErrors = true;
      setFieldError(receiverField, "Enter a valid receiver number.");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      hasErrors = true;
      setFieldError(amountField, "Enter an amount greater than zero.");
    }

    if (hasErrors) {
      setFormFeedback(form, "Please correct the highlighted fields.", "error");
      return null;
    }

    return {
      sender_mobile_number: normalizedSender,
      receiver_phone_number: normalizedReceiver,
      amount: Number(amount.toFixed(2)),
    };
  }

  async function handleSendMoneySubmit(form) {
    var payload = validateSendMoneyForm(form);
    if (!payload) {
      return;
    }

    var submitBtn = form.querySelector('[type="submit"]');
    setElementLoadingState(submitBtn, true);
    setFormFeedback(form, "Submitting transfer...", "info");

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
        applyApiFieldErrors(form, result.errors);
        throw new Error(result.error || "Unable to submit transfer request.");
      }

      setFormFeedback(form, result.message || "Transfer request submitted successfully.", "success");
      form.reset();
    } catch (error) {
      setFormFeedback(form, error.message || "Transfer request failed.", "error");
    } finally {
      setElementLoadingState(submitBtn, false);
    }
  }

  document.addEventListener("click", function (event) {
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
    fetchAndSwap(url.toString(), targetSelector, true)
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
    fetchAndSwap(url, targetSelector, true)
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

  window.addEventListener("popstate", function () {
    window.location.reload();
  });
})();

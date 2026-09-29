/* ====================================================================
   PART 1 — OTP SERVICE
   Thin client for the "GoodayOn - OTP Public Proxy" n8n workflow.
   The proxy attaches X-OTP-Key server-side, so no key lives in this file.
   ==================================================================== */
(function () {
  "use strict";

  var OTP_API_BASE = "https://goodayon.app.n8n.cloud/webhook";
  // Same purpose string as the main Etalem form. Use a distinct string
  // (e.g. "etalem_catering_request") if catering should have its own
  // rate-limit and cooldown state for the same phone number.
  var OTP_PURPOSE = "etalem_service_request";

  function otpRequest(path, body) {
    return fetch(OTP_API_BASE + "/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response
        .json()
        .catch(function () { return null; })
        .then(function (data) { return { ok: response.ok, status: response.status, data: data }; });
    });
  }

  function sendOtp(phone) {
    return otpRequest("goodayon-provider-otp-send", { phone: phone, purpose: OTP_PURPOSE });
  }
  function verifyOtp(phone, code) {
    return otpRequest("goodayon-provider-otp-verify", { phone: phone, code: code, purpose: OTP_PURPOSE });
  }

  function formatWait(seconds) {
    seconds = Math.max(0, Math.round(seconds || 0));
    if (seconds < 60) return seconds + "s";
    var m = Math.floor(seconds / 60), s = seconds % 60;
    return m + "m" + (s ? " " + s + "s" : "");
  }

  function describeSendError(res) {
    var data = (res && res.data) || {};
    switch (data.reason) {
      case "invalid_phone": return "Enter a valid Ethiopian mobile number.";
      case "cooldown": return "Please wait " + formatWait(data.retryAfterSeconds) + " before requesting another code.";
      case "too_many_requests": return "Too many code requests. Try again in " + formatWait(data.retryAfterSeconds) + ".";
      case "locked_out": return "Too many incorrect attempts. Try again in " + formatWait(data.retryAfterSeconds) + ".";
      case "delivery_failed": return "We couldn't deliver the code right now. Please try again shortly.";
      default:
        if (res && res.status === 403) return "We couldn't verify this request. Please refresh the page and try again.";
        return "Something went wrong sending the code. Please try again.";
    }
  }

  function describeVerifyError(res) {
    var data = (res && res.data) || {};
    switch (data.reason) {
      case "no_active_code": return "This code has expired or wasn't found. Request a new one.";
      case "expired": return "This code has expired. Request a new one.";
      case "incorrect_code":
        var left = data.attemptsRemaining;
        return "Incorrect code." + (left !== undefined ? " " + left + " attempt" + (left === 1 ? "" : "s") + " left." : "");
      case "too_many_attempts": return "Too many incorrect attempts for this code. Request a new one.";
      case "already_used": return "This code was already used. Request a new one.";
      case "locked_out": return "Too many incorrect attempts. Try again in " + formatWait(data.retryAfterSeconds) + ".";
      case "invalid_phone": return "Something went wrong with your phone number. Please go back and re-enter it.";
      case "invalid_code_format": return "Enter the 6-digit code.";
      default:
        if (res && res.status === 403) return "We couldn't verify this request. Please refresh the page and try again.";
        return "Something went wrong verifying the code. Please try again.";
    }
  }

  window.OTPService = {
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    describeSendError: describeSendError,
    describeVerifyError: describeVerifyError,
  };
})();

/* ====================================================================
   PART 2 — CATERING WIZARD
   ==================================================================== */
(function () {
  "use strict";

  // Set to the catering n8n webhook URL. While empty, the payload is only
  // logged to the console and the closing screen is shown (test mode).
  var WEBHOOK_URL = "";
  var MAX_LEAD_DAYS = 7;
  var BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';

  var STEPS = ["contact", "otp", "date", "session", "guests", "includes", "menuType", "menuDetails", "budget", "location", "channel", "comms", "notes"];

  var form = document.getElementById("etlCateringForm");
  var formWrap = document.getElementById("etlFormWrap");
  var formSuccess = document.getElementById("etlFormSuccess");
  var progressLabel = document.getElementById("etlProgressLabel");
  var progressFill = document.getElementById("etlProgressFill");

  var stepEls = {};
  STEPS.forEach(function (name) { stepEls[name] = form.querySelector('[data-step="' + name + '"]'); });
  form.querySelectorAll("[data-back]").forEach(function (b) { b.innerHTML = BACK_SVG; });

  var current = "contact";
  var verifiedPhone = ""; // phone that already passed OTP, so back/forward doesn't re-send a code
  var submitting = false;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function val(id) { return ($(id).value || "").trim(); }
  function grp(name) { return form.querySelector('[data-group="' + name + '"]'); }
  function radioVal(name) { var e = form.querySelector('input[name="' + name + '"]:checked'); return e ? e.value : ""; }
  function checkedVals(name) {
    return Array.prototype.map.call(form.querySelectorAll('input[name="' + name + '"]:checked'), function (e) { return e.value; });
  }
  function fullPhone() { return "+251" + val("fPhone").replace(/\s/g, ""); }

  /* ---------- errors ---------- */
  function clearErr() {
    form.querySelectorAll(".etl-field-error").forEach(function (e) { e.remove(); });
  }
  function showErr(message, target) {
    clearErr();
    var host = target.closest(".etl-form-group, .etlw-consent-row, .etlw-stepper") || target;
    var node = document.createElement("div");
    node.className = "etl-field-error";
    node.setAttribute("role", "alert");
    node.textContent = message;
    host.appendChild(node);
    if (host.scrollIntoView) host.scrollIntoView({ behavior: "smooth", block: "center" });
    if (target.focus && target.tagName === "INPUT" && target.type !== "checkbox") target.focus();
  }

  /* ---------- date limits: today .. today + 7 days ---------- */
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  var today = new Date(), maxDate = new Date();
  maxDate.setDate(today.getDate() + MAX_LEAD_DAYS);
  $("fDate").min = ymd(today);
  $("fDate").max = ymd(maxDate);

  /* ---------- OTP UI ---------- */
  var otpInputs = Array.prototype.slice.call(document.querySelectorAll(".etlw-otp-input"));
  var otpRow = $("etlOtpRow");
  var otpResendBtn = $("etlOtpResendBtn");
  var otpTimer = null;

  function otpValue() { return otpInputs.map(function (i) { return i.value; }).join(""); }
  function resetOtpInputs() {
    otpInputs.forEach(function (i) { i.value = ""; i.classList.remove("etl-otp-filled"); });
  }
  function mmss(total) {
    var s = Math.max(0, Math.round(total));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function setOtpBackDisabled(disabled) {
    var back = stepEls.otp.querySelector("[data-back]");
    if (back) back.disabled = disabled;
  }
  function startOtpCountdown(seconds) {
    seconds = seconds || 60;
    if (otpTimer) clearInterval(otpTimer);
    otpResendBtn.disabled = true;
    otpResendBtn.innerHTML = 'Resend in <span id="etlOtpCountdown">' + mmss(seconds) + "</span>";
    setOtpBackDisabled(true);
    otpTimer = setInterval(function () {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(otpTimer);
        otpTimer = null;
        otpResendBtn.disabled = false;
        otpResendBtn.textContent = "Resend code";
        setOtpBackDisabled(false);
        return;
      }
      var span = $("etlOtpCountdown");
      if (span) span.textContent = mmss(seconds);
    }, 1000);
  }
  function updateOtpSubtitle() {
    var d = val("fPhone").replace(/\D/g, "");
    var masked = d.length < 9 ? "+251 9** *** ***" : "+251 " + d.charAt(0) + "** *** " + d.slice(6, 9);
    $("etlOtpSubtitle").textContent = "We sent a 6-digit code to " + masked + ".";
  }

  // The proxy returns HTTP 200 for logical failures (wrong/expired code, cooldown...)
  // and signals them with a `reason` field, so res.ok alone is not enough.
  function isOtpFailure(res) {
    if (!res || !res.ok) return true;
    var d = res.data;
    if (!d) return false;
    return !!(d.reason || d.success === false || d.verified === false);
  }
  function sendOtpRequest() {
    return window.OTPService.sendOtp(fullPhone()).then(function (res) {
      if (isOtpFailure(res)) {
        var err = new Error(window.OTPService.describeSendError(res));
        err.retryAfterSeconds = res && res.data && res.data.retryAfterSeconds;
        throw err;
      }
      return res;
    });
  }

  otpInputs.forEach(function (input, idx) {
    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "").slice(0, 1);
      input.classList.toggle("etl-otp-filled", !!input.value);
      if (input.value && otpInputs[idx + 1]) otpInputs[idx + 1].focus();
      updateContinue();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !input.value && otpInputs[idx - 1]) otpInputs[idx - 1].focus();
    });
    input.addEventListener("paste", function (e) {
      var pasted = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "");
      if (!pasted) return;
      e.preventDefault();
      pasted.split("").slice(0, otpInputs.length).forEach(function (digit, i) {
        otpInputs[i].value = digit;
        otpInputs[i].classList.add("etl-otp-filled");
      });
      otpInputs[Math.min(pasted.length, otpInputs.length) - 1].focus();
      updateContinue();
    });
  });

  otpResendBtn.addEventListener("click", function () {
    if (otpResendBtn.disabled) return;
    clearErr();
    otpResendBtn.disabled = true;
    sendOtpRequest()
      .then(function () { resetOtpInputs(); otpInputs[0].focus(); startOtpCountdown(); })
      .catch(function (err) {
        showErr(err.message, otpRow);
        if (err.retryAfterSeconds) startOtpCountdown(err.retryAfterSeconds);
        else otpResendBtn.disabled = false;
      });
  });

  /* ---------- navigation ---------- */
  function updateProgress() {
    var idx = STEPS.indexOf(current);
    progressLabel.textContent = "Step " + (idx + 1) + " of " + STEPS.length;
    progressFill.style.width = ((idx + 1) / STEPS.length) * 100 + "%";
  }
  function goTo(name) {
    current = name;
    STEPS.forEach(function (n) { stepEls[n].classList.toggle("etlw-step-active", n === name); });
    if (name === "otp") updateOtpSubtitle();
    clearErr();
    updateProgress();
    updateContinue();
  }
  function goBack() {
    var idx = STEPS.indexOf(current);
    if (idx <= 0) return;
    // OTP is already verified, so going back from "date" returns to the contact step.
    goTo(current === "date" ? "contact" : STEPS[idx - 1]);
  }

  /* ---------- validation ---------- */
  // Returns [message, elementToHighlight] or null when the step is valid.
  function validate(step) {
    switch (step) {
      case "contact":
        if (!val("fName")) return ["Please enter your full name.", $("fName")];
        if (!/^[79][0-9]{8}$/.test(val("fPhone").replace(/\s/g, ""))) return ["Enter a valid Ethiopian mobile number: 9 digits starting with 9 or 7.", $("fPhone")];
        if (!$("fConsent").checked) return ["Please agree to the Privacy Policy to continue.", stepEls.contact.querySelector(".etlw-consent-row")];
        return null;
      case "otp":
        if (otpValue().length < 6) return ["Please enter the 6-digit code we sent you.", otpRow];
        return null;
      case "date":
        var d = $("fDate");
        if (!d.value) return ["Please pick a date.", d];
        if (d.value < d.min || d.value > d.max) return ["Please pick a date within the next 7 days.", d];
        return null;
      case "session":
        return checkedVals("sessionType").length ? null : ["Please select at least one session type.", grp("sessionType")];
      case "guests":
        return parseInt($("fGuests").value, 10) >= 1 ? null : ["Enter at least 1 person.", $("fGuests")];
      case "includes":
        return checkedVals("cateringMenuSelection").length ? null : ["Please select at least one option.", grp("cateringMenuSelection")];
      case "menuType":
        return checkedVals("cuisineType").length ? null : ["Please select at least one menu type.", grp("cuisineType")];
      case "menuDetails":
        return val("fMenu") ? null : ["Please tell us what you have in mind for the menu.", $("fMenu")];
      case "budget":
        return parseFloat($("fBudget").value) > 0 ? null : ["Enter a budget per person greater than 0.", $("fBudget")];
      case "location":
        if (!val("fLocation")) return ["Please enter the area or address.", $("fLocation")];
        if (!val("fLandmark")) return ["Please enter a nearby landmark.", $("fLandmark")];
        return null;
      case "channel":
        return radioVal("marketingChannel") ? null : ["Please let us know how you found Etalem.", grp("marketingChannel")];
      case "comms":
        return radioVal("preferredCommunicationChannel") ? null : ["Please select how you'd like us to reach you.", grp("preferredCommunicationChannel")];
      default:
        return null;
    }
  }

  // Contact and OTP buttons stay disabled until their fields are filled.
  function updateContinue() {
    var btn = stepEls[current].querySelector("[data-next]");
    if (!btn || btn.dataset.originalText !== undefined) return; // don't re-enable mid-request
    if (current === "contact") {
      btn.disabled = !(val("fName") && val("fPhone") && $("fConsent").checked);
    } else if (current === "otp") {
      btn.disabled = otpValue().length !== 6;
    }
  }

  function setLoading(btn, on, text) {
    if (on) {
      if (btn.dataset.originalText === undefined) btn.dataset.originalText = btn.textContent;
      btn.textContent = text;
      btn.disabled = true;
    } else {
      if (btn.dataset.originalText !== undefined) {
        btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
      btn.disabled = false;
    }
  }

  /* ---------- step actions ---------- */
  function handleContactNext(btn) {
    if (verifiedPhone && verifiedPhone === fullPhone()) { goTo("date"); return; }
    setLoading(btn, true, "Sending verification code...");
    sendOtpRequest()
      .then(function () {
        setLoading(btn, false);
        resetOtpInputs();
        startOtpCountdown();
        goTo("otp");
        otpInputs[0].focus();
      })
      .catch(function (err) {
        setLoading(btn, false);
        showErr(err.message, $("fPhone"));
      });
  }

  function handleOtpNext(btn) {
    setLoading(btn, true, "Verifying...");
    window.OTPService.verifyOtp(fullPhone(), otpValue())
      .then(function (res) {
        setLoading(btn, false);
        if (isOtpFailure(res)) {
          showErr(window.OTPService.describeVerifyError(res), otpRow);
          resetOtpInputs();
          otpInputs[0].focus();
          updateContinue();
          if (res && res.data && res.data.reason === "locked_out" && res.data.retryAfterSeconds) {
            startOtpCountdown(res.data.retryAfterSeconds);
          }
          return;
        }
        verifiedPhone = fullPhone();
        if (otpTimer) { clearInterval(otpTimer); otpTimer = null; }
        setOtpBackDisabled(false);
        goTo("date");
      })
      .catch(function () {
        setLoading(btn, false);
        showErr("Something went wrong verifying the code. Please try again.", otpRow);
        updateContinue();
      });
  }

  function handleNext(btn) {
    var err = validate(current);
    if (err) { showErr(err[0], err[1]); return; }
    if (current === "contact") return handleContactNext(btn);
    if (current === "otp") return handleOtpNext(btn);
    goTo(STEPS[STEPS.indexOf(current) + 1]);
  }

  /* ---------- events ---------- */
  form.addEventListener("click", function (e) {
    var t = e.target.closest("[data-next], [data-back], .etlw-stepper-btn");
    if (!t) return;
    if (t.hasAttribute("data-back")) goBack();
    else if (t.hasAttribute("data-next")) handleNext(t);
    else {
      var g = $("fGuests");
      g.value = Math.max(1, (parseInt(g.value, 10) || 1) + parseInt(t.getAttribute("data-dir"), 10));
    }
  });

  form.addEventListener("input", function (e) {
    if (e.target.id === "fMenu") $("fMenuCount").textContent = e.target.value.length + "/500 characters used";
    if (e.target.id === "fNotes") $("fNotesCount").textContent = e.target.value.length + "/500 characters used";
    if (e.target.closest(".etl-form-group, .etlw-option-list, .etl-checkbox-group")) clearErr();
    updateContinue();
  });

  form.addEventListener("change", function (e) {
    var t = e.target;
    // Full Day is exclusive: picking it clears other sessions; picking another clears Full Day.
    if (t.name === "sessionType" && t.checked) {
      form.querySelectorAll('input[name="sessionType"]').forEach(function (o) {
        if (o !== t && (t.value === "Full Day" || o.value === "Full Day")) o.checked = false;
      });
    }
    updateContinue();
  });

  // Enter advances the wizard instead of submitting early.
  form.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.target.tagName === "TEXTAREA" || current === "notes") return;
    e.preventDefault();
    var btn = stepEls[current].querySelector("[data-next]");
    if (btn && !btn.disabled) handleNext(btn);
  });

  /* ---------- submit ---------- */
  function buildPayload() {
    return {
      sourcePage: "etalem-catering",
      service: "catering",
      fullName: val("fName"),
      phone: fullPhone(),
      serviceDate: $("fDate").value,
      sessionType: checkedVals("sessionType"),
      numberOfPeople: parseInt($("fGuests").value, 10),
      cateringMenuSelection: checkedVals("cateringMenuSelection"),
      cuisineType: checkedVals("cuisineType"),
      taskDetails: val("fMenu"),
      employerBudget: parseFloat($("fBudget").value),
      location: val("fLocation"),
      landmark: val("fLandmark"),
      marketingChannel: radioVal("marketingChannel"),
      preferredCommunicationChannel: radioVal("preferredCommunicationChannel"),
      notes: val("fNotes"),
    };
  }
  function showSuccess() {
    formWrap.style.display = "none";
    formSuccess.style.display = "block";
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (current !== "notes" || submitting) return;
    var payload = buildPayload();
    if (!WEBHOOK_URL) {
      console.log("Catering payload (test mode, not sent):", payload);
      showSuccess();
      return;
    }
    var btn = $("etlSubmitBtn"), label = btn.textContent;
    submitting = true;
    btn.disabled = true;
    btn.textContent = "Sending...";
    fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed with status " + res.status);
        showSuccess();
      })
      .catch(function () {
        showErr("Sorry, we could not submit your request. Please try again or call 9675.", $("fNotes"));
      })
      .finally(function () {
        submitting = false;
        btn.disabled = false;
        btn.textContent = label;
      });
  });

  goTo("contact");
})();
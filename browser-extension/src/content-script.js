(function () {
  if (window.__wandPasswordsLoaded) return;
  window.__wandPasswordsLoaded = true;

  var state = {
    items: [],
    activeInput: null,
    root: null,
    panel: null,
    savePromptOpen: false,
    disabled: false
  };

  loadSiteSettings();
  refreshItems();
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);
  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message.type === "wand-fill-item") {
      fillItem(message.item);
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "wand-fill-generated-password") {
      fillGeneratedPassword(message.password);
      sendResponse({ ok: true });
    }
  });

  function refreshItems() {
    if (state.disabled) return;
    chrome.runtime.sendMessage({ type: "items-for-url", url: location.href }, function (response) {
      if (response && response.ok) {
        state.items = response.items || [];
      }
    });
  }

  function onFocusIn(event) {
    var input = event.target;
    if (state.disabled) return;
    if (!isFillableInput(input)) return;
    state.activeInput = input;
    renderPanel(input);
  }

  function onInput(event) {
    var input = event.target;
    if (state.disabled) return;
    if (input === state.activeInput && isFillableInput(input)) {
      renderPanel(input);
    }
  }

  function onSubmit(event) {
    var form = event.target;
    if (state.disabled) return;
    if (!form || state.savePromptOpen) return;
    var login = extractLoginFromForm(form);
    if (!login || !login.password) return;
    state.savePromptOpen = true;
    var shouldSave = window.confirm("Save this login to Wand Passwords?");
    state.savePromptOpen = false;
    if (!shouldSave) return;
    chrome.runtime.sendMessage({
      type: "capture-login",
      title: document.title || location.hostname,
      url: location.href,
      username: login.username,
      password: login.password
    }, function () {
      refreshItems();
    });
  }

  function onClick(event) {
    if (state.disabled) return;
    var provider = detectFederatedProvider(event.target);
    if (!provider) return;
    var alreadySaved = state.items.some(function (item) {
      return item.fields && item.fields.providerLogin === provider;
    });
    if (alreadySaved) return;
    var shouldSave = window.confirm("Remember this sign-in choice in Wand Passwords?");
    if (!shouldSave) return;
    chrome.runtime.sendMessage({
      type: "capture-federated-login",
      title: document.title || location.hostname,
      url: location.href,
      provider: provider
    });
  }

  function loadSiteSettings() {
    chrome.runtime.sendMessage({ type: "site-settings", url: location.href }, function (response) {
      state.disabled = !!(response && response.ok && response.disabled);
      if (state.disabled) hidePanel();
    });
  }

  function renderPanel(input) {
    var candidates = matchingItems(input);
    if (!candidates.length) {
      hidePanel();
      return;
    }
    ensurePanel();
    var rect = input.getBoundingClientRect();
    state.root.style.left = Math.max(8, Math.min(window.innerWidth - 330, rect.left + window.scrollX)) + "px";
    state.root.style.top = (rect.bottom + window.scrollY + 6) + "px";
    state.panel.innerHTML = "";
    candidates.slice(0, 6).forEach(function (item) {
      var button = document.createElement("button");
      button.className = "wand-fill-row";
      button.type = "button";
      button.innerHTML = "<span><strong></strong><small></small></span><em></em>";
      button.querySelector("strong").textContent = item.title || "Untitled";
      button.querySelector("small").textContent = subtitleForItem(item);
      button.querySelector("em").textContent = labelForType(item.type);
      button.addEventListener("mousedown", function (event) {
        event.preventDefault();
        fillItem(item);
        chrome.runtime.sendMessage({ type: "touch-item", id: item.id });
        hidePanel();
      });
      state.panel.appendChild(button);
    });
  }

  function ensurePanel() {
    if (state.root && state.panel) return;
    state.root = document.createElement("div");
    state.root.className = "wand-fill-root";
    var shadow = state.root.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial;position:absolute;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      ".panel{width:320px;max-height:300px;overflow:auto;padding:6px;border:1px solid #c9d3e2;border-radius:8px;background:#fff;box-shadow:0 14px 40px rgba(14,30,54,.18);color:#172033}",
      ".wand-fill-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;border:0;background:transparent;text-align:left;border-radius:6px;padding:9px 10px;color:#172033;cursor:pointer}",
      ".wand-fill-row:hover,.wand-fill-row:focus{background:#edf4ff;outline:none}",
      "strong{display:block;font-size:13px;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "small{display:block;margin-top:3px;font-size:12px;color:#5d6b82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "em{font-style:normal;font-size:11px;color:#31507a;background:#e4efff;border-radius:999px;padding:3px 7px;white-space:nowrap}"
    ].join("");
    state.panel = document.createElement("div");
    state.panel.className = "panel";
    shadow.append(style, state.panel);
    document.documentElement.appendChild(state.root);
    document.addEventListener("pointerdown", function (event) {
      if (!state.root.contains(event.target) && event.target !== state.activeInput) hidePanel();
    }, true);
  }

  function hidePanel() {
    if (state.root) {
      state.root.remove();
      state.root = null;
      state.panel = null;
    }
  }

  function matchingItems(input) {
    var kind = classifyInput(input);
    return state.items.filter(function (item) {
      if (kind === "login") return item.type === "login";
      if (kind === "card") return item.type === "credit_card";
      if (kind === "identity") return item.type === "identity";
      return item.type === "login" || item.type === "identity";
    });
  }

  function fillItem(item) {
    if (!item) return;
    if (item.type === "login") fillLogin(item);
    if (item.type === "credit_card") fillCreditCard(item);
    if (item.type === "identity") fillIdentity(item);
  }

  function fillLogin(item) {
    if (item.fields && item.fields.providerLogin) {
      if (clickProviderButton(item.fields.providerLogin)) return;
    }
    var form = findFormForActiveInput();
    var username = findUsernameInput(form) || findInputByAutocomplete("username");
    var password = findPasswordInput(form);
    var otp = findOtpInput(form);
    if (username && item.username) setNativeValue(username, item.username);
    if (password && item.password) setNativeValue(password, item.password);
    if (otp && item.fields && item.fields.totpSecret) {
      chrome.runtime.sendMessage({ type: "preview-totp", secret: item.fields.totpSecret }, function (response) {
        if (response && response.ok && response.code) setNativeValue(otp, response.code);
      });
    }
  }

  function fillCreditCard(item) {
    var fields = item.fields || {};
    setFirst(["cc-name", "name"], fields.cardholder || fields.name);
    setFirst(["cc-number", "cardnumber", "card-number"], fields.number);
    setFirst(["cc-exp-month", "exp-month"], fields.expMonth);
    setFirst(["cc-exp-year", "exp-year"], fields.expYear);
    setFirst(["cc-exp", "expiration"], [fields.expMonth, fields.expYear].filter(Boolean).join("/"));
    setFirst(["cc-csc", "cvc", "cvv"], fields.cvc);
  }

  function fillIdentity(item) {
    var fields = item.fields || {};
    setFirst(["name", "fullname"], fields.name || item.username);
    setFirst(["email"], fields.email);
    setFirst(["tel", "phone"], fields.phone);
    setFirst(["organization"], fields.organization);
    setFirst(["street-address", "address-line1"], fields.address);
    setFirst(["address-level2", "city"], fields.city);
    setFirst(["address-level1", "state"], fields.state);
    setFirst(["postal-code", "zip"], fields.postalCode);
    setFirst(["country"], fields.country);
  }

  function fillGeneratedPassword(password) {
    var target = state.activeInput || document.activeElement;
    if (isFillableInput(target)) setNativeValue(target, password);
  }

  function setFirst(tokens, value) {
    if (!value) return;
    var input = findInputByTokens(tokens);
    if (input) setNativeValue(input, value);
  }

  function findFormForActiveInput() {
    return state.activeInput && state.activeInput.form ? state.activeInput.form : null;
  }

  function extractLoginFromForm(form) {
    var password = findPasswordInput(form);
    if (!password || !password.value) return null;
    var username = findUsernameInput(form);
    return {
      username: username ? username.value : "",
      password: password.value
    };
  }

  function findPasswordInput(form) {
    return firstInput(form, "input[type='password']");
  }

  function findUsernameInput(form) {
    return firstInput(form, "input[autocomplete='username'],input[type='email'],input[type='text'],input:not([type])");
  }

  function findOtpInput(form) {
    return firstInput(form, "input[autocomplete='one-time-code'],input[name*='otp' i],input[id*='otp' i],input[name*='code' i],input[id*='code' i]");
  }

  function firstInput(form, selector) {
    var root = form || document;
    return root.querySelector(selector);
  }

  function findInputByAutocomplete(value) {
    return document.querySelector("input[autocomplete='" + value + "']");
  }

  function findInputByTokens(tokens) {
    var inputs = Array.prototype.slice.call(document.querySelectorAll("input, textarea, select"));
    return inputs.find(function (input) {
      var text = [
        input.autocomplete,
        input.name,
        input.id,
        input.getAttribute("aria-label"),
        input.placeholder
      ].join(" ").toLowerCase();
      return tokens.some(function (token) { return text.indexOf(token.toLowerCase()) >= 0; });
    });
  }

  function setNativeValue(input, value) {
    if (!input) return;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickProviderButton(provider) {
    var providerName = String(provider || "").toLowerCase();
    var candidates = Array.prototype.slice.call(document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']"));
    var hit = candidates.find(function (node) {
      return detectFederatedProvider(node) === providerName;
    });
    if (!hit) return false;
    hit.click();
    return true;
  }

  function detectFederatedProvider(target) {
    var node = target && target.closest ? target.closest("button,a,[role='button'],input[type='button'],input[type='submit']") : null;
    if (!node) return "";
    var text = [
      node.textContent,
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.value,
      node.href
    ].join(" ").toLowerCase();
    if (!/(sign|log|continue|connect|with|oauth|sso|github|google|apple|microsoft|facebook|gitlab|twitter|x\\.com)/.test(text)) return "";
    if (/google|gmail/.test(text)) return "google";
    if (/apple/.test(text)) return "apple";
    if (/microsoft|live\\.com|office|azure/.test(text)) return "microsoft";
    if (/github/.test(text)) return "github";
    if (/gitlab/.test(text)) return "gitlab";
    if (/facebook/.test(text)) return "facebook";
    if (/twitter|x\\.com/.test(text)) return "twitter";
    return "";
  }

  function isFillableInput(input) {
    if (!input || !input.matches) return false;
    if (!input.matches("input, textarea")) return false;
    var type = (input.getAttribute("type") || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(type);
  }

  function classifyInput(input) {
    var text = [
      input.autocomplete,
      input.name,
      input.id,
      input.getAttribute("aria-label"),
      input.placeholder,
      input.type
    ].join(" ").toLowerCase();
    if (/password|username|email|login|one-time-code|otp|code/.test(text)) return "login";
    if (/cc-|card|cvc|cvv|expir/.test(text)) return "card";
    if (/address|name|phone|tel|postal|zip|city|country|organization/.test(text)) return "identity";
    return "other";
  }

  function subtitleForItem(item) {
    if (item.fields && item.fields.providerLogin) return "Continue with " + item.fields.providerLogin;
    if (item.type === "login") return item.username || (item.urls || [])[0] || "";
    if (item.type === "credit_card") return "Card ending " + String((item.fields || {}).number || "").slice(-4);
    if (item.type === "identity") return (item.fields || {}).email || (item.fields || {}).phone || "";
    return (item.urls || [])[0] || "";
  }

  function labelForType(type) {
    return type === "credit_card" ? "Card" : type === "identity" ? "ID" : type === "passkey" ? "Passkey" : "Login";
  }
})();

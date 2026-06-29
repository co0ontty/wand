import { generatePassword } from "../shared/password-tools.mjs";
import { pageTitleFallback } from "../shared/url-tools.mjs";

var state = {
  tab: null,
  items: [],
  report: null
};

var els = {
  statusText: document.getElementById("statusText"),
  lockedView: document.getElementById("lockedView"),
  mainView: document.getElementById("mainView"),
  optionsButton: document.getElementById("optionsButton"),
  siteToggleButton: document.getElementById("siteToggleButton"),
  openOptionsButton: document.getElementById("openOptionsButton"),
  searchInput: document.getElementById("searchInput"),
  itemsList: document.getElementById("itemsList"),
  passwordLength: document.getElementById("passwordLength"),
  passwordDigits: document.getElementById("passwordDigits"),
  passwordSymbols: document.getElementById("passwordSymbols"),
  generatedPassword: document.getElementById("generatedPassword"),
  copyGeneratedButton: document.getElementById("copyGeneratedButton"),
  generateButton: document.getElementById("generateButton"),
  newType: document.getElementById("newType"),
  newTitle: document.getElementById("newTitle"),
  newUsername: document.getElementById("newUsername"),
  newPassword: document.getElementById("newPassword"),
  newTotp: document.getElementById("newTotp"),
  typeFields: document.getElementById("typeFields"),
  newNotes: document.getElementById("newNotes"),
  saveNewButton: document.getElementById("saveNewButton"),
  securityReport: document.getElementById("securityReport")
};

init();

async function init() {
  bindEvents();
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs[0] || null;
  if (state.tab?.url) {
    els.newTitle.value = pageTitleFallback(state.tab.url);
  }
  await loadStatus();
}

function bindEvents() {
  els.optionsButton.addEventListener("click", openOptions);
  els.siteToggleButton.addEventListener("click", toggleSite);
  els.openOptionsButton.addEventListener("click", openOptions);
  els.searchInput.addEventListener("input", debounce(loadItems, 180));
  els.generateButton.addEventListener("click", generateIntoField);
  els.copyGeneratedButton.addEventListener("click", function () {
    copyText(els.generatedPassword.value);
  });
  els.saveNewButton.addEventListener("click", saveNewLogin);
  els.newType.addEventListener("change", renderTypeFields);
  document.querySelectorAll(".tab").forEach(function (button) {
    button.addEventListener("click", function () {
      activateView(button.dataset.view);
    });
  });
  renderTypeFields();
}

async function loadStatus() {
  var response = await send({ type: "status" });
  if (!response.ok) {
    els.statusText.textContent = "Locked";
    els.lockedView.classList.remove("hidden");
    els.mainView.classList.add("hidden");
    return;
  }
  els.statusText.textContent = "Connected";
  els.lockedView.classList.add("hidden");
  els.mainView.classList.remove("hidden");
  await updateSiteToggle();
  generateIntoField();
  await Promise.all([loadItems(), loadSecurityReport()]);
}

async function loadItems() {
  var q = els.searchInput.value.trim();
  var response = await send({
    type: "search-items",
    q,
    url: q ? "" : state.tab?.url,
    limit: 30
  });
  if (!response.ok) {
    renderError(els.itemsList, response.error);
    return;
  }
  state.items = response.items || [];
  renderItems();
}

function renderItems() {
  els.itemsList.innerHTML = "";
  if (!state.items.length) {
    renderEmpty(els.itemsList, "No matching items.");
    return;
  }
  state.items.forEach(function (item) {
    var node = document.createElement("article");
    node.className = "item";
    node.innerHTML = [
      "<div class='item-head'>",
      "<div><div class='item-title'></div><div class='item-subtitle'></div></div>",
      "<span class='pill'></span>",
      "</div>",
      "<div class='actions'>",
      "<button type='button' data-action='fill'>Fill</button>",
      "<button type='button' data-action='open'>Open</button>",
      "<button type='button' data-action='copy-user'>User</button>",
      "<button type='button' data-action='copy-pass'>Password</button>",
      "</div>"
    ].join("");
    node.querySelector(".item-title").textContent = item.title || "Untitled";
    node.querySelector(".item-subtitle").textContent = subtitle(item);
    node.querySelector(".pill").textContent = label(item.type);
    node.querySelector("[data-action='fill']").addEventListener("click", function () {
      send({ type: "fill-active-tab", item });
      window.close();
    });
    node.querySelector("[data-action='open']").addEventListener("click", function () {
      send({ type: "open-and-fill", item });
      window.close();
    });
    node.querySelector("[data-action='copy-user']").addEventListener("click", function () {
      copyText(item.username || "");
    });
    node.querySelector("[data-action='copy-pass']").addEventListener("click", function () {
      copyText(item.password || "");
    });
    els.itemsList.appendChild(node);
  });
}

function generateIntoField() {
  var password = generatePassword({
    length: Number(els.passwordLength.value),
    digits: els.passwordDigits.checked,
    symbols: els.passwordSymbols.checked
  });
  els.generatedPassword.value = password;
}

async function saveNewLogin() {
  var type = els.newType.value;
  var fields = {};
  if (type === "login" && els.newTotp.value.trim()) fields.totpSecret = els.newTotp.value.trim();
  readDynamicFields(fields);
  var response = await send({
    type: "create-item",
    item: {
      type,
      title: els.newTitle.value.trim() || pageTitleFallback(state.tab?.url || ""),
      username: type === "login" ? els.newUsername.value.trim() : fields.email || fields.cardholder || fields.name || "",
      password: type === "login" ? els.newPassword.value : "",
      urls: state.tab?.url ? [state.tab.url] : [],
      notes: els.newNotes.value.trim(),
      fields,
      tags: ["browser-extension"]
    }
  });
  if (!response.ok) {
    renderError(els.itemsList, response.error);
    return;
  }
  els.newUsername.value = "";
  els.newPassword.value = "";
  els.newTotp.value = "";
  els.newNotes.value = "";
  renderTypeFields();
  activateView("suggestions");
  await loadItems();
}

function renderTypeFields() {
  var type = els.newType.value;
  document.querySelectorAll(".new-login").forEach(function (node) {
    node.classList.toggle("hidden", type !== "login");
  });
  var fields = [];
  if (type === "credit_card") {
    fields = [
      ["cardholder", "Cardholder"],
      ["number", "Card Number"],
      ["expMonth", "Expiry Month"],
      ["expYear", "Expiry Year"],
      ["cvc", "CVC"],
      ["billingAddress", "Billing Address"]
    ];
  } else if (type === "identity") {
    fields = [
      ["name", "Full Name"],
      ["email", "Email"],
      ["phone", "Phone"],
      ["organization", "Organization"],
      ["address", "Address"],
      ["city", "City"],
      ["state", "State"],
      ["postalCode", "Postal Code"],
      ["country", "Country"]
    ];
  } else if (type === "passkey") {
    fields = [
      ["relyingPartyId", "Relying Party ID"],
      ["credentialId", "Credential ID"],
      ["userHandle", "User Handle"]
    ];
  }
  els.typeFields.innerHTML = "";
  fields.forEach(function (field) {
    var label = document.createElement("label");
    label.className = "field";
    label.innerHTML = "<span></span><input type='text' data-field=''>";
    label.querySelector("span").textContent = field[1];
    label.querySelector("input").dataset.field = field[0];
    els.typeFields.appendChild(label);
  });
}

function readDynamicFields(fields) {
  els.typeFields.querySelectorAll("[data-field]").forEach(function (input) {
    if (input.value.trim()) fields[input.dataset.field] = input.value.trim();
  });
}

async function updateSiteToggle() {
  if (!state.tab?.url) return;
  var response = await send({ type: "site-settings", url: state.tab.url });
  if (response.ok) {
    els.siteToggleButton.textContent = response.disabled ? "Enable Site" : "Disable Site";
  }
}

async function toggleSite() {
  if (!state.tab?.url) return;
  var response = await send({ type: "toggle-site-disabled", url: state.tab.url });
  if (response.ok) {
    els.siteToggleButton.textContent = response.disabled ? "Enable Site" : "Disable Site";
  }
}

async function loadSecurityReport() {
  var response = await send({ type: "security-report" });
  if (!response.ok) {
    renderError(els.securityReport, response.error);
    return;
  }
  state.report = response.report;
  renderSecurityReport();
}

function renderSecurityReport() {
  var report = state.report;
  if (!report) return;
  els.securityReport.innerHTML = "";
  [
    ["Items", report.totalItems],
    ["Weak", report.weakPasswords],
    ["Reused", report.reusedPasswords],
    ["Missing URLs", report.missingUrls]
  ].forEach(function (metric) {
    var node = document.createElement("div");
    node.className = "metric";
    node.innerHTML = "<strong></strong><span></span>";
    node.querySelector("strong").textContent = String(metric[1]);
    node.querySelector("span").textContent = metric[0];
    els.securityReport.appendChild(node);
  });
  (report.issues || []).slice(0, 5).forEach(function (issue) {
    var node = document.createElement("div");
    node.className = "issue";
    node.innerHTML = "<strong></strong><p></p>";
    node.querySelector("strong").textContent = issue.title;
    node.querySelector("p").textContent = issue.message;
    els.securityReport.appendChild(node);
  });
}

function activateView(view) {
  document.querySelectorAll(".tab").forEach(function (button) {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach(function (section) {
    section.classList.toggle("active", section.id === view + "View");
  });
  if (view === "security") loadSecurityReport();
}

function subtitle(item) {
  if (item.fields && item.fields.providerLogin) return "Continue with " + item.fields.providerLogin;
  if (item.type === "login") return item.username || (item.urls || [])[0] || "";
  if (item.type === "credit_card") return "Card ending " + String((item.fields || {}).number || "").slice(-4);
  if (item.type === "identity") return (item.fields || {}).email || (item.fields || {}).phone || "";
  return (item.urls || [])[0] || "";
}

function label(type) {
  return type === "credit_card" ? "Card" : type === "identity" ? "Identity" : type === "passkey" ? "Passkey" : "Login";
}

function renderEmpty(root, message) {
  root.innerHTML = "";
  var node = document.createElement("div");
  node.className = "empty";
  node.textContent = message;
  root.appendChild(node);
}

function renderError(root, message) {
  root.innerHTML = "";
  var node = document.createElement("div");
  node.className = "error";
  node.textContent = message || "Something went wrong.";
  root.appendChild(node);
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard.writeText(value);
}

function openOptions() {
  chrome.runtime.openOptionsPage();
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function debounce(fn, ms) {
  var timer = 0;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

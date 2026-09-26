// SellPoint Admin — মূল অ্যাপ্লিকেশন লজিক।
// একটাই ফাইলে রাখা হয়েছে (বিল্ড টুল ছাড়া চালানোর সুবিধার জন্য), কিন্তু বিভাগ অনুযায়ী
// স্পষ্টভাবে ভাগ করা: Auth, Router, Dashboard, Licenses, Transactions, App Config, Settings।

import {
  auth, db,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, onSnapshot,
  serverTimestamp,
} from "./firebase-init.js";

import {
  generateLicenseKey, generateWebhookSecret,
  formatWhen, formatTaka, escapeHtml, downloadCsv, toast,
} from "./utils.js";

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════

const loginScreen = document.getElementById("loginScreen");
const appShell = document.getElementById("appShell");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");

let unsubscribers = []; // পেজ পাল্টালে/লগআউট করলে সব লাইভ listener বন্ধ করার জন্য

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  loginBtn.disabled = true;
  loginBtn.textContent = "Signing in…";
  loginError.classList.remove("login-error--visible");

  try {
    // Firebase Authentication (Email/Password) — Spark (ফ্রি) প্ল্যানেই কাজ করে, কোনো
    // Cloud Function লাগে না। কে admin panel-এর ডেটা অ্যাক্সেস পাবে সেটা ঠিক হয় Firestore
    // Rules-এ (isAdmin() — request.auth.token.email একটা অনুমোদিত তালিকায় আছে কিনা)।
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged নিচে UI দেখাবে
  } catch (err) {
    loginError.textContent = friendlyAuthError(err);
    loginError.classList.add("login-error--visible");
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign in";
  }
});

function friendlyAuthError(err) {
  const code = err && err.code;
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "Incorrect email or password.";
  }
  if (code === "auth/invalid-email") return "Enter a valid email address.";
  if (code === "auth/too-many-requests") return "Too many attempts. Try again in a few minutes.";
  if (code === "auth/user-disabled") return "This admin account has been disabled.";
  return "Couldn't sign in. Check your connection and try again.";
}

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  // Firebase Auth-এ সাইন-ইন থাকা মানেই admin panel-এর UI দেখানো হয় — কিন্তু এটা শুধু UX,
  // আসল সুরক্ষা Firestore Rules-এ (isAdmin() — user.email একটা অনুমোদিত তালিকায় আছে কিনা)।
  // তালিকায় না থাকা কেউ সাইন-ইন করলেও UI দেখবে কিন্তু কোনো ডেটা পড়তে/লিখতে পারবে না —
  // Firestore থেকে "permission-denied" আসবে, সেটা প্রতিটা fetch/listener-এর catch/error
  // হ্যান্ডলারে toast হিসেবে দেখানো হয়।
  const signedIn = !!(user && user.uid);
  if (signedIn) {
    loginScreen.style.display = "none";
    appShell.classList.add("app-shell--visible");
    document.getElementById("loginPassword").value = "";
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign in";
    const who = document.querySelector(".sidebar-footer .who");
    if (who) who.textContent = user.email || "Signed in";
    startApp();
  } else {
    loginScreen.style.display = "flex";
    appShell.classList.remove("app-shell--visible");
    stopAllListeners();
  }
});

function stopAllListeners() {
  unsubscribers.forEach((fn) => { try { fn(); } catch (_) {} });
  unsubscribers = [];
}

let appStarted = false;
function startApp() {
  if (appStarted) return; // onAuthStateChanged একাধিকবার fire করতে পারে — একবারই init
  appStarted = true;
  initRouter();
  initDashboard();
  initLicenses();
  initTransactions();
  initAppConfig();
  initSettings();
}

// ════════════════════════════════════════════════════════════════
// ROUTER — সহজ শো/হাইড, কোনো ভারী framework ছাড়া
// ════════════════════════════════════════════════════════════════

const navItems = document.querySelectorAll(".nav-item");
const pages = document.querySelectorAll(".page");

function initRouter() {
  navItems.forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });
}

function showPage(name) {
  navItems.forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  pages.forEach((p) => p.classList.toggle("page--active", p.id === "page-" + name));
  if (name === "dashboard") refreshDashboard();
}

// ════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════

let allLicensesCache = []; // licenses.js পপুলেট করে, dashboard ও transaction filter dropdown দুটোই ব্যবহার করে

function initDashboard() {
  refreshDashboard();
}

async function refreshDashboard() {
  const statsEl = document.getElementById("dashStats");
  const attentionBody = document.querySelector("#dashAttentionTable tbody");

  try {
    const snap = await getDocs(collection(db, "licenses"));
    const licenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const total = licenses.length;
    const active = licenses.filter((l) => l.active === true).length;
    const online = licenses.filter((l) => l.isOnline === true).length;

    const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;
    const now = Date.now();
    const attention = licenses
      .filter((l) => l.active === true)
      .map((l) => {
        const lastSeenMs = toMillisLocal(l.lastSeen);
        const stale = lastSeenMs != null && now - lastSeenMs > OFFLINE_THRESHOLD_MS;
        return { ...l, stale, lastSeenMs };
      })
      .filter((l) => l.stale)
      .sort((a, b) => (a.lastSeenMs || 0) - (b.lastSeenMs || 0))
      .slice(0, 8);

    statsEl.innerHTML = `
      <div class="stat-card">
        <div class="label">Total licenses</div>
        <div class="value">${total}</div>
      </div>
      <div class="stat-card">
        <div class="label">Active</div>
        <div class="value brand">${active}</div>
        <div class="sub">${total - active} inactive</div>
      </div>
      <div class="stat-card">
        <div class="label">Online now</div>
        <div class="value brand">${online}</div>
        <div class="sub">Heartbeat within the last few minutes</div>
      </div>
      <div class="stat-card">
        <div class="label">Needs attention</div>
        <div class="value ${attention.length ? "warn" : ""}">${licenses.filter((l) => l.active && !l.isOnline).length}</div>
        <div class="sub">Active but offline &gt;15 min</div>
      </div>
    `;

    if (attention.length === 0) {
      attentionBody.innerHTML = `<tr><td colspan="3" class="table-empty">All active devices are online. Nothing needs attention.</td></tr>`;
    } else {
      attentionBody.innerHTML = attention.map((l) => `
        <tr>
          <td>${escapeHtml(l.clientName || l.id)}</td>
          <td><span class="badge badge--warn">Offline</span></td>
          <td>${formatWhen(l.lastSeen)}</td>
        </tr>
      `).join("");
    }
  } catch (err) {
    statsEl.innerHTML = `<div class="skeleton">Couldn't load stats: ${escapeHtml(err.message)}</div>`;
  }
}

function toMillisLocal(value) {
  if (value == null) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return null;
}

// ════════════════════════════════════════════════════════════════
// LICENSES
// ════════════════════════════════════════════════════════════════

const licensesTableBody = document.querySelector("#licensesTable tbody");
const licenseSearch = document.getElementById("licenseSearch");
const licenseFilter = document.getElementById("licenseFilter");
const licenseCountEl = document.getElementById("licenseCount");

function initLicenses() {
  const unsub = onSnapshot(collection(db, "licenses"), (snap) => {
    allLicensesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLicensesTable();
    populateTxnLicenseFilter();
  }, (err) => {
    licensesTableBody.innerHTML = `<tr><td colspan="5" class="table-empty">Couldn't load licenses: ${escapeHtml(err.message)}</td></tr>`;
  });
  unsubscribers.push(unsub);

  licenseSearch.addEventListener("input", renderLicensesTable);
  licenseFilter.addEventListener("change", renderLicensesTable);

  document.getElementById("newLicenseBtn").addEventListener("click", () => openLicenseModal(null));
  document.getElementById("licenseModalClose").addEventListener("click", closeLicenseModal);
  document.getElementById("licenseModalCancel").addEventListener("click", closeLicenseModal);
  document.getElementById("licenseModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "licenseModalBackdrop") closeLicenseModal();
  });
}

function renderLicensesTable() {
  const term = licenseSearch.value.trim().toLowerCase();
  const filter = licenseFilter.value;

  let rows = allLicensesCache;
  if (term) {
    rows = rows.filter((l) =>
      (l.clientName || "").toLowerCase().includes(term) || l.id.toLowerCase().includes(term)
    );
  }
  if (filter === "active") rows = rows.filter((l) => l.active === true);
  if (filter === "inactive") rows = rows.filter((l) => l.active !== true);
  if (filter === "online") rows = rows.filter((l) => l.isOnline === true);

  rows = [...rows].sort((a, b) => (a.clientName || a.id).localeCompare(b.clientName || b.id));

  licenseCountEl.textContent = `${rows.length} of ${allLicensesCache.length}`;

  if (rows.length === 0) {
    licensesTableBody.innerHTML = `<tr><td colspan="5" class="table-empty">No licenses match.</td></tr>`;
    return;
  }

  licensesTableBody.innerHTML = rows.map((l) => `
    <tr data-id="${escapeHtml(l.id)}">
      <td>${escapeHtml(l.clientName || "(unnamed)")}</td>
      <td class="mono">${escapeHtml(l.id)}</td>
      <td>${licenseStatusBadge(l)}</td>
      <td>${escapeHtml(l.boundDeviceModel || "Not bound")}</td>
      <td>${formatWhen(l.lastSeen)}</td>
    </tr>
  `).join("");

  licensesTableBody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const license = allLicensesCache.find((l) => l.id === tr.dataset.id);
      if (license) openLicenseModal(license);
    });
  });
}

function licenseStatusBadge(l) {
  if (l.active !== true) return `<span class="badge badge--neutral">Inactive</span>`;
  if (l.isOnline === true) return `<span class="badge badge--ok">Online</span>`;
  return `<span class="badge badge--warn">Offline</span>`;
}

// ── License editor মোডাল ──

const licenseModalBackdrop = document.getElementById("licenseModalBackdrop");
const licenseModalTitle = document.getElementById("licenseModalTitle");
const licenseModalKey = document.getElementById("licenseModalKey");
const licenseModalBody = document.getElementById("licenseModalBody");
const licenseModalSave = document.getElementById("licenseModalSave");
const deleteLicenseBtn = document.getElementById("deleteLicenseBtn");

let editingLicenseId = null; // null = নতুন license তৈরি করা হচ্ছে
let editingRules = [];       // customSenderRules-এর কার্যকরী কপি (মোডাল বন্ধ না করা পর্যন্ত)

function openLicenseModal(license) {
  editingLicenseId = license ? license.id : null;
  editingRules = license && Array.isArray(license.customSenderRules)
    ? license.customSenderRules.map((r) => ({ ...r }))
    : [];

  const isNew = !license;
  licenseModalTitle.textContent = isNew ? "New license" : (license.clientName || "Edit license");
  licenseModalKey.textContent = isNew ? "A new key will be generated on save" : license.id;
  deleteLicenseBtn.style.display = isNew ? "none" : "inline-flex";
  licenseModalSave.textContent = isNew ? "Create license" : "Save changes";

  const l = license || {};

  licenseModalBody.innerHTML = `
    <div class="section-title">Merchant</div>
    <div class="form-grid">
      <div class="field span-2">
        <label for="fClientName">Business name</label>
        <input type="text" id="fClientName" value="${escapeHtml(l.clientName || "")}" placeholder="e.g. Karim's Shop" />
      </div>
      <div class="field">
        <label>Active</label>
        <label class="switch" style="margin-top:4px;">
          <input type="checkbox" id="fActive" ${l.active === true ? "checked" : ""} />
          <span class="track"></span>
        </label>
      </div>
    </div>

    <div class="section-title">Device binding</div>
    ${isNew ? `<div class="field-hint">The first phone to activate this key will be bound automatically.</div>` : `
      <div class="field-row"><span class="fr-label">Bound device</span><span class="fr-value">${escapeHtml(l.boundDeviceModel || "Not bound")}</span></div>
      <div class="field-row"><span class="fr-label">Bound since</span><span class="fr-value">${formatWhen(l.boundAt)}</span></div>
      ${l.boundDeviceId ? `<button type="button" class="btn btn--ghost btn--sm" id="resetBindingBtn" style="margin-top:8px;">Reset device binding</button>` : ""}
    `}

    <div class="section-title">Webhook</div>
    <div class="form-grid">
      <div class="field span-2">
        <label for="fWebhookUrl">Webhook URL</label>
        <input type="url" id="fWebhookUrl" value="${escapeHtml(l.webhookUrl || "")}" placeholder="https://yourserver.com/webhook" />
      </div>
      <div class="field span-2">
        <label for="fWebhookSecret">Signing secret</label>
        <div class="copy-row">
          <code id="fWebhookSecret">${escapeHtml(l.webhookSecret || "(not set — falls back to license key)")}</code>
          <button type="button" class="btn btn--ghost btn--sm" id="regenSecretBtn">Generate new</button>
        </div>
        <div class="field-hint">Used to sign the X-DinGet-Signature header. Regenerating invalidates the old one immediately.</div>
      </div>
    </div>

    <div class="section-title">Offline alerts</div>
    <div class="form-grid">
      <div class="field">
        <label for="fTelegramChatId">Telegram chat ID</label>
        <input type="text" id="fTelegramChatId" value="${escapeHtml(l.telegramChatId || "")}" placeholder="Optional" />
      </div>
      <div class="field">
        <label for="fAlertEmail">Alert email</label>
        <input type="email" id="fAlertEmail" value="${escapeHtml(l.alertEmail || "")}" placeholder="Optional" />
      </div>
      <div class="field span-2">
        <label for="fOfflineMinutes">Offline threshold (minutes)</label>
        <input type="number" id="fOfflineMinutes" min="1" value="${l.offlineAlertMinutes || 15}" />
      </div>
    </div>

    <div class="section-title">Custom sender rules</div>
    <div id="ruleList"></div>
    <button type="button" class="btn btn--ghost btn--sm" id="addRuleBtn">Add rule</button>
  `;

  renderRuleList();

  document.getElementById("regenSecretBtn").addEventListener("click", () => {
    document.getElementById("fWebhookSecret").textContent = generateWebhookSecret();
  });
  document.getElementById("addRuleBtn").addEventListener("click", () => {
    editingRules.push({ senderKeyword: "", methodLabel: "", trxIdRegex: "", amountRegex: "" });
    renderRuleList();
  });
  const resetBtn = document.getElementById("resetBindingBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (!confirm("Clear the device binding? The next phone to activate this key will be bound.")) return;
      try {
        await updateDoc(doc(db, "licenses", editingLicenseId), {
          boundDeviceId: "", boundDeviceModel: "", boundAt: null,
        });
        toast("Device binding cleared", "success");
        closeLicenseModal();
      } catch (err) {
        toast("Couldn't reset binding: " + err.message, "error");
      }
    });
  }

  licenseModalBackdrop.classList.add("modal-backdrop--visible");
}

function renderRuleList() {
  const container = document.getElementById("ruleList");
  if (editingRules.length === 0) {
    container.innerHTML = `<div class="field-hint" style="margin-bottom:10px;">No custom rules — only bKash/Nagad/Rocket/upay SMS are parsed.</div>`;
    return;
  }
  container.innerHTML = editingRules.map((r, i) => `
    <div class="rule-card" data-idx="${i}">
      <div class="rule-head">
        <span>Rule ${i + 1}</span>
        <button type="button" class="btn btn--ghost btn--sm remove-rule-btn" data-idx="${i}">Remove</button>
      </div>
      <div class="rule-grid">
        <div class="field">
          <label>Sender keyword</label>
          <input type="text" class="rule-field" data-idx="${i}" data-key="senderKeyword" value="${escapeHtml(r.senderKeyword || "")}" placeholder="e.g. citybank" />
        </div>
        <div class="field">
          <label>Method label</label>
          <input type="text" class="rule-field" data-idx="${i}" data-key="methodLabel" value="${escapeHtml(r.methodLabel || "")}" placeholder="e.g. City Bank" />
        </div>
        <div class="field span-2">
          <label>TrxID regex (1 capture group)</label>
          <input type="text" class="rule-field" data-idx="${i}" data-key="trxIdRegex" value="${escapeHtml(r.trxIdRegex || "")}" placeholder="e.g. Ref:\\s*([A-Z0-9]+)" />
        </div>
        <div class="field span-2">
          <label>Amount regex (1 capture group)</label>
          <input type="text" class="rule-field" data-idx="${i}" data-key="amountRegex" value="${escapeHtml(r.amountRegex || "")}" placeholder="e.g. Tk\\.?\\s*([0-9,]+\\.?[0-9]*)" />
        </div>
      </div>
      <div class="tester-box">
        <div class="field">
          <label>Test with a real SMS</label>
          <textarea class="rule-tester-input" data-idx="${i}" placeholder="Paste a sample SMS here to check the regex…"></textarea>
        </div>
        <div class="tester-result" data-idx="${i}"></div>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".rule-field").forEach((input) => {
    input.addEventListener("input", () => {
      const idx = Number(input.dataset.idx);
      editingRules[idx][input.dataset.key] = input.value;
    });
  });
  container.querySelectorAll(".remove-rule-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingRules.splice(Number(btn.dataset.idx), 1);
      renderRuleList();
    });
  });
  container.querySelectorAll(".rule-tester-input").forEach((textarea) => {
    textarea.addEventListener("input", () => runRuleTester(Number(textarea.dataset.idx), textarea.value));
  });
}

function runRuleTester(idx, sampleText) {
  const resultEl = document.querySelector(`.tester-result[data-idx="${idx}"]`);
  const rule = editingRules[idx];
  if (!sampleText.trim()) { resultEl.innerHTML = ""; return; }

  const trxId = tryExtract(rule.trxIdRegex, sampleText);
  const amount = tryExtract(rule.amountRegex, sampleText);

  resultEl.innerHTML = `
    <span class="${trxId.ok ? "ok" : "fail"}">TrxID: ${escapeHtml(trxId.value)}</span>
    <span class="${amount.ok ? "ok" : "fail"}">Amount: ${escapeHtml(amount.value)}</span>
  `;
}

/** merchant-এর SmsReceiver.java-তে যেভাবে regex চলে (find + group(1)) হুবহু সেভাবেই — যাতে
 *  টেস্টার আর আসল অ্যাপের ফলাফল কখনো আলাদা না হয় */
function tryExtract(pattern, text) {
  if (!pattern || !pattern.trim()) return { ok: false, value: "(no regex set)" };
  try {
    const re = new RegExp(pattern, "i");
    const m = re.exec(text);
    if (m && m[1] != null) return { ok: true, value: m[1].trim() };
    return { ok: false, value: "No match" };
  } catch (err) {
    return { ok: false, value: "Invalid regex: " + err.message };
  }
}

function closeLicenseModal() {
  licenseModalBackdrop.classList.remove("modal-backdrop--visible");
  editingLicenseId = null;
  editingRules = [];
}

licenseModalSave.addEventListener("click", async () => {
  const clientName = document.getElementById("fClientName").value.trim();
  const active = document.getElementById("fActive").checked;
  const webhookUrl = document.getElementById("fWebhookUrl").value.trim();
  const webhookSecretText = document.getElementById("fWebhookSecret").textContent.trim();
  const webhookSecret = webhookSecretText.startsWith("(") ? "" : webhookSecretText;
  const telegramChatId = document.getElementById("fTelegramChatId").value.trim();
  const alertEmail = document.getElementById("fAlertEmail").value.trim();
  const offlineAlertMinutes = Number(document.getElementById("fOfflineMinutes").value) || 15;

  const cleanRules = editingRules
    .filter((r) => r.senderKeyword && r.senderKeyword.trim())
    .map((r) => ({
      senderKeyword: r.senderKeyword.trim(),
      methodLabel: (r.methodLabel || "Other").trim(),
      trxIdRegex: (r.trxIdRegex || "").trim(),
      amountRegex: (r.amountRegex || "").trim(),
    }));

  const payload = {
    clientName, active, webhookUrl, webhookSecret,
    telegramChatId, alertEmail, offlineAlertMinutes,
    customSenderRules: cleanRules,
  };

  licenseModalSave.disabled = true;
  licenseModalSave.textContent = "Saving…";

  try {
    if (editingLicenseId) {
      await updateDoc(doc(db, "licenses", editingLicenseId), payload);
      toast("License updated", "success");
    } else {
      const newKey = generateLicenseKey();
      await setDoc(doc(db, "licenses", newKey), {
        ...payload,
        active: true,
        createdAt: serverTimestamp(),
        isOnline: false,
      });
      toast(`License created: ${newKey}`, "success");
    }
    closeLicenseModal();
  } catch (err) {
    toast("Couldn't save: " + err.message, "error");
  } finally {
    licenseModalSave.disabled = false;
    licenseModalSave.textContent = editingLicenseId ? "Save changes" : "Create license";
  }
});

deleteLicenseBtn.addEventListener("click", async () => {
  if (!editingLicenseId) return;
  if (!confirm(`Delete license ${editingLicenseId}? This cannot be undone. The merchant's transaction history is kept.`)) return;
  try {
    await deleteDoc(doc(db, "licenses", editingLicenseId));
    toast("License deleted", "success");
    closeLicenseModal();
  } catch (err) {
    toast("Couldn't delete: " + err.message, "error");
  }
});

function populateTxnLicenseFilter() {
  const select = document.getElementById("txnLicenseFilter");
  const current = select.value;
  const sorted = [...allLicensesCache].sort((a, b) => (a.clientName || a.id).localeCompare(b.clientName || b.id));
  select.innerHTML = `<option value="">All merchants</option>` +
    sorted.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.clientName || l.id)}</option>`).join("");
  select.value = current;
}

// ════════════════════════════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════════════════════════════

const PAGE_SIZE = 50;
let txnLastDoc = null;
let txnAllLoaded = [];

function initTransactions() {
  document.getElementById("txnLicenseFilter").addEventListener("change", reloadTransactions);
  document.getElementById("txnMethodFilter").addEventListener("change", reloadTransactions);
  document.getElementById("txnFlagFilter").addEventListener("change", reloadTransactions);
  document.getElementById("loadMoreTxnBtn").addEventListener("click", () => loadTransactionsPage(true));
  document.getElementById("exportCsvBtn").addEventListener("click", exportTransactionsCsv);

  reloadTransactions();
}

function currentTxnFilters() {
  return {
    clientId: document.getElementById("txnLicenseFilter").value,
    method: document.getElementById("txnMethodFilter").value,
    flag: document.getElementById("txnFlagFilter").value,
  };
}

function reloadTransactions() {
  txnLastDoc = null;
  txnAllLoaded = [];
  loadTransactionsPage(false);
}

async function loadTransactionsPage(append) {
  const tbody = document.querySelector("#transactionsTable tbody");
  const loadMoreBtn = document.getElementById("loadMoreTxnBtn");
  if (!append) tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Loading…</td></tr>`;

  const filters = currentTxnFilters();

  try {
    // Firestore-এ query constraints যেকোনো ক্রমে দেওয়া যায় (SDK নিজে সাজিয়ে নেয়),
    // তাই এখানে জটিল insert-position হিসাব করার দরকার নেই।
    // নোট: clientId + method দুটো ফিল্টার একসাথে ব্যবহার করলে (timestamp দিয়ে সাজানোর সাথে)
    // Firestore একটা composite index চাইতে পারে — প্রথমবার এরকম ফিল্টার করলে Firestore
    // Console-এ একটা লিংক আসবে (browser console-এও দেখা যায়) যেটাতে ক্লিক করলেই index
    // তৈরি হয়ে যায়, কোনো কোড বদলাতে হয় না।
    const clauses = [orderBy("timestamp", "desc"), limit(PAGE_SIZE)];
    if (filters.clientId) clauses.push(where("clientId", "==", filters.clientId));
    if (filters.method) clauses.push(where("method", "==", filters.method));
    if (txnLastDoc) clauses.push(startAfter(txnLastDoc));

    const q = query(collection(db, "transactions"), ...clauses);
    const snap = await getDocs(q);

    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (filters.flag === "mismatch") rows = rows.filter((r) => r.balanceStatus === "mismatch");
    if (filters.flag === "recovered") rows = rows.filter((r) => r.recovered === true);

    txnLastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : txnLastDoc;
    txnAllLoaded = append ? [...txnAllLoaded, ...rows] : rows;

    renderTransactionsTable(txnAllLoaded);
    loadMoreBtn.style.display = snap.docs.length === PAGE_SIZE ? "inline-flex" : "none";
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">Couldn't load transactions: ${escapeHtml(err.message)}</td></tr>`;
    loadMoreBtn.style.display = "none";
  }
}

function renderTransactionsTable(rows) {
  const tbody = document.querySelector("#transactionsTable tbody");
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty">No transactions match.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((t) => {
    const flags = [];
    if (t.balanceStatus === "mismatch") flags.push(`<span class="badge badge--error">Balance mismatch</span>`);
    if (t.recovered === true) flags.push(`<span class="badge badge--neutral">Recovered</span>`);
    if (t.manual === true) flags.push(`<span class="badge badge--neutral">Manual</span>`);
    return `
      <tr>
        <td>${formatWhen(t.timestamp)}</td>
        <td>${escapeHtml(t.clientName || t.clientId || "")}</td>
        <td>${escapeHtml(t.method || "")}</td>
        <td>${formatTaka(t.amount)}</td>
        <td class="mono">${escapeHtml(t.trxID || t.id)}</td>
        <td>${flags.join(" ") || "—"}</td>
      </tr>
    `;
  }).join("");
}

function exportTransactionsCsv() {
  if (txnAllLoaded.length === 0) {
    toast("Nothing loaded to export yet", "error");
    return;
  }
  const header = ["Time", "Merchant", "Method", "Amount", "TrxID", "Sender", "Balance status", "Recovered"];
  const rows = txnAllLoaded.map((t) => [
    formatWhen(t.timestamp),
    t.clientName || t.clientId || "",
    t.method || "",
    t.amount != null ? t.amount : "",
    t.trxID || t.id,
    t.sender || "",
    t.balanceStatus || "",
    t.recovered ? "yes" : "no",
  ]);
  downloadCsv(`sellpoint-transactions-${Date.now()}.csv`, [header, ...rows]);
  toast(`Exported ${rows.length} rows`, "success");
}

// ════════════════════════════════════════════════════════════════
// APP CONFIG (app_config/version)
// ════════════════════════════════════════════════════════════════

function initAppConfig() {
  loadAppConfig();
  document.getElementById("appConfigForm").addEventListener("submit", saveAppConfig);
}

async function loadAppConfig() {
  try {
    const snap = await getDoc(doc(db, "app_config", "version"));
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById("cfgVersionCode").value = d.latestVersionCode || "";
      document.getElementById("cfgUpdateUrl").value = d.updateUrl || "";
      document.getElementById("cfgReleaseNotes").value = d.releaseNotes || "";
      document.getElementById("cfgForceUpdate").value = d.forceUpdate ? "true" : "false";
    }
  } catch (err) {
    toast("Couldn't load app config: " + err.message, "error");
  }
}

async function saveAppConfig(e) {
  e.preventDefault();
  const btn = document.getElementById("saveAppConfigBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    await setDoc(doc(db, "app_config", "version"), {
      latestVersionCode: Number(document.getElementById("cfgVersionCode").value),
      updateUrl: document.getElementById("cfgUpdateUrl").value.trim(),
      releaseNotes: document.getElementById("cfgReleaseNotes").value.trim(),
      forceUpdate: document.getElementById("cfgForceUpdate").value === "true",
    }, { merge: true });
    toast("App config saved", "success");
  } catch (err) {
    toast("Couldn't save: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save changes";
  }
}

// ════════════════════════════════════════════════════════════════
// SETTINGS — পাসওয়ার্ড বদলানো
// ════════════════════════════════════════════════════════════════

function initSettings() {
  document.getElementById("changePasswordForm").addEventListener("submit", changePassword);
}

async function changePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;

  if (newPassword !== confirmPassword) {
    toast("New passwords don't match", "error");
    return;
  }
  if (newPassword.length < 8) {
    toast("New password must be at least 8 characters", "error");
    return;
  }

  const btn = document.getElementById("changePasswordBtn");
  btn.disabled = true;
  btn.textContent = "Updating…";

  try {
    // Firebase Auth চায় সম্প্রতি sign-in করা থাকতে হবে পাসওয়ার্ড বদলানোর আগে (security
    // measure) — তাই আগে বর্তমান পাসওয়ার্ড দিয়ে reauthenticate করা হয়, তারপর updatePassword
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error("Not signed in");
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPassword);
    toast("Password updated", "success");
    document.getElementById("changePasswordForm").reset();
  } catch (err) {
    const code = err && err.code;
    let message = "Couldn't update password";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
      message = "Current password is incorrect";
    } else if (code === "auth/weak-password") {
      message = "Password is too weak";
    } else if (err.message) {
      message = err.message;
    }
    toast(message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Update password";
  }
}

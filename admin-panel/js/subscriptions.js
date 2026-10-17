
// SellPoint Admin — সাবস্ক্রিপশন: প্ল্যান তৈরি/এডিট, ট্রায়াল ও সেটিংস, ডিভাইসে প্ল্যান দেওয়া (grant),
// আয়ের হিসাব। app.js থেকে initSubscriptions() একবার কল হয়।
//
// ডেটা (Firestore — ডেভেলপারের নিজের প্রজেক্টে, দেখুন firestore.rules):
//   subscription_plans/{id}          name, price(৳), days, active, sortOrder, description
//   subscription_settings/config     required, trialDays, contactUrl
//   subscriptions/{deviceId}         kind(trial|active), plan, expiresAt, lastGrantAt
//   subscription_payments/{autoId}   device, planId, plan, days, amount, method, trxId, note, grantedAt

import {
  db,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, onSnapshot, serverTimestamp,
} from "./firebase-init.js";
import { escapeHtml, toast, toMillis } from "./utils.js";

const DAY_MS = 86_400_000;

// ── ছোট সহায়ক ──
const $ = (id) => document.getElementById(id);

function fmtDate(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtTaka(n) {
  const v = Number(n) || 0;
  return "\u09F3" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** ইউজার ABCD-1234-... লিখুক বা পেস্ট করুক — অ্যাপ যে ফরম্যাটে সার্ভারে পাঠায় (বড় হাতের, ড্যাশ ছাড়া) */
export function normalizeDeviceId(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function prettyDeviceId(id) {
  return String(id).replace(/(.{4})(?=.)/g, "$1-");
}

function slugify(name) {
  const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "plan") + "-" + Math.random().toString(36).slice(2, 6);
}

/** একটা সাবস্ক্রিপশন ডকের বর্তমান অবস্থা: trial | active | expired */
export function subscriptionState(sub, now = Date.now()) {
  const exp = toMillis(sub && sub.expiresAt);
  if (exp == null || exp <= now) return "expired";
  return sub.kind === "trial" ? "trial" : "active";
}

/** চালু মেয়াদ থাকলে তার শেষ থেকে, নইলে এখন থেকে — আগে নবায়ন করলে দিন নষ্ট হয় না */
export function computeNewExpiry(currentExpiryMs, days, now = Date.now()) {
  const base = Math.max(now, currentExpiryMs || 0);
  return base + days * DAY_MS;
}

// ── স্টেট ──
let plansCache = [];
let subsCache = [];
let paymentsCache = [];
let settingsCache = { required: false, trialDays: 7, contactUrl: "" };

let editingPlanId = null;
let grantTargetId = null;

export function initSubscriptions(unsubscribers) {
  bindPlanUi();
  bindGrantUi();
  bindSettingsForm();

  unsubscribers.push(onSnapshot(collection(db, "subscription_plans"), (snap) => {
    plansCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlans();
    fillGrantPlanSelect();
  }, (err) => {
    $("plansTableBody").innerHTML = `<tr><td colspan="6" class="table-empty">Couldn't load plans: ${escapeHtml(err.message)}</td></tr>`;
  }));

  unsubscribers.push(onSnapshot(doc(db, "subscription_settings", "config"), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      settingsCache = {
        required: d.required === true,
        trialDays: Number.isFinite(d.trialDays) ? d.trialDays : 7,
        contactUrl: d.contactUrl || "",
      };
    }
    renderSettings();
  }, () => { /* rules deploy না হলে পেজ নিজেই ত্রুটি দেখাবে */ }));

  unsubscribers.push(onSnapshot(collection(db, "subscriptions"), (snap) => {
    subsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSubscriptions();
  }, (err) => {
    $("subsTableBody").innerHTML = `<tr><td colspan="5" class="table-empty">Couldn't load subscriptions: ${escapeHtml(err.message)}</td></tr>`;
  }));

  unsubscribers.push(onSnapshot(
    query(collection(db, "subscription_payments"), orderBy("grantedAt", "desc"), limit(200)),
    (snap) => {
      paymentsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderPayments();
      renderSubscriptions(); // আয়ের কার্ড আপডেট
    },
    () => {}
  ));
}

// ════════════════════════════════════════════════════════════════
// SETTINGS (সাবস্ক্রিপশন চালু/বন্ধ, ট্রায়াল, যোগাযোগ)
// ════════════════════════════════════════════════════════════════

function bindSettingsForm() {
  $("subSettingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const trialDays = Math.round(Number($("setTrialDays").value));
    if (!(trialDays >= 0 && trialDays <= 31)) {
      toast("Trial days must be between 0 and 31", "error");
      return;
    }
    const contactUrl = $("setContactUrl").value.trim();
    if (contactUrl && !/^https?:\/\//i.test(contactUrl)) {
      toast("Contact link must start with https://", "error");
      return;
    }
    const required = $("setRequired").checked;
    if (required && plansCache.filter((p) => p.active !== false).length === 0) {
      if (!confirm("You have no active plans yet. Users whose trial ends won't be able to buy anything. Turn subscriptions on anyway?")) return;
    }

    const btn = $("saveSubSettingsBtn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await setDoc(doc(db, "subscription_settings", "config"), { required, trialDays, contactUrl });
      toast("Subscription settings saved", "success");
    } catch (err) {
      toast("Couldn't save: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save settings";
    }
  });
}

function renderSettings() {
  $("setRequired").checked = settingsCache.required;
  $("setTrialDays").value = settingsCache.trialDays;
  $("setContactUrl").value = settingsCache.contactUrl;
  $("subRequiredHint").textContent = settingsCache.required
    ? "ON — users need a trial or a plan. When it ends, new payments are saved on the phone but not uploaded."
    : "OFF — everyone uses the app for free. Turn this on only after you've created your plans.";
}

// ════════════════════════════════════════════════════════════════
// PLANS
// ════════════════════════════════════════════════════════════════

function bindPlanUi() {
  $("newPlanBtn").addEventListener("click", () => openPlanModal(null));
  $("planModalClose").addEventListener("click", closePlanModal);
  $("planModalCancel").addEventListener("click", closePlanModal);
  $("planModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "planModalBackdrop") closePlanModal();
  });
  $("planModalSave").addEventListener("click", savePlan);
  $("deletePlanBtn").addEventListener("click", deletePlan);
}

function sortedPlans() {
  return [...plansCache].sort((a, b) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.days ?? 0) - (b.days ?? 0));
}

function renderPlans() {
  const body = $("plansTableBody");
  const rows = sortedPlans();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty">No plans yet. Click “New plan” to create your first one.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((p) => `
    <tr data-id="${escapeHtml(p.id)}">
      <td>${escapeHtml(p.name || "(unnamed)")}${p.description ? `<div style="font-size:11.5px;color:var(--ink-soft);">${escapeHtml(p.description)}</div>` : ""}</td>
      <td>${fmtTaka(p.price)}</td>
      <td>${Number(p.days) || 0} days</td>
      <td>${p.active === false ? `<span class="badge badge--neutral">Hidden</span>` : `<span class="badge badge--ok">On sale</span>`}</td>
      <td>${p.sortOrder ?? 0}</td>
      <td class="mono">${escapeHtml(p.id)}</td>
    </tr>`).join("");
  body.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const plan = plansCache.find((p) => p.id === tr.dataset.id);
      if (plan) openPlanModal(plan);
    });
  });
}

function openPlanModal(plan) {
  editingPlanId = plan ? plan.id : null;
  const p = plan || { name: "", price: "", days: 30, active: true, sortOrder: plansCache.length + 1, description: "" };
  $("planModalTitle").textContent = plan ? (plan.name || "Edit plan") : "New plan";
  $("planModalSub").textContent = plan ? plan.id : "A plan ID is generated on save";
  $("deletePlanBtn").style.display = plan ? "inline-flex" : "none";
  $("planModalSave").textContent = plan ? "Save changes" : "Create plan";

  $("planModalBody").innerHTML = `
    <div class="form-grid">
      <div class="field span-2">
        <label for="pName">Plan name</label>
        <input type="text" id="pName" maxlength="40" value="${escapeHtml(p.name)}" placeholder="e.g. Monthly" />
      </div>
      <div class="field">
        <label for="pPrice">Price (৳)</label>
        <input type="number" id="pPrice" min="0" step="1" value="${p.price === "" ? "" : escapeHtml(p.price)}" placeholder="299" />
      </div>
      <div class="field">
        <label for="pDays">Duration (days)</label>
        <input type="number" id="pDays" min="1" max="3650" step="1" value="${escapeHtml(p.days)}" />
      </div>
      <div class="field">
        <label for="pOrder">Display order</label>
        <input type="number" id="pOrder" step="1" value="${escapeHtml(p.sortOrder ?? 0)}" />
      </div>
      <div class="field">
        <label>On sale</label>
        <label class="switch" style="margin-top:4px;">
          <input type="checkbox" id="pActive" ${p.active === false ? "" : "checked"} />
          <span class="track"></span>
        </label>
      </div>
      <div class="field span-2">
        <label for="pDesc">Short note (optional)</label>
        <input type="text" id="pDesc" maxlength="80" value="${escapeHtml(p.description || "")}" placeholder="e.g. Best value" />
      </div>
    </div>
    <div class="field-hint">Changing a price or duration doesn't affect plans people already bought — it applies to future purchases only.</div>`;

  $("planModalBackdrop").classList.add("modal-backdrop--visible");
}

function closePlanModal() {
  $("planModalBackdrop").classList.remove("modal-backdrop--visible");
  editingPlanId = null;
}

async function savePlan() {
  const name = $("pName").value.trim();
  const price = Number($("pPrice").value);
  const days = Math.round(Number($("pDays").value));
  const sortOrder = Math.round(Number($("pOrder").value)) || 0;
  const active = $("pActive").checked;
  const description = $("pDesc").value.trim();

  if (!name) return toast("Enter a plan name", "error");
  if (!(price >= 0) || $("pPrice").value === "") return toast("Enter a valid price", "error");
  if (!(days >= 1 && days <= 3650)) return toast("Duration must be 1–3650 days", "error");

  const btn = $("planModalSave");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const id = editingPlanId || slugify(name);
    await setDoc(doc(db, "subscription_plans", id), { name, price, days, active, sortOrder, description });
    toast(editingPlanId ? "Plan updated" : "Plan created", "success");
    closePlanModal();
  } catch (err) {
    toast("Couldn't save plan: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function deletePlan() {
  if (!editingPlanId) return;
  if (!confirm("Delete this plan? People who already bought it keep their remaining time. To just stop selling it, switch “On sale” off instead.")) return;
  try {
    await deleteDoc(doc(db, "subscription_plans", editingPlanId));
    toast("Plan deleted", "success");
    closePlanModal();
  } catch (err) {
    toast("Couldn't delete: " + err.message, "error");
  }
}

// ════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS (ডিভাইস অনুযায়ী) + GRANT
// ════════════════════════════════════════════════════════════════

function bindGrantUi() {
  $("subSearch").addEventListener("input", renderSubscriptions);
  $("subFilter").addEventListener("change", renderSubscriptions);
  $("grantPlanBtn").addEventListener("click", () => openGrantModal(null));
  $("grantModalClose").addEventListener("click", closeGrantModal);
  $("grantModalCancel").addEventListener("click", closeGrantModal);
  $("grantModalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "grantModalBackdrop") closeGrantModal();
  });
  $("grantModalSave").addEventListener("click", saveGrant);
  $("revokeBtn").addEventListener("click", revokeSubscription);
}

function monthStartMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function renderSubscriptions() {
  const now = Date.now();
  const counts = { active: 0, trial: 0, expired: 0 };
  subsCache.forEach((s) => { counts[subscriptionState(s, now)]++; });

  const monthStart = monthStartMs();
  const monthRevenue = paymentsCache
    .filter((p) => (toMillis(p.grantedAt) || 0) >= monthStart)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  $("subStats").innerHTML = `
    <div class="stat-card"><div class="label">Paid & active</div><div class="value brand">${counts.active}</div></div>
    <div class="stat-card"><div class="label">On free trial</div><div class="value">${counts.trial}</div></div>
    <div class="stat-card"><div class="label">Expired</div><div class="value ${counts.expired ? "warn" : ""}">${counts.expired}</div><div class="sub">Trial ended or plan ran out</div></div>
    <div class="stat-card"><div class="label">Revenue this month</div><div class="value brand">${fmtTaka(monthRevenue)}</div></div>`;

  const term = normalizeDeviceId($("subSearch").value);
  const filter = $("subFilter").value;

  let rows = subsCache.map((s) => ({ ...s, state: subscriptionState(s, now), expMs: toMillis(s.expiresAt) }));
  if (term) rows = rows.filter((s) => s.id.includes(term));
  if (filter !== "all") rows = rows.filter((s) => s.state === filter);
  rows.sort((a, b) => (b.expMs || 0) - (a.expMs || 0));

  $("subCount").textContent = `${rows.length} of ${subsCache.length}`;

  const body = $("subsTableBody");
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="table-empty">${subsCache.length ? "No subscriptions match." : "No phones have checked in yet."}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((s) => {
    const badge = s.state === "active" ? `<span class="badge badge--ok">Active</span>`
      : s.state === "trial" ? `<span class="badge badge--warn">Trial</span>`
      : `<span class="badge badge--error">Expired</span>`;
    const left = s.state === "expired" ? "—" : Math.ceil((s.expMs - now) / DAY_MS) + " days";
    return `
      <tr data-id="${escapeHtml(s.id)}">
        <td class="mono">${escapeHtml(prettyDeviceId(s.id))}</td>
        <td>${escapeHtml(s.plan || "—")}</td>
        <td>${badge}</td>
        <td>${fmtDate(s.expMs)}</td>
        <td>${left}</td>
      </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openGrantModal(tr.dataset.id));
  });
}

function renderPayments() {
  const body = $("paymentsTableBody");
  if (paymentsCache.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty">No plan sales recorded yet.</td></tr>`;
    return;
  }
  body.innerHTML = paymentsCache.slice(0, 30).map((p) => `
    <tr>
      <td>${fmtDate(toMillis(p.grantedAt))}</td>
      <td class="mono">${escapeHtml(prettyDeviceId(p.device || ""))}</td>
      <td>${escapeHtml(p.plan || "—")} <span style="color:var(--ink-soft);">· ${Number(p.days) || 0}d</span></td>
      <td>${fmtTaka(p.amount)}</td>
      <td>${escapeHtml(p.method || "—")}</td>
      <td class="mono">${escapeHtml(p.trxId || "—")}</td>
    </tr>`).join("");
}

function fillGrantPlanSelect() {
  const sel = $("gPlan");
  if (!sel) return;
  const keep = sel.value;
  const active = sortedPlans().filter((p) => p.active !== false);
  sel.innerHTML = active.map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} — ${fmtTaka(p.price)} / ${Number(p.days) || 0}d</option>`
  ).join("") + `<option value="__custom">Custom days (gift / compensation)…</option>`;
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  syncGrantForm();
}

function syncGrantForm() {
  const sel = $("gPlan");
  if (!sel) return;
  const custom = sel.value === "__custom";
  $("gCustomRow").style.display = custom ? "grid" : "none";
  if (!custom) {
    const plan = plansCache.find((p) => p.id === sel.value);
    if (plan && document.activeElement !== $("gAmount")) $("gAmount").value = plan.price ?? "";
  } else if (document.activeElement !== $("gAmount")) {
    $("gAmount").value = 0;
  }
}

function openGrantModal(deviceId) {
  grantTargetId = deviceId;
  const sub = deviceId ? subsCache.find((s) => s.id === deviceId) : null;
  const now = Date.now();

  $("grantModalTitle").textContent = deviceId ? "Add time to this phone" : "Grant a plan";
  $("grantModalSub").textContent = sub
    ? `${subscriptionState(sub, now).toUpperCase()} · ${sub.plan || ""} · until ${fmtDate(toMillis(sub.expiresAt))}`
    : "Enter the Subscription ID the customer sent you";
  $("revokeBtn").style.display = sub ? "inline-flex" : "none";

  $("gDevice").value = deviceId ? prettyDeviceId(deviceId) : "";
  $("gDevice").readOnly = !!deviceId;
  $("gTrx").value = "";
  $("gNote").value = "";
  $("gDays").value = 30;
  $("gCustomName").value = "Gift";
  fillGrantPlanSelect();
  syncGrantForm();
  $("gPlan").onchange = () => { $("gAmount").value = ""; syncGrantForm(); };

  $("grantModalBackdrop").classList.add("modal-backdrop--visible");
}

function closeGrantModal() {
  $("grantModalBackdrop").classList.remove("modal-backdrop--visible");
  grantTargetId = null;
}

async function saveGrant() {
  const device = normalizeDeviceId($("gDevice").value);
  if (device.length < 8 || device.length > 32) return toast("Enter a valid Subscription ID", "error");

  const planId = $("gPlan").value;
  let planName, days;
  if (planId === "__custom") {
    days = Math.round(Number($("gDays").value));
    planName = $("gCustomName").value.trim() || "Custom";
    if (!(days >= 1 && days <= 3650)) return toast("Days must be 1–3650", "error");
  } else {
    const plan = plansCache.find((p) => p.id === planId);
    if (!plan) return toast("Pick a plan (create one in the Plans page first)", "error");
    planName = plan.name;
    days = Number(plan.days);
  }
  const amount = Number($("gAmount").value) || 0;
  const method = $("gMethod").value;
  const trxId = $("gTrx").value.trim();
  const note = $("gNote").value.trim();

  // একই TrxID দিয়ে দুইবার প্ল্যান দেওয়া ঠেকানো — ভুল করে দুইবার চাপলে/একই পেমেন্ট দুজনের নামে
  if (trxId && paymentsCache.some((p) => (p.trxId || "").toLowerCase() === trxId.toLowerCase())) {
    if (!confirm(`TrxID ${trxId} was already used for another plan sale. Grant again anyway?`)) return;
  }

  const btn = $("grantModalSave");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const ref = doc(db, "subscriptions", device);
    const snap = await getDoc(ref);
    const current = snap.exists() ? toMillis(snap.data().expiresAt) : 0;
    const expiresAt = new Date(computeNewExpiry(current, days));

    await setDoc(ref, { kind: "active", plan: planName, expiresAt, lastGrantAt: serverTimestamp() });
    await addDoc(collection(db, "subscription_payments"), {
      device, planId: planId === "__custom" ? "" : planId, plan: planName, days, amount,
      method, trxId, note, grantedAt: serverTimestamp(),
    });
    toast(`${planName} added — valid until ${fmtDate(expiresAt.getTime())}`, "success");
    closeGrantModal();
  } catch (err) {
    toast("Couldn't save: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Grant plan";
  }
}

async function revokeSubscription() {
  if (!grantTargetId) return;
  if (!confirm("End this phone's plan right now? Its new payments will stay on the phone until you grant a plan again.")) return;
  try {
    await updateDoc(doc(db, "subscriptions", grantTargetId), { expiresAt: new Date(Date.now() - 1000) });
    toast("Plan ended", "success");
    closeGrantModal();
  } catch (err) {
    toast("Couldn't revoke: " + err.message, "error");
  }
}

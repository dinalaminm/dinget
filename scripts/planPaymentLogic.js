"use strict";
/**
 * প্ল্যান কেনার পেমেন্ট যাচাইয়ের লজিক — pure ফাংশন (Firestore/নেটওয়ার্ক ছাড়া), তাই টেস্ট করা যায়।
 *
 * কাস্টমার অ্যাপে প্ল্যান বেছে TrxID আর যে নম্বর থেকে টাকা পাঠিয়েছে সেটা দেয় (একটা "claim")।
 * আপনার নিজের ফোনের SellPoint ওই পেমেন্টের SMS ধরে transactions/{trxId}-এ রেখেছে।
 * এই লজিক ঠিক করে: claim মিলল (approve), মিলল না (reject, কারণসহ), নাকি SMS এখনো আসেনি (wait)।
 */

const DAY_MS = 86_400_000;

/** ডিফল্ট: SMS না আসা পর্যন্ত কতক্ষণ অপেক্ষা (এর পরে "not_found" বলে reject) */
const DEFAULT_WAIT_MS = 2 * 60 * 60 * 1000;
/** ডিফল্ট: এর চেয়ে পুরনো পেমেন্ট দিয়ে প্ল্যান নেওয়া যাবে না (অন্য কারণে আসা পুরনো TrxID ঠেকাতে) */
const DEFAULT_MAX_TX_AGE_MS = 3 * DAY_MS;

function normalizeTrx(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** শেষ ১০ সংখ্যা — 01712345678, +8801712345678, 8801712345678 সবই এক */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function phonesMatch(a, b) {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return x.length >= 10 && x === y;
}

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

/** চালু মেয়াদ থাকলে তার শেষ থেকে, নইলে এখন থেকে */
function computeNewExpiry(currentExpiryMs, days, nowMs) {
  const base = Math.max(nowMs, currentExpiryMs || 0);
  return base + days * DAY_MS;
}

/**
 * @param {object} p
 * @param {{trxId:string, phone:string, planId:string, submittedAtMs:number}} p.claim
 * @param {{price:number, days:number, active?:boolean}|null} p.plan
 * @param {{amount:number, customerNumber?:string, timestamp?:any}|null} p.tx  transactions/{trxId} (না পেলে null)
 * @param {boolean} p.alreadyUsed  এই TrxID আগেই কোনো প্ল্যানের জন্য ব্যবহার হয়েছে কিনা
 * @param {number} p.nowMs
 * @returns {{action:"approve"|"reject"|"wait", reason?:string}}
 */
function evaluateClaim({ claim, plan, tx, alreadyUsed, nowMs, waitMs = DEFAULT_WAIT_MS, maxTxAgeMs = DEFAULT_MAX_TX_AGE_MS }) {
  if (!plan || plan.active === false) return { action: "reject", reason: "plan_missing" };
  if (alreadyUsed) return { action: "reject", reason: "already_used" };

  if (!tx) {
    // SMS দেরিতে আসতে পারে (ফোন অফলাইন ছিল ইত্যাদি) — কিছুক্ষণ অপেক্ষা করি
    const waited = nowMs - (claim.submittedAtMs || nowMs);
    return waited >= waitMs ? { action: "reject", reason: "not_found" } : { action: "wait" };
  }

  if (!phonesMatch(claim.phone, tx.customerNumber)) return { action: "reject", reason: "phone_mismatch" };

  // কম টাকা পাঠালে প্ল্যান দেওয়া হবে না; বেশি পাঠালে ঠিক আছে
  if (!(Number(tx.amount) >= Number(plan.price))) return { action: "reject", reason: "amount_low" };

  const txMs = toMillis(tx.timestamp);
  if (txMs && nowMs - txMs > maxTxAgeMs) return { action: "reject", reason: "too_old" };

  return { action: "approve" };
}

module.exports = {
  DAY_MS, DEFAULT_WAIT_MS, DEFAULT_MAX_TX_AGE_MS,
  normalizeTrx, normalizePhone, phonesMatch, toMillis, computeNewExpiry, evaluateClaim,
};

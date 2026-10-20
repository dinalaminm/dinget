"use strict";
const test = require("node:test");
const assert = require("node:assert");
const L = require("./planPaymentLogic");

const NOW = 1_800_000_000_000;
const plan = { price: 100, days: 30, active: true };
const claim = { trxId: "ABC123", phone: "01712-345678", planId: "monthly", submittedAtMs: NOW - 60_000 };
const tx = { amount: 100, customerNumber: "01712345678", timestamp: NOW - 120_000 };

test("normalizeTrx / normalizePhone", () => {
  assert.equal(L.normalizeTrx(" abc-123 "), "ABC123");
  assert.equal(L.normalizePhone("+8801712345678"), "1712345678");
  assert.equal(L.normalizePhone("01712 345678"), "1712345678");
  assert.ok(L.phonesMatch("8801712345678", "01712345678"));
  assert.ok(!L.phonesMatch("01712345678", "01812345678"));
  assert.ok(!L.phonesMatch("123", "123")); // খুব ছোট নম্বর মিলানো হয় না
});

test("approve: সব মিললে", () => {
  assert.deepEqual(L.evaluateClaim({ claim, plan, tx, alreadyUsed: false, nowMs: NOW }), { action: "approve" });
});

test("approve: বেশি টাকা পাঠালেও", () => {
  assert.equal(L.evaluateClaim({ claim, plan, tx: { ...tx, amount: 500 }, alreadyUsed: false, nowMs: NOW }).action, "approve");
});

test("reject: কম টাকা", () => {
  const r = L.evaluateClaim({ claim, plan, tx: { ...tx, amount: 99 }, alreadyUsed: false, nowMs: NOW });
  assert.deepEqual(r, { action: "reject", reason: "amount_low" });
});

test("reject: অন্য নম্বর (অন্যের TrxID দিয়ে চেষ্টা)", () => {
  const r = L.evaluateClaim({ claim: { ...claim, phone: "01999999999" }, plan, tx, alreadyUsed: false, nowMs: NOW });
  assert.deepEqual(r, { action: "reject", reason: "phone_mismatch" });
});

test("reject: ইতিমধ্যে ব্যবহার হওয়া TrxID", () => {
  const r = L.evaluateClaim({ claim, plan, tx, alreadyUsed: true, nowMs: NOW });
  assert.deepEqual(r, { action: "reject", reason: "already_used" });
});

test("reject: পুরনো পেমেন্ট", () => {
  const old = { ...tx, timestamp: NOW - 4 * L.DAY_MS };
  assert.deepEqual(L.evaluateClaim({ claim, plan, tx: old, alreadyUsed: false, nowMs: NOW }), { action: "reject", reason: "too_old" });
});

test("reject: প্ল্যান নেই বা বন্ধ", () => {
  assert.equal(L.evaluateClaim({ claim, plan: null, tx, alreadyUsed: false, nowMs: NOW }).reason, "plan_missing");
  assert.equal(L.evaluateClaim({ claim, plan: { ...plan, active: false }, tx, alreadyUsed: false, nowMs: NOW }).reason, "plan_missing");
});

test("wait → not_found: SMS না এলে প্রথমে অপেক্ষা, পরে reject", () => {
  assert.deepEqual(L.evaluateClaim({ claim, plan, tx: null, alreadyUsed: false, nowMs: NOW }), { action: "wait" });
  const late = { ...claim, submittedAtMs: NOW - 3 * 60 * 60 * 1000 };
  assert.deepEqual(L.evaluateClaim({ claim: late, plan, tx: null, alreadyUsed: false, nowMs: NOW }), { action: "reject", reason: "not_found" });
});

test("computeNewExpiry: বাকি মেয়াদের পরে যোগ হয়, মেয়াদ শেষ হলে এখন থেকে", () => {
  assert.equal(L.computeNewExpiry(0, 30, NOW), NOW + 30 * L.DAY_MS);
  assert.equal(L.computeNewExpiry(NOW + 10 * L.DAY_MS, 30, NOW), NOW + 40 * L.DAY_MS);
  assert.equal(L.computeNewExpiry(NOW - 5 * L.DAY_MS, 30, NOW), NOW + 30 * L.DAY_MS);
});

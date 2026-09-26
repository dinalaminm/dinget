"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  selectLicensesNeedingAlert,
  selectRecoveredLicenses,
  formatOfflineMessage,
  formatRecoveryMessage,
  DEFAULT_OFFLINE_THRESHOLD_MINUTES,
} = require("./offlineAlertLogic");

const MIN = 60 * 1000;
const NOW = 10_000_000_000;

function lic(overrides) {
  return Object.assign(
    {
      id: "LIC1",
      active: true,
      isOnline: true,
      lastSeen: NOW - 2 * MIN,
      telegramChatId: "123456",
    },
    overrides
  );
}

test("device seen 2 min ago -> no alert", () => {
  const out = selectLicensesNeedingAlert([lic({})], NOW);
  assert.equal(out.length, 0);
});

test("device seen 20 min ago (default 15min threshold) -> alert", () => {
  const out = selectLicensesNeedingAlert([lic({ lastSeen: NOW - 20 * MIN })], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "LIC1");
});

test("custom offlineAlertMinutes respected", () => {
  // ৫ মিনিট থ্রেশহোল্ড কাস্টম করা, ৭ মিনিট আগে দেখা গেছে -> অ্যালার্ট
  let out = selectLicensesNeedingAlert([lic({ lastSeen: NOW - 7 * MIN, offlineAlertMinutes: 5 })], NOW);
  assert.equal(out.length, 1);
  // ৩০ মিনিট থ্রেশহোল্ড, ২০ মিনিট আগে -> এখনো অ্যালার্ট না
  out = selectLicensesNeedingAlert([lic({ lastSeen: NOW - 20 * MIN, offlineAlertMinutes: 30 })], NOW);
  assert.equal(out.length, 0);
});

test("inactive license never alerted", () => {
  const out = selectLicensesNeedingAlert([lic({ active: false, lastSeen: NOW - 999 * MIN })], NOW);
  assert.equal(out.length, 0);
});

test("no telegram or email -> skipped (nowhere to send)", () => {
  const out = selectLicensesNeedingAlert(
    [lic({ lastSeen: NOW - 999 * MIN, telegramChatId: undefined, alertEmail: undefined })],
    NOW
  );
  assert.equal(out.length, 0);
});

test("alertEmail alone is enough", () => {
  const out = selectLicensesNeedingAlert(
    [lic({ lastSeen: NOW - 999 * MIN, telegramChatId: undefined, alertEmail: "m@example.com" })],
    NOW
  );
  assert.equal(out.length, 1);
});

test("lastSeen never set (new setup) -> not flagged", () => {
  const out = selectLicensesNeedingAlert([lic({ lastSeen: null })], NOW);
  assert.equal(out.length, 0);
});

test("already alerted recently -> cooldown suppresses repeat", () => {
  const out = selectLicensesNeedingAlert(
    [lic({ lastSeen: NOW - 999 * MIN, lastOfflineAlertMillis: NOW - 10 * MIN })],
    NOW
  );
  assert.equal(out.length, 0);
});

test("alerted long ago -> cooldown passed, alerts again", () => {
  const out = selectLicensesNeedingAlert(
    [lic({ lastSeen: NOW - 999 * MIN, lastOfflineAlertMillis: NOW - 61 * MIN })],
    NOW
  );
  assert.equal(out.length, 1);
});

test("multiple licenses -> only the stale ones selected", () => {
  const licenses = [
    lic({ id: "A", lastSeen: NOW - 2 * MIN }),
    lic({ id: "B", lastSeen: NOW - 30 * MIN }),
    lic({ id: "C", lastSeen: NOW - 999 * MIN, active: false }),
    lic({ id: "D", lastSeen: NOW - 45 * MIN }),
  ];
  const out = selectLicensesNeedingAlert(licenses, NOW).map((l) => l.id);
  assert.deepEqual(out.sort(), ["B", "D"]);
});

// ── রিকভারি ──

test("recovered: was offline, lastSeen now fresh -> recovery message", () => {
  const out = selectRecoveredLicenses(
    [lic({ lastSeen: NOW - MIN, lastOfflineAlertMillis: NOW - 5 * MIN })],
    NOW
  );
  assert.equal(out.length, 1);
});

test("still offline -> not in recovered list", () => {
  const out = selectRecoveredLicenses(
    [lic({ lastSeen: NOW - 30 * MIN, lastOfflineAlertMillis: NOW - 40 * MIN })],
    NOW
  );
  assert.equal(out.length, 0);
});

test("never alerted -> nothing to recover from", () => {
  const out = selectRecoveredLicenses([lic({ lastSeen: NOW - MIN })], NOW);
  assert.equal(out.length, 0);
});

// ── মেসেজ ফরম্যাটিং ──

test("offline message includes client name and duration", () => {
  const msg = formatOfflineMessage(lic({ clientName: "Karim's Shop", lastSeen: NOW - 25 * MIN }), NOW);
  assert.match(msg, /Karim's Shop/);
  assert.match(msg, /25 minutes/);
});

test("offline message falls back to id when no clientName", () => {
  const msg = formatOfflineMessage(lic({ clientName: undefined, id: "DINGET-XYZ", lastSeen: NOW - 90 * MIN }), NOW);
  assert.match(msg, /DINGET-XYZ/);
  assert.match(msg, /1h 30m/);
});

test("recovery message includes client name", () => {
  const msg = formatRecoveryMessage(lic({ clientName: "Karim's Shop" }));
  assert.match(msg, /Karim's Shop/);
  assert.match(msg, /back online/);
});

test("default threshold constant is sane", () => {
  assert.equal(DEFAULT_OFFLINE_THRESHOLD_MINUTES, 15);
});

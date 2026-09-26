"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashPassword,
  verifyPassword,
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  MAX_ATTEMPTS_BEFORE_LOCKOUT,
} = require("./adminAuthLogic");

// ── হ্যাশিং ও যাচাই ──

test("correct password verifies", () => {
  const stored = hashPassword("MySecurePass123");
  assert.equal(verifyPassword("MySecurePass123", stored), true);
});

test("wrong password rejected", () => {
  const stored = hashPassword("MySecurePass123");
  assert.equal(verifyPassword("WrongPassword", stored), false);
});

test("same password hashed twice -> different salts, both verify", () => {
  const a = hashPassword("SamePassword1");
  const b = hashPassword("SamePassword1");
  assert.notEqual(a, b); // আলাদা salt থাকায় স্ট্রিং আলাদা হওয়ার কথা
  assert.equal(verifyPassword("SamePassword1", a), true);
  assert.equal(verifyPassword("SamePassword1", b), true);
});

test("empty/missing stored value -> always false (fail-closed, no default password)", () => {
  assert.equal(verifyPassword("admin123", ""), false);
  assert.equal(verifyPassword("admin123", undefined), false);
  assert.equal(verifyPassword("admin123", null), false);
});

test("malformed stored value -> false, not a crash", () => {
  assert.equal(verifyPassword("x", "not-a-valid-hash"), false);
  assert.equal(verifyPassword("x", "onlyonepart"), false);
  assert.equal(verifyPassword("x", "salt:not-hex-!!!"), false);
  assert.equal(verifyPassword("x", ":emptysalt"), false);
});

test("password too short to hash -> throws (caller must validate at set-time)", () => {
  assert.throws(() => hashPassword("short"));
});

test("non-string password input -> false, not a crash", () => {
  assert.equal(verifyPassword(12345, hashPassword("RealPassword1")), false);
  assert.equal(verifyPassword(null, hashPassword("RealPassword1")), false);
});

test("case sensitive", () => {
  const stored = hashPassword("CaseSensitive1");
  assert.equal(verifyPassword("casesensitive1", stored), false);
});

// ── রেট-লিমিট / লকআউট ──

const MIN = 60 * 1000;
const NOW = 10_000_000;

test("fresh state -> allowed", () => {
  const r = checkRateLimit({ failedAttempts: 0, lockedUntilMillis: 0 }, NOW);
  assert.equal(r.allowed, true);
});

test("few failed attempts -> still allowed (below threshold)", () => {
  let state = { failedAttempts: 0, lockedUntilMillis: 0 };
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT - 1; i++) {
    state = recordFailedAttempt(state, NOW);
  }
  const r = checkRateLimit(state, NOW);
  assert.equal(r.allowed, true);
  assert.equal(state.failedAttempts, MAX_ATTEMPTS_BEFORE_LOCKOUT - 1);
});

test("reaching MAX_ATTEMPTS -> locked out", () => {
  let state = { failedAttempts: 0, lockedUntilMillis: 0 };
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT; i++) {
    state = recordFailedAttempt(state, NOW);
  }
  const r = checkRateLimit(state, NOW + MIN);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterMillis > 0);
});

test("lockout expires after duration", () => {
  let state = { failedAttempts: 0, lockedUntilMillis: 0 };
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_LOCKOUT; i++) {
    state = recordFailedAttempt(state, NOW);
  }
  const r = checkRateLimit(state, NOW + 16 * MIN); // ১৫ মিনিট লকআউট পার হয়ে গেছে
  assert.equal(r.allowed, true);
});

test("successful login resets attempts", () => {
  let state = { failedAttempts: 3, lockedUntilMillis: 0 };
  state = recordSuccessfulAttempt();
  assert.equal(state.failedAttempts, 0);
  assert.equal(state.lockedUntilMillis, 0);
});

test("failed attempt counter does not reset itself between calls", () => {
  let state = { failedAttempts: 0, lockedUntilMillis: 0 };
  state = recordFailedAttempt(state, NOW);
  state = recordFailedAttempt(state, NOW + MIN);
  assert.equal(state.failedAttempts, 2);
});

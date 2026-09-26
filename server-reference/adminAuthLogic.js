"use strict";
/**
 * অ্যাডমিন পাসওয়ার্ড হ্যাশিং ও যাচাই — বিশুদ্ধ লজিক, কোনো Firebase/নেটওয়ার্ক নির্ভরতা নেই,
 * তাই প্লেইন Node.js-এ টেস্ট করা যায় (দেখুন adminAuthLogic.test.js)।
 *
 * আগে কী ছিল (FIREBASE_SETUP.md-এর পুরনো ভার্সন দেখুন): admin/settings ডকুমেন্টে পাসওয়ার্ড
 * প্লেইন টেক্সটে থাকত, আর ডকুমেন্ট না থাকলে ডিফল্ট "admin123" ধরে নেওয়া হতো (fail-open —
 * সেটআপ না করলে অ্যাডমিন প্যানেল একটা সুপরিচিত পাসওয়ার্ড দিয়ে খোলাই থেকে যেত)।
 *
 * এখন: পাসওয়ার্ড কখনো প্লেইন টেক্সটে সেভ হয় না — শুধু salted hash (scrypt, Node-এর
 * বিল্ট-ইন crypto, তাই কোনো নেটিভ ডিপেন্ডেন্সি লাগে না)। hash কনফিগার করা না থাকলে
 * লগইন fail-closed (অস্বীকৃত), fail-open না।
 */

const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

/** নতুন পাসওয়ার্ড সেট করার সময় — একবারই চলে, Firestore-এ সেভ করার জন্য "salt:hash" স্ট্রিং দেয় */
function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * লগইনের সময় যাচাই। storedValue হলো Firestore-এ সেভ থাকা "salt:hash" স্ট্রিং।
 * টাইমিং অ্যাটাক ঠেকাতে crypto.timingSafeEqual ব্যবহার করা হয়েছে (===-এর বদলে, কারণ ===
 * বাইট-বাই-বাইট তুলনা করে প্রথম অমিলেই থেমে যায়, যা থেকে টাইমিং দিয়ে পাসওয়ার্ড আন্দাজ করা
 * সম্ভব — খুবই কম ঝুঁকির হলেও এটা free protection)।
 *
 * storedValue ফাঁকা/না থাকলে সবসময় false — কোনো ডিফল্ট পাসওয়ার্ড fallback নেই (fail-closed)।
 */
function verifyPassword(password, storedValue) {
  if (typeof password !== "string" || typeof storedValue !== "string") return false;
  const parts = storedValue.split(":");
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  let expected;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false; // দৈর্ঘ্য না মিললে timingSafeEqual থ্রো করে
  }
}

// ── লগইন প্রচেষ্টা রেট-লিমিটিং (ব্রুট-ফোর্স ঠেকাতে) ──
// বিশুদ্ধ ফাংশন: বর্তমান অবস্থা + এখনকার সময় দিলে সিদ্ধান্ত দেয়, কোথাও state রাখে না —
// আসল state (কতবার fail হয়েছে) Firestore-এ রাখা হবে adminAuthFunctions.js থেকে।
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // ১৫ মিনিট

/**
 * @param state {failedAttempts: number, lockedUntilMillis: number}
 * @returns {allowed: boolean, retryAfterMillis: number}
 */
function checkRateLimit(state, nowMillis) {
  const lockedUntil = (state && state.lockedUntilMillis) || 0;
  if (lockedUntil > nowMillis) {
    return { allowed: false, retryAfterMillis: lockedUntil - nowMillis };
  }
  return { allowed: true, retryAfterMillis: 0 };
}

/** ব্যর্থ লগইনের পর নতুন state — MAX_ATTEMPTS পার হলে lockout শুরু হয় */
function recordFailedAttempt(state, nowMillis) {
  const failedAttempts = ((state && state.failedAttempts) || 0) + 1;
  if (failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCKOUT) {
    return { failedAttempts: 0, lockedUntilMillis: nowMillis + LOCKOUT_DURATION_MS };
  }
  return { failedAttempts, lockedUntilMillis: (state && state.lockedUntilMillis) || 0 };
}

/** সফল লগইনের পর state রিসেট */
function recordSuccessfulAttempt() {
  return { failedAttempts: 0, lockedUntilMillis: 0 };
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  MAX_ATTEMPTS_BEFORE_LOCKOUT,
  LOCKOUT_DURATION_MS,
};

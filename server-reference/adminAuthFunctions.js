"use strict";
/**
 * Firebase Cloud Function — অ্যাডমিন প্যানেল লগইন যাচাই, সম্পূর্ণ সার্ভার-সাইডে।
 *
 * আগে (দেখুন FIREBASE_SETUP.md-এর পুরনো ভার্সন) admin panel সরাসরি Firestore থেকে
 * admin/settings ডকুমেন্টের password ফিল্ড *পড়ত* এবং client-এর ব্রাউজারে সেটা টাইপ করা
 * পাসওয়ার্ডের সাথে তুলনা করত। এর মানে প্লেইন-টেক্সট পাসওয়ার্ডটা প্রতিবার client-এর কাছে
 * চলে যেত — ব্রাউজারের DevTools খুললেই দেখা যেত। এই ফাংশনটা সেই সমস্যা সমাধান করে:
 * পাসওয়ার্ড কখনো client-এ যায় না, তুলনাটা এখানেই (সার্ভারে) হয়, আর client শুধু
 * true/false এবং সফল হলে একটা সাইন-ইন টোকেন পায়।
 *
 * এই ফাইলটা ডিপ্লয় করার আগে:
 *   npm install firebase-functions firebase-admin
 *   node hashPassword.js "YourNewPassword" চালিয়ে hash বানিয়ে Firestore-এ
 *   admin/settings → passwordHash ফিল্ডে বসান (পুরনো plaintext "password" ফিল্ড মুছে ফেলুন)
 *
 * admin panel-এর ক্লায়েন্ট কোড আপডেট করতে হবে যাতে Firestore থেকে সরাসরি password field
 * পড়ার বদলে এই callable function কল করে:
 *   const result = await httpsCallable(functions, "adminLogin")({ password });
 *   if (result.data.token) await signInWithCustomToken(auth, result.data.token);
 * এরপর admin/settings-সহ যেকোনো admin-only Firestore path-এ Firestore Rules-এ
 * `request.auth.token.admin == true` চেক করে অ্যাক্সেস দেওয়া যাবে।
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {
  verifyPassword,
  hashPassword,
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
} = require("./adminAuthLogic");

if (!admin.apps.length) admin.initializeApp();

const RATE_LIMIT_DOC = admin.firestore().collection("admin").doc("loginRateLimit");
const SETTINGS_DOC = admin.firestore().collection("admin").doc("settings");

exports.adminLogin = functions.https.onCall(async (data) => {
  const password = data && data.password;
  if (typeof password !== "string" || password.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "Password is required");
  }

  const now = Date.now();

  // ── রেট-লিমিট চেক ──
  const rateLimitSnap = await RATE_LIMIT_DOC.get();
  const rateLimitState = rateLimitSnap.exists
    ? rateLimitSnap.data()
    : { failedAttempts: 0, lockedUntilMillis: 0 };

  const rl = checkRateLimit(rateLimitState, now);
  if (!rl.allowed) {
    const minutes = Math.ceil(rl.retryAfterMillis / 60000);
    throw new functions.https.HttpsError(
      "resource-exhausted",
      `Too many failed attempts. Try again in ${minutes} minute(s).`
    );
  }

  // ── পাসওয়ার্ড যাচাই ──
  const settingsSnap = await SETTINGS_DOC.get();
  const storedHash = settingsSnap.exists ? settingsSnap.data().passwordHash : null;

  if (!storedHash) {
    // fail-closed: hash কনফিগার করা না থাকলে কাউকেই ঢুকতে দেওয়া হবে না —
    // পুরনো "admin123" ডিফল্ট fallback এখানে ইচ্ছাকৃতভাবে নেই
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Admin password is not configured yet"
    );
  }

  const ok = verifyPassword(password, storedHash);

  if (!ok) {
    const newState = recordFailedAttempt(rateLimitState, now);
    await RATE_LIMIT_DOC.set(newState);
    throw new functions.https.HttpsError("permission-denied", "Incorrect password");
  }

  await RATE_LIMIT_DOC.set(recordSuccessfulAttempt());

  // সফল — admin কাস্টম ক্লেইমসহ একটা sign-in token দেওয়া হচ্ছে, যেটা দিয়ে client
  // signInWithCustomToken() করবে; এরপর Firestore Rules-এ request.auth.token.admin == true
  // চেক করে admin-only ডেটা অ্যাক্সেস দেওয়া যাবে
  const token = await admin.auth().createCustomToken("admin-panel", { admin: true });
  return { token };
});

/**
 * অ্যাডমিন প্যানেল থেকেই পাসওয়ার্ড বদলানো — লগইন করা থাকতে হবে (context.auth.token.admin)।
 * নতুন পাসওয়ার্ড এখানেই hash হয়ে Firestore-এ সেভ হয়, client কখনো plaintext ছাড়া hash
 * বানানোর চেষ্টা করে না (hashPassword() নিজেই Node-এর crypto ব্যবহার করে, সার্ভারেই থাকে)।
 */
exports.adminChangePassword = functions.https.onCall(async (data, context) => {
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError("permission-denied", "Admin login required");
  }

  const { currentPassword, newPassword } = data || {};
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "New password must be at least 8 characters"
    );
  }

  const settingsSnap = await SETTINGS_DOC.get();
  const storedHash = settingsSnap.exists ? settingsSnap.data().passwordHash : null;

  // hash আগে থেকেই সেট থাকলে (মানে এটা পাসওয়ার্ড বদলানো, প্রথমবার সেট করা না) —
  // পুরনো পাসওয়ার্ডও যাচাই করা হয়, যাতে admin session চুরি হলেও সাথে সাথেই পাসওয়ার্ড
  // বদলে অন্যকে লক-আউট করে দেওয়া না যায়
  if (storedHash) {
    if (typeof currentPassword !== "string" || !verifyPassword(currentPassword, storedHash)) {
      throw new functions.https.HttpsError("permission-denied", "Current password is incorrect");
    }
  }

  const newHash = hashPassword(newPassword);
  await SETTINGS_DOC.set({ passwordHash: newHash }, { merge: true });
  return { success: true };
});

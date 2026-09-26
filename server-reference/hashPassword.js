#!/usr/bin/env node
"use strict";
/**
 * অ্যাডমিন পাসওয়ার্ডের hash বানানোর ছোট CLI টুল।
 *
 * ব্যবহার:
 *   node hashPassword.js "YourNewPassword123"
 *
 * আউটপুট স্ট্রিংটা Firestore-এ admin/settings ডকুমেন্টের passwordHash ফিল্ডে বসান
 * (আগের প্লেইন-টেক্সট password ফিল্ডটা মুছে ফেলুন — README.md-এর ধাপ দেখুন)।
 */

const { hashPassword } = require("./adminAuthLogic");

const password = process.argv[2];
if (!password) {
  console.error("Usage: node hashPassword.js <new-password>");
  process.exit(1);
}

try {
  const hash = hashPassword(password);
  console.log("\nStore this value in Firestore: admin/settings → passwordHash\n");
  console.log(hash);
  console.log("");
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}

"use strict";
/**
 * অফলাইন অ্যালার্টের বিশুদ্ধ (pure) সিদ্ধান্ত-লজিক — Firebase/নেটওয়ার্কের কোনো নির্ভরতা নেই,
 * তাই প্লেইন Node.js-এ সহজে ইউনিট-টেস্ট করা যায় (দেখুন offlineAlertLogic.test.js)।
 *
 * ব্যবহার: এই মডিউলটা offlineAlertFunctions.js (আসল Cloud Function) থেকে ইমপোর্ট হয়।
 * এখানে কখনো Firestore/HTTP কল করবেন না — শুধু ডেটা ইন → সিদ্ধান্ত আউট।
 */

/** একটা license ডকুমেন্টের প্রাসঙ্গিক ফিল্ডগুলো (Firestore থেকে .data() করার পর) */
// {
//   active: boolean,
//   isOnline: boolean,
//   lastSeen: number (millis) | null,
//   offlineAlertMinutes: number | undefined,   // merchant/অ্যাডমিন কনফিগার করতে পারবে, ডিফল্ট নিচে
//   lastOfflineAlertMillis: number | undefined, // সর্বশেষ কবে অ্যালার্ট পাঠানো হয়েছিল
//   telegramChatId: string | undefined,
//   alertEmail: string | undefined,
//   clientName: string | undefined,
// }

const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 15;
const ALERT_COOLDOWN_MINUTES = 60; // একই লাইসেন্সকে আবার অ্যালার্ট পাঠানোর আগে অন্তত এতক্ষণ অপেক্ষা

/**
 * এই মুহূর্তে যেসব লাইসেন্স "নতুন করে অফলাইন" বলে অ্যালার্টের যোগ্য তাদের বেছে নেয়।
 * শর্ত: active, lastSeen থ্রেশহোল্ডের চেয়ে পুরনো, এবং (কখনো অ্যালার্ট হয়নি বা কুলডাউন পার হয়ে গেছে)।
 * telegramChatId/alertEmail কোনোটাই না থাকা লাইসেন্স বাদ যায় — পাঠানোর কোনো মাধ্যমই নেই।
 */
function selectLicensesNeedingAlert(licenses, nowMillis) {
  const out = [];
  for (const lic of licenses) {
    if (!lic.active) continue;
    if (!lic.telegramChatId && !lic.alertEmail) continue;

    const lastSeen = typeof lic.lastSeen === "number" ? lic.lastSeen : 0;
    if (lastSeen === 0) continue; // কখনো একবারও অনলাইন হয়নি — এটা "নতুন সেটআপ", অফলাইন অ্যালার্ম না

    const thresholdMs = (lic.offlineAlertMinutes || DEFAULT_OFFLINE_THRESHOLD_MINUTES) * 60 * 1000;
    if (nowMillis - lastSeen < thresholdMs) continue; // এখনো থ্রেশহোল্ডের মধ্যে, সমস্যা না

    const lastAlert = typeof lic.lastOfflineAlertMillis === "number" ? lic.lastOfflineAlertMillis : 0;
    const cooldownMs = ALERT_COOLDOWN_MINUTES * 60 * 1000;
    if (lastAlert > 0 && nowMillis - lastAlert < cooldownMs) continue; // সম্প্রতি অলরেডি অ্যালার্ট গেছে

    out.push(lic);
  }
  return out;
}

/**
 * যেসব লাইসেন্স আগে অফলাইন অ্যালার্ট পেয়েছিল কিন্তু এখন আবার lastSeen সাম্প্রতিক (ফিরে এসেছে) —
 * তাদের জন্য একটা "ফিরে এসেছে" মেসেজ পাঠানো হয়, এবং lastOfflineAlertMillis রিসেট হয়।
 */
function selectRecoveredLicenses(licenses, nowMillis) {
  const out = [];
  for (const lic of licenses) {
    if (!lic.active) continue;
    if (!lic.telegramChatId && !lic.alertEmail) continue;

    const lastAlert = typeof lic.lastOfflineAlertMillis === "number" ? lic.lastOfflineAlertMillis : 0;
    if (lastAlert === 0) continue; // আগে অ্যালার্ট হয়ইনি, রিকভারিরও প্রশ্ন নেই

    const lastSeen = typeof lic.lastSeen === "number" ? lic.lastSeen : 0;
    const thresholdMs = (lic.offlineAlertMinutes || DEFAULT_OFFLINE_THRESHOLD_MINUTES) * 60 * 1000;
    if (lastSeen === 0 || nowMillis - lastSeen >= thresholdMs) continue; // এখনো অফলাইনই আছে

    out.push(lic);
  }
  return out;
}

function formatMinutesAgo(millisAgo) {
  const minutes = Math.max(1, Math.round(millisAgo / 60000));
  if (minutes < 60) return minutes + " minute" + (minutes === 1 ? "" : "s");
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return hours + "h" + (rem > 0 ? " " + rem + "m" : "");
}

function formatOfflineMessage(license, nowMillis) {
  const name = license.clientName || license.id || "Your device";
  const ago = formatMinutesAgo(nowMillis - license.lastSeen);
  return (
    `\u26A0\uFE0F ${name} has been offline for ${ago}.\n` +
    `Incoming bKash/Nagad/Rocket/upay payments are not being verified until it's back online.`
  );
}

function formatRecoveryMessage(license) {
  const name = license.clientName || license.id || "Your device";
  return `\u2705 ${name} is back online. Payment verification has resumed.`;
}

module.exports = {
  DEFAULT_OFFLINE_THRESHOLD_MINUTES,
  ALERT_COOLDOWN_MINUTES,
  selectLicensesNeedingAlert,
  selectRecoveredLicenses,
  formatOfflineMessage,
  formatRecoveryMessage,
};

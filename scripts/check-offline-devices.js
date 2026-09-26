#!/usr/bin/env node
"use strict";
/**
 * অফলাইন অ্যালার্ট — GitHub Actions cron থেকে চলার জন্য (Cloud Functions/Blaze প্ল্যান
 * ছাড়াই)। Cloud Function-ভিত্তিক ভার্সনের (functions/offlineAlertFunctions.js) হুবহু
 * একই লজিক ব্যবহার করে (offlineAlertLogic.js থেকে ইমপোর্ট করে) — শুধু "কীভাবে সময়মতো
 * চালানো হয়" সেটা আলাদা: Cloud Scheduler-এর বদলে GitHub Actions-এর নিজস্ব cron।
 *
 * প্রয়োজনীয় environment variable:
 *   FIREBASE_SERVICE_ACCOUNT_KEY — Firebase Console → Project Settings → Service accounts
 *     → Generate new private key থেকে পাওয়া পুরো JSON ফাইলের কনটেন্ট (এক লাইনে, GitHub
 *     repo secret হিসেবে সেভ করা)
 *   TELEGRAM_BOT_TOKEN — ঐচ্ছিক, Telegram অ্যালার্টের জন্য
 *
 * স্থানীয়ভাবে টেস্ট করতে:
 *   FIREBASE_SERVICE_ACCOUNT_KEY="$(cat serviceAccountKey.json)" \
 *   TELEGRAM_BOT_TOKEN="..." \
 *   node scripts/check-offline-devices.js
 */

const admin = require("firebase-admin");
const {
  selectLicensesNeedingAlert,
  selectRecoveredLicenses,
  formatOfflineMessage,
  formatRecoveryMessage,
} = require("../server-reference/offlineAlertLogic");

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

async function sendTelegramAlert(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.warn("Telegram alert failed:", res.status, await res.text().catch(() => ""));
  }
}

/** placeholder — নিজের email provider বসান (Cloud Function ভার্সনের মতোই) */
async function sendEmailAlert(to, subject, text) {
  if (!to) return;
  console.log(`[email placeholder] to=${to} subject="${subject}" body="${text}"`);
}

async function notify(license, text, subject) {
  const tasks = [];
  if (license.telegramChatId) tasks.push(sendTelegramAlert(license.telegramChatId, text));
  if (license.alertEmail) tasks.push(sendEmailAlert(license.alertEmail, subject, text));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.warn("Alert delivery failed:", r.reason);
  }
}

async function main() {
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY is not set");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(keyJson);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const now = Date.now();
  const snapshot = await db.collection("licenses").where("active", "==", true).get();

  const licenses = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      active: data.active === true,
      isOnline: data.isOnline === true,
      lastSeen: toMillis(data.lastSeen),
      offlineAlertMinutes: data.offlineAlertMinutes,
      lastOfflineAlertMillis: toMillis(data.lastOfflineAlertMillis),
      telegramChatId: data.telegramChatId,
      alertEmail: data.alertEmail,
      clientName: data.clientName,
    };
  });

  const needAlert = selectLicensesNeedingAlert(licenses, now);
  const recovered = selectRecoveredLicenses(licenses, now);

  for (const lic of needAlert) {
    await notify(lic, formatOfflineMessage(lic, now), "SellPoint device offline");
    await db.collection("licenses").doc(lic.id).update({ lastOfflineAlertMillis: now, isOnline: false });
  }

  for (const lic of recovered) {
    await notify(lic, formatRecoveryMessage(lic), "SellPoint device back online");
    await db.collection("licenses").doc(lic.id).update({
      lastOfflineAlertMillis: admin.firestore.FieldValue.delete(),
    });
  }

  console.log(`Offline check: ${needAlert.length} newly offline, ${recovered.length} recovered`);
}

main().catch((err) => {
  console.error("check-offline-devices failed:", err);
  process.exit(1);
});

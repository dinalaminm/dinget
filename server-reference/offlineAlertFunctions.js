"use strict";
/**
 * Firebase Cloud Function — নির্ধারিত সময় অন্তর (schedule) সব সক্রিয় লাইসেন্স স্ক্যান করে
 * কোনটা lastSeen-এর থ্রেশহোল্ড পার করে অফলাইন হয়ে গেছে তা বের করে Telegram/ইমেইলে জানায়।
 *
 * এই ফাইলটা ডিপ্লয় করার আগে:
 *   npm install firebase-functions firebase-admin
 *
 * পরিবেশ ভেরিয়েবল (firebase functions:config:set বা .env):
 *   TELEGRAM_BOT_TOKEN   — @BotFather থেকে পাওয়া বট টোকেন (Telegram অ্যালার্টের জন্য)
 *   (ইমেইলের জন্য আপনার নিজের transactional email provider-এর API key —
 *    নিচের sendEmailAlert() ফাংশনটা placeholder, নিজের provider বসিয়ে নিন)
 *
 * প্রতিটা licenses/{key} ডকুমেন্টে (ঐচ্ছিক) এই ফিল্ডগুলো থাকলে সেটার জন্য অ্যালার্ট চালু হবে:
 *   telegramChatId       — merchant-কে এই chat id-তে মেসেজ পাঠানো হবে
 *   alertEmail           — অথবা/এবং এই ইমেইলে
 *   offlineAlertMinutes  — কত মিনিট lastSeen না এলে "অফলাইন" ধরা হবে (ডিফল্ট ১৫)
 * কোনোটাই সেট না থাকলে সেই লাইসেন্সের জন্য কিছুই পাঠানো হবে না — সম্পূর্ণ ঐচ্ছিক ফিচার।
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const {
  selectLicensesNeedingAlert,
  selectRecoveredLicenses,
  formatOfflineMessage,
  formatRecoveryMessage,
} = require("./offlineAlertLogic");

if (!admin.apps.length) admin.initializeApp();

/** Firestore Timestamp/Date/millis — যেভাবেই lastSeen সেভ থাকুক, মিলিসেকেন্ডে নামিয়ে আনা */
function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

async function sendTelegramAlert(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || (functions.config().telegram || {}).bot_token;
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

/**
 * placeholder — নিজের email provider (SendGrid/Mailgun/SES ইত্যাদি) দিয়ে বাস্তবায়ন করুন।
 * এই ফাংশনটা ফেল করলেও পুরো ফাংশন যাতে ক্র্যাশ না করে, তাই কল করার জায়গায় try/catch আছে।
 */
async function sendEmailAlert(to, subject, text) {
  if (!to) return;
  console.log(`[email placeholder] to=${to} subject="${subject}" body="${text}"`);
  // উদাহরণ (SendGrid): সরান কমেন্ট আর নিজের API key বসান
  // await fetch("https://api.sendgrid.com/v3/mail/send", {
  //   method: "POST",
  //   headers: {
  //     Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
  //     "Content-Type": "application/json",
  //   },
  //   body: JSON.stringify({
  //     personalizations: [{ to: [{ email: to }] }],
  //     from: { email: "alerts@yourdomain.com" },
  //     subject,
  //     content: [{ type: "text/plain", value: text }],
  //   }),
  // });
}

async function notify(license, text, subjectForEmail) {
  const tasks = [];
  if (license.telegramChatId) tasks.push(sendTelegramAlert(license.telegramChatId, text));
  if (license.alertEmail) tasks.push(sendEmailAlert(license.alertEmail, subjectForEmail, text));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.warn("Alert delivery failed:", r.reason);
  }
}

exports.checkOfflineDevices = functions.pubsub
  .schedule("every 5 minutes")
  .onRun(async () => {
    const now = Date.now();
    const snapshot = await admin.firestore()
      .collection("licenses")
      .where("active", "==", true)
      .get();

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

    const writes = [];

    for (const lic of needAlert) {
      const text = formatOfflineMessage(lic, now);
      await notify(lic, text, "SellPoint device offline");
      writes.push(
        admin.firestore().collection("licenses").doc(lic.id).update({
          lastOfflineAlertMillis: now,
          isOnline: false,
        })
      );
    }

    for (const lic of recovered) {
      const text = formatRecoveryMessage(lic);
      await notify(lic, text, "SellPoint device back online");
      writes.push(
        admin.firestore().collection("licenses").doc(lic.id).update({
          lastOfflineAlertMillis: admin.firestore.FieldValue.delete(),
        })
      );
    }

    await Promise.allSettled(writes);
    console.log(`Offline check: ${needAlert.length} newly offline, ${recovered.length} recovered`);
    return null;
  });

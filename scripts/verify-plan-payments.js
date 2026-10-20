#!/usr/bin/env node
"use strict";
/**
 * প্ল্যান কেনার পেমেন্ট নিজে থেকে যাচাই করে প্ল্যান চালু করে — GitHub Actions cron থেকে চলে
 * (Cloud Functions/Blaze প্ল্যান লাগে না)।
 *
 * কীভাবে কাজ করে:
 *   1. আপনার নিজের ফোনে SellPoint চলছে; bKash/Nagad-এ কাস্টমারের পাঠানো টাকার SMS
 *      transactions/{trxId}-এ জমা হয় (পরিমাণ + পাঠানো নম্বরসহ)।
 *   2. কাস্টমার অ্যাপে প্ল্যান বেছে TrxID ও নিজের নম্বর দিলে subscription_claims/{deviceId} তৈরি হয় (status: pending)।
 *   3. এই স্ক্রিপ্ট pending claim-গুলো দেখে: TrxID মিলছে? নম্বর মিলছে? টাকা কম না? আগে ব্যবহার হয়নি?
 *      সব ঠিক থাকলে subscriptions/{deviceId}-এর মেয়াদ বাড়িয়ে দেয়, subscription_payments-এ বিক্রির রেকর্ড
 *      রাখে, claim-কে approved করে। না মিললে কারণসহ rejected।
 *   4. SMS এখনো না এলে (ফোন অফলাইন ইত্যাদি) কিছুক্ষণ pending রেখে অপেক্ষা করে।
 *
 * প্রয়োজনীয় environment variable:
 *   FIREBASE_SERVICE_ACCOUNT_KEY — অফলাইন-অ্যালার্টের মতোই (একই secret)
 *   TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_CHAT_ID — ঐচ্ছিক; প্রতিটা অটো-গ্রান্টে আপনাকে জানাতে
 */

const admin = require("firebase-admin");
const L = require("./planPaymentLogic");

const MAX_PER_RUN = 50;

async function notifyAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.warn("Telegram notify failed:", e.message);
  }
}

async function findTransaction(db, rawTrx) {
  const candidates = [...new Set([String(rawTrx || "").trim(), L.normalizeTrx(rawTrx)])].filter(Boolean);
  for (const id of candidates) {
    const snap = await db.collection("transactions").doc(id).get();
    if (snap.exists) return { id, data: snap.data() };
  }
  return null;
}

async function isTrxUsed(db, rawTrx) {
  const candidates = [...new Set([String(rawTrx || "").trim(), L.normalizeTrx(rawTrx)])].filter(Boolean);
  for (const id of candidates) {
    const q = await db.collection("subscription_payments").where("trxId", "==", id).limit(1).get();
    if (!q.empty) return true;
  }
  return false;
}

async function approve(db, claimRef, claimSnap, plan, planId, txInfo, trxNorm) {
  const FieldValue = admin.firestore.FieldValue;
  const device = claimSnap.id;

  return db.runTransaction(async (t) => {
    // ── সব read আগে ──
    const fresh = await t.get(claimRef);
    if (!fresh.exists) return null;
    const fd = fresh.data();
    // মাঝখানে কাস্টমার অন্য TrxID দিয়ে আবার সাবমিট করলে/ইতিমধ্যে সিদ্ধান্ত হলে এই রান বাদ
    if (fd.status !== "pending" || L.normalizeTrx(fd.trxId) !== trxNorm) return null;

    const usedQ = await t.get(db.collection("subscription_payments").where("trxId", "==", trxNorm).limit(1));
    if (!usedQ.empty) return { rejected: "already_used" };

    const subRef = db.collection("subscriptions").doc(device);
    const subSnap = await t.get(subRef);
    const nowMs = Date.now();
    const currentExp = subSnap.exists ? L.toMillis(subSnap.data().expiresAt) : 0;
    const newExp = L.computeNewExpiry(currentExp, Number(plan.days), nowMs);

    // ── তারপর write ──
    t.set(subRef, {
      kind: "active",
      plan: plan.name,
      expiresAt: new Date(newExp),
      lastGrantAt: FieldValue.serverTimestamp(),
    });
    t.set(db.collection("subscription_payments").doc(), {
      device,
      planId,
      plan: plan.name,
      days: Number(plan.days),
      amount: Number(txInfo.data.amount) || 0,
      method: txInfo.data.method || "",
      trxId: trxNorm,
      note: "auto-verified",
      auto: true,
      grantedAt: FieldValue.serverTimestamp(),
    });
    t.update(claimRef, {
      status: "approved",
      reason: FieldValue.delete(),
      decidedAt: FieldValue.serverTimestamp(),
    });
    return { approvedUntil: newExp };
  });
}

async function main() {
  const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    console.error("FIREBASE_SERVICE_ACCOUNT_KEY is not set");
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(keyJson)) });
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  const pending = await db.collection("subscription_claims").where("status", "==", "pending").limit(MAX_PER_RUN).get();
  const stats = { approved: 0, rejected: 0, waiting: 0 };

  for (const doc of pending.docs) {
    try {
      const claim = doc.data();
      const trxNorm = L.normalizeTrx(claim.trxId);
      const nowMs = Date.now();
      const updMs = doc.updateTime ? doc.updateTime.toMillis() : nowMs;

      const planSnap = await db.collection("subscription_plans").doc(String(claim.planId || "-")).get();
      const plan = planSnap.exists ? planSnap.data() : null;
      const txInfo = trxNorm ? await findTransaction(db, claim.trxId) : null;
      const used = trxNorm ? await isTrxUsed(db, claim.trxId) : false;

      const verdict = L.evaluateClaim({
        claim: { trxId: trxNorm, phone: claim.phone, planId: claim.planId, submittedAtMs: updMs },
        plan, tx: txInfo && txInfo.data, alreadyUsed: used, nowMs,
      });

      if (verdict.action === "wait") { stats.waiting++; continue; }

      if (verdict.action === "reject") {
        // precondition: এর মধ্যে কাস্টমার নতুন করে সাবমিট করলে সেটাকে ভুল করে reject করা হবে না
        await doc.ref.update(
          { status: "rejected", reason: verdict.reason, decidedAt: FieldValue.serverTimestamp() },
          { lastUpdateTime: doc.updateTime }
        ).catch((e) => console.warn(`claim ${doc.id}: skipped reject (${e.code || e.message})`));
        stats.rejected++;
        continue;
      }

      const res = await approve(db, doc.ref, doc, plan, claim.planId, txInfo, trxNorm);
      if (res && res.approvedUntil) {
        stats.approved++;
        console.log(`approved ${doc.id} → ${plan.name} until ${new Date(res.approvedUntil).toISOString()}`);
        await notifyAdmin(
          `✅ Plan auto-activated\n${plan.name} · ৳${txInfo.data.amount} · ${txInfo.data.method || ""}\nTrxID: ${trxNorm}\nID: ${doc.id}`
        );
      } else if (res && res.rejected) {
        await doc.ref.update({ status: "rejected", reason: res.rejected, decidedAt: FieldValue.serverTimestamp() });
        stats.rejected++;
      }
    } catch (err) {
      // একটা claim-এর সমস্যা বাকিগুলো আটকাবে না
      console.error(`claim ${doc.id} failed:`, err.message);
    }
  }

  console.log(`Plan payments: ${stats.approved} approved, ${stats.rejected} rejected, ${stats.waiting} waiting`);
}

main().catch((err) => {
  console.error("verify-plan-payments failed:", err);
  process.exit(1);
});

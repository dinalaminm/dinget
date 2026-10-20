"use strict";
/**
 * SellPoint ওয়েবহুক যাচাই — Node.js (কোনো লাইব্রেরি লাগে না)
 *
 * চালাতে:  WEBHOOK_SECRET=<admin panel-এর Signing secret> node node-verify.js
 * টেস্ট:   node --test node-verify.test.js
 */
const crypto = require("crypto");
const http = require("http");

const TOLERANCE_SEC = 300; // ৫ মিনিটের বেশি পুরনো/ভবিষ্যতের কল বাতিল — replay ঠেকাতে

/**
 * @param {Buffer|string} rawBody  সার্ভারে যেমন এসেছে হুবহু সেই বডি (JSON পার্স করে আবার বানানো বডি নয়!)
 * @param {string} header          X-DinGet-Signature হেডারের মান, যেমন "t=1760000000,v1=ab12..."
 * @param {string} secret          admin panel-এর Signing secret
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function verifySignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = TOLERANCE_SEC) {
  if (!secret) return { ok: false, reason: "no_secret" };
  const parts = {};
  for (const piece of String(header || "").split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!/^\d+$/.test(t || "") || !/^[0-9a-f]{64}$/i.test(v1 || "")) return { ok: false, reason: "malformed_header" };

  if (Math.abs(nowSec - Number(t)) > toleranceSec) return { ok: false, reason: "stale_timestamp" };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

module.exports = { verifySignature, TOLERANCE_SEC };

// ── নমুনা সার্ভার ──
if (require.main === module) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error("Set WEBHOOK_SECRET first");
    process.exit(1);
  }
  const seen = new Set(); // প্রোডাকশনে ডাটাবেজে রাখুন (deliveryId UNIQUE)

  http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") { res.writeHead(404).end(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const check = verifySignature(raw, req.headers["x-dinget-signature"], secret);
      if (!check.ok) {
        console.warn("rejected:", check.reason);
        res.writeHead(401).end(check.reason);
        return;
      }
      const event = JSON.parse(raw.toString("utf8"));
      if (seen.has(event.deliveryId)) { res.writeHead(200).end("duplicate"); return; } // আগেই প্রসেস হয়েছে
      seen.add(event.deliveryId);

      // TODO: এখানে অর্ডার/ইনভয়েস মেলান — event.trxID, event.amount, event.method, event.customerNumber
      console.log("payment:", event.trxID, event.amount, event.method);
      res.writeHead(200).end("ok"); // ৮ সেকেন্ডের মধ্যে 2xx দিন, নইলে SellPoint আবার পাঠাবে
    });
  }).listen(3000, () => console.log("listening on :3000/webhook"));
}

"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { verifySignature } = require("./node-verify");

const SECRET = "whsec_test_0123456789abcdef";
const NOW = 1_760_000_000;
const BODY = '{"deliveryId":"d-1","trxID":"9A1B2C3D4E","method":"bKash","amount":100.0,"sender":"bKash","customerNumber":"01712345678","clientId":"DINGET-XXXX","status":"unused","timestamp":1759999990000}';

function sign(body, ts = NOW, secret = SECRET) {
  const v1 = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

test("বৈধ কল গ্রহণ", () => assert.deepEqual(verifySignature(BODY, sign(BODY), SECRET, NOW), { ok: true }));
test("Buffer বডিও চলে", () => assert.equal(verifySignature(Buffer.from(BODY), sign(BODY), SECRET, NOW).ok, true));
test("বডি বদলালে বাতিল", () => assert.equal(verifySignature(BODY.replace("100.0", "1.0"), sign(BODY), SECRET, NOW).reason, "bad_signature"));
test("ভুল secret-এ বাতিল", () => assert.equal(verifySignature(BODY, sign(BODY, NOW, "other"), SECRET, NOW).reason, "bad_signature"));
test("পুরনো timestamp বাতিল (replay)", () => assert.equal(verifySignature(BODY, sign(BODY, NOW - 301), SECRET, NOW).reason, "stale_timestamp"));
test("৩০০ সেকেন্ডের মধ্যে গ্রহণ", () => assert.equal(verifySignature(BODY, sign(BODY, NOW - 300), SECRET, NOW).ok, true));
test("ভবিষ্যতের timestamp বাতিল", () => assert.equal(verifySignature(BODY, sign(BODY, NOW + 301), SECRET, NOW).reason, "stale_timestamp"));
test("timestamp বদলে replay করলে signature মেলে না", () => {
  const h = sign(BODY, NOW - 1000).replace(`t=${NOW - 1000}`, `t=${NOW}`);
  assert.equal(verifySignature(BODY, h, SECRET, NOW).reason, "bad_signature");
});
test("ভাঙা/ফাঁকা হেডার", () => {
  assert.equal(verifySignature(BODY, "", SECRET, NOW).reason, "malformed_header");
  assert.equal(verifySignature(BODY, "t=abc,v1=zz", SECRET, NOW).reason, "malformed_header");
  assert.equal(verifySignature(BODY, undefined, SECRET, NOW).reason, "malformed_header");
});
test("secret না থাকলে বাতিল", () => assert.equal(verifySignature(BODY, sign(BODY), "", NOW).reason, "no_secret"));

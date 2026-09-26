// ছোট সাধারণ ইউটিলিটি — ফরম্যাটিং, টোস্ট নোটিফিকেশন, license key জেনারেশন।
// এই ফাংশনগুলো UI ফ্রেমওয়ার্ক-নির্ভর না, তাই সহজে বোঝা ও দরকার হলে টেস্ট করা যায়।

/** DINGET-XXXX-XXXX-XXXX ফরম্যাটে একটা নতুন high-entropy license key — Android অ্যাপের
 *  বর্তমান key ফরম্যাটের সাথে মিলিয়ে। বিভ্রান্তিকর অক্ষর (0/O, 1/I) বাদ দেওয়া হয়েছে যাতে
 *  ফোনে টাইপ করার সময় ভুল কম হয়। */
const KEY_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateLicenseKey() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let group = "";
    const randomValues = new Uint32Array(4);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < 4; i++) {
      group += KEY_CHARSET[randomValues[i] % KEY_CHARSET.length];
    }
    groups.push(group);
  }
  return "DINGET-" + groups.join("-");
}

/** webhookSecret-এর জন্য — এটা merchant বা কেউ টাইপ করবে না, তাই সম্পূর্ণ এলোমেলো হলেই যথেষ্ট */
export function generateWebhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Firestore Timestamp | Date | millis | null/undefined — যেকোনো একটা থেকে একটা readable string */
export function formatWhen(value) {
  const millis = toMillis(value);
  if (millis == null) return "—";
  const date = new Date(millis);
  const now = Date.now();
  const diffMs = now - millis;

  if (diffMs >= 0 && diffMs < 60_000) return "Just now";
  if (diffMs >= 0 && diffMs < 3_600_000) return Math.floor(diffMs / 60_000) + "m ago";
  if (diffMs >= 0 && diffMs < 86_400_000) return Math.floor(diffMs / 3_600_000) + "h ago";

  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    year: diffMs > 365 * 86_400_000 ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

export function formatTaka(amount) {
  const n = typeof amount === "number" ? amount : 0;
  return "\u09F3" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** সাধারণ CSV এস্কেপিং — কমা/কোট/নিউলাইন থাকলে quote করা */
export function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function downloadCsv(filename, rows) {
  const content = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── টোস্ট নোটিফিকেশন ──
let toastContainer = null;

export function toast(message, kind = "info") {
  if (!toastContainer) {
    toastContainer = document.getElementById("toastContainer");
  }
  if (!toastContainer) return;

  const el = document.createElement("div");
  el.className = "toast toast--" + kind;
  el.textContent = message;
  toastContainer.appendChild(el);

  requestAnimationFrame(() => el.classList.add("toast--visible"));

  setTimeout(() => {
    el.classList.remove("toast--visible");
    setTimeout(() => el.remove(), 200);
  }, 4000);
}

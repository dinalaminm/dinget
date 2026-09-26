// Firebase SDK (modular, v10) সরাসরি CDN থেকে — কোনো বিল্ড টুল/npm install লাগে না,
// এই ফোল্ডারটা যেকোনো স্ট্যাটিক হোস্টিং (Firebase Hosting, Netlify, বা এমনকি লোকাল
// file server) থেকে সরাসরি চালানো যায়।
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Cloud Functions ব্যবহার করা হচ্ছে না (Blaze প্ল্যান লাগে বলে) — অ্যাডমিন লগইন এখন
// সরাসরি Firebase Authentication (Email/Password) দিয়ে, যেটা Spark (ফ্রি) প্ল্যানেও
// সম্পূর্ণ কাজ করে। অফলাইন অ্যালার্ট চলে GitHub Actions cron দিয়ে (দেখুন
// scripts/check-offline-devices.js), Cloud Scheduler দিয়ে না।
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  onSnapshot,
  serverTimestamp,
};

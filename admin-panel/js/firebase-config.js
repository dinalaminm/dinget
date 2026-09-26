// এই ফাইলটাই একমাত্র জায়গা যেখানে প্রজেক্ট-নির্দিষ্ট Firebase কনফিগারেশন থাকে।
// নিচের মানগুলো app/google-services.json থেকে নেওয়া (আসল, প্রজেক্ট: khelo-jone-bd-f1048) —
// apiKey কোনো গোপন জিনিস না, এটা এমনিতেই আপনার প্রকাশিত APK-এর ভেতরে থাকে; আসল সুরক্ষা
// আসে Firestore Rules ও App Check থেকে, এই key লুকিয়ে রাখা থেকে না।
//
// ⚠️ একটা জিনিস আপনাকে নিজে করতে হবে: appId এখানে Android অ্যাপের আইডি বসানো আছে
// (একটা placeholder হিসেবে কাজ করবে), কিন্তু সঠিকভাবে চালাতে Firebase Console-এ একটা
// "Web" অ্যাপ যোগ করুন (Project Settings → Your apps → Add app → Web) এবং সেখান থেকে
// পাওয়া আসল appId দিয়ে নিচেরটা বদলে দিন।
export const firebaseConfig = {
  apiKey: "AIzaSyCpzyw9n4KsUr48toS010uJVG2xQTF3PEQ",
  authDomain: "dinget-2503a.firebaseapp.com",
  projectId: "dinget-2503a",
  storageBucket: "dinget-2503a.firebasestorage.app",
  messagingSenderId: "281348698415",
  appId: "1:281348698415:web:780cbb33aa90e48678f1da"
};

// Cloud Functions (adminLogin ইত্যাদি) এখানে ব্যবহার হচ্ছে না — লগইন সরাসরি Firebase
// Authentication (Email/Password) দিয়ে, যেটা Blaze প্ল্যান ছাড়াই কাজ করে। অফলাইন অ্যালার্ট
// চলে GitHub Actions cron দিয়ে (দেখুন ../scripts/check-offline-devices.js)।
// পরে কখনো Blaze প্ল্যানে upgrade করলে functions/ ফোল্ডারের Cloud Function-ভিত্তিক ভার্সনে
// ফেরত যাওয়া যাবে — সেই কোড এখনো functions/ ও server-reference/-এ আছে, শুধু ব্যবহার
// করা হচ্ছে না।

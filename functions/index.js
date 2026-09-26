"use strict";
/**
 * Firebase Cloud Functions-এর এন্ট্রি পয়েন্ট — `firebase deploy --only functions` চালালে
 * এই ফাইলটাই পড়া হয়। এখানে শুধু বাকি ফাইলগুলো থেকে ফাংশনগুলো একত্র করে export করা হচ্ছে,
 * আসল লজিক প্রতিটা নিজের ফাইলে (adminAuthFunctions.js, offlineAlertFunctions.js)।
 */

const adminAuth = require("./adminAuthFunctions");
const offlineAlert = require("./offlineAlertFunctions");

exports.adminLogin = adminAuth.adminLogin;
exports.adminChangePassword = adminAuth.adminChangePassword;
exports.checkOfflineDevices = offlineAlert.checkOfflineDevices;

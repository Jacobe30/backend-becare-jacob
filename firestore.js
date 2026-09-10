"use strict";

let firestore = null;
let initialized = false;

function getFirestore() {
  if (initialized) return firestore;
  initialized = true;

  if (process.env.FIRESTORE_DISABLED === "1") return null;

  try {
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (serviceAccountJson) {
        const serviceAccount = JSON.parse(serviceAccountJson);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
        });
      } else {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId: process.env.FIREBASE_PROJECT_ID,
        });
      }
    }
    firestore = admin.firestore();
    console.log("[firestore] sessions persistence enabled");
  } catch (error) {
    console.warn("[firestore] disabled:", error.message);
    firestore = null;
  }
  return firestore;
}

function writeSession(id, document) {
  const db = getFirestore();
  if (!db || !id) return;
  db.collection("sessions").doc(String(id)).set(document, { merge: false }).catch((error) => {
    console.warn("[firestore] session write failed:", error.message);
  });
}

module.exports = { writeSession };

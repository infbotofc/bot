// session_firebase.js
// Save and load session info to Firebase Realtime Database

const { initializeApp } = require('firebase/app');
const { getDatabase, ref, set, get, child } = require('firebase/database');

const firebaseConfig = {
  apiKey: "AIzaSyCOVtGybutGV2mLUfCVPYQYT3mVnvx8VYk",
  authDomain: "aliunpaid-e4f67.firebaseapp.com",
  databaseURL: "https://aliunpaid-e4f67-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "aliunpaid-e4f67",
  storageBucket: "aliunpaid-e4f67.firebasestorage.app",
  messagingSenderId: "216912521042",
  appId: "1:216912521042:web:ab687dd2621275a4d6bc8b",
  measurementId: "G-DP02MQRKHM"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

async function saveSessionToFirebase(sessionId, sessionData) {
  await set(ref(db, 'sessions/' + sessionId), sessionData);
}

async function loadSessionFromFirebase(sessionId) {
  const snapshot = await get(child(ref(db), 'sessions/' + sessionId));
  if (snapshot.exists()) {
    return snapshot.val();
  } else {
    return null;
  }
}

module.exports = {
  saveSessionToFirebase,
  loadSessionFromFirebase
};

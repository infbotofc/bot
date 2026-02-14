// scripts/upload_sessions_to_firebase.js
// Upload all session files to Firebase

const fs = require('fs');
const path = require('path');
const { saveSessionToFirebase } = require('../lib/session_firebase');

const SESSION_DIR = path.join(__dirname, '../session');

async function uploadAllSessions() {
  const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const sessionId = file.replace('.json', '');
    const filePath = path.join(SESSION_DIR, file);
    const data = fs.readFileSync(filePath, 'utf8');
    let json;
    try {
      json = JSON.parse(data);
    } catch (e) {
      console.error(`Failed to parse ${file}:`, e.message);
      continue;
    }
    try {
      await saveSessionToFirebase(sessionId, json);
      console.log(`Uploaded ${file} to Firebase as ${sessionId}`);
    } catch (e) {
      console.error(`Failed to upload ${file}:`, e.message);
    }
  }
}

uploadAllSessions().then(() => {
  console.log('All session files uploaded to Firebase.');
  process.exit(0);
});

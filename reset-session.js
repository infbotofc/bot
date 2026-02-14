const fs = require('fs');
const path = require('path');

function removeIfExists(p) {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log('Removed:', p);
    } else {
      console.log('Not found:', p);
    }
  } catch (e) {
    console.error('Failed to remove', p, e.message);
  }
}

const base = process.cwd();
removeIfExists(path.join(base, 'session'));
// Optionally clear cloned sessions
removeIfExists(path.join(base, 'session', 'clones'));

// Keep paired device records safe, but back them up if present
const paired = path.join(base, 'data', 'paired_devices.json');
if (fs.existsSync(paired)) {
  try {
    const bak = paired + '.bak.' + Date.now();
    fs.copyFileSync(paired, bak);
    console.log('Backed up paired_devices.json to', bak);
  } catch (e) { console.error('Failed to backup paired_devices.json', e.message); }
}

console.log('Session reset complete. You can now start the bot to re-pair.');

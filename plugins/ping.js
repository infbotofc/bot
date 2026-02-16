const settings = require('../settings');
const os = require('os');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

function pickRandomAsset() {
  const assetsDir = path.join(__dirname, '../assets');
  try {
    if (!fs.existsSync(assetsDir)) return null;
    const files = fs.readdirSync(assetsDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (!files.length) return null;
    const choice = files[Math.floor(Math.random() * files.length)];
    return path.join(assetsDir, choice);
  } catch {
    return null;
  }
}

async function dnsPing(host = 'google.com', timeoutMs = 2000) {
  try {
    const t0 = process.hrtime.bigint();
    const lookup = dns.promises.lookup(host);

    const res = await Promise.race([
      lookup.then(() => 'ok').catch(() => 'err'),
      new Promise(r => setTimeout(() => r('timeout'), timeoutMs)),
    ]);

    if (res !== 'ok') return -1;

    const t1 = process.hrtime.bigint();
    return Number(t1 - t0) / 1e6;
  } catch {
    return -1;
  }
}

function uptimeShort(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function mb(n) {
  return (n / 1024 / 1024).toFixed(0);
}

function grade(ms) {
  if (ms < 0) return { icon: '⚪', txt: 'N/A' };
  if (ms <= 120) return { icon: '🟢', txt: 'FAST' };
  if (ms <= 250) return { icon: '🟡', txt: 'OK' };
  if (ms <= 450) return { icon: '🟠', txt: 'SLOW' };
  return { icon: '🔴', txt: 'BAD' };
}

function safeStr(x, fallback) {
  try {
    const s = (x ?? '').toString().trim();
    return s || fallback;
  } catch {
    return fallback;
  }
}

module.exports = {
  command: 'ping',
  aliases: ['p', 'pong'],
  category: 'general',
  description: 'Check bot response time',
  usage: '.ping',
  isPrefixless: true,

  async handler(sock, message) {
    const chatId = message.key.remoteJid;

    // Local latency (how fast command runs)
    const t0 = process.hrtime.bigint();
    const netMs = await dnsPing('google.com', 2000);
    const t1 = process.hrtime.bigint();
    const localMs = Number(t1 - t0) / 1e6;

    const g = grade(netMs);
    const up = uptimeShort(process.uptime());

    const mem = process.memoryUsage();
    const rss = mb(mem.rss || 0);
    const heapU = mb(mem.heapUsed || 0);
    const heapT = mb(mem.heapTotal || 0);

    const botName = safeStr(settings.botName, 'Infinity MD');
    const version = safeStr(settings.version, 'unknown');

    const statusMsg =
`╭━━〔 🤖 ${botName} STATUS 〕━━⬣
┃ 🏓 Local    : ${localMs.toFixed(0)} ms
┃ 🌐 Net      : ${netMs < 0 ? 'N/A' : netMs.toFixed(0) + ' ms'}  ${g.icon} ${g.txt}
┃ 🧠 Response : Active
┃ ⏱ Uptime   : ${up}
┃ 💾 RAM      : ${rss} MB
┃ 📦 Heap     : ${heapU}/${heapT} MB
┃ 🖥 OS       : ${os.platform()} ${os.arch()}
┃ 🟩 Node     : ${process.version}
┃ 🏷 Version  : v${version}
╰━━━━━━━━━━━━━━━━━━━━⬣

✨ Everything working perfectly!`;

    try {
      const imgPath = pickRandomAsset();
      if (imgPath && fs.existsSync(imgPath)) {
        await sock.sendMessage(
          chatId,
          { image: fs.readFileSync(imgPath), caption: statusMsg },
          { quoted: message }
        );
      } else {
        await sock.sendMessage(chatId, { text: statusMsg }, { quoted: message });
      }
    } catch {
      await sock.sendMessage(chatId, { text: statusMsg }, { quoted: message });
    }
  }
};

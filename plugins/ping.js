const settings = require('../settings');
const os = require('os');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

function pickRandomAsset() {
  const assetsDir = path.join(__dirname, '../assets');
  try {
    const files = fs.readdirSync(assetsDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (!files.length) return null;
    const choice = files[Math.floor(Math.random() * files.length)];
    return path.join(assetsDir, choice);
  } catch {
    return null;
  }
}

async function dnsPing(host = 'google.com', timeoutMs = 2000) {
  const t0 = process.hrtime.bigint();
  const lookup = dns.promises.lookup(host);

  const res = await Promise.race([
    lookup.then(() => 'ok').catch(() => 'err'),
    new Promise(r => setTimeout(() => r('timeout'), timeoutMs)),
  ]);

  if (res !== 'ok') return -1;

  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

function uptimeShort(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

function box(lines) {
  // keep it phone-friendly
  const width = Math.min(
    32,
    Math.max(...lines.map(l => l.length), 22)
  );

  const top = `┌${'─'.repeat(width)}┐`;
  const bot = `└${'─'.repeat(width)}┘`;

  const out = [top];
  for (const raw of lines) {
    const l = raw.length > width ? raw.slice(0, width) : raw;
    out.push(`│${l.padEnd(width, ' ')}│`);
  }
  out.push(bot);
  return out.join('\n');
}

module.exports = {
  command: 'ping',
  aliases: ['p', 'pong'],
  category: 'general',
  description: 'Check bot response time',
  usage: '.ping',

  async handler(sock, message) {
    const chatId = message.key.remoteJid;
    const ms = await dnsPing('google.com', 2000);
    const uptime = uptimeShort(process.uptime());
    const statusMsg = `╭━━〔 🤖 BOT STATUS 〕━━⬣\n┃ ⚡ Speed     : ${ms < 0 ? 'N/A' : ms.toFixed(0) + ' ms'}\n┃ 🧠 Response  : Active\n┃ ⏱ Uptime    : ${uptime}\n┃ 📡 Server    : Online\n╰━━━━━━━━━━━━━━⬣\n\n✨ Everything working perfectly!`;
    await sock.sendMessage(chatId, { text: statusMsg }, { quoted: message });
  }
};


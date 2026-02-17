// plugins/autopp.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const isOwnerOrSudo = require('../lib/isOwner');
const store = require('../lib/lightweight_store');

const TMP_DIR = path.join(process.cwd(), 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

let AUTOPP_TIMER = null;
let AUTOPP_RUNNING = false;

const STORE_SCOPE = 'global';
const STORE_KEY = 'autopp'; // { enabled, mode, hours, minHours, maxHours, query, lastRun }

const DEFAULT_QUERY = 'whatsapp profile pictures for boys';
const API_BASE = 'https://api.srihub.store/search/img';

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function msHours(h) { return Math.round(h * 60 * 60 * 1000); }

function pickNextHours(cfg) {
  if (cfg.mode === 'rnd') {
    const minH = clamp(Number(cfg.minHours || 1), 1, 24);
    const maxH = clamp(Number(cfg.maxHours || 6), 1, 24);
    const lo = Math.min(minH, maxH);
    const hi = Math.max(minH, maxH);
    const next = lo + Math.random() * (hi - lo);
    return Math.round(next * 10) / 10; // 1 decimal
  }
  return clamp(Number(cfg.hours || 6), 1, 168);
}

async function getCfg() {
  const cfg = (await store.getSetting(STORE_SCOPE, STORE_KEY)) || {};
  return {
    enabled: !!cfg.enabled,
    mode: cfg.mode === 'rnd' ? 'rnd' : 'fixed',
    hours: Number(cfg.hours || 6),
    minHours: Number(cfg.minHours || 1),
    maxHours: Number(cfg.maxHours || 6),
    query: String(cfg.query || DEFAULT_QUERY),
    lastRun: cfg.lastRun || null,
  };
}

async function setCfg(next) {
  await store.saveSetting(STORE_SCOPE, STORE_KEY, next);
  try { if (typeof store.writeToFile === 'function') await store.writeToFile(); } catch {}
}

async function fetchImageLinksFromSrihub(query) {
  const apikey = process.env.SRH_IMG_APIKEY || process.env.SRIHUB_APIKEY;
  if (!apikey) throw new Error('Missing SRH_IMG_APIKEY in environment variables');

  const url = `${API_BASE}?q=${encodeURIComponent(query)}&apikey=${encodeURIComponent(apikey)}`;

  const res = await axios.get(url, { timeout: 60000 });
  const data = res.data;

  // Try multiple possible response shapes safely
  const candidates = []
    .concat(data?.result || [])
    .concat(data?.results || [])
    .concat(data?.data || [])
    .concat(data?.images || []);

  const links = candidates
    .map(x => {
      if (typeof x === 'string') return x;
      if (x?.url) return x.url;
      if (x?.link) return x.link;
      if (x?.image) return x.image;
      if (x?.src) return x.src;
      return null;
    })
    .filter(Boolean);

  if (!Array.isArray(links) || links.length === 0) {
    throw new Error('SriHub API returned no image links');
  }

  // remove duplicates
  return [...new Set(links)];
}

async function downloadImageToBuffer(imgUrl) {
  const res = await axios.get(imgUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (InfinityMD AutoPP)',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    },
    maxRedirects: 5
  });

  const buf = Buffer.from(res.data || []);
  if (buf.length < 10_000) throw new Error('Downloaded image too small/invalid');
  return buf;
}

async function setBotProfilePicture(sock, query) {
  // Get links → pick random → download → set DP
  const links = await fetchImageLinksFromSrihub(query);
  const pick = links[Math.floor(Math.random() * links.length)];

  const buffer = await downloadImageToBuffer(pick);

  const filePath = path.join(TMP_DIR, `autopp_${Date.now()}.jpg`);
  fs.writeFileSync(filePath, buffer);

  try {
    await sock.updateProfilePicture(sock.user.id, { url: filePath });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }

  return pick;
}

async function scheduleNext(sock) {
  const cfg = await getCfg();
  if (!cfg.enabled) return;

  const nextHours = pickNextHours(cfg);
  const delayMs = msHours(nextHours);

  if (AUTOPP_TIMER) clearTimeout(AUTOPP_TIMER);

  AUTOPP_TIMER = setTimeout(async () => {
    try {
      if (AUTOPP_RUNNING) return;
      AUTOPP_RUNNING = true;

      await setBotProfilePicture(sock, cfg.query);

      const updated = await getCfg();
      updated.lastRun = new Date().toISOString();
      await setCfg(updated);
    } catch (e) {
      console.error('[AUTOPP] failed:', e?.message || e);
    } finally {
      AUTOPP_RUNNING = false;
      scheduleNext(sock).catch(console.error);
    }
  }, delayMs);
}

async function startAutoPP(sock) {
  const cfg = await getCfg();
  if (!cfg.enabled) return;
  await scheduleNext(sock);
}

async function stopAutoPP() {
  if (AUTOPP_TIMER) clearTimeout(AUTOPP_TIMER);
  AUTOPP_TIMER = null;

  const cfg = await getCfg();
  cfg.enabled = false;
  await setCfg(cfg);
}

module.exports = {
  command: 'autopp',
  aliases: ['autodp', 'autodpp'],
  category: 'owner',
  description: 'Auto change bot profile picture every X hours (or random)',
  usage: '.autopp <hours|rnd|off|now|status|query>',

  // for index.js hook
  startAutoPP,
  stopAutoPP,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
      return sock.sendMessage(chatId, { text: '❌ Owner only.' }, { quoted: message });
    }

    const sub = String(args[0] || '').trim().toLowerCase();
    const cfg = await getCfg();

    // status
    if (!sub || sub === 'status') {
      const sched = cfg.enabled
        ? (cfg.mode === 'rnd' ? `Random: ${cfg.minHours}-${cfg.maxHours} hours` : `Every: ${cfg.hours} hours`)
        : 'OFF';

      return sock.sendMessage(chatId, {
        text:
          `👤 *AUTO PP STATUS*\n\n` +
          `• Enabled: ${cfg.enabled ? '✅ ON' : '❌ OFF'}\n` +
          `• Mode: ${cfg.mode.toUpperCase()}\n` +
          `• Query: ${cfg.query}\n` +
          `• Schedule: ${sched}\n` +
          `• Last Run: ${cfg.lastRun || 'Never'}\n\n` +
          `Commands:\n` +
          `• .autopp 6\n` +
          `• .autopp rnd\n` +
          `• .autopp rnd 2 8\n` +
          `• .autopp query <text>\n` +
          `• .autopp now\n` +
          `• .autopp off`
      }, { quoted: message });
    }

    // off
    if (sub === 'off' || sub === 'stop') {
      await stopAutoPP();
      return sock.sendMessage(chatId, { text: '✅ AutoPP stopped (OFF).' }, { quoted: message });
    }

    // change query
    if (sub === 'query') {
      const q = args.slice(1).join(' ').trim();
      if (!q) {
        return sock.sendMessage(chatId, { text: '❌ Use: `.autopp query whatsapp profile pictures for boys`' }, { quoted: message });
      }
      cfg.query = q;
      await setCfg({ ...cfg });
      await startAutoPP(sock);
      return sock.sendMessage(chatId, { text: `✅ AutoPP query updated:\n• ${q}` }, { quoted: message });
    }

    // now
    if (sub === 'now') {
      await sock.sendMessage(chatId, { text: '⬇️ Updating profile picture now...' }, { quoted: message });
      try {
        const usedUrl = await setBotProfilePicture(sock, cfg.query);
        const updated = await getCfg();
        await setCfg({ ...updated, enabled: true, lastRun: new Date().toISOString() });
        await startAutoPP(sock);
        return sock.sendMessage(chatId, { text: `✅ Profile picture updated!\n🖼️ Source: ${usedUrl}` }, { quoted: message });
      } catch (e) {
        return sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: message });
      }
    }

    // random mode
    if (sub === 'rnd') {
      const minH = args[1] ? clamp(Number(args[1]), 1, 24) : 1;
      const maxH = args[2] ? clamp(Number(args[2]), 1, 24) : 6;

      const next = {
        ...cfg,
        enabled: true,
        mode: 'rnd',
        minHours: minH,
        maxHours: maxH,
      };

      await setCfg(next);
      await startAutoPP(sock);

      return sock.sendMessage(chatId, {
        text: `✅ AutoPP enabled (RANDOM)\n• Range: ${minH}-${maxH} hours\n• Query: ${next.query}`
      }, { quoted: message });
    }

    // fixed hours
    const hours = Number(sub);
    if (!Number.isFinite(hours) || hours <= 0) {
      return sock.sendMessage(chatId, {
        text: '❌ Use: `.autopp 1` or `.autopp 6` or `.autopp rnd` or `.autopp query <text>` or `.autopp off`'
      }, { quoted: message });
    }

    const safeH = clamp(hours, 1, 168);
    const next = {
      ...cfg,
      enabled: true,
      mode: 'fixed',
      hours: safeH,
    };

    await setCfg(next);
    await startAutoPP(sock);

    return sock.sendMessage(chatId, {
      text: `✅ AutoPP enabled\n• Interval: every ${safeH} hour(s)\n• Query: ${next.query}`
    }, { quoted: message });
  }
};

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
const STORE_KEY = 'autopp'; // { enabled, mode, hours, minutes, minHours, maxHours, query, lastRun }

const DEFAULT_QUERY = 'whatsapp profile pictures for boys';
const API_BASE = 'https://api.srihub.store/search/img';

// ✅ New API key (fallback if env not set)
const FALLBACK_API_KEY = 'dew_FEIXBd8x3XE6eshtBtM1NwEV5IxSLI6PeRE2zLmi';

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function msHours(h) { return Math.round(h * 60 * 60 * 1000); }
function msMinutes(m) { return Math.round(m * 60 * 1000); }

function formatFixedInterval(cfg) {
  const h = Number(cfg.hours || 0);
  const m = Number(cfg.minutes || 0);
  if (h <= 0 && m > 0) return `${m} minute(s)`;
  if (m > 0) return `${h} hour(s) ${m} minute(s)`;
  return `${h} hour(s)`;
}

function parseHourMinuteToken(token) {
  // Supports:
  //  - "1,15"  => 1h 15m
  //  - "0,15"  => 0h 15m
  //  - "1:15"  => 1h 15m (bonus)
  // Spaces around comma allowed: "1, 15"
  const raw = String(token || '').trim();
  if (!raw) return null;

  const cleaned = raw.replace(/\s+/g, '');
  const sep = cleaned.includes(',') ? ',' : (cleaned.includes(':') ? ':' : null);
  if (!sep) return null;

  const parts = cleaned.split(sep);
  if (parts.length !== 2) return null;

  const hh = Number(parts[0]);
  const mm = Number(parts[1]);

  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || mm < 0) return null;

  // minutes 0-59
  if (mm > 59) return null;

  // require at least 1 minute total
  const totalMin = (hh * 60) + mm;
  if (totalMin < 1) return null;

  // clamp total to 7 days (168h)
  const clampedH = clamp(hh, 0, 168);
  let clampedM = mm;
  if ((clampedH * 60 + clampedM) > (168 * 60)) clampedM = 0;

  return { hours: clampedH, minutes: clampedM };
}

function pickNextHours(cfg) {
  if (cfg.mode === 'rnd') {
    const minH = clamp(Number(cfg.minHours || 1), 1, 24);
    const maxH = clamp(Number(cfg.maxHours || 6), 1, 24);
    const lo = Math.min(minH, maxH);
    const hi = Math.max(minH, maxH);
    const next = lo + Math.random() * (hi - lo);
    return Math.round(next * 10) / 10; // 1 decimal
  }
  return clamp(Number(cfg.hours || 6), 0, 168);
}

function pickFixedDelayMs(cfg) {
  const h = Number(cfg.hours || 0);
  const m = Number(cfg.minutes || 0);
  const totalMin = (h * 60) + m;

  // Backward compatibility: if old config had only hours >=1 and minutes empty
  if ((!Number.isFinite(totalMin) || totalMin <= 0) && h > 0) {
    return msHours(clamp(h, 1, 168));
  }

  // Enforce at least 1 minute, max 168 hours
  const safeMin = clamp(totalMin, 1, 168 * 60);
  return msMinutes(safeMin);
}

async function getCfg() {
  const cfg = (await store.getSetting(STORE_SCOPE, STORE_KEY)) || {};
  return {
    enabled: !!cfg.enabled,
    mode: cfg.mode === 'rnd' ? 'rnd' : 'fixed',
    hours: Number.isFinite(Number(cfg.hours)) ? Number(cfg.hours) : 6,
    minutes: Number.isFinite(Number(cfg.minutes)) ? Number(cfg.minutes) : 0,
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

function getSrihubApiKey() {
  // Priority:
  // 1) SRH_IMG_APIKEY env
  // 2) SRIHUB_APIKEY env
  // 3) hardcoded fallback (new key)
  return (
    process.env.SRH_IMG_APIKEY ||
    process.env.SRIHUB_APIKEY ||
    FALLBACK_API_KEY
  );
}

async function fetchImageLinksFromSrihub(query) {
  const apikey = getSrihubApiKey();
  if (!apikey) throw new Error('Missing SriHub API key');

  const url = `${API_BASE}?q=${encodeURIComponent(query)}&apikey=${encodeURIComponent(apikey)}`;

  const res = await axios.get(url, { timeout: 60000 });
  const data = res.data;

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

  let delayMs;

  if (cfg.mode === 'rnd') {
    const nextHours = pickNextHours(cfg);
    delayMs = msHours(nextHours);
  } else {
    delayMs = pickFixedDelayMs(cfg);
  }

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
  usage: '.autopp <hours | hour,min | rnd | off | now | status | query>',

  startAutoPP,
  stopAutoPP,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

    if (!message.key.fromMe && !isOwner) {
      return sock.sendMessage(chatId, { text: '❌ Owner only.' }, { quoted: message });
    }

    const subRaw = String(args[0] || '').trim();
    const sub = subRaw.toLowerCase();
    const cfg = await getCfg();

    // status
    if (!sub || sub === 'status') {
      const sched = cfg.enabled
        ? (cfg.mode === 'rnd'
          ? `Random: ${cfg.minHours}-${cfg.maxHours} hours`
          : `Every: ${formatFixedInterval(cfg)}`)
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
          `• .autopp 1,15  (1 hour 15 min)\n` +
          `• .autopp 0,15  (15 min)\n` +
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

    // hour,min (or hour:min)
    const hm = parseHourMinuteToken(subRaw);
    if (hm) {
      const next = {
        ...cfg,
        enabled: true,
        mode: 'fixed',
        hours: hm.hours,
        minutes: hm.minutes,
      };

      await setCfg(next);
      await startAutoPP(sock);

      return sock.sendMessage(chatId, {
        text: `✅ AutoPP enabled\n• Interval: every ${formatFixedInterval(next)}\n• Query: ${next.query}`
      }, { quoted: message });
    }

    // fixed hours (old behavior)
    const hours = Number(sub);
    if (!Number.isFinite(hours) || hours <= 0) {
      return sock.sendMessage(chatId, {
        text:
          '❌ Use:\n' +
          '• `.autopp 1` or `.autopp 6`\n' +
          '• `.autopp 1,15` (1 hour 15 min)\n' +
          '• `.autopp 0,15` (15 min)\n' +
          '• `.autopp rnd` or `.autopp rnd 2 8`\n' +
          '• `.autopp query <text>`\n' +
          '• `.autopp now`\n' +
          '• `.autopp off`'
      }, { quoted: message });
    }

    const safeH = clamp(hours, 1, 168);
    const next = {
      ...cfg,
      enabled: true,
      mode: 'fixed',
      hours: safeH,
      minutes: 0,
    };

    await setCfg(next);
    await startAutoPP(sock);

    return sock.sendMessage(chatId, {
      text: `✅ AutoPP enabled\n• Interval: every ${safeH} hour(s)\n• Query: ${next.query}`
    }, { quoted: message });
  }
};

/**
 * AntiCall Plugin (Baileys / WhiskeySockets)
 * ------------------------------------------
 * Command:
 *   .anticall on/off/status
 *
 * What this improves vs your old version:
 * ✅ Fix: ensures ./data/ exists, uses absolute path (no path issues)
 * ✅ Fix: safer JSON read/write (no crash on empty/corrupt file)
 * ✅ Better: caching in memory (less disk/DB hits)
 * ✅ Better: supports "enable/disable/1/0/true/false"
 * ✅ Better: nicer messages + shows storage
 * ✅ Exports: readState/writeState for other modules
 *
 * IMPORTANT (to actually block calls):
 * You MUST call module.onCall(sock, callUpdate) inside your `call` event handler.
 * Example:
 *   sock.ev.on('call', async (calls) => {
 *     for (const c of calls) await anticall.onCall(sock, c);
 *   });
 */

const fs = require('fs');
const path = require('path');
const store = require('../lib/lightweight_store');

const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

const DATA_DIR = path.join(process.cwd(), 'data');
const ANTICALL_PATH = path.join(DATA_DIR, 'anticall.json');

// simple in-memory cache
let CACHE = { enabled: false, loadedAt: 0 };
const CACHE_TTL_MS = 10_000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeJsonParse(text, fallback = {}) {
  try {
    const t = String(text || '').trim();
    if (!t) return fallback;
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

async function readState(force = false) {
  try {
    const now = Date.now();
    if (!force && (now - CACHE.loadedAt) < CACHE_TTL_MS) return { ...CACHE };

    let enabled = false;

    if (HAS_DB) {
      const settings = await store.getSetting('global', 'anticall');
      enabled = !!settings?.enabled;
    } else {
      ensureDataDir();
      if (!fs.existsSync(ANTICALL_PATH)) {
        enabled = false;
      } else {
        const raw = fs.readFileSync(ANTICALL_PATH, 'utf8');
        const data = safeJsonParse(raw, {});
        enabled = !!data.enabled;
      }
    }

    CACHE = { enabled, loadedAt: now };
    return { enabled };
  } catch (e) {
    // fallback to cache if we have it
    return { enabled: !!CACHE.enabled };
  }
}

async function writeState(enabled) {
  const val = !!enabled;
  try {
    if (HAS_DB) {
      await store.saveSetting('global', 'anticall', { enabled: val });
    } else {
      ensureDataDir();
      fs.writeFileSync(ANTICALL_PATH, JSON.stringify({ enabled: val }, null, 2));
    }
    CACHE = { enabled: val, loadedAt: Date.now() };
    return true;
  } catch (e) {
    console.error('Error writing anticall state:', e);
    return false;
  }
}

function parseToggle(input = '') {
  const s = String(input).trim().toLowerCase();
  if (!s) return { type: 'help' };
  if (['status', 'st'].includes(s)) return { type: 'status' };
  if (['on', 'enable', 'enabled', '1', 'true', 'yes', 'y'].includes(s)) return { type: 'set', value: true };
  if (['off', 'disable', 'disabled', '0', 'false', 'no', 'n'].includes(s)) return { type: 'set', value: false };
  return { type: 'help' };
}

/**
 * Call handler to block/reject calls.
 * Wire this into: sock.ev.on('call', ...)
 *
 * Works for most Baileys builds:
 * - Reject call
 * - Block caller
 */
async function onCall(sock, callUpdate) {
  try {
    const state = await readState();
    if (!state.enabled) return;

    // Different builds expose fields slightly differently
    const from = callUpdate?.from || callUpdate?.chatId || callUpdate?.callerId;
    const status = callUpdate?.status;

    // We only act on incoming "offer"/"ringing"
    const isIncoming =
      status === 'offer' ||
      status === 'ringing' ||
      callUpdate?.isVideo !== undefined || // many incoming updates include isVideo
      !!from;

    if (!isIncoming || !from) return;

    // Reject call (if supported)
    // Some builds: sock.rejectCall(callUpdate.id, from)
    // Others: sock.rejectCall(from, callUpdate.id)
    try {
      if (typeof sock.rejectCall === 'function') {
        await sock.rejectCall(callUpdate.id || callUpdate.callId, from);
      }
    } catch {}

    // Block user (if supported)
    try {
      if (typeof sock.updateBlockStatus === 'function') {
        await sock.updateBlockStatus(from, 'block');
      }
    } catch {}

    // Optional: notify caller (can be noisy)
    // try { await sock.sendMessage(from, { text: '📵 Calls are blocked. Please message instead.' }); } catch {}
  } catch (e) {
    console.error('AntiCall onCall error:', e);
  }
}

module.exports = {
  command: 'anticall',
  aliases: ['acall', 'callblock'],
  category: 'owner',
  description: 'Enable/disable auto-reject + auto-block incoming calls',
  usage: '.anticall <on|off|status>',
  ownerOnly: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const subRaw = args.join(' ').trim();
    const parsed = parseToggle(subRaw);
    const state = await readState(true);

    const storageText = HAS_DB ? 'Database' : 'File System';
    const statusText = state.enabled ? '✅ ENABLED' : '❌ DISABLED';

    if (parsed.type === 'help') {
      return await sock.sendMessage(
        chatId,
        {
          text:
            '*📵 ANTICALL SETTINGS*\n\n' +
            'Auto-reject + auto-block incoming WhatsApp calls.\n\n' +
            '*Usage:*\n' +
            '• `.anticall on` - Enable\n' +
            '• `.anticall off` - Disable\n' +
            '• `.anticall status` - Show status\n\n' +
            `*Current:* ${statusText}\n` +
            `*Storage:* ${storageText}\n\n` +
            '_Note: make sure your main file wires the call event to this plugin._'
        },
        { quoted: message }
      );
    }

    if (parsed.type === 'status') {
      return await sock.sendMessage(
        chatId,
        {
          text:
            `📵 *Anticall Status*\n\n` +
            `Current: ${state.enabled ? '✅ *ENABLED*' : '❌ *DISABLED*'}\n` +
            `Storage: ${storageText}\n\n` +
            (state.enabled
              ? 'Incoming calls will be rejected and caller will be blocked.'
              : 'Incoming calls are allowed.')
        },
        { quoted: message }
      );
    }

    // set on/off
    const ok = await writeState(parsed.value);
    const newState = await readState(true);

    return await sock.sendMessage(
      chatId,
      {
        text:
          `📵 *Anticall ${newState.enabled ? 'ENABLED' : 'DISABLED'}*\n\n` +
          (ok
            ? (newState.enabled
                ? '✅ Incoming calls will now be rejected and blocked automatically.'
                : '❌ Incoming calls are now allowed.')
            : '⚠️ Could not save setting (storage error). Check console logs.')
      },
      { quoted: message }
    );
  },

  // exports for main handler
  readState,
  writeState,
  onCall
};

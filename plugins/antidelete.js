const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { writeFile } = require('fs/promises');
const store = require('../lib/lightweight_store');

// Optional settings owner number support (won't crash if missing)
let settings = {};
try {
  // eslint-disable-next-line import/no-unresolved
  settings = require('../settings');
} catch {}

// -------------------------
// ENV / STORAGE DETECTION
// -------------------------
const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

// -------------------------
// PATHS
// -------------------------
const DATA_DIR = path.join(process.cwd(), 'data');
const TMP_DIR = path.join(process.cwd(), 'tmp');
const CONFIG_PATH = path.join(DATA_DIR, 'antidelete.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(TMP_DIR);

// -------------------------
// SAFE JSON
// -------------------------
function safeJsonParse(text, fallback = {}) {
  try {
    const t = String(text || '').trim();
    if (!t) return fallback;
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

// -------------------------
// TEMP CLEANUP (AGE + SIZE)
// -------------------------
const TMP_MAX_MB = 200;
const TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function folderSizeMB(folderPath) {
  try {
    const files = fs.readdirSync(folderPath);
    let total = 0;
    for (const f of files) {
      const fp = path.join(folderPath, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile()) total += st.size;
      } catch {}
    }
    return total / (1024 * 1024);
  } catch {
    return 0;
  }
}

function cleanupTmp() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TMP_DIR);

    // Remove old files first
    for (const f of files) {
      const fp = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
          fs.unlinkSync(fp);
        }
      } catch {}
    }

    // If still too large, delete oldest
    let size = folderSizeMB(TMP_DIR);
    if (size <= TMP_MAX_MB) return;

    const list = fs
      .readdirSync(TMP_DIR)
      .map((f) => {
        const fp = path.join(TMP_DIR, f);
        try {
          const st = fs.statSync(fp);
          return { fp, mtime: st.mtimeMs, ok: st.isFile() };
        } catch {
          return { fp, mtime: 0, ok: false };
        }
      })
      .filter((x) => x.ok)
      .sort((a, b) => a.mtime - b.mtime);

    for (const item of list) {
      try {
        fs.unlinkSync(item.fp);
      } catch {}
      size = folderSizeMB(TMP_DIR);
      if (size <= TMP_MAX_MB) break;
    }
  } catch (err) {
    console.error('Temp cleanup error:', err);
  }
}

setInterval(cleanupTmp, 60 * 1000);

// -------------------------
// CONFIG (DB or FILE)
// -------------------------
async function loadAntideleteConfig() {
  try {
    if (HAS_DB) {
      const cfg = await store.getSetting('global', 'antidelete_cfg');
      return cfg || { enabled: false };
    }

    if (!fs.existsSync(CONFIG_PATH)) return { enabled: false };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = safeJsonParse(raw, { enabled: false });
    return { enabled: !!cfg.enabled };
  } catch {
    return { enabled: false };
  }
}

async function saveAntideleteConfig(config) {
  try {
    const cfg = { enabled: !!config?.enabled };
    if (HAS_DB) {
      await store.saveSetting('global', 'antidelete_cfg', cfg);
    } else {
      ensureDir(DATA_DIR);
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    }
  } catch (err) {
    console.error('Config save error:', err);
  }
}

// -------------------------
// BOUNDED MESSAGE STORE
// -------------------------
const MAX_STORE = 3000;
const messageStore = new Map();

function makeMsgKey(remoteJid, id) {
  const jid = remoteJid || 'unknown';
  const mid = id || 'noid';
  return `${jid}:${mid}`;
}

function storeBounded(key, value) {
  messageStore.set(key, value);
  if (messageStore.size <= MAX_STORE) return;

  const over = messageStore.size - MAX_STORE;
  const it = messageStore.keys();
  for (let i = 0; i < over; i++) {
    const k = it.next().value;
    if (!k) break;
    const v = messageStore.get(k);
    if (v?.mediaPath) {
      try {
        if (fs.existsSync(v.mediaPath)) fs.unlinkSync(v.mediaPath);
      } catch {}
    }
    messageStore.delete(k);
  }
}

// -------------------------
// HELPERS
// -------------------------
async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

function normalizeNumberToJid(num) {
  const n = String(num || '').replace(/[^0-9]/g, '');
  return n ? `${n}@s.whatsapp.net` : null;
}

function getOwnerJid(sock) {
  const ownerCandidate =
    (Array.isArray(settings.owner) && settings.owner[0]) ||
    settings.OWNER_NUMBER ||
    settings.ownerNumber ||
    settings.owner_number;

  const fromSettings = normalizeNumberToJid(ownerCandidate);
  if (fromSettings) return fromSettings;

  // fallback: bot number
  const raw = sock?.user?.id || '';
  const num = raw.split(':')[0];
  return num ? `${num}@s.whatsapp.net` : null;
}

function extractText(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  );
}

function unwrapEphemeral(message) {
  return message?.message?.ephemeralMessage?.message || null;
}

function extractViewOnceContainer(message) {
  const m = message?.message;
  // direct
  const direct =
    m?.viewOnceMessageV2?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2Extension?.message ||
    null;
  if (direct) return direct;

  // inside ephemeral
  const e = m?.ephemeralMessage?.message;
  return (
    e?.viewOnceMessageV2?.message ||
    e?.viewOnceMessage?.message ||
    e?.viewOnceMessageV2Extension?.message ||
    null
  );
}

async function downloadMediaToFile(node, type, outPath) {
  const stream = await downloadContentFromMessage(node, type);
  const buffer = await streamToBuffer(stream);
  await writeFile(outPath, buffer);
  return outPath;
}

function safeFileKey(chatJid, messageId) {
  return `${String(chatJid || 'chat').replace(/[^a-z0-9]/gi, '_')}_${String(messageId || 'id')}`;
}

// -------------------------
// STORE MESSAGE (call on every messages.upsert)
// -------------------------
async function storeMessage(sock, message) {
  try {
    const cfg = await loadAntideleteConfig();
    const globalEnabled = await store.getSetting('global', 'antidelete');
    const enabled = !!(cfg.enabled || globalEnabled);
    if (!enabled) return;

    if (!message?.key?.id || !message?.message) return;

    const messageId = message.key.id;
    const chatJid = message.key.remoteJid;
    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = String(chatJid || '').endsWith('@g.us');

    let content = '';
    let mediaType = '';
    let mediaPath = '';

    // -------- ViewOnce capture (auto-forward to owner) --------
    const globalSettings = (await store.getAllSettings?.('global').catch(() => ({}))) || {};
    const antiviewonceEnabled = !!globalSettings.antiviewonce;

    const vo = extractViewOnceContainer(message);
    if (vo && antiviewonceEnabled) {
      let voType = null;
      let node = null;

      if (vo.imageMessage) {
        voType = 'image';
        node = vo.imageMessage;
        content = node.caption || '';
        mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.jpg`);
        await downloadMediaToFile(node, 'image', mediaPath);
      } else if (vo.videoMessage) {
        voType = 'video';
        node = vo.videoMessage;
        content = node.caption || '';
        mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.mp4`);
        await downloadMediaToFile(node, 'video', mediaPath);
      }

      if (voType && mediaPath && fs.existsSync(mediaPath)) {
        const ownerJid = getOwnerJid(sock);
        const senderName = (sender || '').split('@')[0];
        const cap = `*Anti-ViewOnce ${voType.toUpperCase()}*\nFrom: @${senderName}`;

        try {
          if (ownerJid) {
            if (voType === 'image') {
              await sock.sendMessage(ownerJid, { image: { url: mediaPath }, caption: cap, mentions: [sender] });
            } else {
              await sock.sendMessage(ownerJid, { video: { url: mediaPath }, caption: cap, mentions: [sender] });
            }
          }
        } catch {}
        finally {
          try { fs.unlinkSync(mediaPath); } catch {}
        }

        // Do not store VO content for antidelete (already handled)
        return;
      }
    }

    // -------- Normal message capture (text + media) --------
    content = extractText(message);

    const unwrapped = unwrapEphemeral(message);
    const m = unwrapped || message.message;

    if (m?.imageMessage) {
      mediaType = 'image';
      const node = m.imageMessage;
      content = node.caption || content;
      mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.jpg`);
      await downloadMediaToFile(node, 'image', mediaPath);
    } else if (m?.videoMessage) {
      mediaType = 'video';
      const node = m.videoMessage;
      content = node.caption || content;
      mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.mp4`);
      await downloadMediaToFile(node, 'video', mediaPath);
    } else if (m?.stickerMessage) {
      mediaType = 'sticker';
      const node = m.stickerMessage;
      mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.webp`);
      await downloadMediaToFile(node, 'sticker', mediaPath);
    } else if (m?.audioMessage) {
      mediaType = 'audio';
      const node = m.audioMessage;
      const mime = node.mimetype || '';
      const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'mp3';
      mediaPath = path.join(TMP_DIR, `${safeFileKey(chatJid, messageId)}.${ext}`);
      await downloadMediaToFile(node, 'audio', mediaPath);
    }

    if (!content && !mediaPath) return;

    const key = makeMsgKey(chatJid, messageId);
    storeBounded(key, {
      content,
      mediaType,
      mediaPath,
      sender,
      chatJid,
      isGroup,
      timestamp: Date.now(),
      audioMime: m?.audioMessage?.mimetype || undefined
    });
  } catch (err) {
    console.error('storeMessage error:', err);
  }
}

// -------------------------
// HANDLE REVOCATION (protocolMessage REVOKE)
// Call this when msg.message.protocolMessage?.type === 0
// -------------------------
async function handleMessageRevocation(sock, revocationMessage) {
  try {
    const cfg = await loadAntideleteConfig();
    const globalEnabled = await store.getSetting('global', 'antidelete');
    const enabled = !!(cfg.enabled || globalEnabled);
    if (!enabled) return;

    const proto = revocationMessage?.message?.protocolMessage;
    if (!proto?.key?.id) return;

    const ownerJid = getOwnerJid(sock);
    if (!ownerJid) return;

    const deletedKey = proto.key;
    const deletedId = deletedKey.id;
    const chatJid = revocationMessage.key.remoteJid;

    // Who deleted
    const deletedBy = deletedKey.participant || deletedKey.remoteJid;

    // Ignore deletions by the bot
    const botNum = String(sock?.user?.id || '').split(':')[0];
    if (deletedBy && botNum && String(deletedBy).includes(botNum)) return;

    // Lookup original
    const lookupKey = makeMsgKey(deletedKey.remoteJid || chatJid, deletedId);
    const original = messageStore.get(lookupKey);
    if (!original) return;

    const sender = original.sender;
    const senderName = (sender || '').split('@')[0];
    const deletedByName = (deletedBy || '').split('@')[0];

    let groupName = '';
    if (original.isGroup) {
      try {
        const meta = await sock.groupMetadata(original.chatJid);
        groupName = meta?.subject || '';
      } catch {}
    }

    const time = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Colombo',
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    let text =
      `*🔰 ANTIDELETE REPORT 🔰*\n\n` +
      `*🗑️ Deleted By:* @${deletedByName}\n` +
      `*👤 Sender:* @${senderName}\n` +
      `*🕒 Time:* ${time}\n`;

    if (groupName) text += `*👥 Group:* ${groupName}\n`;

    if (original.content) {
      text += `\n*💬 Deleted Message:*\n${original.content}`;
    }

    await sock.sendMessage(ownerJid, {
      text,
      mentions: [deletedBy, sender].filter(Boolean)
    });

    // Send media if exists
    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
      try {
        switch (original.mediaType) {
          case 'image':
            await sock.sendMessage(ownerJid, {
              image: { url: original.mediaPath },
              caption: `*Deleted image*\nFrom: @${senderName}`,
              mentions: [sender]
            });
            break;
          case 'video':
            await sock.sendMessage(ownerJid, {
              video: { url: original.mediaPath },
              caption: `*Deleted video*\nFrom: @${senderName}`,
              mentions: [sender]
            });
            break;
          case 'sticker':
            await sock.sendMessage(ownerJid, { sticker: { url: original.mediaPath } });
            break;
          case 'audio': {
            const mime = original.audioMime || 'audio/mpeg';
            await sock.sendMessage(ownerJid, {
              audio: { url: original.mediaPath },
              mimetype: mime,
              ptt: false
            });
            break;
          }
        }
      } catch (err) {
        try {
          await sock.sendMessage(ownerJid, { text: `⚠️ Error sending media: ${err?.message || err}` });
        } catch {}
      } finally {
        try { fs.unlinkSync(original.mediaPath); } catch {}
      }
    }

    messageStore.delete(lookupKey);
  } catch (err) {
    console.error('handleMessageRevocation error:', err);
  }
}

// -------------------------
// COMMAND
// -------------------------
module.exports = {
  command: 'antidelete',
  aliases: ['antidel', 'adel'],
  category: 'owner',
  description: 'Enable or disable antidelete feature to track deleted messages',
  usage: '.antidelete <on|off>',
  ownerOnly: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const action = (args[0] || '').toLowerCase().trim();

    const config = await loadAntideleteConfig();

    if (!action) {
      return sock.sendMessage(
        chatId,
        {
          text:
            `*🔰 ANTIDELETE SETUP 🔰*\n\n` +
            `*Current Status:* ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
            `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n\n` +
            `*Commands:*\n` +
            `• \`.antidelete on\` - Enable\n` +
            `• \`.antidelete off\` - Disable\n\n` +
            `*Features:*\n` +
            `• Track deleted messages\n` +
            `• Save deleted media\n` +
            `• (Optional) Anti-ViewOnce if global antiviewonce is enabled\n` +
            `• Reports to owner`
        },
        { quoted: message }
      );
    }

    if (action === 'on') {
      config.enabled = true;
      await saveAntideleteConfig(config);
      // keep legacy boolean too, so other parts of your bot can read it
      try { await store.saveSetting('global', 'antidelete', true); } catch {}

      return sock.sendMessage(
        chatId,
        {
          text:
            `✅ *Antidelete enabled!*\n\n` +
            `Storage: ${HAS_DB ? 'Database' : 'File System'}\n` +
            `• Tracking messages now.`
        },
        { quoted: message }
      );
    }

    if (action === 'off') {
      config.enabled = false;
      await saveAntideleteConfig(config);
      try { await store.saveSetting('global', 'antidelete', false); } catch {}

      return sock.sendMessage(
        chatId,
        { text: `❌ *Antidelete disabled!*\n\nThe bot will no longer track deleted messages.` },
        { quoted: message }
      );
    }

    return sock.sendMessage(
      chatId,
      { text: '❌ *Invalid command*\nUse: `.antidelete on` or `.antidelete off`' },
      { quoted: message }
    );
  },

  handleMessageRevocation,
  storeMessage,
  loadAntideleteConfig,
  saveAntideleteConfig
};


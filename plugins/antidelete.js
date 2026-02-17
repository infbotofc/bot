/**
 * AntiDelete + AntiViewOnce (Baileys / WhiskeySockets)
 * ---------------------------------------------------
 * Drop-in plugin file.
 *
 * REQUIRED WIRING:
 * 1) In messages.upsert: call plugin.storeMessage(sock, msg)
 * 2) In messages.upsert: when you receive protocolMessage REVOKE, call plugin.handleMessageRevocation(sock, msg)
 *
 * Example wiring:
 * sock.ev.on('messages.upsert', async ({ messages }) => {
 *   for (const msg of messages) {
 *     await antidelete.storeMessage(sock, msg);
 *     if (msg?.message?.protocolMessage?.type === 0) {
 *       await antidelete.handleMessageRevocation(sock, msg);
 *     }
 *   }
 * })
 */

const fs = require('fs');
const path = require('path');
const { writeFile } = require('fs/promises');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const store = require('../lib/lightweight_store');
const settings = (() => {
  try {
    // Optional (if you have settings.js with owner info)
    // Expected: settings.owner = ['9477xxxxxxx'] OR settings.OWNER_NUMBER = '9477xxxxxxx'
    // If not present, it will just be ignored.
    // eslint-disable-next-line import/no-unresolved
    return require('../settings');
  } catch {
    return {};
  }
})();

// --------- ENV / STORAGE DETECTION ---------
const HAS_DB = !!(
  process.env.MONGO_URL ||
  process.env.POSTGRES_URL ||
  process.env.MYSQL_URL ||
  process.env.DB_URL
);

// --------- PATHS ---------
const DATA_DIR = path.join(process.cwd(), 'data');
const TMP_DIR = path.join(process.cwd(), 'tmp');
const CONFIG_PATH = path.join(DATA_DIR, 'antidelete.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(TMP_DIR);

// --------- SAFE JSON ---------
function safeJsonParse(text, fallback = {}) {
  try {
    const t = String(text || '').trim();
    if (!t) return fallback;
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

// --------- TEMP CLEANUP ---------
const TMP_MAX_MB = 200;
const TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function folderSizeMB(folder) {
  try {
    const files = fs.readdirSync(folder);
    let total = 0;
    for (const f of files) {
      const fp = path.join(folder, f);
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
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();

    // 1) Remove old files
    for (const f of files) {
      const fp = path.join(TMP_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && now - st.mtimeMs > TMP_MAX_AGE_MS) {
          fs.unlinkSync(fp);
        }
      } catch {}
    }

    // 2) If still too large, remove oldest first
    let size = folderSizeMB(TMP_DIR);
    if (size <= TMP_MAX_MB) return;

    const list = fs
      .readdirSync(TMP_DIR)
      .map((f) => {
        const fp = path.join(TMP_DIR, f);
        try {
          const st = fs.statSync(fp);
          return { fp, mtime: st.mtimeMs, size: st.size, ok: st.isFile() };
        } catch {
          return { fp, mtime: 0, size: 0, ok: false };
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
  } catch (e) {
    console.error('Tmp cleanup error:', e);
  }
}

setInterval(cleanupTmp, 60 * 1000);

// --------- SETTINGS (CACHED) ---------
let SETTINGS_CACHE = null;
let SETTINGS_CACHE_AT = 0;
const SETTINGS_TTL_MS = 8000;

async function getGlobalSettings() {
  const now = Date.now();
  if (SETTINGS_CACHE && now - SETTINGS_CACHE_AT < SETTINGS_TTL_MS) return SETTINGS_CACHE;

  let all = {};
  try {
    // Your lightweight_store should provide this; if not, it will just be {}
    all = await store.getAllSettings('global');
  } catch {
    all = {};
  }

  SETTINGS_CACHE = all || {};
  SETTINGS_CACHE_AT = now;
  return SETTINGS_CACHE;
}

// --------- CONFIG (DB or FILE) ---------
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
  } catch (e) {
    console.error('Config save error:', e);
  }
}

// --------- MESSAGE STORE (BOUNDED) ---------
const MAX_STORE = 3000;
const messageStore = new Map();

function makeMsgKey(msg, overrideRemoteJid) {
  const jid = overrideRemoteJid || msg?.key?.remoteJid || 'unknown';
  const id = msg?.key?.id || 'noid';
  return `${jid}:${id}`;
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

// --------- HELPERS ---------
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
  // 1) If settings has owner
  const ownerCandidate =
    (Array.isArray(settings.owner) && settings.owner[0]) ||
    settings.OWNER_NUMBER ||
    settings.ownerNumber ||
    settings.owner_number;
  const fromSettings = normalizeNumberToJid(ownerCandidate);
  if (fromSettings) return fromSettings;

  // 2) fallback: bot itself (useful for single-number self-bots)
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
  // Sometimes WhatsApp wraps content in ephemeralMessage
  return (
    message?.message?.ephemeralMessage?.message ||
    message?.message?.viewOnceMessageV2?.message ||
    message?.message?.viewOnceMessage?.message ||
    message?.message?.viewOnceMessageV2Extension?.message ||
    null
  );
}

function extractViewOnceContainer(message) {
  const m = message?.message;
  return (
    m?.viewOnceMessageV2?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2Extension?.message ||
    // If VO is wrapped inside ephemeral
    m?.ephemeralMessage?.message?.viewOnceMessageV2?.message ||
    m?.ephemeralMessage?.message?.viewOnceMessage?.message ||
    m?.ephemeralMessage?.message?.viewOnceMessageV2Extension?.message ||
    null
  );
}

async function downloadMediaToFile(msgNode, type, outPath) {
  const stream = await downloadContentFromMessage(msgNode, type);
  const buffer = await streamToBuffer(stream);
  await writeFile(outPath, buffer);
  return outPath;
}

function safeFileKey(chatJid, messageId) {
  return `${String(chatJid || 'chat').replace(/[^a-z0-9]/gi, '_')}_${String(messageId || 'id')}`;
}

// --------- STORE MESSAGE ---------
async function storeMessage(sock, message) {
  try {
    if (!message?.key?.id || !message?.message) return;

    const globalSettings = await getGlobalSettings();
    const cfg = await loadAntideleteConfig();

    // Support both file/db config and globalSettings.antidelete boolean
    const antideleteEnabled = !!(cfg.enabled || globalSettings.antidelete);
    const antiviewonceEnabled = !!globalSettings.antiviewonce;

    if (!antideleteEnabled && !antiviewonceEnabled) return;

    const messageId = message.key.id;
    const chatJid = message.key.remoteJid;
    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = String(chatJid || '').endsWith('@g.us');

    // antidelete_mode: owner/chat/private
    const antideleteMode = globalSettings.antidelete_mode || 'owner';
    if (antideleteMode === 'private' && isGroup) return;

    let content = '';
    let mediaType = '';
    let mediaPath = '';

    // ---- ViewOnce handling (if enabled) ----
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
        const mode = globalSettings.antiviewonce_mode || 'owner'; // owner/chat/warn
        const ownerJid = getOwnerJid(sock);
        const senderName = (sender || '').split('@')[0];

        const reportText =
          `*🌟 ANTI-VIEWONCE DETECTED 🌟*\n\n` +
          `*👤 From:* @${senderName}\n` +
          `*🕒 Type:* ${voType.toUpperCase()}\n` +
          `*📅 Time:* ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;

        try {
          if (mode === 'warn') {
            const oldWarn = (await store.getSetting(sender, 'viewonce_warns')) || 0;
            const newWarn = Number(oldWarn) + 1;
            await store.saveSetting(sender, 'viewonce_warns', newWarn);

            await sock.sendMessage(chatJid, {
              text:
                `*⚠️ VIEWONCE WARNING ⚠️*\n\n` +
                `@${senderName}, ViewOnce media is not allowed! Warning *${newWarn}/3*.\n` +
                `_Media detected and logged._`,
              mentions: [sender]
            });

            if (newWarn >= 3) {
              await sock.sendMessage(chatJid, {
                text: `❌ @${senderName} reached 3 warnings and will be blocked.`,
                mentions: [sender]
              });
              try {
                await sock.updateBlockStatus(sender, 'block');
              } catch {}
            }
          } else {
            const target = mode === 'chat' ? chatJid : ownerJid;
            if (!target) return;

            const base = {
              caption: `${reportText}\n\n> 💫 *INFINITY MD BOT*`,
              mentions: [sender]
            };

            if (voType === 'image') {
              await sock.sendMessage(target, { image: { url: mediaPath }, ...base });
            } else {
              await sock.sendMessage(target, { video: { url: mediaPath }, ...base });
            }
          }
        } catch (e) {
          console.error('Anti-viewOnce handler error:', e);
        } finally {
          try {
            fs.unlinkSync(mediaPath);
          } catch {}
        }

        // Do NOT store VO message (already handled)
        return;
      }
    }

    // ---- Normal message types (for antidelete) ----
    content = extractText(message);

    // Unwrap ephemeral if needed (some media is under ephemeralMessage)
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

    const key = makeMsgKey(message);
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
  } catch (e) {
    console.error('storeMessage error:', e);
  }
}

// --------- HANDLE REVOCATION ---------
async function handleMessageRevocation(sock, revocationMessage) {
  try {
    const proto = revocationMessage?.message?.protocolMessage;
    if (!proto?.key?.id) return;

    const globalSettings = await getGlobalSettings();
    const cfg = await loadAntideleteConfig();
    if (!(cfg.enabled || globalSettings.antidelete)) return;

    const mode = globalSettings.antidelete_mode || 'owner'; // owner/chat/private

    const ownerJid = getOwnerJid(sock);
    const chatJid = revocationMessage.key.remoteJid;

    const deletedKey = proto.key;
    const deletedId = deletedKey.id;

    // In groups, participant who deleted may be proto.key.participant
    const deletedBy = deletedKey.participant || deletedKey.remoteJid;

    // Ignore deletions by the bot itself
    const botNum = String(sock?.user?.id || '').split(':')[0];
    if (deletedBy && botNum && String(deletedBy).includes(botNum)) return;

    // IMPORTANT: stored key uses original remoteJid
    const lookupKey = `${deletedKey.remoteJid || chatJid}:${deletedId}`;
    const original = messageStore.get(lookupKey);
    if (!original) return;

    if (mode === 'private' && original.isGroup) return;

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

    // Decide report target
    // owner: owner only
    // chat: report to group if group else owner (avoids DM loops)
    // private: owner only
    const reportTarget = mode === 'chat' && original.isGroup ? original.chatJid : ownerJid;

    if (reportTarget) {
      await sock.sendMessage(reportTarget, {
        text,
        mentions: [deletedBy, sender].filter(Boolean)
      });
    }

    // Resend text in chat only if mode === chat
    if (mode === 'chat' && original.content) {
      await sock.sendMessage(original.chatJid, {
        text:
          `*🔰 ANTIDELETE RESEND 🔰*\n\n` +
          `*👤 From:* @${senderName}\n` +
          `*💬 Message:* ${original.content}`,
        mentions: [sender]
      });
    }

    // Media resend/report
    if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
      const capBase = `*Deleted ${original.mediaType}*\nFrom: @${senderName}`;

      const sendTo = async (jid, isChatResend) => {
        if (!jid) return;
        switch (original.mediaType) {
          case 'image':
            return sock.sendMessage(jid, {
              image: { url: original.mediaPath },
              caption: isChatResend ? `*🔰 ANTIDELETE RESEND 🔰*\n\n${capBase}` : capBase,
              mentions: [sender]
            });
          case 'video':
            return sock.sendMessage(jid, {
              video: { url: original.mediaPath },
              caption: isChatResend ? `*🔰 ANTIDELETE RESEND 🔰*\n\n${capBase}` : capBase,
              mentions: [sender]
            });
          case 'sticker':
            return sock.sendMessage(jid, { sticker: { url: original.mediaPath } });
          case 'audio': {
            const mime = original.audioMime || 'audio/mpeg';
            return sock.sendMessage(jid, {
              audio: { url: original.mediaPath },
              mimetype: mime,
              ptt: false
            });
          }
          default:
            return;
        }
      };

      try {
        // Always send media to owner (so you get it even if chat mode)
        await sendTo(ownerJid, false);

        // If chat mode, resend in original chat too
        if (mode === 'chat') {
          await sendTo(original.chatJid, true);
        }
      } catch (e) {
        if (ownerJid) {
          try {
            await sock.sendMessage(ownerJid, { text: `⚠️ Error sending media: ${e.message || e}` });
          } catch {}
        }
      } finally {
        try {
          fs.unlinkSync(original.mediaPath);
        } catch {}
      }
    }

    messageStore.delete(lookupKey);
  } catch (e) {
    console.error('handleMessageRevocation error:', e);
  }
}

// --------- COMMAND (OWNER) ---------
module.exports = {
  command: 'antidelete',
  aliases: ['antidel', 'adel'],
  category: 'owner',
  description: 'Enable/disable antidelete & set report mode',
  usage: '.antidelete <on|off|owner|chat|private>',
  ownerOnly: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const action = (args[0] || '').toLowerCase().trim();

    const globalSettings = await getGlobalSettings();

    if (!action) {
      const status = globalSettings.antidelete ? '✅ Enabled' : '❌ Disabled';
      const currentMode = (globalSettings.antidelete_mode || 'owner').toUpperCase();
      const voMode = (globalSettings.antiviewonce_mode || 'owner').toUpperCase();

      return sock.sendMessage(
        chatId,
        {
          text:
            `*🔰 ANTIDELETE SETUP 🔰*\n\n` +
            `*Status:* ${status}\n` +
            `*Mode:* ${currentMode}\n` +
            `*Storage:* ${HAS_DB ? 'Database' : 'File'}\n\n` +
            `*Commands:*\n` +
            `• \`.antidelete on\` - Enable\n` +
            `• \`.antidelete off\` - Disable\n` +
            `• \`.antidelete owner\` - Reports to your inbox only\n` +
            `• \`.antidelete chat\` - Reports + resend in original chat\n` +
            `• \`.antidelete private\` - Track only private chats\n\n` +
            `*Anti-ViewOnce Mode:* ${voMode}\n` +
            `• Use \`.antiviewonce <owner|chat|warn>\` to change.`
        },
        { quoted: message }
      );
    }

    if (['owner', 'chat', 'private'].includes(action)) {
      await store.saveSetting('global', 'antidelete_mode', action);
      await store.saveSetting('global', 'antidelete', true);
      await saveAntideleteConfig({ enabled: true });
      return sock.sendMessage(chatId, { text: `✅ *Antidelete set to ${action.toUpperCase()} mode!*` }, { quoted: message });
    }

    if (action === 'on') {
      await store.saveSetting('global', 'antidelete', true);
      await saveAntideleteConfig({ enabled: true });
      return sock.sendMessage(chatId, { text: '✅ *Antidelete enabled!*' }, { quoted: message });
    }

    if (action === 'off') {
      await store.saveSetting('global', 'antidelete', false);
      await saveAntideleteConfig({ enabled: false });
      return sock.sendMessage(chatId, { text: '❌ *Antidelete disabled!*' }, { quoted: message });
    }

    return sock.sendMessage(chatId, { text: '❌ *Invalid option!*\nUse: `on`, `off`, `owner`, `chat`, or `private`' }, { quoted: message });
  },

  // exports for main bot
  handleMessageRevocation,
  storeMessage,
  loadAntideleteConfig,
  saveAntideleteConfig
};

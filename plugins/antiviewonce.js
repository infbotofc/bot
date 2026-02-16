/**
 * Anti-ViewOnce Plugin (Baileys / WhiskeySockets)
 * ------------------------------------------------
 * - Tracks viewOnce (image/video) and forwards media to the bot owner.
 * - Toggle with .antiviewonce on/off
 * - Uses the same storage pattern as your antidelete plugin (DB via lightweight_store OR JSON file)
 * - Includes temp folder size cleanup.
 *
 * IMPORTANT:
 * 1) You MUST call `storeMessage(sock, msg)` from your messages.upsert handler.
 * 2) This file does NOT handle deleted messages. It's only for viewOnce.
 */

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { writeFile } = require('fs/promises');
const store = require('../lib/lightweight_store');

// In-memory cache (optional; useful if you want to add extra logic later)
const messageStore = new Map();

const CONFIG_PATH = path.join(__dirname, '../data/antiviewonce.json');
const TEMP_MEDIA_DIR = path.join(__dirname, '../tmp');

const MONGO_URL = process.env.MONGO_URL;
const POSTGRES_URL = process.env.POSTGRES_URL;
const MYSQL_URL = process.env.MYSQL_URL;
const SQLITE_URL = process.env.DB_URL;
const HAS_DB = !!(MONGO_URL || POSTGRES_URL || MYSQL_URL || SQLITE_URL);

if (!fs.existsSync(TEMP_MEDIA_DIR)) {
  fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}

// ---------- Temp cleanup (same style as your antidelete) ----------
const getFolderSizeInMB = (folderPath) => {
  try {
    const files = fs.readdirSync(folderPath);
    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      if (fs.statSync(filePath).isFile()) {
        totalSize += fs.statSync(filePath).size;
      }
    }
    return totalSize / (1024 * 1024);
  } catch (err) {
    console.error('Error getting folder size:', err);
    return 0;
  }
};

const cleanTempFolderIfLarge = () => {
  try {
    const sizeMB = getFolderSizeInMB(TEMP_MEDIA_DIR);
    if (sizeMB > 200) {
      const files = fs.readdirSync(TEMP_MEDIA_DIR);
      for (const file of files) {
        const filePath = path.join(TEMP_MEDIA_DIR, file);
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  } catch (err) {
    console.error('Temp cleanup error:', err);
  }
};

setInterval(cleanTempFolderIfLarge, 60 * 1000);

// ---------- Config storage (DB or JSON file) ----------
async function loadAntiViewOnceConfig() {
  try {
    if (HAS_DB) {
      const config = await store.getSetting('global', 'antiviewonce');
      return config || { enabled: false, notifyOwnerOnly: true };
    }

    if (!fs.existsSync(CONFIG_PATH)) return { enabled: false, notifyOwnerOnly: true };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { enabled: false, notifyOwnerOnly: true };
  }
}

async function saveAntiViewOnceConfig(config) {
  try {
    if (HAS_DB) {
      await store.saveSetting('global', 'antiviewonce', config);
      return;
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Config save error:', err);
  }
}

// ---------- Helpers ----------
function getOwnerJid(sock) {
  // Sock user id can look like: "9477xxxxxxx:xx@s.whatsapp.net"
  const raw = sock?.user?.id || '';
  const ownerNumber = raw.includes(':') ? raw.split(':')[0] : raw.split('@')[0];
  return ownerNumber ? `${ownerNumber}@s.whatsapp.net` : null;
}

async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

function pickViewOnceContainer(message) {
  // Baileys currently uses viewOnceMessageV2 in most cases
  return (
    message?.message?.viewOnceMessageV2?.message ||
    message?.message?.viewOnceMessage?.message ||
    null
  );
}

// ---------- Core: capture & forward viewOnce ----------
async function storeMessage(sock, message) {
  try {
    const config = await loadAntiViewOnceConfig();
    if (!config.enabled) return;

    const msgId = message?.key?.id;
    if (!msgId) return;

    const container = pickViewOnceContainer(message);
    if (!container) return; // not viewOnce

    const sender = message.key.participant || message.key.remoteJid;
    const isGroup = message.key.remoteJid?.endsWith('@g.us');
    const groupJid = isGroup ? message.key.remoteJid : null;

    let mediaType = '';
    let caption = '';
    let mediaPath = '';

    if (container.imageMessage) {
      mediaType = 'image';
      caption = container.imageMessage.caption || '';
      const stream = await downloadContentFromMessage(container.imageMessage, 'image');
      const buffer = await streamToBuffer(stream);
      mediaPath = path.join(TEMP_MEDIA_DIR, `${msgId}.jpg`);
      await writeFile(mediaPath, buffer);
    } else if (container.videoMessage) {
      mediaType = 'video';
      caption = container.videoMessage.caption || '';
      const stream = await downloadContentFromMessage(container.videoMessage, 'video');
      const buffer = await streamToBuffer(stream);
      mediaPath = path.join(TEMP_MEDIA_DIR, `${msgId}.mp4`);
      await writeFile(mediaPath, buffer);
    } else {
      return; // Only handling image/video viewOnce for now
    }

    messageStore.set(msgId, {
      sender,
      group: groupJid,
      mediaType,
      caption,
      mediaPath,
      timestamp: new Date().toISOString(),
    });

    // Forward to owner (default) OR optionally to current chat
    const ownerJid = getOwnerJid(sock);
    if (!ownerJid) return;

    const targetJid = config.notifyOwnerOnly ? ownerJid : (message.key.remoteJid || ownerJid);

    // group name (optional)
    let groupName = '';
    if (groupJid) {
      try {
        const md = await sock.groupMetadata(groupJid);
        groupName = md?.subject || '';
      } catch {}
    }

    const senderTag = sender?.split('@')[0] || 'unknown';

    const headerLines = [
      `*👁️ Anti-ViewOnce ${mediaType.toUpperCase()}*`,
      `*From:* @${senderTag}`,
    ];
    if (groupName) headerLines.push(`*Group:* ${groupName}`);

    if (caption) {
      headerLines.push('', '*Caption:*', caption);
    }

    const common = {
      caption: headerLines.join('\n'),
      mentions: [sender],
    };

    if (mediaType === 'image') {
      await sock.sendMessage(targetJid, { image: { url: mediaPath }, ...common });
    } else if (mediaType === 'video') {
      await sock.sendMessage(targetJid, { video: { url: mediaPath }, ...common });
    }

    // Clean temp file after sending
    try { fs.unlinkSync(mediaPath); } catch {}

  } catch (err) {
    console.error('antiviewonce storeMessage error:', err);
  }
}

// ---------- Command handler ----------
module.exports = {
  command: 'antiviewonce',
  aliases: ['antiview', 'avo'],
  category: 'owner',
  description: 'Enable or disable anti-viewonce feature (captures viewOnce images/videos)',
  usage: '.antiviewonce <on|off>',
  ownerOnly: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const config = await loadAntiViewOnceConfig();

    const action = (args[0] || '').toLowerCase();
    const sub = (args[1] || '').toLowerCase();

    if (!action) {
      await sock.sendMessage(chatId, {
        text:
          `*👁️ ANTI-VIEWONCE SETUP 👁️*\n\n` +
          `*Current Status:* ${config.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `*Storage:* ${HAS_DB ? 'Database' : 'File System'}\n` +
          `*Send To:* ${config.notifyOwnerOnly ? 'Owner Only' : 'Same Chat'}\n\n` +
          `*Commands:*\n` +
          `• \`.antiviewonce on\` - Enable\n` +
          `• \`.antiviewonce off\` - Disable\n` +
          `• \`.antiviewonce on chat\` - Enable + send to same chat\n` +
          `• \`.antiviewonce on owner\` - Enable + send to owner only\n\n` +
          `*Notes:*\n` +
          `• Works for ViewOnce image/video\n` +
          `• Forwards captured media immediately`
      }, { quoted: message });
      return;
    }

    if (action === 'on') {
      config.enabled = true;

      // optional routing option
      if (sub === 'chat') config.notifyOwnerOnly = false;
      if (sub === 'owner') config.notifyOwnerOnly = true;

      await saveAntiViewOnceConfig(config);

      await sock.sendMessage(chatId, {
        text:
          `✅ *Anti-ViewOnce enabled!*\n\n` +
          `Storage: ${HAS_DB ? 'Database' : 'File System'}\n` +
          `Send To: ${config.notifyOwnerOnly ? 'Owner Only' : 'Same Chat'}\n\n` +
          `The bot will now capture viewOnce images/videos and forward them.`
      }, { quoted: message });
      return;
    }

    if (action === 'off') {
      config.enabled = false;
      await saveAntiViewOnceConfig(config);
      await sock.sendMessage(chatId, {
        text: `❌ *Anti-ViewOnce disabled!*\n\nThe bot will no longer capture viewOnce media.`
      }, { quoted: message });
      return;
    }

    await sock.sendMessage(chatId, {
      text: '❌ *Invalid command*\n\nUse: `.antiviewonce on/off`'
    }, { quoted: message });
  },

  // export these so your main bot can call them like your antidelete plugin
  storeMessage,
  loadAntiViewOnceConfig,
  saveAntiViewOnceConfig,
};

const fs = require('fs');
const path = require('path');
const commandHandler = require('../lib/commandHandler');
const settings = require('../settings');

/**
 * FINAL MENU (Infinity MD)
 * -----------------------
 * ✅ Banner image (optional)
 * ✅ WhatsApp LIST menu (real list UI)
 * ✅ Fallback buttons if list not supported
 * ✅ Anti-duplicate cooldown per chat
 *
 * IMPORTANT:
 * Delete/rename any other plugin that uses command: 'menu'
 * Your log: [REPLACED] Command "menu" was already registered...
 */

const lastSent = new Map();
const COOLDOWN_MS = 2500;

function pickBanner() {
  const candidates = [
    path.join(process.cwd(), 'assets', 'unnamed_1769953510098.jpg'),
    path.join(process.cwd(), 'assets', 'unnamed_(1)_1769953514810.jpg'),
    path.join(process.cwd(), 'assets', 'unnamed_(2)_1769953519419.jpg'),
  ];
  const choice = candidates[Math.floor(Math.random() * candidates.length)];
  return fs.existsSync(choice) ? choice : null;
}

function formatUptime() {
  const uptime = process.uptime();
  const s = Math.floor(uptime % 60);
  const m = Math.floor((uptime / 60) % 60);
  const h = Math.floor((uptime / 3600) % 24);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function safePrefix() {
  const p = settings?.prefixes?.[0];
  return typeof p === 'string' && p.length ? p : '.';
}

module.exports = {
  command: 'menu',
  aliases: ['help'],
  category: 'main',
  description: 'Show the main menu (List UI + fallback buttons)',
  usage: '.menu',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    // Prevent duplicate sends (common with multiple upsert triggers)
    const now = Date.now();
    const prev = lastSent.get(chatId) || 0;
    if (now - prev < COOLDOWN_MS) return;
    lastSent.set(chatId, now);

    const prefix = safePrefix();
    const uptimeStr = formatUptime();
    const usedMB = process.memoryUsage().rss / 1024 / 1024;

    const botName = settings?.botName || global.botname || 'INFINITY MD';
    const ownerName = settings?.botOwner || 'Owner';
    const cmdCount = commandHandler?.commands?.size || 0;

    const headerText =
      `🤖 *MAIN MENU*\n` +
      `╭───〔 🤖 ${botName} 〕───\n` +
      `│ 👤 *Owner* : ${ownerName}\n` +
      `│ 📊 *Commands* : ${cmdCount}+\n` +
      `│ ⏱ *Uptime* : ${uptimeStr}\n` +
      `│ 🚀 *RAM* : ${usedMB.toFixed(2)}MB\n` +
      `│ ⌨️ *Prefix* : ${prefix}\n` +
      `╰────────────────────\n\n` +
      `Select a category below 👇\n\n` +
      `> 💫 *INFINITY MD BOT* - Powered by AI`;

    // 1) Banner (optional)
    const banner = pickBanner();
    if (banner) {
      try {
        await sock.sendMessage(
          chatId,
          { image: fs.readFileSync(banner), caption: headerText },
          { quoted: message }
        );
      } catch {}
    } else {
      // If no banner, send header once
      await sock.sendMessage(chatId, { text: headerText }, { quoted: message }).catch(() => {});
    }

    // 2) LIST sections
    const sections = [
      {
        title: '📂 MAIN MENUS',
        rows: [
          { title: '👑 Owner Menu', description: 'Owner/Admin commands', rowId: `${prefix}ownermenu` },
          { title: '🧩 Group Menu', description: 'Group features & moderation', rowId: `${prefix}groupmenu` },
          { title: '📥 Download Menu', description: 'YouTube/FB/TikTok downloads', rowId: `${prefix}dlmenu` },
          { title: '🎮 Fun Menu', description: 'Fun games & jokes', rowId: `${prefix}funmenu` },
          { title: '🤖 AI Menu', description: 'AI chat & tools', rowId: `${prefix}aimenu` },
          { title: '🖼 Sticker Menu', description: 'Sticker tools', rowId: `${prefix}stickermenu` },
          { title: '🎵 Audio Menu', description: 'Audio tools', rowId: `${prefix}audiomenu` },
          { title: '🎥 Video Menu', description: 'Video tools', rowId: `${prefix}videomenu` },
          { title: '🔍 Search Menu', description: 'Search tools', rowId: `${prefix}searchmenu` },
          { title: '🛠 Tools Menu', description: 'Utilities', rowId: `${prefix}toolsmenu` },
          { title: '🧠 Convert Menu', description: 'Converters', rowId: `${prefix}convertmenu` },
          { title: '⚙️ Settings Menu', description: 'Bot settings', rowId: `${prefix}settingsmenu` },
          { title: '🗄 DB Menu', description: 'Database tools', rowId: `${prefix}dbmenu` },
          { title: '🧪 Other Menu', description: 'Extra commands', rowId: `${prefix}othermenu` },
        ],
      },
      {
        title: '⚡ QUICK ACTIONS',
        rows: [
          { title: '📌 Ping', description: 'Check bot speed', rowId: `${prefix}ping` },
          { title: '🧾 Settings', description: 'View system settings', rowId: `${prefix}settings` },
          { title: '🖼 Set PP', description: 'Update bot profile picture', rowId: `${prefix}setpp` },
          { title: '🧑‍🎤 AutoPP', description: 'Auto profile pic scheduler', rowId: `${prefix}autopp` },
        ],
      },
    ];

    // 3) Send LIST menu (real list UI)
    try {
      await sock.sendMessage(
        chatId,
        {
          title: `🤖 ${botName}`,
          text: 'Choose one category:',
          footer: `Prefix: ${prefix}  •  Commands: ${cmdCount}+`,
          buttonText: 'OPEN MENU',
          sections,
        },
        { quoted: message }
      );
      return;
    } catch (err) {
      // fallback to buttons
    }

    // 4) Fallback BUTTONS
    const buttons = [
      { buttonId: `${prefix}ownermenu`, buttonText: { displayText: '👑 Owner' }, type: 1 },
      { buttonId: `${prefix}groupmenu`, buttonText: { displayText: '🧩 Group' }, type: 1 },
      { buttonId: `${prefix}dlmenu`, buttonText: { displayText: '📥 Download' }, type: 1 },
    ];

    await sock.sendMessage(
      chatId,
      {
        text: headerText + '\n\n(List UI not supported here — using buttons.)',
        footer: botName,
        buttons,
        headerType: 1,
      },
      { quoted: message }
    ).catch(async () => {
      // last resort plain text
      await sock.sendMessage(chatId, { text: headerText }, { quoted: message }).catch(() => {});
    });
  },
};

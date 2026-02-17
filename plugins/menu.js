const fs = require('fs');
const commandHandler = require('../lib/commandHandler');
const settings = require('../settings');

/**
 * MENU with LIST BUTTONS (Baileys)
 * -------------------------------
 * - Sends an image + caption + list menu (if supported)
 * - Fallbacks to plain text menu if list is not supported by the client
 *
 * IMPORTANT: You must handle list replies in your main messages.upsert:
 * const selected = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
 * If selected exists, treat it like a typed command.
 */

module.exports = {
  command: 'menu',
  aliases: ['help'],
  category: 'main',
  description: 'Shows the main command menu (List Buttons)',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const prefix = settings.prefixes?.[0] || '.';

    // uptime
    const uptime = process.uptime();
    const seconds = Math.floor(uptime % 60);
    const minutes = Math.floor((uptime / 60) % 60);
    const hours = Math.floor((uptime / (60 * 60)) % 24);
    const uptimeStr =
      hours > 0 ? `${hours}h ${minutes}m ${seconds}s` :
      minutes > 0 ? `${minutes}m ${seconds}s` :
      `${seconds} seconds`;

    // memory
    const used = process.memoryUsage().rss / 1024 / 1024;
    const totalMem = 62.80; // keep your style

    // random banner
    const banners = [
      './assets/unnamed_1769953510098.jpg',
      './assets/unnamed_(1)_1769953514810.jpg',
      './assets/unnamed_(2)_1769953519419.jpg'
    ];
    const banner = banners[Math.floor(Math.random() * banners.length)];
    const bannerBuf = fs.existsSync(banner) ? fs.readFileSync(banner) : null;

    // caption text (header)
    let menuText = `🤖 *MAIN MENU*\n`;
    menuText += `╭───〔 🤖 INFINITY MD 〕───\n`;
    menuText += `│ 👤 *Owner* : ${settings.botOwner}\n`;
    menuText += `│ 📊 *Commands* : ${(commandHandler?.commands?.size || 0)}+\n`;
    menuText += `│ ⏱ *Uptime* : ${uptimeStr}\n`;
    menuText += `│ 🚀 *RAM* : ${used.toFixed(2)}MB / ${totalMem}GB\n`;
    menuText += `│ ⌨️ *Prefix* : ${prefix}\n`;
    menuText += `╰────────────────────\n\n`;
    menuText += `Select a category below 👇\n\n`;
    menuText += `> 💫 *INFINITY MD BOT* - Powered by AI`;

    // list sections
    const sections = [
      {
        title: '📂 MAIN MENUS',
        rows: [
          { title: '👑 Owner Menu', description: 'Owner-only commands', rowId: `${prefix}ownermenu` },
          { title: '🧩 Group Menu', description: 'Group moderation & tools', rowId: `${prefix}groupmenu` },
          { title: '📥 Download Menu', description: 'YouTube / Media downloads', rowId: `${prefix}dlmenu` },
          { title: '🎮 Fun Menu', description: 'Fun & games', rowId: `${prefix}funmenu` },
          { title: '🤖 AI Menu', description: 'AI tools & chat', rowId: `${prefix}aimenu` },
          { title: '🖼 Sticker Menu', description: 'Sticker tools', rowId: `${prefix}stickermenu` },
          { title: '🎵 Audio Menu', description: 'Audio tools', rowId: `${prefix}audiomenu` },
          { title: '🎥 Video Menu', description: 'Video tools', rowId: `${prefix}videomenu` },
          { title: '🔍 Search Menu', description: 'Search tools', rowId: `${prefix}searchmenu` },
          { title: '🛠 Tools Menu', description: 'Utilities & helpers', rowId: `${prefix}toolsmenu` },
          { title: '🧠 Convert Menu', description: 'Converters', rowId: `${prefix}convertmenu` },
          { title: '⚙️ Settings Menu', description: 'Bot settings', rowId: `${prefix}settingsmenu` },
          { title: '🗄 DB Menu', description: 'Database tools', rowId: `${prefix}dbmenu` },
          { title: '🧪 Other Menu', description: 'Extra commands', rowId: `${prefix}othermenu` }
        ]
      }
    ];

    const listMsg = {
      text: menuText,
      footer: 'Infinity MD',
      title: 'INFINITY MD MENU',
      buttonText: 'OPEN MENU ✅',
      sections
    };

    // If you want image + list: send image with caption first, then list message.
    // (WhatsApp does not reliably support list+image in one message across all clients.)
    try {
      if (bannerBuf) {
        await sock.sendMessage(chatId, { image: bannerBuf, caption: menuText }, { quoted: message });
        await sock.sendMessage(chatId, listMsg, { quoted: message });
      } else {
        await sock.sendMessage(chatId, listMsg, { quoted: message });
      }
    } catch (e) {
      // Fallback to plain text if list is not supported
      const fallback =
        menuText +
        `\n\n╭───〔 📂 MAIN MENUS 〕───\n` +
        `│ 👑 ${prefix}ownermenu\n` +
        `│ 🧩 ${prefix}groupmenu\n` +
        `│ 📥 ${prefix}dlmenu\n` +
        `│ 🎮 ${prefix}funmenu\n` +
        `│ 🤖 ${prefix}aimenu\n` +
        `│ 🖼 ${prefix}stickermenu\n` +
        `│ 🎵 ${prefix}audiomenu\n` +
        `│ 🎥 ${prefix}videomenu\n` +
        `│ 🔍 ${prefix}searchmenu\n` +
        `│ 🛠 ${prefix}toolsmenu\n` +
        `│ 🧠 ${prefix}convertmenu\n` +
        `│ ⚙️ ${prefix}settingsmenu\n` +
        `│ 🗄 ${prefix}dbmenu\n` +
        `│ 🧪 ${prefix}othermenu\n` +
        `╰────────────────────\n`;

      if (bannerBuf) {
        await sock.sendMessage(chatId, { image: bannerBuf, caption: fallback }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, { text: fallback }, { quoted: message });
      }
    }
  }
};

/*
  MAIN HANDLER ADD THIS (IMPORTANT):

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    const selected = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (selected) {
      // treat like command text
      // example: runCommand(sock, msg, selected)
    }
  });
*/

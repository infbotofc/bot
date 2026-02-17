const commandHandler = require('../lib/commandHandler');
const settings = require('../settings');

/**
 * INFINITY MD MENU (List Buttons) - Fully Updated
 * ----------------------------------------------
 * Fixes your issues:
 * ✅ Sends ONLY ONE menu message (no double header spam)
 * ✅ Uses WhatsApp List Menu (stable)
 * ✅ Clean fallback to text menu if list unsupported
 * ✅ Row IDs are commands (e.g. .dlmenu) so clicking runs like typing
 *
 * REQUIRED (already done in your updated index.js):
 * - Convert list replies to conversation text:
 *   msg.message.listResponseMessage.singleSelectReply.selectedRowId
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
      `${seconds}s`;

    // ram
    const used = process.memoryUsage().rss / 1024 / 1024;
    const totalMem = 62.80; // keep your style

    const cmdCount = (commandHandler?.commands?.size || 0);

    const headerText =
      `🤖 *MAIN MENU*\n` +
      `╭───〔 🤖 INFINITY MD 〕───\n` +
      `│ 👤 *Owner* : ${settings.botOwner}\n` +
      `│ 📊 *Commands* : ${cmdCount}+\n` +
      `│ ⏱ *Uptime* : ${uptimeStr}\n` +
      `│ 🚀 *RAM* : ${used.toFixed(2)}MB / ${totalMem}GB\n` +
      `│ ⌨️ *Prefix* : ${prefix}\n` +
      `╰────────────────────\n\n` +
      `Select a category below 👇\n\n` +
      `> 💫 *INFINITY MD BOT* - Powered by AI`;

    const sections = [
      {
        title: '📂 MAIN MENUS',
        rows: [
          { title: '👑 Owner Menu', description: 'Owner-only commands', rowId: `${prefix}ownermenu` },
          { title: '🧩 Group Menu', description: 'Group moderation & tools', rowId: `${prefix}groupmenu` },
          { title: '📥 Download Menu', description: 'YouTube / media downloads', rowId: `${prefix}dlmenu` },
          { title: '🎮 Fun Menu', description: 'Fun & games', rowId: `${prefix}funmenu` },
          { title: '🤖 AI Menu', description: 'AI tools & chat', rowId: `${prefix}aimenu` },
          { title: '🖼 Sticker Menu', description: 'Sticker tools', rowId: `${prefix}stickermenu` },
          { title: '🎵 Audio Menu', description: 'Audio tools', rowId: `${prefix}audiomenu` },
          { title: '🎥 Video Menu', description: 'Video tools', rowId: `${prefix}videomenu` },
          { title: '🔍 Search Menu', description: 'Search commands', rowId: `${prefix}searchmenu` },
          { title: '🛠 Tools Menu', description: 'Utilities & helpers', rowId: `${prefix}toolsmenu` },
          { title: '🧠 Convert Menu', description: 'Converters', rowId: `${prefix}convertmenu` },
          { title: '⚙️ Settings Menu', description: 'Bot settings', rowId: `${prefix}settingsmenu` },
          { title: '🗄 DB Menu', description: 'Database tools', rowId: `${prefix}dbmenu` },
          { title: '🧪 Other Menu', description: 'Extra commands', rowId: `${prefix}othermenu` }
        ]
      }
    ];

    const listMsg = {
      text: headerText,
      footer: 'Infinity MD',
      title: 'INFINITY MD MENU',
      buttonText: 'OPEN MENU ✅',
      sections
    };

    // Fallback text menu (if list not supported)
    const fallbackText =
      headerText +
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
      `╰────────────────────`;

    try {
      await sock.sendMessage(chatId, listMsg, { quoted: message });
    } catch (e) {
      // Some clients / builds may not support list menus
      await sock.sendMessage(chatId, { text: fallbackText }, { quoted: message });
    }
  }
};

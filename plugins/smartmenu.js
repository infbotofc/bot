const CommandHandler = require('../lib/commandHandler');
const settings = require("../settings");
const fs = require('fs');
const path = require('path');
const os = require('os');

function formatUptime() {
    let uptime = Math.floor(process.uptime());
    const days = Math.floor(uptime / 86400);
    uptime %= 86400;
    const hours = Math.floor(uptime / 3600);
    uptime %= 3600;
    const minutes = Math.floor(uptime / 60);
    const seconds = uptime % 60;

    const parts = [];
    if (days) parts.push(`${days} days`);
    if (hours) parts.push(`${hours} hours`);
    if (minutes) parts.push(`${minutes} minutes`);
    if (seconds || parts.length === 0) parts.push(`${seconds} seconds`);
    return parts.join(' ');
}

function getRAMUsage() {
  const totalMB = os.totalmem() / 1024 / 1024;
  const freeMB = os.freemem() / 1024 / 1024;
  const usedMB = totalMB - freeMB;
  const percent = ((usedMB / totalMB) * 100).toFixed(1);
  const procMem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  return `${(usedMB/1024).toFixed(2)} GB / ${(totalMB/1024).toFixed(2)} GB (${percent}%) · Proc ${procMem} MB`;
}

module.exports = {
  command: 'smenu',
  aliases: ['shelp', 'smart', 'menu', 'help'],
  category: 'general',
  description: 'Interactive smart menu with live status',
  usage: '.menu',
  isPrefixless: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    try {
      const imagePath = path.join(__dirname, '../assets/bot_image.jpg');
      const thumbnail = fs.existsSync(imagePath) ? fs.readFileSync(imagePath) : null;

      const commandCount = CommandHandler.commands.size;
      const prefix = settings.prefixes ? settings.prefixes[0] : '.';

      const load = os.loadavg()[0] ? os.loadavg()[0].toFixed(2) : '0.00';
      let menuText = `╭─〔 🤖 INFINITY MD 〕─╮\n` +
        `│ 👤 Owner : ${settings.botOwner || 'Default Publisher'}\n` +
        `│ 📊 Commands : ${commandCount}+    │ ⌨️ Prefix : ${prefix}\n` +
        `│ ⏱ Uptime  : ${formatUptime()}\n` +
        `│ 💾 RAM     : ${getRAMUsage()}\n` +
        `│ 🧮 Load(1m): ${load}    │ CPU Cores: ${os.cpus().length}\n` +
        `╰──────────────────────╯\n\n` +
        `╭─〔 📂 MAIN MENUS 〕─╮\n` +
        `│ 👑 ${prefix}ownermenu   │ 🧩 ${prefix}groupmenu\n` +
        `│ 📥 ${prefix}dlmenu     │ 🎮 ${prefix}funmenu\n` +
        `│ 🤖 ${prefix}aimenu     │ 🖼 ${prefix}stickermenu\n` +
        `│ 🎵 ${prefix}audiomenu  │ 🎥 ${prefix}videomenu\n` +
        `│ 🔍 ${prefix}searchmenu │ 🛠 ${prefix}toolsmenu\n` +
        `│ 🧠 ${prefix}convertmenu │ ⚙️ ${prefix}settingsmenu\n` +
        `│ 🗄 ${prefix}dbmenu      │ 🧪 ${prefix}othermenu\n` +
        `╰──────────────────────╯\n\n` +
        `💫 INFINITY MD - Powered by AI`;

      if (thumbnail) {
        await sock.sendMessage(chatId, {
          image: thumbnail,
          caption: menuText
        }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, {
          text: menuText
        }, { quoted: message });
      }

    } catch (error) {
      console.error('Menu Error:', error);
      await sock.sendMessage(chatId, { 
        text: `❌ *Menu Error*\n\n${error.message}`
      }, { quoted: message });
    }
  }
};

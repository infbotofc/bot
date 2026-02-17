const fs = require('fs');
const commandHandler = require('../lib/commandHandler');
const settings = require('../settings');

module.exports = {
    command: 'menu',
    aliases: ['help'],
    category: 'main',
    description: 'Shows the main command menu',
    async handler(sock, message, args, context = {}) {
        const chatId = context.chatId || message.key.remoteJid;
        const prefix = settings.prefixes?.[0] || '.';

        const uptime = process.uptime();
        const seconds = Math.floor(uptime % 60);
        const minutes = Math.floor((uptime / 60) % 60);
        const hours = Math.floor((uptime / 3600));
        const uptimeStr = hours > 0
            ? `${hours}h ${minutes}m ${seconds}s`
            : minutes > 0
            ? `${minutes}m ${seconds}s`
            : `${seconds}s`;

        const used = process.memoryUsage().rss / 1024 / 1024;

        const banners = [
            './assets/unnamed_1769953510098.jpg',
            './assets/unnamed_(1)_1769953514810.jpg',
            './assets/unnamed_(2)_1769953519419.jpg'
        ];

        const banner = banners[Math.floor(Math.random() * banners.length)];

        let menuText = `🤖 *MAIN MENU*\n`;
        menuText += `╭───〔 🤖 INFINITY MD 〕───\n`;
        menuText += `│ 👤 *Owner* : ${settings.botOwner}\n`;
        menuText += `│ 📊 *Commands* : ${commandHandler.commands.size}+\n`;
        menuText += `│ ⏱ *Uptime* : ${uptimeStr}\n`;
        menuText += `│ 🚀 *RAM* : ${used.toFixed(2)}MB\n`;
        menuText += `│ ⌨️ *Prefix* : ${prefix}\n`;
        menuText += `╰────────────────────\n\n`;

        menuText += `╭───〔 📂 MAIN MENUS 〕───\n`;
        menuText += `│ 👑 ${prefix}ownermenu\n`;
        menuText += `│ 🧩 ${prefix}groupmenu\n`;
        menuText += `│ 📥 ${prefix}dlmenu\n`;
        menuText += `│ 🎮 ${prefix}funmenu\n`;
        menuText += `│ 🤖 ${prefix}aimenu\n`;
        menuText += `│ 🖼 ${prefix}stickermenu\n`;
        menuText += `│ 🎵 ${prefix}audiomenu\n`;
        menuText += `│ 🎥 ${prefix}videomenu\n`;
        menuText += `│ 🔍 ${prefix}searchmenu\n`;
        menuText += `│ 🛠 ${prefix}toolsmenu\n`;
        menuText += `│ 🧠 ${prefix}convertmenu\n`;
        menuText += `│ ⚙️ ${prefix}settingsmenu\n`;
        menuText += `│ 🗄 ${prefix}dbmenu\n`;
        menuText += `│ 🧪 ${prefix}othermenu\n`;
        menuText += `╰────────────────────\n\n`;

        menuText += `> 💫 *INFINITY MD BOT* - Powered by AI`;

        try {
            await sock.sendMessage(chatId, {
                image: fs.readFileSync(banner),
                caption: menuText
            }, { quoted: message });
        } catch {
            await sock.sendMessage(chatId, { text: menuText }, { quoted: message });
        }
    }
};

const settings = require("../settings");
const fs = require("fs");
const path = require("path");

module.exports = {
  command: 'dlmenu',
  aliases: ['downloadmenu', 'download'],
  category: 'menu',
  description: 'Download commands menu',
  usage: '.dlmenu',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const prefix = settings.prefixes ? settings.prefixes[0] : '.';

    const bannerPath = path.join(__dirname, '../assets/unnamed_(2)_1769953519419.jpg');
    const banner = fs.existsSync(bannerPath) ? fs.readFileSync(bannerPath) : null;

    const menuText = `
╭━━━〔 📥 *DOWNLOAD HUB* 〕━━━⬣

🎬 *Movies & Series*
┃ ${prefix}movie – Baiscope movies
┃ ${prefix}baiscope – Same as movie
┃ ${prefix}cinesubz – Cinesubz search
┃ ${prefix}cinesubs – Alias movie cmd

🎧 *Music & Audio*
┃ ${prefix}play – Play song from YouTube
┃ ${prefix}song – Download song
┃ ${prefix}spotify – Spotify downloader
┃ ${prefix}scloud – SoundCloud download

🎬 *Video Downloads*
┃ ${prefix}video – General video download
┃ ${prefix}ytmp4 – YouTube video
┃ ${prefix}ytmp3 – YouTube audio

📱 *Social Media*
┃ ${prefix}tiktok – TikTok download
┃ ${prefix}instagram – Instagram media
┃ ${prefix}facebook – Facebook video
┃ ${prefix}twitter – Twitter/X media
┃ ${prefix}snapchat – Snapchat content

🖼️ *Image Tools*
┃ ${prefix}pinterest – Pinterest search
┃ ${prefix}gimage – Google images
┃ ${prefix}alamy – Alamy photos
┃ ${prefix}getty – Getty images

📂 *Files & Apps*
┃ ${prefix}mediafire – Mediafire downloader
┃ ${prefix}terabox – Terabox file
┃ ${prefix}apk – APK search/download

╰━━━━━━━━━━━━━━━━━━⬣
🚀 *Infinity MD Bot*
💫 Fast • Stable • Smart
`.trim();

    try {
      if (banner) {
        await sock.sendMessage(chatId, {
          image: banner,
          caption: menuText
        }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, { text: menuText }, { quoted: message });
      }
    } catch {
      await sock.sendMessage(chatId, { text: menuText }, { quoted: message });
    }
  }
};

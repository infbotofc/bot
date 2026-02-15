const yts = require('yt-search');
const ytdl = require('ytdl-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  command: 'song',
  aliases: ['rsong', 'music2'],
  category: 'download',
  description: 'Download song from YouTube',
  usage: '.song <song name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const query = args.join(' ').trim();
    if (!query) {
      return sock.sendMessage(chatId, {
        text: '🎵 *Which song do you want to download?*\n\nUsage: .song <song name>'
      }, { quoted: message });
    }
    const tmpFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);
    try {
      await sock.sendPresenceUpdate('composing', chatId);
      const search = await yts(query);
      const video = (search?.videos || []).find(v => (v.seconds || 0) > 30 && (v.seconds || 0) < 2 * 60 * 60) || (search?.videos || [])[0];
      if (!video || !video.url) {
        return sock.sendMessage(chatId, { text: '❌ No YouTube songs found!' }, { quoted: message });
      }
      const videoUrl = video.url;
      const title = video.title || 'Unknown Title';
      const duration = video.timestamp || 'Unknown';
      const author = video.author?.name || video.author || 'Unknown Artist';
      const thumbnail = video.thumbnail || '';
      const infoText =
        `╭───〔 🎵 *SONG INFO* 〕───\n` +
        `│ 📝 *Title:* ${title}\n` +
        `│ 👤 *Artist:* ${author}\n` +
        `│ ⏱️ *Duration:* ${duration}\n` +
        `│ 🔗 *Link:* ${videoUrl}\n` +
        `╰───────────────────\n\n` +
        `⏳ *Downloading audio...*\n\n` +
        `> 💫 *INFINITY MD BOT*`;
      await sock.sendMessage(chatId, {
        image: { url: thumbnail },
        caption: infoText
      }, { quoted: message });
      await sock.sendPresenceUpdate('recording', chatId);
      await new Promise((resolve, reject) => {
        const stream = ytdl(videoUrl, {
          filter: 'audioonly',
          quality: 'highestaudio',
          highWaterMark: 1 << 25
        });
        const write = fs.createWriteStream(tmpFile);
        stream.pipe(write);
        stream.on('error', reject);
        write.on('error', reject);
        write.on('finish', resolve);
      });
      const size = fs.statSync(tmpFile).size;
      const safeName = title.replace(/[^a-zA-Z0-9 _.-]/g, '_');
      if (size <= 25 * 1024 * 1024) {
        const audioBuffer = fs.readFileSync(tmpFile);
        await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${safeName}.mp3`
        }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, {
          document: fs.createReadStream(tmpFile),
          mimetype: 'audio/mpeg',
          fileName: `${safeName}.mp3`
        }, { quoted: message });
      }
    } catch (err) {
      console.error('Song Error:', err);
      await sock.sendMessage(chatId, {
        text: `❌ *Download failed!*\n\n*Error:* ${err.message || err}`
      }, { quoted: message });
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
      await sock.sendPresenceUpdate('paused', chatId);
    }
  }
};

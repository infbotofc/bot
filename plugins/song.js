const axios = require('axios');
const yts = require('yt-search');
const { fetchBuffer } = require('../lib/myfunc2')

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
      return await sock.sendMessage(chatId, {
        text: '🎵 *Which song do you want to download?*\n\nUsage: .song <song name>'
      }, { quoted: message });
    }

    try {
      // Auto-typing effect
      await sock.sendPresenceUpdate('composing', chatId);
      
      const search = await yts(query);
      if (!search.all || search.all.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No songs found!' }, { quoted: message });
      }

      const topResult = search.all[0];
      const videoUrl = topResult.url;
      const title = topResult.title;
      const duration = topResult.timestamp;
      const author = topResult.author.name;
      const thumbnail = topResult.thumbnail;

      const infoText = `╭───〔 🎵 *SONG INFO* 〕───
│
│ 📝 *Title:* ${title}
│ 👤 *Artist:* ${author}
│ ⏱️ *Duration:* ${duration}
│ 🔗 *Link:* ${videoUrl}
│
╰───────────────────

⏳ *Downloading audio...*

> 💫 *INFINITY MD BOT*`;

      await sock.sendMessage(chatId, {
        image: { url: thumbnail },
        caption: infoText
      }, { quoted: message });

      // Auto-recording (voice) effect
      await sock.sendPresenceUpdate('recording', chatId);

      // Using the most stable API endpoint for YouTube to MP3
      const apiUrl = `https://api.qasimdev.dpdns.org/api/downloader/ytmp3?url=${encodeURIComponent(videoUrl)}&apiKey=qasim-dev`;
      
      try {
        const response = await axios.get(apiUrl, { timeout: 60000 });
        if (response.data && response.data.success && response.data.data?.downloadUrl) {
          const { downloadUrl } = response.data.data;
          const audioBuffer = await fetchBuffer(downloadUrl, { timeout: 120000 });
          if (!audioBuffer || audioBuffer.length < 1024) {
            console.error('Downloaded audio buffer is empty or too small.');
            await sock.sendMessage(chatId, {
              text: '❌ Failed to download audio. The file is empty or invalid.'
            }, { quoted: message });
            throw new Error('Audio buffer empty or invalid');
          }
          // Optionally, check file signature for MP3 (starts with ID3 or 0xFFFB)
          const isMp3 = audioBuffer.slice(0, 3).toString() === 'ID3' || (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0);
          if (!isMp3) {
            console.error('Downloaded file is not a valid MP3.');
            await sock.sendMessage(chatId, {
              text: '❌ Downloaded file is not a valid MP3 audio.'
            }, { quoted: message });
            throw new Error('File is not valid MP3');
          }
          return await sock.sendMessage(chatId, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            fileName: `${title}.mp3`
          }, { quoted: message });
        }
      } catch (e) {
        console.log('Primary API failed, trying fallback...', e);
      }

      // Fallback API: LoaderTo (format: mp3)
      const fallbackUrl = `https://api.qasimdev.dpdns.org/api/loaderto/download?apiKey=qasim-dev&format=mp3&url=${encodeURIComponent(videoUrl)}`;
      const fallbackResponse = await axios.get(fallbackUrl, { timeout: 60000 });
      if (fallbackResponse.data && fallbackResponse.data.success && fallbackResponse.data.data?.downloadUrl) {
        const { downloadUrl } = fallbackResponse.data.data;
        const audioBuffer = await fetchBuffer(downloadUrl, { timeout: 120000 });
        if (!audioBuffer || audioBuffer.length < 1024) {
          console.error('Fallback: Downloaded audio buffer is empty or too small.');
          await sock.sendMessage(chatId, {
            text: '❌ Fallback failed: The audio file is empty or invalid.'
          }, { quoted: message });
          throw new Error('Fallback audio buffer empty or invalid');
        }
        const isMp3 = audioBuffer.slice(0, 3).toString() === 'ID3' || (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0);
        if (!isMp3) {
          console.error('Fallback: Downloaded file is not a valid MP3.');
          await sock.sendMessage(chatId, {
            text: '❌ Fallback: Downloaded file is not a valid MP3 audio.'
          }, { quoted: message });
          throw new Error('Fallback file is not valid MP3');
        }
        return await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${title}.mp3`
        }, { quoted: message });
      }

      throw new Error('Servers are currently unresponsive. Please try again.');

    } catch (error) {
      console.error('Song Error:', error);
      await sock.sendMessage(chatId, {
        text: `❌ *Download failed!*\n\n*Error:* ${error.message}`
      }, { quoted: message });
    } finally {
      await sock.sendPresenceUpdate('paused', chatId);
    }
  }
};

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
      // Search YouTube only
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
      // Download audio using ytdl-core (YouTube only)
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
const axios = require('axios');
const yts = require('yt-search');
const ytdl = require('ytdl-core');
const { fetchBuffer } = require('../lib/myfunc2');
const https = require('https');
const http = require('http');
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
      return await sock.sendMessage(chatId, {
        text: '🎵 *Which song do you want to download?*\n\nUsage: .song <song name>'
      }, { quoted: message });
    }

    try {
      // Auto-typing effect
      await sock.sendPresenceUpdate('composing', chatId);
      
      const search = await yts(query);
      // Prefer video results only (songs). yts returns arrays: videos, playlists, etc.
      let topResult = null;
      if (search && Array.isArray(search.videos) && search.videos.length > 0) {
        // pick first reasonable video result (duration between 30s and 2 hours)
        topResult = search.videos.find(v => (v.seconds || 0) > 30 && (v.seconds || 0) < 2 * 60 * 60) || search.videos[0];
      } else if (search && Array.isArray(search.all) && search.all.length > 0) {
        // fallback: pick first item that's a video
        topResult = search.all.find(i => i.type === 'video') || search.all[0];
      }

      if (!topResult) {
        return await sock.sendMessage(chatId, { text: '❌ No songs found!' }, { quoted: message });
      }
      const videoUrl = topResult.url || topResult.videoId ? `https://youtu.be/${topResult.videoId || ''}` : '';
      const title = topResult.title || topResult.name || 'Unknown Title';
      const duration = topResult.timestamp || topResult.duration || 'Unknown';
      const author = (topResult.author && topResult.author.name) || topResult.author || 'Unknown Artist';
      const thumbnail = topResult.thumbnail || (topResult.image && topResult.image.url) || '';

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

      // List of stable API endpoints to try
      const apiEndpoints = [
        // Option 1: MP3 Converter API with followRedirects
        {
          name: 'MP3 Converter',
          getUrl: (url) => `https://mp3-converter-video-downloader.p.rapidapi.com/convertMP3?url=${encodeURIComponent(url)}`,
          headers: {
            'X-RapidAPI-Key': '6c8e5e7f31mshc0a5f8c5a3e9f8f8f8f',
            'X-RapidAPI-Host': 'mp3-converter-video-downloader.p.rapidapi.com'
          },
          extractUrl: (data) => data?.result?.downloadUrl || data?.download_url || data?.url,
          isWorking: true
        },
        // Option 2: YouTube MP3 Direct
        {
          name: 'Direct MP3 Fetch',
          getUrl: (url) => `https://api.davidcyriltech.my.id/youtube-dl?url=${encodeURIComponent(url)}&quality=128`,
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
          extractUrl: (data) => data?.data?.url || data?.url,
          isWorking: true
        },
        // Option 3: YouTube Audio Extract
        {
          name: 'Audio Extract',
          getUrl: (url) => {
            const videoId = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/)?.[1];
            return `https://api-media-downloader.herokuapp.com/youtube/audio?url=${encodeURIComponent(url)}`;
          },
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
          extractUrl: (data) => data?.data?.url || data?.audio_url || data?.url,
          isWorking: true
        },
        // Option 4: Backup - Simple MP3 Download
        {
          name: 'FMP3 API',
          getUrl: (url) => `https://api.fabdl.com/youtube/info?url=${encodeURIComponent(url)}`,
          headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
          extractUrl: (data) => {
            if (data?.data?.formats) {
              const audio = data.data.formats.find(f => f.quality === '128' || f.format_id === '251');
              return audio?.url;
            }
            return data?.data?.url;
          },
          isWorking: true
        }
      ];

      let audioBuffer = null;
      let downloadedFrom = null;

      // Try each API endpoint
      for (const api of apiEndpoints) {
        try {
          console.log(`[Song] Trying API: ${api.name}`);
          const apiUrl = api.getUrl(videoUrl);
          
          const response = await axios.get(apiUrl, {
            headers: api.headers || { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
            timeout: 45000,
            maxRedirects: 5
          });

          if (response.data) {
            const dlUrl = api.extractUrl(response.data);
            
            if (!dlUrl || dlUrl.length < 10) {
              console.warn(`[Song] ${api.name} returned invalid URL`);
              continue;
            }

            try {
              console.log(`[Song] Downloading from: ${dlUrl.substring(0, 100)}...`);
              // Stream download to temp file with retries
              const downloadToTemp = async (url, attempts = 3) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const tmpFile = path.join(os.tmpdir(), `song_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
                    const resStream = await axios.get(url, {
                      responseType: 'stream',
                      timeout: 120000,
                      maxRedirects: 10,
                      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
                    });

                    const ctype = (resStream.headers && resStream.headers['content-type']) || '';
                    const clen = parseInt(resStream.headers && resStream.headers['content-length'] || '0');

                    // If response looks like HTML or very small, treat as failure and try next attempt
                    if (ctype.includes('text') || (!ctype && clen > 0 && clen < 5000) ) {
                      resStream.data.destroy();
                      throw new Error('Non-audio response');
                    }

                    const writer = fs.createWriteStream(tmpFile);
                    await new Promise((resolve, reject) => {
                      resStream.data.pipe(writer);
                      resStream.data.on('error', reject);
                      writer.on('finish', resolve);
                      writer.on('error', reject);
                    });

                    const stats = fs.statSync(tmpFile);
                    if (stats.size < 5000) {
                      fs.unlinkSync(tmpFile);
                      throw new Error('Downloaded file too small');
                    }

                    return { tmpFile, size: stats.size, contentType: ctype };
                  } catch (err) {
                    if (i === attempts - 1) throw err;
                    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                  }
                }
              };

              const result = await downloadToTemp(dlUrl, 3);
              if (!result) continue;

              // If file is reasonably small, load into buffer to send as `audio`
              if (result.size <= 25 * 1024 * 1024) {
                audioBuffer = fs.readFileSync(result.tmpFile);
                downloadedFrom = api.name;
                fs.unlinkSync(result.tmpFile);
                console.log(`[Song] ✓ Successfully downloaded from ${api.name} (${audioBuffer.length} bytes)`);
                break;
              } else {
                // For larger files, send as document stream to avoid high memory usage
                const stream = fs.createReadStream(result.tmpFile);
                downloadedFrom = api.name;
                console.log(`[Song] ✓ Downloaded large file from ${api.name} (${result.size} bytes) - sending as document`);
                await sock.sendMessage(chatId, {
                  document: stream,
                  mimetype: result.contentType || 'audio/mpeg',
                  fileName: `${title.replace(/[^a-zA-Z0-9 _.-]/g, '_')}.mp3`
                }, { quoted: message });
                try { fs.unlinkSync(result.tmpFile); } catch (e) {}
                return;
              }
            } catch (downloadError) {
              console.warn(`[Song] Download failed for ${api.name}:`, downloadError.message);
              continue;
            }
          }
        } catch (error) {
          console.warn(`[Song] API ${api.name} failed:`, error.message);
          continue;
        }
      }

      if (!audioBuffer) {
        // All main APIs failed, fallback to alternative handler immediately
        try {
          const alt = require('./song_alt');
          console.log('[Song] All main APIs failed, using alternative song handler (song_alt)');
          await alt.handler(sock, message, args, context);
          return;
        } catch (altErr) {
          console.error('[Song] Alternative handler failed:', altErr && altErr.message);
          return await sock.sendMessage(chatId, {
            text: '❌ *Download failed!*\n\nAll APIs and fallback methods are currently unavailable. Please try again later.'
          }, { quoted: message });
        }
      }

      if (audioBuffer) {
        console.log(`[Song] Sending audio file (${audioBuffer.length} bytes) downloaded from ${downloadedFrom}`);
        return await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${title.replace(/[^a-zA-Z0-9 _.-]/g, '_')}.mp3`
        }, { quoted: message });
      }
    } catch (error) {
      console.error('Song Error:', error);
      await sock.sendMessage(chatId, {
        text: `❌ *Download failed!*\n\n*Error:* ${error.message || 'Unknown error occurred'}`
      }, { quoted: message });
    } finally {
      await sock.sendPresenceUpdate('paused', chatId);
    }
  }
};

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
        // Fallback: try streaming directly with ytdl-core
        try {
          console.log('[Song] Attempting ytdl-core fallback...');
          const tmpFile = path.join(os.tmpdir(), `song_ytdl_${Date.now()}_${Math.random().toString(36).slice(2,8)}.tmp`);
          const stream = ytdl(videoUrl, { quality: 'highestaudio', filter: 'audioonly' });
          const writer = fs.createWriteStream(tmpFile);
          await new Promise((resolve, reject) => {
            stream.pipe(writer);
            stream.on('error', reject);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          const stats = fs.statSync(tmpFile);
          if (stats.size >= 5000) {
            if (stats.size <= 25 * 1024 * 1024) {
              audioBuffer = fs.readFileSync(tmpFile);
              downloadedFrom = 'ytdl-core';
              try { fs.unlinkSync(tmpFile); } catch {}
              console.log(`[Song] ✓ ytdl-core fallback succeeded (${audioBuffer.length} bytes)`);
            } else {
              // Send large files as documents
              const streamOut = fs.createReadStream(tmpFile);
              downloadedFrom = 'ytdl-core';
              await sock.sendMessage(chatId, {
                document: streamOut,
                mimetype: 'audio/mpeg',
                fileName: `${title.replace(/[^a-zA-Z0-9 _.-]/g, '_')}.mp3`
              }, { quoted: message });
              try { fs.unlinkSync(tmpFile); } catch (e) {}
              return;
            }
          } else {
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            throw new Error('ytdl produced too small file');
          }
        } catch (e) {
          console.warn('[Song] ytdl-core fallback failed:', e.message || e);
          // Last resort: try yt-dlp approach via RapidAPI
          try {
            console.log('[Song] Attempting last resort API...');
            const lastResortUrl = `https://yt-dlp-api.p.rapidapi.com/dl?url=${encodeURIComponent(videoUrl)}`;
            const response = await axios.get(lastResortUrl, {
              headers: {
                'X-RapidAPI-Key': '6c8e5e7f31mshc0a5f8c5a3e9f8f8f8f',
                'X-RapidAPI-Host': 'yt-dlp-api.p.rapidapi.com'
              },
              timeout: 60000
            });

            if (response.data?.data?.formats) {
              const audioFormat = response.data.data.formats
                .filter(f => f.vcodec === 'none' || f.acodec)
                .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
              if (audioFormat?.url) {
                const fileResponse = await axios.get(audioFormat.url, {
                  responseType: 'arraybuffer',
                  timeout: 120000,
                  maxRedirects: 5
                });
                audioBuffer = Buffer.from(fileResponse.data, 'binary');
                downloadedFrom = 'Last Resort API';
                console.log(`[Song] ✓ Last resort API succeeded`);
              }
            }
          } catch (le) {
            console.error('[Song] Last resort failed:', le.message || le);
          }
        }
      }

      if (!audioBuffer) {
        return await sock.sendMessage(chatId, {
          text: '❌ *Download failed!*\n\nAll APIs are currently unavailable. Please try again in a moment.'
        }, { quoted: message });
      }

      console.log(`[Song] Sending audio file (${audioBuffer.length} bytes) downloaded from ${downloadedFrom}`);
      return await sock.sendMessage(chatId, {
        audio: audioBuffer,
        mimetype: 'audio/mpeg',
        fileName: `${title.replace(/[^a-zA-Z0-9 _.-]/g, '_')}.mp3`
      }, { quoted: message });

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

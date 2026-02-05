const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = {
  command: 'cinesubz',
  aliases: ['cinesub'],
  category: 'movies',
  description: 'Search Cinesubz and get download links',
  usage: '.cinesubz <movie name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const query = args.join(' ').trim();

    try {
      if (!query) {
        return await sock.sendMessage(chatId, { text: '*Please provide a movie name.*\nExample: .cinesubz Ne Zha' }, { quoted: message });
      }

      await sock.sendMessage(chatId, { text: '🔎 Searching Cinesubz...' }, { quoted: message });

      const apiKey = 'dew_kuKmHwBBCgIAdUty5TBY1VWWtUgwbQwKRtC8MFUF';
      const searchUrl = `https://api.srihub.store/movie/cinesubz?q=${encodeURIComponent(query)}&apikey=${apiKey}`;
      const res = await axios.get(searchUrl, { timeout: 20000 });

      const results = res.data?.result;
      if (!Array.isArray(results) || results.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Build list message
      let caption = `🎬 *Cinesubz Results for:* *${query}*\n\n↩️ *Reply with a number to download*\n\n`;
      results.forEach((item, i) => {
        caption += `*${i + 1}.* ${item.title}\n`;
        if (item.quality) caption += `🔊 Quality: ${item.quality}\n`;
        if (item.imdb) caption += `⭐ IMDB: ${item.imdb}\n`;
        if (item.link) caption += `🔗 ${item.link}\n`;
        caption += `\n`;
      });

      const firstImg = results[0]?.image;
      const sentMsg = await sock.sendMessage(chatId, firstImg ? { image: { url: firstImg }, caption } : { text: caption }, { quoted: message });

      // Persist the URLs for this user/session (so restart doesn't immediately break)
      const urls = results.map(r => r.link);
      await store.saveSetting(senderId, 'cinesubz_results', urls);

      // Auto-expire
      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);
        try { await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please run the command again if you want to search.' }, { quoted: sentMsg }); } catch (e) {}
      }, 5 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim());
        if (isNaN(choice)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Please reply with the number of the movie.' }, { quoted: m });
        }

        const saved = await store.getSetting(senderId, 'cinesubz_results') || urls;
        if (!Array.isArray(saved) || saved.length === 0) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired or no saved results. Please run the command again.' }, { quoted: m });
        }

        if (choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);

        const selectedUrl = saved[choice - 1];
        await sock.sendMessage(chatId, { text: `ℹ️ Fetching download details for selection #${choice}...` }, { quoted: m });

        try {
          const dlUrl = `https://api.srihub.store/movie/cinesubzdl?url=${encodeURIComponent(selectedUrl)}&apikey=${apiKey}`;
          const dlRes = await axios.get(dlUrl, { timeout: 20000 });

          const movie = dlRes.data?.result;
          if (!movie) {
            return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
          }

          let info = `📥 *Download Details - ${movie.title || 'Movie'}*\n\n`;
          if (movie.year) info += `📆 Year: ${movie.year}\n`;
          if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
          if (movie.description) info += `\n${movie.description}\n\n`;

          // Flatten available download links but DO NOT expose raw URLs in the message
          const flatLinks = [];
          if (Array.isArray(movie.downloadOptions) && movie.downloadOptions.length > 0) {
            movie.downloadOptions.forEach(opt => {
              (opt.links || []).forEach(link => {
                flatLinks.push({
                  url: link.url,
                  quality: link.quality || 'N/A',
                  size: link.size || '',
                  server: opt.serverTitle || opt.server || ''
                });
              });
            });
          } else if (movie.sourceUrl) {
            flatLinks.push({ url: movie.sourceUrl, quality: 'N/A', size: '', server: '' });
          }

          if (flatLinks.length === 0) {
            info += '\n❌ No downloadable links found.';
            const image = movie.gallery && movie.gallery.length ? movie.gallery[0] : null;
            await sock.sendMessage(chatId, image ? { image: { url: image }, caption: info } : { text: info }, { quoted: m });
            return;
          }

          // Build a numbered list for the user to choose from (no raw URLs shown)
          info += '\n*Available Downloads:*\n\n';
          flatLinks.forEach((l, idx) => {
            info += `*${idx + 1}.* ${l.server || 'Server'} - ${l.quality} ${l.size ? `(${l.size})` : ''}\n`;
          });
          info += '\n↩️ *Reply with the number to download the file (will be sent to chat).*';

          const image = movie.gallery && movie.gallery.length ? movie.gallery[0] : null;
          const sentDlMsg = await sock.sendMessage(chatId, image ? { image: { url: image }, caption: info } : { text: info }, { quoted: m });

          // Persist the actual URLs for this user/session
          await store.saveSetting(senderId, 'cinesubz_dl_links', flatLinks.map(f => f.url));

          // Listen for a reply to this download-list message
          const dlTimeout = setTimeout(async () => {
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);
            try { await sock.sendMessage(chatId, { text: '⌛ Download selection expired. Please run the command again.' }, { quoted: sentDlMsg }); } catch (e) {}
          }, 5 * 60 * 1000);

          const dlListener = async ({ messages }) => {
            const mm = messages[0];
            if (!mm?.message || mm.key.remoteJid !== chatId) return;

            const ctx2 = mm.message?.extendedTextMessage?.contextInfo;
            if (!ctx2?.stanzaId || ctx2.stanzaId !== sentDlMsg.key.id) return;

            const replyText2 = mm.message.conversation || mm.message.extendedTextMessage?.text || '';
            const choice2 = parseInt(replyText2.trim());
            if (isNaN(choice2)) {
              return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Please reply with the number of the file to download.' }, { quoted: mm });
            }

            const savedLinks = await store.getSetting(senderId, 'cinesubz_dl_links') || [];
            if (!Array.isArray(savedLinks) || savedLinks.length === 0) {
              return await sock.sendMessage(chatId, { text: '❌ Session expired or no saved links. Please run the command again.' }, { quoted: mm });
            }

            if (choice2 < 1 || choice2 > savedLinks.length) {
              return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${savedLinks.length}.` }, { quoted: mm });
            }

            clearTimeout(dlTimeout);
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);

            const finalUrl = savedLinks[choice2 - 1];
            await sock.sendMessage(chatId, { text: `⬇️ Downloading selection #${choice2}... This may take a while depending on file size.` }, { quoted: mm });

            try {
              // Stream download to temp file with more robust resolution
              const downloadToTemp = async (url, attempts = 3) => {
                for (let i = 0; i < attempts; i++) {
                  try {
                    const tmpFile = path.join(os.tmpdir(), `cinesubz_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
                    const res = await axios.get(url, { responseType: 'stream', timeout: 5 * 60 * 1000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', 'Referer': selectedUrl || 'https://cinesubz.lk' } });
                    const ctype = (res.headers && res.headers['content-type']) || '';
                    const clen = parseInt(res.headers && res.headers['content-length'] || '0');

                    // If HTML returned, try to extract direct media link then retry
                    if (ctype.includes('text') || (ctype === '' && clen > 0 && clen < 10000)) {
                      try {
                        const textRes = await axios.get(url, { responseType: 'text', timeout: 20000, maxRedirects: 10, headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' } });
                        const html = textRes.data || '';
                        const mp4Match = html.match(/https?:\/\/[^'"\s>]+\.(?:mp4|mkv|webm)/gi);
                        let realUrl = mp4Match && mp4Match.length ? mp4Match[0] : null;
                        if (!realUrl) {
                          const $ = cheerio.load(html);
                          const source = $('video source[src]').attr('src') || $('video[src]').attr('src') || $('a[href$=".mp4"]').attr('href');
                          if (source) realUrl = new URL(source, url).toString();
                        }
                        if (realUrl) {
                          url = realUrl;
                          continue; // retry with resolved URL
                        }
                      } catch (htmlErr) {
                        console.warn('Cinesubz: HTML resolution failed', htmlErr && htmlErr.message);
                      }
                      // If still HTML, throw to try next attempt
                      throw new Error('HTML response, could not resolve media');
                    }

                    // Pipe stream to temporary file
                    const writer = fs.createWriteStream(tmpFile);
                    await new Promise((resolve, reject) => {
                      res.data.pipe(writer);
                      res.data.on('error', reject);
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

              const dlResult = await downloadToTemp(finalUrl, 3);
              if (!dlResult) {
                throw new Error('Failed to resolve or download file');
              }

              // Try detect file type by reading the initial bytes
              const readChunk = (file, len = 8192) => new Promise((resolve, reject) => {
                const rs = fs.createReadStream(file, { start: 0, end: len - 1 });
                const chunks = [];
                rs.on('data', c => chunks.push(c));
                rs.on('end', () => resolve(Buffer.concat(chunks)));
                rs.on('error', reject);
              });
              const bufferStart = await readChunk(dlResult.tmpFile, 8192);
              let type = await fromBuffer(bufferStart);

              const safeTitle = (movie.title || 'movie').replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 200);
              const ext = (type && type.ext) ? type.ext : 'mp4';
              const fileName = `${safeTitle}_${choice2}.${ext}`;

              // Send based on detected type
              if (type && type.mime && type.mime.startsWith('image/')) {
                const buf = fs.readFileSync(dlResult.tmpFile);
                await sock.sendMessage(chatId, { image: buf, caption: `Here is ${fileName}` }, { quoted: mm });
              } else if (type && type.mime && type.mime.startsWith('video/')) {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { document: stream, mimetype: type.mime, fileName }, { quoted: mm });
              } else if (type && type.mime && type.mime.startsWith('audio/')) {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { audio: stream, mimetype: type.mime }, { quoted: mm });
              } else {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { document: stream, mimetype: type ? type.mime : 'application/octet-stream', fileName }, { quoted: mm });
              }

              try { fs.unlinkSync(dlResult.tmpFile); } catch (e) {}

            } catch (e) {
              console.error('❌ Cinesubz Download Error:', e.message || e);
              await sock.sendMessage(chatId, { text: '❌ Failed to download or send the file. The source may block direct downloads or file is too large.' }, { quoted: mm });
            }
          };

          sock.ev.on('messages.upsert', dlListener);

        } catch (e) {
          console.error('❌ Cinesubz DL Error:', e.message || e);
          await sock.sendMessage(chatId, { text: '❌ Error fetching download details. Please try again later.' }, { quoted: m });
        }
      };

      sock.ev.on('messages.upsert', listener);

    } catch (err) {
      console.error('❌ Cinesubz Plugin Error:', err.message || err);
      await sock.sendMessage(chatId, { text: '❌ Failed to process request. Please try again later.' }, { quoted: message });
    }
  }
};

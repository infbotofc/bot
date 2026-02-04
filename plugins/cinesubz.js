const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');

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
              const resBuf = await axios.get(finalUrl, { responseType: 'arraybuffer', timeout: 5 * 60 * 1000 });
              const buffer = Buffer.from(resBuf.data, 'binary');
              const type = await fromBuffer(buffer);

              const safeTitle = (movie.title || 'movie').replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 200);
              const ext = (type && type.ext) ? type.ext : 'mp4';
              const fileName = `${safeTitle}_${choice2}.${ext}`;

              if (type && type.mime && type.mime.startsWith('image/')) {
                await sock.sendMessage(chatId, { image: buffer, caption: `Here is ${fileName}` }, { quoted: mm });
              } else if (type && type.mime && type.mime.startsWith('video/')) {
                await sock.sendMessage(chatId, { document: buffer, mimetype: type.mime, fileName }, { quoted: mm });
              } else if (type && type.mime && type.mime.startsWith('audio/')) {
                await sock.sendMessage(chatId, { audio: buffer, mimetype: type.mime }, { quoted: mm });
              } else {
                await sock.sendMessage(chatId, { document: buffer, mimetype: type ? type.mime : 'application/octet-stream', fileName }, { quoted: mm });
              }

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

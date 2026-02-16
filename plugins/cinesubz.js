/**
 * Cinesubz Plugin (FINAL) - TMDb 18+ Block + File-or-Link Reply
 * -------------------------------------------------------------
 * ✅ Blocks adult movies using TMDb (adult flag) + keyword fallback
 * ✅ Filters adult results in search list + blocks again in details stage
 * ✅ Sends FILE to chat if possible; if too large/fails -> sends LINK
 * ✅ Session-based reply selection (same as your original)
 *
 * Notes:
 * - Put your TMDb key in ENV if you want: TMDB_KEY=xxxx
 * - MAX_SEND_MB depends on WhatsApp limits; keep safe (80-100MB)
 */

const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const MAX_SEND_MB = 90; // file size limit for sending to chat (fallback to link if bigger)

// ===================== Adult Filter (TMDb) =====================
const TMDB_KEY = process.env.TMDB_KEY || '3c3765d22672d49fd193b764324d3493';

const ADULT_KEYWORDS = [
  '18+', 'adult', 'nsfw', 'porn', 'xxx', 'sex', 'erotic', 'erotica', 'nude', 'nudity',
  'softcore', 'hardcore', 'bdsm', 'fetish', 'onlyfans',
  '365 days', '365days', 'fifty shades', '50 shades'
];

function norm(s = '') {
  return String(s).toLowerCase().replace(/[\W_]+/g, ' ').trim();
}

function containsAdultKeyword(text = '') {
  const t = ` ${norm(text)} `;
  return ADULT_KEYWORDS.some(k => {
    const kk = norm(k);
    return t.includes(` ${kk} `) || t.includes(kk);
  });
}

async function isAdultByTMDB(title, year) {
  try {
    if (!TMDB_KEY || !title) return null;

    const url = 'https://api.themoviedb.org/3/search/movie';
    const params = {
      api_key: TMDB_KEY,
      query: title,
      include_adult: true
    };
    if (year) params.year = year;

    const r = await axios.get(url, { params, timeout: 12000 });
    const items = r.data?.results || [];
    if (!items.length) return null;

    // best match
    return !!items[0].adult;
  } catch {
    return null;
  }
}

async function shouldBlockAdult({ query, title, description, year }) {
  if (containsAdultKeyword(query) || containsAdultKeyword(title) || containsAdultKeyword(description)) {
    return true;
  }
  const tmdbAdult = await isAdultByTMDB(title || query, year);
  if (tmdbAdult === true) return true;
  return false;
}

async function loadAdultConfig(chatId) {
  // default: block adult everywhere
  const cfg = await store.getSetting(chatId, 'adult_filter');
  return cfg || { blockAdult: true };
}

async function saveAdultConfig(chatId, cfg) {
  await store.saveSetting(chatId, 'adult_filter', cfg);
}

// ===================== Download helper =====================
async function downloadToTemp(url, referer, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const tmpFile = path.join(
        os.tmpdir(),
        `cinesubz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      );

      const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 5 * 60 * 1000,
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
          'Referer': referer || 'https://cinesubz.lk'
        }
      });

      const ctype = (res.headers && res.headers['content-type']) || '';
      const clen = parseInt((res.headers && res.headers['content-length']) || '0');

      // If HTML returned, try to extract direct media link then retry
      if (ctype.includes('text') || (ctype === '' && clen > 0 && clen < 10000)) {
        try {
          const textRes = await axios.get(url, {
            responseType: 'text',
            timeout: 20000,
            maxRedirects: 10,
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }
          });
          const html = textRes.data || '';
          const mediaMatch = html.match(/https?:\/\/[^'"\s>]+\.(?:mp4|mkv|webm)/gi);
          let realUrl = mediaMatch && mediaMatch.length ? mediaMatch[0] : null;

          if (!realUrl) {
            const $ = cheerio.load(html);
            const source =
              $('video source[src]').attr('src') ||
              $('video[src]').attr('src') ||
              $('a[href$=".mp4"]').attr('href') ||
              $('a[href$=".mkv"]').attr('href') ||
              $('a[href$=".webm"]').attr('href');

            if (source) realUrl = new URL(source, url).toString();
          }

          if (realUrl) {
            url = realUrl; // retry with resolved
            continue;
          }
        } catch (htmlErr) {
          console.warn('Cinesubz: HTML resolution failed', htmlErr?.message);
        }
        throw new Error('HTML response, could not resolve media');
      }

      // Pipe stream to file
      const writer = fs.createWriteStream(tmpFile);
      await new Promise((resolve, reject) => {
        res.data.pipe(writer);
        res.data.on('error', reject);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const stats = fs.statSync(tmpFile);
      if (stats.size < 5000) {
        try { fs.unlinkSync(tmpFile); } catch {}
        throw new Error('Downloaded file too small');
      }

      return { tmpFile, size: stats.size, contentType: ctype };
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function readChunk(file, len = 8192) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { start: 0, end: len - 1 });
    const chunks = [];
    rs.on('data', c => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
    rs.on('error', reject);
  });
}

module.exports = {
  command: 'cinesubz',
  aliases: ['cinesub'],
  category: 'movies',
  description: 'Search Cinesubz and get download links (blocks 18+ using TMDb)',
  usage: '.cinesubz <movie name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const query = args.join(' ').trim();

    try {
      if (!query) {
        return await sock.sendMessage(
          chatId,
          { text: '*Please provide a movie name.*\nExample: .cinesubz Ne Zha' },
          { quoted: message }
        );
      }

      // Optional config command inside same plugin:
      // .cinesubz adultfilter on/off
      if (args[0]?.toLowerCase() === 'adultfilter') {
        const action = (args[1] || '').toLowerCase();
        if (!action) {
          const cfg = await loadAdultConfig(chatId);
          return await sock.sendMessage(
            chatId,
            { text: `*Adult Filter:* ${cfg.blockAdult ? '✅ ON (blocking 18+)' : '❌ OFF (allowing 18+)'}\n\nUse: .cinesubz adultfilter on/off` },
            { quoted: message }
          );
        }
        const cfg = await loadAdultConfig(chatId);
        if (action === 'on') cfg.blockAdult = true;
        else if (action === 'off') cfg.blockAdult = false;
        else return await sock.sendMessage(chatId, { text: '❌ Invalid. Use: on/off' }, { quoted: message });
        await saveAdultConfig(chatId, cfg);
        return await sock.sendMessage(
          chatId,
          { text: `✅ Adult Filter is now: *${cfg.blockAdult ? 'ON (blocking 18+)' : 'OFF (allowing 18+)'}*` },
          { quoted: message }
        );
      }

      // Quick block by query
      const chatCfg0 = await loadAdultConfig(chatId);
      if (chatCfg0.blockAdult) {
        const qBlock = await shouldBlockAdult({ query });
        if (qBlock) {
          return await sock.sendMessage(
            chatId,
            { text: '🚫 *Blocked:* This request appears to be *18+ / adult content*.\n\nTry a different movie name.' },
            { quoted: message }
          );
        }
      }

      await sock.sendMessage(chatId, { text: '🔎 Searching Cinesubz...' }, { quoted: message });

      const apiKey = 'dew_kuKmHwBBCgIAdUty5TBY1VWWtUgwbQwKRtC8MFUF';
      const searchUrl = `https://api.srihub.store/movie/cinesubz?q=${encodeURIComponent(query)}&apikey=${apiKey}`;
      const res = await axios.get(searchUrl, { timeout: 20000 });

      let results = res.data?.result;
      if (!Array.isArray(results) || results.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Filter adult results (TMDb + keywords)
      const chatCfg = await loadAdultConfig(chatId);
      if (chatCfg.blockAdult) {
        const filtered = [];
        for (const item of results) {
          const block = await shouldBlockAdult({ query, title: item?.title });
          if (!block) filtered.push(item);
        }
        results = filtered;

        if (!results.length) {
          return await sock.sendMessage(
            chatId,
            { text: '🚫 *Blocked:* Results appear to be *18+ / adult content*.' },
            { quoted: message }
          );
        }
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
      const sentMsg = await sock.sendMessage(
        chatId,
        firstImg ? { image: { url: firstImg }, caption } : { text: caption },
        { quoted: message }
      );

      // Persist URLs for selection step
      const urls = results.map(r => r.link);
      await store.saveSetting(senderId, 'cinesubz_results', urls);

      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);
        try {
          await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please run the command again.' }, { quoted: sentMsg });
        } catch {}
      }, 5 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim(), 10);

        if (isNaN(choice)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with the number of the movie.' }, { quoted: m });
        }

        const saved = (await store.getSetting(senderId, 'cinesubz_results')) || urls;
        if (!Array.isArray(saved) || !saved.length) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: m });
        }

        if (choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);

        const selectedUrl = saved[choice - 1];

        await sock.sendMessage(chatId, { text: `ℹ️ Fetching download details for #${choice}...` }, { quoted: m });

        try {
          const dlUrl = `https://api.srihub.store/movie/cinesubzdl?url=${encodeURIComponent(selectedUrl)}&apikey=${apiKey}`;
          const dlRes = await axios.get(dlUrl, { timeout: 20000 });

          const movie = dlRes.data?.result;
          if (!movie) {
            return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
          }

          // Block adult again at details stage
          const chatCfg2 = await loadAdultConfig(chatId);
          if (chatCfg2.blockAdult) {
            const block = await shouldBlockAdult({
              query,
              title: movie.title,
              description: movie.description,
              year: movie.year
            });
            if (block) {
              return await sock.sendMessage(
                chatId,
                { text: `🚫 *Blocked:* *${movie.title || 'This movie'}* appears to be *18+ / adult content*.\nDownload disabled.` },
                { quoted: m }
              );
            }
          }

          let info = `📥 *Download Details - ${movie.title || 'Movie'}*\n\n`;
          if (movie.year) info += `📆 Year: ${movie.year}\n`;
          if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
          if (movie.description) info += `\n${movie.description}\n\n`;

          // Flatten download links (no raw URLs in message)
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

          if (!flatLinks.length) {
            info += '\n❌ No downloadable links found.';
            const image = movie.gallery?.length ? movie.gallery[0] : null;
            await sock.sendMessage(chatId, image ? { image: { url: image }, caption: info } : { text: info }, { quoted: m });
            return;
          }

          info += '\n*Available Downloads:*\n\n';
          flatLinks.forEach((l, idx) => {
            info += `*${idx + 1}.* ${l.server || 'Server'} - ${l.quality} ${l.size ? `(${l.size})` : ''}\n`;
          });
          info += '\n↩️ *Reply with the number to receive the file.*\nIf file is too big, bot will send link.';

          const image = movie.gallery?.length ? movie.gallery[0] : null;
          const sentDlMsg = await sock.sendMessage(chatId, image ? { image: { url: image }, caption: info } : { text: info }, { quoted: m });

          await store.saveSetting(senderId, 'cinesubz_dl_links', flatLinks.map(f => f.url));

          const dlTimeout = setTimeout(async () => {
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);
            try { await sock.sendMessage(chatId, { text: '⌛ Download selection expired. Run the command again.' }, { quoted: sentDlMsg }); } catch {}
          }, 5 * 60 * 1000);

          const dlListener = async ({ messages }) => {
            const mm = messages[0];
            if (!mm?.message || mm.key.remoteJid !== chatId) return;

            const ctx2 = mm.message?.extendedTextMessage?.contextInfo;
            if (!ctx2?.stanzaId || ctx2.stanzaId !== sentDlMsg.key.id) return;

            const replyText2 = mm.message.conversation || mm.message.extendedTextMessage?.text || '';
            const choice2 = parseInt(replyText2.trim(), 10);

            if (isNaN(choice2)) {
              return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with the file number.' }, { quoted: mm });
            }

            const savedLinks = (await store.getSetting(senderId, 'cinesubz_dl_links')) || [];
            if (!Array.isArray(savedLinks) || !savedLinks.length) {
              return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: mm });
            }

            if (choice2 < 1 || choice2 > savedLinks.length) {
              return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${savedLinks.length}.` }, { quoted: mm });
            }

            clearTimeout(dlTimeout);
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);

            const finalUrl = savedLinks[choice2 - 1];

            await sock.sendMessage(chatId, { text: `⬇️ Preparing selection #${choice2}...` }, { quoted: mm });

            // ===== FILE OR LINK DELIVERY =====
            try {
              const dlResult = await downloadToTemp(finalUrl, selectedUrl, 3);
              const sizeMB = dlResult.size / (1024 * 1024);

              // Too big => send link
              if (sizeMB > MAX_SEND_MB) {
                try { fs.unlinkSync(dlResult.tmpFile); } catch {}
                return await sock.sendMessage(chatId, {
                  text: `⚠️ File is too large to send (${sizeMB.toFixed(1)} MB).\n\n✅ Download link:\n${finalUrl}`
                }, { quoted: mm });
              }

              // detect type
              const bufferStart = await readChunk(dlResult.tmpFile, 8192);
              const type = await fromBuffer(bufferStart);

              const safeTitle = (movie.title || 'movie').replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 200);
              const ext = (type && type.ext) ? type.ext : 'mp4';
              const fileName = `${safeTitle}_${choice2}.${ext}`;

              if (type?.mime?.startsWith('image/')) {
                const buf = fs.readFileSync(dlResult.tmpFile);
                await sock.sendMessage(chatId, { image: buf, caption: `✅ ${fileName}` }, { quoted: mm });
              } else if (type?.mime?.startsWith('video/')) {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { document: stream, mimetype: type.mime, fileName }, { quoted: mm });
              } else if (type?.mime?.startsWith('audio/')) {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { audio: stream, mimetype: type.mime }, { quoted: mm });
              } else {
                const stream = fs.createReadStream(dlResult.tmpFile);
                await sock.sendMessage(chatId, { document: stream, mimetype: type ? type.mime : 'application/octet-stream', fileName }, { quoted: mm });
              }

              try { fs.unlinkSync(dlResult.tmpFile); } catch {}

            } catch (e) {
              console.error('❌ Cinesubz Download Error:', e.message || e);
              // Fallback to link
              await sock.sendMessage(chatId, {
                text: `❌ Failed to send the file (blocked/too large).\n\n✅ Download link:\n${finalUrl}`
              }, { quoted: mm });
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

/**
 * Cinesubz (FINAL) — Allow all + 18+ warning + No media for 18+
 * -------------------------------------------------------------
 * ✅ Everyone can use it (NO access denied)
 * ✅ Detects 18+ with TMDb adult flag + keyword fallback
 * ✅ If 18+:
 *    - shows 🔞 warning
 *    - NO poster/banner images
 *    - NO file/media sending
 *    - ONLY sends direct download LINK as text
 * ✅ If NOT 18+:
 *    - normal list can include poster
 *    - normal download tries to send file, fallback link if too big/fails
 */

const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const SRIHUB_API_KEY = 'dew_FEIXBd8x3XE6eshtBtM1NwEV5IxSLI6PeRE2zLmi';
const TMDB_KEY = process.env.TMDB_KEY || '3c3765d22672d49fd193b764324d3493';

const MAX_SEND_MB = 90;

// ---------- 18+ detection ----------
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
    const params = { api_key: TMDB_KEY, query: title, include_adult: true };
    if (year) params.year = year;
    const r = await axios.get(url, { params, timeout: 12000 });
    const items = r.data?.results || [];
    if (!items.length) return null;
    return !!items[0].adult;
  } catch {
    return null;
  }
}

async function isAdultMovie({ query, title, description, year }) {
  if (containsAdultKeyword(query) || containsAdultKeyword(title) || containsAdultKeyword(description)) return true;
  const tmdbAdult = await isAdultByTMDB(title || query, year);
  if (tmdbAdult === true) return true;
  return false;
}

// ---------- Download helpers (non-18+ only) ----------
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

      // HTML returned => try resolve media url
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
            url = realUrl;
            continue;
          }
        } catch {}
        throw new Error('HTML response, could not resolve media');
      }

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

// ---------- Plugin ----------
module.exports = {
  command: 'cinesubz',
  aliases: ['cinesub'],
  category: 'movies',
  description: 'Search Cinesubz + download (18+ allowed but link-only + no banners)',
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

      const searchUrl = `https://api.srihub.store/movie/cinesubz?q=${encodeURIComponent(query)}&apikey=${SRIHUB_API_KEY}`;
      const res = await axios.get(searchUrl, { timeout: 20000 });

      let results = res.data?.result;
      if (!Array.isArray(results) || results.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Mark results with adult flag (best effort)
      const marked = [];
      for (const item of results) {
        const adult = await isAdultMovie({ query, title: item?.title });
        marked.push({ ...item, __adult: adult });
      }
      results = marked;

      const hasAdultInList = results.some(r => r.__adult);

      // Build list
      let caption =
        `🎬 *Cinesubz Results for:* *${query}*\n\n` +
        `↩️ *Reply with a number to continue*\n\n`;

      results.forEach((item, i) => {
        caption += `*${i + 1}.* ${item.__adult ? '🔞' : '✅'} ${item.title}\n`;
        if (item.quality) caption += `🔊 Quality: ${item.quality}\n`;
        if (item.imdb) caption += `⭐ IMDB: ${item.imdb}\n`;
        caption += `\n`;
      });

      // If any adult results exist => TEXT ONLY (no banner image)
      const firstImg = results[0]?.image;
      const sentMsg = await sock.sendMessage(
        chatId,
        (firstImg && !hasAdultInList) ? { image: { url: firstImg }, caption } : { text: caption },
        { quoted: message }
      );

      // Save selection list with titles + links
      await store.saveSetting(senderId, 'cinesubz_results', results.map(r => ({ link: r.link, title: r.title, adult: !!r.__adult })) );

      // expire
      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);
        try { await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please run the command again.' }, { quoted: sentMsg }); } catch {}
      }, 5 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim(), 10);
        if (isNaN(choice)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with the number.' }, { quoted: m });
        }

        const saved = (await store.getSetting(senderId, 'cinesubz_results')) || [];
        if (!Array.isArray(saved) || !saved.length) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: m });
        }

        if (choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'cinesubz_results', null);

        const selected = saved[choice - 1];
        const selectedUrl = selected.link;

        await sock.sendMessage(chatId, { text: `ℹ️ Fetching download details for #${choice}...` }, { quoted: m });

        try {
          const dlUrl = `https://api.srihub.store/movie/cinesubzdl?url=${encodeURIComponent(selectedUrl)}&apikey=${SRIHUB_API_KEY}`;
          const dlRes = await axios.get(dlUrl, { timeout: 20000 });

          const movie = dlRes.data?.result;
          if (!movie) {
            return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
          }

          // Decide adult at details stage (more accurate)
          const isAdult = await isAdultMovie({
            query,
            title: movie.title || selected.title || query,
            description: movie.description,
            year: movie.year
          });

          // Flatten download links
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

          let info = `📥 *Download Details - ${movie.title || 'Movie'}*\n\n`;
          if (movie.year) info += `📆 Year: ${movie.year}\n`;
          if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
          if (movie.description) info += `\n${movie.description}\n\n`;

          if (isAdult) info += `🔞 *18+ content detected* — media is disabled. Links only.\n\n`;

          if (!flatLinks.length) {
            info += '\n❌ No downloadable links found.';
            // Adult => TEXT ONLY, Non-adult => can attach image
            const image = movie.gallery?.length ? movie.gallery[0] : null;
            await sock.sendMessage(
              chatId,
              (!isAdult && image) ? { image: { url: image }, caption: info } : { text: info },
              { quoted: m }
            );
            return;
          }

          info += `*Available Downloads:*\n\n`;
          flatLinks.forEach((l, idx) => {
            info += `*${idx + 1}.* ${l.server || 'Server'} - ${l.quality} ${l.size ? `(${l.size})` : ''}\n`;
          });

          info += isAdult
            ? '\n↩️ Reply with number to get the LINK (no media).'
            : '\n↩️ Reply with number to get the FILE (or link if too big).';

          const image = movie.gallery?.length ? movie.gallery[0] : null;
          const sentDlMsg = await sock.sendMessage(
            chatId,
            (!isAdult && image) ? { image: { url: image }, caption: info } : { text: info },
            { quoted: m }
          );

          await store.saveSetting(senderId, 'cinesubz_dl_links', flatLinks.map(f => f.url));
          await store.saveSetting(senderId, 'cinesubz_is_adult_mode', !!isAdult);
          await store.saveSetting(senderId, 'cinesubz_ref_url', selectedUrl);

          const dlTimeout = setTimeout(async () => {
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);
            await store.saveSetting(senderId, 'cinesubz_is_adult_mode', null);
            await store.saveSetting(senderId, 'cinesubz_ref_url', null);
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
            const adultMode = !!(await store.getSetting(senderId, 'cinesubz_is_adult_mode'));
            const refUrl = (await store.getSetting(senderId, 'cinesubz_ref_url')) || '';

            if (!Array.isArray(savedLinks) || !savedLinks.length) {
              return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: mm });
            }

            if (choice2 < 1 || choice2 > savedLinks.length) {
              return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${savedLinks.length}.` }, { quoted: mm });
            }

            clearTimeout(dlTimeout);
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderId, 'cinesubz_dl_links', null);
            await store.saveSetting(senderId, 'cinesubz_is_adult_mode', null);
            await store.saveSetting(senderId, 'cinesubz_ref_url', null);

            const finalUrl = savedLinks[choice2 - 1];

            // 18+ => LINK ONLY (no media)
            if (adultMode) {
              return await sock.sendMessage(chatId, {
                text: `🔞 *18+ content detected* — media disabled.\n\n✅ Download link:\n${finalUrl}`
              }, { quoted: mm });
            }

            // Normal => try file, fallback link
            await sock.sendMessage(chatId, { text: `⬇️ Downloading #${choice2}...` }, { quoted: mm });

            try {
              const dlResult = await downloadToTemp(finalUrl, refUrl, 3);
              const sizeMB = dlResult.size / (1024 * 1024);

              if (sizeMB > MAX_SEND_MB) {
                try { fs.unlinkSync(dlResult.tmpFile); } catch {}
                return await sock.sendMessage(chatId, {
                  text: `⚠️ File too large to send (${sizeMB.toFixed(1)} MB).\n\n✅ Link:\n${finalUrl}`
                }, { quoted: mm });
              }

              const bufferStart = await readChunk(dlResult.tmpFile, 8192);
              const type = await fromBuffer(bufferStart);

              const safeTitle = (query || 'movie').replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 200);
              const ext = (type && type.ext) ? type.ext : 'mp4';
              const fileName = `${safeTitle}_${choice2}.${ext}`;

              const stream = fs.createReadStream(dlResult.tmpFile);
              await sock.sendMessage(chatId, {
                document: stream,
                mimetype: type?.mime || 'application/octet-stream',
                fileName
              }, { quoted: mm });

              try { fs.unlinkSync(dlResult.tmpFile); } catch {}
            } catch (e) {
              await sock.sendMessage(chatId, {
                text: `❌ Failed to send file.\n\n✅ Link:\n${finalUrl}`
              }, { quoted: mm });
            }
          };

          sock.ev.on('messages.upsert', dlListener);

        } catch (e) {
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

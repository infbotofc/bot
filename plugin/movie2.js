/**
 * .movie2 (SriHub) — Search -> pick -> download list -> pick (send file or link)
 * -----------------------------------------------------------------------------
 * Endpoints:
 *  Search:   https://api.srihub.store/movie/srihub?q=<name>&apikey=<key>
 *  Details:  https://api.srihub.store/movie/srihubdl?url=<srihub_post_url>&apikey=<key>
 *
 * 18+ Policy (same as your latest):
 * ✅ Allow everyone
 * ⚠️ If 18+ detected:
 *   - Notify 🔞
 *   - NO banners/posters/images
 *   - NO file/media sending
 *   - LINK ONLY (text)
 * ✅ If NOT 18+:
 *   - Can attach poster/banner if provided
 *   - Can send file (document), fallback to link if too big/fails
 */

const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const API_KEY = 'dew_kuKmHwBBCgIAdUty5TBY1VWWtUgwbQwKRtC8MFUF';
const BASE = 'https://api.srihub.store/movie';

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
  return tmdbAdult === true;
}

// ---------- Helpers ----------
function pickPostUrl(item) {
  return (
    item?.link ||
    item?.url ||
    item?.postUrl ||
    item?.permalink ||
    item?.href ||
    item?.sourceUrl ||
    item?.page ||
    ''
  );
}
function pickImage(item) {
  return item?.image || item?.poster || item?.thumb || item?.thumbnail || item?.cover || null;
}

// ---------- Download helpers (NON-18+ only) ----------
async function downloadToTemp(url, referer, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const tmpFile = path.join(
        os.tmpdir(),
        `srihub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      );

      const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 5 * 60 * 1000,
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
          'Referer': referer || 'https://srihub.store'
        }
      });

      const ctype = (res.headers && res.headers['content-type']) || '';
      const clen = parseInt((res.headers && res.headers['content-length']) || '0');

      // HTML returned => try resolve direct media link
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
  command: 'movie2',
  aliases: ['srihub', 'srihubmovie'],
  category: 'movies',
  description: 'Search SriHub and download movies (18+ warns & links-only)',
  usage: '.movie2 <movie name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const query = args.join(' ').trim();

    try {
      if (!query) {
        return await sock.sendMessage(chatId, { text: '*Please provide a movie name.*\nExample: .movie2 Ne Zha' }, { quoted: message });
      }

      await sock.sendMessage(chatId, { text: '🔎 Searching SriHub...' }, { quoted: message });

      const searchUrl = `${BASE}/srihub?q=${encodeURIComponent(query)}&apikey=${API_KEY}`;
      const res = await axios.get(searchUrl, { timeout: 20000 });

      const raw = res.data?.result;
      if (!Array.isArray(raw) || raw.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // normalize results + mark adult
      let results = [];
      for (const item of raw) {
        const title = item?.title || item?.name || '';
        const url = pickPostUrl(item);
        if (!url) continue;
        const adult = await isAdultMovie({ query, title });
        results.push({
          title,
          url,
          image: pickImage(item),
          quality: item?.quality,
          imdb: item?.imdb,
          year: item?.year,
          adult
        });
      }

      results = results.slice(0, 20);
      if (!results.length) {
        return await sock.sendMessage(chatId, { text: '❌ No usable results (missing URLs).' }, { quoted: message });
      }

      const hasAdultInList = results.some(r => r.adult);

      let caption = `🎬 *SriHub Results for:* *${query}*\n\n↩️ *Reply with a number to continue*\n\n`;
      results.forEach((r, i) => {
        caption += `*${i + 1}.* ${r.adult ? '🔞' : '✅'} ${r.title}\n`;
        if (r.quality) caption += `🔊 Quality: ${r.quality}\n`;
        if (r.imdb) caption += `⭐ IMDB: ${r.imdb}\n`;
        if (r.year) caption += `📆 Year: ${r.year}\n`;
        caption += `\n`;
      });

      // If any adult results exist => TEXT ONLY (no posters)
      const sentMsg = await sock.sendMessage(
        chatId,
        (results[0].image && !hasAdultInList) ? { image: { url: results[0].image }, caption } : { text: caption },
        { quoted: message }
      );

      await store.saveSetting(senderId, 'srihub_results', results);

      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'srihub_results', null);
        try { await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please search again.' }, { quoted: sentMsg }); } catch {}
      }, 5 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim(), 10);
        const saved = (await store.getSetting(senderId, 'srihub_results')) || results;

        if (!Array.isArray(saved) || !saved.length) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: m });
        }

        if (Number.isNaN(choice) || choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'srihub_results', null);

        const selected = saved[choice - 1];
        await sock.sendMessage(chatId, { text: `ℹ️ Fetching details for #${choice}...` }, { quoted: m });

        const dlUrl = `${BASE}/srihubdl?url=${encodeURIComponent(selected.url)}&apikey=${API_KEY}`;
        const dlRes = await axios.get(dlUrl, { timeout: 20000 });

        const movie = dlRes.data?.result;
        if (!movie) {
          return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
        }

        const isAdult = await isAdultMovie({
          query,
          title: movie.title || selected.title || query,
          description: movie.description,
          year: movie.year
        });

        // flatten links
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
        } else if (Array.isArray(movie.links)) {
          movie.links.forEach(l => flatLinks.push({ url: l.url || l.link, quality: l.quality || 'N/A', size: l.size || '', server: l.server || '' }));
        }

        let info = `📥 *Download Details - ${movie.title || selected.title || 'Movie'}*\n\n`;
        if (movie.year) info += `📆 Year: ${movie.year}\n`;
        if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
        if (movie.description) info += `\n${movie.description}\n\n`;
        if (isAdult) info += `🔞 *18+ content detected* — media disabled. Links only.\n\n`;

        if (!flatLinks.length) {
          info += '❌ No downloadable links found.';
          const img = movie.gallery?.[0] || movie.image || selected.image;
          return await sock.sendMessage(
            chatId,
            (!isAdult && img) ? { image: { url: img }, caption: info } : { text: info },
            { quoted: m }
          );
        }

        info += `*Available Downloads:*\n\n`;
        flatLinks.forEach((l, idx) => {
          info += `*${idx + 1}.* ${l.server || 'Server'} - ${l.quality} ${l.size ? `(${l.size})` : ''}\n`;
        });

        info += isAdult
          ? '\n↩️ Reply with number to get the LINK (no media).'
          : '\n↩️ Reply with number to get the FILE (or link if too big).';

        const img = movie.gallery?.[0] || movie.image || selected.image;
        const sentDlMsg = await sock.sendMessage(
          chatId,
          (!isAdult && img) ? { image: { url: img }, caption: info } : { text: info },
          { quoted: m }
        );

        await store.saveSetting(senderId, 'srihub_dl_links', flatLinks.map(f => f.url));
        await store.saveSetting(senderId, 'srihub_is_adult_mode', !!isAdult);
        await store.saveSetting(senderId, 'srihub_ref_url', selected.url);
        await store.saveSetting(senderId, 'srihub_title', movie.title || selected.title || query);

        const dlTimeout = setTimeout(async () => {
          sock.ev.off('messages.upsert', dlListener);
          await store.saveSetting(senderId, 'srihub_dl_links', null);
          await store.saveSetting(senderId, 'srihub_is_adult_mode', null);
          await store.saveSetting(senderId, 'srihub_ref_url', null);
          await store.saveSetting(senderId, 'srihub_title', null);
          try { await sock.sendMessage(chatId, { text: '⌛ Selection expired. Run the command again.' }, { quoted: sentDlMsg }); } catch {}
        }, 5 * 60 * 1000);

        const dlListener = async ({ messages }) => {
          const mm = messages[0];
          if (!mm?.message || mm.key.remoteJid !== chatId) return;

          const ctx2 = mm.message?.extendedTextMessage?.contextInfo;
          if (!ctx2?.stanzaId || ctx2.stanzaId !== sentDlMsg.key.id) return;

          const replyText2 = mm.message.conversation || mm.message.extendedTextMessage?.text || '';
          const choice2 = parseInt(replyText2.trim(), 10);

          const savedLinks = (await store.getSetting(senderId, 'srihub_dl_links')) || [];
          const adultMode = !!(await store.getSetting(senderId, 'srihub_is_adult_mode'));
          const refUrl = (await store.getSetting(senderId, 'srihub_ref_url')) || '';
          const title = (await store.getSetting(senderId, 'srihub_title')) || 'movie';

          if (!Array.isArray(savedLinks) || !savedLinks.length) {
            return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: mm });
          }
          if (Number.isNaN(choice2) || choice2 < 1 || choice2 > savedLinks.length) {
            return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${savedLinks.length}.` }, { quoted: mm });
          }

          clearTimeout(dlTimeout);
          sock.ev.off('messages.upsert', dlListener);
          await store.saveSetting(senderId, 'srihub_dl_links', null);
          await store.saveSetting(senderId, 'srihub_is_adult_mode', null);
          await store.saveSetting(senderId, 'srihub_ref_url', null);
          await store.saveSetting(senderId, 'srihub_title', null);

          const finalUrl = savedLinks[choice2 - 1];

          // 18+ => link only
          if (adultMode) {
            return await sock.sendMessage(chatId, {
              text: `🔞 *18+ content detected* — media disabled.\n\n✅ Download link:\n${finalUrl}`
            }, { quoted: mm });
          }

          // non-18+ => try file; fallback link
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

            const safeTitle = String(title).replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 200);
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
            await sock.sendMessage(chatId, { text: `❌ Failed to send file.\n\n✅ Link:\n${finalUrl}` }, { quoted: mm });
          }
        };

        sock.ev.on('messages.upsert', dlListener);
      };

      sock.ev.on('messages.upsert', listener);

    } catch (err) {
      console.error('❌ SriHub Plugin Error:', err?.message || err);
      await sock.sendMessage(chatId, { text: '❌ Failed to process request. Please try again later.' }, { quoted: message });
    }
  }
};

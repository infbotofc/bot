/**
 * Cinesubz Plugin (FINAL) - ONLY ALLOW 1 NUMBER + TMDb 18+ RULES
 * -------------------------------------------------------------
 * ✅ Only this number can use .cinesubz: +94 74 289 4413
 * ✅ Everyone else: blocked
 * ✅ 18+ detection: TMDb adult flag + keyword fallback
 * ✅ If movie is 18+ AND allowed user requests it:
 *      - ALLOW but NEVER send any media (no poster, no file)
 *      - ONLY send TEXT + LINKS
 * ✅ If movie is NOT 18+:
 *      - Can send file normally (file-or-link fallback) + can send poster image
 *
 * Setup:
 * - Put TMDB_KEY in env if you want: TMDB_KEY=xxxx
 * - MAX_SEND_MB safe limit for WhatsApp
 */

const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const MAX_SEND_MB = 90;

// ===================== Allowlist =====================
const ALLOWED_NUMBER_E164 = '+94742894413'; // +94 74 289 4413
const ALLOWED_JID = '94742894413@s.whatsapp.net';

function normalizeToE164Plus(raw = '') {
  // raw can be "+94 74...", "9474...", "9474...@s.whatsapp.net"
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!digits) return '';
  // Sri Lanka: if starts with 94 already, keep, else try to prefix? (we keep simple)
  return digits.startsWith('94') ? `+${digits}` : `+${digits}`;
}

function jidFromNumberPlus(e164Plus) {
  const digits = String(e164Plus).replace(/[^\d]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function getSenderJid(message) {
  // For groups, participant is actual sender. For private chat, remoteJid is sender.
  return message?.key?.participant || message?.key?.remoteJid || '';
}

function isAllowedSender(message) {
  const senderJid = getSenderJid(message);
  if (!senderJid) return false;

  // If already exact match
  if (senderJid === ALLOWED_JID) return true;

  // normalize by digits
  const senderDigits = senderJid.split('@')[0]?.replace(/[^\d]/g, '') || '';
  const allowedDigits = ALLOWED_JID.split('@')[0];
  return senderDigits === allowedDigits;
}

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

    return !!items[0].adult;
  } catch {
    return null;
  }
}

async function isAdultMovie({ query, title, description, year }) {
  if (containsAdultKeyword(query) || containsAdultKeyword(title) || containsAdultKeyword(description)) {
    return true;
  }
  const tmdbAdult = await isAdultByTMDB(title || query, year);
  if (tmdbAdult === true) return true;
  return false;
}

// ===================== Download helper (for NON-18+ only) =====================
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
            url = realUrl;
            continue;
          }
        } catch (htmlErr) {
          console.warn('Cinesubz: HTML resolution failed', htmlErr?.message);
        }
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

// ===================== Plugin =====================
module.exports = {
  command: 'cinesubz',
  aliases: ['cinesub'],
  category: 'movies',
  description: 'Search Cinesubz and get download links (ONLY allowed number; 18+ link-only)',
  usage: '.cinesubz <movie name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderJid = getSenderJid(message);
    const query = args.join(' ').trim();

    // 1) Restrict command to allowed number only
    if (!isAllowedSender(message)) {
      return await sock.sendMessage(
        chatId,
        { text: '🚫 Access denied.' },
        { quoted: message }
      );
    }

    try {
      if (!query) {
        return await sock.sendMessage(
          chatId,
          { text: '*Please provide a movie name.*\nExample: .cinesubz Ne Zha' },
          { quoted: message }
        );
      }

      await sock.sendMessage(chatId, { text: '🔎 Searching Cinesubz...' }, { quoted: message });

      const apiKey = 'dew_kuKmHwBBCgIAdUty5TBY1VWWtUgwbQwKRtC8MFUF';
      const searchUrl = `https://api.srihub.store/movie/cinesubz?q=${encodeURIComponent(query)}&apikey=${apiKey}`;
      const res = await axios.get(searchUrl, { timeout: 20000 });

      let results = res.data?.result;
      if (!Array.isArray(results) || results.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // 2) DO NOT block 18+ for allowed user, BUT we must avoid sending media for 18+.
      // We'll mark items as adult/non-adult using TMDb (best effort).
      const marked = [];
      for (const item of results) {
        const adult = await isAdultMovie({ query, title: item?.title });
        marked.push({ ...item, __adult: adult });
      }
      results = marked;

      // Build list message (TEXT only if any adult results exist)
      // (Because user said: "do not attach any media for message on this over 18 films")
      const hasAnyAdultInList = results.some(r => r.__adult);

      let caption =
        `🎬 *Cinesubz Results for:* *${query}*\n\n` +
        `↩️ *Reply with a number to continue*\n\n`;

      results.forEach((item, i) => {
        const tag = item.__adult ? '🔞' : '✅';
        caption += `*${i + 1}.* ${tag} ${item.title}\n`;
        if (item.quality) caption += `🔊 Quality: ${item.quality}\n`;
        if (item.imdb) caption += `⭐ IMDB: ${item.imdb}\n`;
        caption += `\n`;
      });

      // If list contains adult items, send TEXT ONLY (no poster image).
      // If list contains no adult items, allow image like normal.
      const firstImg = results[0]?.image;
      const sentMsg = await sock.sendMessage(
        chatId,
        (firstImg && !hasAnyAdultInList)
          ? { image: { url: firstImg }, caption }
          : { text: caption },
        { quoted: message }
      );

      const urls = results.map(r => r.link);
      await store.saveSetting(senderJid, 'cinesubz_results', urls);

      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderJid, 'cinesubz_results', null);
        try {
          await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please run the command again.' }, { quoted: sentMsg });
        } catch {}
      }, 5 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        // keep restricted to allowed sender even in replies
        if (!isAllowedSender(m)) return;

        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim(), 10);

        if (isNaN(choice)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with the number.' }, { quoted: m });
        }

        const saved = (await store.getSetting(senderJid, 'cinesubz_results')) || urls;
        if (!Array.isArray(saved) || !saved.length) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: m });
        }

        if (choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderJid, 'cinesubz_results', null);

        const selectedUrl = saved[choice - 1];
        const selectedTitle = results?.[choice - 1]?.title || query;

        await sock.sendMessage(chatId, { text: `ℹ️ Fetching details for #${choice}...` }, { quoted: m });

        try {
          const dlUrl = `https://api.srihub.store/movie/cinesubzdl?url=${encodeURIComponent(selectedUrl)}&apikey=${apiKey}`;
          const dlRes = await axios.get(dlUrl, { timeout: 20000 });

          const movie = dlRes.data?.result;
          if (!movie) {
            return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
          }

          // Determine if THIS movie is adult
          const isAdult = await isAdultMovie({
            query,
            title: movie.title || selectedTitle,
            description: movie.description,
            year: movie.year
          });

          let info = `📥 *Download Details - ${movie.title || 'Movie'}*\n\n`;
          if (movie.year) info += `📆 Year: ${movie.year}\n`;
          if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
          if (movie.description) info += `\n${movie.description}\n\n`;
          if (isAdult) info += `🔞 *Adult/18+ detected — Link-only mode*\n\n`;

          // Flatten download links (no raw URLs in message list)
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
            // If adult: TEXT ONLY; else you can attach image
            const image = movie.gallery?.length ? movie.gallery[0] : null;
            await sock.sendMessage(
              chatId,
              (!isAdult && image) ? { image: { url: image }, caption: info } : { text: info },
              { quoted: m }
            );
            return;
          }

          info += '*Available Downloads:*\n\n';
          flatLinks.forEach((l, idx) => {
            info += `*${idx + 1}.* ${l.server || 'Server'} - ${l.quality} ${l.size ? `(${l.size})` : ''}\n`;
          });

          // For adult: reply number will send LINK only
          // For non-adult: reply number will try FILE then fallback LINK
          info += isAdult
            ? '\n↩️ *Reply with the number to get the LINK (no media will be sent).*'
            : '\n↩️ *Reply with the number to get the FILE (or link if too big).*';

          const image = movie.gallery?.length ? movie.gallery[0] : null;
          const sentDlMsg = await sock.sendMessage(
            chatId,
            (!isAdult && image) ? { image: { url: image }, caption: info } : { text: info },
            { quoted: m }
          );

          await store.saveSetting(senderJid, 'cinesubz_dl_links', flatLinks.map(f => f.url));
          await store.saveSetting(senderJid, 'cinesubz_is_adult_mode', isAdult);

          const dlTimeout = setTimeout(async () => {
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderJid, 'cinesubz_dl_links', null);
            await store.saveSetting(senderJid, 'cinesubz_is_adult_mode', null);
            try { await sock.sendMessage(chatId, { text: '⌛ Download selection expired. Run the command again.' }, { quoted: sentDlMsg }); } catch {}
          }, 5 * 60 * 1000);

          const dlListener = async ({ messages }) => {
            const mm = messages[0];
            if (!mm?.message || mm.key.remoteJid !== chatId) return;

            if (!isAllowedSender(mm)) return;

            const ctx2 = mm.message?.extendedTextMessage?.contextInfo;
            if (!ctx2?.stanzaId || ctx2.stanzaId !== sentDlMsg.key.id) return;

            const replyText2 = mm.message.conversation || mm.message.extendedTextMessage?.text || '';
            const choice2 = parseInt(replyText2.trim(), 10);

            if (isNaN(choice2)) {
              return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with the file number.' }, { quoted: mm });
            }

            const savedLinks = (await store.getSetting(senderJid, 'cinesubz_dl_links')) || [];
            const adultMode = !!(await store.getSetting(senderJid, 'cinesubz_is_adult_mode'));

            if (!Array.isArray(savedLinks) || !savedLinks.length) {
              return await sock.sendMessage(chatId, { text: '❌ Session expired. Run the command again.' }, { quoted: mm });
            }

            if (choice2 < 1 || choice2 > savedLinks.length) {
              return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${savedLinks.length}.` }, { quoted: mm });
            }

            clearTimeout(dlTimeout);
            sock.ev.off('messages.upsert', dlListener);
            await store.saveSetting(senderJid, 'cinesubz_dl_links', null);
            await store.saveSetting(senderJid, 'cinesubz_is_adult_mode', null);

            const finalUrl = savedLinks[choice2 - 1];

            // ===== Adult mode => LINK ONLY (NO MEDIA) =====
            if (adultMode) {
              return await sock.sendMessage(
                chatId,
                { text: `🔞 *18+ Link (media disabled)*\n\n✅ ${finalUrl}` },
                { quoted: mm }
              );
            }

            // ===== Non-adult => try FILE, else LINK =====
            await sock.sendMessage(chatId, { text: `⬇️ Preparing #${choice2}...` }, { quoted: mm });

            try {
              const dlResult = await downloadToTemp(finalUrl, selectedUrl, 3);
              const sizeMB = dlResult.size / (1024 * 1024);

              if (sizeMB > MAX_SEND_MB) {
                try { fs.unlinkSync(dlResult.tmpFile); } catch {}
                return await sock.sendMessage(chatId, {
                  text: `⚠️ File too large to send (${sizeMB.toFixed(1)} MB).\n\n✅ Link:\n${finalUrl}`
                }, { quoted: mm });
              }

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
              await sock.sendMessage(chatId, {
                text: `❌ Failed to send file.\n\n✅ Link:\n${finalUrl}`
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

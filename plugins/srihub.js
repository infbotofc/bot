const axios = require('axios');
const store = require('../lib/lightweight_store');
const { fromBuffer } = require('file-type');
const cheerio = require('cheerio');
const { URL } = require('url');

// =======================
// Helpers
// =======================
const API_KEY = 'dew_kuKmHwBBCgIAdUty5TBY1VWWtUgwbQwKRtC8MFUF';
const SEARCH_ENDPOINT = 'https://api.srihub.store/movie/srihub';
const DL_ENDPOINT = 'https://api.srihub.store/movie/srihubdl';

const SESSION_TTL_MS = 10 * 60 * 1000;
const HEAD_TIMEOUT_MS = 8000;
const REQ_TIMEOUT_MS = 20000;

// NOTE: WhatsApp file limits vary by client/platform.
// Keep conservative default; you can raise it if your stack supports larger.
const WHATSAPP_SEND_LIMIT = 100 * 1024 * 1024; // 100 MB

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function humanSize(bytes) {
  if (!bytes || isNaN(bytes)) return '';
  const thresh = 1024;
  if (Math.abs(bytes) < thresh) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  let u = -1;
  do {
    bytes /= thresh;
    ++u;
  } while (Math.abs(bytes) >= thresh && u < units.length - 1);
  return `${bytes.toFixed(1)} ${units[u]}`;
}

function getText(m) {
  return (
    m?.message?.conversation ||
    m?.message?.extendedTextMessage?.text ||
    m?.message?.imageMessage?.caption ||
    m?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

function safeFileName(name) {
  return (name || 'movie')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function isReplyTo(m, parentMsg) {
  const ctx = m?.message?.extendedTextMessage?.contextInfo;
  return !!(ctx?.stanzaId && parentMsg?.key?.id && ctx.stanzaId === parentMsg.key.id);
}

async function axiosGet(url, opts = {}) {
  return axios.get(url, {
    timeout: REQ_TIMEOUT_MS,
    maxRedirects: 10,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    ...opts,
  });
}

async function axiosHead(url, opts = {}) {
  return axios.head(url, {
    timeout: HEAD_TIMEOUT_MS,
    maxRedirects: 10,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    validateStatus: (s) => s >= 200 && s < 400,
    ...opts,
  });
}

function normalizeSearchResults(data) {
  // srihub API sometimes returns { result: { data: [...] } } or { result: [...] }
  const raw = Array.isArray(data?.result)
    ? data.result
    : Array.isArray(data?.result?.data)
      ? data.result.data
      : [];

  return raw
    .map((x) => ({
      title: x?.title || x?.name || 'Unknown',
      imdb: x?.imdb || x?.rating || '',
      quality: x?.quality || '',
      url: x?.url || x?.link || '',
      image: x?.image || x?.thumbnail || '',
    }))
    .filter((x) => x.url);
}

function flattenDownloadOptions(movie) {
  // Supports multiple possible response shapes
  const list = [];

  // Preferred: movie.downloadOptions[{serverTitle, links:[{url,quality,size}]}]
  if (Array.isArray(movie?.downloadOptions)) {
    for (const opt of movie.downloadOptions) {
      const server = opt?.serverTitle || opt?.server || opt?.title || '';
      const links = Array.isArray(opt?.links) ? opt.links : [];
      for (const l of links) {
        if (!l?.url) continue;
        list.push({
          url: l.url,
          quality: l.quality || l.resolution || 'N/A',
          size: l.size || '',
          server: server || 'Server',
        });
      }
    }
  }

  // Fallbacks
  const maybeLinks = [
    ...(Array.isArray(movie?.links) ? movie.links : []),
    ...(Array.isArray(movie?.downloadLinks) ? movie.downloadLinks : []),
  ];
  for (const l of maybeLinks) {
    if (!l?.url) continue;
    list.push({
      url: l.url,
      quality: l.quality || l.resolution || 'N/A',
      size: l.size || '',
      server: l.server || 'Link',
    });
  }

  if (list.length === 0 && movie?.sourceUrl) {
    list.push({ url: movie.sourceUrl, quality: 'N/A', size: '', server: 'Source' });
  }

  // de-dup by url
  const seen = new Set();
  return list.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

async function tryResolveSizeForLinks(links, limit = 6) {
  // Update missing sizes with HEAD content-length when possible
  const slice = links.slice(0, limit);
  const sizes = await Promise.all(
    slice.map(async (l) => {
      if (l.size) return l.size;
      try {
        const head = await axiosHead(l.url);
        const len = head?.headers?.['content-length'] || head?.headers?.['Content-Length'];
        return len ? humanSize(parseInt(len, 10)) : '';
      } catch {
        return '';
      }
    })
  );
  sizes.forEach((s, i) => {
    if (!slice[i].size && s) slice[i].size = s;
  });
}

async function resolveDirectMediaUrlIfHtml(url) {
  // Many hosts return an HTML landing page; try to extract direct media
  const textRes = await axiosGet(url, { responseType: 'text' });
  const html = textRes?.data || '';

  // Quick regex scan for direct mp4/mkv links
  const directMatch = html.match(/https?:\/\/[^'"\s>]+\.(mp4|mkv|webm)(\?[^'"\s>]*)?/gi);
  if (directMatch?.length) return directMatch[0];

  const $ = cheerio.load(html);

  // Common video tags
  const src1 = $('video source[src]').attr('src');
  const src2 = $('video[src]').attr('src');
  const src3 = $('a[href$=".mp4"], a[href$=".mkv"], a[href$=".webm"]').attr('href');

  const picked = src1 || src2 || src3;
  if (!picked) return null;

  return new URL(picked, url).toString();
}

async function downloadToBuffer(url) {
  // First attempt: direct binary
  const res = await axiosGet(url, { responseType: 'arraybuffer', timeout: 5 * 60 * 1000 });
  let buffer = Buffer.from(res.data, 'binary');
  let type = await fromBuffer(buffer);

  const looksLikeHtml =
    !type ||
    (type?.mime && type.mime.startsWith('text/')) ||
    buffer.slice(0, 20).toString('utf8').trim().startsWith('<');

  if (looksLikeHtml) {
    const realUrl = await resolveDirectMediaUrlIfHtml(url);
    if (realUrl) {
      const res2 = await axiosGet(realUrl, { responseType: 'arraybuffer', timeout: 5 * 60 * 1000 });
      buffer = Buffer.from(res2.data, 'binary');
      type = await fromBuffer(buffer);
      return { buffer, type, finalUrl: realUrl };
    }
  }

  return { buffer, type, finalUrl: url };
}

async function sendMedia(sock, chatId, quoted, movieTitle, buffer, type, fallbackUrl) {
  // If too large, just provide direct link
  if (buffer?.length && buffer.length > WHATSAPP_SEND_LIMIT) {
    await sock.sendMessage(
      chatId,
      { text: `⚠️ File is too large to send via WhatsApp (${humanSize(buffer.length)}).\n\n🔗 Direct link:\n${fallbackUrl}` },
      { quoted }
    );
    return;
  }

  const base = safeFileName(movieTitle);
  const ext = type?.ext || 'mp4';
  const mime = type?.mime || 'application/octet-stream';
  const fileName = `${base}.${ext}`;

  // Prefer document to avoid WhatsApp recompression and to better support large video
  if (mime.startsWith('video/')) {
    await sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName }, { quoted });
    return;
  }

  if (mime.startsWith('image/')) {
    await sock.sendMessage(chatId, { image: buffer, caption: fileName }, { quoted });
    return;
  }

  if (mime.startsWith('audio/')) {
    await sock.sendMessage(chatId, { audio: buffer, mimetype: mime }, { quoted });
    return;
  }

  await sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName }, { quoted });
}

async function saveSession(senderId, key, value) {
  await store.saveSetting(senderId, key, value);
  // also store timestamp for expiry
  await store.saveSetting(senderId, `${key}_ts`, Date.now());
}

async function loadSession(senderId, key) {
  const ts = await store.getSetting(senderId, `${key}_ts`);
  const v = await store.getSetting(senderId, key);
  if (!ts || !v) return null;
  if (Date.now() - ts > SESSION_TTL_MS) return null;
  return v;
}

async function clearSession(senderId, key) {
  await store.saveSetting(senderId, key, null);
  await store.saveSetting(senderId, `${key}_ts`, null);
}

module.exports = {
  command: 'srihub',
  aliases: ['sri'],
  category: 'movies',
  description: 'Search SriHub and download movies (2-step selection)',
  usage: '.srihub <movie name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const query = args.join(' ').trim();

    // Keys for this command session
    const KEY_RESULTS = 'srihub_results_v2';
    const KEY_DLS = 'srihub_dls_v2';

    try {
      if (!query) {
        return await sock.sendMessage(
          chatId,
          { text: '*Please provide a movie name.*\nExample: .srihub Ne Zha' },
          { quoted: message }
        );
      }

      // Reset any previous incomplete sessions for this user
      await clearSession(senderId, KEY_RESULTS);
      await clearSession(senderId, KEY_DLS);

      await sock.sendMessage(chatId, { text: '🔎 Searching SriHub...' }, { quoted: message });

      const searchUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&apikey=${API_KEY}`;
      const res = await axiosGet(searchUrl);

      const results = normalizeSearchResults(res.data);
      if (!results.length) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Build list
      let caption = `🎬 *SriHub Results for:* *${query}*\n\n`;
      caption += `↩️ *Reply with a number (1-${results.length}) to pick a movie.*\n\n`;

      results.slice(0, 20).forEach((item, i) => {
        caption += `*${i + 1}.* ${item.title}\n`;
        if (item.quality) caption += `🎞️ Quality: ${item.quality}\n`;
        if (item.imdb) caption += `⭐ IMDB: ${item.imdb}\n`;
        caption += `\n`;
      });

      if (results.length > 20) {
        caption += `…and ${results.length - 20} more results. Try a more specific name to narrow it down.\n`;
      }

      const firstImg = results[0]?.image;
      const sentMsg = await sock.sendMessage(
        chatId,
        firstImg ? { image: { url: firstImg }, caption } : { text: caption },
        { quoted: message }
      );

      // Store urls only (keep lightweight)
      const urls = results.map((r) => r.url);
      await saveSession(senderId, KEY_RESULTS, urls);

      // One-time listener for selecting movie
      const listener = async ({ messages }) => {
        const m = messages?.[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;
        if (!isReplyTo(m, sentMsg)) return;

        const text = getText(m);
        const choice = parseInt(text, 10);
        if (isNaN(choice)) {
          return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with a number from the list.' }, { quoted: m });
        }

        const saved = await loadSession(senderId, KEY_RESULTS);
        if (!Array.isArray(saved) || !saved.length) {
          sock.ev.off('messages.upsert', listener);
          return await sock.sendMessage(chatId, { text: '⌛ Session expired. Please run .srihub <movie name> again.' }, { quoted: m });
        }

        if (choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        // Stop listening for movie choice now
        sock.ev.off('messages.upsert', listener);
        await clearSession(senderId, KEY_RESULTS);

        const selectedUrl = saved[choice - 1];
        await sock.sendMessage(chatId, { text: `📥 Fetching download options for #${choice}...` }, { quoted: m });

        // Fetch download details
        const dlUrl = `${DL_ENDPOINT}?url=${encodeURIComponent(selectedUrl)}&apikey=${API_KEY}`;
        const dlRes = await axiosGet(dlUrl);

        const movie = dlRes?.data?.result;
        if (!movie) {
          return await sock.sendMessage(chatId, { text: '❌ Failed to fetch download details.' }, { quoted: m });
        }

        const flatLinks = flattenDownloadOptions(movie);
        if (!flatLinks.length) {
          return await sock.sendMessage(chatId, { text: '❌ No downloadable links found for this movie.' }, { quoted: m });
        }

        // Try fill in size quickly for first few
        await tryResolveSizeForLinks(flatLinks, 8);

        // Build download options message (do not show URLs)
        let info = `📦 *${movie.title || 'Movie'}*\n`;
        if (movie.year) info += `📆 Year: ${movie.year}\n`;
        if (movie.imdb) info += `⭐ IMDB: ${movie.imdb}\n`;
        info += `\n*Available Downloads:*\n\n`;

        flatLinks.slice(0, 25).forEach((l, idx) => {
          info += `*${idx + 1}.* ${l.server} - ${l.quality}`;
          if (l.size) info += ` (${l.size})`;
          info += `\n`;
        });

        if (flatLinks.length > 25) {
          info += `\n…and ${flatLinks.length - 25} more links. Choose a smaller number range by refining search.`;
        }

        info += `\n↩️ *Reply with a number (1-${Math.min(flatLinks.length, 25)}) to download and send the file to WhatsApp.*`;

        const image = Array.isArray(movie.gallery) && movie.gallery.length ? movie.gallery[0] : null;
        const sentDlMsg = await sock.sendMessage(chatId, image ? { image: { url: image }, caption: info } : { text: info }, { quoted: m });

        // Store direct URLs for second step
        await saveSession(senderId, KEY_DLS, flatLinks.map((x) => x.url));

        // Listener for download choice
        const dlListener = async ({ messages: msgs2 }) => {
          const mm = msgs2?.[0];
          if (!mm?.message || mm.key.remoteJid !== chatId) return;
          if (!isReplyTo(mm, sentDlMsg)) return;

          const text2 = getText(mm);
          const choice2 = parseInt(text2, 10);
          if (isNaN(choice2)) {
            return await sock.sendMessage(chatId, { text: '❌ Invalid choice. Reply with a number from the download list.' }, { quoted: mm });
          }

          const savedLinks = await loadSession(senderId, KEY_DLS);
          if (!Array.isArray(savedLinks) || !savedLinks.length) {
            sock.ev.off('messages.upsert', dlListener);
            return await sock.sendMessage(chatId, { text: '⌛ Download session expired. Please run .srihub again.' }, { quoted: mm });
          }

          const maxPick = Math.min(savedLinks.length, 25);
          if (choice2 < 1 || choice2 > maxPick) {
            return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${maxPick}.` }, { quoted: mm });
          }

          // Stop listening
          sock.ev.off('messages.upsert', dlListener);
          await clearSession(senderId, KEY_DLS);

          const finalUrl = savedLinks[choice2 - 1];
          await sock.sendMessage(chatId, { text: `⬇️ Downloading option #${choice2}...` }, { quoted: mm });

          try {
            const { buffer, type, finalUrl: realUrl } = await downloadToBuffer(finalUrl);

            // If still unknown type, attempt a HEAD to detect content-type/length
            if (!type) {
              try {
                const head = await axiosHead(realUrl);
                const len = head?.headers?.['content-length'] || head?.headers?.['Content-Length'];
                if (len && parseInt(len, 10) > WHATSAPP_SEND_LIMIT) {
                  await sock.sendMessage(
                    chatId,
                    { text: `⚠️ File is too large to send via WhatsApp (${humanSize(parseInt(len, 10))}).\n\n🔗 Direct link:\n${realUrl}` },
                    { quoted: mm }
                  );
                  return;
                }
              } catch {}
            }

            await sendMedia(sock, chatId, mm, movie.title || 'movie', buffer, type, realUrl);
          } catch (e) {
            console.error('❌ SriHub Download Error:', e?.message || e);
            await sock.sendMessage(
              chatId,
              { text: '❌ Failed to download or send the file. The host may block direct downloads, require cookies, or the file may be too large.' },
              { quoted: mm }
            );
          }
        };

        sock.ev.on('messages.upsert', dlListener);
      };

      sock.ev.on('messages.upsert', listener);
    } catch (err) {
      console.error('❌ SriHub Plugin Error:', err?.message || err);
      await sock.sendMessage(chatId, { text: '❌ Failed to process request. Please try again later.' }, { quoted: message });
    }
  },
};

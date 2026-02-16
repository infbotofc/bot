/**
 * APKMirror (UPDATED TEMPLATE) — Infinity MD Style
 * ------------------------------------------------
 * ✅ Phone-friendly output + clean design
 * ✅ Reply-to-select works reliably (checks stanzaId)
 * ✅ Stores results per user (so it won't break if results array changes)
 * ✅ Auto-expire selection
 * ✅ Optional: blocks very large APKs (you can adjust MAX_APK_MB)
 * ✅ Sends APK file if direct link exists, otherwise sends info + link
 *
 * API:
 *  Search: https://discardapi.dpdns.org/api/apk/search/apkmirror?apikey=guru&query=
 *  DL:     https://discardapi.dpdns.org/api/apk/dl/apkmirror?apikey=guru&url=
 */

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/lightweight_store'); // keep your store like other plugins

const API_KEY = 'guru';
const BASE = 'https://discardapi.dpdns.org/api/apk';
const MAX_APK_MB = 120; // change or set null to disable size blocking

function safeText(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function parseSizeMB(sizeText = '') {
  const s = safeText(sizeText).toLowerCase().trim();
  // examples: "58 MB", "1.2 GB"
  const m = s.match(/([\d.]+)\s*(kb|mb|gb)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (Number.isNaN(n)) return null;
  if (unit === 'kb') return n / 1024;
  if (unit === 'mb') return n;
  if (unit === 'gb') return n * 1024;
  return null;
}

async function downloadToTemp(url, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const tmpFile = path.join(
        os.tmpdir(),
        `apkmirror_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.apk`
      );

      const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 5 * 60 * 1000,
        maxRedirects: 10,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }
      });

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
      return { tmpFile, size: stats.size };
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

module.exports = {
  command: 'apkmirror',
  aliases: ['apkmi', 'mirrorapk'],
  category: 'apks',
  description: 'Search APKMirror and download by reply',
  usage: '.apkmirror <app name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const senderId = message.key.participant || message.key.remoteJid;
    const query = args.join(' ').trim();

    try {
      if (!query) {
        return await sock.sendMessage(
          chatId,
          { text: `📦 *APKMirror*\n\nPlease provide an app name.\nExample: \`.apkmirror Telegram\`` },
          { quoted: message }
        );
      }

      await sock.sendMessage(chatId, { text: '🔎 Searching APKMirror...' }, { quoted: message });

      const searchUrl = `${BASE}/search/apkmirror?apikey=${API_KEY}&query=${encodeURIComponent(query)}`;
      const searchRes = await axios.get(searchUrl, { timeout: 20000 });

      const resultsRaw = searchRes.data?.result;
      if (!Array.isArray(resultsRaw) || resultsRaw.length === 0) {
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Normalize + keep only usable items (must have url)
      const results = resultsRaw
        .map(r => ({
          title: safeText(r.title),
          developer: safeText(r.developer),
          size: safeText(r.size),
          updated: safeText(r.updated),
          url: safeText(r.url)
        }))
        .filter(r => r.url.startsWith('http'))
        .slice(0, 15);

      if (!results.length) {
        return await sock.sendMessage(chatId, { text: '❌ No usable results (missing URLs).' }, { quoted: message });
      }

      // Save per user (so reply still works even if memory changes)
      await store.saveSetting(senderId, 'apkmirror_results', results);

      const lines = [];
      lines.push(`📦 *APKMirror Results*`);
      lines.push(`🔎 Query: *${query}*`);
      lines.push('');
      lines.push(`↩️ Reply with a number (1-${results.length})`);
      lines.push('—'.repeat(22));

      results.forEach((v, i) => {
        const num = i + 1;
        lines.push(`*${num}.* ${v.title || 'Unknown'}`);
        if (v.developer) lines.push(`   👨‍💻 ${v.developer}`);
        if (v.size) lines.push(`   📦 ${v.size}`);
        if (v.updated) lines.push(`   🕒 ${v.updated}`);
        lines.push('');
      });

      lines.push('—'.repeat(22));
      lines.push('💫 *Infinity MD*');

      const sentMsg = await sock.sendMessage(chatId, { text: lines.join('\n') }, { quoted: message });

      const timeout = setTimeout(async () => {
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'apkmirror_results', null);
        try {
          await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please search again.' }, { quoted: sentMsg });
        } catch {}
      }, 3 * 60 * 1000);

      const listener = async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.remoteJid !== chatId) return;

        // must be a reply to our list message
        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || ctx.stanzaId !== sentMsg.key.id) return;

        const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const choice = parseInt(replyText.trim(), 10);

        const saved = (await store.getSetting(senderId, 'apkmirror_results')) || results;
        if (!Array.isArray(saved) || saved.length === 0) {
          return await sock.sendMessage(chatId, { text: '❌ Session expired. Please search again.' }, { quoted: m });
        }

        if (Number.isNaN(choice) || choice < 1 || choice > saved.length) {
          return await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${saved.length}.` }, { quoted: m });
        }

        clearTimeout(timeout);
        sock.ev.off('messages.upsert', listener);
        await store.saveSetting(senderId, 'apkmirror_results', null);

        const selected = saved[choice - 1];
        if (!selected?.url) {
          return await sock.sendMessage(chatId, { text: '❌ Missing APK page URL for this selection.' }, { quoted: m });
        }

        await sock.sendMessage(
          chatId,
          { text: `⬇️ Fetching *${selected.title || 'APK'}*...\nPlease wait...` },
          { quoted: m }
        );

        const dlUrl = `${BASE}/dl/apkmirror?apikey=${API_KEY}&url=${encodeURIComponent(selected.url)}`;
        const dlRes = await axios.get(dlUrl, { timeout: 20000 });

        const apk = dlRes.data?.result;
        if (!apk) {
          return await sock.sendMessage(chatId, { text: '❌ Failed to fetch APK details.' }, { quoted: m });
        }

        const info =
          `📦 *APK Download Info*\n\n` +
          `📛 Name: ${safeText(apk.name) || safeText(selected.title)}\n` +
          `🔢 Version: ${safeText(apk.version)}\n` +
          `📦 Size: ${safeText(apk.size)}\n` +
          `📥 Downloads: ${safeText(apk.downloads)}\n` +
          `📦 Package: ${safeText(apk.package)}\n` +
          `📅 Uploaded: ${safeText(apk.uploaded)}\n`;

        // If API provides direct download link, try to send file (document).
        // Fallback: send link only.
        const direct = safeText(apk.url || apk.download || apk.direct || apk.link);
        const icon = safeText(apk.icon);

        // Size check (if size text available)
        const mb = parseSizeMB(apk.size);
        if (MAX_APK_MB && mb !== null && mb > MAX_APK_MB) {
          const msgText =
            info +
            `\n⚠️ File is too large (${mb.toFixed(1)} MB). Sending link instead:\n${direct || selected.url}`;
          // show icon if exists
          if (icon) {
            return await sock.sendMessage(chatId, { image: { url: icon }, caption: msgText }, { quoted: m });
          }
          return await sock.sendMessage(chatId, { text: msgText }, { quoted: m });
        }

        // Always show info first (with icon if available)
        if (icon) {
          await sock.sendMessage(chatId, { image: { url: icon }, caption: info.trim() }, { quoted: m });
        } else {
          await sock.sendMessage(chatId, { text: info.trim() }, { quoted: m });
        }

        // If we have a direct link, attempt sending the APK as a document
        if (direct && direct.startsWith('http')) {
          try {
            const { tmpFile, size } = await downloadToTemp(direct, 2);
            const sizeMB = size / (1024 * 1024);

            if (MAX_APK_MB && sizeMB > MAX_APK_MB) {
              try { fs.unlinkSync(tmpFile); } catch {}
              return await sock.sendMessage(chatId, {
                text: `⚠️ File too large to send (${sizeMB.toFixed(1)} MB).\n\n✅ Link:\n${direct}`
              }, { quoted: m });
            }

            const fileName = `${(safeText(apk.name) || safeText(selected.title) || 'app')
              .replace(/[^a-zA-Z0-9 _.-]/g, '_')
              .slice(0, 120)}.apk`;

            const stream = fs.createReadStream(tmpFile);
            await sock.sendMessage(chatId, {
              document: stream,
              mimetype: 'application/vnd.android.package-archive',
              fileName
            }, { quoted: m });

            try { fs.unlinkSync(tmpFile); } catch {}
            return;
          } catch (e) {
            // fallback to link
            return await sock.sendMessage(chatId, {
              text: `✅ Download link:\n${direct}`
            }, { quoted: m });
          }
        }

        // No direct link found => send page URL
        return await sock.sendMessage(chatId, {
          text: `✅ Open this link to download:\n${selected.url}`
        }, { quoted: m });
      };

      sock.ev.on('messages.upsert', listener);

    } catch (err) {
      console.error('❌ APKMirror Plugin Error:', err?.message || err);
      await sock.sendMessage(chatId, { text: '❌ Failed to process request. Please try again later.' }, { quoted: message });
    }
  }
};

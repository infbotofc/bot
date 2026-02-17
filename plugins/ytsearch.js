const yts = require('yt-search');
const settings = require('../settings');

// In-memory last results per chat for quick pick (reply 1-10)
const lastResults = new Map(); // chatId => { list: videos[], at: timestamp }
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function formatViews(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return String(v || '0');
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function shorten(str, max = 60) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function prefix() {
  return (settings.prefixes && settings.prefixes[0]) ? settings.prefixes[0] : '.';
}

module.exports = {
  command: 'yt',
  aliases: ['ytsearch', 'yts', 'playlist', 'playlista'],
  category: 'music',
  description: 'Search YouTube (reply 1-10 to pick)',
  usage: '.yt <query>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    // --- Quick pick: if user replies "1".."10" to the bot search message
    const maybeNumber = (args[0] || '').trim();
    const cached = lastResults.get(chatId);

    if (/^(10|[1-9])$/.test(maybeNumber) && cached && (Date.now() - cached.at) < TTL_MS) {
      const idx = parseInt(maybeNumber, 10) - 1;
      const item = cached.list[idx];
      if (!item) {
        return sock.sendMessage(chatId, { text: '❌ Invalid number. Choose 1-10.' }, { quoted: message });
      }

      // Send selected result nicely
      return sock.sendMessage(chatId, {
        text:
          `🎬 *Selected:* ${item.title}\n` +
          `⏱ *Duration:* ${item.timestamp || '—'}\n` +
          `👀 *Views:* ${formatViews(item.views)}\n` +
          `🔗 *Link:* ${item.url}`
      }, { quoted: message });
    }

    const query = args.join(' ').trim();
    if (!query) {
      return sock.sendMessage(chatId, {
        text: `Use:\n*${prefix()}yt* <query>\n\nExample:\n*${prefix()}yt* Lil Peep`
      }, { quoted: message });
    }

    try {
      await sock.sendMessage(chatId, { react: { text: '🔎', key: message.key } });

      const result = await yts(query);
      const videos = (result?.videos || []).slice(0, 10);

      if (!videos.length) {
        await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
        return sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });
      }

      // Cache for quick pick
      lastResults.set(chatId, { list: videos, at: Date.now() });

      // Build compact list (mobile friendly)
      let text =
        `🎧 *YouTube Results* (${videos.length}/10)\n` +
        `🔎 *Query:* ${shorten(query, 48)}\n\n`;

      videos.forEach((v, i) => {
        text +=
          `*${i + 1}.* ${shorten(v.title, 55)}\n` +
          `⏱ ${v.timestamp || '—'}  •  👀 ${formatViews(v.views)}\n` +
          `🔗 ${v.url}\n\n`;
      });

      text +=
        `Reply with a number *1-10* to select.\n` +
        `Example: \`${prefix()}yt 1\``;

      // Thumbnail as image if available
      const thumb = videos[0]?.image;

      await sock.sendMessage(chatId, { react: { text: '✅', key: message.key } });

      if (thumb) {
        return sock.sendMessage(chatId, { image: { url: thumb }, caption: text }, { quoted: message });
      }

      return sock.sendMessage(chatId, { text }, { quoted: message });

    } catch (error) {
      console.error('YouTube Search Error:', error);
      try { await sock.sendMessage(chatId, { react: { text: '⚠️', key: message.key } }); } catch {}
      return sock.sendMessage(chatId, { text: '❌ Error searching YouTube. Try again.' }, { quoted: message });
    }
  }
};

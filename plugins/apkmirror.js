const axios = require('axios');

module.exports = {
  command: 'apkmirror',
  aliases: ['apkmi', 'mirrorapk'],
  category: 'apks',
  description: 'Search APKs from APKMirror and download by reply',
  usage: '.apkmirror <apk_name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const query = args.join(' ').trim();

    try {
      if (!query) return await sock.sendMessage(chatId, { text: '*Please provide an app name.*\nExample: .apkmirror Telegram' }, { quoted: message });

      await sock.sendMessage(chatId, { text: '🔎 Searching APKMirror...' }, { quoted: message });

      const searchUrl = `https://discardapi.dpdns.org/api/apk/search/apkmirror?apikey=guru&query=${encodeURIComponent(query)}`;
      const searchRes = await axios.get(searchUrl);

      const results = searchRes.data?.result;
      if (!Array.isArray(results) || results.length === 0)
        return await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: message });

      let caption = `📦 *APKMirror Results for:* *${query}*\n\n↩️ *Reply with a number to download*\n\n`;
      results.forEach((v, i) => {
        caption += `*${i + 1}.* ${v.title}\n👨‍💻 ${v.developer}\n📦 ${v.size}\n🕒 ${v.updated}\n🔗 ${v.url}\n\n`;
      });

      const sentMsg = await sock.sendMessage(chatId, { text: caption }, { quoted: message });

      let timedOut = false;
      const safeOff = (fn) => {
        try { sock.ev.off('messages.upsert', fn); } catch (e) { }
      };

      const timeout = setTimeout(async () => {
        timedOut = true;
        safeOff(listener);
        try {
          await sock.sendMessage(chatId, { text: '⌛ Selection expired. Please search again.' }, { quoted: sentMsg }).catch(() => {});
        } catch (e) {}
      }, 3 * 60 * 1000);

      const listener = async ({ messages }) => {
        try {
          const m = Array.isArray(messages) ? messages[0] : messages;
          if (!m || !m.message) return;
          const from = m.key && (m.key.remoteJid || m.key.participant || null) || null;
          if (!from || from !== chatId) return;

          const ctx = m.message?.extendedTextMessage?.contextInfo;
          if (!ctx?.stanzaId || !sentMsg?.key?.id || ctx.stanzaId !== sentMsg.key.id) return;

          const replyText = m.message.conversation || m.message.extendedTextMessage?.text || '';
          const choice = parseInt((replyText || '').trim());
          if (isNaN(choice) || choice < 1 || choice > results.length) {
            await sock.sendMessage(chatId, { text: `❌ Invalid choice. Pick 1-${results.length}.` }, { quoted: m }).catch(() => {});
            return;
          }

          if (timedOut) return;
          clearTimeout(timeout);
          safeOff(listener);

          const selected = results[choice - 1];
          await sock.sendMessage(chatId, { text: `⬇️ Downloading *${selected.title}*...\n⏳ Please wait...` }, { quoted: m }).catch(() => {});

          const dlUrl = `https://discardapi.dpdns.org/api/apk/dl/apkmirror?apikey=guru&url=${encodeURIComponent(selected.url)}`;
          let dlRes;
          try {
            dlRes = await axios.get(dlUrl, { timeout: 20000 });
          } catch (e) {
            await sock.sendMessage(chatId, { text: '❌ Failed to fetch APK details (network).' }, { quoted: m }).catch(() => {});
            return;
          }

          const apk = dlRes?.data?.result;
          if (!apk) {
            await sock.sendMessage(chatId, { text: '❌ Failed to fetch APK details.' }, { quoted: m }).catch(() => {});
            return;
          }

          const info =
            `📦 *APK Download Info*\n\n` +
            `📛 Name: ${apk.name || 'N/A'}\n` +
            `📦 Size: ${apk.size || 'N/A'}\n` +
            `📥 Downloads: ${apk.downloads || 'N/A'}\n` +
            `📦 Package: ${apk.package || 'N/A'}\n` +
            `📅 Uploaded: ${apk.uploaded || 'N/A'}\n` +
            `🔢 Version: ${apk.version || 'N/A'}`;

          if (apk.icon) {
            await sock.sendMessage(chatId, { image: { url: apk.icon }, caption: info }, { quoted: m }).catch(async () => {
              await sock.sendMessage(chatId, { text: info + `\n\nDownload: ${apk.download || apk.url || 'N/A'}` }, { quoted: m }).catch(() => {});
            });
          } else {
            await sock.sendMessage(chatId, { text: info + `\n\nDownload: ${apk.download || apk.url || 'N/A'}` }, { quoted: m }).catch(() => {});
          }
        } catch (err) {
          console.error('❌ APKMirror listener error:', err);
          try { safeOff(listener); clearTimeout(timeout); } catch (e) {}
        }
      };

      sock.ev.on('messages.upsert', listener);

    } catch (err) {
      console.error('❌ APKMirror Plugin Error:', err);
      await sock.sendMessage(chatId, { text: '❌ Failed to process request.' }, { quoted: message });
    }
  }
};
        

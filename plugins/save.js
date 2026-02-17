// plugins/save.js
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const FileType = require('file-type');

/**
 * .save
 * -----
 * Reply to someone's WhatsApp Status with: .save
 * Bot downloads that quoted status media and re-sends it in the current chat.
 *
 * Works with: image status, video status (and most quoted media messages)
 *
 * NOTE:
 * - You MUST reply to the status message (the message that contains the image/video preview).
 * - If your bot blocks status processing elsewhere, that's fine — this uses the quotedMessage directly.
 */

async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

function getQuotedMessage(message) {
  // supports different message shapes
  const ctx =
    message?.message?.extendedTextMessage?.contextInfo ||
    message?.message?.imageMessage?.contextInfo ||
    message?.message?.videoMessage?.contextInfo ||
    message?.message?.buttonsResponseMessage?.contextInfo ||
    message?.message?.listResponseMessage?.contextInfo ||
    null;

  return ctx?.quotedMessage || null;
}

module.exports = {
  command: 'save',
  aliases: ['savestatus', 'statussave'],
  category: 'tools',
  description: 'Save a quoted WhatsApp status/media into the chat',
  usage: '.save (reply to a status/media message)',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;

    try {
      const quoted = getQuotedMessage(message);

      if (!quoted) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ Please *reply to a status/media message* and type `.save`' },
          { quoted: message }
        );
      }

      // Status replies commonly contain quoted imageMessage/videoMessage
      const qImg = quoted.imageMessage;
      const qVid = quoted.videoMessage;

      if (!qImg && !qVid) {
        // sometimes quoted message is wrapped
        const v2 = quoted?.viewOnceMessageV2?.message || quoted?.viewOnceMessage?.message;
        if (v2?.imageMessage || v2?.videoMessage) {
          // treat it as normal media
          const innerImg = v2.imageMessage;
          const innerVid = v2.videoMessage;

          const type = innerImg ? 'image' : 'video';
          const stream = await downloadContentFromMessage(innerImg || innerVid, type);
          const buffer = await streamToBuffer(stream);

          const caption = (innerImg?.caption || innerVid?.caption || '').trim();
          const savedCap =
            `✅ *Status Saved*\n` +
            (caption ? `\n📝 ${caption}\n` : '\n') +
            `> 💫 *INFINITY MD BOT*`;

          if (type === 'image') {
            return await sock.sendMessage(chatId, { image: buffer, caption: savedCap }, { quoted: message });
          } else {
            return await sock.sendMessage(chatId, { video: buffer, caption: savedCap, mimetype: 'video/mp4' }, { quoted: message });
          }
        }

        return await sock.sendMessage(
          chatId,
          { text: '❌ That replied message has no downloadable image/video.\nReply to an *image/video status* then use `.save`.' },
          { quoted: message }
        );
      }

      await sock.sendMessage(chatId, { text: '⬇️ Saving status...' }, { quoted: message });

      const mediaMsg = qImg || qVid;
      const type = qImg ? 'image' : 'video';

      const stream = await downloadContentFromMessage(mediaMsg, type);
      const buffer = await streamToBuffer(stream);

      // detect mime/ext if needed
      const ft = await FileType.fromBuffer(buffer).catch(() => null);
      const caption = (mediaMsg.caption || '').trim();

      const savedCap =
        `✅ *Status Saved*\n` +
        (caption ? `\n📝 ${caption}\n` : '\n') +
        (ft?.mime ? `📎 ${ft.mime}\n` : '') +
        `> 💫 *INFINITY MD BOT*`;

      if (type === 'image') {
        await sock.sendMessage(chatId, { image: buffer, caption: savedCap }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, { video: buffer, caption: savedCap, mimetype: mediaMsg.mimetype || 'video/mp4' }, { quoted: message });
      }
    } catch (err) {
      console.error('SAVE status error:', err);
      await sock.sendMessage(
        chatId,
        { text: `❌ Failed to save status.\n\n*Error:* ${err.message}` },
        { quoted: message }
      );
    }
  }
};

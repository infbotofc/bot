// plugins/song_alt.js
// Minimal fallback handler in case something tries to call it (shouldn't normally happen)

module.exports = {
  command: 'song_alt',
  aliases: [],
  category: 'download',
  description: 'Fallback song downloader (disabled)',
  usage: '.song <query>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    await sock.sendMessage(
      chatId,
      { text: '❌ Alternate song handler is not available.' },
      { quoted: message }
    );
  }
};

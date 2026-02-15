

const axios = require('axios');

module.exports = {
  command: 'ai',
  aliases: ['ask','gpt','chat'],
  category: 'ai',
  description: 'Ask the AI (requires AI_API_KEY in env)',
  usage: '.ai <prompt>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const query = args.join(' ').trim();

    if (!query) {
      await sock.sendMessage(chatId, {
        text: "Please provide a query after .ai\n\nExample: .ai write a basic HTML code"
      }, { quoted: message });
      return;
    }

    try {
      await sock.sendMessage(chatId, {
        react: { text: '🤖', key: message.key }
      });

      // Use the provided endpoint for all AI queries
      const apiUrl = `https://api.srihub.store/ai/chatgpt?prompt=${encodeURIComponent(query)}&apikey=dew_FEIXBd8x3XE6eshtBtM1NwEV5IxSLI6PeRE2zLmi`;
      const response = await axios.get(apiUrl);
      if (response.data && (response.data.result || response.data.answer || response.data.message)) {
        const answer = response.data.result || response.data.answer || response.data.message;
        await sock.sendMessage(chatId, { text: answer }, { quoted: message });
      } else {
        throw new Error('Invalid response from AI API');
      }
    } catch (error) {
      console.error('AI Command Error:', error);
      await sock.sendMessage(chatId, {
        text: "❌ Failed to get AI response. Please try again later."
      }, { quoted: message });
    }
  }
};

/*****************************************************************************
 *                                                                           *
 *                   Developed By Qasim Ali                                  *
 *                                                                           *
 *   🌐 GitHub   : https://github.com/GlobalTechInfo                         *
 *   ▶️  YouTube  : https://youtube.com/@GlobalTechInfo                      *
 *   💬  WhatsApp :     *
 *                                                                           *
 *    © 2026 GlobalTechInfo. All rights reserved.                            *
 *                                                                           *
 *    Description: This file is part of the Infinity MD Project.                 *
 *                 Unauthorized copying or distribution is prohibited.       *
 *                                                                           *
 *****************************************************************************/


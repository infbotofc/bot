const store = require('../lib/lightweight_store');

module.exports = {
    command: 'status',
    aliases: ['stat', 'presence'],
    category: 'owner',
    description: 'Toggle reported online status (show offline while connected)',
    usage: '.status <on|off>',
    ownerOnly: true,

    async handler(sock, message, args, context = {}) {
        const chatId = context.chatId || message.key.remoteJid;
        const action = args[0]?.toLowerCase();

        const current = await store.getSetting('global', 'stealthMode') || { enabled: false };

        if (!action || !['on', 'off'].includes(action)) {
            const statusText = current.enabled ? 'OFF (appearing offline)' : 'ON (appearing online)';
            return await sock.sendMessage(chatId, { text: `🤖 *Status Command*
Current: ${statusText}

Usage: .status <on|off>
• .status off - Bot will appear offline even when connected
• .status on  - Bot will appear online normally` }, { quoted: message });
        }

        const enableOffline = action === 'off';

        try {
            if (enableOffline) {
                // send explicit unavailable presence first, then save setting
                try { await sock.sendPresenceUpdate('unavailable'); } catch (e) {}
                await store.saveSetting('global', 'stealthMode', { enabled: true });
                await sock.sendMessage(chatId, { text: '✅ Status updated: Bot will appear OFFLINE now.' }, { quoted: message });
            } else {
                // turn online: clear setting then send available presence
                await store.saveSetting('global', 'stealthMode', { enabled: false });
                try { await sock.sendPresenceUpdate('available'); } catch (e) {}
                await sock.sendMessage(chatId, { text: '✅ Status updated: Bot will appear ONLINE now.' }, { quoted: message });
            }
        } catch (err) {
            await sock.sendMessage(chatId, { text: `❌ Failed to update status: ${err.message}` }, { quoted: message });
        }
    }
};

const settings = require("../settings");
const store = require('../lib/lightweight_store');

module.exports = {
  command: 'settingsmenu',
  aliases: ['setmenu', 'config'],
  category: 'general',
  description: 'Settings menu (shows live state and allows toggles)',
  usage: '.settingsmenu',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const prefix = settings.prefixes ? settings.prefixes[0] : '.';

    const toggleable = {
      autotyping: 'Auto Typing',
      autoread: 'Auto Read',
      autoreact: 'Auto React',
      cmdreact: 'Command React',
      autostatus: 'Auto Status',
      stealthMode: 'Stealth Mode',
      anticall: 'Anti Call',
      antispam: 'Anti Spam',
      pmblocker: 'PM Blocker',
    };

    // handle toggle: .settingsmenu toggle <key>
    if (args && args[0] && args[0].toLowerCase() === 'toggle') {
      const key = args[1];
      if (!key || !toggleable[key]) {
        const keys = Object.keys(toggleable).map(k => `• ${k} (${toggleable[k]})`).join('\n');
        return await sock.sendMessage(chatId, { text: `⚠️ Usage: .settingsmenu toggle <key>\nValid keys:\n${keys}` }, { quoted: message });
      }

      // load current state and flip boolean
      try {
        const current = await store.getSetting('global', key) || {};
        const enabled = !!current.enabled;
        const newState = { enabled: !enabled };
        await store.saveSetting('global', key, newState);
        return await sock.sendMessage(chatId, { text: `✅ ${toggleable[key]} is now *${newState.enabled ? 'ENABLED' : 'DISABLED'}*` }, { quoted: message });
      } catch (e) {
        return await sock.sendMessage(chatId, { text: `❌ Could not toggle ${key}: ${e.message}` }, { quoted: message });
      }
    }

    // otherwise show current states live
    const parts = [];
    parts.push('╭─〔 ⚙️ SETTINGS MENU 〕─╮');
    parts.push(`│ Prefix : ${prefix}    │ Bot: ${settings.botName || 'Infinity MD'}`);
    parts.push('│');

    for (const [key, label] of Object.entries(toggleable)) {
      try {
        const val = await store.getSetting('global', key);
        const enabled = val?.enabled ? '✅ Enabled' : '❌ Disabled';
        parts.push(`│ ${label.padEnd(18)} : ${enabled}`);
      } catch (e) {
        parts.push(`│ ${label.padEnd(18)} : ❌ Unknown`);
      }
    }

    parts.push('│');
    parts.push(`│ Toggle instantly: ${prefix}settingsmenu toggle <key>`);
    parts.push('╰────────────────────────╯');
    parts.push('\nFor changing prefix or language use the respective commands.');

    await sock.sendMessage(chatId, { text: parts.join('\n') }, { quoted: message });
  }
};

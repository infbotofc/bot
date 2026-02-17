const store = require('../lib/lightweight_store');

/**
 * GHOST / STEALTH MODE (ALWAYS OFFLINE)
 * ------------------------------------
 * Goal: When .ghost on, bot should look offline-like EVEN if auto-typing is enabled.
 *
 * This implementation:
 * ✅ Saves stealthMode in DB
 * ✅ Patches the *live* sock instance to block ALL presence + receipts while enabled
 * ✅ Works even if other plugins call sock.sendPresenceUpdate('composing'...)
 * ✅ No restart needed
 * ✅ Supports: on/off/toggle/status
 *
 * IMPORTANT:
 * - WhatsApp can still know the device is connected; this hides online/typing/read signals.
 */

// Keep originals per socket so we can restore on .ghost off
const ORIGINALS = new WeakMap();

function normalizeStealth(val) {
  if (val && typeof val === 'object') return { enabled: !!val.enabled, ...val };
  if (typeof val === 'boolean') return { enabled: val };
  if (typeof val === 'string') return { enabled: val.toLowerCase() === 'true' };
  return { enabled: false };
}

async function isStealthEnabled() {
  const raw = await store.getSetting('global', 'stealthMode');
  return normalizeStealth(raw).enabled;
}

async function setStealth(enabled) {
  const next = { enabled: !!enabled, updatedAt: Date.now() };
  await store.saveSetting('global', 'stealthMode', next);
  return next;
}

function ensurePatched(sock) {
  if (!sock || ORIGINALS.has(sock)) return;

  const originals = {
    sendPresenceUpdate: sock.sendPresenceUpdate ? sock.sendPresenceUpdate.bind(sock) : null,
    readMessages: sock.readMessages ? sock.readMessages.bind(sock) : null,
    sendReceipt: sock.sendReceipt ? sock.sendReceipt.bind(sock) : null,
    sendReadReceipt: sock.sendReadReceipt ? sock.sendReadReceipt.bind(sock) : null,
    query: sock.query ? sock.query.bind(sock) : null
  };

  // Presence (online/typing/recording)
  if (originals.sendPresenceUpdate) {
    sock.sendPresenceUpdate = async (...args) => {
      try {
        if (await isStealthEnabled()) return;
      } catch {}
      return originals.sendPresenceUpdate(...args);
    };
  }

  // Mark as read / blue ticks
  if (originals.readMessages) {
    sock.readMessages = async (...args) => {
      try {
        if (await isStealthEnabled()) return;
      } catch {}
      return originals.readMessages(...args);
    };
  }

  // Delivery/read receipts
  if (originals.sendReceipt) {
    sock.sendReceipt = async (...args) => {
      try {
        if (await isStealthEnabled()) return;
      } catch {}
      return originals.sendReceipt(...args);
    };
  }

  if (originals.sendReadReceipt) {
    sock.sendReadReceipt = async (...args) => {
      try {
        if (await isStealthEnabled()) return;
      } catch {}
      return originals.sendReadReceipt(...args);
    };
  }

  // Low-level blocker: blocks presence + receipts even if plugins craft nodes
  if (originals.query) {
    sock.query = async (node, ...args) => {
      try {
        if (await isStealthEnabled()) {
          // Block the most common signal packets
          if (node?.tag === 'presence') return;
          if (node?.tag === 'receipt') return;

          // Some builds send these types
          if (node?.attrs && (node.attrs.type === 'read' || node.attrs.type === 'read-self')) return;

          // Some presence nodes may appear with different tags/attrs
          if (node?.attrs && (node.attrs.name === 'presence' || node.attrs.category === 'presence')) return;
        }
      } catch {}
      return originals.query(node, ...args);
    };
  }

  ORIGINALS.set(sock, originals);
}

function restoreIfPossible(sock) {
  const originals = ORIGINALS.get(sock);
  if (!originals) return;

  try {
    if (originals.sendPresenceUpdate) sock.sendPresenceUpdate = originals.sendPresenceUpdate;
    if (originals.readMessages) sock.readMessages = originals.readMessages;
    if (originals.sendReceipt) sock.sendReceipt = originals.sendReceipt;
    if (originals.sendReadReceipt) sock.sendReadReceipt = originals.sendReadReceipt;
    if (originals.query) sock.query = originals.query;
  } catch {}

  ORIGINALS.delete(sock);
}

module.exports = {
  command: 'ghost',
  aliases: ['stealth', 'invisible'],
  category: 'owner',
  description: 'Always-offline stealth mode (blocks online/typing/read receipts) even if autotyping is enabled',
  usage: '.ghost <on|off|toggle|status>',
  ownerOnly: true,

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const action = (args[0] || '').toLowerCase().trim();

    try {
      // Ensure live socket is patched (so autotyping can’t leak presence)
      ensurePatched(sock);

      const current = normalizeStealth(await store.getSetting('global', 'stealthMode'));

      if (!action || action === 'help' || action === 'status') {
        const status = current.enabled ? '✅ Enabled' : '❌ Disabled';
        const last = current.updatedAt
          ? new Date(current.updatedAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })
          : '—';

        return await sock.sendMessage(
          chatId,
          {
            text:
              `*👻 GHOST MODE (ALWAYS OFFLINE)*\n\n` +
              `*Current Status:* ${status}\n` +
              `*Last Change:* ${last}\n\n` +
              `*Commands:*\n` +
              `• \`.ghost on\` - Enable\n` +
              `• \`.ghost off\` - Disable\n` +
              `• \`.ghost toggle\` - Toggle\n` +
              `• \`.ghost status\` - Status\n\n` +
              `*What it blocks:* online status, typing/recording, read receipts.\n` +
              `_Works even if .autotyping is enabled._`
          },
          { quoted: message }
        );
      }

      if (action === 'toggle') {
        const next = await setStealth(!current.enabled);
        // Keep patch active in both cases; it self-checks DB. (No restart)
        return await sock.sendMessage(
          chatId,
          {
            text: next.enabled
              ? '✅ *Ghost mode enabled!*\n_Always-offline stealth is active now (autotyping won’t show typing)._'
              : '❌ *Ghost mode disabled!*\n_Bot will behave normally._'
          },
          { quoted: message }
        );
      }

      if (action === 'on' || action === 'enable' || action === 'true') {
        if (current.enabled) {
          return await sock.sendMessage(chatId, { text: '✅ Ghost mode is already enabled.' }, { quoted: message });
        }
        await setStealth(true);
        return await sock.sendMessage(
          chatId,
          { text: '✅ *Ghost mode enabled!*\n_Always-offline stealth is active now (autotyping won’t show typing)._'},
          { quoted: message }
        );
      }

      if (action === 'off' || action === 'disable' || action === 'false') {
        if (!current.enabled) {
          return await sock.sendMessage(chatId, { text: '❌ Ghost mode is already disabled.' }, { quoted: message });
        }
        await setStealth(false);

        // Optional: restore originals to reduce overhead when stealth is OFF.
        // If you prefer to keep patch always, comment this out.
        restoreIfPossible(sock);

        return await sock.sendMessage(
          chatId,
          { text: '❌ *Ghost mode disabled!*\n_Bot will behave normally now._' },
          { quoted: message }
        );
      }

      return await sock.sendMessage(
        chatId,
        { text: '❌ *Invalid option!*\nUse: `.ghost on`, `.ghost off`, `.ghost toggle`, `.ghost status`' },
        { quoted: message }
      );
    } catch (e) {
      console.error('ghost command error:', e);
      try {
        await sock.sendMessage(chatId, { text: `⚠️ Ghost error: ${e?.message || e}` }, { quoted: message });
      } catch {}
    }
  }
};

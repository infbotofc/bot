/* process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; */
'use strict';

// Load environment variables from .env (do NOT commit your real .env to git)
try {
  require('dotenv').config();
} catch (e) {}

require('./config');
require('./settings');

const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const FileType = require('file-type');
const syntaxerror = require('syntax-error');
const path = require('path');
const axios = require('axios');
const PhoneNumber = require('awesome-phonenumber');
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid } = require('./lib/exif');
const { smsg, isUrl, generateMessageTag, getBuffer, getSizeMedia, fetch, await: _await, sleep, reSize } = require('./lib/myfunc');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateForwardMessageContent,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  generateMessageID,
  downloadContentFromMessage,
  Browsers,
  jidDecode,
  proto,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  delay
} = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const pino = require('pino');
const readline = require('readline');
const { parsePhoneNumber } = require('libphonenumber-js');
const { PHONENUMBER_MCC } = require('@whiskeysockets/baileys/lib/Utils/generics');
const { rmSync, existsSync, mkdirSync } = require('fs');

const store = require('./lib/lightweight_store');
const SaveCreds = require('./lib/session');
const { app, server, PORT } = require('./lib/server');
const { printLog } = require('./lib/print');
const {
  handleMessages,
  handleGroupParticipantUpdate,
  handleStatus,
  handleCall
} = require('./lib/messageHandler');

const settings = require('./settings');
const commandHandler = require('./lib/commandHandler');

// ✅ ADD THIS: AntiDelete + AntiViewOnce plugin
// Ensure the file exists: ./plugins/antidelete.js
const antidelete = require('./plugins/antidelete');

// ------------------------------
// ✅ Normalize list/button replies into plain text
// So your command handler can treat them like typed commands.
// ------------------------------
function normalizeInteractiveReplies(mek) {
  try {
    if (!mek?.message) return mek;

    // unwrap ephemeral
    if (Object.keys(mek.message)[0] === 'ephemeralMessage') {
      mek.message = mek.message.ephemeralMessage?.message || mek.message;
    }

    // unwrap viewOnce ephemeral container (some clients wrap buttons inside)
    if (Object.keys(mek.message)[0] === 'viewOnceMessageV2') {
      mek.message = mek.message.viewOnceMessageV2?.message || mek.message;
    }

    const selectedList = mek.message?.listResponseMessage?.singleSelectReply?.selectedRowId;
    const selectedBtn =
      mek.message?.buttonsResponseMessage?.selectedButtonId ||
      mek.message?.templateButtonReplyMessage?.selectedId;

    const picked = selectedList || selectedBtn;
    if (picked) {
      mek.message = { conversation: String(picked) };
    }

    return mek;
  } catch {
    return mek;
  }
}

store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

commandHandler.loadCommands();

// GC + RAM guard
setInterval(() => {
  if (global.gc) {
    global.gc();
    console.log('🧹 Garbage collection completed');
  }
}, 60_000);

setInterval(() => {
  const used = process.memoryUsage().rss / 1024 / 1024;
  if (used > 400) {
    console.log(chalk.yellow('⚠️ RAM too high (>400MB), restarting bot...'));
    process.exit(1);
  }
}, 30_000);

let phoneNumber = global.PAIRING_NUMBER || process.env.PAIRING_NUMBER || '94702958515';

// ✅ Safer owner loading (avoid crash when file missing)
let owner = [];
try {
  owner = JSON.parse(fs.readFileSync('./data/owner.json'));
} catch (e) {
  owner = [settings.ownerNumber || phoneNumber];
}

global.botname = process.env.BOT_NAME || 'Infinity MD';
global.themeemoji = '•';

const pairingCode = !!phoneNumber || process.argv.includes('--pairing-code');
const useMobile = process.argv.includes('--mobile');

let rl = null;
if (process.stdin.isTTY && !process.env.PAIRING_NUMBER) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

const question = (text) => {
  if (rl && !rl.closed) {
    return new Promise((resolve) => rl.question(text, resolve));
  } else {
    return Promise.resolve(settings.ownerNumber || phoneNumber);
  }
};

process.on('exit', () => {
  if (rl && !rl.closed) rl.close();
});

process.on('SIGINT', () => {
  if (rl && !rl.closed) rl.close();
  process.exit(0);
});

function ensureSessionDirectory() {
  const sessionPath = path.join(__dirname, 'session');
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });
  return sessionPath;
}

function hasValidSession() {
  try {
    const credsPath = path.join(__dirname, 'session', 'creds.json');
    if (!existsSync(credsPath)) return false;

    const fileContent = fs.readFileSync(credsPath, 'utf8');
    if (!fileContent || fileContent.trim().length === 0) {
      printLog('warning', 'creds.json exists but is empty');
      return false;
    }

    try {
      const creds = JSON.parse(fileContent);
      if (!creds.noiseKey || !creds.signedIdentityKey || !creds.signedPreKey) {
        printLog('warning', 'creds.json is missing required fields');
        return false;
      }
      if (creds.registered === false) {
        printLog('warning', 'Session credentials exist but are not registered');
        try {
          rmSync(path.join(__dirname, 'session'), { recursive: true, force: true });
        } catch (e) {}
        return false;
      }
      printLog('success', 'Valid and registered session credentials found');
      return true;
    } catch (parseError) {
      printLog('warning', 'creds.json contains invalid JSON');
      return false;
    }
  } catch (error) {
    printLog('error', `Error checking session validity: ${error.message}`);
    return false;
  }
}

async function initializeSession() {
  ensureSessionDirectory();

  const txt = global.SESSION_ID || process.env.SESSION_ID;

  if (!txt) {
    printLog('warning', 'No SESSION_ID found in environment variables');
    if (hasValidSession()) {
      printLog('success', 'Existing session found. Using saved credentials');
      return true;
    }
    printLog('warning', 'No existing session found. Pairing code will be required');
    return false;
  }

  if (hasValidSession()) return true;

  try {
    await SaveCreds(txt);
    await delay(2000);

    if (hasValidSession()) {
      printLog('success', 'Session file verified and valid');
      await delay(1000);
      return true;
    }

    printLog('error', 'Session file not valid after download');
    return false;
  } catch (error) {
    printLog('error', `Error downloading session: ${error.message}`);
    return false;
  }
}

server.listen(PORT, () => {
  printLog('success', `Server listening on port ${PORT}`);
});

let _startingQasim = false;
let _restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 6;

async function startQasimDev() {
  try {
    if (_startingQasim) {
      printLog('info', 'startQasimDev already running, skipping duplicate start');
      return;
    }
    _startingQasim = true;

    const { version } = await fetchLatestBaileysVersion();

    ensureSessionDirectory();
    await delay(1000);

    let state, saveCreds;
    try {
      ({ state, saveCreds } = await useMultiFileAuthState('./session'));
    } catch (err) {
      printLog('error', `Failed to load auth state: ${err.message}. Clearing session and retrying.`);
      try {
        rmSync('./session', { recursive: true, force: true });
      } catch (e) {}
      await delay(1000);
      ({ state, saveCreds } = await useMultiFileAuthState('./session'));
    }

    const msgRetryCounterCache = new NodeCache();
    printLog('info', `Credentials loaded. Registered: ${state.creds?.registered || false}`);

    const ghostMode = await store.getSetting('global', 'stealthMode');
    const isGhostActive = ghostMode && ghostMode.enabled;

    if (isGhostActive) printLog('info', '👻 STEALTH MODE IS ACTIVE - Starting in stealth mode');

    const QasimDev = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: !pairingCode,
      browser: Browsers.macOS('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
      },
      markOnlineOnConnect: !isGhostActive,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      getMessage: async (key) => {
        const jid = jidNormalizedUser(key.remoteJid);
        const msg = await store.loadMessage(jid, key.id);
        return msg?.message || '';
      },
      msgRetryCounterCache,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 250,
      maxRetries: 5
    });

    // Stealth mode overrides
    const originalSendPresenceUpdate = QasimDev.sendPresenceUpdate;
    const originalReadMessages = QasimDev.readMessages;
    const originalSendReceipt = QasimDev.sendReceipt;
    const originalSendReadReceipt = QasimDev.sendReadReceipt;

    QasimDev.sendPresenceUpdate = async function (...args) {
      const gm = await store.getSetting('global', 'stealthMode');
      if (gm && gm.enabled) return;
      return originalSendPresenceUpdate.apply(this, args);
    };

    QasimDev.readMessages = async function (...args) {
      const gm = await store.getSetting('global', 'stealthMode');
      if (gm && gm.enabled) return;
      return originalReadMessages.apply(this, args);
    };

    if (originalSendReceipt) {
      QasimDev.sendReceipt = async function (...args) {
        const gm = await store.getSetting('global', 'stealthMode');
        if (gm && gm.enabled) return;
        return originalSendReceipt.apply(this, args);
      };
    }

    if (originalSendReadReceipt) {
      QasimDev.sendReadReceipt = async function (...args) {
        const gm = await store.getSetting('global', 'stealthMode');
        if (gm && gm.enabled) return;
        return originalSendReadReceipt.apply(this, args);
      };
    }

    const originalQuery = QasimDev.query;
    QasimDev.query = async function (node, ...args) {
      const gm = await store.getSetting('global', 'stealthMode');
      if (gm && gm.enabled) {
        if (node?.tag === 'receipt') return;
        if (node?.attrs && (node.attrs.type === 'read' || node.attrs.type === 'read-self')) return;
      }
      return originalQuery.apply(this, [node, ...args]);
    };

    QasimDev.ev.on('creds.update', saveCreds);
    store.bind(QasimDev.ev);

    QasimDev.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const mek = chatUpdate.messages[0];
        if (!mek?.message) return;

        normalizeInteractiveReplies(mek);
        chatUpdate.messages[0] = mek;

        // ✅ AntiDelete + AntiViewOnce hook (THIS IS THE FIX)
        // 1) store every message for restore
        await antidelete.storeMessage(QasimDev, mek);
        // 2) if message is delete-for-everyone event, handle it
        if (mek?.message?.protocolMessage?.type === 0) {
          await antidelete.handleMessageRevocation(QasimDev, mek);
        }

        if (mek.key?.remoteJid === 'status@broadcast') {
          await handleStatus(QasimDev, chatUpdate);
          return;
        }

        if (!QasimDev.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
          const isGroup = mek.key?.remoteJid?.endsWith('@g.us');
          if (!isGroup) return;
        }

        if (mek.key?.id?.startsWith('BAE5') && mek.key.id.length === 16) return;

        if (QasimDev?.msgRetryCounterCache) QasimDev.msgRetryCounterCache.clear();

        await handleMessages(QasimDev, chatUpdate);
      } catch (err) {
        printLog('error', `Error in messages.upsert: ${err.message}`);
      }
    });

    QasimDev.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {};
        return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
      }
      return jid;
    };

    QasimDev.ev.on('contacts.update', (update) => {
      for (const contact of update) {
        const id = QasimDev.decodeJid(contact.id);
        if (store?.contacts) store.contacts[id] = { id, name: contact.notify };
      }
    });

    QasimDev.getName = (jid, withoutContact = false) => {
      let id = QasimDev.decodeJid(jid);
      withoutContact = QasimDev.withoutContact || withoutContact;
      let v;
      if (id.endsWith('@g.us'))
        return new Promise(async (resolve) => {
          v = store.contacts[id] || {};
          if (!(v.name || v.subject)) v = QasimDev.groupMetadata(id) || {};
          resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'));
        });
      v =
        id === '0@s.whatsapp.net'
          ? { id, name: 'WhatsApp' }
          : id === QasimDev.decodeJid(QasimDev.user.id)
            ? QasimDev.user
            : store.contacts[id] || {};
      return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international');
    };

    QasimDev.public = true;
    QasimDev.serializeM = (m) => smsg(QasimDev, m, store);

    const isRegistered = state.creds?.registered === true;

    if (pairingCode && !isRegistered) {
      if (useMobile) throw new Error('Cannot use pairing code with mobile api');

      printLog('warning', 'Session not registered. Pairing code required');

      let phoneNumberInput;
      if (global.phoneNumber) phoneNumberInput = global.phoneNumber;
      else if (process.env.PAIRING_NUMBER) phoneNumberInput = process.env.PAIRING_NUMBER;
      else if (rl && !rl.closed) {
        phoneNumberInput = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number 😍\nFormat: 6281376552730 (without + or spaces) : `)));
      } else phoneNumberInput = phoneNumber;

      const helper = require('./lib/baileys_helper');
      phoneNumberInput = helper.normalizeNumber(phoneNumberInput);

      setTimeout(async () => {
        try {
          let code = await QasimDev.requestPairingCode(phoneNumberInput);
          const formattedCode = helper.formatPairingCode(code || '');
          console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(formattedCode)));
          printLog('success', `Pairing code generated: ${formattedCode}`);
          if (rl && !rl.closed) {
            rl.close();
            rl = null;
          }
        } catch (error) {
          printLog('error', `Failed to get pairing code: ${error.message}`);
        }
      }, 3000);
    } else {
      if (rl && !rl.closed) {
        rl.close();
        rl = null;
      }
    }

    QasimDev.ev.on('connection.update', async (s) => {
      const { connection, lastDisconnect, qr } = s;

      if (qr) printLog('info', 'QR Code generated. Please scan with WhatsApp');
      if (connection === 'connecting') printLog('connection', 'Connecting to WhatsApp...');

      if (connection === 'open') {
        printLog('success', 'Bot connected successfully!');

        // ✅ Start AutoBio
        try {
          const { updateBio, startAutoBio } = require('./plugins/setbio');
          await updateBio(QasimDev);
          startAutoBio(QasimDev);
        } catch (e) {
          printLog('error', 'AutoBio Startup Error: ' + e.message);
        }

        // ✅ Start AutoPP Scheduler (your new plugin)
        try {
          const autopp = require('./plugins/autopp');
          if (typeof autopp.startAutoPP === 'function') {
            await autopp.startAutoPP(QasimDev);
            printLog('success', 'AutoPP scheduler started');
          }
        } catch (e) {
          printLog('error', 'AutoPP startup error: ' + (e?.message || e));
        }

        const ghostMode = await store.getSetting('global', 'stealthMode');
        if (ghostMode?.enabled) {
          printLog('info', '👻 STEALTH MODE ACTIVE - Bot is in stealth mode');
          console.log(chalk.gray('• No online status'));
          console.log(chalk.gray('• No typing indicators'));
        }

        console.log(chalk.yellow(`🌿Connected to => ` + JSON.stringify(QasimDev.user, null, 2)));

        await delay(1999);
        console.log(chalk.yellow(`\n\n                  ${chalk.bold.blue(`[ ${global.botname || 'Infinity MD'} ]`)}\n\n`));
        console.log(chalk.cyan(`< ================================================== >`));
        console.log(chalk.magenta(`\n${global.themeemoji || '•'} YT CHANNEL: GlobalTechInfo`));
        console.log(chalk.magenta(`${global.themeemoji || '•'} GITHUB: GlobalTechInfo`));
        console.log(chalk.magenta(`${global.themeemoji || '•'} WA NUMBER: ${owner}`));
        console.log(chalk.magenta(`${global.themeemoji || '•'} CREDIT: Qasim Ali`));
        console.log(chalk.green(`${global.themeemoji || '•'} 🤖 Bot Connected Successfully! ✅`));
        console.log(chalk.blue(`Bot Version: ${settings.version}`));
        console.log(chalk.cyan(`Loaded Commands: ${commandHandler.commands.size}`));
        console.log(chalk.cyan(`Prefixes: ${settings.prefixes.join(', ')}`));
        console.log(chalk.gray(`Backend: ${store.getStats().backend}`));
        console.log();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason =
          statusCode === DisconnectReason.loggedOut ? 'Logged Out' :
          statusCode === 440 ? 'Token Revoked' :
          statusCode === 503 ? 'Service Unavailable' :
          statusCode === 515 ? 'Temporarily Unavailable' :
          'Unknown';

        printLog('error', `Connection closed - Status: ${statusCode} (${reason})`);

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          try {
            const backupDir = `./session.bak.${Date.now()}`;
            try {
              require('fs').renameSync('./session', backupDir);
              printLog('info', `Backed up session to ${backupDir}`);
            } catch (e) {}
            rmSync('./session', { recursive: true, force: true });
            printLog('warning', 'Session logged out. Session cleared. Please re-authenticate');
            return;
          } catch (error) {
            printLog('error', `Error deleting session: ${error.message}`);
          }
        }

        if (shouldReconnect) {
          try {
            QasimDev.ev.removeAllListeners();
          } catch (e) {}
          try {
            if (QasimDev.end) await QasimDev.end();
          } catch (e) {}

          const waitTime = [440, 503, 515].includes(statusCode) ? 10000 : 5000;
          printLog('connection', `Reconnecting in ${waitTime / 1000} seconds...`);
          await delay(waitTime);
          _startingQasim = false;
          _restartAttempts++;
          if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
            printLog('error', `Exceeded max restart attempts (${MAX_RESTART_ATTEMPTS}). Exiting.`);
            process.exit(1);
          }
          startQasimDev();
        }
      }
    });

    QasimDev.ev.on('call', async (calls) => {
      await handleCall(QasimDev, calls);
    });
    QasimDev.ev.on('group-participants.update', async (update) => {
      await handleGroupParticipantUpdate(QasimDev, update);
    });
    QasimDev.ev.on('status.update', async (status) => {
      await handleStatus(QasimDev, status);
    });
    QasimDev.ev.on('messages.reaction', async (reaction) => {
      await handleStatus(QasimDev, reaction);
    });

    _startingQasim = false;
    _restartAttempts = 0;
    global.QasimDev = QasimDev;
    return QasimDev;
  } catch (error) {
    printLog('error', `Error in startQasimDev: ${error.message}`);

    if (rl && !rl.closed) {
      rl.close();
      rl = null;
    }

    _startingQasim = false;
    _restartAttempts++;
    if (_restartAttempts > MAX_RESTART_ATTEMPTS) {
      printLog('error', `startQasimDev failed repeatedly (${_restartAttempts}). Exiting.`);
      process.exit(1);
    }
    await delay(5000);
    startQasimDev();
  }
}

async function main() {
  printLog('info', 'Starting Infinity MD Bot...');

  const sessionReady = await initializeSession();
  if (sessionReady) printLog('success', 'Session initialization complete. Starting bot...');
  else printLog('warning', 'Session initialization incomplete. Will attempt pairing...');

  await delay(3000);

  startQasimDev().catch((error) => {
    printLog('error', `Fatal error: ${error.message}`);
    if (rl && !rl.closed) rl.close();
    process.exit(1);
  });
}

main();

// Temp folder
const customTemp = path.join(process.cwd(), 'temp');
if (!fs.existsSync(customTemp)) fs.mkdirSync(customTemp, { recursive: true });
process.env.TMPDIR = customTemp;
process.env.TEMP = customTemp;
process.env.TMP = customTemp;

setInterval(() => {
  fs.readdir(customTemp, (err, files) => {
    if (err) return;
    for (const file of files) {
      const filePath = path.join(customTemp, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && Date.now() - stats.mtimeMs > 3 * 60 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      });
    }
  });
}, 1 * 60 * 60 * 1000);

// Syntax check
const folders = [path.join(__dirname, './lib'), path.join(__dirname, './plugins')];
let totalFiles = 0;
let okFiles = 0;
let errorFiles = 0;

folders.forEach((folder) => {
  if (!fs.existsSync(folder)) return;

  fs.readdirSync(folder)
    .filter((file) => file.endsWith('.js'))
    .forEach((file) => {
      totalFiles++;
      const filePath = path.join(folder, file);

      try {
        const code = fs.readFileSync(filePath, 'utf-8');
        const err = syntaxerror(code, file, {
          sourceType: 'script',
          allowAwaitOutsideFunction: true
        });

        if (err) {
          console.error(chalk.red(`❌ Syntax error in ${filePath}:\n${err}`));
          errorFiles++;
        } else {
          okFiles++;
        }
      } catch (e) {
        console.error(chalk.yellow(`⚠️ Cannot read file ${filePath}:\n${e}`));
        errorFiles++;
      }
    });
});

process.on('uncaughtException', (err) => {
  printLog('error', `Uncaught Exception: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (err) => {
  printLog('error', `Unhandled Rejection: ${err.message}`);
  console.error(err.stack);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  printLog('info', `Received ${signal}. Shutting down gracefully...`);
  try {
    if (global.QasimDev?.ev) {
      try {
        global.QasimDev.ev.removeAllListeners();
      } catch (e) {}
      try {
        if (global.QasimDev.end) await global.QasimDev.end();
      } catch (e) {}
    }
    await delay(500);
    printLog('info', 'Shutdown complete.');
    process.exit(0);
  } catch (e) {
    printLog('error', `Error during shutdown: ${e.message}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    printLog('error', `Address localhost:${PORT} in use`);
    server.close();
  } else {
    printLog('error', `Server error: ${error.message}`);
  }
});

let file = require.resolve(__filename);
fs.watchFile(file, () => {
  fs.unwatchFile(file);
  printLog('info', 'index.js updated, reloading...');
  delete require.cache[file];
  require(file);
});

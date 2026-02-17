/**
 * INFINITY MD SETTINGS
 * --------------------
 * Safe, validated config for all plugins
 */

const settings = {

  /* ================== BASIC ================== */

  prefixes: ['.', '!', '/', '#'],   // command prefixes
  defaultPrefix: '.',               // fallback prefix

  botName: "Infinity MD",
  packname: 'Infinity MD',
  author: 'Infinity MD Bot',

  description: "Infinity MD Bot - Powered by AI",
  version: "1.0.2",

  /* ================== OWNER ================== */

  botOwner: 'Default Publisher',

  // Raw number (digits only)
  ownerNumber: '94778507806',

  // JID format (used internally by WhatsApp)
  ownerJid: '94778507806@s.whatsapp.net',

  /* ================== MODE ================== */

  // public = everyone can use
  // private = only owner
  // group = groups only
  commandMode: "public",

  /* ================== REGION ================== */

  // Use Sri Lanka timezone (fix timestamps)
  timeZone: 'Asia/Colombo',

  /* ================== API KEYS ================== */

  giphyApiKey: 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',

  /* ================== STORAGE ================== */

  maxStoreMessages: 20,
  storeWriteInterval: 10000,

  // temp file cleanup (1 hour)
  tempCleanupInterval: 1 * 60 * 60 * 1000,

  /* ================== UPDATES ================== */

  updateZipUrl:
    "https://github.com/GlobalTechInfo/Infinity-MD/archive/refs/heads/main.zip",

  /* ================== LINKS ================== */

  channelLink: "",
  ytch: "GlobalTechInfo",

  /* ================== OPTIONAL FUTURE ================== */

  sessionName: "InfinityMD",
  maxGroupParticipants: 1000,
};

module.exports = settings;

const path = require('path');
const { pathToFileURL } = require('url');

async function loadMegaModule() {
  const file = path.resolve(__dirname, '..', 'dashboard', 'WEB-PAIR-QR-main', 'mega.js');
  const url = pathToFileURL(file).href;
  return await import(url);
}

async function upload(data, name) {
  const mod = await loadMegaModule();
  if (!mod || !mod.upload) throw new Error('mega upload function not found');
  return await mod.upload(data, name);
}

module.exports = { upload };

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    delay
} = require('@whiskeysockets/baileys');

const helper = require('./baileys_helper');

const router = express.Router();
const baseDir = path.join(__dirname, '..', 'data', 'multidevice_sessions');
fs.ensureDirSync(baseDir);

function deviceInfoPath(id) { return path.join(baseDir, id, 'info.json'); }

// GET /api/multidevice/qr - create a temporary QR session
router.get('/qr', async (req, res) => {
    try {
        const id = uuidv4().slice(0,8);
        const sessionDir = path.join(baseDir, id);
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })) },
            browser: Browsers.windows('Chrome'),
            markOnlineOnConnect: false,
            printQRInTerminal: false,
        });

        let sent = false;
        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;
            if (qr && !sent) {
                sent = true;
                const qrData = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' });
                await fs.writeJSON(deviceInfoPath(id), { id, createdAt: Date.now(), status: 'qr', type: 'qr' });
                res.json({ id, qr: qrData, message: 'Scan QR with WhatsApp to link device' });
            }

            if (connection === 'open') {
                await fs.writeJSON(deviceInfoPath(id), { id, createdAt: Date.now(), status: 'paired', type: 'qr' });
                await delay(1000);
                sock.logout && sock.logout().catch(()=>{});
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // timeout
        setTimeout(async () => {
            if (!sent && !res.headersSent) {
                res.status(408).json({ error: 'QR generation timeout' });
                sock.end && sock.end(new Error('timeout'));
            }
        }, 60000);

    } catch (err) {
        console.error('multidevice qr error', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/multidevice/number - pairing code by number
router.post('/number', async (req, res) => {
    try {
        const { number } = req.body || {};
        if (!number) return res.status(400).json({ error: 'Phone number required' });

        const clean = (() => { try { return helper.normalizeNumber(number); } catch (e) { return null; } })();
        if (!clean) return res.status(400).json({ error: 'Invalid phone number' });

        const id = uuidv4().slice(0,8);
        const sessionDir = path.join(baseDir, id);
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })) },
            browser: Browsers.windows('Chrome'),
            markOnlineOnConnect: false,
            printQRInTerminal: false,
        });

        let codeSent = false;
        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                await fs.writeJSON(deviceInfoPath(id), { id, createdAt: Date.now(), status: 'paired', phone: clean });
                await delay(1000);
                sock.logout && sock.logout().catch(()=>{});
            }
            if (connection === 'close') {
                sock.ev.removeAllListeners();
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            try {
                const raw = await helper.requestPairingCode(sock, clean);
                const code = raw || '';
                codeSent = true;
                await fs.writeJSON(deviceInfoPath(id), { id, createdAt: Date.now(), status: 'code_sent', phone: clean });
                res.json({ id, code, message: 'Pairing code generated. Enter this in WhatsApp -> Linked Devices -> Link with phone number' });
            } catch (err) {
                if (!res.headersSent) res.status(503).json({ error: 'Failed to generate pairing code' });
            }
        }

        sock.ev.on('creds.update', saveCreds);

        setTimeout(() => {
            if (!codeSent && !res.headersSent) res.status(408).json({ error: 'Pairing code timeout' });
            sock.end && sock.end(new Error('timeout'));
        }, 30000);

    } catch (err) {
        console.error('multidevice number error', err);
        res.status(500).json({ error: err.message });
    }
});

// devices listing
router.get('/devices', async (req, res) => {
    try {
        const ids = await fs.readdir(baseDir).catch(()=>[]);
        const out = [];
        for (const id of ids) {
            const p = deviceInfoPath(id);
            if (await fs.pathExists(p)) out.push(await fs.readJSON(p));
        }
        res.json({ devices: out });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// remove device
router.delete('/devices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const dir = path.join(baseDir, id);
        if (!await fs.pathExists(dir)) return res.status(404).json({ error: 'Not found' });
        await fs.remove(dir);
        res.json({ status: 'deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

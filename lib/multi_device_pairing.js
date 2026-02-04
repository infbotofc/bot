const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const pn = require('awesome-phonenumber');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    delay
} = require('@whiskeysockets/baileys');

const router = express.Router();
const devicesDir = path.join(__dirname, '..', 'data', 'devices');

// Ensure devices directory exists
fs.ensureDirSync(devicesDir);

/**
 * GET /api/pair/qr - Generate QR code for WhatsApp linking
 * Returns: { deviceId, qr (data URL), message }
 */
router.get('/qr', async (req, res) => {
    try {
        const deviceId = uuidv4().slice(0, 8); // Short device ID
        const deviceDir = path.join(devicesDir, deviceId);
        const sessionDir = path.join(deviceDir, 'session');
        
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        let qrGenerated = false;
        let responseSent = false;
        let sock;

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            markOnlineOnConnect: false,
        });

        const handleQR = async (qr) => {
            if (qrGenerated || responseSent) return;
            qrGenerated = true;

            try {
                const qrDataURL = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' });
                if (!responseSent) {
                    responseSent = true;
                    res.json({
                        deviceId,
                        qr: qrDataURL,
                        message: 'QR Code generated! Scan with WhatsApp.',
                        instructions: [
                            'Open WhatsApp on your phone',
                            'Go to Settings > Linked Devices',
                            'Tap "Link a Device"',
                            'Scan this QR code'
                        ]
                    });
                }
            } catch (err) {
                console.error('QR generation error:', err);
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Failed to generate QR code' });
                }
            }
        };

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            if (qr && !qrGenerated) await handleQR(qr);

            if (connection === 'open') {
                console.log(`✅ Device ${deviceId} connected successfully`);
                
                // Save device info
                const deviceInfo = {
                    deviceId,
                    phoneNumber: sock.user?.id?.split(':')[0] || 'unknown',
                    createdAt: new Date().toISOString(),
                    status: 'active'
                };
                await fs.writeJSON(path.join(deviceDir, 'info.json'), deviceInfo);
                
                // Keep connection alive briefly then close
                await delay(3000);
                await sock.logout();
            }

            if (connection === 'close') {
                console.log(`Connection closed for device ${deviceId}`);
                sock.ev.removeAllListeners();
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Timeout after 60 seconds
        setTimeout(() => {
            if (!responseSent) {
                responseSent = true;
                res.status(408).json({ error: 'QR generation timeout' });
            }
            if (sock) sock.end(new Error('timeout'));
        }, 60000);

    } catch (err) {
        console.error('QR endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/pair/number - Generate pairing code for phone number
 * Body: { number } - full phone number with country code
 * Returns: { deviceId, code, message }
 */
router.post('/number', async (req, res) => {
    try {
        const { number } = req.body;
        if (!number) {
            return res.status(400).json({ error: 'Phone number required' });
        }

        // Normalize and validate number using awesome-phonenumber
        const raw = String(number || '').trim();
        const phone = pn(raw.startsWith('+') ? raw : ('+' + raw.replace(/[^0-9]/g, '')));
        if (!phone.isValid()) {
            return res.status(400).json({ error: 'Invalid phone number. Use full international format with country code.' });
        }

        const cleanNumber = phone.getNumber('e164').replace('+', '');

        const deviceId = uuidv4().slice(0, 8);
        const deviceDir = path.join(devicesDir, deviceId);
        const sessionDir = path.join(deviceDir, 'session');
        
        await fs.ensureDir(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        let codeSent = false;
        let sock;

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            markOnlineOnConnect: false,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                console.log(`✅ Device ${deviceId} paired successfully`);
                
                const deviceInfo = {
                    deviceId,
                    phoneNumber: cleanNumber,
                    createdAt: new Date().toISOString(),
                    status: 'active'
                };
                await fs.writeJSON(path.join(deviceDir, 'info.json'), deviceInfo);
                
                await delay(2000);
                await sock.logout();
            }

            if (connection === 'close') {
                console.log(`Pairing session closed for device ${deviceId}`);
                sock.ev.removeAllListeners();
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(1500);
            try {
                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                codeSent = true;
                res.json({
                    deviceId,
                    code,
                    message: 'Pairing code generated. Enter this code in WhatsApp.',
                    instructions: [
                        'Open WhatsApp on your phone',
                        'Go to Settings > Linked Devices',
                        'Tap "Link a Device"',
                        'Select "Link with phone number"',
                        'Enter your number when prompted',
                        'Enter the code shown above'
                    ]
                });
            } catch (err) {
                if (!codeSent) {
                    res.status(503).json({ error: 'Failed to generate pairing code' });
                }
            }
        }

        sock.ev.on('creds.update', saveCreds);

        // Timeout after 30 seconds
        setTimeout(() => {
            if (!codeSent) {
                res.status(408).json({ error: 'Pairing code timeout' });
            }
            if (sock) sock.end(new Error('timeout'));
        }, 30000);

    } catch (err) {
        console.error('Number pairing error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/devices - List all paired devices
 */
router.get('/devices', async (req, res) => {
    try {
        const devices = [];
        const dirs = await fs.readdir(devicesDir);
        
        for (const dir of dirs) {
            const infoPath = path.join(devicesDir, dir, 'info.json');
            if (await fs.pathExists(infoPath)) {
                const info = await fs.readJSON(infoPath);
                devices.push(info);
            }
        }
        
        res.json({ devices, total: devices.length });
    } catch (err) {
        console.error('Devices list error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/devices/:deviceId - Remove a paired device
 */
router.delete('/devices/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const deviceDir = path.join(devicesDir, deviceId);
        
        if (!await fs.pathExists(deviceDir)) {
            return res.status(404).json({ error: 'Device not found' });
        }
        
        await fs.remove(deviceDir);
        res.json({ message: 'Device removed' });
    } catch (err) {
        console.error('Device deletion error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

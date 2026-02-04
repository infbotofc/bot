const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const QRCode = require('qrcode');
const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const router = express.Router();

async function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        await fs.remove(filePath);
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

router.get('/', async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;
    if (!fs.existsSync('./qr_sessions')) await fs.mkdir('./qr_sessions', { recursive: true });

    async function initiateSession() {
        if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();
            let qrGenerated = false;
            let responseSent = false;

            let sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                browser: Browsers.windows('Chrome'),
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
                },
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            const handleQRCode = async (qr) => {
                if (qrGenerated || responseSent) return;
                qrGenerated = true;

                try {
                    const qrDataURL = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M' });
                    if (!responseSent) {
                        responseSent = true;
                        res.send({
                            qr: qrDataURL,
                            message: 'QR Code Generated! Scan with WhatsApp app.',
                            instructions: [
                                '1. Open WhatsApp on your phone',
                                '2. Go to Settings > Linked Devices',
                                '3. Tap "Link a Device"',
                                '4. Scan the QR code above'
                            ],
                            sessionId: sessionId
                        });
                    }
                } catch (err) {
                    console.error('Error generating QR code:', err);
                    if (!responseSent) res.status(500).send({ error: 'Failed to generate QR code' });
                }
            };

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr && !qrGenerated) await handleQRCode(qr);

                if (connection === 'open') {
                    try {
                        const credsFile = dirs + '/creds.json';
                        if (fs.existsSync(credsFile)) {
                            // Copy entire session folder to bot's main session folder
                            const mainSessionPath = './session';
                            if (!fs.existsSync(mainSessionPath)) fs.mkdirSync(mainSessionPath, { recursive: true });
                            
                            // Copy all files from temp session to main session
                            const files = fs.readdirSync(dirs);
                            for (const file of files) {
                                const src = `${dirs}/${file}`;
                                const dst = `${mainSessionPath}/${file}`;
                                fs.copySync(src, dst, { overwrite: true });
                            }
                            
                            console.log('✅ Session paired successfully and saved to ./session:', sessionId);
                            // Keep temp session for 30 seconds then cleanup
                            setTimeout(() => removeFile(dirs), 30000);
                        }
                    } catch (err) {
                        console.error('Error handling paired session:', err);
                        await removeFile(dirs);
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === 401) {
                        console.log('Credentials invalid, cleaning up');
                        removeFile(dirs);
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            setTimeout(() => {
                if (!responseSent) {
                    res.status(408).send({ error: 'QR generation timeout' });
                    removeFile(dirs);
                }
            }, 30000);

        } catch (err) {
            console.error('Error initializing QR session:', err);
            if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable: ' + err.message });
            await removeFile(dirs);
        }
    }

    await initiateSession();
});

module.exports = router;

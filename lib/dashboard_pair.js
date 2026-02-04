const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const pn = require('awesome-phonenumber');
const { exec } = require('child_process');
const {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const router = express.Router();

async function removeFile(p) {
    if (fs.existsSync(p)) await fs.remove(p);
}

router.get('/', async (req, res) => {
    let num = req.query.number || '';
    const dirs = './auth_info_baileys';

    try {
        await removeFile(dirs);

        num = (num || '').replace(/[^0-9]/g, '');
        const phone = pn('+' + num);

        if (!phone.isValid()) {
            return res.status(400).send({ code: 'Invalid phone number. Use full international format without + or spaces.' });
        }

        num = phone.getNumber('e164').replace('+', '');

        async function runSession() {
            try {
                const { state, saveCreds } = await useMultiFileAuthState(dirs);
                const { version } = await fetchLatestBaileysVersion();

                const sock = makeWASocket({
                    version,
                    auth: { 
                        creds: state.creds, 
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })) 
                    },
                    printQRInTerminal: false,
                    logger: pino({ level: 'fatal' }),
                    browser: Browsers.windows('Chrome'),
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 250,
                    maxRetries: 5,
                });

                let codeSent = false;

                sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                    if (connection === 'open') {
                        try {
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
                            
                            console.log('✅ Phone pairing successful! Session saved to ./session');
                            if (!res.headersSent) res.send({ code: 'Pairing successful! Restart the bot to connect.' });
                            await delay(1000);
                            await removeFile(dirs);
                        } catch (err) {
                            console.error('Error saving paired session:', err);
                            if (!res.headersSent) res.status(500).send({ code: 'Error saving session: ' + err.message });
                            await removeFile(dirs);
                        }
                    }
                    
                    if (connection === 'close') {
                        const code = lastDisconnect?.error?.output?.statusCode;
                        if (code === 401) {
                            console.log('Pairing failed - invalid credentials');
                            await removeFile(dirs);
                        }
                    }
                });

                if (!sock.authState.creds.registered) {
                    await delay(1500);
                    try {
                        let code = await sock.requestPairingCode(num);
                        code = code?.match(/.{1,4}/g)?.join('-') || code;
                        if (!res.headersSent && !codeSent) {
                            codeSent = true;
                            res.send({ code });
                            console.log('✅ Pairing code sent for:', num);
                            // Keep session alive for 5 minutes
                            setTimeout(() => removeFile(dirs), 300000);
                        }
                    } catch (err) {
                        if (!res.headersSent) res.status(503).send({ code: 'Failed to get pairing code: ' + err.message });
                    }
                }

                sock.ev.on('creds.update', saveCreds);

            } catch (err) {
                console.error('Fatal pairing error:', err.message);
                await removeFile(dirs);
                if (!res.headersSent) res.status(503).send({ code: 'Service Unavailable: ' + err.message });
            }
        }

        await runSession();

    } catch (err) {
        console.error('Pairing endpoint error:', err.message);
        if (!res.headersSent) res.status(500).send({ code: 'Error: ' + err.message });
    }
});

module.exports = router;

const express = require('express');
const { createServer } = require('http');
const packageInfo = require('../package.json');

const app = express();
const path = require('path');
const server = createServer(app);
const PORT = process.env.PORT || 5000;

app.get('/status', (req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeString = `${hours}h ${minutes}m ${seconds}s`;

    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${packageInfo.name.toUpperCase()} Status</title>
        <style>
            :root { --primary: #25d366; --bg: #0f172a; --card-bg: rgba(30, 41, 59, 0.7); }
            body { 
                margin: 0; padding: 0; background: var(--bg); color: white; 
                font-family: 'Inter', system-ui, sans-serif;
                display: flex; justify-content: center; align-items: center; min-height: 100vh;
            }
            .container {
                background: var(--card-bg); backdrop-filter: blur(12px);
                border: 1px solid rgba(255,255,255,0.1); padding: 30px;
                border-radius: 24px; width: 90%; max-width: 400px; text-align: center;
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
            }
            .status-badge {
                display: inline-flex; align-items: center; background: rgba(37, 211, 102, 0.1);
                color: var(--primary); padding: 5px 15px; border-radius: 50px;
                font-size: 0.8rem; font-weight: bold; margin-bottom: 20px;
            }
            .dot { height: 8px; width: 8px; background: var(--primary); border-radius: 50%; margin-right: 8px; box-shadow: 0 0 10px var(--primary); }
            h1 { margin: 0; font-size: 1.8rem; letter-spacing: 1px; }
            .desc { color: #94a3b8; margin: 10px 0 25px 0; font-size: 0.9rem; }
            .grid { display: grid; gap: 12px; }
            .item { 
                background: rgba(0,0,0,0.2); padding: 12px 18px; border-radius: 12px;
                display: flex; justify-content: space-between; align-items: center;
            }
            .label { color: #64748b; font-size: 0.75rem; text-transform: uppercase; font-weight: 800; }
            .val { font-weight: 600; font-family: monospace; color: #f1f5f9; }
            footer { margin-top: 25px; font-size: 0.7rem; color: #475569; letter-spacing: 1px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="status-badge"><span class="dot"></span> SYSTEM ONLINE</div>
            <h1>${packageInfo.name.toUpperCase()}</h1>
            <p class="desc">${packageInfo.description}</p>
            
            <div class="grid">
                <div class="item"><span class="label">Version</span><span class="val">${packageInfo.version}</span></div>
                <div class="item"><span class="label">Author</span><span class="val">${packageInfo.author}</span></div>
                <div class="item"><span class="label">Uptime</span><span class="val">${uptimeString}</span></div>
            </div>

            <footer>POWERED BY INFINITY MD</footer>
        </div>
    </body>
    </html>
    `);
});

// Serve new multi-device dashboard at root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'dashboard', 'multi-device.html')));

app.use(express.json());

// Serve new lightweight multidevice dashboard
const newDashboardPath = path.join(__dirname, '..', 'dashboard');
app.use('/dashboard', express.static(newDashboardPath));
app.get('/dashboard', (req, res) => res.sendFile(path.join(newDashboardPath, 'multidevice.html')));

// Mount new multidevice API
try {
    const multiDevice = require('./multidevice');
    app.use('/api/multidevice', multiDevice);
} catch (e) {
    console.warn('New multidevice API not mounted:', e.message);
}

// Simple per-device settings storage for dashboard
const fs = require('fs');
const devicesFile = path.join(__dirname, '..', 'data', 'paired_devices.json');
if (!fs.existsSync(path.join(__dirname, '..', 'data'))) fs.mkdirSync(path.join(__dirname, '..', 'data'));
if (!fs.existsSync(devicesFile)) fs.writeFileSync(devicesFile, JSON.stringify({}));

function readDevices() {
    try { return JSON.parse(fs.readFileSync(devicesFile, 'utf8') || '{}'); } catch (e) { return {}; }
}
function writeDevices(obj) { fs.writeFileSync(devicesFile, JSON.stringify(obj, null, 2)); }

app.get('/dashboard/api/devices', (req, res) => {
    const devices = readDevices();
    res.json(devices);
});

app.post('/dashboard/api/devices', (req, res) => {
    const { id, name, settings } = req.body || {};
    const devices = readDevices();
    const deviceId = id || (Date.now().toString() + Math.random().toString(36).slice(2,8));
    devices[deviceId] = { id: deviceId, name: name || `Device-${deviceId}`, settings: settings || {} };
    writeDevices(devices);
    res.status(201).json(devices[deviceId]);
});

app.put('/dashboard/api/devices/:id', (req, res) => {
    const { id } = req.params;
    const { name, settings } = req.body || {};
    const devices = readDevices();
    if (!devices[id]) return res.status(404).json({ error: 'Not found' });
    if (name) devices[id].name = name;
    if (settings) devices[id].settings = settings;
    writeDevices(devices);
    res.json(devices[id]);
});

app.delete('/dashboard/api/devices/:id', (req, res) => {
    const { id } = req.params;
    const devices = readDevices();
    if (!devices[id]) return res.status(404).json({ error: 'Not found' });
    delete devices[id];
    writeDevices(devices);
    res.json({ status: 'deleted' });
});

// Admin endpoint to reset main session (requires ADMIN_TOKEN env var)
app.post('/dashboard/api/reset-session', (req, res) => {
    const token = process.env.ADMIN_TOKEN || '';
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token && token.length > 0 && auth !== token) return res.status(401).json({ error: 'Unauthorized' });

    const fs = require('fs');
    const path = require('path');
    const sessionPath = path.join(__dirname, '..', 'session');
    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        return res.json({ status: 'session_reset' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/process', (req, res) => {
    const { send } = req.query;
    if (!send) return res.status(400).json({ error: 'Missing send query' });
    res.json({ status: 'Received', data: send });
});

app.get('/chat', (req, res) => {
    const { message, to } = req.query;
    if (!message || !to) return res.status(400).json({ error: 'Missing message or to query' });
    res.json({ status: 200, info: 'Message received (integration not implemented)' });
});

module.exports = { app, server, PORT };


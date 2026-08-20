import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

let sock = null;
let qrBase64 = null;
let connectionStatus = 'disconnected';
let connectedPhone = null;
const logger = pino({ level: 'silent' });
const AUTH_DIR = path.join(__dirname, '.wa_session');

async function startWhatsApp() {
  try {
    connectionStatus = 'connecting';
    qrBase64 = null;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, logger, browser: Browsers.ubuntu('MenuZaps'), auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrBase64 = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', width: 320, margin: 2, color: { dark: '#111827', light: '#ffffff' } });
        connectionStatus = 'qr_ready';
        console.log('QR Code gerado');
      }
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected'; connectedPhone = null; qrBase64 = null;
        if (shouldReconnect) setTimeout(() => startWhatsApp(), 3000);
        else if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      if (connection === 'open') {
        connectionStatus = 'connected'; qrBase64 = null;
        connectedPhone = sock.user?.id?.split(':')[0] || null;
        console.log('WhatsApp conectado:', connectedPhone);
      }
    });
    sock.ev.on('messages.upsert', () => {});
  } catch (err) { console.error('Erro:', err); connectionStatus = 'disconnected'; }
}

function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  const full = digits.startsWith('55') ? digits : '55' + digits;
  return full + '@s.whatsapp.net';
}

app.get('/api/wa/status', (req, res) => res.json({ status: connectionStatus, phone: connectedPhone, hasQR: !!qrBase64 }));
app.get('/api/wa/qr', (req, res) => { if (!qrBase64) return res.status(404).json({ error: 'QR nao disponivel' }); res.json({ qr: qrBase64 }); });
app.post('/api/wa/send', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) return res.status(503).json({ error: 'WhatsApp nao conectado' });
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Campos to e message sao obrigatorios' });
  try { await sock.sendMessage(formatPhone(to), { text: message }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/wa/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'disconnected'; connectedPhone = null; qrBase64 = null;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/wa/restart', async (req, res) => {
  try {
    if (sock) { sock.end(undefined); sock = null; }
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'disconnected'; connectedPhone = null; qrBase64 = null;
    setTimeout(() => startWhatsApp(), 500);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Keep-alive ping endpoint ───────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), status: connectionStatus }));
app.get('/', (req, res) => res.json({ service: 'MenuZaps WA Server', status: connectionStatus, phone: connectedPhone }));

app.listen(PORT, () => {
  console.log('MenuZaps WA Server na porta ' + PORT);
  startWhatsApp();

  // ── Self-ping a cada 10 minutos para não dormir no Render ─────
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const { default: https } = await import(SELF_URL.startsWith('https') ? 'https' : 'http');
      https.get(`${SELF_URL}/ping`, (r) => {
        console.log(`Keep-alive ping → ${r.statusCode} | WA: ${connectionStatus}`);
      }).on('error', () => {});
    } catch {}
  }, 10 * 60 * 1000); // 10 minutos
});


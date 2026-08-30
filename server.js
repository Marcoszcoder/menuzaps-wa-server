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

let isStarting = false;
async function startWhatsApp() {
  if (isStarting) return;
  isStarting = true;
  try {
    if (typeof sock !== 'undefined' && sock) {
      sock.ev.removeAllListeners();
      try { sock.end(undefined); } catch(e) {}
    }
    
    connectionStatus = 'connecting';
    qrBase64 = null;
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({ 
      version, 
      logger, 
      browser: Browsers.macOS('Desktop'),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) }, 
      printQRInTerminal: false, 
      syncFullHistory: false, 
      markOnlineOnConnect: true, keepAliveIntervalMs: 30000
    });
    
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
        
        console.log('Conexão fechada. Status code:', statusCode, 'Reconnect:', shouldReconnect);
        
        connectionStatus = 'disconnected'; 
        if (!shouldReconnect) connectedPhone = null; 
        qrBase64 = null;
        
        if (shouldReconnect) {
          setTimeout(() => { startWhatsApp(); }, statusCode === 515 ? 1000 : 3000);
        } else {
          if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
      }
      
      if (connection === 'open') {
        connectionStatus = 'connected'; 
        qrBase64 = null;
        connectedPhone = sock.user?.id?.split(':')[0] || null;
        console.log('WhatsApp conectado:', connectedPhone);
      }
    });
    
    sock.ev.on('messages.upsert', () => {});
  } catch (err) { 
    console.error('Erro:', err); 
    connectionStatus = 'disconnected'; 
  } finally {
    isStarting = false;
  }
}

// Tenta formatos brasileiros: com e sem o 9° dígito
function buildJids(raw) {
  const digits = raw.replace(/\D/g, '');
  // Garantir country code 55
  const withCC = digits.startsWith('55') ? digits : '55' + digits;
  const jids = [withCC + '@s.whatsapp.net'];
  
  // Brasil: DDD (2) + número
  // Se tem 12 dígitos (55 + DDD + 8 dígitos), adicionar versão com 9
  if (withCC.length === 12) {
    const com9 = withCC.slice(0, 4) + '9' + withCC.slice(4);
    jids.unshift(com9 + '@s.whatsapp.net'); // tenta primeiro o com 9
  }
  // Se tem 13 dígitos (55 + DDD + 9 dígitos), também tenta sem o 9
  if (withCC.length === 13) {
    const sem9 = withCC.slice(0, 4) + withCC.slice(5);
    jids.push(sem9 + '@s.whatsapp.net');
  }
  return jids;
}

app.get('/api/wa/status', (req, res) => res.json({ status: connectionStatus, phone: connectedPhone, hasQR: !!qrBase64 }));
app.get('/api/wa/qr', (req, res) => { if (!qrBase64) return res.status(404).json({ error: 'QR nao disponivel' }); res.json({ qr: qrBase64 }); });
app.post('/api/wa/send', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) return res.status(503).json({ error: 'WhatsApp nao conectado' });
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Campos to e message sao obrigatorios' });
  try {
    const jids = buildJids(to);
    let sentTo = null;
    
    // Tentar cada formato de JID
    for (const jid of jids) {
      try {
        // Verificar se o numero existe no WhatsApp
        const [result] = await sock.onWhatsApp(jid);
        if (result?.exists) {
          await sock.sendMessage(result.jid, { text: message });
          sentTo = result.jid;
          break;
        }
      } catch { /* tentar próximo formato */ }
    }
    
    if (sentTo) {
      res.json({ ok: true, sentTo });
    } else {
      // Número não encontrado — enviar assim mesmo no primeiro formato
      await sock.sendMessage(jids[0], { text: message });
      res.json({ ok: true, sentTo: jids[0], warn: 'Numero nao verificado no WhatsApp' });
    }
  }
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

// ═══════════════════════════════════════════════════════════════
// ——— ABACATEPAY & FINANCE MANAGEMENT ———
// ═══════════════════════════════════════════════════════════════
const ABACATEPAY_API_KEY = process.env.ABACATEPAY_API_KEY || 'abc_prod_YAA2SUwQbqgBBTBxTSzr1CJU';
const ABACATEPAY_WEBHOOK_SECRET = process.env.ABACATEPAY_WEBHOOK_SECRET || 'webh_prod_GxjhThqfPrP1ZJ54frXeGaXs';
const VALID_WEBHOOK_SECRETS = ['webh_prod_GxjhThqfPrP1ZJ54frXeGaXs', 'mz_whsec_99762785abacate'];

const PAYMENTS_FILE = path.join(__dirname, '.payments_data.json');

function loadPaymentsData() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    balance: 0,
    totalSales: 0,
    transactions: [],
    withdrawals: []
  };
}

function savePaymentsData(data) {
  try {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) {
    console.error('Erro ao salvar dados de pagamento:', e);
  }
}

const SEC_LOGS_FILE = path.join(__dirname, '.security_logs.json');

function loadSecurityLogs() {
  try {
    if (fs.existsSync(SEC_LOGS_FILE)) {
      return JSON.parse(fs.readFileSync(SEC_LOGS_FILE, 'utf8'));
    }
  } catch(e) {}
  return [];
}

function saveSecurityLogs(logs) {
  try {
    fs.writeFileSync(SEC_LOGS_FILE, JSON.stringify(logs.slice(0, 300), null, 2), 'utf8');
  } catch(e) {
    console.error('Erro ao salvar logs de segurança:', e);
  }
}

function logSecurityEvent(type, severity, description, req = null) {
  try {
    const logs = loadSecurityLogs();
    
    // Obter IP real atrás do proxy do Render/Cloudflare
    let ip = '0.0.0.0';
    let userAgent = 'Desconhecido';
    if (req) {
      ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
      if (ip.includes(',')) ip = ip.split(',')[0].trim();
      userAgent = req.headers['user-agent'] || 'Desconhecido';
    }

    const newLog = {
      timestamp: new Date().toISOString(),
      type, // 'failed_login', 'unauthorized_payout', 'webhook_hack', etc
      severity, // 'INFO', 'WARN', 'CRITICAL'
      description,
      ip,
      userAgent
    };

    logs.unshift(newLog);
    saveSecurityLogs(logs);
    console.log(`[SECURITY ${severity}] ${type}: ${description} (IP: ${ip})`);
  } catch(e) {
    console.error('Erro ao registrar log de segurança:', e);
  }
}

// Endpoints de logs de segurança
app.get('/api/admin/security-logs', (req, res) => {
  try {
    res.json({ ok: true, logs: loadSecurityLogs() });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/log-security', (req, res) => {
  try {
    const { type, severity, description } = req.body;
    logSecurityEvent(type, severity, description, req);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 1. Criar Cobrança Pix AbacatePay ──────────────────────────
app.post('/api/payment/create-pix', async (req, res) => {
  try {
    const { orderId, amount, clientName, clientPhone, clientEmail, itemsDescription, storeSlug, restaurant } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valor inválido' });
    }

    const priceInCents = Math.round(Number(amount) * 100);
    const orderNum = orderId || Math.floor(1000 + Math.random() * 9000);

    // 1. Criar produto dinâmico para a cobrança
    const prodRes = await fetch('https://api.abacatepay.com/v2/products/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ABACATEPAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        externalId: `order_${orderNum}_${Date.now()}`,
        name: `Pedido MenuZaps #${orderNum}`,
        description: itemsDescription || `Pedido #${orderNum} - ${clientName || 'Cliente'}`,
        price: priceInCents,
        currency: 'BRL'
      })
    });

    const prodData = await prodRes.json();
    if (!prodData.success || !prodData.data?.id) {
      return res.status(500).json({ ok: false, error: prodData.error || 'Falha ao criar produto na AbacatePay' });
    }

    const productId = prodData.data.id;

    // 2. Criar checkout Pix
    const checkRes = await fetch('https://api.abacatepay.com/v2/checkouts/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ABACATEPAY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        frequency: 'ONE_TIME',
        methods: ['PIX'],
        items: [
          {
            id: productId,
            quantity: 1
          }
        ],
        customer: {
          name: clientName || 'Cliente MenuZaps',
          cellphone: clientPhone ? clientPhone.replace(/\D/g, '') : '66999762785',
          email: clientEmail || 'cliente@menuzaps.com'
        },
        returnUrl: 'https://menuzaps.vercel.app/cardapio.html?payment=success',
        completionUrl: 'https://menuzaps.vercel.app/cardapio.html?payment=success'
      })
    });

    const checkData = await checkRes.json();
    if (!checkData.success || !checkData.data?.url) {
      return res.status(500).json({ ok: false, error: checkData.error || 'Falha ao gerar checkout Pix' });
    }

    const billing = checkData.data;

    // Registrar transação pendente no storage
    const db = loadPaymentsData();
    const newTx = {
      billingId: billing.id,
      orderId: orderNum,
      clientName: clientName || 'Cliente',
      clientPhone: clientPhone || '',
      grossAmount: Number(amount),
      fee: (billing.platformFee || 100) / 100,
      netAmount: Math.max(0, Number(amount) - ((billing.platformFee || 100) / 100)),
      paymentUrl: billing.url,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      storeSlug: storeSlug || 'pizzaria-bella-napoli',
      restaurant: restaurant || 'Pizzaria Bella Napoli'
    };
    db.transactions.unshift(newTx);
    savePaymentsData(db);

    res.json({
      ok: true,
      billingId: billing.id,
      paymentUrl: billing.url,
      orderId: orderNum,
      amount: Number(amount)
    });
  } catch (err) {
    console.error('Erro create-pix:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 2. Checar Status de Cobrança ──────────────────────────────
app.get('/api/payment/status/:billingId', async (req, res) => {
  try {
    const { billingId } = req.params;
    const db = loadPaymentsData();
    const tx = db.transactions.find(t => t.billingId === billingId);

    // Consultar na AbacatePay
    const apiRes = await fetch(`https://api.abacatepay.com/v2/checkouts/list`, {
      headers: {
        'Authorization': `Bearer ${ABACATEPAY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    const apiData = await apiRes.json();
    const foundBill = apiData.data?.find(b => b.id === billingId);

    if (foundBill) {
      const isPaid = foundBill.status === 'PAID';
      if (tx && tx.status !== 'PAID' && isPaid) {
        tx.status = 'PAID';
        tx.paidAt = new Date().toISOString();
        db.balance += tx.netAmount;
        db.totalSales += tx.grossAmount;
        savePaymentsData(db);
      }
      return res.json({ ok: true, status: foundBill.status, isPaid, tx });
    }

    res.json({ ok: true, status: tx?.status || 'PENDING', isPaid: tx?.status === 'PAID', tx });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 3. Webhook de Confirmação AbacatePay ───────────────────────
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const secretQuery = req.query.secret;
    const secretHeader = req.headers['abacatepay-signature'] || req.headers['x-webhook-secret'] || req.headers['webhook-id'];

    // Validação de Secret
    const isSecretValid = !secretQuery || VALID_WEBHOOK_SECRETS.includes(secretQuery) || (secretHeader && VALID_WEBHOOK_SECRETS.includes(secretHeader));
    if (!isSecretValid) {
      logSecurityEvent('webhook_hack', 'CRITICAL', `Tentativa de simulação de webhook com assinatura/secret inválido (Query: "${secretQuery}", Header: "${secretHeader}")`, req);
      return res.status(403).json({ error: 'Assinatura inválida' });
    }

    const payload = req.body;
    console.log('Webhook AbacatePay recebido:', JSON.stringify(payload));

    const event = payload.event || payload.type;
    const data = payload.data || payload;

    if (event === 'billing.paid' || data.status === 'PAID' || event === 'BILLING_PAID') {
      const billingId = data.id;
      const db = loadPaymentsData();
      const tx = db.transactions.find(t => t.billingId === billingId);

      if (tx && tx.status !== 'PAID') {
        tx.status = 'PAID';
        tx.paidAt = new Date().toISOString();
        db.balance += tx.netAmount;
        db.totalSales += tx.grossAmount;
        savePaymentsData(db);

        logSecurityEvent('pix_received', 'INFO', `Pix confirmado: R$ ${tx.grossAmount.toFixed(2)} (Líquido: R$ ${tx.netAmount.toFixed(2)}) | Cliente: ${tx.clientName} (Pedido #${tx.orderId})`, req);

        // Notificar restaurante via WhatsApp se conectado
        if (connectionStatus === 'connected' && sock && connectedPhone) {
          try {
            const jids = buildJids(connectedPhone);
            await sock.sendMessage(jids[0], {
              text: `🟢 *PIX RECEBIDO COM SUCESSO!*\n\n` +
                    `📦 *Pedido:* #${tx.orderId}\n` +
                    `👤 *Cliente:* ${tx.clientName}\n` +
                    `💰 *Valor Bruto:* R$ ${tx.grossAmount.toFixed(2).replace('.', ',')}\n` +
                    `💵 *Valor Líquido:* R$ ${tx.netAmount.toFixed(2).replace('.', ',')}\n` +
                    `✨ O saldo já está disponível no seu painel!`
            });
          } catch(e) {
            console.error('Erro ao notificar via WA:', e);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. Resumo Financeiro & Saldo ──────────────────────────────
app.get('/api/payment/finance-summary', (req, res) => {
  try {
    const db = loadPaymentsData();
    const today = new Date().toISOString().slice(0, 10);
    const { store } = req.query;

    let transactions = db.transactions || [];
    let withdrawals = db.withdrawals || [];

    if (store) {
      transactions = transactions.filter(t => (t.storeSlug && t.storeSlug === store) || (t.restaurant && t.restaurant.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === store));
      withdrawals = withdrawals.filter(w => (w.storeSlug && w.storeSlug === store) || (w.storeName && w.storeName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === store));
    }

    const paidTxs = transactions.filter(t => t.status === 'PAID');
    const completedWds = withdrawals.filter(w => w.status === 'COMPLETED');

    const totalSales = paidTxs.reduce((sum, t) => sum + Number(t.grossAmount || 0), 0);
    const totalNet = paidTxs.reduce((sum, t) => sum + Number(t.netAmount || 0), 0);
    const todaySales = paidTxs.filter(t => t.createdAt && t.createdAt.startsWith(today)).reduce((sum, t) => sum + Number(t.grossAmount || 0), 0);
    const totalWithdrawn = completedWds.reduce((sum, w) => sum + Number(w.amount || 0), 0);
    
    // Se for solicitado por uma loja especifica, o saldo é o líquido daquela loja menos os saques concluídos daquela loja
    const balance = store ? Math.max(0, totalNet - totalWithdrawn) : Math.max(0, db.balance);

    res.json({
      ok: true,
      balance: balance,
      totalSales: totalSales,
      todaySales: todaySales,
      totalWithdrawn: totalWithdrawn,
      transactions: transactions.slice(0, 50),
      withdrawals: withdrawals.slice(0, 20)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 5. Solicitar Saque Pix ────────────────────────────────────
app.post('/api/payment/request-withdrawal', (req, res) => {
  try {
    const { amount, pixKey, pixKeyType, storeSlug, storeName, ownerEmail, ownerPhone } = req.body;
    const withdrawAmount = Number(amount);
    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valor de saque inválido' });
    }
    if (!pixKey) {
      return res.status(400).json({ ok: false, error: 'Chave Pix é obrigatória' });
    }

    const db = loadPaymentsData();
    
    // Calcular saldo disponível para esta loja específica se for enviado o slug
    let storeBalance = db.balance;
    if (storeSlug) {
      const txs = db.transactions.filter(t => t.storeSlug === storeSlug && t.status === 'PAID');
      const wds = db.withdrawals.filter(w => w.storeSlug === storeSlug && w.status === 'COMPLETED');
      const totalNet = txs.reduce((acc, t) => acc + t.netAmount, 0);
      const totalWithdrawn = wds.reduce((acc, w) => acc + w.amount, 0);
      storeBalance = totalNet - totalWithdrawn;
    }

    if (storeBalance < withdrawAmount) {
      return res.status(400).json({ ok: false, error: `Saldo insuficiente. Saldo disponível para saque: R$ ${storeBalance.toFixed(2).replace('.', ',')}` });
    }

    db.balance -= withdrawAmount;
    const newWithdrawal = {
      id: 'wd_' + Date.now(),
      amount: withdrawAmount,
      pixKey: pixKey,
      pixKeyType: pixKeyType || 'CPF/CNPJ',
      status: 'COMPLETED',
      requestedAt: new Date().toISOString(),
      storeSlug: storeSlug || 'pizzaria-bella-napoli',
      storeName: storeName || 'Pizzaria Bella Napoli',
      ownerEmail: ownerEmail || '',
      ownerPhone: ownerPhone || ''
    };
    db.withdrawals.unshift(newWithdrawal);
    savePaymentsData(db);

    logSecurityEvent('withdrawal_requested', 'WARN', `Saque Pix solicitado: R$ ${withdrawAmount.toFixed(2)} | Loja: ${newWithdrawal.storeName} (${storeSlug}) | Chave: "${pixKey}"`, req);

    res.json({
      ok: true,
      message: `Saque de R$ ${withdrawAmount.toFixed(2).replace('.', ',')} solicitado para a chave ${pixKey}!`,
      newBalance: db.balance,
      withdrawal: newWithdrawal
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 6. Simular Venda Pix (Para testes rápidos do dono) ─────────
app.post('/api/payment/simulate-pix', (req, res) => {
  try {
    const { orderId, amount, clientName, storeSlug } = req.body;
    const val = Number(amount) || 32.90;
    const orderNum = orderId || Math.floor(1000 + Math.random() * 9000);
    const fee = 0.80;
    const net = Math.max(0, val - fee);

    const db = loadPaymentsData();
    const newTx = {
      billingId: 'sim_' + Date.now(),
      orderId: orderNum,
      clientName: clientName || 'Cliente Simulação',
      clientPhone: '66999762785',
      grossAmount: val,
      fee: fee,
      netAmount: net,
      paymentUrl: '#',
      status: 'PAID',
      createdAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      storeSlug: storeSlug || 'pizzaria-bella-napoli',
      restaurant: storeSlug === 'hamburgeria-do-chef' ? 'Hamburgeria do Chef' : 'Pizzaria Bella Napoli'
    };
    db.transactions.unshift(newTx);
    db.balance += net;
    db.totalSales += val;
    savePaymentsData(db);

    res.json({
      ok: true,
      message: `Pix simulado de R$ ${val.toFixed(2).replace('.', ',')} creditado com sucesso!`,
      newBalance: db.balance,
      tx: newTx
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Keep-alive ping endpoint ───────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString(), status: connectionStatus }));
app.get('/', (req, res) => res.json({
  service: 'MenuZaps WA & Payments Server',
  status: connectionStatus,
  phone: connectedPhone,
  abacatePay: 'Active (v2)'
}));

app.listen(PORT, () => {
  console.log('MenuZaps Server na porta ' + PORT);
  startWhatsApp();

  // Self-ping a cada 10 minutos para não dormir no Render
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      const { default: https } = await import(SELF_URL.startsWith('https') ? 'https' : 'http');
      https.get(`${SELF_URL}/ping`, (r) => {
        console.log(`Keep-alive ping → ${r.statusCode} | WA: ${connectionStatus}`);
      }).on('error', () => {});
    } catch {}
  }, 10 * 60 * 1000);
});



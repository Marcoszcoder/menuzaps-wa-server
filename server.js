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

// ── 1. Criar Cobrança Pix AbacatePay ──────────────────────────
app.post('/api/payment/create-pix', async (req, res) => {
  try {
    const { orderId, amount, clientName, clientPhone, clientEmail, itemsDescription } = req.body;
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
      createdAt: new Date().toISOString()
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
      console.warn('Webhook recebido com secret não reconhecido:', secretQuery || secretHeader);
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
    const todaySales = db.transactions
      .filter(t => t.status === 'PAID' && t.createdAt.startsWith(today))
      .reduce((acc, t) => acc + t.grossAmount, 0);

    const totalWithdrawn = db.withdrawals
      .filter(w => w.status === 'COMPLETED')
      .reduce((acc, w) => acc + w.amount, 0);

    res.json({
      ok: true,
      balance: Math.max(0, db.balance),
      totalSales: db.totalSales,
      todaySales: todaySales,
      totalWithdrawn: totalWithdrawn,
      transactions: db.transactions.slice(0, 50),
      withdrawals: db.withdrawals.slice(0, 20)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 5. Solicitar Saque Pix ────────────────────────────────────
app.post('/api/payment/request-withdrawal', (req, res) => {
  try {
    const { amount, pixKey, pixKeyType } = req.body;
    const withdrawAmount = Number(amount);
    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Valor de saque inválido' });
    }
    if (!pixKey) {
      return res.status(400).json({ ok: false, error: 'Chave Pix é obrigatória' });
    }

    const db = loadPaymentsData();
    if (db.balance < withdrawAmount) {
      return res.status(400).json({ ok: false, error: `Saldo insuficiente. Saldo disponível: R$ ${db.balance.toFixed(2).replace('.', ',')}` });
    }

    db.balance -= withdrawAmount;
    const newWithdrawal = {
      id: 'wd_' + Date.now(),
      amount: withdrawAmount,
      pixKey: pixKey,
      pixKeyType: pixKeyType || 'CPF/CNPJ',
      status: 'COMPLETED',
      requestedAt: new Date().toISOString()
    };
    db.withdrawals.unshift(newWithdrawal);
    savePaymentsData(db);

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
    const { orderId, amount, clientName } = req.body;
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
      paidAt: new Date().toISOString()
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


// ── 7. Criar Pedido Balcão/Entrega (Dinheiro ou Cartão na Entrega) ──
app.post('/api/orders/create', (req, res) => {
  try {
    const { clientName, clientPhone, address, deliveryType, notes, items, amount, paymentMethod, restaurant } = req.body;
    const orderNum = Math.floor(1000 + Math.random() * 9000);
    const db = loadPaymentsData();
    if (!db.orders) db.orders = [];

    const newOrder = {
      id: orderNum,
      client: clientName || 'Cliente',
      phone: clientPhone || '',
      addr: address || '',
      type: deliveryType || 'delivery',
      items: items || 'Itens do Cardápio',
      notes: notes || '',
      value: Number(amount) || 0,
      payment: paymentMethod || 'Dinheiro / Cartão na Entrega',
      restaurant: restaurant || 'Estabelecimento',
      status: 'new', // Dinheiro/Cartão entra direto para a cozinha
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      ago: 'agora',
      createdAt: new Date().toISOString()
    };

    db.orders.unshift(newOrder);
    savePaymentsData(db);

    // Notificar WhatsApp se conectado
    if (connectionStatus === 'connected' && sock && connectedPhone) {
      try {
        const jids = buildJids(connectedPhone);
        sock.sendMessage(jids[0], {
          text: `🔔 *NOVO PEDIDO RECEBIDO!*\n\n` +
                `📦 *Pedido:* #${newOrder.id}\n` +
                `👤 *Cliente:* ${newOrder.client}\n` +
                `📱 *Telefone:* ${newOrder.phone}\n` +
                `🛵 *Tipo:* ${newOrder.type === 'delivery' ? 'Entrega' : 'Retirada'}\n` +
                `📋 *Itens:*\n${newOrder.items}\n` +
                `💵 *Pagamento:* ${newOrder.payment}\n` +
                `💰 *Total:* R$ ${newOrder.value.toFixed(2).replace('.', ',')}`
        }).catch(() => {});
      } catch(e) {}
    }

    res.json({ ok: true, order: newOrder });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 8. Listar Pedidos Confirmados para a Central (Kanban) ──
app.get('/api/orders/live', (req, res) => {
  try {
    const db = loadPaymentsData();
    if (!db.orders) db.orders = [];
    // Retorna apenas pedidos confirmados (exclui os Pix pendentes de pagamento)
    const confirmedOrders = db.orders.filter(o => o.status !== 'pending_payment');
    res.json({ ok: true, orders: confirmedOrders.slice(0, 50) });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ── 9. Atualizar Etapa do Pedido e Notificar Cliente no WhatsApp ──
app.post('/api/orders/update-status', async (req, res) => {
  try {
    const { orderId, newStatus, clientPhone, clientName, deliveryType, address } = req.body;
    const db = loadPaymentsData();
    if (!db.orders) db.orders = [];

    const order = db.orders.find(o => o.id === parseInt(orderId));
    if (order) {
      order.status = newStatus;
      savePaymentsData(db);
    }

    const phone = clientPhone || order?.phone;
    const name = clientName || order?.client || 'Cliente';
    const type = deliveryType || order?.type || 'delivery';
    const addr = address || order?.addr || '';

    // Enviar mensagem automática correspondente à etapa
    if (connectionStatus === 'connected' && sock && phone) {
      try {
        const jids = buildJids(phone);
        let msg = '';

        if (newStatus === 'prep') {
          msg = `👨‍🍳 *Olá, ${name}! Seu pedido #${orderId} está EM PREPARAÇÃO!*\n\nNossos chefs já estão preparando tudo com muito capricho. Em breve sairá para entrega! ⏱️`;
        } else if (newStatus === 'ready') {
          if (type === 'delivery') {
            msg = `📦 *Olá, ${name}! Seu pedido #${orderId} está PRONTO e aguardando o entregador!*\n\nEm poucos minutos sairá para entrega no seu endereço.`;
          } else {
            msg = `🏪 *Oba, ${name}! Seu pedido #${orderId} está PRONTO PARA RETIRADA!*\n\nVocê já pode vir retirar no nosso balcão. Te esperamos! 🎉`;
          }
        } else if (newStatus === 'out') {
          msg = `🛵 *Oba, ${name}! Seu pedido #${orderId} SAIU PARA ENTREGA!*\n\nO entregador já está a caminho${addr ? ` de: *${addr}*` : ''}. Fique atento! 📦`;
        } else if (newStatus === 'done') {
          msg = `⭐ *Pedido #${orderId} ENTREGUE COM SUCESSO!*\n\nEsperamos que goste muito! Bom apetite e obrigado pela preferência. Volte sempre! 🎉`;
        }

        if (msg) {
          await sock.sendMessage(jids[0], { text: msg });
        }
      } catch(e) {
        console.error('Erro ao enviar notificação de etapa:', e);
      }
    }

    res.json({ ok: true, status: newStatus });
  } catch(err) {
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



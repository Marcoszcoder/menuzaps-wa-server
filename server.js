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
// ——— MERCADO PAGO & FINANCE MANAGEMENT ———
// ═══════════════════════════════════════════════════════════════
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-2207563349086564-082708-c96459588956e75d8b1def743ef226db-2247952099';
const MP_PUBLIC_KEY = process.env.NEXT_PUBLIC_MP_PUBLIC_KEY || 'APP_USR-22bf5c71-dac7-4300-ba28-2229a783ea01';
const MP_CLIENT_ID = process.env.MP_CLIENT_ID || '2207563349086564';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || 'yzwJniOnkcV7XaBQHak1z5A1680XlMbK';

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
    withdrawals: [],
    orders: []
  };
}

function savePaymentsData(data) {
  try {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch(e) {
    console.error('Erro ao salvar dados de pagamento:', e);
  }
}


// ── 0. Validar Access Token do Mercado Pago do Lojista ─────────
app.post('/api/payment/validate-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.trim().startsWith('APP_USR')) {
      return res.status(400).json({ ok: false, error: 'O Access Token de produção deve começar com "APP_USR-"' });
    }

    const mpRes = await fetch('https://api.mercadopago.com/users/me', {
      headers: { 'Authorization': `Bearer ${token.trim()}` }
    });
    const mpData = await mpRes.json();

    if (mpRes.ok && mpData.id) {
      const name = mpData.first_name ? `${mpData.first_name} ${mpData.last_name || ''}`.trim() : (mpData.nickname || 'Conta Mercado Pago');
      return res.json({
        ok: true,
        accountName: name,
        email: mpData.email || '',
        id: mpData.id
      });
    }

    return res.status(400).json({ ok: false, error: 'Access Token inválido ou não encontrado no Mercado Pago. Verifique suas credenciais de produção.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 1. Criar Cobrança Pix no Mercado Pago (Multi-Tenant / Split) ─
app.post('/api/payment/create-pix', async (req, res) => {
  try {
    const { orderId, amount, clientName, clientPhone, clientEmail, address, deliveryType, notes, items, restaurant, storeMpAccessToken } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'Valor inválido' });
    }

    const orderNum = orderId || Math.floor(1000 + Math.random() * 9000);
    const nameParts = (clientName || 'Cliente').trim().split(' ');
    const firstName = nameParts[0] || 'Cliente';
    const lastName = nameParts.slice(1).join(' ') || 'MenuZaps';
    const email = clientEmail || 'cliente@menuzaps.com';

    // Criar Pagamento Pix Oficial Mercado Pago
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${(storeMpAccessToken && storeMpAccessToken.startsWith('APP_USR')) ? storeMpAccessToken.trim() : MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `order_${orderNum}_${Date.now()}`
      },
      body: JSON.stringify({
        transaction_amount: Number(amount),
        description: `Pedido MenuZaps #${orderNum} - ${clientName || 'Cliente'}`,
        payment_method_id: 'pix',
        payer: {
          email: email,
          first_name: firstName,
          last_name: lastName
        },
        notification_url: 'https://menuzaps-wa-server.onrender.com/api/payment/webhook'
      })
    });

    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.id) {
      console.error('Erro Mercado Pago API:', mpData);
      return res.status(500).json({ ok: false, error: mpData.message || 'Falha ao gerar cobrança Pix no Mercado Pago' });
    }

    const paymentId = String(mpData.id);
    const txData = mpData.point_of_interaction?.transaction_data || {};
    const qrCode = txData.qr_code || '';
    const qrCodeBase64 = txData.qr_code_base64 || '';
    const ticketUrl = txData.ticket_url || '';

    const db = loadPaymentsData();
    if (!db.orders) db.orders = [];

    const newTx = {
      billingId: paymentId,
      orderId: orderNum,
      clientName: clientName || 'Cliente',
      clientPhone: clientPhone || '',
      grossAmount: Number(amount),
      fee: mpData.fee_details?.[0]?.amount || 0.99,
      netAmount: Math.max(0, Number(amount) - (mpData.fee_details?.[0]?.amount || 0.99)),
      qrCode: qrCode,
      qrCodeBase64: qrCodeBase64,
      paymentUrl: ticketUrl,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    db.transactions.unshift(newTx);

    const newOrder = {
      id: orderNum,
      billingId: paymentId,
      client: clientName || 'Cliente',
      phone: clientPhone || '',
      addr: address || '',
      type: deliveryType || 'delivery',
      items: items || 'Itens do Cardápio',
      notes: notes || '',
      value: Number(amount),
      payment: 'PIX (Mercado Pago)',
      pixUrl: ticketUrl,
      qrCode: qrCode,
      qrCodeBase64: qrCodeBase64,
      restaurant: restaurant || 'Estabelecimento',
      status: 'pending_payment',
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      ago: 'agora',
      createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    savePaymentsData(db);

    res.json({
      ok: true,
      billingId: paymentId,
      paymentId: paymentId,
      paymentUrl: ticketUrl,
      qrCode: qrCode,
      qrCodeBase64: qrCodeBase64,
      orderId: orderNum,
      amount: Number(amount)
    });
  } catch (err) {
    console.error('Erro create-pix:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 2. Checar Status de Cobrança Pix (Mercado Pago) ─────────────
app.get('/api/payment/status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const db = loadPaymentsData();
    const tx = db.transactions.find(t => String(t.billingId) === String(paymentId) || String(t.orderId) === String(paymentId));

    let isApproved = false;
    let mpStatus = 'pending';

    try {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const mpData = await mpRes.json();
      if (mpData && mpData.status) {
        mpStatus = mpData.status;
        isApproved = (mpData.status === 'approved');
      }
    } catch(e) {}

    if (isApproved) {
      if (tx && tx.status !== 'PAID') {
        tx.status = 'PAID';
        tx.paidAt = new Date().toISOString();
        db.balance += tx.netAmount;
        db.totalSales += tx.grossAmount;

        if (!db.orders) db.orders = [];
        const order = db.orders.find(o => String(o.billingId) === String(paymentId) || o.id === tx.orderId);
        if (order) {
          order.status = 'new';
          order.paid = true;
          order.paidAt = new Date().toISOString();
        }
        savePaymentsData(db);

        // Notificar restaurante e cliente via WhatsApp se conectado
        if (connectionStatus === 'connected' && sock) {
          if (connectedPhone) {
            try {
              const jids = buildJids(connectedPhone);
              await sock.sendMessage(jids[0], {
                text: `🟢 *PIX RECEBIDO (MERCADO PAGO)!*\n\n` +
                      `📦 *Pedido:* #${tx.orderId}\n` +
                      `👤 *Cliente:* ${tx.clientName}\n` +
                      `💰 *Valor:* R$ ${tx.grossAmount.toFixed(2).replace('.', ',')}\n` +
                      `✨ O pedido foi enviado para a cozinha!`
              });
            } catch(e) {}
          }
          if (tx.clientPhone) {
            try {
              const clientJids = buildJids(tx.clientPhone);
              await sock.sendMessage(clientJids[0], {
                text: `🎉 *Olá, ${tx.clientName}! Seu PIX foi CONFIRMADO pelo Mercado Pago!*\n\n` +
                      `📦 *Pedido:* #${tx.orderId}\n` +
                      `💰 *Valor Pago:* R$ ${tx.grossAmount.toFixed(2).replace('.', ',')}\n\n` +
                      `👨‍🍳 O seu pedido foi enviado para a cozinha e em instantes iniciaremos o preparo! 🍳`
              });
            } catch(e) {}
          }
        }
      }
      return res.json({ ok: true, status: 'approved', isPaid: true, tx });
    }

    res.json({ ok: true, status: mpStatus, isPaid: isApproved, tx });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 3. Webhook de Confirmação Mercado Pago ─────────────────────
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Webhook Mercado Pago recebido:', JSON.stringify(payload), req.query);

    const paymentId = payload?.data?.id || req.query['data.id'] || req.query.id || payload?.id;

    if (paymentId) {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      const mpData = await mpRes.json();

      if (mpData && mpData.status === 'approved') {
        const db = loadPaymentsData();
        const tx = db.transactions.find(t => String(t.billingId) === String(paymentId) || String(t.orderId) === String(mpData.external_reference));

        if (tx && tx.status !== 'PAID') {
          tx.status = 'PAID';
          tx.paidAt = new Date().toISOString();
          db.balance += tx.netAmount;
          db.totalSales += tx.grossAmount;

          if (!db.orders) db.orders = [];
          const order = db.orders.find(o => String(o.billingId) === String(paymentId) || o.id === tx.orderId);
          if (order) {
            order.status = 'new';
            order.paid = true;
            order.paidAt = new Date().toISOString();
          }
          savePaymentsData(db);

          if (connectionStatus === 'connected' && sock) {
            if (connectedPhone) {
              try {
                const jids = buildJids(connectedPhone);
                await sock.sendMessage(jids[0], {
                  text: `🟢 *PIX RECEBIDO (MERCADO PAGO)!*\n\n` +
                        `📦 *Pedido:* #${tx.orderId}\n` +
                        `👤 *Cliente:* ${tx.clientName}\n` +
                        `💰 *Valor:* R$ ${tx.grossAmount.toFixed(2).replace('.', ',')}\n` +
                        `✨ O pedido foi enviado para a cozinha!`
                });
              } catch(e) {}
            }
            if (tx.clientPhone) {
              try {
                const clientJids = buildJids(tx.clientPhone);
                await sock.sendMessage(clientJids[0], {
                  text: `🎉 *Olá, ${tx.clientName}! Seu PIX foi CONFIRMADO pelo Mercado Pago!*\n\n` +
                        `📦 *Pedido:* #${tx.orderId}\n` +
                        `💰 *Valor Pago:* R$ ${tx.grossAmount.toFixed(2).replace('.', ',')}\n\n` +
                        `👨‍🍳 O seu pedido foi enviado para a cozinha e em instantes iniciaremos o preparo! 🍳`
                });
              } catch(e) {}
            }
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erro no webhook Mercado Pago:', err);
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

// ── 5. Solicitar Saque Pix pelo Lojista ─────────────────────────
app.post('/api/payment/request-withdrawal', async (req, res) => {
  try {
    const { amount, pixKey, pixKeyType, storeName, ownerEmail, ownerPhone } = req.body;
    const withdrawAmount = Number(amount);
    if (!withdrawAmount || withdrawAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Informe um valor de saque válido' });
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
      storeName: storeName || 'Estabelecimento',
      ownerEmail: ownerEmail || '',
      ownerPhone: ownerPhone || '',
      amount: withdrawAmount,
      pixKey: pixKey.trim(),
      pixKeyType: pixKeyType || 'CPF/CNPJ',
      status: 'PENDING', // Aguardando transferência Pix pelo Admin Master
      requestedAt: new Date().toISOString()
    };

    if (!db.withdrawals) db.withdrawals = [];
    db.withdrawals.unshift(newWithdrawal);
    savePaymentsData(db);

    // Notificar o Admin Master via WhatsApp
    if (connectionStatus === 'connected' && sock && connectedPhone) {
      try {
        const jids = buildJids(connectedPhone);
        sock.sendMessage(jids[0], {
          text: `🔔 *NOVA SOLICITAÇÃO DE SAQUE PIX!*` + '\n\n' +
                `🏢 *Estabelecimento:* ${newWithdrawal.storeName}` + '\n' +
                `💰 *Valor:* R$ ${newWithdrawal.amount.toFixed(2).replace('.', ',')}` + '\n' +
                `🔑 *Chave Pix (${newWithdrawal.pixKeyType}):* ${newWithdrawal.pixKey}` + '\n' +
                `📱 *WhatsApp Lojista:* ${newWithdrawal.ownerPhone || 'Não informado'}` + '\n\n' +
                `👉 Acesse seu painel admin.html para aprovar e transferir o Pix!`
        }).catch(() => {});
      } catch(e) {}
    }

    res.json({
      ok: true,
      message: `Saque de R$ ${withdrawAmount.toFixed(2).replace('.', ',')} solicitado com sucesso! A transferência Pix será realizada para a chave ${pixKey}.`,
      newBalance: db.balance,
      withdrawal: newWithdrawal
    });
  } catch (err) {
    console.error('Erro request-withdrawal:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 5.1. Listar Saques para o Painel Admin Master ─────────────
app.get('/api/admin/withdrawals', (req, res) => {
  try {
    const db = loadPaymentsData();
    res.json({ ok: true, withdrawals: db.withdrawals || [] });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 5.2. Aprovar e Marcar Saque como Concluído ─────────────────
app.post('/api/admin/withdrawals/approve', async (req, res) => {
  try {
    const { id } = req.body;
    const db = loadPaymentsData();
    if (!db.withdrawals) db.withdrawals = [];

    const wd = db.withdrawals.find(w => w.id === id);
    if (!wd) {
      return res.status(404).json({ ok: false, error: 'Saque não encontrado' });
    }

    wd.status = 'COMPLETED';
    wd.completedAt = new Date().toISOString();
    savePaymentsData(db);

    // Notificar o Lojista no WhatsApp dele avisando que o Pix foi enviado
    if (connectionStatus === 'connected' && sock && wd.ownerPhone) {
      try {
        const clientJids = buildJids(wd.ownerPhone);
        sock.sendMessage(clientJids[0], {
          text: `🎉 *Olá, ${wd.storeName}! Seu SAQUE foi ENVIADO COM SUCESSO!*\n\n` +
                `💰 *Valor Transferido:* R$ ${wd.amount.toFixed(2).replace('.', ',')}\n` +
                `🔑 *Chave Pix:* ${wd.pixKey} (${wd.pixKeyType})\n\n` +
                `✨ O dinheiro já foi enviado para a sua conta bancária. Boas vendas e obrigado pela parceria com o MenuZaps! 🚀`
        }).catch(() => {});
      } catch(e) {}
    }

    res.json({ ok: true, message: 'Saque marcado como concluído com sucesso!', withdrawal: wd });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 6. Simular Venda Pix (Para testes rápidos) ─────────────────
app.post('/api/payment/simulate-pix', (req, res) => {
  try {
    const { orderId, amount, clientName } = req.body;
    const val = Number(amount) || 32.90;
    const orderNum = orderId || Math.floor(1000 + Math.random() * 9000);
    const fee = 0.99;
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
      status: 'new',
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      ago: 'agora',
      createdAt: new Date().toISOString()
    };

    db.orders.unshift(newOrder);
    savePaymentsData(db);

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
  mercadoPago: 'Active (v1 Payments)'
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




// ── 10. Salvar Configurações e Produtos da Loja (Sincronização Nuvem PC + Celular) ──
app.post('/api/store/save-config', (req, res) => {
  try {
    const { slug, config, products } = req.body;
    const storeSlug = slug || 'pizzaria-bella-napoli';
    const db = loadPaymentsData();
    if (!db.stores) db.stores = {};

    db.stores[storeSlug] = {
      config: config || {},
      products: products || [],
      updatedAt: new Date().toISOString()
    };

    savePaymentsData(db);
    res.json({ ok: true, message: 'Dados da loja sincronizados na nuvem!' });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 11. Carregar Configurações e Produtos da Loja na Nuvem ──
app.get('/api/store/config', (req, res) => {
  try {
    const storeSlug = req.query.slug || 'pizzaria-bella-napoli';
    const db = loadPaymentsData();
    if (db.stores && db.stores[storeSlug]) {
      return res.json({ ok: true, store: db.stores[storeSlug] });
    }
    res.json({ ok: false, message: 'Loja não encontrada na nuvem' });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

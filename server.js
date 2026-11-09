const path = require('path');
const express = require('express');
const { closeTicket } = require('./guider');
const sheets = require('./sheets');
const worker = require('./worker');

const PORT = process.env.PORT || 3000;
const DEV_USER_EMAIL = (process.env.DEV_USER_EMAIL || '').trim().toLowerCase();

for (const name of [
  'GUIDER_TOKEN',
  'SPREADSHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
]) {
  if (!process.env[name]) {
    console.error(`Variável de ambiente ${name} não definida.`);
    process.exit(1);
  }
}
if (DEV_USER_EMAIL) {
  console.warn(`DEV_USER_EMAIL ativo (${DEV_USER_EMAIL}): NUNCA usar em produção.`);
}

const app = express();
app.use(express.json());

// ---- Health check (sem autenticação, não toca no Sheets) ----
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---- Autenticação: o ingress do Magic Deploy autentica e injeta o e-mail em X-Auth-Request-Email.
// Autorização: o e-mail precisa estar na aba "Acessos" da planilha.
const isApi = (req) => req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/close');

function deny(req, res, status, message) {
  if (isApi(req)) return res.status(status).json({ error: message });
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Acesso negado</title><body style="font:16px system-ui;max-width:480px;margin:15vh auto;padding:0 16px">` +
        `<h1 style="font-size:20px">Acesso negado</h1><p>${message}</p></body>`
    );
}

async function requireUser(req, res, next) {
  const email = String(req.get('x-auth-request-email') || DEV_USER_EMAIL || '')
    .trim()
    .toLowerCase();
  if (!email) return deny(req, res, 403, 'Não foi possível identificar o usuário.');

  let access;
  try {
    access = await sheets.getAccess();
  } catch (err) {
    console.error('Falha ao ler a aba de acessos:', err.message);
    return deny(req, res, 503, 'Não foi possível verificar suas permissões agora. Tente novamente em instantes.');
  }
  const perfil = access.get(email);
  if (!perfil) {
    return deny(req, res, 403, 'Seu e-mail não tem acesso a esta ferramenta. Peça a liberação ao responsável.');
  }
  req.user = { email, perfil };
  return next();
}

function requireOperator(req, res, next) {
  if (req.user.perfil !== 'operador') {
    return deny(req, res, 403, 'Seu perfil é somente leitura: você não pode executar esta ação.');
  }
  return next();
}

app.use(requireUser);

// ---- Fechamento avulso de um ticket (operador) ----
async function handleClose(req, res) {
  const ticketId = req.params.ticketId || req.body?.ticketId || req.body?.ticket_id;
  if (!ticketId) return res.status(400).json({ error: 'ticketId é obrigatório' });
  try {
    const response = await closeTicket(ticketId);
    console.log(`Ticket ${ticketId} enviado ao Guider por ${req.user.email} (status ${response.status})`);
    sheets.appendAudit(req.user.email, 'FECHAR_AVULSO', `ticket ${ticketId} (HTTP ${response.status})`);
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || { error: err.message };
    console.error(`Falha ao fechar ticket ${ticketId}:`, status, data);
    sheets.appendAudit(req.user.email, 'FECHAR_AVULSO', `ticket ${ticketId} falhou (${status})`);
    return res.status(status).json(data);
  }
}
app.post('/close', requireOperator, handleClose);
app.post('/close/:ticketId', requireOperator, handleClose);

// ---- API do painel ----
app.get('/api/me', (req, res) => res.json(req.user));

let statusCache = { at: 0, value: null };

app.get('/api/status', async (_req, res) => {
  try {
    if (statusCache.value && Date.now() - statusCache.at < 4000) return res.json(statusCache.value);

    const [ctl, rows] = await Promise.all([sheets.getControl(), sheets.readTickets(4000)]);
    const counts = { total: 0, sucesso: 0, erro: 0, duplicado: 0, pendentes: 0 };
    for (const r of rows) {
      if (!r.id) continue;
      counts.total++;
      if (r.status === 'SUCESSO') counts.sucesso++;
      else if (r.status === 'ERRO') counts.erro++;
      else if (r.status === 'DUPLICADO') counts.duplicado++;
      else if (!r.status) counts.pendentes++;
    }
    const hbAgeSec = ctl.heartbeat ? Math.round((Date.now() - Date.parse(ctl.heartbeat)) / 1000) : null;
    const msPerTicket = Number(ctl.ms_por_ticket) || null;
    const value = {
      estado: ctl.estado,
      mensagem: ctl.mensagem || '',
      workerAtivo: ctl.estado === 'RODANDO' && !!ctl.worker_id && hbAgeSec !== null && hbAgeSec * 1000 < worker.STALE_MS,
      heartbeatSegundos: hbAgeSec,
      intervaloMs: Number(ctl.intervalo_ms) || null,
      ultimoTicket: ctl.ultimo_ticket || '',
      etaSegundos: msPerTicket ? Math.round((counts.pendentes * msPerTicket) / 1000) : null,
      counts,
    };
    statusCache = { at: Date.now(), value };
    res.json(value);
  } catch (err) {
    console.error('Erro em /api/status:', err.message);
    res.status(502).json({ error: 'Falha ao ler a planilha: ' + err.message });
  }
});

async function setState(req, res, partial, action) {
  try {
    await sheets.setControl(partial);
    statusCache = { at: 0, value: null };
    worker.wake();
    sheets.appendAudit(req.user.email, action);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao gravar na planilha: ' + err.message });
  }
}

app.post('/api/start', requireOperator, (req, res) =>
  setState(req, res, { estado: 'RODANDO', mensagem: `Iniciado por ${req.user.email}` }, 'INICIAR')
);
app.post('/api/pause', requireOperator, (req, res) =>
  setState(req, res, { estado: 'PAUSADO', mensagem: `Pausado por ${req.user.email}` }, 'PAUSAR')
);

app.post('/api/retry-errors', requireOperator, async (req, res) => {
  try {
    const ctl = await sheets.getControl();
    if (ctl.estado === 'RODANDO') return res.status(409).json({ error: 'Pause o job antes de reprocessar os erros.' });
    const n = await sheets.clearErrors();
    statusCache = { at: 0, value: null };
    sheets.appendAudit(req.user.email, 'REPROCESSAR_ERROS', `${n} ticket(s) liberados`);
    res.json({ ok: true, liberados: n });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao limpar erros: ' + err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Inicialização e encerramento limpo ----
(async () => {
  try {
    await sheets.ensureSheets();
    const access = await sheets.getAccess(0);
    if (!access.size) {
      console.warn('Aba "Acessos" vazia: ninguém conseguirá acessar. Adicione e-mails (coluna email, perfil operador|leitor).');
    }
  } catch (err) {
    console.error('Não foi possível acessar a planilha:', err.message);
    process.exit(1);
  }
  // '0.0.0.0' garante que o app aceite conexões externas no container
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando na porta ${PORT}`));
  worker.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} recebido: encerrando (finalizando o ticket em andamento)...`);
    setTimeout(() => process.exit(1), 25000).unref();
    server.close();
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();

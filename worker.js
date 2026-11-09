const crypto = require('crypto');
const sheets = require('./sheets');
const { closeTicket } = require('./guider');

const WORKER_ID = `${process.env.HOSTNAME || 'node'}-${crypto.randomBytes(3).toString('hex')}`;

const STALE_MS = 60000; // heartbeat mais velho que isso = worker anterior morreu
const IDLE_MS = 5000; // intervalo de consulta da planilha quando ocioso
const CTL_CHECK_MS = 5000; // de quanto em quanto tempo relê o estado durante o processamento
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS) || 1000; // protege a cota de escrita do Sheets
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS) || 2000;
const MAX_ATTEMPTS = 4;

let stopping = false;
let wakeFn = null;
let loopPromise = null;
let consecutiveErrors = 0;
let emaMs = null;
let unwritten = []; // resultados cujo registro na planilha falhou (reenviados antes de qualquer outra coisa)

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeFn = () => {
      clearTimeout(t);
      resolve();
    };
  });

const nowBR = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const nowISO = () => new Date().toISOString();

function describeError(err) {
  const code = err.response?.status ? `HTTP ${err.response.status}: ` : '';
  const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  return (code + body).slice(0, 500);
}

// Chama o Guider com retry/backoff para 429, 5xx e falhas de rede
async function processTicket(id) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await closeTicket(id);
      return { status: 'SUCESSO', detail: `HTTP ${res.status}` };
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) return { fatal: true, detail: describeError(err) };
      const retryable = !status || status === 429 || status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS && !stopping) {
        const retryAfter = Number(err.response?.headers?.['retry-after']) * 1000;
        await sleep(retryAfter > 0 ? retryAfter : RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      return { status: 'ERRO', detail: describeError(err) };
    }
  }
}

async function acquireLock(ctl) {
  if (ctl.worker_id === WORKER_ID) return true;
  const hbAge = ctl.heartbeat ? Date.now() - Date.parse(ctl.heartbeat) : Infinity;
  const alive = ctl.worker_id && hbAge < STALE_MS;
  if (alive) return false;

  await sheets.setControl({ worker_id: WORKER_ID, heartbeat: nowISO(), mensagem: 'Worker assumiu o job' });
  await sleep(2000); // janela para detectar outro worker assumindo ao mesmo tempo
  const again = await sheets.getControl();
  if (again.worker_id !== WORKER_ID || again.estado !== 'RODANDO') return false;
  consecutiveErrors = 0;
  console.log(`[${WORKER_ID}] lock adquirido`);
  return true;
}

// Separa o que precisa processar (status vazio) e o que é ID repetido
async function scan() {
  const rows = await sheets.readTickets(0);
  const done = new Set(rows.filter((r) => r.id && r.status === 'SUCESSO').map((r) => r.id));
  const queued = new Set();
  const pending = [];
  const dups = [];
  for (const r of rows) {
    if (!r.id || r.status) continue;
    if (done.has(r.id) || queued.has(r.id)) dups.push(r);
    else {
      queued.add(r.id);
      pending.push(r);
    }
  }
  return { pending, dups };
}

async function pauseWith(message, extra = {}) {
  console.warn(`[${WORKER_ID}] pausando: ${message}`);
  await sheets.setControl({ estado: 'PAUSADO', worker_id: '', mensagem: message, ...extra });
}

async function tick() {
  if (unwritten.length) {
    await sheets.markRows(unwritten);
    unwritten = [];
  }

  let ctl = await sheets.getControl();
  if (ctl.estado !== 'RODANDO') {
    if (ctl.worker_id === WORKER_ID) await sheets.setControl({ worker_id: '' });
    return sleep(IDLE_MS);
  }
  if (!(await acquireLock(ctl))) return sleep(IDLE_MS);

  const { pending, dups } = await scan();
  if (dups.length) {
    await sheets.markRows(
      dups.map((r) => ({ line: r.line, status: 'DUPLICADO', when: nowBR(), detail: 'ID repetido na planilha' }))
    );
  }
  if (!pending.length) {
    await sheets.setControl({
      estado: 'CONCLUIDO',
      worker_id: '',
      mensagem: 'Todos os tickets pendentes foram processados',
    });
    console.log(`[${WORKER_ID}] nada pendente: concluído`);
    return;
  }

  const slice = pending.slice(0, Math.max(1, Number(ctl.lote) || 50));
  let lastCheck = Date.now();
  if (emaMs === null && Number(ctl.ms_por_ticket) > 0) emaMs = Number(ctl.ms_por_ticket);

  for (const t of slice) {
    if (stopping) return;

    if (Date.now() - lastCheck >= CTL_CHECK_MS) {
      ctl = await sheets.getControl();
      lastCheck = Date.now();
      // pausado pelo usuário ou lock perdido: o próximo tick libera/aguarda
      if (ctl.estado !== 'RODANDO' || ctl.worker_id !== WORKER_ID) return;
    }
    const interval = Math.max(MIN_INTERVAL_MS, Number(ctl.intervalo_ms) || 1500);
    const maxErrors = Number(ctl.max_erros_seguidos) || 10;

    const started = Date.now();
    const r = await processTicket(t.id);

    if (r.fatal) {
      await pauseWith(`Pausado: Guider recusou a autenticação (${r.detail}). Ticket ${t.id} não foi marcado.`);
      return;
    }

    consecutiveErrors = r.status === 'SUCESSO' ? 0 : consecutiveErrors + 1;
    const when = nowBR();
    emaMs = emaMs === null ? Date.now() - started + interval : emaMs * 0.9 + (Date.now() - started + interval) * 0.1;

    try {
      await sheets.writeResult(t.line, r.status, when, r.detail, [
        WORKER_ID,
        nowISO(),
        Math.round(emaMs),
        t.id,
        `Processando (${consecutiveErrors} erro(s) seguido(s))`,
      ]);
    } catch (err) {
      // O disparo já foi feito: guarda para regravar antes de qualquer novo ticket
      console.error(`Falha ao registrar ticket ${t.id} (${r.status}) na planilha:`, err.message);
      unwritten.push({ line: t.line, status: r.status, when, detail: r.detail });
      throw err;
    }
    console.log(`Ticket ${t.id}: ${r.status} ${r.detail}`);

    if (consecutiveErrors >= maxErrors) {
      await pauseWith(`Pausado automaticamente após ${consecutiveErrors} erros seguidos (último: ${r.detail})`);
      return;
    }
    await sleep(interval);
  }
}

async function loop() {
  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      console.error('Erro no worker:', err.message);
      if (!stopping) await sleep(10000);
    }
  }
}

function start() {
  if (!loopPromise) {
    console.log(`Worker ${WORKER_ID} iniciado (aguardando estado RODANDO na planilha)`);
    loopPromise = loop();
  }
}

function wake() {
  wakeFn?.();
}

// Encerramento limpo: termina o ticket em andamento e libera o lock (estado RODANDO é mantido
// para a nova instância retomar sozinha)
async function stop() {
  stopping = true;
  wakeFn?.();
  await loopPromise;
  try {
    if (unwritten.length) await sheets.markRows(unwritten);
    const ctl = await sheets.getControl();
    if (ctl.worker_id === WORKER_ID) await sheets.setControl({ worker_id: '', mensagem: 'Worker reiniciando' });
  } catch (err) {
    console.error('Falha ao liberar lock:', err.message);
  }
}

module.exports = { start, stop, wake, WORKER_ID, STALE_MS };

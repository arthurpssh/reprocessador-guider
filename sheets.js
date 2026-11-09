const { google } = require('googleapis');

const {
  SPREADSHEET_ID,
  SHEET_NAME = 'Tickets',
  CONTROL_SHEET_NAME = 'Controle',
  ACCESS_SHEET_NAME = 'Acessos',
  AUDIT_SHEET_NAME = 'Auditoria',
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
} = process.env;

const TAB = `'${SHEET_NAME}'`;
const CTL = `'${CONTROL_SHEET_NAME}'`;
const ACCESS = `'${ACCESS_SHEET_NAME}'`;
const AUDIT = `'${AUDIT_SHEET_NAME}'`;

// Aba de controle: coluna A = chave, coluna B = valor. A ORDEM das linhas é fixa (não reordenar).
const KEYS = [
  'estado', // PARADO | RODANDO | PAUSADO | CONCLUIDO
  'intervalo_ms', // pausa entre chamadas ao Guider
  'lote', // tickets por ciclo (depois relê a planilha e a configuração)
  'max_erros_seguidos', // trava: pausa o job após N erros seguidos
  'worker_id', // quem está processando (lock)
  'heartbeat', // último sinal de vida do worker (ISO UTC)
  'ms_por_ticket', // média móvel do tempo por ticket (para o ETA)
  'ultimo_ticket',
  'mensagem',
];
const DEFAULTS = {
  estado: 'PARADO',
  intervalo_ms: 1500,
  lote: 50,
  max_erros_seguidos: 10,
  worker_id: '',
  heartbeat: '',
  ms_por_ticket: '',
  ultimo_ticket: '',
  mensagem: '',
};
const rowOf = (key) => KEYS.indexOf(key) + 2; // linha 1 = cabeçalho

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sheetsApi;
function api() {
  if (!sheetsApi) {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // No .env a chave costuma vir com "\n" literal; converte para quebras de linha reais
      key: (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/^"|"$/g, ''),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsApi = google.sheets({ version: 'v4', auth });
  }
  return sheetsApi;
}

// Repete chamadas ao Sheets em caso de cota (429), erro 5xx ou falha de rede
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = Number(err.code || err.response?.status);
      const retryable = !code || code === 429 || code >= 500;
      if (!retryable || attempt >= 5) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function ensureSheets() {
  const meta = await withRetry(() =>
    api().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties.title' })
  );
  const titles = meta.data.sheets.map((s) => s.properties.title);
  if (!titles.includes(SHEET_NAME)) {
    throw new Error(`Aba "${SHEET_NAME}" não encontrada na planilha (abas: ${titles.join(', ')})`);
  }
  const createTab = async (title, values) => {
    if (titles.includes(title)) return;
    await withRetry(() =>
      api().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      })
    );
    await withRetry(() =>
      api().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${title}'!A1`,
        valueInputOption: 'RAW',
        requestBody: { values },
      })
    );
    console.log(`Aba "${title}" criada.`);
  };

  await createTab(CONTROL_SHEET_NAME, [['chave', 'valor'], ...KEYS.map((k) => [k, DEFAULTS[k]])]);
  await createTab(ACCESS_SHEET_NAME, [['email', 'perfil']]);
  await createTab(AUDIT_SHEET_NAME, [['data', 'usuario', 'acao', 'detalhe']]);
}

// Aba "Acessos": email | perfil (operador = pode iniciar/pausar/reprocessar; qualquer outro valor = leitor).
// E-mail que não está na aba não acessa nada. Cache curto para não estourar a cota do Sheets.
let accessCache = { at: 0, map: null };
async function getAccess(ttlMs = 30000) {
  if (accessCache.map && Date.now() - accessCache.at < ttlMs) return accessCache.map;
  try {
    const { data } = await withRetry(() =>
      api().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ACCESS}!A2:B`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    );
    const map = new Map();
    for (const r of data.values || []) {
      const email = String(r[0] ?? '').trim().toLowerCase();
      if (!email) continue;
      map.set(email, String(r[1] ?? '').trim().toLowerCase() === 'operador' ? 'operador' : 'leitor');
    }
    accessCache = { at: Date.now(), map };
  } catch (err) {
    // Sheets indisponível: usa a última lista conhecida (até 5 min); sem lista, falha fechada
    if (!accessCache.map || Date.now() - accessCache.at > 5 * 60 * 1000) throw err;
  }
  return accessCache.map;
}

// Registro de quem acionou o quê. Falha de auditoria não bloqueia a operação.
async function appendAudit(user, action, detail = '') {
  try {
    await withRetry(() =>
      api().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${AUDIT}!A:D`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }), user, action, detail]],
        },
      })
    );
  } catch (err) {
    console.error('Falha ao registrar auditoria:', err.message);
  }
}

async function getControl() {
  const { data } = await withRetry(() =>
    api().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CTL}!A2:B${KEYS.length + 1}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
  );
  const rows = data.values || [];
  const ctl = {};
  KEYS.forEach((k, i) => {
    const v = rows[i]?.[1];
    ctl[k] = v === undefined ? DEFAULTS[k] : v;
  });
  ctl.estado = String(ctl.estado).trim().toUpperCase();
  return ctl;
}

async function setControl(partial) {
  const data = Object.entries(partial).map(([key, value]) => ({
    range: `${CTL}!B${rowOf(key)}`,
    values: [[value]],
  }));
  await withRetry(() =>
    api().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );
}

// Lê a aba de tickets (A = id, B = status). Cache opcional para a tela de acompanhamento.
let cache = { at: 0, rows: null };
async function readTickets(ttlMs = 0) {
  if (ttlMs && cache.rows && Date.now() - cache.at < ttlMs) return cache.rows;
  const { data } = await withRetry(() =>
    api().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB}!A2:B`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
  );
  const rows = (data.values || []).map((r, i) => ({
    line: i + 2,
    id: String(r[0] ?? '').trim(),
    status: String(r[1] ?? '').trim().toUpperCase(),
  }));
  cache = { at: Date.now(), rows };
  return rows;
}

// Grava o resultado de UM ticket e o heartbeat/progresso do worker na mesma chamada.
// `progress` = valores de worker_id..mensagem (nessa ordem).
async function writeResult(line, status, when, detail, progress) {
  const firstKey = 'worker_id';
  const lastKey = 'mensagem';
  const data = [
    { range: `${TAB}!B${line}:D${line}`, values: [[status, when, detail]] },
    {
      range: `${CTL}!B${rowOf(firstKey)}:B${rowOf(lastKey)}`,
      values: progress.map((v) => [v]),
    },
  ];
  await withRetry(() =>
    api().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    })
  );
}

// Grava vários resultados de uma vez: [{ line, status, when, detail }]
async function markRows(updates) {
  for (let i = 0; i < updates.length; i += 100) {
    const data = updates.slice(i, i + 100).map((u) => ({
      range: `${TAB}!B${u.line}:D${u.line}`,
      values: [[u.status, u.when, u.detail]],
    }));
    await withRetry(() =>
      api().spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
      })
    );
  }
}

// Limpa status/data/detalhe das linhas com ERRO para que sejam reprocessadas
async function clearErrors() {
  const rows = await readTickets(0);
  const errors = rows.filter((r) => r.id && r.status === 'ERRO');
  for (let i = 0; i < errors.length; i += 200) {
    const ranges = errors.slice(i, i + 200).map((r) => `${TAB}!B${r.line}:D${r.line}`);
    await withRetry(() =>
      api().spreadsheets.values.batchClear({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { ranges },
      })
    );
  }
  cache = { at: 0, rows: null };
  return errors.length;
}

module.exports = {
  ensureSheets,
  getAccess,
  appendAudit,
  getControl,
  setControl,
  readTickets,
  writeResult,
  markRows,
  clearErrors,
};

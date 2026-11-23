// Serviço de fundo da extensão Cobrança S4E.
// Só faz leitura no S4E: nunca envia postback, gera acordo ou altera situação.
const S4E_URL = 'https://redesaude.s4e.com.br/';
const S4E_PATTERN = 'https://redesaude.s4e.com.br/*';
const PORTAL_PATTERNS = [
  'http://192.168.1.11/*',
  'https://192.168.1.11/*',
  'http://127.0.0.1/*',
  'https://127.0.0.1/*',
  'http://localhost/*',
  'https://localhost/*',
];
// Reiniciado a cada progresso: o relatório completo passa de 900 fichas e pode
// levar vários minutos, mas nunca deve ficar parado sem sinal de vida.
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

let pending = null;
let idleTimer = null;

function newRequestId() {
  return `cob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function findPortalTab() {
  for (const pattern of PORTAL_PATTERNS) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: pattern });
    } catch (_) {
      continue;
    }
    const tab = tabs.find(item => item.active) || tabs[0];
    if (tab && tab.id) return tab;
  }
  return null;
}

async function findS4eTab() {
  try {
    const tabs = await chrome.tabs.query({ url: S4E_PATTERN });
    return tabs.find(item => item.active) || tabs[0] || null;
  } catch (_) {
    return null;
  }
}

async function focusTab(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) await chrome.tabs.update(tab.id, { active: true });
  } catch (_) {}
}

async function notifyPortal(detail) {
  if (!pending || !pending.portalTabId) return;
  try {
    await chrome.tabs.sendMessage(pending.portalTabId, { type: 'COBRANCA_RESULT', detail });
  } catch (_) {}
}

async function progress(message) {
  if (!pending || !pending.portalTabId) return;
  try {
    await chrome.tabs.sendMessage(pending.portalTabId, { type: 'COBRANCA_PROGRESS', message });
  } catch (_) {}
}

function clearPending() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  pending = null;
}

function armTimeout() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!pending) return;
    notifyPortal({ ok: false, message: 'A leitura no S4E ficou parada por muito tempo e foi interrompida. Confirme que a aba do S4E continua aberta e tente novamente.' });
    clearPending();
  }, IDLE_TIMEOUT_MS);
}

async function startImport(portalTab) {
  if (!portalTab || !portalTab.id) return;
  if (pending) {
    try {
      await chrome.tabs.update(portalTab.id, { active: true });
    } catch (_) {}
    await chrome.tabs.sendMessage(portalTab.id, {
      type: 'COBRANCA_RESULT',
      detail: { ok: false, message: 'Já existe uma importação em andamento. Aguarde terminar.' },
    });
    return;
  }
  const s4eTab = await findS4eTab();
  if (!s4eTab) {
    await chrome.tabs.create({ url: S4E_URL, active: true });
    await chrome.tabs.sendMessage(portalTab.id, {
      type: 'COBRANCA_RESULT',
      detail: {
        ok: false,
        message: 'Abri o S4E em outra aba. Entre no sistema, abra Faturamento → Contas a Receber, aplique o filtro, clique em Buscar e depois volte ao portal e clique em Importar do S4E.',
      },
    });
    return;
  }

  let ping = null;
  try {
    ping = await chrome.tabs.sendMessage(s4eTab.id, { type: 'S4E_PING' });
  } catch (_) {
    ping = null;
  }
  if (!ping || !ping.hasReport) {
    await focusTab(s4eTab);
    await chrome.tabs.sendMessage(portalTab.id, {
      type: 'COBRANCA_RESULT',
      detail: {
        ok: false,
        message: 'Não encontrei o Contas a Receber aberto no S4E. Entre no S4E, abra Faturamento → Contas a Receber, aplique o filtro, clique em Buscar e importe de novo.',
      },
    });
    return;
  }

  pending = { portalTabId: portalTab.id, s4eTabId: s4eTab.id, requestId: newRequestId(), batches: {} };
  armTimeout();
  await focusTab(s4eTab);
  try {
    const started = await chrome.tabs.sendMessage(s4eTab.id, { type: 'S4E_EXTRACT', requestId: pending.requestId });
    if (!started || !started.started) {
      clearPending();
      await chrome.tabs.sendMessage(portalTab.id, {
        type: 'COBRANCA_RESULT',
        detail: { ok: false, message: 'A extensão não conseguiu iniciar a leitura no S4E. Atualize a aba do S4E (F5) e tente novamente.' },
      });
    }
  } catch (_) {
    clearPending();
    await chrome.tabs.sendMessage(portalTab.id, {
      type: 'COBRANCA_RESULT',
      detail: { ok: false, message: 'Atualize a aba do S4E (F5), confirme que o relatório está aberto e tente novamente.' },
    });
  }
}

async function uploadRows(rows, periodStart, periodEnd, source, fullScope, scope) {
  const session = await chrome.tabs.sendMessage(pending.portalTabId, { type: 'GET_PORTAL_SESSION' }).catch(() => null);
  if (!session || !session.token || !session.origin) {
    throw new Error('A sessão do portal não foi encontrada. Atualize a página do portal, entre novamente e repita a importação.');
  }
  let response = null;
  try {
    response = await fetch(`${session.origin}/api/cobranca/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rows,
        source: source || 's4e',
        scope: scope || 'empresas',
        fullScope: Boolean(fullScope),
        periodStart: periodStart || '',
        periodEnd: periodEnd || '',
      }),
    });
  } catch (_) {
    throw new Error('Não consegui enviar a fila para o portal. Confirme que o portal está aberto e acessível e tente novamente.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error('A sessão do portal expirou. Atualize a página, entre novamente e repita a importação.');
  }
  if (!response.ok) throw new Error(data.error || 'O portal recusou a importação da fila de cobrança.');
  return data;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  if (message.type === 'PORTAL_IMPORT_REQUEST') {
    const portalTab = sender && sender.tab ? sender.tab : null;
    startImport(portalTab).catch(async error => {
      if (portalTab) {
        try {
          await chrome.tabs.sendMessage(portalTab.id, {
            type: 'COBRANCA_RESULT',
            detail: { ok: false, message: error.message || 'A importação falhou.' },
          });
        } catch (_) {}
      }
    });
    return;
  }

  if (message.type === 'S4E_PROGRESS') {
    if (!pending) return;
    armTimeout();
    progress(message.message || '');
    return;
  }

  if (message.type === 'S4E_EXTRACT_ERROR') {
    if (!pending) return;
    const target = pending.portalTabId;
    clearPending();
    chrome.tabs.sendMessage(target, {
      type: 'COBRANCA_RESULT',
      detail: { ok: false, message: message.message || 'A leitura do relatório no S4E falhou.' },
    }).catch(() => {});
    return;
  }

  if (message.type === 'S4E_EXTRACT_BATCH') {
    if (!pending) return;
    if (message.requestId && pending.requestId && message.requestId !== pending.requestId) return;
    armTimeout();
    const index = Number(message.index) || 0;
    pending.batches[index] = Array.isArray(message.rows) ? message.rows : [];
    pending.batchTotal = Number(message.total) || 1;
    return;
  }

  if (message.type === 'S4E_EXTRACT_RESULT') {
    if (!pending) return;
    if (message.requestId && pending.requestId && message.requestId !== pending.requestId) return;
    const batches = pending.batches || {};
    const missing = [];
    for (let index = 0; index < (pending.batchTotal || 1); index += 1) {
      if (!Array.isArray(batches[index])) missing.push(index + 1);
    }
    if (missing.length) {
      const target = pending.portalTabId;
      clearPending();
      chrome.tabs.sendMessage(target, {
        type: 'COBRANCA_RESULT',
        detail: { ok: false, message: `Faltaram dados na transferência (lote ${missing.join(', ')}). Tente importar novamente.` },
      }).catch(() => {});
      return;
    }
    const rows = Object.keys(batches)
      .sort((left, right) => Number(left) - Number(right))
      .flatMap(key => batches[key]);
    const portalTabId = pending.portalTabId;
    uploadRows(rows, message.periodStart, message.periodEnd, message.source, message.fullScope, message.scope)
      .then(async data => {
        clearPending();
        const imported = data.import || {};
        const summary = `${imported.criados || 0} cobrança(s) nova(s), ${imported.atualizados || 0} atualizada(s), ${imported.baixados || 0} baixada(s)`
          + `${imported.semEmail ? ` · ${imported.semEmail} sem e-mail` : ''}`
          + `${imported.semWhatsapp ? ` · ${imported.semWhatsapp} sem WhatsApp` : ''}`
          + `${message.warning ? ` · ${message.warning}` : ''}.`;
        await chrome.tabs.sendMessage(portalTabId, {
          type: 'COBRANCA_RESULT',
          detail: { ok: true, message: summary, import: imported },
        }).catch(() => {});
        const tab = await chrome.tabs.get(portalTabId).catch(() => null);
        if (tab) focusTab(tab);
      })
      .catch(async error => {
        clearPending();
        await chrome.tabs.sendMessage(portalTabId, {
          type: 'COBRANCA_RESULT',
          detail: { ok: false, message: error.message || 'Não consegui enviar a fila para o portal.' },
        }).catch(() => {});
      });
  }
});

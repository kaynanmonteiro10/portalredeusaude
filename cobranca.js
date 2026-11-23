// ── Tela Cobrança: empresas em atraso (S4E) ────────────────────────────────
(function () {
  const byId = id => document.getElementById(id);
  const esc = value => {
    const text = String(value == null ? '' : value);
    if (window.escapeHtml) return window.escapeHtml(text);
    return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  };
  const apiBase = () => window.PORTAL_API_BASE || '';
  const notify = (message, tone) => (window.notify ? window.notify(message, tone) : alert(message));
  const api = (path, options) => window.PortalAccess.api(path, options);

  const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const intFmt = new Intl.NumberFormat('pt-BR');

  const CONTATO_LABELS = {
    com_email: 'com e-mail',
    sem_email: 'sem e-mail',
    com_whatsapp: 'com WhatsApp',
    sem_whatsapp: 'sem WhatsApp',
  };
  const DEPOSITO_LABELS = {
    cobrar: 'só cobrar',
    deposito: 'depósito bancário',
    cancelada: 'empresas canceladas',
  };
  const STATUS_FILTER_LABELS = {
    ativos: 'em aberto (fila)',
    aberto: 'novos',
    em_cobranca: 'em cobrança',
    promessa: 'prometeu pagar',
    sem_contato: 'sem contato',
    pago: 'baixados',
    encerrado: 'encerrados',
    todos: 'todos',
  };

  const state = {
    bound: false,
    loading: false,
    items: [],
    summary: {},
    imports: [],
    statusLabels: {},
    resultLabels: {},
    statusCounts: {},
    canManage: false,
    canDelete: false,
    tipos: [],
    groups: [],
    total: 0,
    search: '',
    status: 'ativos',
    tipo: '',
    grupo: '',
    contato: '',
    deposito: '',
    from: '',
    to: '',
    sort: 'venc_asc',
    requestId: 0,
    searchTimer: null,
    extensionReady: false,
    importing: false,
    dialogCompany: null,
    dialogHistory: [],
    dialogSends: [],
    dialogGraph: {},
    dialogEmail: {},
    dialogTab: 'preview',
    sending: false,
    s4eConnected: false,
    s4eUser: '',
    s4eBusy: false,
    s4eTimer: null,
    s4eAccount: {},
    s4eCanManage: false,
    s4eShowAccountForm: false,
    visible: false,
    refreshTimer: null,
    loadedAt: 0,
  };

  function money(value) {
    return moneyFmt.format(Number(value) || 0);
  }

  function integer(value) {
    return intFmt.format(Number(value) || 0);
  }

  function plural(value, one, many) {
    return Number(value) === 1 ? one : many;
  }

  function dateLabel(value) {
    const raw = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [year, month, day] = raw.split('-');
      return `${day}/${month}/${year}`;
    }
    return raw || '—';
  }

  function dateTimeLabel(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return dateLabel(value);
    return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function phoneDigits(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    return digits;
  }

  function statusTone(status) {
    return ['aberto', 'em_cobranca', 'promessa', 'sem_contato', 'pago', 'encerrado'].includes(status) ? status : 'aberto';
  }

  function filterParams() {
    const params = new URLSearchParams();
    params.set('mode', 'empresas');
    if (state.search.trim()) params.set('search', state.search.trim());
    params.set('status', state.status || 'ativos');
    if (state.tipo) params.set('tipo', state.tipo);
    if (state.grupo) params.set('grupo', state.grupo);
    if (state.contato) params.set('contato', state.contato);
    if (state.deposito) params.set('deposito', state.deposito);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    params.set('sort', state.sort);
    return params;
  }

  function setLoading(active) {
    state.loading = active;
    byId('cobrancaScreen')?.classList.toggle('finance-loading', active);
  }

  function renderKpis() {
    const summary = state.summary || {};
    const cards = [
      {
        label: 'Empresas na fila',
        value: integer(summary.empresas),
        hint: `${integer(summary.cases)} título(s) em aberto`,
        kpi: 'all',
      },
      {
        label: 'A cobrar',
        value: integer(summary.empresasCobrar),
        hint: `${integer(summary.titulosCobrar)} título(s) · ${money(summary.valorCobrar)}`,
        kpi: 'cobrar',
        highlight: true,
      },
      {
        label: 'Depósito bancário',
        value: integer(summary.empresasDeposito),
        hint: `${money(summary.depositoValor)} · não cobrar`,
        kpi: 'deposito',
      },
      {
        label: 'Canceladas',
        value: integer(summary.empresasCanceladas),
        hint: `${money(summary.canceladaValor)} · não cobrar`,
        kpi: 'cancelada',
      },
      {
        label: 'Com acordo',
        value: integer(summary.empresasAcordo),
        hint: 'mensagem detalha cada parcela',
        kpi: '',
      },
      {
        label: 'Sem e-mail',
        value: integer(summary.empresasSemEmail),
        hint: 'entre as empresas a cobrar',
        kpi: '',
      },
      {
        label: 'Sem WhatsApp',
        value: integer(summary.empresasSemWhatsapp),
        hint: 'entre as empresas a cobrar',
        kpi: '',
      },
      {
        label: 'Cobradas hoje',
        value: integer(summary.empresasCobradasHoje),
        hint: 'empresas com contato registrado hoje',
        kpi: '',
      },
    ];
    const host = byId('cobrancaKpis');
    if (!host) return;
    host.innerHTML = cards.map(card => `
      <article class="stat-card${card.highlight ? ' highlight' : ''}${card.kpi ? ' is-clickable' : ''}"${card.kpi ? ` data-kpi="${card.kpi}" role="button" tabindex="0"` : ''}>
        <span>${esc(card.label)}</span>
        <strong>${esc(card.value)}</strong>
        <small>${esc(card.hint)}</small>
      </article>`).join('');
  }

  function renderLastImport() {
    const host = byId('cobrancaLastImport');
    if (!host) return;
    const last = (state.imports || [])[0];
    if (!last) {
      host.textContent = 'Nenhuma importação ainda.';
      return;
    }
    const period = last.periodStart || last.periodEnd
      ? ` · ${dateLabel(last.periodStart || last.periodEnd)}${last.periodEnd && last.periodEnd !== last.periodStart ? ` a ${dateLabel(last.periodEnd)}` : ''}`
      : '';
    host.innerHTML = `<strong>${integer(last.total)} linha(s) do S4E</strong><br>`
      + `${integer(last.criados)} novo(s) · ${integer(last.atualizados)} atualizado(s) · ${integer(last.baixados)} baixado(s)${period}<br>`
      + `${esc(dateTimeLabel(last.at))} · ${esc(last.userName || '—')}`;
  }

  function renderTipoOptions() {
    const select = byId('cobrancaTipoFilter');
    if (!select) return;
    const options = (state.tipos || []).map(item => {
      const option = document.createElement('option');
      option.value = item.value || '';
      option.textContent = `${item.label} (${integer(item.total)})`;
      return option.outerHTML;
    }).join('');
    select.innerHTML = '<option value="">Todos os tipos</option>' + options;
    select.value = state.tipo || '';
  }

  function renderGroupOptions() {
    const select = byId('cobrancaGrupoFilter');
    if (!select) return;
    const options = (state.groups || []).map(item => {
      const option = document.createElement('option');
      option.value = item.name || '';
      option.textContent = `${item.name} (${integer(item.total)})`;
      return option.outerHTML;
    }).join('');
    select.innerHTML = '<option value="">Todos os grupos</option>' + options;
    select.value = state.grupo || '';
  }

  function tipoFilterLabel(value) {
    const item = (state.tipos || []).find(entry => (entry.value || '') === value);
    return item ? item.label : value;
  }

  function activeFilters() {
    const filters = [];
    const search = state.search.trim();
    if (search) filters.push({ key: 'search', kind: 'Pesquisa', label: search, isSearch: true });
    if (state.grupo) filters.push({ key: 'grupo', kind: 'Grupo', label: state.grupo });
    if (state.tipo) filters.push({ key: 'tipo', kind: 'Tipo', label: tipoFilterLabel(state.tipo) });
    if (state.contato) filters.push({ key: 'contato', kind: 'Contato', label: CONTATO_LABELS[state.contato] || state.contato });
    if (state.deposito) filters.push({ key: 'deposito', kind: 'Cobrança', label: DEPOSITO_LABELS[state.deposito] || state.deposito });
    if (state.status && state.status !== 'ativos') filters.push({ key: 'status', kind: 'Situação', label: STATUS_FILTER_LABELS[state.status] || state.status });
    if (state.from) filters.push({ key: 'from', kind: 'Vence de', label: dateLabel(state.from) });
    if (state.to) filters.push({ key: 'to', kind: 'Vence até', label: dateLabel(state.to) });
    return filters;
  }

  function clearFilter(key) {
    if (key === 'search') {
      state.search = '';
      if (byId('cobrancaSearch')) byId('cobrancaSearch').value = '';
    } else if (key === 'grupo') {
      state.grupo = '';
      if (byId('cobrancaGrupoFilter')) byId('cobrancaGrupoFilter').value = '';
    } else if (key === 'tipo') {
      state.tipo = '';
      if (byId('cobrancaTipoFilter')) byId('cobrancaTipoFilter').value = '';
    } else if (key === 'contato') {
      state.contato = '';
      if (byId('cobrancaContatoFilter')) byId('cobrancaContatoFilter').value = '';
    } else if (key === 'deposito') {
      state.deposito = '';
      if (byId('cobrancaDepositoFilter')) byId('cobrancaDepositoFilter').value = '';
    } else if (key === 'status') {
      state.status = 'ativos';
      if (byId('cobrancaStatusFilter')) byId('cobrancaStatusFilter').value = 'ativos';
    } else if (key === 'from') {
      state.from = '';
      if (byId('cobrancaFrom')) byId('cobrancaFrom').value = '';
    } else if (key === 'to') {
      state.to = '';
      if (byId('cobrancaTo')) byId('cobrancaTo').value = '';
    }
    load();
  }

  function filterChipsHtml(filters, removable) {
    return filters.map(filter => {
      const tag = removable ? 'button' : 'span';
      const action = removable ? ` type="button" data-filter-clear="${esc(filter.key)}" title="Remover ${esc(filter.kind)}"` : '';
      return `<${tag} class="cobranca-filter-chip${filter.isSearch ? ' is-search' : ''}"${action}>`
        + `${esc(filter.kind)}: <strong>${esc(filter.label)}</strong>${removable ? '<span class="cobranca-filter-x" aria-hidden="true">×</span>' : ''}`
        + `</${tag}>`;
    }).join('');
  }

  function renderFilterChips() {
    const host = byId('cobrancaFilterChips');
    if (!host) return;
    const filters = activeFilters();
    if (!filters.length) {
      host.hidden = true;
      host.innerHTML = '';
      return;
    }
    const filterCount = filters.filter(filter => !filter.isSearch).length;
    host.hidden = false;
    const caption = filterCount ? `${filterCount} filtro${filterCount > 1 ? 's' : ''} aplicado${filterCount > 1 ? 's' : ''}` : 'Pesquisa aplicada';
    host.innerHTML = `<span class="cobranca-filter-caption">${caption}</span>`
      + filterChipsHtml(filters, true);
    host.querySelectorAll('[data-filter-clear]').forEach(button => {
      button.addEventListener('click', () => clearFilter(button.dataset.filterClear));
    });
  }

  function renderStatusFilterCounts() {
    const counts = state.statusCounts || {};
    const labels = {
      ativos: (counts.aberto || 0) + (counts.em_cobranca || 0) + (counts.promessa || 0) + (counts.sem_contato || 0),
      aberto: counts.aberto || 0,
      em_cobranca: counts.em_cobranca || 0,
      promessa: counts.promessa || 0,
      sem_contato: counts.sem_contato || 0,
      pago: counts.pago || 0,
      encerrado: counts.encerrado || 0,
      todos: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
    };
    const names = {
      ativos: 'Em aberto (fila)',
      aberto: 'Novos',
      em_cobranca: 'Em cobrança',
      promessa: 'Prometeu pagar',
      sem_contato: 'Sem contato',
      pago: 'Baixados',
      encerrado: 'Encerrados',
      todos: 'Todos',
    };
    Object.keys(names).forEach(key => {
      const option = byId('cobrancaStatusFilter')?.querySelector(`option[value="${key}"]`);
      if (option) {
        option.textContent = `${names[key]} (${integer(labels[key])})`;
        option.title = `${integer(labels[key])} título(s)`;
      }
    });
  }

  function compositionChips(company, short = false) {
    const entries = company.composicao || [];
    if (!entries.length) return '<span class="cobranca-muted">—</span>';
    return `<div class="cobranca-comp">${entries.map(entry => {
      const label = Number(entry.count) === 1 ? entry.label : entry.labelPlural;
      const text = short ? `${integer(entry.count)}` : `${integer(entry.count)} ${label.toLowerCase()}`;
      return `<span class="cobranca-comp-chip is-${esc(entry.key)}" title="${esc(`${entry.count} ${label} · ${money(entry.total)}`)}">${esc(text)}</span>`;
    }).join('')}</div>`;
  }

  function blockedBadge(company) {
    if (company.cancelada) return '<span class="cobranca-deposito-badge cobranca-cancelada-badge">Empresa cancelada</span>';
    if (company.deposito) return '<span class="cobranca-deposito-badge">Depósito bancário</span>';
    return '';
  }

  function contactCell(company) {
    const lines = [];
    if (company.emails?.length) lines.push(`<span class="cobranca-contact-line" title="${esc(company.emails.join(', '))}">✉ ${esc(company.emails[0])}${company.emails.length > 1 ? ` +${company.emails.length - 1}` : ''}</span>`);
    if (company.phones?.length) lines.push(`<span class="cobranca-contact-line" title="${esc(company.phones.join(', '))}">☎ ${esc(company.phones[0])}${company.phones.length > 1 ? ` +${company.phones.length - 1}` : ''}</span>`);
    if (!company.emails?.length) lines.push('<span class="cobranca-contact-none">sem e-mail</span>');
    if (company.cc?.length) lines.push(`<span class="cobranca-contact-line cobranca-contact-cc" title="Em cópia: ${esc(company.cc.join(', '))}">cc ${esc(company.cc[0])}${company.cc.length > 1 ? ` +${company.cc.length - 1}` : ''}</span>`);
    if (company.emailsIgnorados?.length) lines.push(`<span class="cobranca-contact-ignored" title="Ignorados: ${esc(company.emailsIgnorados.join(', '))}">${integer(company.emailsIgnorados.length)} interno(s) ignorado(s)</span>`);
    if (!lines.length) return '<span class="cobranca-contact-none">Sem contato no S4E</span>';
    return lines.join('');
  }

  function renderRows() {
    const host = byId('cobrancaRows');
    if (!host) return;
    const items = state.items || [];
    host.innerHTML = items.map(company => {
      const blocked = company.bloqueada;
      const overdue = !company.vencimento
        ? ''
        : Number(company.diasAtraso) > 0
          ? `<span class="finance-sub cobranca-overdue">${integer(company.diasAtraso)} dia(s)</span>`
          : '<span class="finance-sub">vence hoje</span>';
      const last = company.lastContactAt
        ? `<span class="finance-sub">contato ${esc(dateTimeLabel(company.lastContactAt))}</span>`
        : '';
      return `<tr data-open-company="${esc(company.key)}"${blocked ? ' class="cobranca-row-deposito"' : ''}>
        <td class="cobranca-col-empresa">
          <button class="cobranca-company-name" type="button" data-open-company="${esc(company.key)}" title="${esc(company.nome)}">${esc(company.nome)}</button>
          <span class="finance-sub">${esc(company.documento || 'sem CNPJ')}${company.grupo ? ` · ${esc(company.grupo)}` : ''}</span>
          ${company.cadastros > 1 ? `<span class="cobranca-cadastros">${integer(company.cadastros)} cadastros</span>` : ''}
        </td>
        <td class="cobranca-col-comp">${compositionChips(company)}</td>
        <td class="cobranca-col-venc">${esc(dateLabel(company.vencimento))}${overdue}</td>
        <td class="cobranca-col-valor num">${blocked
          ? `<span class="finance-money muted">${esc(money(company.total))}</span><span class="finance-sub">não cobrar</span>`
          : `<span class="finance-money">${esc(money(company.totalCobrar))}</span>`}</td>
        <td class="cobranca-col-contato">${contactCell(company)}</td>
        <td class="cobranca-col-sit">
          ${blocked
            ? blockedBadge(company)
            : `<span class="cobranca-status is-${esc(statusTone(company.status))}">${esc(company.statusLabel)}</span>`}
          ${last}
        </td>
        <td class="cobranca-col-acao"><div class="cobranca-row-actions">${blocked
          ? '<span class="cobranca-muted">Sem cobrança</span>'
          : `<button class="button button-primary cobranca-open" type="button" data-open-company="${esc(company.key)}">Cobrar</button>`}${state.canDelete
          ? `<button class="cobranca-icon-delete" type="button" data-delete-company="${esc(company.key)}" title="Apagar esta empresa da fila" aria-label="Apagar ${esc(company.nome)} da fila">🗑</button>`
          : ''}</div></td>
      </tr>`;
    }).join('');
    byId('cobrancaEmpty')?.classList.toggle('hidden', items.length > 0);
    const table = host.closest('table');
    if (table) table.classList.toggle('hidden', items.length === 0);
  }

  function renderMeta() {
    const summary = state.summary || {};
    const count = byId('cobrancaCount');
    if (count) {
      if (state.total) {
        const parts = [`<strong>${integer(state.total)}</strong> ${plural(state.total, 'empresa', 'empresas')} na tela`];
        if (Number(summary.empresasCobrar)) parts.push(`<strong>${integer(summary.empresasCobrar)}</strong> a cobrar · <strong>${esc(money(summary.valorCobrar))}</strong>`);
        if (Number(summary.empresasDeposito)) parts.push(`<strong>${integer(summary.empresasDeposito)}</strong> depósito`);
        if (Number(summary.empresasCanceladas)) parts.push(`<strong>${integer(summary.empresasCanceladas)}</strong> cancelada(s)`);
        count.innerHTML = parts.join(' · ');
      } else {
        count.textContent = 'Nenhuma empresa no filtro';
      }
    }
    const hint = byId('cobrancaHint');
    if (hint) {
      const parts = [];
      if (summary.titulosCobrar) parts.push(`${integer(summary.titulosCobrar)} título(s) a cobrar`);
      if (summary.empresasSemEmail) parts.push(`${integer(summary.empresasSemEmail)} empresa(s) sem e-mail`);
      if (summary.empresasSemWhatsapp) parts.push(`${integer(summary.empresasSemWhatsapp)} sem WhatsApp`);
      if (summary.empresasAcordo) parts.push(`${integer(summary.empresasAcordo)} com acordo`);
      hint.textContent = parts.length ? parts.join(' · ') : 'Contatos em dia';
    }
  }

  function renderAll() {
    renderKpis();
    renderTipoOptions();
    renderGroupOptions();
    renderStatusFilterCounts();
    renderFilterChips();
    renderLastImport();
    renderRows();
    renderMeta();
    byId('cobrancaClearButton')?.classList.toggle('hidden', !state.canDelete || !state.total);
    byId('cobrancaSearchClear')?.classList.toggle('hidden', !state.search);
  }

  async function load() {
    const requestId = ++state.requestId;
    setLoading(true);
    try {
      const data = await api(`/api/cobranca?${filterParams().toString()}`);
      if (requestId !== state.requestId) return;
      state.items = data.items || [];
      state.summary = data.summary || {};
      state.imports = data.imports || [];
      state.tipos = data.tipos || [];
      state.groups = data.groups || [];
      state.statusLabels = data.statusLabels || {};
      state.resultLabels = data.resultLabels || {};
      state.statusCounts = data.statusCounts || {};
      state.canManage = Boolean(data.canManage);
      state.canDelete = Boolean(data.canDelete);
      state.total = Number(data.total) || state.items.length;
      state.loadedAt = Date.now();
      renderAll();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    } finally {
      if (requestId === state.requestId) {
        setLoading(false);
        renderMeta();
        scheduleRefresh();
      }
    }
  }

  // A fila também muda sozinha (importação automática no servidor): recarrega sem sair da tela.
  const REFRESH_MS = 5 * 60 * 1000;
  const screenVisible = () => state.visible && Boolean(window.PortalAccess?.Access.user) && !document.body.classList.contains('locked');
  const dialogOpen = () => ['cobrancaDialog', 'cobrancaS4eDialog', 'cobrancaTemplatesDialog', 'cobrancaGroupsDialog', 'cobrancaLoteDialog', 'cobrancaSendsDialog'].some(id => byId(id)?.open);

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    if (screenVisible()) state.refreshTimer = setTimeout(refreshQuietly, REFRESH_MS);
  }

  async function refreshQuietly() {
    if (!screenVisible()) return;
    if (document.hidden || dialogOpen() || state.loading || state.importing || state.s4eBusy || state.sending) {
      scheduleRefresh();
      return;
    }
    await load();
  }

  async function exportFiltered() {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/cobranca/export/xlsx?${filterParams().toString()}`, {
        headers: window.PortalAccess.authHeaders(),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível exportar o filtro.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cobranca-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify('Planilha do filtro atual baixada (empresas e títulos).');
    } catch (error) {
      notify(error.message, 'warning');
    } finally {
      setLoading(false);
    }
  }

  // ── Importação pela extensão ──────────────────────────────────────────────
  function detectExtension() {
    state.extensionReady = document.documentElement.dataset.cobrancaExtension === '1';
  }

  function startImport() {
    detectExtension();
    if (!state.extensionReady) {
      const help = byId('cobrancaScreen')?.querySelector('details.finance-help');
      if (help) help.open = true;
      notify('A extensão Cobrança S4E não está ativa. Instale/ative a extensão no navegador e recarregue esta página.', 'warning');
      return;
    }
    if (state.importing) return;
    state.importing = true;
    setLoading(true);
    byId('cobrancaImportS4e').disabled = true;
    notify('Lendo o relatório no S4E e buscando os contatos na ficha de cada cliente...');
    window.dispatchEvent(new CustomEvent('portal-cobranca-import'));
  }

  function finishImport(detail) {
    state.importing = false;
    setLoading(false);
    const button = byId('cobrancaImportS4e');
    if (button) button.disabled = false;
    const imported = detail.import || {};
    if (detail.ok === false) {
      notify(detail.message || 'A importação do S4E falhou.', 'warning');
      return;
    }
    const parts = [
      `${integer(imported.criados)} nova(s)`,
      `${integer(imported.atualizados)} atualizada(s)`,
      `${integer(imported.baixados)} baixada(s)`,
    ];
    if (imported.semEmail) parts.push(`${integer(imported.semEmail)} sem e-mail`);
    if (imported.semWhatsapp) parts.push(`${integer(imported.semWhatsapp)} sem WhatsApp`);
    notify(detail.message || `Importação concluída: ${parts.join(' · ')}.`);
    load();
  }

  // ── Conector S4E (login no portal, sem extensão) ──────────────────────────
  function s4eSetStatus(text, tone) {
    const el = byId('s4eStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', tone === 'error');
    el.classList.toggle('is-ok', tone === 'ok');
  }

  function s4eElapsed(startedAt) {
    if (!startedAt) return '';
    const started = new Date(startedAt).getTime();
    if (!Number.isFinite(started)) return '';
    const secs = Math.max(0, Math.round((Date.now() - started) / 1000));
    const minutes = Math.floor(secs / 60);
    return minutes ? `${minutes}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
  }

  function s4eSetProgress(job) {
    const box = byId('s4eProgressBox');
    const bar = byId('s4eProgress');
    const label = byId('s4eProgressLabel');
    if (!box || !bar) return;
    box.classList.remove('hidden');
    const total = Number(job.total) || 0;
    const done = Number(job.done) || 0;
    const raw = Number(job.percent);
    const percent = Number.isFinite(raw) ? raw : (total ? Math.round((done / total) * 100) : null);
    if (percent === null) bar.removeAttribute('value');
    else bar.value = Math.max(0, Math.min(100, percent));
    const elapsed = s4eElapsed(job.startedAt);
    const parts = [];
    if (percent !== null) parts.push(`${Math.round(percent)}%`);
    if (total && done) parts.push(`${done} de ${total}`);
    if (elapsed) parts.push(elapsed);
    if (label) label.textContent = parts.join(' · ') || 'Trabalhando...';
  }

  function s4eRender() {
    const account = state.s4eAccount || {};
    const canManage = Boolean(state.s4eCanManage);
    const label = byId('s4eUserLabel');
    if (label) {
      label.textContent = state.s4eConnected && state.s4eUser
        ? `Conectado ao S4E como ${state.s4eUser}.`
        : (account.configured ? 'Conta do S4E pronta.' : '');
    }
    const line = byId('s4eAccountLine');
    if (line) {
      if (account.configured) {
        const who = account.name ? `<strong>${esc(account.name)}</strong>` : 'a conta salva';
        const cpf = account.cpf ? ` · CPF ${esc(account.cpf)}` : '';
        const when = account.savedAt ? ` · salva em ${new Date(account.savedAt).toLocaleDateString('pt-BR')}` : '';
        line.innerHTML = `O portal entra sozinho com ${who}${cpf}${when}. O botão <strong>Importar do S4E</strong> não pede senha.`;
      } else if (canManage) {
        line.textContent = 'Nenhuma conta salva ainda. Configure uma vez para importar sem digitar senha.';
      } else {
        line.textContent = 'A conta do S4E ainda não foi configurada. Peça à gerência para configurar em Cobrança → Importar do S4E.';
      }
    }
    const showForm = canManage && (state.s4eShowAccountForm || !account.configured);
    byId('s4eConnectBox')?.classList.toggle('hidden', !showForm);
    byId('s4eForgetBtn')?.classList.toggle('hidden', !canManage || !account.configured);
    byId('s4eDisconnectBtn')?.classList.toggle('hidden', !state.s4eConnected);
  }

  function s4eSetBusy(busy) {
    state.s4eBusy = busy;
    ['s4eConnectBtn', 's4ePreviewBtn', 's4eImportBtn', 's4eDisconnectBtn', 's4eForgetBtn'].forEach(id => {
      const el = byId(id);
      if (el) el.disabled = busy;
    });
  }

  async function s4eLoadStatus() {
    try {
      const data = await api('/api/s4e/status');
      state.s4eConnected = Boolean(data.connected);
      state.s4eUser = data.user || '';
      state.s4eAccount = data.account || {};
      state.s4eCanManage = Boolean(data.canManage);
      s4eRender();
      if (data.job && data.job.running && !state.s4eTimer) s4eHandleJob(data.job);
      return data;
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') s4eSetStatus(error.message, 'error');
      return null;
    }
  }

  async function openS4eDialog() {
    const dialog = byId('cobrancaS4eDialog');
    if (!dialog) return;
    state.s4eShowAccountForm = false;
    s4eSetStatus('Verificando o S4E...');
    byId('s4eProgressBox')?.classList.add('hidden');
    dialog.showModal();
    const data = await s4eLoadStatus();
    if (!data) return;
    if (data.job && data.job.running) return;
    const ready = state.s4eConnected || (data.account && data.account.configured);
    if (ready) {
      s4eSetStatus('Tudo pronto. Importando do S4E...');
      s4eStartImport(false);
      return;
    }
    s4eSetStatus(
      data.canManage
        ? 'Configure a conta do S4E uma vez para importar sem digitar senha.'
        : 'A conta do S4E ainda não foi configurada. Peça à gerência para configurar.'
    );
    byId('s4eAccountBox')?.setAttribute('open', '');
    byId('s4eConnectBox')?.classList.remove('hidden');
  }

  async function s4eConnect() {
    if (state.s4eBusy) return;
    const cpf = byId('s4eCpf')?.value.trim() || '';
    const password = byId('s4eSenha')?.value || '';
    if (!cpf || !password) {
      s4eSetStatus('Informe o CPF e a senha do S4E.', 'error');
      return;
    }
    s4eSetBusy(true);
    s4eSetStatus('Entrando no S4E...');
    try {
      const data = await api('/api/s4e/connect', {
        method: 'POST',
        body: JSON.stringify({ cpf, password, save: true }),
      });
      if (byId('s4eSenha')) byId('s4eSenha').value = '';
      state.s4eConnected = Boolean(data.connected);
      state.s4eUser = data.user || '';
      if (data.account) state.s4eAccount = data.account;
      state.s4eShowAccountForm = false;
      s4eRender();
      s4eSetStatus('Conta salva. Importando do S4E...', 'ok');
      s4eSetBusy(false);
      const status = await s4eLoadStatus();
      if (status && !(status.job && status.job.running)) s4eStartImport(false);
      return;
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') s4eSetStatus(error.message, 'error');
    }
    s4eSetBusy(false);
  }

  async function s4eDisconnect() {
    if (state.s4eBusy) return;
    s4eSetBusy(true);
    try {
      await api('/api/s4e/disconnect', { method: 'POST', body: '{}' });
      state.s4eConnected = false;
      state.s4eUser = '';
      s4eRender();
      s4eSetStatus('Sessão encerrada. O portal entra de novo sozinho na próxima importação.', 'ok');
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') s4eSetStatus(error.message, 'error');
    } finally {
      s4eSetBusy(false);
    }
  }

  async function s4eForget() {
    if (state.s4eBusy) return;
    const ok = window.confirm(
      'Remover a conta do S4E salva neste portal? A próxima importação vai pedir CPF e senha para a gerência.'
    );
    if (!ok) return;
    s4eSetBusy(true);
    try {
      const data = await api('/api/s4e/account/delete', { method: 'POST', body: '{}' });
      state.s4eAccount = data.account || {};
      state.s4eConnected = false;
      state.s4eUser = '';
      state.s4eShowAccountForm = Boolean(state.s4eCanManage);
      s4eRender();
      s4eSetStatus('Conta do S4E removida.', 'ok');
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') s4eSetStatus(error.message, 'error');
    } finally {
      s4eSetBusy(false);
    }
  }

  async function s4eStartImport(dryRun) {
    if (state.s4eBusy) return;
    s4eSetBusy(true);
    s4eSetStatus(dryRun ? 'Lendo o relatório para pré-visualizar...' : 'Iniciando a importação...');
    const progressBox = byId('s4eProgressBox');
    const progressBar = byId('s4eProgress');
    progressBox?.classList.remove('hidden');
    if (progressBar) progressBar.removeAttribute('value');
    const progressLabel = byId('s4eProgressLabel');
    if (progressLabel) progressLabel.textContent = 'Conectando ao S4E...';
    try {
      await api('/api/s4e/import', {
        method: 'POST',
        body: JSON.stringify({
          dryRun: Boolean(dryRun),
          withContacts: Boolean(byId('s4eContacts')?.checked),
          periodStart: byId('s4eFrom')?.value || '',
          periodEnd: byId('s4eTo')?.value || '',
        }),
      });
      s4ePoll();
    } catch (error) {
      progressBox?.classList.add('hidden');
      s4eSetBusy(false);
      if (error.message !== 'auth' && error.message !== 'locked') s4eSetStatus(error.message, 'error');
    }
  }

  function s4ePoll() {
    clearTimeout(state.s4eTimer);
    state.s4eTimer = setTimeout(async () => {
      try {
        const data = await api('/api/s4e/status');
        state.s4eConnected = Boolean(data.connected);
        state.s4eUser = data.user || '';
        if (data.account) state.s4eAccount = data.account;
        state.s4eCanManage = Boolean(data.canManage);
        s4eRender();
        if (data.job) s4eHandleJob(data.job);
      } catch (_) {
        s4eSetBusy(false);
        s4eSetStatus('Não foi possível acompanhar a importação. Atualize a tela para conferir.', 'error');
      }
    }, 800);
  }

  function s4eHandleJob(job) {
    if (job.running) {
      s4eSetBusy(true);
      s4eSetProgress(job);
      s4eSetStatus(job.message || 'Importando...');
      s4ePoll();
      return;
    }
    clearTimeout(state.s4eTimer);
    state.s4eTimer = null;
    s4eSetBusy(false);
    byId('s4eProgressBox')?.classList.add('hidden');
    if (job.error) {
      s4eSetStatus(job.error, 'error');
      if (state.s4eCanManage) {
        state.s4eShowAccountForm = true;
        byId('s4eAccountBox')?.setAttribute('open', '');
        s4eRender();
      }
      return;
    }
    const result = job.result;
    if (!result) return;
    if (result.dryRun) {
      const parts = [
        `${integer(result.titulos)} título(s)`,
        `${integer(result.empresas)} empresa(s)`,
        `total ${money(result.valor)}`,
      ];
      if (Number.isFinite(result.semEmail)) parts.push(`${integer(result.semEmail)} empresa(s) sem e-mail`);
      if (Number.isFinite(result.semWhatsapp)) parts.push(`${integer(result.semWhatsapp)} empresa(s) sem WhatsApp`);
      if (result.aviso) parts.push(result.aviso);
      s4eSetStatus(`Pré-visualização: ${parts.join(' · ')}.`, 'ok');
      return;
    }
    const parts = [
      `${integer(result.criados)} nova(s)`,
      `${integer(result.atualizados)} atualizada(s)`,
      `${integer(result.baixados)} baixada(s)`,
    ];
    if (result.semEmail) parts.push(`${integer(result.semEmail)} sem e-mail`);
    if (result.semWhatsapp) parts.push(`${integer(result.semWhatsapp)} sem WhatsApp`);
    notify(`Importação do S4E concluída: ${parts.join(' · ')}.`);
    byId('cobrancaS4eDialog')?.close();
    load();
  }

  // ── Modelo da mensagem ────────────────────────────────────────────────────
  function openModelDialog() {
    const dialog = byId('cobrancaTemplatesDialog');
    const host = byId('cobrancaTemplatesBody');
    if (!host) return;
    host.innerHTML = `
      <p class="cobranca-model-intro">A mensagem é montada automaticamente para cada empresa. O texto muda conforme o que ela deve:
      uma empresa com 3 mensalidades atrasadas recebe um texto diferente de outra com 7 meses e parcela de acordo.</p>
      <div class="cobranca-model-grid">
        <article class="cobranca-model-card">
          <span class="cobranca-model-step">1</span>
          <h4>Abertura</h4>
          <p><strong>Prezada, empresa {{empresa}}.</strong></p>
          <p>Conforme verificação em nosso sistema, identificamos que o(s) vencimento(s) abaixo encontram-se em aberto:</p>
          <p class="cobranca-muted">Para empresa com acordo, a abertura avisa que as parcelas do acordo também estão incluídas.</p>
        </article>
        <article class="cobranca-model-card">
          <span class="cobranca-model-step">2</span>
          <h4>Tabela consolidada</h4>
          <p>Competência e valor, uma linha por mês ou por parcela:</p>
          <ul>
            <li>Mensalidades de uma mesma competência somam em uma linha;</li>
            <li>Cada parcela do acordo aparece separada;</li>
            <li>Adesão, sindicato e outros valores entram com o nome do tipo;</li>
            <li>Empresa com vários cadastros recebe uma única tabela com tudo.</li>
          </ul>
        </article>
        <article class="cobranca-model-card">
          <span class="cobranca-model-step">3</span>
          <h4>Total e comprovante</h4>
          <p>O total em aberto aparece em destaque e, logo abaixo, o aviso:</p>
          <p class="cobranca-muted"><strong>Informação:</strong> o valor apresentado corresponde ao valor nominal dos títulos. O valor final do boleto pode apresentar diferença em razão de impostos, juros ou multas, conforme aplicável.</p>
          <p class="cobranca-muted">“Caso o pagamento já tenha sido realizado, desconsidere este aviso. Se o pagamento foi efetuado via depósito bancário, solicitamos o envio do comprovante.”</p>
        </article>
        <article class="cobranca-model-card">
          <span class="cobranca-model-step">4</span>
          <h4>Regularização e assinatura</h4>
          <p>“Se ainda não houve o pagamento, solicitamos a regularização o quanto antes para evitar o bloqueio automático dos atendimentos.”</p>
          <p><strong>Atenciosamente,<br>Equipe Faturamento</strong><br>Fixo: (85) 4141-3734<br>WhatsApp: (85) 99633-8854</p>
        </article>
      </div>
      <div class="cobranca-model-foot">
        <strong>Versão em HTML</strong>
        <span>O e-mail sai com cabeçalho colorido, cartões de resumo, tabela e botões de contato. No diálogo de cada empresa você pode ver a prévia exata antes de enviar.</span>
        <button class="button button-primary" type="button" id="cobrancaModelClose">Entendi</button>
      </div>`;
    byId('cobrancaModelClose')?.addEventListener('click', () => dialog?.close());
    if (dialog && !dialog.open) dialog.showModal();
  }

  // ── Diálogo da empresa ───────────────────────────────────────────────────
  function targetCase(company) {
    return (company.casosCobrar && company.casosCobrar[0]) || (company.casos && company.casos[0]) || null;
  }

  function senderLabel() {
    const graph = state.dialogGraph || {};
    const email = state.dialogEmail || {};
    if (graph.connected) return `Microsoft · ${graph.account || 'conta conectada'}`;
    if (email.configured) return `${email.fromName || 'Rede Saúde'} · ${email.fromEmail}`;
    return '';
  }

  function companyCanSend(company) {
    const sender = senderLabel();
    return Boolean(sender && company.podeCobrar && (company.emails || []).length && !state.sending);
  }

  function messageTabs(company) {
    const mensagem = company.mensagem || {};
    const count = (mensagem.entradas || []).length;
    const tab = state.dialogTab;
    return `<div class="cobranca-msg">
      <div class="cobranca-msg-head">
        <div class="cobranca-tabs" role="tablist">
          <button type="button" class="cobranca-tab${tab === 'preview' ? ' is-active' : ''}" data-msg-tab="preview">Prévia do e-mail</button>
          <button type="button" class="cobranca-tab${tab === 'text' ? ' is-active' : ''}" data-msg-tab="text">Texto</button>
          <button type="button" class="cobranca-tab${tab === 'titles' ? ' is-active' : ''}" data-msg-tab="titles">Títulos (${integer(count)})</button>
        </div>
        <span class="cobranca-muted">Assunto: ${esc(mensagem.subject || '—')}</span>
      </div>
      <div class="cobranca-msg-panel" data-msg-panel="preview"${tab === 'preview' ? '' : ' hidden'}>
        <iframe class="cobranca-preview-frame" id="cobrancaPreviewFrame" title="Prévia do e-mail"></iframe>
      </div>
      <div class="cobranca-msg-panel" data-msg-panel="text"${tab === 'text' ? '' : ' hidden'}>
        <pre class="cobranca-text-preview">${esc(mensagem.text || '')}</pre>
      </div>
      <div class="cobranca-msg-panel" data-msg-panel="titles"${tab === 'titles' ? '' : ' hidden'}>
        ${renderEntries(company)}
      </div>
    </div>`;
  }

  function renderEntries(company) {
    const entradas = (company.mensagem || {}).entradas || [];
    if (!entradas.length) return '<p class="empty-state">Nenhum título a cobrar nesta empresa.</p>';
    return `<table class="finance-table cobranca-titles-table">
      <thead><tr><th>Competência / referência</th><th>Detalhe</th><th>Vencimento</th><th class="num">Valor</th></tr></thead>
      <tbody>${entradas.map(entry => `<tr>
        <td><strong>${esc(entry.titulo || '—')}</strong></td>
        <td>${esc(entry.detalhe || '—')}</td>
        <td>${esc(dateLabel(entry.vencimento))}</td>
        <td class="num"><span class="finance-money">${esc(money(entry.valor))}</span></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3"><strong>Total</strong></td><td class="num"><strong>${esc(money((company.mensagem || {}).total || 0))}</strong></td></tr></tfoot>
    </table>
    <details class="cobranca-cadastros-details">
      <summary>Ver os ${integer(company.casos.length)} título(s) e ${integer(company.cadastros)} cadastro(s) do S4E</summary>
      <div class="cobranca-cadastros-list">${(company.clientes || []).map(item => `<span class="cobranca-cadastro-chip" title="${esc(item.cliente)}">${esc(item.cliente)}<small>${integer(item.cases)} título(s) · ${esc(money(item.total))}</small></span>`).join('')}</div>
      <div class="cobranca-titles-scroll">
        <table class="finance-table">
          <thead><tr><th>Cadastro</th><th>Tipo</th><th>Competência</th><th>Vencimento</th><th class="num">Valor</th>${state.canDelete ? '<th></th>' : ''}</tr></thead>
          <tbody>${(company.casos || []).map(item => `<tr>
            <td>${esc(item.cliente)}</td>
            <td>${esc(item.tipoLabel)}${item.parcela ? ` · ${esc(item.parcela)}` : ''}</td>
            <td>${esc(item.competencia || '—')}</td>
            <td>${esc(dateLabel(item.vencimento))}</td>
            <td class="num">${esc(money(item.valor))}</td>
            ${state.canDelete ? `<td><button class="cobranca-icon-delete" type="button" data-delete-case="${esc(item.id)}" title="Apagar este título do portal" aria-label="Apagar este título do portal">🗑</button></td>` : ''}
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </details>`;
  }

  function sendBlock(company) {
    const emails = company.emails || [];
    const phones = company.phones || [];
    const cc = company.cc || [];
    const ignorados = company.emailsIgnorados || [];
    const sender = senderLabel();
    const canSend = companyCanSend(company);
    return `<div class="cobranca-send">
      <div class="cobranca-send-grid">
        <label class="cobranca-field-inline">E-mail de destino
          <input id="cobrancaCompanyTo" type="email" list="cobrancaCompanyEmails" value="${esc(emails[0] || '')}" placeholder="sem e-mail no S4E">
          <datalist id="cobrancaCompanyEmails">${emails.map(email => `<option value="${esc(email)}"></option>`).join('')}</datalist>
        </label>
        <label class="cobranca-field-inline">Assunto
          <input id="cobrancaCompanySubject" type="text" maxlength="200" value="${esc((company.mensagem || {}).subject || '')}">
        </label>
        <label class="cobranca-field-inline">WhatsApp
          <select id="cobrancaCompanyPhone"${phones.length ? '' : ' disabled'}>
            ${phones.length ? phones.map(phone => `<option value="${esc(phone)}">${esc(phone)}</option>`).join('') : '<option value="">sem WhatsApp no S4E</option>'}
          </select>
        </label>
      </div>
      ${cc.length
        ? `<div class="cobranca-send-cc"><strong>Em cópia neste envio</strong>${cc.map(email => `<span class="cobranca-cc-chip">${esc(email)}</span>`).join('')}</div>`
        : `<p class="cobranca-send-cc-empty">Nenhuma cópia configurada para ${company.grupo ? `o grupo <strong>${esc(company.grupo)}</strong>` : 'esta empresa'}. Ajuste em <strong>Cópias por grupo</strong>.</p>`}
      <div class="cobranca-send-actions">
        <button class="button button-primary" type="button" id="cobrancaCompanySend"${canSend ? '' : ' disabled'}>${state.sending ? 'Enviando...' : 'Enviar e-mail agora'}</button>
        <button class="button button-secondary" type="button" id="cobrancaCompanyWhats"${phones.length ? '' : ' disabled'}>Abrir WhatsApp</button>
        <button class="button button-secondary" type="button" id="cobrancaCompanyCopy">Copiar texto</button>
      </div>
      <p class="cobranca-muted">${sender
        ? `Envio por ${esc(sender)}. O que for enviado fica registrado no histórico de todos os títulos desta empresa.`
        : 'A conta de envio ainda não está configurada. Conecte a conta Microsoft em <strong>Cobrar todos por e-mail</strong> para enviar direto daqui.'}</p>
      ${!emails.length ? '<p class="cobranca-warn">Esta empresa está sem e-mail no S4E. Atualize a ficha da empresa e importe novamente, ou use o WhatsApp.</p>' : ''}
      ${ignorados.length ? `<p class="cobranca-muted cobranca-ignored-note">E-mails internos da Rede Saúde ignorados no S4E: ${ignorados.map(email => esc(email)).join(', ')}.</p>` : ''}
    </div>`;
  }

  function renderCompanyDialog() {
    const company = state.dialogCompany;
    const host = byId('cobrancaDialogBody');
    if (!company || !host) return;
    byId('cobrancaDialogTitle').textContent = company.nome || 'Cobrança da empresa';
    const valorAberto = Number(company.total) || 0;
    const valorCobrar = Number(company.totalCobrar) || 0;
    const blocked = company.bloqueada;
    host.innerHTML = `
      <div class="cobranca-case-head">
        <div>
          <p class="cobranca-case-sub">${esc(company.documento || 'sem CNPJ')} · ${integer(company.cadastros)} ${plural(company.cadastros, 'cadastro', 'cadastros')}${company.grupo ? ` · Grupo ${esc(company.grupo)}` : ''}</p>
          <div class="cobranca-case-badges cobranca-case-badges-left">${compositionChips(company)}</div>
        </div>
        <div class="cobranca-case-badges">
          ${blocked ? blockedBadge(company) : `<span class="cobranca-status is-${esc(statusTone(company.status))}">${esc(company.statusLabel)}</span>`}
          ${company.temAcordo && !blocked ? '<span class="cobranca-tipo">Com acordo</span>' : ''}
        </div>
      </div>
      <div class="cobranca-facts">
        <div><span>Valor em aberto</span><strong>${esc(money(valorAberto))}</strong><small>${blocked ? 'não cobrar' : `${esc(money(valorCobrar))} a cobrar`}</small></div>
        <div><span>Títulos</span><strong>${integer(company.cases)}</strong><small>${integer(company.casesCobrar)} a cobrar</small></div>
        <div><span>Vencimento mais antigo</span><strong>${esc(dateLabel(company.vencimento))}</strong><small>${integer(company.diasAtraso)} dia(s) em atraso</small></div>
        <div><span>Cadastros</span><strong>${integer(company.cadastros)}</strong><small>mesma empresa / CNPJ</small></div>
        <div><span>Contatos feitos</span><strong>${integer(company.contactCount)}</strong><small>${company.lastContactAt ? `último ${esc(dateTimeLabel(company.lastContactAt))}` : 'nunca'}</small></div>
        <div><span>Próximo contato</span><strong>${company.nextContact ? esc(dateLabel(company.nextContact)) : '—'}</strong><small>${esc(company.lastSeen ? `dados do S4E de ${dateLabel(company.lastSeen)}` : 'origem S4E')}</small></div>
      </div>
      ${blocked
        ? `<p class="cobranca-warn cobranca-deposito-note"><strong>${esc(company.statusLabel)}.</strong> ${esc(company.motivo || 'Esta empresa não pode ser cobrada.')} Ela continua na fila e no histórico — use o registro abaixo para anotar qualquer contato.</p>`
        : messageTabs(company)}
      ${blocked ? '' : sendBlock(company)}
      <div id="cobrancaFollowup" class="cobranca-followup"></div>
      <div id="cobrancaStatusRow" class="cobranca-status-row"></div>
      <h4 class="cobranca-history-title">Histórico de contatos</h4>
      <ul id="cobrancaHistory" class="cobranca-history"></ul>
      <h4 class="cobranca-history-title">Envios registrados</h4>
      <ul id="cobrancaSendsList" class="cobranca-sends"></ul>
      ${state.canDelete ? `<div class="cobranca-danger-zone">
        <div><strong>Excluir da fila</strong><span>Apaga os títulos desta empresa do portal (e o histórico de contatos). Nada é alterado no S4E.</span></div>
        <button class="button button-danger" type="button" id="cobrancaCompanyDelete">Excluir empresa da fila</button>
      </div>` : ''}`;
    const frame = byId('cobrancaPreviewFrame');
    if (frame) frame.srcdoc = (company.mensagem || {}).html || '<p style="font-family:sans-serif;padding:20px">Sem prévia.</p>';
    host.querySelectorAll('[data-msg-tab]').forEach(button => {
      button.addEventListener('click', () => {
        state.dialogTab = button.dataset.msgTab;
        host.querySelectorAll('[data-msg-tab]').forEach(item => item.classList.toggle('is-active', item === button));
        host.querySelectorAll('[data-msg-panel]').forEach(panel => { panel.hidden = panel.dataset.msgPanel !== state.dialogTab; });
      });
    });
    if (!blocked) {
      byId('cobrancaCompanySend')?.addEventListener('click', sendCompanyEmail);
      byId('cobrancaCompanyWhats')?.addEventListener('click', openCompanyWhatsApp);
      byId('cobrancaCompanyCopy')?.addEventListener('click', copyCompanyMessage);
    }
    renderFollowup();
    renderStatusRow();
    renderHistory();
    renderCompanySends();
  }

  async function openCompany(key) {
    if (!key) return;
    const dialog = byId('cobrancaDialog');
    try {
      const data = await api(`/api/cobranca/empresa?key=${encodeURIComponent(key)}`);
      state.dialogCompany = data.company;
      state.dialogHistory = data.history || [];
      state.dialogSends = data.sends || [];
      state.dialogGraph = data.graph || {};
      state.dialogEmail = data.email || {};
      state.dialogTab = 'preview';
      renderCompanyDialog();
      if (dialog && !dialog.open) dialog.showModal();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function refreshCompany() {
    const company = state.dialogCompany;
    if (!company) return;
    try {
      const data = await api(`/api/cobranca/empresa?key=${encodeURIComponent(company.key)}`);
      state.dialogCompany = data.company;
      state.dialogHistory = data.history || [];
      state.dialogSends = data.sends || [];
      state.dialogGraph = data.graph || {};
      state.dialogEmail = data.email || {};
      renderCompanyDialog();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function logContact(payload) {
    const company = state.dialogCompany;
    const item = company ? targetCase(company) : null;
    if (!item) return null;
    const data = await api(`/api/cobranca/${encodeURIComponent(item.id)}/interaction`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (data && data.history) state.dialogHistory = data.history;
    return data;
  }

  async function deleteCase(caseId) {
    if (!caseId) return;
    const confirmed = window.confirm(
      'Apagar este título da fila de cobrança?\n\n'
      + 'Ele sai do portal (e do histórico de contatos desse título), mas continua no S4E. '
      + 'Esta ação não pode ser desfeita.'
    );
    if (!confirmed) return;
    try {
      await api(`/api/cobranca/${encodeURIComponent(caseId)}`, { method: 'DELETE', body: '{}' });
      notify('Título apagado da fila.');
      if (state.dialogCompany) await refreshCompany();
      load();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function deleteCompany(key) {
    if (!key) return;
    const company = state.dialogCompany?.key === key
      ? state.dialogCompany
      : (state.items || []).find(item => item.key === key);
    const nome = company?.nome || 'esta empresa';
    const titulos = Number(company?.cases || (company?.casos || []).length) || 0;
    const confirmed = window.confirm(
      `Apagar ${nome} da fila de cobrança?\n\n`
      + `${titulos ? `${integer(titulos)} título(s) e o histórico de contatos ` : 'Todos os títulos e o histórico de contatos '}`
      + 'serão removidos do portal. O S4E não é alterado e esta ação não pode ser desfeita.'
    );
    if (!confirmed) return;
    try {
      const data = await api('/api/cobranca/empresa/delete', {
        method: 'POST',
        body: JSON.stringify({ key }),
      });
      notify(`${nome}: ${integer(data.cases)} título(s) apagado(s) da fila.`);
      if (state.dialogCompany?.key === key) byId('cobrancaDialog')?.close();
      load();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function clearAll() {
    const first = window.confirm(
      'Limpar TODAS as cobranças do portal?\n\n'
      + 'Isso apaga a fila de empresas, todo o histórico de contatos e o registro das importações. '
      + 'Os modelos de mensagem e as cópias por grupo continuam salvos. O S4E não é alterado.\n\n'
      + 'Esta ação não pode ser desfeita.'
    );
    if (!first) return;
    const typed = window.prompt('Para confirmar, digite LIMPAR:');
    if (String(typed || '').trim().toUpperCase() !== 'LIMPAR') {
      notify('Limpeza cancelada.', 'warning');
      return;
    }
    try {
      const data = await api('/api/cobranca/clear', { method: 'POST', body: '{}' });
      notify(`Cobranças apagadas: ${integer(data.cases)} título(s) e ${integer(data.imports)} importação(ões).`);
      byId('cobrancaDialog')?.close();
      load();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function sendCompanyEmail() {
    const company = state.dialogCompany;
    if (!company || state.sending) return;
    const to = (byId('cobrancaCompanyTo')?.value || '').trim();
    const subject = (byId('cobrancaCompanySubject')?.value || '').trim();
    if (!to) {
      notify('Informe o e-mail que deve receber a cobrança.', 'warning');
      return;
    }
    const confirmed = window.confirm(
      `Enviar a cobrança para ${company.nome}?\n\n`
      + `Para: ${to}\n`
      + `Títulos: ${integer(company.casesCobrar)} · valor: ${money(company.totalCobrar)}.\n\n`
      + 'O envio é real e fica registrado no histórico de todos os títulos desta empresa.'
    );
    if (!confirmed) return;
    state.sending = true;
    renderCompanyDialog();
    try {
      const data = await api('/api/cobranca/empresa/send', {
        method: 'POST',
        body: JSON.stringify({ key: company.key, to, subject }),
      });
      notify(`E-mail enviado para ${data.to} · ${integer(data.cases)} título(s) · ${money(data.value)}.`);
      await refreshCompany();
      load();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    } finally {
      state.sending = false;
      renderCompanyDialog();
    }
  }

  async function openCompanyWhatsApp() {
    const company = state.dialogCompany;
    if (!company) return;
    const phone = byId('cobrancaCompanyPhone')?.value || (company.phones || [])[0] || '';
    const digits = phoneDigits(phone);
    if (!digits) {
      notify('Esta empresa não tem WhatsApp válido no S4E.', 'warning');
      return;
    }
    const text = (company.mensagem || {}).text || '';
    if (!text) {
      notify('Não foi possível montar a mensagem desta empresa.', 'warning');
      return;
    }
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    try {
      await logContact({
        channel: 'whatsapp',
        result: 'enviado',
        notes: `WhatsApp aberto para ${phone} com a cobrança consolidada da empresa.`,
      });
      await refreshCompany();
      load();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function copyCompanyMessage() {
    const company = state.dialogCompany;
    const text = (company?.mensagem || {}).text || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify('Mensagem copiada.');
    } catch (_) {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      notify('Mensagem copiada.');
    }
  }

  function renderFollowup() {
    const host = byId('cobrancaFollowup');
    if (!host) return;
    const company = state.dialogCompany;
    const labels = state.resultLabels || {};
    const results = ['enviado', 'prometeu', 'sem_resposta', 'contato_invalido', 'negociou', 'pagou', 'outro'];
    host.innerHTML = `
      <h4>Como foi o contato?</h4>
      <div class="cobranca-followup-grid">
        <label class="cobranca-field-inline">Resultado
          <select id="cobrancaResult">
            ${results.map(key => `<option value="${key}"${key === 'prometeu' ? ' selected' : ''}>${esc(labels[key] || key)}</option>`).join('')}
          </select>
        </label>
        <label class="cobranca-field-inline">Próximo contato
          <input id="cobrancaNextContact" type="date" value="${esc(company?.nextContact || '')}">
        </label>
        <label class="cobranca-field-inline cobranca-notes-field">Anotação
          <input id="cobrancaNotesInput" type="text" maxlength="2000" placeholder="Ex.: pediu até sexta, vai enviar comprovante...">
        </label>
        <button class="button button-primary" type="button" id="cobrancaFollowupSave">Registrar contato</button>
      </div>`;
    byId('cobrancaFollowupSave')?.addEventListener('click', async () => {
      const result = byId('cobrancaResult')?.value || 'outro';
      const nextContact = byId('cobrancaNextContact')?.value || '';
      const notes = byId('cobrancaNotesInput')?.value || '';
      try {
        await logContact({ channel: 'manual', result, nextContact, notes, count: false });
        notify('Contato registrado no histórico.');
        await refreshCompany();
        load();
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
      }
    });
  }

  function renderStatusRow() {
    const host = byId('cobrancaStatusRow');
    if (!host) return;
    const company = state.dialogCompany;
    const labels = state.statusLabels || {};
    const cases = (company?.casosCobrar?.length ? company.casosCobrar : company?.casos) || [];
    const current = company?.status || 'aberto';
    host.innerHTML = `
      <label class="cobranca-field-inline">Situação no portal
        <select id="cobrancaStatusSelect">
          ${Object.keys(labels).map(key => `<option value="${key}"${current === key ? ' selected' : ''}>${esc(labels[key])}</option>`).join('')}
        </select>
      </label>
      <button class="button button-secondary" type="button" id="cobrancaStatusSave">Salvar na empresa toda</button>
      <span class="cobranca-muted">Aplica a ${integer(cases.length)} título(s). “Baixado” e “Encerrado” saem da fila.</span>`;
    byId('cobrancaStatusSave')?.addEventListener('click', async () => {
      const status = byId('cobrancaStatusSelect')?.value || '';
      if (!cases.length) return;
      try {
        for (const item of cases) {
          await api(`/api/cobranca/${encodeURIComponent(item.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ status }),
          });
        }
        notify(`Situação atualizada em ${integer(cases.length)} título(s).`);
        await refreshCompany();
        load();
      } catch (error) {
        if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
      }
    });
  }

  function renderHistory() {
    const host = byId('cobrancaHistory');
    if (!host) return;
    const items = state.dialogHistory || [];
    if (!items.length) {
      host.innerHTML = '<li class="cobranca-history-empty">Nenhum contato registrado ainda.</li>';
      return;
    }
    const icons = { email: '✉', whatsapp: '☎', telefone: '☎', sistema: '⚙', manual: '✎' };
    host.innerHTML = items.map(entry => `
      <li class="cobranca-history-item">
        <span class="cobranca-history-icon">${esc(icons[entry.channel] || '•')}</span>
        <div>
          <strong>${esc(entry.resultLabel)}</strong>
          <span class="cobranca-muted"> · ${esc(dateTimeLabel(entry.at))} · ${esc(entry.userName || '—')}</span>
          ${entry.notes ? `<p class="cobranca-history-notes">${esc(entry.notes)}</p>` : ''}
          ${Number(entry.caseCount) > 1 ? `<p class="cobranca-history-titles">${integer(entry.caseCount)} títulos neste envio${entry.titles?.length ? `: ${esc(entry.titles.join(' · '))}` : ''}</p>` : ''}
          ${entry.nextContact ? `<span class="finance-sub">retorno em ${esc(dateLabel(entry.nextContact))}</span>` : ''}
        </div>
      </li>`).join('');
  }

  // ── Registro de envios (auditoria) ───────────────────────────────────────
  const sendsState = { items: [], total: 0, search: '', status: '', loading: false, timer: null };

  function sendStatusBadge(entry) {
    return entry.status === 'enviado'
      ? '<span class="cobranca-send-badge is-ok">Enviado</span>'
      : '<span class="cobranca-send-badge is-fail">Falhou</span>';
  }

  function sendChannelLabel(entry) {
    if (entry.channel === 'smtp') return 'SMTP';
    if (entry.channel === 'historico') return 'Histórico de contatos';
    return 'Microsoft';
  }

  function sendItem(entry, withCompany) {
    const copies = (entry.cc || []).filter(Boolean);
    return `<li class="cobranca-send-item">
      <div class="cobranca-send-top">
        <strong>${esc(withCompany ? (entry.company || entry.email) : entry.email)}</strong>
        ${sendStatusBadge(entry)}
      </div>
      <p class="cobranca-send-meta">${esc(dateTimeLabel(entry.at))} · ${esc(entry.kindLabel)} · ${esc(sendChannelLabel(entry))}${entry.userName ? ` · ${esc(entry.userName)}` : ''}</p>
      ${withCompany && entry.documento ? `<p class="cobranca-send-meta">${esc(entry.documento)}</p>` : ''}
      ${withCompany && entry.email !== entry.company ? `<p class="cobranca-send-meta">Para: ${esc(entry.email)}</p>` : ''}
      ${copies.length ? `<p class="cobranca-send-meta">Cópia: ${esc(copies.join(', '))}</p>` : ''}
      ${entry.cases ? `<p class="cobranca-send-meta">${integer(entry.cases)} título(s) · ${esc(money(entry.value))}</p>` : ''}
      ${entry.error ? `<p class="cobranca-send-error">${esc(entry.error)}</p>` : ''}
      ${entry.imported ? '<p class="cobranca-send-meta">Reconstruído do histórico de contatos: sem referência do provedor.</p>' : ''}
      ${entry.providerRef ? `<p class="cobranca-send-ref">Referência do provedor: <code>${esc(entry.providerRef)}</code></p>` : ''}
    </li>`;
  }

  function renderCompanySends() {
    const host = byId('cobrancaSendsList');
    if (!host) return;
    const items = state.dialogSends || [];
    if (!items.length) {
      host.innerHTML = '<li class="cobranca-history-empty">Nenhum envio registrado ainda.</li>';
      return;
    }
    host.innerHTML = items.map(entry => sendItem(entry, false)).join('');
  }

  async function openSendsDialog() {
    const dialog = byId('cobrancaSendsDialog');
    const host = byId('cobrancaSendsBody');
    if (!host) return;
    sendsState.search = '';
    sendsState.status = '';
    host.innerHTML = '<p class="cobranca-muted">Carregando os envios...</p>';
    if (dialog && !dialog.open) dialog.showModal();
    await loadSends();
  }

  async function loadSends() {
    if (sendsState.loading) return;
    sendsState.loading = true;
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (sendsState.search) params.set('search', sendsState.search);
      if (sendsState.status) params.set('status', sendsState.status);
      const data = await api(`/api/cobranca/envios?${params.toString()}`);
      sendsState.items = data.sends || [];
      sendsState.total = Number(data.total) || 0;
      renderSendsDialog();
    } catch (error) {
      const host = byId('cobrancaSendsBody');
      if (host) host.innerHTML = `<p class="cobranca-send-error">${esc(error.message || 'Não foi possível carregar os envios.')}</p>`;
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    } finally {
      sendsState.loading = false;
    }
  }

  function renderSendsResults() {
    const host = byId('cobrancaSendsResults');
    if (!host) return;
    const items = sendsState.items || [];
    const enviados = items.filter(item => item.status === 'enviado').length;
    const falhas = items.filter(item => item.status === 'falha').length;
    const titulos = items.reduce((total, item) => total + (item.status === 'enviado' ? Number(item.cases) || 0 : 0), 0);
    const summary = byId('cobrancaSendsSummary');
    if (summary) {
      summary.textContent = `${integer(enviados)} enviado(s) · ${integer(falhas)} falha(s) · ${integer(titulos)} título(s) nesta lista`
        + (sendsState.total > items.length ? ` · mostrando os ${integer(items.length)} mais recentes de ${integer(sendsState.total)}` : '');
    }
    if (items.length) {
      host.innerHTML = `<ul class="cobranca-sends">${items.map(entry => sendItem(entry, true)).join('')}</ul>`;
      return;
    }
    const semFiltro = !sendsState.search && !sendsState.status;
    host.innerHTML = semFiltro
      ? '<p class="empty-state">Nenhum envio registrado ainda.</p>'
      : '<p class="empty-state">Nenhum envio registrado com esse filtro.</p>';
  }

  function renderSendsDialog() {
    const host = byId('cobrancaSendsBody');
    if (!host) return;
    if (!byId('cobrancaSendsResults')) {
      host.innerHTML = `
        <p class="cobranca-model-intro">Cada e-mail realmente entregue ao provedor (ou recusado) aparece aqui com data, destinatários, títulos e a referência usada no suporte. Os envios anteriores a esta versão foram reconstruídos do histórico de contatos e aparecem como “Histórico de contatos”. É só leitura: nada é reenviado e o S4E não é alterado.</p>
        <div class="cobranca-sends-tools">
          <input id="cobrancaSendsSearch" type="search" placeholder="Buscar empresa, CNPJ ou e-mail" autocomplete="off">
          <select id="cobrancaSendsStatus">
            <option value="">Todos os resultados</option>
            <option value="enviado">Só enviados</option>
            <option value="falha">Só falhas</option>
          </select>
        </div>
        <p class="cobranca-sends-summary" id="cobrancaSendsSummary"></p>
        <div id="cobrancaSendsResults"></div>`;
      byId('cobrancaSendsSearch')?.addEventListener('input', event => {
        sendsState.search = event.target.value;
        clearTimeout(sendsState.timer);
        sendsState.timer = setTimeout(loadSends, 320);
      });
      byId('cobrancaSendsStatus')?.addEventListener('change', event => {
        sendsState.status = event.target.value;
        loadSends();
      });
    }
    renderSendsResults();
  }

  // ── Cópias (CC) por grupo de empresa ─────────────────────────────────────
  const groupsState = { groups: [], canManage: false, saving: false };

  async function openGroupsDialog() {
    const dialog = byId('cobrancaGroupsDialog');
    const host = byId('cobrancaGroupsBody');
    if (!host) return;
    host.innerHTML = '<p class="cobranca-muted">Carregando os grupos de empresa...</p>';
    if (dialog && !dialog.open) dialog.showModal();
    try {
      const data = await api('/api/cobranca/grupos');
      groupsState.groups = data.groups || [];
      groupsState.canManage = Boolean(data.canManage);
      renderGroupsDialog();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
      dialog?.close();
    }
  }

  function renderGroupsDialog() {
    const host = byId('cobrancaGroupsBody');
    if (!host) return;
    const groups = groupsState.groups || [];
    host.innerHTML = `
      <p class="cobranca-model-intro">Os e-mails em cópia são somados a <strong>cada</strong> cobrança enviada para empresas do grupo. Separe vários endereços por vírgula ou por linha. Endereços internos da Rede Saúde também podem ser usados em cópia — eles nunca recebem cobrança como destinatário.</p>
      ${groups.length ? `<div class="cobranca-groups-list">${groups.map(group => `
        <article class="cobranca-group-card" data-group-name="${esc(group.name)}">
          <header>
            <strong>${esc(group.name)}</strong>
            <span>${integer(group.empresas)} ${plural(group.empresas, 'empresa', 'empresas')}</span>
            ${group.emails?.length ? `<span class="cobranca-group-badge">${integer(group.emails.length)} cópia(s)</span>` : '<span class="cobranca-group-badge is-empty">sem cópia</span>'}
          </header>
          <textarea data-group-emails rows="2" placeholder="email1@empresa.com, email2@empresa.com"${groupsState.canManage ? '' : ' disabled'}>${esc((group.emails || []).join(', '))}</textarea>
        </article>`).join('')}</div>`
        : '<p class="empty-state">Nenhum grupo de empresa encontrado na fila do S4E. Importe o relatório para ver os grupos.</p>'}
      <div class="cobranca-group-new">
        <label class="cobranca-field-inline">Adicionar grupo que ainda não está na fila
          <input id="cobrancaNewGroupName" type="text" maxlength="160" placeholder="Nome do grupo no S4E"${groupsState.canManage ? '' : ' disabled'}>
        </label>
        <label class="cobranca-field-inline">Cópias deste grupo
          <input id="cobrancaNewGroupEmails" type="text" placeholder="email1@empresa.com, email2@empresa.com"${groupsState.canManage ? '' : ' disabled'}>
        </label>
      </div>
      <div class="cobranca-group-foot">
        <span class="cobranca-muted">${groupsState.canManage
          ? 'As cópias entram em todos os envios do grupo — individual ou em lote.'
          : 'Só a gerência pode alterar as cópias por grupo. Você pode consultar os endereços aqui.'}</span>
        ${groupsState.canManage ? `<button class="button button-primary" type="button" id="cobrancaGroupsSave"${groupsState.saving ? ' disabled' : ''}>${groupsState.saving ? 'Salvando...' : 'Salvar cópias'}</button>` : ''}
      </div>`;
    byId('cobrancaGroupsSave')?.addEventListener('click', saveGroupsDialog);
  }

  async function saveGroupsDialog() {
    const host = byId('cobrancaGroupsBody');
    if (!host || groupsState.saving) return;
    const groups = [];
    host.querySelectorAll('[data-group-name]').forEach(card => {
      groups.push({
        name: card.dataset.groupName,
        emails: (card.querySelector('[data-group-emails]')?.value || '').split(/[\s,;]+/).filter(Boolean),
      });
    });
    const newName = (byId('cobrancaNewGroupName')?.value || '').trim();
    const newEmails = (byId('cobrancaNewGroupEmails')?.value || '').split(/[\s,;]+/).filter(Boolean);
    if (newName && newEmails.length) groups.push({ name: newName, emails: newEmails });
    groupsState.saving = true;
    renderGroupsDialog();
    try {
      const data = await api('/api/cobranca/grupos', { method: 'POST', body: JSON.stringify({ groups }) });
      groupsState.groups = data.groups || [];
      groupsState.saving = false;
      renderGroupsDialog();
      const ignored = data.ignored || [];
      if (ignored.length) {
        notify(`Cópias salvas, mas ${integer(ignored.length)} endereço(s) inválido(s) foram ignorados: ${ignored.slice(0, 3).map(item => item.email).join(', ')}${ignored.length > 3 ? '…' : ''}`, 'warning');
      } else {
        notify('Cópias por grupo salvas.');
      }
      load();
      if (byId('cobrancaDialog')?.open) refreshCompany();
    } catch (error) {
      groupsState.saving = false;
      renderGroupsDialog();
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  // ── Cobrança em lote por e-mail ───────────────────────────────────────────
  const bulkState = {
    plan: null,
    email: null,
    graph: null,
    canManage: false,
    skipToday: true,
    skipDueToday: true,
    sending: false,
    result: null,
    graphTimer: null,
    selection: new Map(),
    filter: '',
    filters: null,
    facets: { tipos: [], groups: [] },
    expanded: new Set(),
    details: new Map(),
    detailGen: 0,
    previewKey: '',
    filterTimer: null,
  };

  function bulkFiltersFromScreen() {
    return {
      search: state.search || '',
      tipo: state.tipo || '',
      grupo: state.grupo || '',
      contato: state.contato || '',
      deposito: state.deposito || '',
      from: state.from || '',
      to: state.to || '',
    };
  }

  function bulkFilterParams() {
    const filters = bulkState.filters || {};
    const params = new URLSearchParams();
    params.set('mode', 'empresas');
    params.set('status', 'ativos');
    if ((filters.search || '').trim()) params.set('search', filters.search.trim());
    if (filters.tipo) params.set('tipo', filters.tipo);
    if (filters.grupo) params.set('grupo', filters.grupo);
    if (filters.contato) params.set('contato', filters.contato);
    if (filters.deposito) params.set('deposito', filters.deposito);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    params.set('sort', 'venc_asc');
    return params;
  }

  function bulkTipoLabel(value) {
    const item = (bulkState.facets.tipos || state.tipos || []).find(entry => (entry.value || '') === value);
    return item ? item.label : (tipoFilterLabel(value) || value);
  }

  function bulkActiveFilters() {
    const filters = bulkState.filters || {};
    const list = [];
    if ((filters.search || '').trim()) list.push({ key: 'search', kind: 'Pesquisa', label: filters.search.trim(), isSearch: true });
    if (filters.grupo) list.push({ key: 'grupo', kind: 'Grupo', label: filters.grupo });
    if (filters.tipo) list.push({ key: 'tipo', kind: 'Tipo', label: bulkTipoLabel(filters.tipo) });
    if (filters.contato) list.push({ key: 'contato', kind: 'Contato', label: CONTATO_LABELS[filters.contato] || filters.contato });
    if (filters.deposito) list.push({ key: 'deposito', kind: 'Cobrança', label: DEPOSITO_LABELS[filters.deposito] || filters.deposito });
    if (filters.from) list.push({ key: 'from', kind: 'Vence de', label: dateLabel(filters.from) });
    if (filters.to) list.push({ key: 'to', kind: 'Vence até', label: dateLabel(filters.to) });
    return list;
  }

  function bulkFiltersHtml() {
    const filters = bulkState.filters || {};
    const active = bulkActiveFilters();
    const facetGroups = bulkState.facets.groups?.length ? bulkState.facets.groups : (state.groups || []);
    const facetTipos = bulkState.facets.tipos?.length ? bulkState.facets.tipos : (state.tipos || []);
    const groupOptions = facetGroups.map(item =>
      `<option value="${esc(item.name || '')}"${filters.grupo === item.name ? ' selected' : ''}>${esc(item.name)} (${integer(item.total)})</option>`
    ).join('');
    const tipoOptions = facetTipos.map(item =>
      `<option value="${esc(item.value || '')}"${filters.tipo === item.value ? ' selected' : ''}>${esc(item.label)} (${integer(item.total)})</option>`
    ).join('');
    return `<div class="cobranca-lote-filters">
      <div class="cobranca-lote-filters-head">
        <div>
          <strong>Filtros deste lote</strong>
          <span>Escolha quem entra neste envio. O lote usa apenas estes filtros.</span>
        </div>
        <div class="cobranca-lote-filter-actions">
          <button class="button button-secondary" type="button" id="cobrancaLoteUseScreen">Usar filtros da tela</button>
          <button class="button button-secondary" type="button" id="cobrancaLoteFilterClear"${active.length ? '' : ' disabled'}>Limpar filtros</button>
        </div>
      </div>
      <div class="cobranca-lote-filter-grid">
        <label class="cobranca-field-inline cobranca-lote-filter-search">Pesquisar
          <input id="cobrancaLoteSearch" type="search" value="${esc(filters.search || '')}" placeholder="Empresa, CNPJ ou grupo" autocomplete="off">
        </label>
        <label class="cobranca-field-inline">Grupo
          <select id="cobrancaLoteGrupo"><option value="">Todos os grupos</option>${groupOptions}</select>
        </label>
        <label class="cobranca-field-inline">Tipo
          <select id="cobrancaLoteTipo"><option value="">Todos os tipos</option>${tipoOptions}</select>
        </label>
        <label class="cobranca-field-inline">Contato
          <select id="cobrancaLoteContato">
            <option value="">Qualquer contato</option>
            <option value="com_email"${filters.contato === 'com_email' ? ' selected' : ''}>Com e-mail</option>
            <option value="sem_email"${filters.contato === 'sem_email' ? ' selected' : ''}>Sem e-mail</option>
            <option value="com_whatsapp"${filters.contato === 'com_whatsapp' ? ' selected' : ''}>Com WhatsApp</option>
            <option value="sem_whatsapp"${filters.contato === 'sem_whatsapp' ? ' selected' : ''}>Sem WhatsApp</option>
          </select>
        </label>
        <label class="cobranca-field-inline">Vence de
          <input id="cobrancaLoteFrom" type="date" value="${esc(filters.from || '')}">
        </label>
        <label class="cobranca-field-inline">até
          <input id="cobrancaLoteTo" type="date" value="${esc(filters.to || '')}">
        </label>
      </div>
      <div class="cobranca-filter-chips is-static" id="cobrancaLoteFilterChips">
        ${active.length ? filterChipsHtml(active, true) : '<span class="cobranca-muted">Sem filtros: o lote considera a fila inteira.</span>'}
      </div>
      ${active.length ? '<p class="cobranca-lote-scope">A lista de empresas, os números e a prévia abaixo consideram apenas estes filtros.</p>' : ''}
    </div>`;
  }

  function bulkFetch() {
    return api(`/api/cobranca/lote?${bulkFilterParams().toString()}`, {
      method: 'POST',
      body: JSON.stringify({ dryRun: true, skipToday: bulkState.skipToday, skipDueToday: bulkState.skipDueToday }),
    });
  }

  function applyBulkData(data) {
    bulkState.plan = data.plan || {};
    bulkState.email = data.email || {};
    bulkState.graph = data.graph || {};
    bulkState.canManage = Boolean(data.canManage);
    bulkState.facets = {
      tipos: data.tipos || [],
      groups: data.groups || [],
    };
    bulkState.details.clear();
    bulkState.detailGen += 1;
    initBulkSelection();
    const companies = bulkState.plan.companies || [];
    if (!bulkState.previewKey || !companies.some(company => company.key === bulkState.previewKey)) {
      bulkState.previewKey = bulkState.plan.preview?.key
        || companies.find(company => company.temEmail)?.key
        || '';
    }
  }

  function initBulkSelection() {
    const previous = bulkState.selection;
    const selection = new Map();
    (bulkState.plan?.companies || []).forEach(company => {
      const old = previous.get(company.key);
      selection.set(company.key, {
        key: company.key,
        email: old?.email || company.email || '',
        include: old ? old.include : Boolean(company.temEmail) && !(bulkState.skipToday && company.cobradoHoje),
      });
    });
    bulkState.selection = selection;
  }

  function bulkCompanyMap() {
    const map = new Map();
    (bulkState.plan?.companies || []).forEach(company => map.set(company.key, company));
    return map;
  }

  function bulkEmailValid(email) {
    const value = String(email || '').trim();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !/redesaude/i.test(value);
  }

  function bulkStats() {
    const map = bulkCompanyMap();
    let companies = 0;
    let cases = 0;
    let value = 0;
    let invalid = 0;
    bulkState.selection.forEach(entry => {
      if (!entry.include) return;
      const company = map.get(entry.key);
      if (!company) return;
      if (!bulkEmailValid(entry.email)) {
        invalid += 1;
        return;
      }
      companies += 1;
      cases += Number(company.cases) || 0;
      value += Number(company.total) || 0;
    });
    return { companies, cases, value, invalid };
  }

  function syncBulkEmails() {
    const host = byId('cobrancaLoteSelection');
    if (!host) return;
    host.querySelectorAll('[data-bulk-email]').forEach(input => {
      const entry = bulkState.selection.get(input.dataset.bulkEmail);
      if (entry) entry.email = input.value;
    });
  }

  function updateBulkLive() {
    const stats = bulkStats();
    const statCompanies = byId('cobrancaLoteStatCompanies');
    if (statCompanies) statCompanies.textContent = integer(stats.companies);
    const statCases = byId('cobrancaLoteStatCases');
    if (statCases) statCases.textContent = integer(stats.cases);
    const statValue = byId('cobrancaLoteStatValue');
    if (statValue) statValue.textContent = money(stats.value);
    const info = byId('cobrancaLoteSelectionInfo');
    if (info) info.innerHTML = `<strong>${integer(stats.companies)}</strong> ${plural(stats.companies, 'empresa', 'empresas')} · <strong>${integer(stats.cases)}</strong> título(s) · <strong>${esc(money(stats.value))}</strong>`;
    const warning = byId('cobrancaLoteWarning');
    if (warning) {
      warning.hidden = !stats.invalid;
      warning.textContent = stats.invalid
        ? `${integer(stats.invalid)} empresa(s) selecionada(s) estão com e-mail vazio, inválido ou interno. Corrija ou remova antes de enviar.`
        : '';
    }
    const send = byId('cobrancaLoteSend');
    if (send) {
      const configured = Boolean(bulkState.email?.configured || bulkState.graph?.connected);
      send.disabled = bulkState.sending || !configured || !stats.companies || stats.invalid > 0;
      send.textContent = bulkState.sending ? 'Enviando...' : `Enviar agora${stats.companies ? ` (${integer(stats.companies)})` : ''}`;
    }
  }

  function bulkSelectionHtml() {
    const map = bulkCompanyMap();
    const filter = bulkState.filter.trim().toLowerCase();
    const included = [...bulkState.selection.values()].filter(entry => entry.include);
    const visible = included.filter(entry => {
      const company = map.get(entry.key);
      if (!company) return false;
      if (!filter) return true;
      return `${company.nome} ${company.documento} ${company.grupo}`.toLowerCase().includes(filter);
    });
    const stats = bulkStats();
    const active = bulkActiveFilters();
    const scope = active.map(item => `${item.kind}: ${item.label}`).join(' · ');
    return `
      <div class="cobranca-lote-selection-head">
        <div>
          <strong>Empresas deste envio</strong>
          <span id="cobrancaLoteSelectionInfo"><strong>${integer(stats.companies)}</strong> ${plural(stats.companies, 'empresa', 'empresas')} · <strong>${integer(stats.cases)}</strong> título(s) · <strong>${esc(money(stats.value))}</strong></span>
        </div>
        <div class="cobranca-lote-tools">
          <input id="cobrancaLoteFilter" type="search" placeholder="Filtrar por empresa, CNPJ ou grupo" value="${esc(bulkState.filter)}" autocomplete="off">
          <button class="button button-secondary" type="button" id="cobrancaLoteAll">Marcar todas com e-mail</button>
          <button class="button button-secondary" type="button" id="cobrancaLoteClear">Limpar seleção</button>
        </div>
      </div>
      <p class="cobranca-lote-scope-line">${scope
        ? `Só entram nesta lista as empresas que atendem a <strong>${esc(scope)}</strong>. As demais estão fora do lote.`
        : 'Sem filtros no lote: a lista abaixo parte da fila inteira e só mostra as empresas marcadas.'}</p>
      <div class="cobranca-lote-scroll">
        <table class="finance-table cobranca-lote-table">
          <thead><tr><th>Empresa</th><th>Grupo</th><th>E-mail de envio</th><th class="num">Títulos</th><th class="num">Valor</th><th></th></tr></thead>
          <tbody>${visible.length ? visible.map(entry => {
            const company = map.get(entry.key);
            const cc = company.cc || [];
            const open = bulkState.expanded.has(entry.key);
            const search = `${company.nome} ${company.documento} ${company.grupo}`.toLowerCase();
            return `<tr data-bulk-row data-search="${esc(search)}">
              <td><button class="cobranca-lote-expand${open ? ' is-open' : ''}" type="button" data-bulk-expand="${esc(entry.key)}" aria-expanded="${open}" title="Ver títulos, cópias e assunto">${open ? '▾' : '▸'}</button><strong>${esc(company.nome)}</strong><span class="finance-sub">${esc(company.documento || 'sem CNPJ')}${company.cadastros > 1 ? ` · ${integer(company.cadastros)} cadastros` : ''}</span></td>
              <td>${company.grupo ? `<span class="cobranca-group-chip">${esc(company.grupo)}</span>` : '<span class="cobranca-muted">—</span>'}${cc.length ? `<span class="cobranca-cc-inline" title="${esc(cc.join(', '))}">cc ${esc(cc[0])}${cc.length > 1 ? ` +${cc.length - 1}` : ''}</span>` : ''}</td>
              <td><input class="cobranca-lote-email-input${bulkEmailValid(entry.email) ? '' : ' is-invalid'}" data-bulk-email="${esc(entry.key)}" type="email" value="${esc(entry.email)}" placeholder="informe o e-mail" aria-label="E-mail de ${esc(company.nome)}"></td>
              <td class="num">${integer(company.cases)}</td>
              <td class="num"><span class="finance-money">${esc(money(company.total))}</span></td>
              <td class="num"><button class="cobranca-lote-remove" type="button" data-bulk-remove="${esc(entry.key)}" title="Remover ${esc(company.nome)} do lote">Remover</button></td>
            </tr>${open ? `<tr class="cobranca-lote-detail-row" data-bulk-detail-row data-search="${esc(search)}"><td colspan="6" data-bulk-detail="${esc(entry.key)}">${bulkDetailHtml(entry.key)}</td></tr>` : ''}`;
          }).join('') : `<tr><td colspan="6" class="empty-state">${included.length ? 'Nenhuma empresa encontrada neste filtro.' : 'Nenhuma empresa selecionada. Clique em “Marcar todas com e-mail”.'}</td></tr>`}</tbody>
        </table>
      </div>
      <p class="cobranca-lote-warning" id="cobrancaLoteWarning"${stats.invalid ? '' : ' hidden'}>${stats.invalid ? `${integer(stats.invalid)} empresa(s) selecionada(s) estão com e-mail vazio, inválido ou interno. Corrija ou remova antes de enviar.` : ''}</p>`;
  }

  function bulkDetailHtml(key) {
    const cached = bulkState.details.get(key);
    if (!cached || cached === 'loading') {
      return '<div class="cobranca-lote-detail"><p class="cobranca-muted">Carregando títulos, cópias e assunto deste e-mail...</p></div>';
    }
    if (cached.error) {
      return `<div class="cobranca-lote-detail"><p class="cobranca-warn">${esc(cached.error)}</p><button class="button button-secondary" type="button" data-bulk-detail-reload="${esc(key)}">Tentar de novo</button></div>`;
    }
    const company = cached.company || {};
    const casos = company.casos || [];
    const cc = company.cc || [];
    const mensagem = company.mensagem || {};
    const mail = bulkState.selection.get(key)?.email || '';
    return `<div class="cobranca-lote-detail">
      <div class="cobranca-lote-detail-head">
        <div>
          <strong>Títulos e cópias deste e-mail</strong>
          <span>${integer(company.cases)} título(s) · ${esc(money(company.total))} · ${integer(cc.length)} cópia(s)</span>
        </div>
        <button class="button button-secondary" type="button" data-bulk-preview="${esc(key)}">Ver prévia deste e-mail</button>
      </div>
      <div class="cobranca-lote-detail-meta">
        <p><span>Para</span><strong>${esc(mail || 'sem e-mail')}</strong></p>
        <p><span>Assunto</span><strong>${esc(mensagem.subject || '—')}</strong></p>
        <p><span>Cópias (CC)</span><strong>${bulkCcHtml(cc)}</strong></p>
      </div>
      <div class="cobranca-lote-titles-scroll">
        <table class="finance-table cobranca-lote-titles">
          <thead><tr><th>Título</th><th>Competência</th><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th></tr></thead>
          <tbody>${casos.map(item => `<tr>
            <td>${esc(item.tipoLabel || item.tipoParcela || 'Cobrança')}</td>
            <td>${esc(item.competencia || '—')}</td>
            <td>${esc(item.parcela || '—')}</td>
            <td>${esc(dateLabel(item.vencimento))}</td>
            <td class="num">${esc(money(item.valor))}</td>
            <td>${esc(item.statusLabel || item.status || '—')}${item.naoCobrar ? ' · depósito' : ''}${item.cancelada ? ' · cancelada' : ''}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty-state">Nenhum título ativo nesta empresa.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="cobranca-muted">As cópias recebem este e-mail em cópia, sem entrar como destinatário da cobrança.</p>
    </div>`;
  }

  function refreshBulkDetailCell(key) {
    const host = byId('cobrancaLoteSelection');
    if (!host) return;
    const cell = [...host.querySelectorAll('[data-bulk-detail]')].find(item => item.dataset.bulkDetail === key);
    if (cell) cell.innerHTML = bulkDetailHtml(key);
  }

  async function loadBulkDetail(key) {
    const current = bulkState.details.get(key);
    if (current && current !== 'loading') return current;
    if (current === 'loading') return null;
    const generation = bulkState.detailGen;
    bulkState.details.set(key, 'loading');
    refreshBulkDetailCell(key);
    try {
      const data = await api(`/api/cobranca/empresa?key=${encodeURIComponent(key)}`);
      if (bulkState.detailGen !== generation) return null;
      bulkState.details.set(key, { company: data.company || {} });
    } catch (error) {
      if (bulkState.detailGen !== generation) return null;
      const message = error.message === 'auth' || error.message === 'locked'
        ? 'Sessão expirada. Feche e abra o lote de novo.'
        : error.message;
      bulkState.details.set(key, { error: message });
    }
    refreshBulkDetailCell(key);
    if (bulkState.previewKey === key) syncBulkPreview();
    return bulkState.details.get(key);
  }

  function toggleBulkDetail(key) {
    const open = !bulkState.expanded.has(key);
    if (open) bulkState.expanded.add(key);
    else bulkState.expanded.delete(key);
    rerenderBulkSelection();
    if (open) loadBulkDetail(key);
  }

  function syncExpandedBulkDetails() {
    const map = bulkCompanyMap();
    [...bulkState.expanded].forEach(key => {
      if (!map.has(key)) {
        bulkState.expanded.delete(key);
        return;
      }
      loadBulkDetail(key);
    });
  }

  function bulkCcHtml(list) {
    const cc = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!cc.length) return '<span class="cobranca-muted">sem cópia neste e-mail</span>';
    return cc.map(email => `<span class="cobranca-lote-cc-chip">${esc(email)}</span>`).join('');
  }

  function bulkPreviewFor(key) {
    const planPreview = bulkState.plan?.preview;
    if (planPreview && planPreview.key === key) return planPreview;
    const cached = bulkState.details.get(key);
    if (cached && cached !== 'loading' && cached.company) {
      const mensagem = cached.company.mensagem || {};
      return {
        key,
        empresa: cached.company.nome,
        subject: mensagem.subject || '',
        text: mensagem.text || '',
        html: mensagem.html || '',
        cc: cached.company.cc || [],
      };
    }
    return null;
  }

  function bulkPreviewCompanies() {
    const map = bulkCompanyMap();
    return [...bulkState.selection.values()]
      .filter(entry => entry.include && map.has(entry.key))
      .map(entry => {
        const company = map.get(entry.key);
        return { key: entry.key, nome: company.nome, total: company.total, email: entry.email };
      });
  }

  function bulkPreviewHtml() {
    const list = bulkPreviewCompanies();
    if (!list.length) {
      return '<div class="cobranca-lote-preview"><div class="cobranca-lote-preview-head"><div><strong>Prévia de cada e-mail</strong><span>Cada empresa recebe um e-mail próprio, só com os títulos dela.</span></div></div><p class="cobranca-muted">Marque ao menos uma empresa para ver a prévia do e-mail.</p></div>';
    }
    if (!list.some(item => item.key === bulkState.previewKey)) {
      bulkState.previewKey = list[0].key;
    }
    const options = list.map(item =>
      `<option value="${esc(item.key)}"${item.key === bulkState.previewKey ? ' selected' : ''}>${esc(item.nome)} — ${esc(money(item.total))}</option>`
    ).join('');
    return `<div class="cobranca-lote-preview">
      <div class="cobranca-lote-preview-head">
        <div>
          <strong>Prévia de cada e-mail</strong>
          <span>Escolha a empresa para ver exatamente o assunto, as cópias e o corpo que ela vai receber.</span>
        </div>
        <label class="cobranca-lote-preview-pick">Empresa
          <select id="cobrancaLotePreviewSelect">${options}</select>
        </label>
      </div>
      <div class="cobranca-lote-preview-meta">
        <p><span>Para</span><strong id="cobrancaLotePreviewTo">—</strong></p>
        <p><span>Assunto</span><strong id="cobrancaLotePreviewSubject">Carregando...</strong></p>
        <p><span>Cópias (CC)</span><strong id="cobrancaLotePreviewCc">—</strong></p>
      </div>
      <iframe class="cobranca-preview-frame is-lote" id="cobrancaLotePreview" title="Prévia do e-mail de cobrança"></iframe>
      <p class="cobranca-muted">Este é o e-mail real da empresa selecionada. As cópias do grupo entram automaticamente e cada empresa recebe só os próprios títulos.</p>
    </div>`;
  }

  function renderBulkPreview() {
    const host = byId('cobrancaLotePreviewHost');
    if (!host) return;
    host.innerHTML = bulkPreviewHtml();
    bindBulkPreview();
    syncBulkPreview();
  }

  function bindBulkPreview() {
    byId('cobrancaLotePreviewSelect')?.addEventListener('change', event => {
      bulkState.previewKey = event.target.value;
      syncBulkPreview();
    });
  }

  function syncBulkPreview() {
    const frame = byId('cobrancaLotePreview');
    if (!frame) return;
    const key = bulkState.previewKey || bulkPreviewCompanies()[0]?.key || '';
    const preview = key ? bulkPreviewFor(key) : null;
    const toEl = byId('cobrancaLotePreviewTo');
    const subjectEl = byId('cobrancaLotePreviewSubject');
    const ccEl = byId('cobrancaLotePreviewCc');
    const company = bulkCompanyMap().get(key);
    const mail = bulkState.selection.get(key)?.email || '';
    if (toEl) toEl.textContent = mail || company?.email || 'sem e-mail';
    if (!key) {
      if (subjectEl) subjectEl.textContent = '—';
      if (ccEl) ccEl.innerHTML = '—';
      frame.srcdoc = '<p style="font-family:sans-serif;padding:24px;color:#555">Marque uma empresa para ver a prévia.</p>';
      return;
    }
    if (!preview) {
      const cached = bulkState.details.get(key);
      if (cached && cached !== 'loading' && cached.error) {
        if (subjectEl) subjectEl.textContent = 'Não foi possível carregar';
        if (ccEl) ccEl.textContent = '—';
        frame.srcdoc = `<p style="font-family:sans-serif;padding:24px;color:#a3333a">${esc(cached.error)}</p>`;
      } else {
        if (subjectEl) subjectEl.textContent = 'Carregando...';
        if (ccEl) ccEl.innerHTML = '—';
        frame.srcdoc = '<p style="font-family:sans-serif;padding:24px;color:#555">Carregando a prévia deste e-mail...</p>';
        loadBulkDetail(key);
      }
      return;
    }
    if (subjectEl) subjectEl.textContent = preview.subject || '—';
    if (ccEl) ccEl.innerHTML = bulkCcHtml(preview.cc);
    frame.srcdoc = preview.html || `<pre style="font-family:sans-serif;white-space:pre-wrap;padding:24px;color:#243b42">${esc(preview.text || '')}</pre>`;
  }

  function selectBulkPreview(key) {
    bulkState.previewKey = key;
    if (!bulkState.expanded.has(key)) {
      bulkState.expanded.add(key);
      rerenderBulkSelection();
      loadBulkDetail(key);
    }
    syncBulkPreview();
    document.querySelector('.cobranca-lote-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderBulkSelection() {
    const host = byId('cobrancaLoteSelection');
    if (!host) return;
    host.innerHTML = bulkSelectionHtml();
    bindBulkSelection();
    updateBulkLive();
  }

  function rerenderBulkSelection() {
    const scroll = byId('cobrancaLoteSelection')?.querySelector('.cobranca-lote-scroll');
    const scrollTop = scroll?.scrollTop || 0;
    renderBulkSelection();
    const next = byId('cobrancaLoteSelection')?.querySelector('.cobranca-lote-scroll');
    if (next) next.scrollTop = scrollTop;
  }

  function bindBulkSelection() {
    const host = byId('cobrancaLoteSelection');
    if (!host) return;
    host.querySelectorAll('[data-bulk-email]').forEach(input => {
      input.addEventListener('input', () => {
        const entry = bulkState.selection.get(input.dataset.bulkEmail);
        if (entry) entry.email = input.value;
        input.classList.toggle('is-invalid', !bulkEmailValid(input.value));
        updateBulkLive();
      });
    });
    host.querySelectorAll('[data-bulk-expand]').forEach(button => {
      button.addEventListener('click', () => toggleBulkDetail(button.dataset.bulkExpand));
    });
    host.querySelectorAll('[data-bulk-preview]').forEach(button => {
      button.addEventListener('click', () => selectBulkPreview(button.dataset.bulkPreview));
    });
    host.querySelectorAll('[data-bulk-detail-reload]').forEach(button => {
      button.addEventListener('click', () => {
        bulkState.details.delete(button.dataset.bulkDetailReload);
        loadBulkDetail(button.dataset.bulkDetailReload);
      });
    });
    host.querySelectorAll('[data-bulk-remove]').forEach(button => {
      button.addEventListener('click', () => {
        syncBulkEmails();
        const entry = bulkState.selection.get(button.dataset.bulkRemove);
        if (entry) entry.include = false;
        bulkState.expanded.delete(button.dataset.bulkRemove);
        renderBulkSelection();
        renderBulkPreview();
      });
    });
    byId('cobrancaLoteFilter')?.addEventListener('input', event => {
      bulkState.filter = event.target.value;
      const term = bulkState.filter.trim().toLowerCase();
      host.querySelectorAll('[data-bulk-row],[data-bulk-detail-row]').forEach(row => {
        row.hidden = Boolean(term) && !row.dataset.search.includes(term);
      });
    });
    byId('cobrancaLoteAll')?.addEventListener('click', () => {
      syncBulkEmails();
      bulkCompanyMap().forEach(company => {
        if (!company.temEmail) return;
        if (bulkState.skipToday && company.cobradoHoje) return;
        const entry = bulkState.selection.get(company.key);
        if (!entry) return;
        entry.include = true;
        if (!entry.email) entry.email = company.email || '';
      });
      renderBulkSelection();
      renderBulkPreview();
    });
    byId('cobrancaLoteClear')?.addEventListener('click', () => {
      syncBulkEmails();
      bulkState.selection.forEach(entry => { entry.include = false; });
      bulkState.expanded.clear();
      renderBulkSelection();
      renderBulkPreview();
    });
  }

  async function openBulk() {
    const dialog = byId('cobrancaLoteDialog');
    const host = byId('cobrancaLoteBody');
    bulkState.result = null;
    bulkState.selection.clear();
    bulkState.filter = '';
    bulkState.expanded.clear();
    bulkState.details.clear();
    bulkState.detailGen += 1;
    bulkState.previewKey = '';
    bulkState.skipDueToday = true;
    bulkState.filters = bulkFiltersFromScreen();
    stopGraphTimer();
    if (dialog && !dialog.open) dialog.showModal();
    if (host) host.innerHTML = '<p class="cobranca-muted">Montando a prévia da cobrança...</p>';
    try {
      applyBulkData(await bulkFetch());
      renderBulk();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
      dialog?.close();
    }
  }

  function bulkGraphBlock(graph) {
    const connected = Boolean(graph.connected);
    return `<div class="cobranca-graph">
      <div class="cobranca-graph-head">
        <strong>${connected ? 'Conta Microsoft conectada' : 'Conectar conta Microsoft'}</strong>
        <span>${connected
          ? `${esc(graph.account || 'conta conectada')} · o portal renova o acesso sozinho`
          : 'Sem precisar de administrador: entre uma vez com a conta do faturamento e o portal passa a enviar por ela.'}</span>
      </div>
      ${bulkState.canManage ? (connected
        ? '<button class="button button-secondary" type="button" id="cobrancaGraphDisconnect">Desconectar conta Microsoft</button>'
        : '<button class="button button-primary" type="button" id="cobrancaGraphConnect">Conectar conta Microsoft</button>') : ''}
      <div class="cobranca-graph-flow" id="cobrancaGraphFlow" hidden></div>
    </div>`;
  }

  function bulkConfigForm(email, graphConnected) {
    return `<details class="cobranca-lote-config"${email.configured || graphConnected ? '' : ' open'}>
      <summary>${email.configured ? 'Trocar a conta SMTP' : 'Configurar conta SMTP (alternativa)'}</summary>
      <div class="cobranca-lote-config-grid">
        <label class="cobranca-field-inline">Servidor SMTP
          <input id="cobrancaSmtpHost" type="text" value="${esc(email.host || '')}" placeholder="smtp.seudominio.com.br" autocomplete="off">
        </label>
        <label class="cobranca-field-inline">Porta
          <input id="cobrancaSmtpPort" type="number" min="1" max="65535" value="${esc(email.port || 587)}">
        </label>
        <label class="cobranca-field-inline">Usuário
          <input id="cobrancaSmtpUser" type="text" value="${esc(email.user || '')}" placeholder="cobranca@redesaude.com.br" autocomplete="off">
        </label>
        <label class="cobranca-field-inline">Senha
          <input id="cobrancaSmtpPassword" type="password" value="" placeholder="${email.hasPassword ? 'senha guardada' : 'senha do e-mail'}" autocomplete="new-password">
        </label>
        <label class="cobranca-field-inline">Nome do remetente
          <input id="cobrancaSmtpName" type="text" value="${esc(email.fromName || 'Rede Saúde')}">
        </label>
        <label class="cobranca-field-inline">E-mail do remetente
          <input id="cobrancaSmtpFrom" type="email" value="${esc(email.fromEmail || '')}" placeholder="cobranca@redesaude.com.br">
        </label>
        <label class="cobranca-lote-check"><input id="cobrancaSmtpTls" type="checkbox"${email.useTls !== false ? ' checked' : ''}> Usar TLS (porta 587)</label>
      </div>
      <div class="cobranca-lote-config-actions">
        <button class="button button-primary" type="button" id="cobrancaSmtpSave">Salvar conta SMTP</button>
      </div>
      <p class="cobranca-muted">Só use o SMTP se o provedor liberar o envio. Em contas Microsoft 365 o administrador precisa liberar o SMTP autenticado — por isso a conexão Microsoft acima é o caminho mais simples. A senha fica guardada só no servidor do portal.</p>
    </details>`;
  }

  function bulkResultBlock() {
    const result = bulkState.result;
    if (!result) return '';
    const failures = result.failures || [];
    const skipped = result.skipped || {};
    const skippedText = [
      Number(skipped.deposito) ? `${integer(skipped.deposito)} de depósito` : '',
      Number(skipped.cancelada) ? `${integer(skipped.cancelada)} de empresa cancelada` : '',
      Number(skipped.semEmail) ? `${integer(skipped.semEmail)} sem e-mail` : '',
      Number(skipped.vencendoHoje) ? `${integer(skipped.vencendoHoje)} que vencem hoje` : '',
      Number(skipped.selecao) ? `${integer(skipped.selecao)} da seleção` : '',
    ].filter(Boolean).join(', ');
    return `<div class="cobranca-lote-result">
      <strong>Lote concluído.</strong>
      ${integer(result.sent)} e-mail(s) enviado(s) · ${integer(result.cases)} título(s) · ${esc(money(result.value))}.${result.failed ? ` ${integer(result.failed)} falha(s).` : ''}${result.remaining ? ` ${integer(result.remaining)} empresa(s) ficam para o próximo envio.` : ''}
      ${skippedText ? `<br><span class="cobranca-muted">Fora do lote: ${esc(skippedText)}.</span>` : ''}
      ${failures.length ? `<details><summary>Ver falhas</summary><ul>${failures.map(item => `<li>${esc(item.cliente)} (${esc(item.email)}): ${esc(item.error)}</li>`).join('')}</ul></details>` : ''}
    </div>`;
  }

  function renderBulk() {
    const host = byId('cobrancaLoteBody');
    if (!host) return;
    const plan = bulkState.plan || {};
    const email = bulkState.email || {};
    const graph = bulkState.graph || {};
    const smtpReady = Boolean(email.configured);
    const graphReady = Boolean(graph.connected);
    const configured = smtpReady || graphReady;
    const accountText = graphReady
      ? `Microsoft · ${esc(graph.account || 'conta conectada')}`
      : smtpReady
        ? `${esc(email.fromName || 'Rede Saúde')} &lt;${esc(email.fromEmail)}&gt;`
        : 'Conecte a conta Microsoft ou configure o SMTP abaixo.';
    const skip = bulkState.skipToday;
    const skipDue = bulkState.skipDueToday;
    const limit = Number(plan.limite) || 0;
    const stats = bulkStats();
    host.innerHTML = `
      ${bulkResultBlock()}
      ${bulkFiltersHtml()}
      <div class="cobranca-lote-summary">
        <div><span>Empresas selecionadas</span><strong id="cobrancaLoteStatCompanies">${integer(stats.companies)}</strong></div>
        <div><span>Títulos</span><strong id="cobrancaLoteStatCases">${integer(stats.cases)}</strong></div>
        <div><span>Valor a cobrar</span><strong id="cobrancaLoteStatValue">${esc(money(stats.value))}</strong></div>
      </div>
      <div class="cobranca-lote-excluded">
        <span>Fora do lote:</span>
        <strong>${integer(plan.depositoCasos)}</strong> título(s) de depósito bancário ·
        <strong>${integer(plan.canceladaCasos)}</strong> de empresa cancelada ·
        <strong>${integer(plan.semEmail)}</strong> empresa(s) sem e-mail${skip ? ` · <strong>${integer(plan.cobradosHoje)}</strong> já cobradas hoje` : ''}${skipDue ? ` · <strong>${integer(plan.vencendoHojeCasos)}</strong> título(s) que vencem hoje` : ''}
      </div>
      <div class="cobranca-lote-guards">
        <label class="cobranca-lote-check"><input id="cobrancaLoteSkipToday" type="checkbox"${skip ? ' checked' : ''}> Pular empresas que já receberam contato hoje</label>
        <label class="cobranca-lote-check"><input id="cobrancaLoteSkipDueToday" type="checkbox"${skipDue ? ' checked' : ''}> Não cobrar títulos que vencem hoje</label>
      </div>
      <p class="cobranca-muted cobranca-lote-guard-hint">${skipDue
        ? 'Os títulos com vencimento no próprio dia ficam fora deste envio e continuam na fila para os próximos lotes.'
        : 'Atenção: a proteção está desligada e os títulos que vencem hoje entram neste envio.'}</p>
      <div id="cobrancaLoteSelection"></div>
      ${stats.companies > limit && limit ? `<p class="cobranca-warn">O limite é de ${integer(limit)} empresas por envio. Remova ${integer(stats.companies - limit)} empresa(s) da seleção.</p>` : ''}
      <div id="cobrancaLotePreviewHost"></div>
      <div class="cobranca-lote-email">
        <div class="cobranca-lote-email-head">
          <strong>${configured ? 'Conta de envio pronta' : 'Conta de envio ainda não configurada'}</strong>
          <span>${accountText}</span>
        </div>
        ${bulkState.canManage ? `
          ${bulkGraphBlock(graph)}
          ${bulkConfigForm(email, graphReady)}
          <div class="cobranca-lote-config-actions cobranca-lote-test">
            <input id="cobrancaSmtpTestTo" type="email" placeholder="e-mail para receber o teste" aria-label="E-mail para receber o teste">
            <input id="cobrancaSmtpTestCc" type="text" placeholder="cópias do teste (opcional)" aria-label="Cópias do e-mail de teste">
            <button class="button button-secondary" type="button" id="cobrancaSmtpTest"${configured ? '' : ' disabled'}>Enviar teste</button>
          </div>
          <p class="cobranca-muted cobranca-lote-test-hint">O teste usa o mesmo assunto e o mesmo HTML da empresa escolhida na prévia. Informe as cópias separadas por vírgula.</p>` : '<p class="cobranca-muted">Peça à gerência para conectar a conta de e-mail do portal.</p>'}
      </div>
      <div class="cobranca-lote-actions">
        <button class="button button-secondary" type="button" id="cobrancaLoteRefresh"${bulkState.sending ? ' disabled' : ''}>Atualizar prévia</button>
        <button class="button button-primary" type="button" id="cobrancaLoteSend"${configured && stats.companies && !stats.invalid && !bulkState.sending ? '' : ' disabled'}>${bulkState.sending ? 'Enviando...' : `Enviar agora${stats.companies ? ` (${integer(stats.companies)})` : ''}`}</button>
      </div>
      <p class="cobranca-muted">Você pode editar o e-mail, remover empresas ou incluir outras antes de enviar. O envio é real e fica registrado no histórico de cada título.</p>`;
    renderBulkSelection();
    renderBulkPreview();
    bindBulk();
    syncExpandedBulkDetails();
  }

  async function applyBulkFilters() {
    if (bulkState.sending) return;
    syncBulkEmails();
    const scrollHost = byId('cobrancaLoteBody')?.closest('.contracts-dialog-body');
    const scrollTop = scrollHost?.scrollTop || 0;
    const focusId = document.activeElement?.id || '';
    await refreshBulk();
    if (scrollHost) scrollHost.scrollTop = scrollTop;
    if (focusId === 'cobrancaLoteSearch') {
      const input = byId('cobrancaLoteSearch');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  function bindBulk() {
    byId('cobrancaLoteSkipToday')?.addEventListener('change', async event => {
      bulkState.skipToday = event.target.checked;
      await refreshBulk();
      if (bulkState.skipToday) {
        bulkCompanyMap().forEach(company => {
          const entry = bulkState.selection.get(company.key);
          if (entry && company.cobradoHoje) entry.include = false;
        });
        renderBulkSelection();
        renderBulkPreview();
        updateBulkLive();
      }
    });
    byId('cobrancaLoteSkipDueToday')?.addEventListener('change', async event => {
      bulkState.skipDueToday = event.target.checked;
      await refreshBulk();
    });
    byId('cobrancaLoteGrupo')?.addEventListener('change', event => {
      bulkState.filters.grupo = event.target.value;
      applyBulkFilters();
    });
    byId('cobrancaLoteTipo')?.addEventListener('change', event => {
      bulkState.filters.tipo = event.target.value;
      applyBulkFilters();
    });
    byId('cobrancaLoteContato')?.addEventListener('change', event => {
      bulkState.filters.contato = event.target.value;
      applyBulkFilters();
    });
    byId('cobrancaLoteFrom')?.addEventListener('change', event => {
      bulkState.filters.from = event.target.value;
      applyBulkFilters();
    });
    byId('cobrancaLoteTo')?.addEventListener('change', event => {
      bulkState.filters.to = event.target.value;
      applyBulkFilters();
    });
    const searchInput = byId('cobrancaLoteSearch');
    searchInput?.addEventListener('input', event => {
      bulkState.filters.search = event.target.value;
      if (bulkState.filterTimer) window.clearTimeout(bulkState.filterTimer);
      bulkState.filterTimer = window.setTimeout(applyBulkFilters, 450);
    });
    searchInput?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (bulkState.filterTimer) window.clearTimeout(bulkState.filterTimer);
      applyBulkFilters();
    });
    byId('cobrancaLoteFilterClear')?.addEventListener('click', () => {
      bulkState.filters = { search: '', tipo: '', grupo: '', contato: '', deposito: '', from: '', to: '' };
      applyBulkFilters();
    });
    byId('cobrancaLoteUseScreen')?.addEventListener('click', () => {
      bulkState.filters = bulkFiltersFromScreen();
      applyBulkFilters();
    });
    document.querySelectorAll('#cobrancaLoteFilterChips [data-filter-clear]').forEach(button => {
      button.addEventListener('click', () => {
        bulkState.filters[button.dataset.filterClear] = '';
        applyBulkFilters();
      });
    });
    byId('cobrancaLoteRefresh')?.addEventListener('click', refreshBulk);
    byId('cobrancaLoteSend')?.addEventListener('click', sendBulk);
    byId('cobrancaSmtpSave')?.addEventListener('click', saveBulkConfig);
    byId('cobrancaSmtpTest')?.addEventListener('click', testBulkConfig);
    byId('cobrancaGraphConnect')?.addEventListener('click', connectGraph);
    byId('cobrancaGraphDisconnect')?.addEventListener('click', disconnectGraph);
  }

  async function refreshBulk() {
    if (bulkState.sending) return;
    try {
      applyBulkData(await bulkFetch());
      renderBulk();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function saveBulkConfig() {
    const payload = {
      host: byId('cobrancaSmtpHost')?.value || '',
      port: Number(byId('cobrancaSmtpPort')?.value || 587),
      user: byId('cobrancaSmtpUser')?.value || '',
      password: byId('cobrancaSmtpPassword')?.value || '',
      fromName: byId('cobrancaSmtpName')?.value || '',
      fromEmail: byId('cobrancaSmtpFrom')?.value || '',
      useTls: Boolean(byId('cobrancaSmtpTls')?.checked),
    };
    try {
      const data = await api('/api/cobranca/email-config', { method: 'POST', body: JSON.stringify(payload) });
      bulkState.email = data.config || {};
      notify(bulkState.email.configured ? 'Conta de e-mail salva.' : 'Conta de e-mail removida.');
      renderBulk();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function testBulkConfig() {
    const to = (byId('cobrancaSmtpTestTo')?.value || '').trim();
    const cc = (byId('cobrancaSmtpTestCc')?.value || '').trim();
    if (!to) {
      notify('Informe o e-mail que deve receber o teste.', 'warning');
      return;
    }
    const button = byId('cobrancaSmtpTest');
    if (button) button.disabled = true;
    try {
      const data = await api('/api/cobranca/email-test', {
        method: 'POST',
        body: JSON.stringify({
          to,
          cc,
          key: bulkState.previewKey || bulkState.plan?.preview?.key || '',
        }),
      });
      const copies = (data.cc || []).length;
      const company = data.company ? ` · HTML de ${data.company}` : '';
      notify(`Teste enviado para ${data.to || to}${copies ? ` com ${integer(copies)} cópia(s)` : ''}${company}.`);
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function stopGraphTimer() {
    if (bulkState.graphTimer) {
      window.clearInterval(bulkState.graphTimer);
      bulkState.graphTimer = null;
    }
  }

  function setGraphStatus(message) {
    const el = byId('cobrancaGraphStatus');
    if (el) el.textContent = message;
  }

  function watchGraph(data) {
    stopGraphTimer();
    const interval = Math.max(3, Number(data.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(data.expiresIn) || 900) * 1000;
    const tick = async () => {
      if (Date.now() > deadline) {
        stopGraphTimer();
        setGraphStatus('O código expirou. Clique em Conectar conta Microsoft para gerar outro.');
        return;
      }
      try {
        const result = await api('/api/cobranca/graph/poll', {
          method: 'POST',
          body: JSON.stringify({ deviceCode: data.deviceCode }),
        });
        if (result.pending) {
          if (result.slowDown) setGraphStatus('A Microsoft pediu para aguardar mais um pouco...');
          return;
        }
        stopGraphTimer();
        setGraphStatus('Conta conectada. Atualizando a prévia...');
        applyBulkData(await bulkFetch());
        renderBulk();
        notify(`Conta Microsoft conectada${result.graph?.account ? ` (${result.graph.account})` : ''}.`);
      } catch (error) {
        stopGraphTimer();
        setGraphStatus(error.message);
        const button = byId('cobrancaGraphConnect');
        if (button) button.disabled = false;
      }
    };
    bulkState.graphTimer = window.setInterval(tick, interval);
    tick();
  }

  async function connectGraph() {
    const flow = byId('cobrancaGraphFlow');
    const button = byId('cobrancaGraphConnect');
    if (button) button.disabled = true;
    try {
      const data = await api('/api/cobranca/graph/start', { method: 'POST' });
      if (!flow) return;
      flow.hidden = false;
      flow.innerHTML = `
        <p>Abra <a href="${esc(data.verificationUri)}" target="_blank" rel="noopener">${esc(String(data.verificationUri || '').replace(/^https?:\/\//, ''))}</a> e entre com a conta do faturamento.</p>
        <p>Quando a Microsoft pedir, digite este código:</p>
        <strong class="cobranca-graph-code">${esc(data.userCode)}</strong>
        <p class="cobranca-muted">Aguardando a confirmação... <span id="cobrancaGraphStatus">o portal confere sozinho.</span></p>`;
      watchGraph(data);
    } catch (error) {
      if (button) button.disabled = false;
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function disconnectGraph() {
    if (!window.confirm('Desconectar a conta Microsoft usada nos envios de cobrança?')) return;
    try {
      await api('/api/cobranca/graph/disconnect', { method: 'POST' });
      bulkState.graph = {};
      notify('Conta Microsoft desconectada.');
      await refreshBulk();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  async function sendBulk() {
    if (bulkState.sending) return;
    const plan = bulkState.plan || {};
    const limit = Number(plan.limite) || 0;
    const stats = bulkStats();
    if (stats.invalid) {
      notify('Corrija ou remova as empresas com e-mail inválido antes de enviar.', 'warning');
      return;
    }
    if (!stats.companies) {
      notify('Selecione ao menos uma empresa com e-mail para cobrar.', 'warning');
      return;
    }
    if (limit && stats.companies > limit) {
      notify(`O limite é de ${integer(limit)} empresas por envio.`, 'warning');
      return;
    }
    const map = bulkCompanyMap();
    const selection = [...bulkState.selection.values()]
      .filter(entry => entry.include && map.has(entry.key) && bulkEmailValid(entry.email))
      .map(entry => ({ key: entry.key, email: entry.email.trim() }));
    const confirmed = window.confirm(
      `Enviar ${integer(stats.companies)} e-mail(s) de cobrança agora?\n\n`
      + `Títulos: ${integer(stats.cases)} · valor: ${money(stats.value)}.\n`
      + 'Cada empresa recebe um e-mail consolidado, adaptado ao que deve.\n'
      + 'O envio é real e fica registrado no histórico de cada título.'
    );
    if (!confirmed) return;
    bulkState.sending = true;
    renderBulk();
    try {
      const data = await api(`/api/cobranca/lote?${bulkFilterParams().toString()}`, {
        method: 'POST',
        body: JSON.stringify({ dryRun: false, skipToday: bulkState.skipToday, skipDueToday: bulkState.skipDueToday, companies: selection }),
      });
      bulkState.sending = false;
      bulkState.result = data;
      bulkState.selection.clear();
      const parts = [`${integer(data.sent)} e-mail(s) enviado(s)`];
      if (data.failed) parts.push(`${integer(data.failed)} falha(s)`);
      if (data.remaining) parts.push(`${integer(data.remaining)} empresa(s) para o próximo envio`);
      notify(`Cobrança em lote: ${parts.join(' · ')}.`, data.failed ? 'warning' : undefined);
      await refreshBulk();
      load();
    } catch (error) {
      bulkState.sending = false;
      renderBulk();
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    }
  }

  // ── Eventos ──────────────────────────────────────────────────────────────
  function bind() {
    if (state.bound) return;
    state.bound = true;

    byId('cobrancaImportS4e')?.addEventListener('click', openS4eDialog);
    byId('cobrancaS4eClose')?.addEventListener('click', () => byId('cobrancaS4eDialog')?.close());
    byId('cobrancaS4eDialog')?.addEventListener('close', () => clearTimeout(state.s4eTimer));
    byId('s4eConnectBtn')?.addEventListener('click', s4eConnect);
    byId('s4eDisconnectBtn')?.addEventListener('click', s4eDisconnect);
    byId('s4eForgetBtn')?.addEventListener('click', s4eForget);
    byId('s4ePreviewBtn')?.addEventListener('click', () => s4eStartImport(true));
    byId('s4eImportBtn')?.addEventListener('click', () => s4eStartImport(false));
    byId('s4eLegacyBtn')?.addEventListener('click', () => {
      byId('cobrancaS4eDialog')?.close();
      startImport();
    });
    byId('cobrancaBulkButton')?.addEventListener('click', openBulk);
    byId('cobrancaTemplatesButton')?.addEventListener('click', openModelDialog);
    byId('cobrancaGroupsButton')?.addEventListener('click', openGroupsDialog);
    byId('cobrancaExportButton')?.addEventListener('click', exportFiltered);
    byId('cobrancaSendsButton')?.addEventListener('click', openSendsDialog);
    byId('cobrancaRefreshButton')?.addEventListener('click', () => load());
    byId('cobrancaClearButton')?.addEventListener('click', clearAll);

    byId('cobrancaSearch')?.addEventListener('input', event => {
      state.search = event.target.value;
      byId('cobrancaSearchClear')?.classList.toggle('hidden', !state.search);
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(load, 320);
    });
    byId('cobrancaSearchClear')?.addEventListener('click', () => {
      state.search = '';
      byId('cobrancaSearch').value = '';
      byId('cobrancaSearchClear')?.classList.add('hidden');
      load();
      byId('cobrancaSearch')?.focus();
    });

    const reload = () => load();
    byId('cobrancaStatusFilter')?.addEventListener('change', event => { state.status = event.target.value; reload(); });
    byId('cobrancaTipoFilter')?.addEventListener('change', event => { state.tipo = event.target.value; reload(); });
    byId('cobrancaGrupoFilter')?.addEventListener('change', event => { state.grupo = event.target.value; reload(); });
    byId('cobrancaContatoFilter')?.addEventListener('change', event => { state.contato = event.target.value; reload(); });
    byId('cobrancaDepositoFilter')?.addEventListener('change', event => { state.deposito = event.target.value; reload(); });
    byId('cobrancaFrom')?.addEventListener('change', event => { state.from = event.target.value; reload(); });
    byId('cobrancaTo')?.addEventListener('change', event => { state.to = event.target.value; reload(); });
    byId('cobrancaSort')?.addEventListener('change', event => { state.sort = event.target.value; reload(); });
    byId('cobrancaClearFilters')?.addEventListener('click', () => {
      state.search = '';
      state.tipo = '';
      state.grupo = '';
      state.contato = '';
      state.deposito = '';
      state.from = '';
      state.to = '';
      state.status = 'ativos';
      state.sort = 'venc_asc';
      if (byId('cobrancaSearch')) byId('cobrancaSearch').value = '';
      if (byId('cobrancaTipoFilter')) byId('cobrancaTipoFilter').value = '';
      if (byId('cobrancaGrupoFilter')) byId('cobrancaGrupoFilter').value = '';
      if (byId('cobrancaContatoFilter')) byId('cobrancaContatoFilter').value = '';
      if (byId('cobrancaDepositoFilter')) byId('cobrancaDepositoFilter').value = '';
      if (byId('cobrancaFrom')) byId('cobrancaFrom').value = '';
      if (byId('cobrancaTo')) byId('cobrancaTo').value = '';
      if (byId('cobrancaStatusFilter')) byId('cobrancaStatusFilter').value = 'ativos';
      if (byId('cobrancaSort')) byId('cobrancaSort').value = 'venc_asc';
      reload();
    });

    byId('cobrancaKpis')?.addEventListener('click', event => {
      const card = event.target.closest('[data-kpi]');
      if (!card) return;
      const value = card.dataset.kpi;
      state.deposito = value === 'deposito' || value === 'cancelada' ? value : value === 'cobrar' ? 'cobrar' : '';
      if (byId('cobrancaDepositoFilter')) byId('cobrancaDepositoFilter').value = state.deposito;
      reload();
    });

    byId('cobrancaRows')?.addEventListener('click', event => {
      const remove = event.target.closest('[data-delete-company]');
      if (remove) {
        deleteCompany(remove.dataset.deleteCompany);
        return;
      }
      const target = event.target.closest('[data-open-company]');
      if (target) openCompany(target.dataset.openCompany);
    });

    byId('cobrancaDialogBody')?.addEventListener('click', event => {
      const caseButton = event.target.closest('[data-delete-case]');
      if (caseButton) {
        deleteCase(caseButton.dataset.deleteCase);
        return;
      }
      if (event.target.closest('#cobrancaCompanyDelete')) {
        const key = state.dialogCompany?.key;
        if (key) deleteCompany(key);
      }
    });

    byId('cobrancaDialogClose')?.addEventListener('click', () => byId('cobrancaDialog')?.close());
    byId('cobrancaTemplatesClose')?.addEventListener('click', () => byId('cobrancaTemplatesDialog')?.close());
    byId('cobrancaGroupsClose')?.addEventListener('click', () => byId('cobrancaGroupsDialog')?.close());
    byId('cobrancaLoteClose')?.addEventListener('click', () => byId('cobrancaLoteDialog')?.close());
    byId('cobrancaLoteDialog')?.addEventListener('close', stopGraphTimer);
    byId('cobrancaSendsClose')?.addEventListener('click', () => byId('cobrancaSendsDialog')?.close());

    window.addEventListener('cobranca-extension-ready', () => { state.extensionReady = true; });
    window.addEventListener('portal-cobranca-progress', event => {
      const message = event.detail?.message;
      if (message) notify(message);
    });
    window.addEventListener('portal-cobranca-result', event => finishImport(event.detail || {}));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !screenVisible() || dialogOpen()) return;
      if (Date.now() - state.loadedAt > 60000) load();
    });
    detectExtension();
  }

  function enter() {
    state.visible = true;
    bind();
    load();
  }

  function leave() {
    state.visible = false;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  window.enterCobrancaScreen = enter;
  window.leaveCobrancaScreen = leave;
  bind();
  if (byId('cobrancaScreen') && !byId('cobrancaScreen').classList.contains('hidden')) enter();
})();

// ── Tela Financeiro: rateios recebidos do P4X ───────────────────────────────
(function () {
  const byId = id => document.getElementById(id);
  const esc = value => (window.escapeHtml ? window.escapeHtml(String(value == null ? '' : value)) : String(value == null ? '' : value));
  const apiBase = () => window.PORTAL_API_BASE || '';
  const notify = (message, tone) => (window.notify ? window.notify(message, tone) : alert(message));

  const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const intFmt = new Intl.NumberFormat('pt-BR');

  const state = {
    loading: false,
    bound: false,
    items: [],
    summary: {},
    imports: [],
    filters: { files: [], receivers: [], occurrences: [] },
    canManage: false,
    page: 1,
    pageSize: 50,
    totalPages: 1,
    total: 0,
    search: '',
    dateField: 'payment',
    from: '',
    to: '',
    file: '',
    receiver: '',
    occurrence: '',
    importId: 'all',
    sort: 'payment_desc',
    requestId: 0,
    searchTimer: null,
  };

  function money(value) {
    return moneyFmt.format(Number(value) || 0);
  }

  function integer(value) {
    return intFmt.format(Number(value) || 0);
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

  function periodLabel(start, end) {
    if (!start && !end) return '—';
    if (start && end && start !== end) return `${dateLabel(start)} a ${dateLabel(end)}`;
    return dateLabel(start || end);
  }

  const csvCodeKey = 'portal-finance-csv-code';

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadName(header, fallback) {
    if (!header) return fallback;
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf) {
      try { return decodeURIComponent(utf[1].trim()); } catch (_) {}
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : fallback;
  }

  function queryParams(includePage = true) {
    const params = new URLSearchParams();
    if (state.search.trim()) params.set('search', state.search.trim());
    params.set('dateField', state.dateField);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (state.file) params.set('file', state.file);
    if (state.receiver) params.set('receiver', state.receiver);
    if (state.occurrence) params.set('occurrence', state.occurrence);
    if (state.importId && state.importId !== 'all') params.set('importId', state.importId);
    params.set('sort', state.sort);
    if (includePage) {
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));
    }
    return params;
  }

  function setLoading(active) {
    state.loading = active;
    byId('financeScreen')?.classList.toggle('finance-loading', active);
  }

  function renderKpis() {
    const summary = state.summary || {};
    const cards = [
      { label: 'Lançamentos', value: integer(summary.rows), hint: 'no filtro atual', icon: '▦' },
      { label: 'Arquivos P4X', value: integer(summary.files), hint: 'arquivos distintos', icon: '▤' },
      { label: 'Recebedores', value: summary.receivers ? integer(summary.receivers) : '—', hint: summary.receivers ? 'identificados' : 'arquivo sem recebedor', icon: '◈' },
      { label: 'Valor nominal', value: money(summary.nominal), hint: 'soma dos títulos', icon: '≡' },
      { label: 'Valor pago', value: money(summary.paid), hint: 'confirmado no filtro', icon: '✓' },
      { label: 'Rateio total', value: money(summary.rateio), hint: 'valor a repassar', icon: '◧', highlight: true },
    ];
    const host = byId('financeKpis');
    if (host) {
      host.innerHTML = cards.map(card => `
        <article class="stat-card${card.highlight ? ' highlight' : ''}">
          <span>${esc(card.label)}</span>
          <strong>${esc(card.value)}</strong>
          <small>${esc(card.hint)}</small>
        </article>`).join('');
    }
  }

  function fillSelect(select, options, current, placeholder) {
    if (!select) return;
    const values = Array.isArray(options) ? options : [];
    const known = new Set(values);
    select.innerHTML = `<option value="">${esc(placeholder)}</option>`
      + values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    select.value = known.has(current) ? current : '';
    return select.value;
  }

  function renderFilters() {
    state.file = fillSelect(byId('financeFileFilter'), state.filters.files, state.file, 'Todos os arquivos');
    state.receiver = fillSelect(byId('financeReceiverFilter'), state.filters.receivers, state.receiver, 'Todos os recebedores');
    state.occurrence = fillSelect(byId('financeOccurrenceFilter'), state.filters.occurrences, state.occurrence, 'Todas as ocorrências');

    const importsSelect = byId('financeImportFilter');
    if (importsSelect) {
      const imports = state.imports || [];
      const known = new Set(imports.map(item => item.id));
      importsSelect.innerHTML = '<option value="all">Todas as importações</option>'
        + imports.map(item => `<option value="${esc(item.id)}">${esc(`${dateTimeLabel(item.createdAt)} · ${item.fileName} · ${integer(item.rows)} lançamentos`)}</option>`).join('');
      importsSelect.value = known.has(state.importId) ? state.importId : 'all';
      state.importId = importsSelect.value;
    }
  }

  function renderLastImport() {
    const host = byId('financeLastImport');
    if (!host) return;
    const last = (state.imports || [])[0];
    if (!last) {
      host.textContent = 'Nenhuma importação ainda.';
      return;
    }
    host.innerHTML = `<strong>${esc(last.fileName)}</strong><br>${integer(last.rows)} lançamentos · ${esc(money(last.rateio))}<br>${esc(dateTimeLabel(last.createdAt))} · ${esc(last.userName || '—')}`;
  }

  function renderRows() {
    const host = byId('financeRows');
    if (!host) return;
    const items = state.items || [];
    host.innerHTML = items.map(item => {
      const payment = item.paymentDate || item.dueDate;
      const dateSub = item.paymentDate && item.dueDate && item.paymentDate !== item.dueDate
        ? `<span class="finance-sub">venc. ${esc(dateLabel(item.dueDate))}</span>` : '';
      const receiver = item.receiver
        ? `<span class="finance-payer" title="${esc(item.receiver)}">${esc(item.receiver)}</span><span class="finance-sub">${esc(item.receiverDoc || '')}</span>`
        : '<span class="finance-sub">—</span>';
      const fileCell = item.file
        ? `<button class="finance-file" type="button" data-finance-csv-file="${esc(item.file)}" title="Baixar CSV deste arquivo"><span>${esc(item.file)}</span><span class="finance-file-icon" aria-hidden="true">⤓</span></button>`
        : '<span class="finance-sub">—</span>';
      return `<tr>
        <td>${esc(dateLabel(payment))}${dateSub}</td>
        <td>${fileCell}</td>
        <td>${receiver}</td>
        <td><span class="finance-payer" title="${esc(item.payer)}">${esc(item.payer || '—')}</span><span class="finance-sub">${esc(item.payerDoc || '')}</span></td>
        <td>${esc(item.occurrence || '—')}${item.occurrenceCode ? `<span class="finance-sub">cód. ${esc(item.occurrenceCode)}</span>` : ''}</td>
        <td>${esc(item.ourNumber || '—')}${item.yourNumber ? `<span class="finance-sub">seu nº ${esc(item.yourNumber)}</span>` : ''}</td>
        <td class="num">${esc(money(item.nominal))}</td>
        <td class="num">${esc(money(item.fee))}</td>
        <td class="num">${esc(money(item.paid))}</td>
        <td class="num"><span class="finance-money">${esc(money(item.rateio))}</span></td>
      </tr>`;
    }).join('');
    byId('financeEmpty')?.classList.toggle('hidden', items.length > 0);
    const table = host.closest('table');
    if (table) table.classList.toggle('hidden', items.length === 0);
  }

  function renderPager() {
    const summary = state.summary || {};
    const total = Number(state.total) || 0;
    const count = byId('financeCount');
    if (count) {
      count.innerHTML = total
        ? `<strong>${integer(total)}</strong> lançamento(s) · rateio <strong>${esc(money(summary.rateio))}</strong>`
        : 'Nenhum lançamento no filtro';
    }
    const hint = byId('financeFilterHint');
    if (hint) {
      const period = periodLabel(summary.periodStart, summary.periodEnd);
      hint.textContent = period === '—' ? 'Sem período identificado' : `Período: ${period}`;
    }
    const info = byId('financePageInfo');
    if (info) info.textContent = `Página ${state.page} de ${state.totalPages} · ${integer(total)} lançamento(s)`;
    const prev = byId('financePrev');
    const next = byId('financeNext');
    if (prev) prev.disabled = state.page <= 1 || state.loading;
    if (next) next.disabled = state.page >= state.totalPages || state.loading;
  }

  function renderImports() {
    const host = byId('financeImportsBody');
    if (!host) return;
    const imports = state.imports || [];
    const currentUserId = window.PortalAccess?.Access?.user?.id || '';
    host.innerHTML = imports.map(item => {
      const canDelete = state.canManage || (item.userId && item.userId === currentUserId);
      return `<tr>
        <td>${esc(dateTimeLabel(item.createdAt))}</td>
        <td><span class="finance-import-file">${esc(item.fileName)}<small>${esc(item.source === 'planilha' ? 'Consolidado P4X' : item.source)}</small></span></td>
        <td>${integer(item.rows)}</td>
        <td>${integer(item.files)}</td>
        <td><strong>${esc(money(item.rateio))}</strong></td>
        <td>${esc(periodLabel(item.periodStart, item.periodEnd))}</td>
        <td>${esc(item.userName || '—')}</td>
        <td class="finance-import-actions"><button class="finance-csv" type="button" data-finance-csv-import="${esc(item.id)}" title="Baixar CSV desta importação">CSV</button>${canDelete ? `<button class="finance-delete" type="button" data-finance-delete="${esc(item.id)}" title="Excluir importação" aria-label="Excluir importação">×</button>` : ''}</td>
      </tr>`;
    }).join('');
    const empty = byId('financeImportsEmpty');
    if (empty) empty.classList.toggle('hidden', imports.length > 0);
    const wrap = host.closest('.history-table-wrap');
    if (wrap) wrap.classList.toggle('hidden', imports.length === 0);
  }

  function renderAll() {
    renderKpis();
    renderFilters();
    renderLastImport();
    renderRows();
    renderPager();
    renderImports();
    byId('financeSearchClear')?.classList.toggle('hidden', !state.search);
  }

  async function load() {
    const requestId = ++state.requestId;
    setLoading(true);
    try {
      const data = await window.PortalAccess.api(`/api/finance/rateios?${queryParams().toString()}`);
      if (requestId !== state.requestId) return;
      state.items = data.items || [];
      state.summary = data.summary || {};
      state.imports = data.imports || [];
      state.filters = data.filters || { files: [], receivers: [], occurrences: [] };
      state.canManage = Boolean(data.canManage);
      state.page = Number(data.page) || 1;
      state.pageSize = Number(data.pageSize) || state.pageSize;
      state.totalPages = Number(data.totalPages) || 1;
      state.total = Number(data.total) || 0;
      renderAll();
    } catch (error) {
      if (error.message !== 'auth' && error.message !== 'locked') notify(error.message, 'warning');
    } finally {
      if (requestId === state.requestId) {
        setLoading(false);
        renderPager();
      }
    }
  }

  async function importFile(file) {
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      notify('Escolha o arquivo .xlsx gerado pela extensão do P4X.', 'warning');
      return;
    }
    setLoading(true);
    notify('Importando o consolidado de rateios...');
    try {
      const response = await fetch(
        `${apiBase()}/api/finance/rateios/import?force=1&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: window.PortalAccess.authHeaders({ 'Content-Type': 'application/octet-stream' }),
          body: file,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.PortalAccess.restoreSession();
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Não foi possível importar o consolidado.');
      const imported = data.import || {};
      notify(`${integer(imported.rows)} lançamentos importados de ${integer(imported.files)} arquivo(s)${data.replaced ? ' · importação anterior substituída' : ''}.`);
      state.page = 1;
      await load();
    } catch (error) {
      notify(error.message, 'warning');
    } finally {
      setLoading(false);
    }
  }

  async function exportFiltered() {
    setLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/finance/rateios/export?${queryParams(false).toString()}`, {
        headers: window.PortalAccess.authHeaders(),
      });
      if (response.status === 401) {
        window.PortalAccess.restoreSession();
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível gerar a exportação.');
      }
      const blob = await response.blob();
      triggerDownload(blob, `rateios-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`);
      notify('Exportação gerada com os filtros atuais.');
    } catch (error) {
      notify(error.message, 'warning');
    } finally {
      setLoading(false);
    }
  }

  let csvContext = null;
  let csvOccurrences = [];
  let csvImport = '';
  let csvFile = '';
  let csvOptionsState = 'idle';
  let csvOptionsRequest = 0;

  function occurrenceLabel(name) {
    return String(name || '').trim() || 'Sem descrição';
  }

  function csvImportOptions() {
    return (state.imports || []).map(item => {
      const period = periodLabel(item.periodStart, item.periodEnd);
      const label = `${dateTimeLabel(item.createdAt)} · ${item.fileName} · ${item.userName || '—'} · ${period}`;
      return `<option value="${esc(item.id)}">${esc(label)}</option>`;
    }).join('');
  }

  function csvScopeParams(context) {
    if (csvImport) {
      const params = new URLSearchParams({ importId: csvImport });
      if (csvFile) params.set('file', csvFile);
      return params;
    }
    const params = new URLSearchParams();
    if (state.search.trim()) params.set('search', state.search.trim());
    params.set('dateField', state.dateField);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (state.receiver) params.set('receiver', state.receiver);
    if (state.importId && state.importId !== 'all') params.set('importId', state.importId);
    params.set('sort', state.sort);
    const file = context.mode === 'file' ? context.file : state.file;
    if (file) params.set('file', file);
    return params;
  }

  function updateCsvHint(context) {
    const hint = byId('financeCsvContext');
    if (!hint) return;
    if (csvImport) {
      const item = (state.imports || []).find(entry => entry.id === csvImport);
      const fileNote = csvFile ? ` Arquivo ${csvFile}.` : '';
      hint.textContent = (item
        ? `Importação de ${dateTimeLabel(item.createdAt)} · ${item.fileName} · ${item.userName || '—'} · período ${periodLabel(item.periodStart, item.periodEnd)}.`
        : 'Importação selecionada.') + ` Os filtros da tela não são aplicados.${fileNote}`;
    } else if (context.mode === 'file') {
      hint.textContent = `Arquivo ${context.file}, dentro dos filtros atuais da tela.`;
    } else {
      hint.textContent = 'Todas as importações, com os filtros atuais da tela.';
    }
  }

  function updateCsvConfirm() {
    const confirm = byId('financeCsvConfirm');
    if (!confirm) return;
    confirm.disabled = csvOptionsState !== 'ready' || !csvOccurrences.some(item => item.selected);
  }

  function renderCsvOccurrences(message) {
    const host = byId('financeCsvOccurrences');
    if (!host) return;
    const empty = byId('financeCsvOccEmpty');
    if (message) {
      host.innerHTML = `<p class="finance-csv-occ-note">${esc(message)}</p>`;
      if (empty) empty.classList.add('hidden');
      return;
    }
    if (!csvOccurrences.length) {
      host.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    host.innerHTML = csvOccurrences.map(item => `
      <label class="finance-csv-occ-item${item.exportable ? '' : ' is-disabled'}">
        <input type="checkbox" value="${esc(item.key)}"${item.selected ? ' checked' : ''}${item.exportable ? '' : ' disabled'} data-finance-csv-occ>
        <span class="finance-csv-occ-name">${esc(occurrenceLabel(item.name))}</span>
        <span class="finance-csv-occ-meta">${item.exportable ? `${integer(item.exportable)} lanç. · ${esc(money(item.paid))}` : 'sem data de pagamento'}</span>
      </label>`).join('');
  }

  async function loadCsvOccurrences(context) {
    const requestId = ++csvOptionsRequest;
    csvOccurrences = [];
    csvOptionsState = 'loading';
    renderCsvOccurrences('Carregando descrições...');
    updateCsvConfirm();
    try {
      const response = await fetch(`${apiBase()}/api/finance/rateios/occurrences?${csvScopeParams(context).toString()}`, {
        headers: window.PortalAccess.authHeaders(),
      });
      if (response.status === 401) {
        window.PortalAccess.restoreSession();
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (requestId !== csvOptionsRequest) return;
      if (!response.ok) throw new Error(data.error || 'Não foi possível carregar as descrições.');
      csvOccurrences = (data.items || []).map(item => ({
        key: item.key,
        name: item.name || '',
        rows: Number(item.rows) || 0,
        exportable: Number(item.exportable) || 0,
        paid: Number(item.paid) || 0,
        selected: Number(item.exportable) > 0,
      }));
      csvOptionsState = 'ready';
      renderCsvOccurrences();
    } catch (err) {
      if (requestId !== csvOptionsRequest) return;
      csvOptionsState = 'error';
      renderCsvOccurrences(err?.message || 'Não foi possível carregar as descrições.');
    } finally {
      if (requestId === csvOptionsRequest) updateCsvConfirm();
    }
  }

  function openCsvDialog(context) {
    const dialog = byId('financeCsvDialog');
    const input = byId('financeCsvHeader');
    if (!dialog || !input) return;
    csvContext = context;
    csvOccurrences = [];
    csvFile = context.mode === 'file' ? context.file : '';
    if (context.mode === 'import') csvImport = context.importId;
    else if (state.importId && state.importId !== 'all') csvImport = state.importId;
    else csvImport = '';
    const importSelect = byId('financeCsvImport');
    if (importSelect) {
      importSelect.innerHTML = ['<option value="">Todas as importações</option>', csvImportOptions()].join('');
      if (csvImport && !(state.imports || []).some(item => item.id === csvImport)) {
        importSelect.insertAdjacentHTML('beforeend', `<option value="${esc(csvImport)}">Importação selecionada</option>`);
      }
      importSelect.value = csvImport;
    }
    updateCsvHint(context);
    byId('financeCsvError')?.classList.add('hidden');
    input.value = localStorage.getItem(csvCodeKey) || '';
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
    loadCsvOccurrences(context);
  }

  async function downloadCsv() {
    const input = byId('financeCsvHeader');
    const error = byId('financeCsvError');
    const confirmButton = byId('financeCsvConfirm');
    const showError = message => {
      if (error) {
        error.textContent = message;
        error.classList.remove('hidden');
      } else {
        notify(message, 'warning');
      }
    };
    const code = String(input?.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(code)) {
      showError('Digite o código da primeira linha, com letras e números (ex.: PDNN00001005112026).');
      input?.focus();
      return;
    }
    if (csvOptionsState === 'loading' || csvOptionsState === 'idle') {
      showError('As descrições ainda não carregaram. Aguarde um instante.');
      return;
    }
    if (csvOptionsState !== 'ready') {
      showError('Não foi possível carregar as descrições. Feche e abra o diálogo novamente.');
      return;
    }
    if (!csvOccurrences.length) {
      showError('Nenhum lançamento com nosso número e data de pagamento neste escopo.');
      return;
    }
    if (!csvOccurrences.some(item => item.selected)) {
      showError('Marque ao menos uma descrição para ir no CSV.');
      return;
    }
    if (error) error.classList.add('hidden');
    const context = csvContext || { mode: 'filters' };
    const params = csvScopeParams(context);
    params.set('header', code);
    csvOccurrences.filter(item => item.selected).forEach(item => params.append('occurrences', item.key));
    setLoading(true);
    if (confirmButton) {
      confirmButton.disabled = true;
      confirmButton.textContent = 'Gerando...';
    }
    try {
      const response = await fetch(`${apiBase()}/api/finance/rateios/csv?${params.toString()}`, {
        headers: window.PortalAccess.authHeaders(),
      });
      if (response.status === 401) {
        window.PortalAccess.restoreSession();
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível gerar o CSV.');
      }
      const blob = await response.blob();
      const fallback = csvFile
        ? `${csvFile}.csv`
        : `rateios-csv-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
      const filename = downloadName(response.headers.get('Content-Disposition'), fallback);
      triggerDownload(blob, filename);
      localStorage.setItem(csvCodeKey, code);
      byId('financeCsvDialog')?.close();
      notify(`CSV gerado: ${filename}`);
    } catch (err) {
      showError(err?.message || 'Não foi possível gerar o CSV.');
    } finally {
      setLoading(false);
      if (confirmButton) confirmButton.textContent = 'Baixar CSV';
      updateCsvConfirm();
    }
  }

  let p4xRequest = null;

  function requestP4xImport() {
    if (p4xRequest) return;
    const request = { acknowledged: false, ackTimer: 0, longTimer: 0 };
    const cleanup = () => {
      clearTimeout(request.ackTimer);
      clearTimeout(request.longTimer);
      window.removeEventListener('p4x-finance-ack', onAck);
      window.removeEventListener('p4x-finance-result', onResult);
      if (p4xRequest === request) p4xRequest = null;
    };
    const finish = (ok, message) => {
      if (p4xRequest !== request) return;
      cleanup();
      setLoading(false);
      if (message) notify(message, ok ? 'success' : 'warning');
      if (ok) {
        state.page = 1;
        load();
      }
    };
    const onAck = () => {
      if (p4xRequest !== request || request.acknowledged) return;
      request.acknowledged = true;
      clearTimeout(request.ackTimer);
      notify('Exportando no P4X. Aguarde o aviso “Concluído” na aba do P4X; o portal será atualizado automaticamente.');
      request.longTimer = setTimeout(
        () => finish(false, 'A exportação no P4X não respondeu. Verifique a aba do P4X e tente novamente.'),
        15 * 60 * 1000,
      );
    };
    const onResult = event => {
      let data = {};
      try { data = JSON.parse(String(event.detail || '{}')); } catch (_) {}
      finish(Boolean(data.ok), data.message || (data.ok ? 'Rateios importados do P4X.' : 'Não foi possível importar do P4X.'));
    };
    p4xRequest = request;
    setLoading(true);
    notify('Chamando a extensão do P4X...');
    request.ackTimer = setTimeout(
      () => finish(false, 'Extensão não encontrada. Abra o portal pelo atalho "Portal Financeiro" ou peça a preparação deste computador ao responsável.'),
      2500,
    );
    window.addEventListener('p4x-finance-ack', onAck);
    window.addEventListener('p4x-finance-result', onResult);
    window.dispatchEvent(new CustomEvent('p4x-finance-request'));
  }

  async function deleteImport(importId) {
    if (!importId || !confirm('Excluir esta importação e todos os rateios dela?')) return;
    setLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/finance/imports/${encodeURIComponent(importId)}`, {
        method: 'DELETE',
        headers: window.PortalAccess.authHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.PortalAccess.restoreSession();
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Não foi possível excluir a importação.');
      notify('Importação excluída.');
      state.page = 1;
      await load();
    } catch (error) {
      notify(error.message, 'warning');
    } finally {
      setLoading(false);
    }
  }

  function resetFilters() {
    state.search = '';
    state.dateField = 'payment';
    state.from = '';
    state.to = '';
    state.file = '';
    state.receiver = '';
    state.occurrence = '';
    state.importId = 'all';
    state.sort = 'payment_desc';
    if (byId('financeSearch')) byId('financeSearch').value = '';
    if (byId('financeDateField')) byId('financeDateField').value = 'payment';
    if (byId('financeFrom')) byId('financeFrom').value = '';
    if (byId('financeTo')) byId('financeTo').value = '';
    if (byId('financeSort')) byId('financeSort').value = 'payment_desc';
    state.page = 1;
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    byId('financeImportFromP4x')?.addEventListener('click', requestP4xImport);
    byId('financeImportButton')?.addEventListener('click', () => byId('financeFileInput')?.click());
    byId('financeFileInput')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      importFile(file);
    });
    byId('financeExportButton')?.addEventListener('click', exportFiltered);
    byId('financeCsvButton')?.addEventListener('click', () => openCsvDialog({ mode: 'filters' }));
    byId('financeRefreshButton')?.addEventListener('click', () => load());

    byId('financeCsvForm')?.addEventListener('submit', event => {
      event.preventDefault();
      downloadCsv();
    });
    byId('financeCsvClose')?.addEventListener('click', () => byId('financeCsvDialog')?.close());
    byId('financeCsvCancel')?.addEventListener('click', () => byId('financeCsvDialog')?.close());
    byId('financeCsvHeader')?.addEventListener('input', () => byId('financeCsvError')?.classList.add('hidden'));
    byId('financeCsvOccAll')?.addEventListener('click', () => {
      csvOccurrences.forEach(item => { item.selected = item.exportable > 0; });
      renderCsvOccurrences();
      updateCsvConfirm();
    });
    byId('financeCsvOccNone')?.addEventListener('click', () => {
      csvOccurrences.forEach(item => { item.selected = false; });
      renderCsvOccurrences();
      updateCsvConfirm();
    });
    byId('financeCsvOccurrences')?.addEventListener('change', event => {
      const checkbox = event.target.closest('[data-finance-csv-occ]');
      if (!checkbox) return;
      const item = csvOccurrences.find(entry => entry.key === checkbox.value);
      if (item) item.selected = checkbox.checked;
      updateCsvConfirm();
    });
    byId('financeCsvImport')?.addEventListener('change', event => {
      csvImport = event.target.value;
      if (csvImport) csvFile = '';
      byId('financeCsvError')?.classList.add('hidden');
      updateCsvHint(csvContext || { mode: 'filters' });
      if (csvContext) loadCsvOccurrences(csvContext);
    });
    byId('financeCsvDialog')?.addEventListener('close', () => {
      csvContext = null;
      csvOccurrences = [];
      csvImport = '';
      csvFile = '';
      csvOptionsState = 'idle';
      csvOptionsRequest += 1;
      byId('financeCsvError')?.classList.add('hidden');
    });

    byId('financeSearch')?.addEventListener('input', event => {
      state.search = event.target.value;
      byId('financeSearchClear')?.classList.toggle('hidden', !state.search);
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => { state.page = 1; load(); }, 320);
    });
    byId('financeSearchClear')?.addEventListener('click', () => {
      state.search = '';
      byId('financeSearch').value = '';
      byId('financeSearchClear')?.classList.add('hidden');
      state.page = 1;
      load();
      byId('financeSearch')?.focus();
    });

    const reload = () => { state.page = 1; load(); };
    byId('financeDateField')?.addEventListener('change', event => { state.dateField = event.target.value; reload(); });
    byId('financeFrom')?.addEventListener('change', event => { state.from = event.target.value; reload(); });
    byId('financeTo')?.addEventListener('change', event => { state.to = event.target.value; reload(); });
    byId('financeFileFilter')?.addEventListener('change', event => { state.file = event.target.value; reload(); });
    byId('financeReceiverFilter')?.addEventListener('change', event => { state.receiver = event.target.value; reload(); });
    byId('financeOccurrenceFilter')?.addEventListener('change', event => { state.occurrence = event.target.value; reload(); });
    byId('financeImportFilter')?.addEventListener('change', event => { state.importId = event.target.value; reload(); });
    byId('financeSort')?.addEventListener('change', event => { state.sort = event.target.value; reload(); });
    byId('financeClearFilters')?.addEventListener('click', () => { resetFilters(); load(); });

    byId('financePrev')?.addEventListener('click', () => {
      if (state.page <= 1) return;
      state.page -= 1;
      load();
    });
    byId('financeNext')?.addEventListener('click', () => {
      if (state.page >= state.totalPages) return;
      state.page += 1;
      load();
    });

    byId('financeRows')?.addEventListener('click', event => {
      const button = event.target.closest('[data-finance-csv-file]');
      if (button) openCsvDialog({ mode: 'file', file: button.dataset.financeCsvFile });
    });

    byId('financeImportsBody')?.addEventListener('click', event => {
      const csvButton = event.target.closest('[data-finance-csv-import]');
      if (csvButton) {
        openCsvDialog({ mode: 'import', importId: csvButton.dataset.financeCsvImport });
        return;
      }
      const button = event.target.closest('[data-finance-delete]');
      if (button) deleteImport(button.dataset.financeDelete);
    });
  }

  function enter() {
    bind();
    state.page = 1;
    load();
  }

  window.enterFinanceScreen = enter;
  bind();
  if (byId('financeScreen') && !byId('financeScreen').classList.contains('hidden')) enter();
})();

(function () {
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, options) => window.PortalAccess.api(path, options);
  const number = new Intl.NumberFormat('pt-BR');
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const state = {
    active: false, timer: null, sequence: 0, loading: false, starting: false,
    overview: null, selectedRun: '', items: [], itemsRun: '', itemsLoading: false,
    downloadUrl: '', job: null, previa: null, previaTimer: null, previaSeq: 0,
  };

  const visible = () => state.active && window.PortalAccess?.Access.user && !document.body.classList.contains('locked');
  const stamp = value => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza', dateStyle: 'short', timeStyle: 'short' }) : '—';
  const isoDay = day => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const brDay = value => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  };
  const daysBetween = (start, end) => Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000);
  const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
  const statusNames = { running: 'Gerando', done: 'Concluída', error: 'Falhou' };

  function message(text = '', error = false, download = null) {
    const box = byId('rcMessage');
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = '';
    }
    box.replaceChildren();
    if (text) box.appendChild(document.createTextNode(text));
    if (download?.blob) {
      state.downloadUrl = URL.createObjectURL(download.blob);
      const link = document.createElement('a');
      link.className = 'rc-link';
      link.href = state.downloadUrl;
      link.download = download.filename;
      link.textContent = 'Baixar novamente';
      box.appendChild(document.createTextNode(' '));
      box.appendChild(link);
    }
    box.hidden = !text;
    box.classList.toggle('rc-error', error);
  }

  function runById(id) {
    return (state.overview?.runs || []).find(run => run.id === id) || null;
  }

  function controls() {
    const busy = state.starting || state.job?.running;
    byId('rcRun').disabled = Boolean(busy || state.loading);
    byId('rcRun').textContent = busy ? 'Gerando recibos…' : 'Gerar recibos';
    const run = runById(state.selectedRun);
    byId('rcDownload').disabled = busy || !run || run.status !== 'done' || !run.hasZip;
  }

  function fillSelect(select, values, placeholder) {
    const current = select.value;
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    if (values.includes(current)) select.value = current;
  }

  function fillCentros() {
    const centros = (state.overview?.centros || []).map(item => item.nome);
    fillSelect(byId('rcGroup'), centros, 'Todos os centros de custo');
    fillGrupos();
  }

  function fillGrupos() {
    const centro = byId('rcGroup').value;
    const grupos = new Set();
    (state.overview?.centros || []).forEach(item => {
      if (centro && item.nome !== centro) return;
      (item.grupos || []).forEach(nome => grupos.add(nome));
    });
    fillSelect(
      byId('rcUnion'),
      [...grupos].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      centro ? 'Todos os grupos deste centro de custo' : 'Todos os grupos',
    );
  }

  function renderPrevia(data) {
    const box = byId('rcPreview');
    if (!data || !data.base) {
      box.textContent = 'A prévia aparece depois da primeira apuração. A geração continua lendo o S4E ao vivo.';
      return;
    }
    const quando = stamp(data.base.finishedAt || data.base.startedAt);
    if (!data.parcelas) {
      box.textContent = `Prévia pela apuração de ${quando}: nenhuma parcela paga nesse período e filtros. A geração relê o S4E e pode encontrar pagamentos novos.`;
      return;
    }
    box.textContent = `Prévia pela apuração de ${quando}: ${number.format(data.empresas)} empresa(s) · ${number.format(data.parcelas)} parcela(s) paga(s) · ${money.format(data.valor || 0)} · ${number.format(data.centros)} centro(s) de custo. A geração relê o S4E ao vivo e pode incluir pagamentos feitos depois disso.`;
  }

  async function loadPrevia() {
    const start = byId('rcStart').value;
    const end = byId('rcEnd').value;
    if (!start || !end || end < start) {
      renderPrevia(null);
      return;
    }
    const sequence = ++state.previaSeq;
    try {
      const query = new URLSearchParams({
        start, end,
        centro: byId('rcGroup').value,
        grupo: byId('rcUnion').value,
      });
      const data = await api(`/api/recibos/previa?${query}`);
      if (sequence !== state.previaSeq || !visible()) return;
      state.previa = data;
      renderPrevia(data);
    } catch (error) {
      if (sequence === state.previaSeq && visible()) byId('rcPreview').textContent = error.message;
    }
  }

  function schedulePrevia() {
    clearTimeout(state.previaTimer);
    state.previaTimer = setTimeout(loadPrevia, 400);
  }

  function renderJob() {
    const job = state.job || {};
    const box = byId('rcJob');
    box.hidden = !job.running;
    if (!job.running) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(job.startedAt || Date.now()).getTime()) / 1000));
    const duration = value => `${Math.floor(value / 60)}min ${String(value % 60).padStart(2, '0')}s`;
    const descriptions = {
      inicio: 'Conectando ao S4E com a conta configurada.',
      relatorio: 'Aguardando o S4E gerar e devolver o relatório de faturamento. Esta é a etapa mais demorada e o S4E não informa o progresso interno.',
      filtro: 'Selecionando somente as empresas com pagamento registrado no período.',
      recibos: 'Abrindo o recibo oficial de cada parcela paga. As leituras acontecem em paralelo, sem alterar nada no S4E.',
      pdf: 'Montando os PDFs e separando as pastas por centro de custo, grupo e empresa.',
      zip: 'Compactando a pasta completa para download.',
      fim: 'Concluído.',
    };
    byId('rcJobText').textContent = job.message || 'Preparando a geração…';
    byId('rcJobDetail').textContent = descriptions[job.phase] || 'Finalizando a geração dos recibos.';
    byId('rcJobTime').textContent = `Decorrido: ${duration(elapsed)}${job.total ? ` · ${number.format(job.done || 0)} de ${number.format(job.total)} recibos` : ''}`;
    byId('rcJobProgress').value = job.percent || 0;
    byId('rcJobProgress').setAttribute('aria-valuetext', `${job.percent || 0}% concluído. ${descriptions[job.phase] || ''}`);
  }

  function renderSummary() {
    const run = runById(state.selectedRun) || (state.overview?.runs || [])[0] || null;
    byId('rcTotal').textContent = run ? number.format(run.gerados || 0) : '—';
    byId('rcCompanies').textContent = run ? number.format(run.empresas || 0) : '—';
    byId('rcSkipped').textContent = run ? number.format(run.ignorados || 0) : '—';
    byId('rcErrors').textContent = run ? number.format(run.erros || 0) : '—';
    byId('rcSummaryPeriod').textContent = run
      ? `${brDay(run.periodStart)} a ${brDay(run.periodEnd)}${run.centroCusto ? ` · ${run.centroCusto}` : ''}${run.grupo ? ` · ${run.grupo}` : ''}`
      : 'Nenhuma geração ainda';
  }

  function runItem(run) {
    const active = run.id === state.selectedRun;
    const filters = [run.centroCusto, run.grupo].filter(Boolean).join(' · ') || 'Todos os centros de custo e grupos';
    const counts = run.status === 'done'
      ? `${number.format(run.gerados || 0)} PDF(s) · ${number.format(run.empresas || 0)} empresa(s)${run.ignorados ? ` · ${number.format(run.ignorados)} sem valor` : ''}${run.erros ? ` · ${number.format(run.erros)} não lido(s)` : ''}`
      : (run.message || '');
    return `<article class="rc-run${active ? ' rc-run-active' : ''}" data-rc-run="${esc(run.id)}">
      <div class="rc-run-main">
        <div class="rc-run-title"><strong>${esc(brDay(run.periodStart))} a ${esc(brDay(run.periodEnd))}</strong><span class="rc-badge rc-badge-${esc(run.status)}">${esc(statusNames[run.status] || run.status)}</span></div>
        <span class="rc-run-filter">${esc(filters)}</span>
        <span class="rc-run-counts">${esc(counts)}</span>
        <span class="rc-run-meta">${esc(run.createdBy || 'Sistema')} · ${esc(stamp(run.finishedAt || run.startedAt))}</span>
        ${run.error ? `<span class="rc-run-error">${esc(run.error)}</span>` : ''}
      </div>
      <div class="rc-run-actions">
        <button class="button button-secondary" type="button" data-rc-inspect="${esc(run.id)}"${run.status === 'done' ? '' : ' disabled'}>Conferir</button>
        <button class="button button-primary" type="button" data-rc-download="${esc(run.id)}"${run.hasZip && run.status === 'done' ? '' : ' disabled'}>Baixar .zip</button>
      </div>
    </article>`;
  }

  function renderRuns() {
    const runs = state.overview?.runs || [];
    if (!state.selectedRun && runs.length) state.selectedRun = runs.find(run => run.status === 'done' && run.hasZip)?.id || runs[0].id;
    byId('rcRunsEmpty').hidden = Boolean(runs.length);
    byId('rcRuns').innerHTML = runs.map(runItem).join('');
    byId('rcHistoryCount').textContent = runs.length ? `${runs.length} geração(ões) recentes` : '';
  }

  function renderItems() {
    const query = searchText(byId('rcSearch').value);
    const rows = state.items.filter(item => !query || searchText([item.empresa, item.documento, item.centroCusto, item.grupo, item.parcela].join(' ')).includes(query));
    byId('rcItemsEmpty').hidden = Boolean(rows.length);
    byId('rcItemRows').innerHTML = rows.map(item => {
      const label = item.status === 'ok' ? 'PDF gerado' : item.status === 'ignorado' ? 'Sem valor recebido' : (item.error || 'Não lido');
      const statusClass = item.status === 'ok' ? 'rc-ok' : item.status === 'ignorado' ? 'rc-warn' : 'rc-bad';
      const pdf = item.hasPdf
        ? `<button class="rc-link" type="button" data-rc-pdf="${esc(item.parcela)}">Abrir PDF</button>`
        : '—';
      return `<tr>
        <td>${esc(item.centroCusto || '—')}</td><td>${esc(item.grupo || '—')}</td><td><strong>${esc(item.empresa || '—')}</strong></td>
        <td>${esc(item.documento || '—')}</td><td>${esc(item.parcela || '—')}</td><td>${esc(item.vencimento || '—')}</td>
        <td>${esc(item.dataCredito || '—')}</td><td>${money.format(Number(item.valor) || 0)}</td>
        <td class="${statusClass}">${esc(label)}</td><td>${pdf}</td>
      </tr>`;
    }).join('');
    byId('rcItemsNote').textContent = `${number.format(rows.length)} de ${number.format(state.items.length)} parcela(s). O PDF abre a versão gerada a partir do recibo oficial do S4E.`;
  }

  function render() {
    byId('rcStart').max = byId('rcEnd').value || '';
    byId('rcEnd').min = byId('rcStart').value || '';
    renderRuns();
    renderSummary();
    renderJob();
    controls();
  }

  async function loadItems(runId) {
    if (!runId) return;
    state.itemsLoading = true;
    try {
      const data = await api(`/api/recibos/itens?run=${encodeURIComponent(runId)}`);
      state.items = data.items || [];
      state.itemsRun = runId;
      renderItems();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.itemsLoading = false;
    }
  }

  function inspect(runId) {
    state.selectedRun = runId;
    byId('rcItems').hidden = false;
    const run = runById(runId);
    byId('rcItemsTitle').textContent = run ? `Conferência · ${brDay(run.periodStart)} a ${brDay(run.periodEnd)}` : 'Conferência dos recibos';
    state.items = [];
    renderItems();
    loadItems(runId);
    render();
    byId('rcItems').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function load() {
    if (!visible()) return;
    const sequence = ++state.sequence;
    state.loading = true;
    controls();
    try {
      if (state.job?.running) {
        const job = await api('/api/recibos/job');
        if (sequence !== state.sequence || !visible()) return;
        state.job = job;
        renderJob();
        controls();
        if (job.running) return;
      }
      const [overview, job] = await Promise.all([api('/api/recibos'), api('/api/recibos/job')]);
      if (sequence !== state.sequence || !visible()) return;
      state.overview = overview;
      state.job = job;
      fillCentros();
      loadPrevia();
      render();
      if (job.error && !job.running) message(`A última geração falhou: ${job.error}`, true);
      else if (job.message && !job.running) message(job.message, job.phase === 'erro');
      if (state.itemsRun && byId('rcItems').hidden === false) loadItems(state.itemsRun);
    } catch (error) {
      if (sequence === state.sequence && visible()) message(error.message, true);
    } finally {
      if (sequence === state.sequence) {
        state.loading = false;
        controls();
        schedule();
      }
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (visible()) state.timer = setTimeout(load, state.job?.running ? 2500 : 30000);
  }

  async function start() {
    if (state.starting || state.job?.running) return;
    const start = byId('rcStart').value;
    const end = byId('rcEnd').value;
    if (!start || !end) return message('Escolha a data inicial e a final do período.', true);
    if (end < start) return message('A data final precisa ser depois da data inicial.', true);
    if (daysBetween(start, end) > 62) return message('Escolha um período de até 62 dias para não sobrecarregar o S4E.', true);
    state.starting = true;
    message();
    controls();
    try {
      const result = await api('/api/recibos/run', {
        method: 'POST',
        body: JSON.stringify({
          start, end,
          centro: byId('rcGroup').value,
          grupo: byId('rcUnion').value,
        }),
      });
      state.job = result.job;
      state.selectedRun = result.runId;
      byId('rcItems').hidden = true;
      state.items = [];
      renderJob();
      await load();
    } catch (error) {
      message(error.message, true);
    } finally {
      state.starting = false;
      controls();
    }
  }

  async function download(runId) {
    if (!runId) return;
    const run = runById(runId);
    if (!run?.hasZip) return message('Esta geração ainda não possui pasta para baixar.', true);
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/recibos/download?id=${encodeURIComponent(runId)}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível baixar a pasta.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const match = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/);
      anchor.href = url;
      anchor.download = match ? match[1] : 'recibos.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      message('Pasta pronta. Se o download não aparecer, use o link:', false, { blob, filename: match ? match[1] : 'recibos.zip' });
    } catch (error) {
      message(error.message, true);
    }
  }

  async function openPdf(parcela) {
    const runId = state.itemsRun || state.selectedRun;
    if (!runId || !parcela) return;
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/recibos/pdf?run=${encodeURIComponent(runId)}&parcela=${encodeURIComponent(parcela)}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível abrir o recibo.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener');
      if (!win) {
        message('O navegador bloqueou a janela do PDF. Use o download da pasta para abrir o arquivo.', true);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      message(error.message, true);
    }
  }

  byId('rcForm').addEventListener('submit', event => {
    event.preventDefault();
    start();
  });
  byId('rcDownload').addEventListener('click', () => download(state.selectedRun));
  byId('rcSearch').addEventListener('input', renderItems);
  byId('rcItemsClose').addEventListener('click', () => { byId('rcItems').hidden = true; state.items = []; });
  byId('rcRuns').addEventListener('click', event => {
    const downloadButton = event.target.closest('[data-rc-download]');
    if (downloadButton) {
      state.selectedRun = downloadButton.dataset.rcDownload;
      download(downloadButton.dataset.rcDownload);
      return;
    }
    const inspectButton = event.target.closest('[data-rc-inspect]');
    if (inspectButton) {
      inspect(inspectButton.dataset.rcInspect);
      return;
    }
    const card = event.target.closest('[data-rc-run]');
    if (card) {
      state.selectedRun = card.dataset.rcRun;
      render();
    }
  });
  byId('rcItemRows').addEventListener('click', event => {
    const button = event.target.closest('[data-rc-pdf]');
    if (button) openPdf(button.dataset.rcPdf);
  });
  byId('rcStart').addEventListener('change', () => { render(); schedulePrevia(); });
  byId('rcEnd').addEventListener('change', () => { render(); schedulePrevia(); });
  byId('rcGroup').addEventListener('change', () => { fillGrupos(); schedulePrevia(); render(); });
  byId('rcUnion').addEventListener('change', schedulePrevia);

  setInterval(() => {
    if (visible() && state.job?.running) renderJob();
  }, 1000);

  function enter() {
    state.active = true;
    if (!byId('rcStart').value) {
      const today = new Date();
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      byId('rcStart').value = isoDay(first);
      byId('rcEnd').value = isoDay(today);
    }
    load();
  }

  function leave() {
    state.active = false;
    state.sequence += 1;
    state.previaSeq += 1;
    clearTimeout(state.timer);
    clearTimeout(state.previaTimer);
  }

  window.enterRecibosScreen = enter;
  window.leaveRecibosScreen = leave;
})();

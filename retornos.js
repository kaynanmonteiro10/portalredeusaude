(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('retornosScreen');
  if (!root) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const date = value => {
    if (!value) return '—';
    if (/^\d{2}\/\d{2}\/\d{4}/.test(value)) return value;
    return new Date(value).toLocaleString('pt-BR');
  };
  const today = () => { const day = new Date(); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
  const allowed = () => !!window.PortalAccess?.Access?.token && !!window.PortalAccess?.canSee?.('retornosScreen') && !window.PortalAccess.Access.offline;
  const token = () => window.PortalAccess?.Access?.token || '';
  const state = { owner: '', sequence: 0, timer: null, loading: false, ready: false, incidents: [], institutions: [],
    monitor: {}, period: {}, range: { start: today(), end: today() }, error: '', requestScan: false, seen: new Map(), seenReady: false };
  const api = (path, options) => window.PortalAccess.api(path, options);
  const valid = (sequence, owner) => allowed() && state.sequence === sequence && state.owner === owner && token() === owner;

  function render() {
    const query = fold($('retornosSearch').value.trim());
    const institution = $('retornosInstitution').value;
    const status = $('retornosStatus').value;
    const matching = state.incidents.filter(item => (!institution || item.type === institution) && (!query || fold(JSON.stringify(item)).includes(query)));
    const visible = matching.filter(item => status === 'all' || item.state === status);
    const openCount = visible.filter(item => item.state === 'open').length;
    const resolvedCount = visible.filter(item => item.state === 'resolved').length;
    $('retornosAlertCount').textContent = `${openCount} com erro · ${resolvedCount} corrigidos`;
    const badge = $('retornosNavBadge');
    badge.textContent = String(openCount);
    badge.classList.toggle('hidden', !openCount);
    badge.setAttribute('aria-label', `${openCount} erros de retornos nos filtros atuais`);
    $('retornosIncidents').innerHTML = visible.map(item => {
      const corrected = item.state === 'resolved';
      const line = item.line;
      const fields = line ? [['Parcela', line.installment], ['Nosso número', line.ourNumber], ['Linha', line.line],
        ['Valor', line.value], ['Pago', line.paid], ['Vencimento', line.dueDate], ['Pagamento', line.paymentDate],
        ['Multa', line.fine], ['Desconto', line.discount], ['Tarifa', line.fee], ['Auxiliar', line.auxiliary]] : [];
      return `<article class="retornos-incident ${corrected ? 'is-resolved' : 'is-open'}">
        <div class="retornos-heading"><strong>${esc(item.type)}</strong><span class="retornos-tag ${corrected ? 'retornos-success' : 'retornos-error'}">${corrected ? 'Corrigido' : 'Com erro'}</span></div>
        <h4>${esc(item.message)}${line?.occurrenceCode ? ` <small>· Código ${esc(line.occurrenceCode)}</small>` : ''}</h4>
        ${line ? `<p><strong>${esc(line.client || 'Cliente não identificado pelo S4E')}</strong> · Parcela ${esc(line.installment)} · Valor R$ ${esc(line.value || '—')}</p>` : ''}
        <p class="retornos-note">Retorno de ${esc(item.processedAt)} · Convênio ${esc(item.agreement)} · ${esc(item.filename)}</p>
        <p class="retornos-note">Identificado em ${esc(date(item.firstSeen))}${corrected ? ` · Correção confirmada em ${esc(date(item.resolvedAt))}` : ''}</p>
        ${corrected && item.resolution ? `<p class="retornos-note">Correção no lote ${esc(item.resolution.loteId)} · Processado em ${esc(item.resolution.processedAt)}${item.resolution.line ? ` · Parcela ${esc(item.resolution.line.installment)} · ${esc(item.resolution.line.occurrence)}` : ''}</p>` : ''}
        <details><summary>Detalhes do erro original</summary><div class="retornos-error-fields">
          <div><span>Lote</span><strong>${esc(item.loteId)}</strong></div><div><span>Situação no S4E</span><strong>${esc(item.sourceStatus)}</strong></div>
          ${fields.filter(([, value]) => value !== '' && value != null).map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}
        </div><p class="retornos-note">O erro original fica preservado. A correção exige sucesso confirmado para o título; em novo lote, também conferimos arquivo, instituição, convênio, Nosso Número, empresa, datas e valores. Nenhum arquivo é reprocessado por esta consulta.</p></details>
      </article>`;
    }).join('') || `<p class="empty-state">${!state.ready ? 'Conferindo os retornos...' : !state.period.checkedAt ? 'Aguardando a conferência completa deste período.' : matching.length ? 'Nenhuma ocorrência nesta situação.' : 'Nenhum erro registrado neste período para estes filtros.'}</p>`;
    const error = state.error || state.monitor.error || '';
    $('retornosError').textContent = error ? `${error.replace(/\.+$/, '')}. Os últimos dados confirmados continuam disponíveis.` : '';
    $('retornosError').classList.toggle('hidden', !error);
    $('retornosMonitor').textContent = state.monitor.running ? 'Conferindo os retornos de todas as instituições...' : state.requestScan ? 'Seu período será conferido assim que a consulta atual terminar.' : state.period.checkedAt ? `Última conferência: ${date(state.period.checkedAt)} · Atualização automática a cada 5 minutos.` : 'Aguardando a conferência dos retornos.';
    $('retornosApply').disabled = !allowed() || !state.ready;
  }

  function notify(incidents) {
    const notifier = window.PortalNotify;
    incidents.forEach(item => {
      const previous = state.seen.get(item.id);
      const changed = state.seenReady && previous !== item.state;
      state.seen.set(item.id, item.state);
      if (!changed || !notifier?.enabled?.() || !notifier.allows?.('retornos')) return;
      notifier.push({ category: 'retornos', title: item.state === 'resolved' ? 'Retorno corrigido' : 'Erro no retorno financeiro',
        body: `${item.type}: ${item.message}`, tag: `retornos-${item.id}-${item.state}`,
        onClick: () => { if (allowed()) window.PortalAccess.openScreen('retornosScreen'); } });
    });
    state.seenReady = true;
  }

  function schedule() {
    if (state.timer) clearTimeout(state.timer);
    if (allowed() && state.owner === token()) state.timer = setTimeout(refresh, state.monitor.running || state.requestScan ? 2500 : 30000);
  }

  async function refresh() {
    if (!allowed() || state.loading) return;
    if (state.owner !== token()) { start(); return; }
    if (state.timer) clearTimeout(state.timer);
    const sequence = ++state.sequence, owner = state.owner;
    const range = { ...state.range };
    state.loading = true;
    try {
      const data = await api(`/api/retornos?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`);
      if (!valid(sequence, owner)) return;
      state.incidents = Array.isArray(data.incidents) ? data.incidents : state.incidents;
      state.institutions = data.institutions || [];
      state.monitor = data.monitor || {};
      state.period = data.period || {};
      state.ready = true;
      state.error = '';
      const selected = $('retornosInstitution').value;
      $('retornosInstitution').innerHTML = '<option value="">Todas as instituições</option>' + state.institutions.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
      $('retornosInstitution').value = state.institutions.includes(selected) ? selected : '';
      notify(state.incidents);
      render();
      if (state.requestScan && !state.monitor.running) {
        const result = await api('/api/retornos/sync', { method: 'POST', body: JSON.stringify(range) });
        if (!valid(sequence, owner)) return;
        state.monitor = result.monitor;
        if (state.monitor.periodStart === range.start && state.monitor.periodEnd === range.end) state.requestScan = false;
      }
    } catch (error) {
      if (valid(sequence, owner)) state.error = error.message;
    } finally {
      if (valid(sequence, owner)) { state.loading = false; render(); schedule(); }
    }
  }

  function selectRange() {
    const start = $('retornosStart').value, end = $('retornosEnd').value;
    const days = (Date.parse(end) - Date.parse(start)) / 86400000;
    if (!start || !end || !Number.isFinite(days) || days < 0 || days > 30 || end > today()) {
      state.error = 'Escolha um período de até 31 dias, sem datas futuras';
      render();
      return;
    }
    state.sequence++;
    state.loading = false;
    state.range = { start, end };
    state.incidents = [];
    state.period = {};
    state.error = '';
    state.requestScan = true;
    $('retornosInstitution').value = '';
    render();
    refresh();
  }

  function reset() {
    if (state.timer) clearTimeout(state.timer);
    state.sequence++;
    Object.assign(state, { owner: '', timer: null, loading: false, ready: false, incidents: [], institutions: [], monitor: {}, period: {},
      range: { start: today(), end: today() }, error: '', requestScan: false, seenReady: false });
    state.seen.clear();
    $('retornosStart').value = today();
    $('retornosEnd').value = today();
    $('retornosInstitution').innerHTML = '<option value="">Todas as instituições</option>';
    $('retornosStatus').value = 'all';
    $('retornosSearch').value = '';
    $('retornosNavBadge').classList.add('hidden');
    root.classList.add('hidden');
    render();
  }
  function start() {
    if (!allowed()) { reset(); return; }
    if (state.owner === token()) return;
    const visible = !root.classList.contains('hidden');
    reset();
    if (visible) root.classList.remove('hidden');
    state.owner = token();
    refresh();
  }
  window.startRetornosPolling = start;
  window.resetRetornos = reset;
  window.enterRetornosScreen = () => { start(); if (allowed()) refresh(); };
  $('retornosFilterForm').addEventListener('submit', event => { event.preventDefault(); selectRange(); });
  $('retornosToday').addEventListener('click', () => { $('retornosStart').value = today(); $('retornosEnd').value = today(); selectRange(); });
  ['retornosInstitution', 'retornosStatus', 'retornosSearch'].forEach(id => $(id).addEventListener('input', render));
  $('retornosStart').value = today();
  $('retornosEnd').value = today();
  render();
  if (allowed()) start();
})();

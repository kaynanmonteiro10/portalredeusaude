(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = value => value === null || value === undefined || value === '' ? 'Não informado' : String(value);
  const state = { active: false, epoch: 0, timer: null, controller: null, busy: false, start: '', end: '', snapshots: new Map(), attempted: new Set(), companies: [], companyId: '', job: null, error: '', link: null, polls: 0, pending: false };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const key = () => `${state.start}/${state.end}`;
  const admin = () => window.PortalAccess?.Access?.user?.role === 'admin';
  const visible = () => state.active && admin() && !document.hidden && !el('vendasScreen').classList.contains('hidden') && !document.body.classList.contains('locked');
  const current = () => state.snapshots.get(key());
  const status = row => row.kind === 'cancelled' ? 'Cancelado' : text(row.status);
  const team = row => text(row.team);
  const seller = row => text(row.seller);
  const dateLabel = value => {
    if (!value) return 'Não informado';
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
    return Number.isNaN(d.getTime()) ? text(value) : d.toLocaleString('pt-BR', /^\d{4}-\d{2}-\d{2}$/.test(value) ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {});
  };
  function invalidate() {
    state.epoch += 1;
    clearTimeout(state.timer);
    state.timer = null;
    state.controller?.abort();
    state.controller = null;
    state.busy = false;
  }
  function valid(epoch, token) {
    return epoch === state.epoch && visible() && token === window.PortalAccess.Access.token;
  }
  async function request(path, options, epoch, token) {
    state.controller = new AbortController();
    const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, { ...options, signal: state.controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!valid(epoch, token)) throw new DOMException('Resposta antiga', 'AbortError');
    if (response.status === 401) {
      clearSession();
      showLogin(data.error || 'Faça login para continuar.');
      throw new DOMException('Sessão encerrada', 'AbortError');
    }
    if (response.status === 423) {
      showSystemLock(data);
      throw new DOMException('Portal bloqueado', 'AbortError');
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível consultar as vendas. Tente novamente pelo botão Consultar período.');
    return data;
  }
  function periodError(start, end) {
    const parse = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
      const n = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value ? n : NaN;
    };
    const a = parse(start), b = parse(end);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'Informe duas datas válidas.';
    if (start > today() || end > today()) return 'Não são permitidas datas futuras.';
    if (a > b) return 'A data inicial deve ser anterior ou igual à final.';
    if ((b - a) / 86400000 + 1 > 31) return 'Selecione um período de até 31 dias.';
    return '';
  }
  function initializeDates() {
    if (state.start) return;
    state.end = today();
    state.start = `${state.end.slice(0, 7)}-01`;
    el('vendasStart').value = state.start;
    el('vendasEnd').value = state.end;
    el('vendasStart').max = el('vendasEnd').max = today();
  }
  function accept(data) {
    const snapshot = data.snapshot;
    if (snapshot && snapshot.start === state.start && snapshot.end === state.end) state.snapshots.set(key(), snapshot);
    state.job = data.job || null;
    state.companies = Array.isArray(data.companies) ? data.companies : [];
    if (state.job && state.job.start === state.start && state.job.end === state.end && (state.job.startedAt || state.job.running || state.job.error)) state.attempted.add(key());
    state.error = state.job?.start === state.start && state.job?.end === state.end && state.job?.error ? text(state.job.error) : '';
    fillFilters();
    render();
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!visible() || state.error) return;
    if (state.job?.running && state.polls >= 360) {
      state.error = 'A consulta continua em andamento. O acompanhamento foi pausado; use Consultar período para verificar novamente.';
      renderMonitor();
      return;
    }
    state.timer = setTimeout(() => load(false), state.job?.running ? 2500 : 30000);
  }
  async function load(auto = false) {
    if (!visible() || state.busy) return;
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    state.busy = true;
    renderMonitor();
    try {
      const data = await request(`/api/vendas?${new URLSearchParams({ start: state.start, end: state.end })}`, {}, epoch, token);
      if (!valid(epoch, token)) return;
      accept(data);
      state.polls = state.job?.running ? state.polls + 1 : 0;
      if (!state.job?.running && !state.error && (state.pending || (auto && !current() && !state.attempted.has(key())))) {
        state.pending = false;
        state.attempted.add(key());
        const result = await request('/api/vendas/consultar', { method: 'POST', body: JSON.stringify({ start: state.start, end: state.end }) }, epoch, token);
        if (!valid(epoch, token)) return;
        state.job = result.job;
      }
    } catch (error) {
      if (valid(epoch, token) && error.name !== 'AbortError') state.error = error.message || 'Não foi possível conectar. Use Consultar período para tentar novamente.';
    } finally {
      if (valid(epoch, token)) {
        state.busy = false;
        state.controller = null;
        renderMonitor();
        schedule();
      }
    }
  }
  async function consult() {
    if (!visible() || state.busy) return;
    const start = el('vendasStart').value, end = el('vendasEnd').value;
    const error = periodError(start, end);
    if (error) { state.error = error; renderMonitor(); return; }
    const changed = start !== state.start || end !== state.end;
    invalidate();
    state.start = start;
    state.end = end;
    state.error = '';
    state.polls = 0;
    state.attempted.add(key());
    if (changed) state.job = null;
    fillFilters();
    render();
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    state.busy = true;
    renderMonitor();
    try {
      const cached = await request(`/api/vendas?${new URLSearchParams({ start, end })}`, {}, epoch, token);
      accept(cached);
      state.pending = Boolean(state.job?.running && (state.job.start !== start || state.job.end !== end));
      if (!state.job?.running) {
        const data = await request('/api/vendas/consultar', { method: 'POST', body: JSON.stringify({ start, end }) }, epoch, token);
        if (!valid(epoch, token)) return;
        state.job = data.job;
        state.error = state.job?.error ? text(state.job.error) : '';
      }
    } catch (err) {
      if (valid(epoch, token) && err.name !== 'AbortError') state.error = err.message;
    } finally {
      if (valid(epoch, token)) {
        state.busy = false;
        state.controller = null;
        renderMonitor();
        schedule();
      }
    }
  }
  function renderMonitor() {
    const job = state.job;
    let message = state.busy ? 'Consultando período…' : `Período selecionado: ${dateLabel(state.start)} a ${dateLabel(state.end)}.`;
    if (job?.running) {
      const began = new Date(job.startedAt).getTime();
      const seconds = Number.isFinite(began) ? Math.max(0, Math.floor((Date.now() - began) / 1000)) : null;
      message = `${text(job.message || 'Consulta em andamento')} · ${dateLabel(job.start)} a ${dateLabel(job.end)}`;
      if (seconds !== null) message += ` · Decorrido: ${Math.floor(seconds / 60)}min ${seconds % 60}s`;
      if (job.done !== null && job.done !== undefined && job.total !== null && job.total !== undefined) message += ` · ${job.done}/${job.total}`;
    } else if (job?.message && job.start === state.start && job.end === state.end) message += ` ${text(job.message)}`;
    if (state.pending) message += ` · O período ${dateLabel(state.start)} a ${dateLabel(state.end)} será consultado após a conclusão atual.`;
    el('vendasMonitor').textContent = message;
    const progress = el('vendasProgress');
    progress.classList.toggle('hidden', !job?.running);
    if (Number(job?.total) > 0) { progress.max = Number(job.total); progress.value = Math.max(0, Number(job.done) || 0); }
    else progress.removeAttribute('value');
    el('vendasError').textContent = state.error;
    el('vendasError').classList.toggle('hidden', !state.error);
    el('vendasConsult').disabled = state.busy;
    el('vendasToday').disabled = state.busy;
  }
  function fillSelect(id, values, label) {
    const select = el(id), previous = select.value;
    select.innerHTML = `<option value="">${label}</option>` + [...new Set(values)].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    select.value = values.includes(previous) ? previous : '';
  }
  function fillFilters() {
    const rows = current()?.rows || [];
    fillSelect('vendasTeam', rows.map(team), 'Todas');
    fillSelect('vendasSeller', rows.map(seller), 'Todos');
    fillSelect('vendasStatus', rows.map(status), 'Todas');
  }
  const numeric = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const n = Number(String(value || '0').replace(/R\$|\s/g, '').replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  function render() {
    renderMonitor();
    const snapshot = current();
    el('vendasSnapshotTitle').textContent = snapshot ? `S4E · ${dateLabel(snapshot.start)} a ${dateLabel(snapshot.end)}` : `Sem dados · ${dateLabel(state.start)} a ${dateLabel(state.end)}`;
    el('vendasChecked').textContent = snapshot ? `Consultado em ${dateLabel(snapshot.checkedAt)}. Valores monetários e médias por equipe conforme S4E.` : 'Aguardando consulta deste período. Dados de outros períodos não são exibidos.';
    const teams = snapshot?.teams || [];
    const totals = teams.reduce((sum, t) => {
      ['lives', 'contracts', 'value', 'cancelledLives', 'cancelledValue'].forEach(field => { sum[field] += numeric(t[field]); });
      return sum;
    }, { lives: 0, contracts: 0, value: 0, cancelledLives: 0, cancelledValue: 0 });
    el('vendasTotals').innerHTML = snapshot ? [['Vidas vendidas', totals.lives.toLocaleString('pt-BR')], ['Contratos', totals.contracts.toLocaleString('pt-BR')], ['Valor de vendas', money(totals.value)], ['Vidas canceladas', totals.cancelledLives.toLocaleString('pt-BR')], ['Valor cancelado', money(totals.cancelledValue)]].map(([label, value]) => `<article><span>${esc(label)}</span><strong>${esc(value)}</strong><small>Soma das equipes oficiais</small></article>`).join('') : '';
    el('vendasTeams').innerHTML = teams.map(t => `<tr>${['team', 'lives', 'contracts', 'value', 'averageValue', 'cancelledLives', 'cancelledValue', 'cancelledAverageValue'].map(f => `<td>${esc(text(t[f]))}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="8">Nenhuma equipe disponível neste período.</td></tr>';
    const names = { plan: 'Plano', paymentType: 'Forma de pagamento', periodStatus: 'Situação no período', currentStatus: 'Situação atual', clientType: 'Tipo de cliente', state: 'Estado', city: 'Cidade' };
    el('vendasBreakdowns').innerHTML = Object.entries(names).map(([field, label]) => {
      const entries = snapshot?.breakdowns?.[field] || [];
      return `<details><summary>${label}</summary><div class="vendas-table-wrap"><table class="history-table"><thead><tr><th>Descrição</th><th>Vidas</th><th>Valor S4E</th><th>Percentual S4E</th></tr></thead><tbody>${entries.map(r => `<tr><td>${esc(text(r.label))}</td><td>${esc(text(r.lives))}</td><td>${esc(text(r.value))}</td><td>${esc(text(r.percent))}</td></tr>`).join('') || '<tr><td colspan="4">Não informado.</td></tr>'}</tbody></table></div></details>`;
    }).join('');
    renderRows();
  }
  function renderRows() {
    const rows = current()?.rows || [];
    const query = el('vendasSearch').value.trim().toLocaleLowerCase('pt-BR');
    const filtered = rows.map((row, index) => ({ row, index })).filter(({ row }) => {
      const linked = Boolean(row.companyId && row.linkedCompany?.id === row.companyId);
      return (!state.companyId || (linked && row.companyId === state.companyId)) && (!el('vendasTeam').value || team(row) === el('vendasTeam').value) && (!el('vendasSeller').value || seller(row) === el('vendasSeller').value) && (!el('vendasStatus').value || status(row) === el('vendasStatus').value) && (!el('vendasKind').value || row.kind === el('vendasKind').value) && (!el('vendasLinked').value || linked === (el('vendasLinked').value === 'yes')) && (!query || [row.client, row.company, row.batch, row.commission, row.linkedCompany?.name, row.linkedCompany?.cnpj].map(text).join(' ').toLocaleLowerCase('pt-BR').includes(query));
    });
    const matchedCompany = rows.filter(row => row.companyId === state.companyId && row.linkedCompany?.id === row.companyId);
    const company = state.companies.find(c => c.id === state.companyId) || matchedCompany[0]?.linkedCompany;
    el('vendasCompanyNote').classList.toggle('hidden', !state.companyId);
    el('vendasClearCompany').classList.toggle('hidden', !state.companyId);
    el('vendasCompanyNote').textContent = state.companyId ? `Vínculos confirmados: ${text(company?.name || state.companyId)}${company?.cnpj ? ` · ${company.cnpj}` : ''}. ${matchedCompany.length ? 'Os demais filtros também se aplicam.' : 'Sem linhas vinculadas a esta empresa no período selecionado.'}` : '';
    el('vendasRowCount').textContent = `${filtered.length} de ${rows.length} registros (não é contagem de contratos).`;
    el('vendasRows').innerHTML = filtered.map(({ row: r, index }) => {
      const linked = r.companyId && r.linkedCompany?.id === r.companyId;
      const info = [['Registro', r.key], ['Empresa de origem', r.company], ['Responsável ID', r.responsibleId], ['Responsável', r.responsible], ['Vendedor ID', r.sellerId], ['Vendedor', seller(r)], ['Equipe ID', r.teamId], ['Plano', r.plan], ['Assinatura', r.signatureDate], ['Cancelado em', r.cancelledAt], ['Motivo', r.reason], ['Chave de vínculo', r.linkKey]];
      return `<tr><td><span class="vendas-tag${r.kind === 'cancelled' ? ' vendas-cancelled' : ''}">${r.kind === 'cancelled' ? 'Cancelamento' : 'Venda'}</span><br>${esc(status(r))}</td><td><strong>${esc(text(r.client))}</strong><br>${esc(text(r.company))}</td><td>${esc(team(r))}<br>${esc(seller(r))}</td><td>${esc(text(r.kind === 'cancelled' ? r.cancelledAt : r.registeredAt))}${r.kind === 'cancelled' ? '<br>Cancelamento' : `<br>Lote: ${esc(text(r.batch))}`}</td><td>${esc(text(r.value))}</td><td>${esc(text(r.commission))}</td><td>${linked ? `<strong>${esc(text(r.linkedCompany.name))}</strong><br>${esc(text(r.linkedCompany.cnpj))}<div class="vendas-actions"><button type="button" data-vendas-contract="${index}">Contrato</button><button type="button" data-vendas-commission="${index}">Comissões</button></div>` : 'Sem vínculo confirmado'}${r.linkKey ? `<button type="button" data-vendas-link="${index}">${linked ? 'Alterar vínculo' : 'Vincular contrato'}</button>` : ''}</td><td><details><summary>Ver detalhes</summary><dl>${info.map(([label, value]) => `<dt>${label}</dt><dd>${esc(text(value))}</dd>`).join('')}</dl></details></td></tr>`;
    }).join('');
    el('vendasEmpty').textContent = filtered.length ? '' : current() ? 'Nenhum registro corresponde ao período e aos filtros selecionados.' : 'Ainda não há dados consultados deste período.';
    el('vendasEmpty').classList.toggle('hidden', filtered.length > 0);
  }
  function companyOptions() {
    const select = el('vendasCompanySelect'), previous = select.value;
    const query = el('vendasCompanySearch').value.trim().toLocaleLowerCase('pt-BR');
    const companies = state.companies.filter(c => !query || `${c.name} ${c.cnpj}`.toLocaleLowerCase('pt-BR').includes(query));
    select.innerHTML = '<option value="">Selecione explicitamente um contrato</option>' + companies.map(c => `<option value="${esc(c.id)}">${esc(text(c.name))} · ${esc(text(c.cnpj))}</option>`).join('');
    select.value = companies.some(c => c.id === previous) ? previous : '';
    targetDescription();
  }
  function targetDescription() {
    const c = state.companies.find(c => c.id === el('vendasCompanySelect').value);
    el('vendasLinkTarget').textContent = c ? `Contrato: ${text(c.name)} · CNPJ: ${text(c.cnpj)} · Vendedor: ${text(c.seller)}` : 'Nenhum contrato selecionado. Não há sugestão ou vínculo automático por nome.';
  }
  function openLink(row) {
    if (!visible() || state.busy || !row.linkKey || !current()) return;
    clearTimeout(state.timer);
    state.link = { row, snapshotId: current().id, epoch: state.epoch };
    el('vendasLinkSource').textContent = `Fonte S4E: ${text(row.company)} · Responsável ID: ${text(row.responsibleId)} · Responsável: ${text(row.responsible)} · Vendedor: ${seller(row)} (ID: ${text(row.sellerId)}) · Registro: ${text(row.key)} · Chave: ${row.linkKey}`;
    el('vendasCompanySearch').value = '';
    el('vendasCompanySelect').value = '';
    el('vendasLinkError').classList.add('hidden');
    el('vendasLinkConfirm').disabled = false;
    el('vendasLinkCancel').disabled = false;
    companyOptions();
    el('vendasLinkDialog').showModal();
  }
  el('vendasLinkForm').addEventListener('submit', async event => {
    event.preventDefault();
    const link = state.link, companyId = el('vendasCompanySelect').value;
    if (!visible() || state.busy || !link || link.epoch !== state.epoch || !state.companies.some(c => c.id === companyId)) return;
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    state.busy = true;
    el('vendasLinkConfirm').disabled = true;
    el('vendasLinkCancel').disabled = true;
    try {
      await request('/api/vendas/vinculos', { method: 'PUT', body: JSON.stringify({ linkKey: link.row.linkKey, companyId, snapshotId: link.snapshotId }) }, epoch, token);
      if (!valid(epoch, token)) return;
      state.busy = false;
      el('vendasLinkDialog').close();
      await load(false);
    } catch (error) {
      if (valid(epoch, token) && error.name !== 'AbortError') {
        el('vendasLinkError').textContent = error.message;
        el('vendasLinkError').classList.remove('hidden');
      }
    } finally {
      if (valid(epoch, token)) { state.busy = false; el('vendasLinkConfirm').disabled = false; el('vendasLinkCancel').disabled = false; renderMonitor(); }
    }
  });
  el('vendasLinkCancel').addEventListener('click', () => el('vendasLinkDialog').close());
  el('vendasLinkDialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
  el('vendasLinkDialog').addEventListener('close', () => { state.link = null; schedule(); });
  el('vendasCompanySearch').addEventListener('input', companyOptions);
  el('vendasCompanySelect').addEventListener('change', targetDescription);
  el('vendasPeriodForm').addEventListener('submit', event => { event.preventDefault(); consult(); });
  el('vendasToday').addEventListener('click', () => { el('vendasStart').value = el('vendasEnd').value = today(); consult(); });
  ['vendasTeam', 'vendasSeller', 'vendasStatus', 'vendasKind', 'vendasLinked'].forEach(id => el(id).addEventListener('change', renderRows));
  el('vendasSearch').addEventListener('input', renderRows);
  el('vendasClearCompany').addEventListener('click', () => { state.companyId = ''; renderRows(); });
  el('vendasRows').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !visible()) return;
    const field = ['vendasLink', 'vendasContract', 'vendasCommission'].find(f => button.dataset[f] !== undefined);
    if (!field) return;
    const row = current()?.rows?.[Number(button.dataset[field])];
    if (!row) return;
    if (field === 'vendasLink') openLink(row);
    else if (row.companyId && row.linkedCompany?.id === row.companyId) {
      if (field === 'vendasContract') window.openContractFromVendas?.(row.companyId);
      else window.openCommissionFromVendas?.(row.companyId);
    }
  });
  window.enterVendasScreen = () => {
    if (!admin()) return;
    initializeDates();
    if (state.active && visible()) return;
    state.active = true;
    state.error = '';
    state.polls = 0;
    render();
    load(true);
  };
  window.leaveVendasScreen = () => {
    state.active = false;
    state.pending = false;
    invalidate();
    el('vendasLinkDialog').close();
  };
  window.resetVendas = () => {
    window.leaveVendasScreen();
    state.snapshots.clear();
    state.attempted.clear();
    state.companies = [];
    state.companyId = '';
    state.start = state.end = '';
    state.job = null;
    state.error = '';
    state.link = null;
    ['vendasTeam', 'vendasSeller', 'vendasStatus', 'vendasKind', 'vendasLinked', 'vendasSearch', 'vendasCompanySearch'].forEach(id => { el(id).value = ''; });
    el('vendasCompanySelect').innerHTML = '';
    el('vendasLinkSource').textContent = '';
    el('vendasLinkTarget').textContent = '';
    el('vendasLinkCancel').disabled = false;
    el('vendasLinkError').textContent = '';
    fillFilters();
    render();
  };
  window.openVendasForCompany = companyId => {
    if (!admin() || !companyId) return;
    state.companyId = String(companyId);
    ['vendasTeam', 'vendasSeller', 'vendasStatus', 'vendasKind', 'vendasLinked', 'vendasSearch'].forEach(id => { el(id).value = ''; });
    window.PortalAccess.openScreen('vendasScreen');
    renderRows();
  };
  document.addEventListener('visibilitychange', () => {
    if (!state.active) return;
    invalidate();
    el('vendasLinkDialog').close();
    if (visible()) { state.error = ''; state.polls = 0; load(true); }
  });
})();

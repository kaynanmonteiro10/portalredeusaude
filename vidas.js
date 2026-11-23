(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = value => Number(value || 0).toLocaleString('pt-BR');
  const signed = value => value > 0 ? `+${num(value)}` : num(value);
  const money = value => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const percent = value => `${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const state = {
    active: false, epoch: 0, timer: null, controller: null, busy: false,
    start: '', end: '', centro: '', grupo: '', data: null, job: null,
    error: '', attempted: new Set(), polls: 0, expanded: new Set(), tab: 'geral',
  };
  const people = { loaded: false, busy: false, data: null, error: '', status: '', timer: null, pollTimer: null, polls: 0 };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const key = () => `${state.start}/${state.end}`;
  const isAdmin = () => window.PortalAccess?.Access?.user?.role === 'admin';
  const allowed = () => {
    const user = window.PortalAccess?.Access?.user;
    if (!user) return false;
    if (user.role === 'admin') return true;
    const screens = user.allowedScreens || user.screens || [];
    return screens.includes('vidasScreen');
  };
  const visible = () => state.active && allowed() && !document.hidden && !el('vidasScreen').classList.contains('hidden') && !document.body.classList.contains('locked');
  const dateLabel = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '—';
    const [y, m, d] = value.split('-');
    return `${d}/${m}/${y}`;
  };
  const stampLabel = value => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
  function clearSessionLocal() { clearSession(); }
  async function request(path, options, epoch, token) {
    state.controller = new AbortController();
    const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, {
      ...options, signal: state.controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!valid(epoch, token)) throw new DOMException('Resposta antiga', 'AbortError');
    if (response.status === 401) {
      clearSessionLocal();
      showLogin(data.error || 'Faça login para continuar.');
      throw new DOMException('Sessão encerrada', 'AbortError');
    }
    if (response.status === 423) throw new DOMException('Portal bloqueado', 'AbortError');
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a movimentação de vidas.');
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
    el('vidasStart').value = state.start;
    el('vidasEnd').value = state.end;
    el('vidasStart').max = el('vidasEnd').max = today();
  }
  function initializePeopleDates() {
    if (el('vidasPessoasInicio').value) return;
    el('vidasPessoasFim').value = today();
    el('vidasPessoasInicio').value = `${today().slice(0, 7)}-01`;
    el('vidasPessoasInicio').max = el('vidasPessoasFim').max = today();
  }
  function stale() {
    const at = Date.parse(state.data?.movimentacao?.consultadoEm || '');
    return !Number.isFinite(at) || Date.now() - at > 30 * 60 * 1000;
  }
  function accept(data) {
    state.data = data;
    state.job = data.job || null;
    state.error = '';
    fillFilters();
    render();
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!visible() || state.error) return;
    if (state.job?.running && state.polls >= 360) {
      state.error = 'A consulta continua em andamento. O acompanhamento foi pausado; use Atualizar do S4E para verificar novamente.';
      renderMonitor();
      return;
    }
    state.timer = setTimeout(() => load(false), state.job?.running ? 2500 : 60000);
  }
  function startJob(epoch, token) {
    return request('/api/vidas/atualizar', { method: 'POST', body: JSON.stringify({ start: state.start, end: state.end }) }, epoch, token);
  }
  async function load(auto = false) {
    if (!visible() || state.busy) return;
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    state.busy = true;
    renderMonitor();
    try {
      const query = new URLSearchParams({ start: state.start, end: state.end, centro: state.centro, grupo: state.grupo });
      const data = await request(`/api/vidas?${query}`, {}, epoch, token);
      if (!valid(epoch, token)) return;
      accept(data);
      state.polls = state.job?.running ? state.polls + 1 : 0;
      const runningCurrent = state.job?.running && state.job?.start === state.start && state.job?.end === state.end;
      if (!runningCurrent && auto && stale() && !state.attempted.has(key())) {
        state.attempted.add(key());
        const result = await startJob(epoch, token);
        if (!valid(epoch, token)) return;
        state.job = result.job;
        state.polls = 0;
        renderMonitor();
      }
    } catch (error) {
      if (valid(epoch, token) && error.name !== 'AbortError') state.error = error.message || 'Não foi possível conectar. Use Atualizar do S4E para tentar novamente.';
    } finally {
      if (valid(epoch, token)) {
        state.busy = false;
        state.controller = null;
        renderMonitor();
        schedule();
      }
    }
  }
  async function refresh() {
    if (!visible() || state.busy) return;
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    state.busy = true;
    state.error = '';
    renderMonitor();
    try {
      const result = await startJob(epoch, token);
      if (!valid(epoch, token)) return;
      state.job = result.job;
      state.polls = 0;
    } catch (error) {
      if (valid(epoch, token) && error.name !== 'AbortError') state.error = error.message;
    } finally {
      if (valid(epoch, token)) {
        state.busy = false;
        state.controller = null;
        renderMonitor();
        schedule();
      }
    }
  }
  async function apply() {
    if (!visible() || state.busy) return;
    const start = el('vidasStart').value, end = el('vidasEnd').value;
    const error = periodError(start, end);
    if (error) {
      state.error = error;
      renderMonitor();
      return;
    }
    const changed = start !== state.start || end !== state.end;
    const centro = el('vidasCentro').value, grupo = el('vidasGrupo').value;
    invalidate();
    state.start = start;
    state.end = end;
    state.centro = centro;
    state.grupo = grupo;
    state.error = '';
    state.polls = 0;
    state.expanded.clear();
    state.busy = true;
    renderMonitor();
    const epoch = state.epoch, token = window.PortalAccess.Access.token;
    try {
      const query = new URLSearchParams({ start, end, centro, grupo });
      accept(await request(`/api/vidas?${query}`, {}, epoch, token));
      if (!valid(epoch, token)) return;
      if (changed && !state.data?.movimentacao?.consultaId && !state.attempted.has(key())) {
        state.attempted.add(key());
        const result = await startJob(epoch, token);
        if (!valid(epoch, token)) return;
        state.job = result.job;
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
    let message = `Período ${dateLabel(state.start)} a ${dateLabel(state.end)}.`;
    if (state.busy && !job?.running) message = 'Carregando movimentação…';
    if (job?.running) {
      message = `${job.message || 'Consultando o S4E…'} · ${dateLabel(job.start)} a ${dateLabel(job.end)}`;
      if (Number(job.total) > 0) message += ` · ${job.done}/${job.total}`;
    } else if (job?.error && job.start === state.start && job.end === state.end) {
      message = `A última consulta falhou: ${job.error}`;
    } else if (job?.message && job.start === state.start && job.end === state.end) {
      message += ` ${job.message}`;
    }
    const missing = Number(state.data?.totais?.naoAtribuidas || 0);
    if (missing) message += ` · ${num(missing)} movimentação(ões) sem centro de custo identificado.`;
    el('vidasMonitor').textContent = message;
    const progress = el('vidasProgress');
    progress.classList.toggle('hidden', !job?.running);
    if (Number(job?.total) > 0) {
      progress.max = Number(job.total);
      progress.value = Math.max(0, Number(job.done) || 0);
    } else {
      progress.removeAttribute('value');
      progress.max = 100;
    }
    el('vidasError').textContent = state.error;
    el('vidasError').classList.toggle('hidden', !state.error);
    el('vidasApply').disabled = state.busy;
    el('vidasRefresh').disabled = state.busy || Boolean(job?.running);
    el('vidasExport').disabled = state.busy;
  }
  function fillSelect(id, values, label, selected) {
    const select = el(id);
    select.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    select.value = values.includes(selected) ? selected : '';
  }
  function fillFilters() {
    const filtros = state.data?.filtros || {};
    fillSelect('vidasCentro', filtros.centros || [], 'Todos os centros', state.centro);
    fillGrupos(state.grupo);
  }
  function fillGrupos(selected) {
    const filtros = state.data?.filtros || {};
    const byCentro = filtros.gruposPorCentro || {};
    const centro = el('vidasCentro').value;
    const grupos = centro ? (byCentro[centro] || []) : (filtros.grupos || []);
    fillSelect('vidasGrupo', grupos, centro ? 'Todos os grupos deste centro' : 'Todos os grupos', selected);
  }
  function kpi(label, value, note, tone = '') {
    return `<article class="vidas-kpi ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
  }
  function renderTotals() {
    const totais = state.data?.totais;
    const apuracao = state.data?.apuracao;
    const box = el('vidasKpis');
    if (!totais) {
      box.innerHTML = '';
      return;
    }
    const atual = apuracao?.atual?.competencia || 'sem apuração';
    const anterior = apuracao?.anterior?.competencia || 'sem competência anterior';
    box.innerHTML = [
      kpi('Vidas que entraram', num(totais.entradas), 'vendas registradas no período', 'in'),
      kpi('Vidas que saíram', num(totais.saidas), 'cancelamentos registrados no período', 'out'),
      kpi('Saldo do período', signed(totais.saldo), totais.saldo >= 0 ? 'entradas superam as saídas' : 'saídas superam as entradas', totais.saldo >= 0 ? 'in' : 'out'),
      kpi('Empresas com movimento', num(totais.empresasComMovimento), 'com pelo menos uma entrada ou saída'),
      kpi('Vidas faturadas agora', num(totais.vidasAgora), `${atual} · variação ${signed(totais.variacao)} vs ${anterior}`, totais.variacao >= 0 ? 'in' : 'out'),
      kpi('Empresas fora da apuração', num(totais.empresasFora), `${num(totais.vidasFora)} vidas que não aparecem em ${atual}`),
      kpi('Valor mensal movimentado', money((totais.valorEntradas || 0) + (totais.valorSaidas || 0)), `entradas ${money(totais.valorEntradas)} · saídas ${money(totais.valorSaidas)}`),
      kpi('Taxa de saída', percent(totais.taxaSaida), `saídas sobre as ${num(totais.vidasAntes)} vidas faturadas antes`, 'out'),
    ].join('');
  }
  function renderChart() {
    const rows = state.data?.diario || [];
    const box = el('vidasChart');
    el('vidasChartNote').textContent = rows.length ? `${dateLabel(state.start)} a ${dateLabel(state.end)} · verde entradas, vermelho saídas` : '';
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Sem período para exibir.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map(r => Math.max(r.entradas, r.saidas)));
    const left = 44, right = 12, top = 14, bottom = 30;
    const step = rows.length > 21 ? 18 : 26;
    const width = left + right + rows.length * step;
    const height = 190;
    const plot = height - top - bottom;
    const every = Math.max(1, Math.ceil(38 / step));
    const bar = Math.max(4, step * 0.32);
    const grid = [0, 0.5, 1].map(ratio => {
      const y = top + plot - plot * ratio;
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="vidas-grid-line"/>`
        + `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="vidas-axis">${Math.round(max * ratio)}</text>`;
    }).join('');
    const bars = rows.map((row, index) => {
      const x = left + index * step;
      const entryH = (row.entradas / max) * plot;
      const exitH = (row.saidas / max) * plot;
      const label = index % every === 0 ? `<text x="${x + step / 2}" y="${height - 10}" text-anchor="middle" class="vidas-axis">${dateLabel(row.dia).slice(0, 5)}</text>` : '';
      return `<g><title>${dateLabel(row.dia)}: ${row.entradas} entrada(s), ${row.saidas} saída(s)</title>`
        + `<rect x="${x + step * 0.11}" y="${top + plot - entryH}" width="${bar}" height="${Math.max(entryH, row.entradas ? 2 : 0)}" rx="3" class="vidas-bar-in"/>`
        + `<rect x="${x + step * 0.11 + bar + 2}" y="${top + plot - exitH}" width="${bar}" height="${Math.max(exitH, row.saidas ? 2 : 0)}" rx="3" class="vidas-bar-out"/>`
        + `${label}</g>`;
    }).join('');
    box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Entradas e saídas por dia">${grid}${bars}</svg>`;
  }
  function renderRanking() {
    const rows = (state.data?.vendedores || []).filter(item => item.entradas > 0).slice(0, 8);
    const box = el('vidasRanking');
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Nenhuma venda no período com vendedor identificado.</p>';
      return;
    }
    const max = Math.max(...rows.map(item => item.entradas));
    box.innerHTML = rows.map(item => `
      <div class="vidas-rank-row">
        <div class="vidas-rank-label"><strong title="${esc(item.nome)}">${esc(item.nome)}</strong><small>${esc(item.equipe || 'Equipe não informada')}</small></div>
        <div class="vidas-rank-bar"><i style="width:${Math.max(3, Math.round((item.entradas / max) * 100))}%"></i></div>
        <b>${num(item.entradas)}</b>
      </div>`).join('');
  }
  function renderCarteira(id, rows) {
    const box = el(id);
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Sem dados para o filtro atual.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map(item => Math.max(item.vidasAntes, item.vidasAgora)));
    box.innerHTML = rows.slice(0, 10).map(item => `
      <div class="vidas-centro-row">
        <div class="vidas-centro-head">
          <strong>${esc(item.nome)}</strong>
          <span>${num(item.empresas)} empresa(s) · ${signed(item.vidasAgora - item.vidasAntes)} vidas</span>
        </div>
        <div class="vidas-bar-line"><span class="vidas-bar-label">antes</span><div class="vidas-bar-track"><i class="before" style="width:${Math.max(1, Math.round((item.vidasAntes / max) * 100))}%"></i></div><b>${num(item.vidasAntes)}</b></div>
        <div class="vidas-bar-line"><span class="vidas-bar-label">agora</span><div class="vidas-bar-track"><i class="after" style="width:${Math.max(1, Math.round((item.vidasAgora / max) * 100))}%"></i></div><b>${num(item.vidasAgora)}</b></div>
        <small class="vidas-centro-foot">${num(item.entradas)} entrada(s) · ${num(item.saidas)} saída(s) no período</small>
      </div>`).join('');
  }
  function renderCentros() {
    const apuracao = state.data?.apuracao;
    el('vidasCentrosNote').textContent = apuracao?.atual && apuracao?.anterior
      ? `Vidas faturadas: ${apuracao.anterior.competencia} → ${apuracao.atual.competencia}`
      : 'Comparativo disponível após duas apurações concluídas.';
    renderCarteira('vidasCentros', state.data?.centros || []);
  }
  function renderGrupos() {
    const apuracao = state.data?.apuracao;
    el('vidasGruposNote').textContent = apuracao?.atual && apuracao?.anterior
      ? `Vidas faturadas: ${apuracao.anterior.competencia} → ${apuracao.atual.competencia}`
      : 'Comparativo disponível após duas apurações concluídas.';
    renderCarteira('vidasGrupos', state.data?.grupos || []);
  }
  function renderEquipes() {
    const rows = (state.data?.equipes || []).slice(0, 10);
    const box = el('vidasEquipes');
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Nenhuma movimentação com equipe identificada.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map(item => Math.max(item.entradas, item.saidas)));
    box.innerHTML = rows.map(item => `
      <div class="vidas-centro-row">
        <div class="vidas-centro-head"><strong>${esc(item.nome)}</strong><span>saldo ${signed(item.saldo)}</span></div>
        <div class="vidas-bar-line"><span class="vidas-bar-label">ent.</span><div class="vidas-bar-track"><i class="in" style="width:${Math.max(0, Math.round((item.entradas / max) * 100))}%"></i></div><b>${num(item.entradas)}</b></div>
        <div class="vidas-bar-line"><span class="vidas-bar-label">saí.</span><div class="vidas-bar-track"><i class="out" style="width:${Math.max(0, Math.round((item.saidas / max) * 100))}%"></i></div><b>${num(item.saidas)}</b></div>
      </div>`).join('');
  }
  function renderMotivos() {
    const rows = (state.data?.motivos || []).slice(0, 8);
    const box = el('vidasMotivos');
    el('vidasMotivosNote').textContent = state.data?.totais
      ? `${num(state.data.totais.saidas)} saída(s) no período`
      : '';
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Nenhuma saída registrada no período e filtros atuais.</p>';
      return;
    }
    const max = Math.max(1, ...rows.map(item => item.saidas));
    box.innerHTML = rows.map(item => `
      <div class="vidas-rank-row out">
        <div class="vidas-rank-label"><strong title="${esc(item.nome)}">${esc(item.nome)}</strong></div>
        <div class="vidas-rank-bar"><i style="width:${Math.max(3, Math.round((item.saidas / max) * 100))}%"></i></div>
        <b>${num(item.saidas)}</b>
      </div>`).join('');
  }
  function renderBalance() {
    const rows = state.data?.diario || [];
    const box = el('vidasBalance');
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Sem período para exibir.</p>';
      return;
    }
    const values = rows.map(row => Number(row.acumulado || 0));
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values, 1);
    const span = max - min || 1;
    const left = 44, right = 16, top = 18, bottom = 30;
    const step = rows.length > 21 ? 18 : 26;
    const width = left + right + rows.length * step;
    const height = 190;
    const plot = height - top - bottom;
    const y = value => top + plot - ((value - min) / span) * plot;
    const base = y(0);
    const every = Math.max(1, Math.ceil(38 / step));
    const centers = rows.map((row, index) => left + index * step + step / 2);
    const points = centers.map((x, index) => `${x},${y(values[index])}`).join(' ');
    const area = `${centers[0]},${base} ${points} ${centers[centers.length - 1]},${base}`;
    const grid = [0, 0.5, 1].map(ratio => {
      const value = min + span * ratio;
      const gy = y(value);
      return `<line x1="${left}" y1="${gy}" x2="${width - right}" y2="${gy}" class="vidas-grid-line"/>`
        + `<text x="${left - 8}" y="${gy + 4}" text-anchor="end" class="vidas-axis">${signed(Math.round(value))}</text>`;
    }).join('');
    const labels = rows.map((row, index) => index % every === 0
      ? `<text x="${centers[index]}" y="${height - 10}" text-anchor="middle" class="vidas-axis">${dateLabel(row.dia).slice(0, 5)}</text>`
      : '').join('');
    const last = values[values.length - 1];
    const tail = `<circle cx="${centers[centers.length - 1]}" cy="${y(last)}" r="3.5" class="vidas-dot"/>`
      + `<text x="${centers[centers.length - 1]}" y="${y(last) - 9}" text-anchor="end" class="vidas-value-label">${signed(last)}</text>`;
    box.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Saldo acumulado por dia">`
      + `${grid}<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" class="vidas-zero"/>`
      + `<polygon points="${area}" class="vidas-area"/>`
      + `<polyline points="${points}" class="vidas-line"/>${tail}${labels}</svg>`;
  }
  function sellersOf(record) {
    const names = [...new Set(record.registros.filter(r => r.tipo === 'entrada' && r.vendedor).map(r => r.vendedor))];
    if (!names.length) return '—';
    return names.length > 2 ? `${names.slice(0, 2).map(esc).join(', ')} +${names.length - 2}` : names.map(esc).join(', ');
  }
  function renderEmpresas() {
    const rows = state.data?.empresas || [];
    el('vidasEmpresasNote').textContent = rows.length ? `${num(rows.length)} empresa(s) com entrada, saída ou mudança de vidas faturadas.` : '';
    const body = el('vidasEmpresas');
    const empty = el('vidasEmpty');
    empty.classList.toggle('hidden', Boolean(rows.length));
    empty.textContent = rows.length ? '' : 'Nenhuma empresa com movimentação no período e filtros selecionados.';
    body.innerHTML = rows.map((record, index) => {
      const open = state.expanded.has(index);
      const variacao = record.vidasAgora - record.vidasAntes;
      const details = !open ? '' : `
        <tr class="vidas-detail"><td colspan="10">
          <table class="vidas-detail-table"><thead><tr><th>Dia</th><th>Tipo</th><th>Cliente (vida)</th><th>Código / lote</th><th>Vendedor</th><th>Equipe</th><th>Plano</th><th>Motivo</th><th>Valor S4E</th></tr></thead><tbody>
          ${record.registros.map(item => `<tr>
            <td>${esc(dateLabel(item.dia))}${item.assinatura ? `<small>assinado ${esc(dateLabel(item.assinatura))}</small>` : ''}</td>
            <td><span class="vidas-tag ${item.tipo === 'saida' ? 'out' : 'in'}">${item.tipo === 'saida' ? 'Saída' : 'Entrada'}</span></td>
            <td>${esc(item.cliente || '—')}</td>
            <td>${esc(item.codigoCliente || '—')}${item.lote ? `<small>lote ${esc(item.lote)}</small>` : ''}</td>
            <td>${esc(item.vendedor || '—')}</td>
            <td>${esc(item.equipe || '—')}</td>
            <td>${esc(item.plano || '—')}</td>
            <td>${esc(item.motivo || '—')}</td>
            <td>${esc(item.valor || '—')}</td>
          </tr>`).join('')}
          </tbody></table>
        </td></tr>`;
      return `<tr>
        <td><strong>${esc(record.nome)}</strong><small>${record.codigo ? `código ${esc(record.codigo)}` : ''}</small></td>
        <td>${esc(record.centro || '—')}</td>
        <td>${esc(record.grupo || '—')}</td>
        <td class="vidas-number">${num(record.vidasAntes)}</td>
        <td class="vidas-number">${num(record.vidasAgora)}</td>
        <td class="vidas-number ${variacao > 0 ? 'up' : variacao < 0 ? 'down' : ''}">${signed(variacao)}</td>
        <td class="vidas-number in">${num(record.entradas)}</td>
        <td class="vidas-number out">${num(record.saidas)}</td>
        <td class="vidas-sellers">${sellersOf(record)}</td>
        <td><button type="button" class="vidas-detail-button" data-index="${index}" aria-expanded="${open}">${open ? 'Ocultar' : 'Ver'}</button></td>
      </tr>${details}`;
    }).join('');
  }
  const TABS = ['geral', 'carteira', 'empresas', 'pessoas'];
  const tabId = name => `vidasTab${name[0].toUpperCase()}${name.slice(1)}`;
  const paneId = name => `vidasPane${name[0].toUpperCase()}${name.slice(1)}`;
  function showTab(name) {
    if (!TABS.includes(name)) name = 'geral';
    state.tab = name;
    TABS.forEach(tab => {
      const button = el(tabId(tab)), pane = el(paneId(tab));
      const active = tab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      pane.classList.toggle('hidden', !active);
    });
    if (name === 'pessoas') loadPeople();
  }
  let tabsBound = false;
  function bindTabs() {
    if (tabsBound) {
      showTab(state.tab);
      return;
    }
    tabsBound = true;
    TABS.forEach(tab => {
      const button = el(tabId(tab));
      button.addEventListener('click', () => showTab(tab));
      button.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const index = TABS.indexOf(state.tab);
        const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        showTab(next);
        el(tabId(next)).focus();
      });
    });
    showTab(state.tab);
  }
  async function peopleFetch(path, options = {}) {
    const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, {
      ...options,
      headers: {
        ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${window.PortalAccess.Access.token}`,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearSessionLocal();
      showLogin('Faça login para continuar.');
      throw new DOMException('Sessão encerrada', 'AbortError');
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar as pessoas.');
    return data;
  }
  function peopleFilters() {
    return {
      busca: el('vidasPessoasBusca').value.trim(),
      situacao: el('vidasPessoasSituacao').value,
      parentesco: el('vidasPessoasParentesco').value,
      centro: el('vidasPessoasCentro').value,
    };
  }
  function acceptPeople(data) {
    people.data = data;
    people.error = '';
    const filtros = data?.filtros || {};
    fillSelect('vidasPessoasSituacao', filtros.situacoes || [], 'Todas', peopleFilters().situacao);
    fillSelect('vidasPessoasParentesco', filtros.parentescos || [], 'Todos', peopleFilters().parentesco);
    fillSelect('vidasPessoasCentro', filtros.centros || [], 'Todos os centros', peopleFilters().centro);
    renderPeople();
  }
  function schedulePeople() {
    clearTimeout(people.pollTimer);
    people.pollTimer = null;
    const job = people.data?.job;
    if (!job?.running || !visible() || state.tab !== 'pessoas') return;
    people.pollTimer = setTimeout(loadPeople, 2500);
  }
  async function loadPeople() {
    if (!visible() || people.busy) return;
    people.busy = true;
    people.status = '';
    renderPeople();
    try {
      const query = new URLSearchParams(peopleFilters());
      acceptPeople(await peopleFetch(`/api/vidas/pessoas?${query}`));
      people.loaded = true;
    } catch (error) {
      if (error.name !== 'AbortError') people.error = error.message || 'Não foi possível carregar as pessoas.';
    } finally {
      people.busy = false;
      renderPeople();
      schedulePeople();
    }
  }
  function queuePeople() {
    clearTimeout(people.timer);
    people.timer = setTimeout(loadPeople, 320);
  }
  function renderImports() {
    const box = el('vidasPessoasImportacoes');
    const rows = people.data?.importacoes || [];
    if (!rows.length) {
      box.innerHTML = '<p class="vidas-help">Nenhuma consulta feita ainda.</p>';
      return;
    }
    box.innerHTML = rows.map(row => `
      <div class="vidas-import-row">
        <div class="vidas-import-main">
          <strong title="${esc(row.arquivo)}">${esc(row.arquivo)}</strong>
          <small>${num(row.linhas)} pessoa(s) · ${num(row.ativos)} ativa(s) · ${num(row.cancelados)} cancelada(s)</small>
          <small>Consultado em ${esc(stampLabel(row.importadoEm))}${row.importadoPor ? ` · ${esc(row.importadoPor)}` : ''}</small>
        </div>
        <button type="button" class="vidas-detail-button" data-remove-import="${esc(row.id)}" ${isAdmin() ? '' : 'hidden'}>Remover</button>
      </div>`).join('');
  }
  function peopleKpis(data) {
    const totais = data?.totais;
    if (!totais) return '';
    return [
      kpi('Total de pessoas', num(totais.pessoas), 'uma linha por CPF/contrato, na consulta mais recente'),
      kpi('Ativas', num(totais.ativos), 'situação ATIVA no S4E', 'in'),
      kpi('Canceladas', num(totais.cancelados), 'situação CANCELADA no S4E', 'out'),
      kpi('Titulares', num(totais.titulares), 'responsáveis pelo plano'),
      kpi('Dependentes', num(totais.dependentes), 'cônjuge, filho ou outro parentesco'),
      kpi('Sem centro de custo', num(totais.semCentro), 'nenhum centro informado e empresa fora da apuração'),
    ].join('');
  }
  function renderPeopleRows() {
    const rows = people.data?.pessoas || [];
    const body = el('vidasPessoasRows');
    const empty = el('vidasPessoasEmpty');
    const data = people.data;
    el('vidasPessoasKpis').innerHTML = peopleKpis(data);
    el('vidasTabPessoasCount').textContent = data?.totais?.pessoas ? num(data.totais.pessoas) : '';
    el('vidasPessoasNote').textContent = data
      ? `${num(data.filtrados)} pessoa(s) no filtro atual · exibindo ${num(data.exibidos)}${data.filtrados > data.exibidos ? ' · refine a busca para ver as demais' : ''}${data.apuracao ? ` · grupos atribuídos pela apuração ${data.apuracao}` : ''}`
      : '';
    empty.classList.toggle('hidden', Boolean(rows.length));
    empty.textContent = rows.length ? '' : (data?.totais?.pessoas ? 'Nenhuma pessoa atende aos filtros selecionados.' : 'Busque no S4E para trazer CPF, parentesco, nascimento, nome da mãe, vencimento e contrato.');
    body.innerHTML = rows.map(record => `<tr>
      <td><strong>${esc(record.nome)}</strong>${record.responsavel ? `<small>resp. ${esc(record.responsavel)}</small>` : ''}</td>
      <td>${esc(record.cpf || '—')}</td>
      <td>${esc(record.empresa || '—')}</td>
      <td>${esc(record.centro || '—')}</td>
      <td><span class="vidas-tag ${record.situacao === 'CANCELADO' ? 'out' : 'in'}">${esc(record.situacao || '—')}</span></td>
      <td>${esc(record.parentesco || '—')}</td>
      <td>${esc(record.contrato || '—')}</td>
      <td>${esc(record.grupo || '—')}</td>
      <td class="vidas-number">${record.valor ? money(record.valor) : '—'}</td>
      <td>${esc(dateLabel(record.data))}</td>
      <td>${esc(record.vencimento || '—')}</td>
      <td>${esc(dateLabel(record.nascimento))}</td>
      <td>${esc(record.nome_mae || '—')}</td>
    </tr>`).join('');
  }
  function renderPeople() {
    const job = people.data?.job;
    const progress = el('vidasPessoasProgress');
    if (job?.running) {
      progress.classList.remove('hidden');
      if (job.total) progress.value = Math.round(job.done / job.total * 100);
      else progress.removeAttribute('value');
    } else {
      progress.classList.add('hidden');
    }
    el('vidasPessoasStatus').textContent = job?.running
      ? (job.message || 'Consultando o S4E…')
      : people.busy
        ? 'Carregando pessoas…'
        : (people.status || job?.message || (people.data ? 'Dados do relatório de usuários do S4E.' : ''));
    el('vidasPessoasError').textContent = people.error || (!job?.running ? job?.error || '' : '');
    el('vidasPessoasError').classList.toggle('hidden', !el('vidasPessoasError').textContent);
    el('vidasPessoasSincronizar').disabled = people.busy || Boolean(job?.running);
    el('vidasPessoasRecarregar').disabled = people.busy;
    renderImports();
    renderPeopleRows();
  }
  async function syncPeople() {
    if (people.busy || people.data?.job?.running) return;
    const start = el('vidasPessoasInicio').value;
    const end = el('vidasPessoasFim').value;
    const invalid = periodError(start, end);
    if (invalid) {
      people.error = invalid;
      renderPeople();
      return;
    }
    people.busy = true;
    people.error = '';
    people.status = '';
    renderPeople();
    try {
      const result = await peopleFetch('/api/vidas/pessoas/sincronizar', {
        method: 'POST',
        body: JSON.stringify({ start, end, escopo: el('vidasPessoasEscopo').value }),
      });
      people.data = { ...(people.data || {}), job: result.job };
      people.polls = 0;
      people.status = result.job?.message || 'Consultando o S4E…';
    } catch (error) {
      if (error.name !== 'AbortError') people.error = error.message || 'Não foi possível iniciar a consulta.';
    } finally {
      people.busy = false;
      renderPeople();
      schedulePeople();
    }
  }
  async function removeImport(id) {
    if (people.busy || people.data?.job?.running) return;
    if (!window.confirm('Remover esta consulta? As pessoas trazidas por ela saem da lista até uma nova busca no S4E.')) return;
    people.busy = true;
    people.error = '';
    people.status = '';
    renderPeople();
    try {
      const data = await peopleFetch('/api/vidas/importacoes/remover', { method: 'POST', body: JSON.stringify({ id }) });
      acceptPeople(data.pessoas);
      people.status = 'Importação removida.';
    } catch (error) {
      if (error.name !== 'AbortError') people.error = error.message || 'Não foi possível remover a importação.';
    } finally {
      people.busy = false;
      renderPeople();
    }
  }
  function render() {
    renderMonitor();
    const mov = state.data?.movimentacao;
    el('vidasChecked').textContent = mov?.consultadoEm ? stampLabel(mov.consultadoEm) : '—';
    el('vidasCheckedNote').textContent = mov?.consultaId
      ? `${num(mov.registros)} registro(s) no período · somente leitura`
      : 'A primeira consulta ao S4E começa automaticamente.';
    el('vidasTabEmpresasCount').textContent = state.data?.empresas?.length ? num(state.data.empresas.length) : '';
    renderTotals();
    renderChart();
    renderBalance();
    renderMotivos();
    renderRanking();
    renderCentros();
    renderGrupos();
    renderEquipes();
    renderEmpresas();
  }
  async function exportReport() {
    if (!visible()) return;
    const button = el('vidasExport');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Gerando planilha…';
    try {
      const query = new URLSearchParams({ start: state.start, end: state.end, centro: state.centro, grupo: state.grupo });
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/vidas/exportar?${query}`, {
        headers: { Authorization: `Bearer ${window.PortalAccess.Access.token}` },
      });
      if (response.status === 401) {
        clearSessionLocal();
        showLogin('Faça login para continuar.');
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível gerar a planilha.');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'movimentacao-de-vidas.xlsx';
      const link = document.createElement('a');
      const href = URL.createObjectURL(blob);
      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
      state.error = '';
    } catch (error) {
      state.error = error.message || 'Não foi possível gerar a planilha.';
    } finally {
      button.textContent = label;
      button.disabled = false;
      renderMonitor();
    }
  }
  el('vidasForm').addEventListener('submit', event => { event.preventDefault(); apply(); });
  el('vidasRefresh').addEventListener('click', refresh);
  el('vidasExport').addEventListener('click', exportReport);
  el('vidasStart').addEventListener('change', () => { el('vidasEnd').min = el('vidasStart').value; });
  el('vidasCentro').addEventListener('change', () => fillGrupos(''));
  el('vidasEmpresas').addEventListener('click', event => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (state.expanded.has(index)) state.expanded.delete(index); else state.expanded.add(index);
    renderEmpresas();
  });
  el('vidasPessoasSyncForm').addEventListener('submit', event => { event.preventDefault(); syncPeople(); });
  el('vidasPessoasInicio').addEventListener('change', () => { el('vidasPessoasFim').min = el('vidasPessoasInicio').value; });
  el('vidasPessoasRecarregar').addEventListener('click', loadPeople);
  el('vidasPessoasForm').addEventListener('submit', event => { event.preventDefault(); loadPeople(); });
  el('vidasPessoasBusca').addEventListener('input', queuePeople);
  el('vidasPessoasSituacao').addEventListener('change', loadPeople);
  el('vidasPessoasParentesco').addEventListener('change', loadPeople);
  el('vidasPessoasCentro').addEventListener('change', loadPeople);
  el('vidasPessoasLimpar').addEventListener('click', () => {
    el('vidasPessoasBusca').value = '';
    el('vidasPessoasSituacao').value = '';
    el('vidasPessoasParentesco').value = '';
    el('vidasPessoasCentro').value = '';
    loadPeople();
  });
  el('vidasPessoasImportacoes').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-import]');
    if (button) removeImport(button.dataset.removeImport);
  });
  bindTabs();
  window.enterVidasScreen = () => {
    if (!allowed()) return;
    initializeDates();
    initializePeopleDates();
    if (state.active && visible()) return;
    state.active = true;
    state.error = '';
    state.polls = 0;
    bindTabs();
    render();
    load(true);
  };
  window.leaveVidasScreen = () => {
    state.active = false;
    invalidate();
    clearTimeout(people.pollTimer);
    people.pollTimer = null;
  };
  window.resetVidas = () => {
    window.leaveVidasScreen();
    state.data = null;
    state.job = null;
    state.error = '';
    state.attempted.clear();
    state.expanded.clear();
    state.start = state.end = state.centro = state.grupo = '';
    clearTimeout(people.timer);
    clearTimeout(people.pollTimer);
    people.pollTimer = null;
    people.loaded = false;
    people.data = null;
    people.error = '';
    people.status = '';
    people.busy = false;
    people.polls = 0;
    ['vidasPessoasBusca', 'vidasPessoasSituacao', 'vidasPessoasParentesco', 'vidasPessoasCentro'].forEach(id => { el(id).value = ''; });
    el('vidasPessoasInicio').value = '';
    el('vidasPessoasFim').value = '';
    render();
    renderPeople();
  };
  document.addEventListener('visibilitychange', () => {
    if (!state.active) return;
    invalidate();
    if (!visible()) {
      clearTimeout(people.pollTimer);
      people.pollTimer = null;
      return;
    }
    state.error = '';
    state.polls = 0;
    load(true);
    if (state.tab === 'pessoas') loadPeople();
  });
})();

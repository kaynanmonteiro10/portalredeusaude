(function () {
  const $ = id => document.getElementById(id);
  const api = (path, options) => window.PortalAccess.api(path, options);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;' }[c]));
  const methodLabel = { por_vida: 'Por vida', percentual: '% faturamento', fixo: 'Fixo' };
  const levelLabel = { 1: 'Centro de custo', 2: 'Grupo', 3: 'Empresa' };
  const encargosLabel = { rateio: 'Divide com a base', recebedor: 'Conta específica', rede: 'Rede Saúde' };
  // O campo da conta de juros só aparece quando a regra manda os encargos para uma conta.
  function toggleEncargosReceiver() {
    const wrap = $('rfEncargosReceiverWrap');
    if (!wrap) return;
    wrap.hidden = ($('rfEncargos')?.value || 'rateio') !== 'recebedor';
  }
  const state = {
    data: null, prev: null, active: false, jobTimer: null, epoch: 0,
    tab: 'visao', search: '', status: '', receiver: '', sort: null, page: 1, pageSize: 25,
    mode: 'faturamento', detailed: false, rulesSearch: '', rulesFilter: '', editingRule: null,
    grupo: '', grupoEmpresa: '', empresa: '',
  };
  const cash = value => money.format(Number(value) || 0);
  const num = value => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const pct = value => `${(Number(value) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const dateLabel = value => {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (String(value || '').trim() || '—');
  };
  const isoDate = value => {
    const m = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(value || '');
  };
  const MONTHS_PT = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
  const norm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const monthKey = value => {
    const text = norm(value);
    const numeric = text.match(/^(\d{1,2})\s*\/\s*(\d{4})$/);
    if (numeric) return `${numeric[2]}-${numeric[1].padStart(2, '0')}`;
    const named = text.match(/^([a-z]+)\s*\/\s*(\d{4})$/);
    if (named && MONTHS_PT[named[1]]) return `${named[2]}-${String(MONTHS_PT[named[1]]).padStart(2, '0')}`;
    const iso = String(value ?? '').match(/^(\d{4})-(\d{2})/);
    return iso ? `${iso[1]}-${iso[2]}` : '';
  };
  const currentMonth = () => monthKey(state.data?.competencia || $('rfCompetencia').value);
  const inMonth = (value, key = currentMonth()) => Boolean(key) && monthKey(value) === key;
  const stampLabel = value => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const visible = () => state.active && !document.body.classList.contains('locked');
  const canManage = () => Boolean(state.data?.canManage);
  const items = () => state.data?.items || [];
  const filteredQuery = () => new URLSearchParams({
    competencia: $('rfCompetencia').value || '',
    tipoParcela: $('rfParcelType').value,
    pagamentoStatus: $('rfPaymentStatus').value,
    vencimentoDe: $('rfDueFrom').value,
    vencimentoAte: $('rfDueTo').value,
    pagamentoDe: $('rfPaidFrom').value,
    pagamentoAte: $('rfPaidTo').value,
    creditoDe: $('rfCreditFrom').value,
    creditoAte: $('rfCreditTo').value,
  });
  const exportQuery = () => {
    const query = filteredQuery();
    if (state.grupo) query.set('grupo', state.grupo);
    if (state.grupoEmpresa) query.set('grupoEmpresa', state.grupoEmpresa);
    if (state.empresa) query.set('empresa', state.empresa);
    return query;
  };

  const msg = (text = '', error = false) => {
    const box = $('rfMessage');
    box.textContent = text;
    box.hidden = !text;
    box.classList.toggle('is-error', error);
  };

  function statusOf(x) {
    if (!x.totalRateado) return { key: 'sem-regra', label: 'Sem regra', tone: 'review' };
    if (x.saldo < -0.01) return { key: 'excede', label: `Excede ${cash(-x.saldo)}`, tone: 'error' };
    if (x.saldo > 0.01) return { key: 'falta', label: `Falta ${cash(x.saldo)}`, tone: 'warning' };
    return { key: 'fechado', label: 'Fechado', tone: 'ok' };
  }

  function setBusy(busy) {
    $('rateioScreen').classList.toggle('is-busy', busy);
    ['rfRefresh', 'rfExport', 'rfCopySummary', 'rfApplyFilters', 'rfClearFilters'].forEach(id => { $(id).disabled = busy; });
    if (busy) $('rfHeroRun').textContent = 'Carregando dados da competência…';
  }

  function showJob(job = {}) {
    const running = Boolean(job.running);
    $('rfJob').hidden = !running;
    if (!running) return;
    const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
    $('rfJobText').textContent = job.message || 'Consultando o S4E…';
    $('rfJobDetail').textContent = job.phase === 's4e'
      ? 'O S4E está gerando o relatório. Esta etapa pode demorar alguns minutos.'
      : 'Organizando os dados para o rateio.';
    $('rfJobPercent').textContent = `${Math.round(percent)}%`;
    $('rfJobProgress').value = percent;
  }

  async function pollJob() {
    if (!state.active) return;
    try {
      const wasVisible = !$('rfJob').hidden;
      const job = await api('/api/apuracao/job');
      showJob(job);
      if (job.running) {
        clearTimeout(state.jobTimer);
        state.jobTimer = setTimeout(pollJob, 3000);
      } else if (wasVisible) {
        msg(job.error || 'Consulta concluída. Os dados do rateio foram atualizados.', Boolean(job.error));
        if (!job.error) load();
      }
    } catch (_) { /* silencioso: a tela volta a tentar na próxima abertura */ }
  }

  function searchText(x) {
    return [x.grupo, x.grupoEmpresa, x.empresa, x.documento, x.titulo, x.nf, x.parcela, x.competenciaOriginal]
      .map(v => String(v || '')).join(' ').toLowerCase();
  }

  function matchesFilters(x) {
    if (state.grupo && x.grupo !== state.grupo) return false;
    if (state.grupoEmpresa && x.grupoEmpresa !== state.grupoEmpresa) return false;
    if (state.empresa && x.empresa !== state.empresa) return false;
    if (state.mode === 'recebimento') {
      if (bankActive()) {
        if (x.banco?.pagamento) {
          if (!inMonth(isoDate(x.banco.pagamento))) return false;
        } else {
          const received = Number(x.valorRecebido) > 0;
          const inPay = inMonth(isoDate(x.pagamento));
          const inCredit = inMonth(isoDate(x.credito));
          if (!(received && (inPay || inCredit))) return false;
        }
      } else if (!inMonth(isoDate(x.credito))) {
        return false;
      }
    }
    if (state.receiver && !(x.rateios || []).some(r => r.recebedor === state.receiver)) return false;
    if (state.status) {
      const status = statusOf(x).key;
      if (state.status === 'problema' ? status === 'fechado' : status !== state.status) return false;
    }
    const text = state.search.trim().toLowerCase();
    return !text || text.split(/\s+/).every(part => searchText(x).includes(part));
  }

  function sortValue(x, key) {
    if (key === 'vencimento' || key === 'pagamento' || key === 'credito') return isoDate(x[key]) || '';
    if (key === 'competenciaOriginal') return monthKey(x.competenciaOriginal);
    if (key === 'recebido') return Number(x.valorRecebido) || 0;
    if (key === 'rateado') return Number(x.totalRateado) || 0;
    if (['faturado', 'valorRecebido', 'totalRateado', 'saldo', 'diferencaRecebimento', 'tarifa'].includes(key)) return Number(x[key]) || 0;
    if (key === 'vidas') return Number(x.vidasFaturadas) || 0;
    if (key === 'documento') return String(x.documento || '');
    return String(x[key] || '').toLocaleLowerCase('pt-BR');
  }

  function filteredItems() {
    const rows = items().filter(matchesFilters);
    if (!state.sort) return rows;
    const { key, dir } = state.sort;
    return rows.slice().sort((a, b) => {
      const left = sortValue(a, key), right = sortValue(b, key);
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * dir;
      return String(left).localeCompare(String(right), 'pt-BR') * dir;
    });
  }

  function totals(rows) {
    return rows.reduce((acc, x) => {
      acc.billing += Number(x.faturado) || 0;
      acc.received += Number(x.valorRecebido) || 0;
      acc.allocated += Number(x.totalRateado) || 0;
      return acc;
    }, { billing: 0, received: 0, allocated: 0 });
  }

  function deltaLabel(current, previous, label) {
    if (!previous || !Number.isFinite(previous.amount) || !previous.amount) return '';
    const diff = current - previous.amount;
    const variation = Math.abs(diff / previous.amount) * 100;
    const arrow = diff >= 0 ? '▲' : '▼';
    return `${arrow} ${pct(variation)} vs ${label || 'competência anterior'}`;
  }

  function renderHero() {
    const data = state.data || {};
    const rows = items();
    const sum = totals(rows);
    const coverage = sum.billing ? (sum.allocated / sum.billing) * 100 : 0;
    $('rfHeroRun').textContent = data.run ? `Apuração de ${stampLabel(data.run.finishedAt) || '—'}` : 'Sem apuração nesta competência';
    $('rfHeroCount').textContent = `${rows.length} ${rows.length === 1 ? 'lançamento' : 'lançamentos'}`;
    $('rfHeroCoverage').textContent = sum.billing ? `Cobertura ${pct(coverage)}` : 'Cobertura —';
    $('rfHeroCoverage').classList.toggle('is-warning', Boolean(sum.billing) && coverage < 99.5);
  }

  function renderKpis() {
    const sum = totals(items());
    const previous = state.prev ? { label: state.prev.competencia, ...totals(state.prev.items || []) } : null;
    const balance = sum.billing - sum.allocated;
    const coverage = sum.billing ? (sum.allocated / sum.billing) * 100 : 0;
    $('rfBilling').textContent = cash(sum.billing);
    $('rfReceived').textContent = cash(sum.received);
    $('rfAllocated').textContent = cash(sum.allocated);
    $('rfBalance').textContent = cash(balance);
    $('rfBalance').classList.toggle('is-negative', balance < -0.01);
    $('rfBalanceHint').textContent = sum.billing ? `Cobertura ${pct(coverage)} do faturamento` : 'Cobertura do faturamento';
    $('rfBillingDelta').textContent = deltaLabel(sum.billing, previous && { amount: previous.billing }, previous?.label);
    $('rfReceivedDelta').textContent = deltaLabel(sum.received, previous && { amount: previous.received }, previous?.label);
    $('rfAllocatedDelta').textContent = deltaLabel(sum.allocated, previous && { amount: previous.allocated }, previous?.label);
    const rules = state.data?.rules || [];
    const active = rules.filter(r => r.ativo);
    $('rfRules').textContent = active.length;
    $('rfRulesHint').textContent = rules.length === active.length
      ? (rules.length ? 'Todas em uso' : 'Nenhuma regra cadastrada')
      : `${rules.length - active.length} em revisão`;
  }

  function cashMetrics(rows, key = currentMonth()) {
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const metrics = { billing: 0, billingCount: 0, billingReceived: 0, cash: 0, cashCount: 0, other: 0, otherCount: 0, overdue: 0, open: 0, percent: 0 };
    rows.forEach(x => {
      const received = Number(x.valorRecebido) || 0;
      const own = inMonth(x.competenciaOriginal, key);
      if (own) {
        metrics.billing += Number(x.faturado) || 0;
        metrics.billingCount += 1;
        metrics.billingReceived += received;
        if (received < 0.01 && x.vencimento && isoDate(x.vencimento) < todayIso) metrics.overdue += 1;
      }
      if (inMonth(isoDate(x.credito), key)) {
        metrics.cash += received;
        metrics.cashCount += 1;
        if (!own) {
          metrics.other += received;
          metrics.otherCount += 1;
        }
      }
    });
    metrics.open = metrics.billing - metrics.billingReceived;
    metrics.percent = metrics.billing ? (metrics.billingReceived / metrics.billing) * 100 : 0;
    return metrics;
  }

  function differenceInfo(x) {
    const billed = Number(x.faturado) || 0;
    const received = Number(x.valorRecebido) || 0;
    if (received < 0.005) return null;
    const diff = Math.round((received - billed) * 100) / 100;
    const round = value => Math.round(value * 100) / 100;
    const parts = [];
    const imposto = -round(Number(x.imposto) || 0);
    const juros = round((Number(x.multa) || 0) + (Number(x.acrescimo) || 0) + (Number(x.acrescimoAvulso) || 0));
    const desconto = -round((Number(x.desconto) || 0) + (Number(x.descontoPagamento) || 0));
    if (Math.abs(imposto) > 0.005) parts.push({ label: 'Imposto', value: imposto });
    if (Math.abs(juros) > 0.005) parts.push({ label: 'Juros e multa', value: juros });
    if (Math.abs(desconto) > 0.005) parts.push({ label: 'Desconto', value: desconto });
    const explained = round(parts.reduce((acc, part) => acc + part.value, 0));
    const residual = round(diff - explained);
    if (Math.abs(residual) > 0.01) parts.push({ label: 'Outros', value: residual });
    return { diff, parts, label: parts.map(part => part.label).join(' + ') };
  }

  const bankStatusLabel = { conciliado: 'Conciliado', 'nao-baixado': 'S4E em aberto', divergente: 'Valor diverge' };
  const receipts = () => state.data?.receipts || null;
  const bankActive = () => Boolean(receipts()?.banco?.count);
  const dayLabel = value => dateLabel(String(value || '').trim().slice(0, 10));

  function renderCash() {
    const metrics = cashMetrics(items());
    $('rfCashBilling').textContent = cash(metrics.billing);
    $('rfCashBillingNote').textContent = metrics.billingCount
      ? `${num(metrics.billingCount)} ${metrics.billingCount === 1 ? 'título' : 'títulos'} da competência`
      : 'Sem títulos desta competência';
    $('rfCashReceived').textContent = cash(metrics.cash);
    const receivedNote = metrics.cashCount
      ? `${num(metrics.cashCount)} ${metrics.cashCount === 1 ? 'título' : 'títulos'} com crédito no mês${metrics.otherCount ? ` · ${cash(metrics.other)} de outras competências` : ''}`
      : 'Nenhum crédito no mês';
    $('rfCashOther').textContent = receivedNote;
    $('rfCashOpen').textContent = cash(metrics.open);
    $('rfCashOpen').classList.toggle('is-negative', metrics.open < -0.01);
    $('rfCashOverdue').textContent = metrics.overdue ? `${num(metrics.overdue)} ${metrics.overdue === 1 ? 'vencido em aberto' : 'vencidos em aberto'}` : 'Nenhum vencido em aberto';
    $('rfCashPercent').textContent = pct(metrics.percent);
    $('rfCashPercentNote').textContent = metrics.billingCount
      ? `${cash(metrics.billingReceived)} dos títulos da competência`
      : 'Sem faturamento na competência';
    const bankEl = $('rfCashBank');
    if (bankEl) {
      const r = receipts();
      const bank = r && r.banco && r.banco.count ? r.banco : null;
      bankEl.textContent = bank ? cash(bank.valor) : '—';
      bankEl.classList.toggle('is-negative', false);
      $('rfCashBankNote').textContent = bank
        ? `${num(bank.count)} ${bank.count === 1 ? 'pagamento' : 'pagamentos'} · ${r.status === 'ok' ? 'igual ao relatório analítico' : `relatório ${cash(r.relatorio?.valor)} · diferença explicada`}`
        : 'Sem retorno bancário carregado nesta competência';
    }
  }

  function renderReconcile() {
    const panel = $('rfReconcile');
    if (!panel) return;
    const r = receipts();
    panel.hidden = !r || !r.banco?.count;
    if (panel.hidden) return;
    $('rfReconBank').textContent = cash(r.banco?.valor);
    $('rfReconBankNote').textContent = `${num(r.banco?.count)} ${r.banco?.count === 1 ? 'pagamento' : 'pagamentos'} no mês`;
    $('rfReconReport').textContent = cash(r.relatorio?.valor);
    $('rfReconReportNote').textContent = `${num(r.relatorio?.count)} títulos com pagamento ou crédito no S4E no mês`;
    $('rfReconDiff').textContent = cash(r.diferenca);
    $('rfReconDiff').classList.toggle('is-negative', Math.abs(Number(r.diferenca) || 0) > 0.05);
    $('rfReconDiffNote').textContent = r.status === 'ok' ? 'Banco e relatório fecham' : 'Diferença explicada abaixo';
    const status = $('rfReconcileStatus');
    status.textContent = r.status === 'ok' ? 'Conciliado' : 'Explicado';
    status.className = `rf-status is-${r.status === 'ok' ? 'ok' : 'warning'}`;
    $('rfReconLead').textContent = r.conciliado?.count
      ? `${num(r.conciliado.count)} títulos batem exatamente entre o banco e o relatório (${cash(r.conciliado.valorBanco)}).`
      : '';
    $('rfReconGroups').innerHTML = (r.grupos || []).map(group => {
      const motivos = (group.motivos || []).map(item => `${esc(item.label)} (${num(item.count)})`).join(' · ');
      const items = (group.itens || []).map(item => `<li><span>${esc(item.empresa)} · venc. ${dayLabel(item.vencimento)}${item.pagamento ? ` · pago ${dayLabel(item.pagamento)}` : ''}${item.tipo ? ` · ${esc(item.tipo)}` : ''}</span><span>${cash(item.valor)}</span></li>`).join('');
      return `<li><details><summary><span><strong>${esc(group.label)}</strong><small>${num(group.count)} ${group.count === 1 ? 'item' : 'itens'}${motivos ? ` · ${motivos}` : ''}</small></span><strong class="${Number(group.valor) < 0 ? 'rf-negative' : ''}">${cash(group.valor)}</strong></summary><p>${esc(group.hint)}</p>${items ? `<ul class="rf-recon-items">${items}</ul>` : ''}${group.count > (group.itens || []).length ? `<p class="rf-muted">Mostrando ${num((group.itens || []).length)} de ${num(group.count)} itens.</p>` : ''}</details></li>`;
    }).join('') || '<li class="rf-empty-inline">Banco e relatório fecham sem diferença.</li>';
    const coverage = r.cobertura || {};
    const parts = [];
    if (coverage.arquivos) parts.push(`${num(coverage.arquivos)} arquivos de retorno conferidos`);
    if (coverage.de) parts.push(`de ${dayLabel(coverage.de)} a ${dayLabel(coverage.ate)}`);
    if (r.ocorrencias?.count) parts.push(`${num(r.ocorrencias.count)} ocorrências sem baixa fora do total (${cash(r.ocorrencias.valor)})`);
    $('rfReconCoverage').textContent = parts.length ? `${parts.join(' · ')}.` : '';
  }

  function renderReceivers() {
    const list = (state.data?.recebedores || []).slice().sort((a, b) => b.valor - a.valor);
    const total = list.reduce((acc, x) => acc + Number(x.valor || 0), 0);
    const width = value => total ? Math.max(2, Math.round((Number(value || 0) / total) * 100)) : 0;
    $('rfReceivers').innerHTML = list.map(x => `
      <button type="button" class="rf-receiver ${state.receiver === x.nome ? 'is-active' : ''}" data-receiver="${esc(x.nome)}" aria-pressed="${state.receiver === x.nome}">
        <span class="rf-receiver-top"><span class="rf-receiver-name">${esc(x.nome)}</span><span class="rf-receiver-share">${pct(total ? (Number(x.valor) / total) * 100 : 0)}</span></span>
        <strong>${cash(x.valor)}</strong>
        <span class="rf-bar" aria-hidden="true"><i style="width:${width(x.valor)}%"></i></span>
      </button>`).join('') || '<p class="rf-empty-inline">Nenhuma conta recebendo nesta competência. Cadastre uma regra para começar.</p>';
    $('rfClearReceiver').hidden = !state.receiver;
  }

  function renderStatuses() {
    const rows = items();
    const groups = [
      { key: 'fechado', label: 'Fechados', hint: 'rateio igual ao faturamento', tone: 'ok' },
      { key: 'falta', label: 'Falta', hint: 'regra não cobre o total', tone: 'warning' },
      { key: 'excede', label: 'Excede', hint: 'rateio maior que o faturamento', tone: 'error' },
      { key: 'sem-regra', label: 'Sem regra', hint: 'nenhuma regra aplicada', tone: 'review' },
    ];
    $('rfStatuses').innerHTML = groups.map(group => {
      const selected = rows.filter(x => statusOf(x).key === group.key);
      const value = selected.reduce((acc, x) => acc + (Number(x.faturado) || 0), 0);
      const active = state.status === group.key;
      return `<button type="button" class="rf-status-card is-${group.tone} ${active ? 'is-active' : ''}" data-status="${group.key}" aria-pressed="${active}">
        <span class="rf-status-count">${selected.length}</span>
        <span class="rf-status-label">${group.label}</span>
        <span class="rf-status-hint">${selected.length ? cash(value) : group.hint}</span>
      </button>`;
    }).join('');
  }

  function renderAlerts() {
    const alerts = state.data?.alerts || [];
    $('rfAlerts').innerHTML = alerts.map(text => `<li>${esc(text)}</li>`).join('');
    $('rfAlerts').hidden = !alerts.length;
    $('rfAlertsEmpty').hidden = Boolean(alerts.length);
  }

  function tableColumns() {
    const columns = [
      { id: 'status', label: 'Situação' },
      { id: 'empresa', label: 'Empresa', sort: true },
      { id: 'parcela', label: 'Parcela', sort: true, numeric: true },
      { id: 'vencimento', label: 'Vencimento', sort: true },
    ];
    if (state.mode === 'recebimento') {
      columns.push(
        { id: 'competenciaOriginal', label: 'Competência', sort: true },
        { id: 'pagamento', label: 'Pagamento', sort: true },
        { id: 'credito', label: 'Crédito', sort: true },
        { id: 'recebido', label: 'Valor recebido', sort: true, numeric: true },
        { id: 'diferencaRecebimento', label: 'Diferença', sort: true, numeric: true },
        { id: 'conferencia', label: 'Conferência' },
        { id: 'tarifa', label: 'Tarifa', sort: true, numeric: true });
    } else {
      columns.push(
        { id: 'vidas', label: 'Vidas', sort: true, numeric: true },
        { id: 'faturado', label: 'Faturado', sort: true, numeric: true },
        { id: 'recebido', label: 'Recebido', sort: true, numeric: true },
        { id: 'rateado', label: 'Rateado', sort: true, numeric: true },
        { id: 'saldo', label: 'Saldo', sort: true, numeric: true });
    }
    if (state.detailed) {
      const present = new Set(columns.map(column => column.id));
      const detailed = [
        { id: 'grupo', label: 'Centro de custo', sort: true },
        { id: 'grupoEmpresa', label: 'Grupo', sort: true },
        { id: 'documento', label: 'CNPJ' },
        { id: 'competenciaOriginal', label: 'Competência' },
        { id: 'nf', label: 'NF' },
      ].filter(column => !present.has(column.id));
      columns.splice(4, 0, ...detailed);
      const extras = [
        { id: 'acrescimo', label: 'Acréscimo', numeric: true },
        { id: 'imposto', label: 'Imposto', numeric: true },
        { id: 'titulo', label: 'Título', numeric: true },
        { id: 'taxa', label: 'Taxa', numeric: true },
        { id: 'multa', label: 'Multa', numeric: true },
        { id: 'acrescimoAvulso', label: 'Avulso', numeric: true },
        { id: 'desconto', label: 'Desc. parcela', numeric: true },
        { id: 'descontoPagamento', label: 'Desc. pagto', numeric: true },
        { id: 'tarifa', label: 'Tarifa', numeric: true },
        { id: 'diferencaRecebimento', label: 'Dif. recebida', numeric: true },
        { id: 'faturado', label: 'Faturado', numeric: true },
        { id: 'rateado', label: 'Rateado', numeric: true },
        { id: 'saldo', label: 'Saldo', numeric: true },
        { id: 'vidas', label: 'Vidas', numeric: true },
      ];
      const inserted = new Set(columns.map(column => column.id));
      extras.forEach(extra => { if (!inserted.has(extra.id)) columns.push(extra); });
    }
    columns.push({ id: 'actions', label: '' });
    return columns;
  }

  function cellHtml(column, x, status) {
    switch (column.id) {
      case 'status': return `<span class="rf-status is-${status.tone}">${esc(status.label)}</span>`;
      case 'empresa': return `<div class="rf-company"><strong>${esc(x.empresa)}</strong><small>${esc(x.grupoEmpresa || x.grupo || '—')}</small></div>`;
      case 'parcela': return esc(x.parcela || '—');
      case 'vencimento': return dateLabel(x.vencimento);
      case 'pagamento': {
        if (state.mode === 'recebimento' && x.banco?.pagamento) {
          return `${dayLabel(x.banco.pagamento)}<small class="rf-muted">banco</small>`;
        }
        return x.pagamento ? dateLabel(x.pagamento) : '<span class="rf-muted">Em aberto</span>';
      }
      case 'credito': return x.credito ? dateLabel(x.credito) : '<span class="rf-muted">—</span>';
      case 'vidas': return x.parcela
        ? `<button type="button" class="rf-lives-button" data-lives="${esc(x.parcela)}" title="Ver a relação nominal desta parcela">${num(x.vidasFaturadas)}</button><small class="rf-muted">${num(x.vidas)} no S4E</small>`
        : `${num(x.vidasFaturadas)}<small class="rf-muted">${num(x.vidas)} no S4E</small>`;
      case 'faturado': return cash(x.faturado);
      case 'recebido': {
        if (state.mode === 'recebimento') {
          const bank = x.banco;
          if (bank) {
            const note = bank.situacao === 'conciliado'
              ? `<small class="rf-muted">Banco ${dayLabel(bank.pagamento)}</small>`
              : `<small class="rf-muted ${bank.situacao === 'divergente' ? 'rf-negative' : 'rf-attention'}">Banco · S4E ${cash(x.valorRecebido)}</small>`;
            return `<strong>${cash(bank.valor)}</strong>${note}`;
          }
          if (Number(x.valorRecebido) > 0) {
            const note = outsideReturnMonth(x) ? 'Fora do mês do retorno' : 'Sem retorno';
            return `<strong>${cash(x.valorRecebido)}</strong><small class="rf-muted rf-attention">${note}</small>`;
          }
          return `<strong>${cash(x.valorRecebido)}</strong>`;
        }
        const info = differenceInfo(x);
        const note = info && Math.abs(info.diff) > 0.01
          ? `<small class="rf-muted ${info.diff < 0 ? 'rf-negative' : ''}">${cash(info.diff)} · ${esc(info.label || 'diferença')}</small>`
          : '';
        return `<strong>${cash(x.valorRecebido)}</strong>${note}`;
      }
      case 'rateado': return cash(x.totalRateado);
      case 'saldo': return `<span class="${Number(x.saldo) < -0.01 ? 'rf-negative' : (Number(x.saldo) > 0.01 ? 'rf-attention' : '')}">${cash(x.saldo)}</span>`;
      case 'actions': return `<button type="button" class="rf-link" data-detail="${x.__id}">Detalhe</button>`;
      case 'diferencaRecebimento': {
        const info = differenceInfo(x);
        if (!info) return '<span class="rf-muted">Em aberto</span>';
        if (Math.abs(info.diff) <= 0.01) return '<span class="rf-muted">—</span>';
        return `<span class="${info.diff < 0 ? 'rf-negative' : ''}">${cash(info.diff)}</span>${info.label ? `<small class="rf-muted">${esc(info.label)}</small>` : ''}`;
      }
      case 'conferencia': {
        if (x.banco) {
          const tone = { conciliado: 'ok', 'nao-baixado': 'warning', divergente: 'error' }[x.banco.situacao] || 'review';
          const note = Math.abs(Number(x.banco.diferenca) || 0) > 0.01
            ? `<small class="rf-muted ${x.banco.diferenca < 0 ? 'rf-negative' : ''}">${cash(x.banco.diferenca)}</small>`
            : '';
          return `<span class="rf-status is-${tone}">${esc(bankStatusLabel[x.banco.situacao] || 'Verificar')}</span>${note}`;
        }
        if (Number(x.valorRecebido) > 0) {
          return outsideReturnMonth(x)
            ? '<span class="rf-status is-review">Fora do mês</span>'
            : '<span class="rf-status is-warning">Sem retorno</span>';
        }
        return '<span class="rf-status is-review">Em aberto</span>';
      }
      case 'competenciaOriginal': {
        if (!x.competenciaOriginal) return '—';
        return inMonth(x.competenciaOriginal)
          ? esc(x.competenciaOriginal)
          : `${esc(x.competenciaOriginal)}<small class="rf-muted">outra competência</small>`;
      }
      case 'documento':
      case 'nf':
      case 'grupo':
      case 'grupoEmpresa': return esc(x[column.id] || '—');
      default: return cash(x[column.id]);
    }
  }

  function renderTable() {
    const columns = tableColumns();
    $('rfHead').innerHTML = `<tr>${columns.map(column => {
      if (!column.sort) return `<th class="${column.numeric ? 'num' : ''}">${column.label}</th>`;
      const active = state.sort?.key === column.id;
      const mark = active ? (state.sort.dir > 0 ? '▲' : '▼') : '↕';
      return `<th class="${column.numeric ? 'num' : ''}" aria-sort="${active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="rf-sort ${active ? 'is-active' : ''}" data-sort="${column.id}">${column.label}<span>${mark}</span></button></th>`;
    }).join('')}</tr>`;
    const rows = filteredItems();
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * state.pageSize;
    const pageRows = rows.slice(start, start + state.pageSize);
    $('rfRows').innerHTML = pageRows.map(x => {
      const status = statusOf(x);
      return `<tr class="is-${status.tone}">${columns.map(column => `<td class="${column.numeric ? 'num' : ''}">${cellHtml(column, x, status)}</td>`).join('')}</tr>`;
    }).join('');
    $('rfEmpty').hidden = rows.length > 0;
    const sum = totals(rows);
    const scope = [
      state.grupo ? `centro ${state.grupo}` : '',
      state.grupoEmpresa ? `grupo ${state.grupoEmpresa}` : '',
      state.empresa ? `empresa ${state.empresa}` : '',
      state.receiver ? `conta ${state.receiver}` : '',
      state.status ? `situação ${statusLabel(state.status)}` : '',
      state.search.trim() ? `busca “${state.search.trim()}”` : '',
    ].filter(Boolean).join(' · ');
    const receiverTotal = state.receiver
      ? rows.reduce((acc, x) => acc + (x.rateios || []).filter(r => r.recebedor === state.receiver).reduce((sum2, r) => sum2 + (Number(r.valor) || 0), 0), 0)
      : null;
    const receiverNote = receiverTotal === null ? '' : ` · ${state.receiver} recebe ${cash(receiverTotal)}`;
    const metrics = cashMetrics(rows);
    const otherNote = metrics.otherCount ? ` · ${cash(metrics.other)} (${num(metrics.otherCount)}) de outras competências` : '';
    const totalsText = state.mode === 'recebimento'
      ? (bankActive()
          ? `Retorno bancário: ${cash(receipts().banco.valor)} em ${num(receipts().banco.count)} ${receipts().banco.count === 1 ? 'pagamento' : 'pagamentos'} · Relatório: ${cash(receipts().relatorio?.valor)} · Diferença: ${cash(receipts().diferenca)}${(receipts().grupos || []).length ? ' (explicada na conciliação)' : ''}`
          : `Créditos de ${state.data?.competencia || '—'}: ${cash(sum.received)} em ${num(rows.length)} ${rows.length === 1 ? 'título' : 'títulos'}${otherNote}${receiverNote}`)
      : `Faturamento ${cash(sum.billing)} · Recebido ${cash(sum.received)} · Rateado ${cash(sum.allocated)} · Saldo ${cash(sum.billing - sum.allocated)}${receiverNote}`;
    $('rfTableSummary').textContent = `${rows.length} de ${items().length} lançamentos${scope ? ` · ${scope}` : ''} · ${totalsText}`;
    $('rfPageInfo').textContent = rows.length ? `${start + 1}–${Math.min(rows.length, start + state.pageSize)} de ${rows.length}` : '0 de 0';
    $('rfPrevPage').disabled = state.page <= 1;
    $('rfNextPage').disabled = state.page >= pages;
    $('rfToggleDetail').textContent = state.detailed ? 'Menos colunas' : 'Mais colunas';
    document.querySelectorAll('[data-rf-mode]').forEach(button => {
      const active = button.dataset.rfMode === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function statusLabel(key) {
    return ({ fechado: 'fechados', falta: 'falta', excede: 'excede', 'sem-regra': 'sem regra', problema: 'com problema' })[key] || key;
  }

  function renderRules() {
    const rules = state.data?.rules || [];
    const text = state.rulesSearch.trim().toLowerCase();
    const list = rules.filter(rule => {
      if (state.rulesFilter === 'ativa' && !rule.ativo) return false;
      if (state.rulesFilter === 'revisao' && rule.ativo) return false;
      if (!text) return true;
      return [rule.grupo, rule.grupoEmpresa, rule.empresa, rule.recebedor].map(v => String(v || '')).join(' ').toLowerCase().includes(text);
    });
    const manage = canManage();
    $('rfRuleRows').innerHTML = list.map(rule => {
      const exception = rule.empresa ? esc(rule.empresa) : '—';
      const value = rule.metodo === 'percentual' ? `${num(rule.valor)}%` : cash(rule.valor);
      const status = manage
        ? `<div class="rf-rule-state"><button type="button" class="rf-switch ${rule.ativo ? 'is-on' : ''}" data-toggle="${esc(rule.id)}" aria-pressed="${rule.ativo}" title="${rule.ativo ? 'Colocar em revisão' : 'Ativar regra'}"><span></span></button><span>${rule.ativo ? 'Ativa' : 'Em revisão'}</span></div>`
        : `<span class="rf-status is-${rule.ativo ? 'ok' : 'review'}">${rule.ativo ? 'Ativa' : 'Em revisão'}</span>`;
      const actions = manage
        ? `<div class="rf-rule-actions"><button type="button" class="rf-link" data-edit="${esc(rule.id)}">Editar</button><button type="button" class="rf-link" data-duplicate="${esc(rule.id)}">Duplicar</button><button type="button" class="rf-link rf-delete" data-delete="${esc(rule.id)}">Excluir</button></div>`
        : '';
      const escopo = levelLabel[rule.nivel || 1] || 'Centro de custo';
      const encargo = rule.encargos === 'recebedor'
        ? `Conta: ${esc(rule.encargosRecebedor || '—')}`
        : (encargosLabel[rule.encargos] || encargosLabel.rateio);
      return `<tr class="${rule.ativo ? '' : 'is-review'}"><td>${esc(rule.grupo)}</td><td>${esc(rule.grupoEmpresa || '—')}</td><td>${exception}</td><td><strong>${esc(rule.recebedor)}</strong></td><td>${methodLabel[rule.metodo] || esc(rule.metodo)}</td><td>${value}</td><td><small>${escopo}</small></td><td><small>${encargo}</small></td><td>${status}</td><td class="rf-col-actions">${actions}</td></tr>`;
    }).join('');
    $('rfRulesEmpty').hidden = list.length > 0;
    $('rfRuleCount').textContent = `${list.length} de ${rules.length} ${rules.length === 1 ? 'regra' : 'regras'}`;
    $('rfRuleOpen').hidden = !manage;
  }

  function render() {
    const data = state.data || {};
    items().forEach((item, index) => { item.__id = index; });
    syncFilterOptions();
    $('rfTabCount').textContent = items().length;
    $('rfTabRules').textContent = (data.rules || []).filter(rule => rule.ativo).length;
    renderHero();
    renderKpis();
    renderCash();
    renderReconcile();
    renderReceivers();
    renderStatuses();
    renderAlerts();
    renderTable();
    renderRules();
  }

  async function load() {
    if (!visible()) return;
    const epoch = ++state.epoch;
    setBusy(true);
    state.page = 1;
    try {
      const data = await api(`/api/rateios-faturamento?${filteredQuery()}`);
      if (epoch !== state.epoch) return;
      state.data = data;
      state.prev = null;
      const parcel = $('rfParcelType').value;
      const competencia = $('rfCompetencia').value;
      $('rfCompetencia').innerHTML = (data.competencias || []).map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
      $('rfCompetencia').value = competencia || data.competencia;
      $('rfParcelType').innerHTML = '<option value="">Todos os tipos</option>' + (data.tiposParcela || []).map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
      $('rfParcelType').value = (data.tiposParcela || []).includes(parcel) ? parcel : '';
      render();
      msg(data.run ? '' : 'Execute a Apuração desta competência para carregar os lançamentos.');
      setBusy(false);
      loadComparison(epoch);
    } catch (error) {
      if (epoch !== state.epoch) return;
      msg(error.message || 'Não foi possível carregar o rateio.', true);
      setBusy(false);
    }
  }

  async function loadComparison(epoch) {
    const data = state.data;
    const list = data?.competencias || [];
    const index = list.indexOf(data?.competencia);
    const previous = index >= 0 ? list[index + 1] : '';
    if (!previous) return;
    try {
      const result = await api(`/api/rateios-faturamento?competencia=${encodeURIComponent(previous)}`);
      if (epoch !== state.epoch || !result.run) return;
      state.prev = result;
      renderKpis();
    } catch (_) { /* comparativo é complementar */ }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#rateioScreen .rf-tab').forEach(button => {
      const active = button.dataset.rfTab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('#rateioScreen .rf-view').forEach(view => { view.classList.toggle('hidden', view.dataset.rfView !== tab); });
    if (tab === 'contas') renderAccounts();
  }

  function goToItems() {
    switchTab('lancamentos');
    render();
    $('rateioScreen').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function enhanceCombo(id) {
    const select = $(id);
    if (!select || select.dataset.combo) return;
    select.dataset.combo = 'ready';
    select.removeAttribute('required');
    select.setAttribute('tabindex', '-1');
    const holder = document.createElement('div');
    holder.className = 'rf-combo';
    select.parentNode.insertBefore(holder, select);
    holder.appendChild(select);
    select.classList.add('rf-combo-native');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rf-combo-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="rf-combo-label"></span><span class="rf-combo-arrow" aria-hidden="true">▾</span>';
    const panel = document.createElement('div');
    panel.className = 'rf-combo-panel';
    panel.hidden = true;
    panel.innerHTML = '<input type="search" class="rf-combo-search" placeholder="Pesquisar…" autocomplete="off" aria-label="Pesquisar opções"><div class="rf-combo-list" role="listbox"></div><p class="rf-combo-empty" hidden>Nenhuma opção encontrada.</p>';
    holder.append(button, panel);
    const search = panel.querySelector('.rf-combo-search');
    const list = panel.querySelector('.rf-combo-list');
    const empty = panel.querySelector('.rf-combo-empty');

    const label = () => {
      const option = [...select.options].find(item => item.value === select.value) || select.options[0];
      button.querySelector('.rf-combo-label').textContent = option ? option.textContent : 'Selecione…';
      button.classList.toggle('is-placeholder', !select.value);
    };
    const draw = () => {
      const query = norm(search.value);
      const options = [...select.options].filter(item => !query || norm(item.textContent).includes(query));
      list.innerHTML = options.map(item => `<button type="button" class="rf-combo-option ${item.value === select.value ? 'is-selected' : ''}" role="option" aria-selected="${item.value === select.value}" data-value="${esc(item.value)}">${esc(item.textContent)}</button>`).join('');
      empty.hidden = options.length > 0;
    };
    const close = () => {
      if (panel.hidden) return;
      panel.hidden = true;
      holder.classList.remove('is-open');
      button.setAttribute('aria-expanded', 'false');
      search.value = '';
    };
    const open = () => {
      document.querySelectorAll('.rf-combo.is-open').forEach(node => { if (node !== holder && node.rfClose) node.rfClose(); });
      panel.hidden = false;
      holder.classList.add('is-open');
      button.setAttribute('aria-expanded', 'true');
      draw();
      search.focus();
    };
    holder.rfClose = close;
    holder.rfRefresh = () => { label(); if (!panel.hidden) draw(); };
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      if (panel.hidden) open(); else close();
    };
    button.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    };
    search.oninput = draw;
    search.onkeydown = event => {
      const options = [...list.querySelectorAll('.rf-combo-option')];
      const index = options.findIndex(node => node.classList.contains('is-focused'));
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        button.focus();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const target = options[index >= 0 ? index : 0];
        if (target) target.click();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!options.length) return;
        const next = event.key === 'ArrowDown' ? Math.min(options.length - 1, index + 1) : Math.max(0, index - 1);
        options.forEach((node, position) => node.classList.toggle('is-focused', position === next));
        options[next].scrollIntoView({ block: 'nearest' });
      }
    };
    list.onclick = event => {
      const option = event.target.closest('.rf-combo-option');
      if (!option) return;
      select.value = option.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      label();
      close();
      button.focus();
    };
    select.addEventListener('change', label);
    label();
  }

  function refreshCombo(id) {
    $(id)?.closest('.rf-combo')?.rfRefresh?.();
  }

  function fillCombo(id, values, placeholder) {
    const select = $(id);
    const current = select.value;
    select.innerHTML = `<option value="">${esc(placeholder)}</option>` + values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    select.value = values.includes(current) ? current : '';
    refreshCombo(id);
  }

  function syncFilterOptions() {
    const rows = items();
    const groups = [...new Set(rows.map(x => x.grupo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    fillCombo('rfFilterGroup', groups, 'Todos os centros de custo');
    state.grupo = $('rfFilterGroup').value;
    const subs = [...new Set(rows.filter(x => !state.grupo || x.grupo === state.grupo).map(x => x.grupoEmpresa).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    fillCombo('rfFilterCompanyGroup', subs, state.grupo ? 'Todos os grupos deste centro' : 'Todos os grupos');
    state.grupoEmpresa = $('rfFilterCompanyGroup').value;
    const companies = [...new Set(rows
      .filter(x => (!state.grupo || x.grupo === state.grupo) && (!state.grupoEmpresa || x.grupoEmpresa === state.grupoEmpresa))
      .map(x => x.empresa).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    fillCombo('rfFilterCompany', companies, state.grupoEmpresa ? 'Todas as empresas do grupo' : 'Todas as empresas');
    state.empresa = $('rfFilterCompany').value;
  }

  function syncGroups() {
    const values = [...items().map(x => x.grupo), ...(state.data?.rules || []).map(r => r.grupo)].filter(Boolean);
    const groups = [...new Set(values)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const old = $('rfGroup').value;
    $('rfGroup').innerHTML = groups.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    if (groups.includes(old)) $('rfGroup').value = old;
    refreshCombo('rfGroup');
    syncCompanies();
  }

  function syncCompanies() {
    const group = $('rfGroup').value;
    const fromItems = items().filter(x => x.grupo === group);
    const fromRules = (state.data?.rules || []).filter(r => r.grupo === group);
    const subs = [...new Set([...fromItems.map(x => x.grupoEmpresa), ...fromRules.map(r => r.grupoEmpresa)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const oldSub = $('rfCompanyGroup').value;
    $('rfCompanyGroup').innerHTML = '<option value="">Todos os grupos deste centro</option>' + subs.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    if (subs.includes(oldSub)) $('rfCompanyGroup').value = oldSub;
    refreshCombo('rfCompanyGroup');
    const sub = $('rfCompanyGroup').value;
    const companies = [...new Set([
      ...fromItems.filter(x => !sub || x.grupoEmpresa === sub).map(x => x.empresa),
      ...fromRules.filter(r => (!sub || r.grupoEmpresa === sub) && r.empresa).map(r => r.empresa),
    ])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const oldCompany = $('rfCompany').value;
    $('rfCompany').innerHTML = '<option value="">Todas as empresas do grupo</option>' + companies.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    if (companies.includes(oldCompany)) $('rfCompany').value = oldCompany;
    refreshCombo('rfCompany');
    updateRuleImpact();
  }

  function ruleScope() {
    const group = $('rfGroup').value;
    const sub = $('rfCompanyGroup').value;
    const company = $('rfCompany').value;
    return items().filter(x => x.grupo === group && (!sub || x.grupoEmpresa === sub) && (!company || x.empresa === company));
  }

  function updateRuleImpact() {
    const value = Number($('rfValue').value) || 0;
    const scope = ruleScope();
    const method = $('rfMethod').value;
    const scopeLabel = scope.length
      ? `${scope.length} ${scope.length === 1 ? 'lançamento' : 'lançamentos'} nesta competência`
      : 'nenhum lançamento nesta competência para este escopo';
    if (!scope.length) {
      $('rfRuleImpact').textContent = `Impacto estimado: — · ${scopeLabel}.`;
      return;
    }
    const vidas = scope.reduce((acc, x) => acc + (Number(x.vidasFaturadas) || 0), 0);
    const billing = scope.reduce((acc, x) => acc + (Number(x.faturado) || 0), 0);
    const base = method === 'percentual' ? billing * value / 100 : method === 'por_vida' ? vidas * value : scope.length * value;
    const detail = method === 'percentual'
      ? `${pct(value)} de ${cash(billing)}`
      : method === 'por_vida'
        ? `${num(vidas)} vidas × ${cash(value)}`
        : `${scope.length} ${scope.length === 1 ? 'lançamento' : 'lançamentos'} × ${cash(value)}`;
    $('rfRuleImpact').textContent = `Impacto estimado: ${cash(base)} · ${detail} em ${scopeLabel.replace(' nesta competência', '')}.`;
  }

  function updateValueLabel() {
    $('rfValueLabel').textContent = ({ por_vida: 'Valor por vida', percentual: 'Percentual do faturamento (%)', fixo: 'Valor fixo por lançamento' })[$('rfMethod').value];
    updateRuleImpact();
  }

  // ── Contas que recebem rateio ────────────────────────────────────
  function accountList() {
    return (state.data?.accounts) || [];
  }

  function accountNames() {
    return accountList().filter(a => a.ativo).map(a => a.nome);
  }

  // Preenche um select de conta, mantendo o valor atual quando ele existe.
  function fillAccountSelect(id, value, opcional) {
    const select = $(id);
    if (!select) return;
    const nomes = accountNames();
    const atual = value || select.value || '';
    const opcoes = [`<option value="">${opcional || 'Escolha a conta'}</option>`]
      .concat(nomes.map(nome => `<option value="${esc(nome)}">${esc(nome)}</option>`));
    // Uma regra antiga pode apontar para uma conta ainda não cadastrada: não perder.
    if (atual && !nomes.includes(atual)) {
      opcoes.push(`<option value="${esc(atual)}">${esc(atual)} (não cadastrada)</option>`);
    }
    select.innerHTML = opcoes.join('');
    select.value = atual;
  }

  function accountRulesCount(nome) {
    return ((state.data?.rules) || []).filter(r => r.recebedor === nome || r.encargosRecebedor === nome).length;
  }

  function renderAccounts() {
    const busca = norm($('rfAccountsSearch')?.value || '');
    const filtro = $('rfAccountsFilter')?.value || '';
    const contas = accountList().filter(conta => {
      if (filtro === 'ativa' && !conta.ativo) return false;
      if (filtro === 'revisao' && conta.ativo) return false;
      if (!busca) return true;
      return [conta.nome, conta.tipo, conta.documento, conta.banco, conta.chavePix].some(v => norm(v || '').includes(busca));
    });
    const linhas = contas.map(conta => {
      const usadas = accountRulesCount(conta.nome);
      const contaBanco = [conta.agencia, conta.conta].filter(Boolean).join(' / ') || '—';
      const tipo = ({ sindicato: 'Sindicato', rede: 'Rede Saúde', fundo: 'Fundo', pessoa: 'Pessoa física', outro: 'Outro' })[conta.tipo] || '—';
      return `<tr class="${conta.ativo ? '' : 'is-review'}"><td><strong>${esc(conta.nome)}</strong>${conta.observacao ? `<br><small>${esc(conta.observacao)}</small>` : ''}</td><td>${tipo}</td><td>${esc(conta.documento || '—')}</td><td>${esc(conta.banco || '—')}</td><td>${esc(contaBanco)}</td><td>${esc(conta.chavePix || '—')}</td><td>${usadas}</td><td>${conta.ativo ? '<span class="rf-badge is-ok">Ativa</span>' : '<span class="rf-badge">Inativa</span>'}</td><td class="rf-col-actions"><button type="button" class="rf-row-action" data-account-edit="${esc(conta.id)}">Editar</button><button type="button" class="rf-row-action" data-account-del="${esc(conta.id)}">Excluir</button></td></tr>`;
    });
    $('rfAccountRows').innerHTML = linhas.join('');
    $('rfAccountsEmpty').classList.toggle('hidden', linhas.length > 0);
    $('rfAccountCount').textContent = `${contas.length} de ${accountList().length}`;
    $('rfTabAccounts').textContent = accountList().length;
  }

  function openAccount(conta = null) {
    $('rfAccountForm').reset();
    state.editingAccount = conta;
    $('rfAccountId').value = conta?.id || '';
    $('rfAccountTitle').textContent = conta ? 'Editar conta de rateio' : 'Nova conta de rateio';
    $('rfAccountError').hidden = true;
    if (conta) {
      $('rfAccountName').value = conta.nome || '';
      $('rfAccountKind').value = conta.tipo || '';
      $('rfAccountDoc').value = conta.documento || '';
      $('rfAccountBank').value = conta.banco || '';
      $('rfAccountBranch').value = conta.agencia || '';
      $('rfAccountNumber').value = conta.conta || '';
      $('rfAccountPix').value = conta.chavePix || '';
      $('rfAccountNote').value = conta.observacao || '';
    }
    $('rfAccountDialog').showModal();
  }

  function openRule(rule = null, copy = false) {
    const contas = accountNames();
    if (!contas.length) {
      msg('Cadastre ao menos uma conta na aba Contas antes de criar a regra.', true);
      switchTab('contas');
      return;
    }
    $('rfRuleForm').reset();
    state.editingRule = copy ? null : rule;
    $('rfRuleId').value = copy ? '' : (rule?.id || '');
    $('rfRuleTitle').textContent = rule ? (copy ? 'Duplicar regra de rateio' : 'Editar regra de rateio') : 'Nova regra de rateio';
    $('rfRuleError').hidden = true;
    $('rfRuleError').textContent = '';
    syncGroups();
    fillAccountSelect('rfReceiver', rule?.recebedor || '');
    fillAccountSelect('rfEncargosReceiver', rule?.encargosRecebedor || '', 'Escolha a conta');
    if (rule) {
      $('rfGroup').value = rule.grupo;
      refreshCombo('rfGroup');
      syncCompanies();
      if (rule.grupoEmpresa) { $('rfCompanyGroup').value = rule.grupoEmpresa; syncCompanies(); }
      if (rule.empresa) { $('rfCompany').value = rule.empresa; refreshCombo('rfCompany'); }
      fillAccountSelect('rfReceiver', rule.recebedor);
      $('rfMethod').value = rule.metodo;
      if ($('rfEncargos')) $('rfEncargos').value = rule.encargos || 'rateio';
      fillAccountSelect('rfEncargosReceiver', rule.encargosRecebedor || '', 'Escolha a conta');
      toggleEncargosReceiver();
      $('rfValue').value = rule.valor;
    }
    refreshCombo('rfGroup');
    refreshCombo('rfCompanyGroup');
    refreshCombo('rfCompany');
    updateValueLabel();
    $('rfRuleDialog').showModal();
  }

  function differenceHtml(x) {
    const info = differenceInfo(x);
    if (!info) return '<p class="rf-muted">Título em aberto — nenhum valor recebido.</p>';
    if (!info.parts.length) return '<p class="rf-muted">Recebido igual ao faturado.</p>';
    const rows = info.parts.map(part => `<li><span>${esc(part.label)}</span><strong class="${part.value < 0 ? 'rf-negative' : ''}">${cash(part.value)}</strong></li>`).join('');
    return `<ul class="rf-diff-list">${rows}<li class="rf-diff-total"><span>Recebido − faturado</span><strong class="${info.diff < 0 ? 'rf-negative' : ''}">${cash(info.diff)}</strong></li></ul>`;
  }

  function differenceText(x) {
    const info = differenceInfo(x);
    if (!info) return 'Diferença: título em aberto (sem recebimento)';
    if (!info.parts.length) return 'Diferença: recebido igual ao faturado';
    return `Diferença: ${cash(info.diff)} · ${info.parts.map(part => `${part.label} ${cash(part.value)}`).join(' · ')}`;
  }

  const outsideReturnMonth = x => {
    const month = receipts()?.mes;
    return Boolean(month && x.pagamento && isoDate(x.pagamento).slice(0, 7) !== month);
  };

  function bankHtml(x) {
    const bank = x.banco;
    if (!bank) {
      if (Number(x.valorRecebido) <= 0) return '<p class="rf-muted">Sem retorno bancário para este título.</p>';
      if (outsideReturnMonth(x)) {
        return `<p class="rf-muted">O S4E registra o pagamento em ${dateLabel(x.pagamento)}, fora do mês do retorno conferido — por isso ele não aparece no banco deste mês.</p>`;
      }
      return '<p class="rf-muted">O relatório registra recebimento, mas não há retorno bancário correspondente no período.</p>';
    }
    const tone = { conciliado: 'ok', 'nao-baixado': 'warning', divergente: 'error' }[bank.situacao] || 'review';
    return `<ul class="rf-diff-list"><li><span>Pago no banco</span><strong>${cash(bank.valor)}</strong></li><li><span>Data do retorno</span><strong>${dayLabel(bank.pagamento)}</strong></li><li><span>Ocorrência</span><strong>${esc(bank.ocorrencia || '—')}</strong></li><li><span>Arquivo</span><strong>${esc(bank.tipo || bank.arquivo || '—')}</strong></li><li class="rf-diff-total"><span>Conferência</span><strong><span class="rf-status is-${tone}">${esc(bankStatusLabel[bank.situacao] || 'Verificar')}</span></strong></li></ul>`;
  }

  function bankText(x) {
    if (x.banco) return `Banco: ${cash(x.banco.valor)} em ${dayLabel(x.banco.pagamento)} · ${bankStatusLabel[x.banco.situacao] || 'verificar'}`;
    if (Number(x.valorRecebido) <= 0) return 'Banco: sem pagamento';
    if (outsideReturnMonth(x)) return `Banco: pagamento do S4E em ${dateLabel(x.pagamento)}, fora do mês do retorno`;
    return 'Banco: sem retorno bancário no período';
  }

  function detailHtml(x) {
    const status = statusOf(x);
    const fields = [
      ['Centro de custo', x.grupo], ['Grupo', x.grupoEmpresa], ['CNPJ', x.documento],
      ['Competência original', x.competenciaOriginal], ['Vencimento', dateLabel(x.vencimento)],
      ['Pagamento', dateLabel(x.pagamento)], ['Crédito', dateLabel(x.credito)], ['NF', x.nf],
    ];
    const values = [
      ['Faturamento', cash(x.faturado)], ['Acréscimo', cash(x.acrescimo)], ['Imposto', cash(x.imposto)],
      ['Título', cash(x.titulo)], ['Taxa', cash(x.taxa)], ['Multa', cash(x.multa)],
      ['Acréscimo avulso', cash(x.acrescimoAvulso)], ['Desconto parcela', cash(x.desconto)],
      ['Desconto pagamento', cash(x.descontoPagamento)], ['Tarifa', cash(x.tarifa)],
      ['Valor recebido', cash(x.valorRecebido)], ['Diferença recebida', cash(x.diferencaRecebimento)],
      ['Rateado base', cash(x.totalRateado)], ['Saldo base', cash(x.saldo)],
    ];
    const allocations = (x.rateios || []).map(r => `<li><span>${esc(r.recebedor)}</span><strong>${cash(r.valor)}</strong></li>`).join('') || '<li class="rf-empty-inline">Nenhuma regra aplicada.</li>';
    return `
      <div class="rf-detail-status"><span class="rf-status is-${status.tone}">${esc(status.label)}</span><span>${num(x.vidasFaturadas)} vidas faturadas · ${num(x.vidas)} no S4E</span></div>
      <dl class="rf-detail-grid">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value || '—')}</dd></div>`).join('')}</dl>
      <h4>Valores</h4>
      <dl class="rf-detail-grid rf-detail-values">${values.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
      <h4>Composição da diferença</h4>
      ${differenceHtml(x)}
      <h4>Conciliação bancária</h4>
      ${bankHtml(x)}
      <h4>Distribuição por conta</h4>
      <ul class="rf-allocations">${allocations}</ul>
      <div class="rf-form-actions"><button type="button" class="button button-secondary" id="rfDetailCopy">Copiar dados</button>${x.parcela ? `<button type="button" class="button button-secondary" id="rfDetailLives">Ver vidas da parcela</button>` : ''}<button type="button" class="button button-primary" id="rfDetailDone">Fechar</button></div>`;
  }

  function openDetail(id) {
    const item = items().find(x => String(x.__id) === String(id));
    if (!item) return;
    $('rfDetailTitle').textContent = `${item.empresa} · parcela ${item.parcela || '—'}`;
    $('rfDetailBody').innerHTML = detailHtml(item);
    $('rfDetailDialog').showModal();
    $('rfDetailDone').onclick = () => $('rfDetailDialog').close();
    $('rfDetailCopy').onclick = () => copyText(detailText(item), $('rfDetailCopy'));
    const lives = $('rfDetailLives');
    if (lives) lives.onclick = () => { $('rfDetailDialog').close(); openLives(item.parcela); };
  }

  function detailText(x) {
    return [
      `${x.empresa} · parcela ${x.parcela || '—'}`,
      `Centro de custo: ${x.grupo || '—'} · Grupo: ${x.grupoEmpresa || '—'}`,
      `CNPJ: ${x.documento || '—'} · Competência: ${x.competenciaOriginal || '—'}`,
      `Vencimento: ${dateLabel(x.vencimento)} · Pagamento: ${dateLabel(x.pagamento)} · Crédito: ${dateLabel(x.credito)}`,
      `Vidas: ${num(x.vidasFaturadas)} faturadas · ${num(x.vidas)} no S4E`,
      `Faturamento: ${cash(x.faturado)} · Recebido: ${cash(x.valorRecebido)} · Rateado: ${cash(x.totalRateado)} · Saldo: ${cash(x.saldo)}`,
      differenceText(x),
      bankText(x),
      ...(x.rateios || []).map(r => `${r.recebedor}: ${cash(r.valor)}`),
    ].join('\n');
  }

  async function copyText(text, button) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copiado!';
      setTimeout(() => { button.textContent = original; }, 1800);
    }
  }

  function summaryText() {
    const rows = items();
    const sum = totals(rows);
    const metrics = cashMetrics(rows);
    const problems = rows.filter(x => statusOf(x).key !== 'fechado').length;
    const receivers = (state.data?.recebedores || []).slice().sort((a, b) => b.valor - a.valor)
      .map(x => `- ${x.nome}: ${cash(x.valor)}`);
    return [
      `Rateio de Faturamento — ${state.data?.competencia || ''}`,
      `Faturamento base: ${cash(sum.billing)}`,
      `Faturado da competência: ${cash(metrics.billing)} (${num(metrics.billingCount)} títulos)`,
      `Recebido por crédito no mês: ${cash(metrics.cash)}${metrics.otherCount ? ` (${cash(metrics.other)} de outras competências)` : ''}`,
      `Em aberto da competência: ${cash(metrics.open)}`,
      `Rateado base: ${cash(sum.allocated)}`,
      `Saldo: ${cash(sum.billing - sum.allocated)}`,
      `Lançamentos: ${rows.length} · ${problems} com problema`,
      '',
      'Por conta:',
      ...(receivers.length ? receivers : ['- Nenhuma conta recebendo']),
    ].join('\n');
  }

  async function openLives(parcela) {
    const item = items().find(x => String(x.parcela) === String(parcela));
    if (!item) return;
    $('rfLivesTitle').textContent = `${item.empresa} · parcela ${parcela}`;
    $('rfLivesLoading').textContent = 'Consultando a relação nominal no S4E…';
    $('rfLivesLoading').hidden = false;
    $('rfLivesContent').hidden = true;
    $('rfLivesDialog').showModal();
    try {
      const query = new URLSearchParams({ competencia: $('rfCompetencia').value, parcela });
      const d = await api(`/api/rateios-faturamento/vidas?${query}`);
      $('rfLivesS4e').textContent = d.temDuplicidade ? `${d.vidasS4e} (${d.vidasAtuaisUnicas} únicas)` : d.vidasS4e;
      $('rfLivesBilled').textContent = d.vidasFaturadas;
      $('rfLivesFound').textContent = d.identificadas;
      $('rfLivesGenerated').textContent = d.gerado || '—';
      $('rfLivesStatus').textContent = d.mensagem;
      $('rfLivesStatus').className = `rf-lives-status ${d.reconciliado && !d.temDuplicidade ? 'is-ok' : 'is-warning'}`;
      $('rfLivesIncluded').innerHTML = lifeRows(d.incluidas, true) || '<tr><td colspan="8">Nenhuma vida identificada.</td></tr>';
      $('rfLivesLater').innerHTML = lifeRows(d.posteriores, false);
      $('rfLivesLaterSection').hidden = !(d.posteriores || []).length;
      $('rfLivesSource').textContent = `Cancelamentos conferidos em: ${d.fonteCancelamentos}`;
      $('rfLivesLoading').hidden = true;
      $('rfLivesContent').hidden = false;
    } catch (error) {
      $('rfLivesLoading').textContent = error.message || 'Não foi possível consultar a relação nominal.';
    }
  }

  const lifeRows = (rows, included) => (rows || []).map(x => `<tr><td><strong>${esc(x.nome)}</strong></td><td>${esc(x.titular || '—')}</td><td>${esc(x.cpf || '—')}</td><td>${esc(x.associado || x.matricula || '—')}</td><td>${cash(x.valor)}</td><td>${dateLabel(x.adesao)}</td>${included ? `<td>${dateLabel(x.cancelamento)}</td>` : ''}<td>${esc(x.motivo || '—')}</td></tr>`).join('');

  window.enterRateioScreen = () => {
    state.active = true;
    switchTab('visao');
    load();
    pollJob();
  };
  window.leaveRateioScreen = () => {
    state.active = false;
    clearTimeout(state.jobTimer);
  };

  document.addEventListener('DOMContentLoaded', () => {
    ['rfGroup', 'rfCompanyGroup', 'rfCompany', 'rfFilterGroup', 'rfFilterCompanyGroup', 'rfFilterCompany'].forEach(enhanceCombo);
    $('rfRefresh').onclick = load;
    $('rfApplyFilters').onclick = load;
    $('rfClearFilters').onclick = () => {
      ['rfDueFrom', 'rfDueTo', 'rfPaidFrom', 'rfPaidTo', 'rfCreditFrom', 'rfCreditTo'].forEach(id => { $(id).value = ''; });
      $('rfPaymentStatus').value = '';
      $('rfParcelType').value = '';
      $('rfFilterGroup').value = '';
      $('rfFilterCompanyGroup').value = '';
      $('rfFilterCompany').value = '';
      syncFilterOptions();
      state.page = 1;
      renderTable();
      load();
    };
    $('rfFilterGroup').onchange = () => {
      $('rfFilterCompanyGroup').value = '';
      $('rfFilterCompany').value = '';
      syncFilterOptions();
      state.page = 1;
      renderTable();
    };
    $('rfFilterCompanyGroup').onchange = () => {
      $('rfFilterCompany').value = '';
      syncFilterOptions();
      state.page = 1;
      renderTable();
    };
    $('rfFilterCompany').onchange = () => {
      state.empresa = $('rfFilterCompany').value;
      state.page = 1;
      renderTable();
    };
    $('rfCompetencia').onchange = () => { state.receiver = ''; state.status = ''; state.search = ''; $('rfSearch').value = ''; setChips(); load(); };
    $('rfSearch').oninput = () => { state.search = $('rfSearch').value; state.page = 1; renderTable(); };
    $('rfToggleFilters').onclick = () => {
      const panel = $('rfFilterPanel');
      panel.hidden = !panel.hidden;
      $('rfToggleFilters').classList.toggle('is-active', !panel.hidden);
    };
    $('rfToggleDetail').onclick = () => { state.detailed = !state.detailed; $('rateioScreen').classList.toggle('is-detailed', state.detailed); renderTable(); };
    document.querySelectorAll('[data-rf-mode]').forEach(button => {
      button.onclick = () => {
        state.mode = button.dataset.rfMode;
        state.page = 1;
        const keys = tableColumns().map(column => column.id);
        if (state.sort && !keys.includes(state.sort.key)) state.sort = null;
        renderTable();
      };
    });
    $('rfGroup').onchange = () => { $('rfRuleError').hidden = true; syncCompanies(); };
    $('rfCompanyGroup').onchange = syncCompanies;
    $('rfMethod').onchange = updateValueLabel;
    $('rfValue').oninput = updateRuleImpact;
    $('rfRuleOpen').onclick = () => openRule();
    $('rfRuleClose').onclick = () => $('rfRuleDialog').close();
    $('rfRuleCancel').onclick = () => $('rfRuleDialog').close();
    $('rfDetailClose').onclick = () => $('rfDetailDialog').close();
    $('rfLivesClose').onclick = () => $('rfLivesDialog').close();
    $('rfPrevPage').onclick = () => { state.page = Math.max(1, state.page - 1); renderTable(); };
    $('rfNextPage').onclick = () => { state.page += 1; renderTable(); };
    $('rfCopySummary').onclick = () => copyText(summaryText(), $('rfCopySummary'));
    $('rfRulesSearch').oninput = () => { state.rulesSearch = $('rfRulesSearch').value; renderRules(); };
    $('rfRulesFilter').onchange = () => { state.rulesFilter = $('rfRulesFilter').value; renderRules(); };

    document.querySelectorAll('#rateioScreen .rf-tab').forEach(button => {
      button.onclick = () => switchTab(button.dataset.rfTab);
    });
    $('rfQuickFilters').onclick = event => {
      const chip = event.target.closest('[data-rf-status]');
      if (!chip) return;
      state.status = chip.dataset.rfStatus;
      state.page = 1;
      setChips();
      renderStatuses();
      renderTable();
    };
    $('rfStatuses').onclick = event => {
      const card = event.target.closest('[data-status]');
      if (!card) return;
      state.status = state.status === card.dataset.status ? '' : card.dataset.status;
      state.page = 1;
      setChips();
      goToItems();
    };
    $('rfReceivers').onclick = event => {
      const card = event.target.closest('[data-receiver]');
      if (!card) return;
      state.receiver = state.receiver === card.dataset.receiver ? '' : card.dataset.receiver;
      state.page = 1;
      renderReceivers();
      goToItems();
    };
    $('rfClearReceiver').onclick = () => { state.receiver = ''; renderReceivers(); renderTable(); };
    $('rfHead').onclick = event => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      const key = button.dataset.sort;
      state.sort = state.sort?.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
      state.page = 1;
      renderTable();
    };
    $('rfRows').onclick = event => {
      const lives = event.target.closest('[data-lives]');
      if (lives) return openLives(lives.dataset.lives);
      const detail = event.target.closest('[data-detail]');
      if (detail) openDetail(detail.dataset.detail);
    };
    $('rfRuleRows').onclick = async event => {
      const target = event.target.closest('[data-edit],[data-duplicate],[data-delete],[data-toggle]');
      if (!target) return;
      const rules = state.data?.rules || [];
      const rule = rules.find(x => x.id === (target.dataset.edit || target.dataset.duplicate || target.dataset.delete || target.dataset.toggle));
      if (!rule) return;
      if (target.dataset.edit) return openRule(rule);
      if (target.dataset.duplicate) return openRule(rule, true);
      if (target.dataset.toggle) {
        try {
          await api('/api/rateios-faturamento/regras', {
            method: 'POST',
            body: JSON.stringify({
              id: rule.id, grupo: rule.grupo, grupoEmpresa: rule.grupoEmpresa, empresa: rule.empresa,
              recebedor: rule.recebedor, metodo: rule.metodo, valor: rule.valor,
              vigenciaInicio: rule.vigenciaInicio, vigenciaFim: rule.vigenciaFim, ativo: !rule.ativo,
            }),
          });
          msg(rule.ativo ? `Regra de ${rule.recebedor} colocada em revisão.` : `Regra de ${rule.recebedor} ativada.`);
          load();
        } catch (error) { msg(error.message || 'Não foi possível alterar a regra.', true); }
        return;
      }
      if (confirm(`Excluir a regra de ${rule.recebedor}?`)) {
        try {
          await api(`/api/rateios-faturamento/regras/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
          load();
        } catch (error) { msg(error.message || 'Não foi possível excluir a regra.', true); }
      }
    };
    $('rfEncargos')?.addEventListener('change', toggleEncargosReceiver);

    // ── Ações da aba Contas ──────────────────────────────────────────
    $('rfAccountOpen').onclick = () => openAccount(null);
    $('rfAccountCancel').onclick = () => $('rfAccountDialog').close();
    $('rfAccountClose').onclick = () => $('rfAccountDialog').close();
    $('rfAccountsSearch').oninput = renderAccounts;
    $('rfAccountsFilter').onchange = renderAccounts;
    $('rfAccountRows').onclick = async event => {
      const editar = event.target.closest('[data-account-edit]');
      const excluir = event.target.closest('[data-account-del]');
      if (editar) {
        const conta = accountList().find(a => a.id === editar.dataset.accountEdit);
        if (conta) openAccount(conta);
        return;
      }
      if (!excluir) return;
      const conta = accountList().find(a => a.id === excluir.dataset.accountDel);
      if (!conta) return;
      const usadas = accountRulesCount(conta.nome);
      if (usadas) {
        msg(`"${conta.nome}" está em ${usadas} regra(s). Troque o destino antes de excluir.`, true);
        return;
      }
      if (!confirm(`Excluir a conta "${conta.nome}"?`)) return;
      try {
        await api(`/api/rateios-faturamento/contas/${encodeURIComponent(conta.id)}`, { method: 'DELETE' });
        msg('Conta excluída.');
        load();
      } catch (error) { msg(error.message || 'Não foi possível excluir a conta.', true); }
    };
    $('rfAccountForm').onsubmit = async event => {
      event.preventDefault();
      const nome = $('rfAccountName').value.trim();
      const erro = $('rfAccountError');
      if (!nome) {
        erro.textContent = 'Dê um nome à conta.';
        erro.hidden = false;
        return;
      }
      const repetida = accountList().find(a => a.id !== $('rfAccountId').value && norm(a.nome) === norm(nome));
      if (repetida) {
        erro.textContent = `Já existe a conta "${repetida.nome}".`;
        erro.hidden = false;
        return;
      }
      const button = $('rfAccountForm').querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/api/rateios-faturamento/contas', {
          method: 'POST',
          body: JSON.stringify({
            id: $('rfAccountId').value, nome,
            tipo: $('rfAccountKind').value,
            documento: $('rfAccountDoc').value,
            banco: $('rfAccountBank').value,
            agencia: $('rfAccountBranch').value,
            conta: $('rfAccountNumber').value,
            chavePix: $('rfAccountPix').value,
            observacao: $('rfAccountNote').value,
            ativo: state.editingAccount ? state.editingAccount.ativo : true,
          }),
        });
        $('rfAccountDialog').close();
        msg('Conta salva.');
        load();
      } catch (error) {
        erro.textContent = error.message || 'Não foi possível salvar a conta.';
        erro.hidden = false;
      } finally { button.disabled = false; }
    };

    $('rfRuleForm').onsubmit = async event => {
      event.preventDefault();
      const group = $('rfGroup').value;
      if (!group) {
        $('rfRuleError').textContent = 'Escolha o centro de custo da regra.';
        $('rfRuleError').hidden = false;
        return;
      }
      const button = $('rfRuleForm').querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/api/rateios-faturamento/regras', {
          method: 'POST',
          body: JSON.stringify({
            id: $('rfRuleId').value, grupo: group, grupoEmpresa: $('rfCompanyGroup').value,
            empresa: $('rfCompany').value, recebedor: $('rfReceiver').value, metodo: $('rfMethod').value,
            valor: $('rfValue').value,
            encargos: $('rfEncargos')?.value || 'rateio',
            encargosRecebedor: $('rfEncargosReceiver')?.value || '',
            vigenciaInicio: state.editingRule?.vigenciaInicio || '', vigenciaFim: state.editingRule?.vigenciaFim || '',
            ativo: state.editingRule ? state.editingRule.ativo : true,
          }),
        });
        $('rfRuleDialog').close();
        load();
      } catch (error) { msg(error.message || 'Não foi possível salvar a regra.', true); }
      finally { button.disabled = false; }
    };
    $('rfExport').onclick = async () => {
      try {
        const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/rateios-faturamento/exportar?${exportQuery()}`, { headers: window.PortalAccess.authHeaders({}) });
        if (!response.ok) throw new Error('Não foi possível gerar o Excel.');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `rateio-${$('rfCompetencia').value || 'competencia'}.xlsx`;
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) { msg(error.message || 'Não foi possível gerar o Excel.', true); }
    };
    $('rfRunApuracao').onclick = async () => {
      const button = $('rfRunApuracao');
      try {
        button.disabled = true;
        button.textContent = 'Consultando S4E…';
        const data = await api('/api/apuracao/run', { method: 'POST', body: JSON.stringify({ competencia: $('rfCompetencia').value || state.data?.competencia || '' }) });
        showJob(data.job || { running: true, percent: 2, message: 'Iniciando consulta…' });
        pollJob();
        msg('');
      } catch (error) { msg(error.message || 'Não foi possível iniciar a consulta ao S4E.', true); }
      finally { button.disabled = false; button.textContent = 'Buscar dados no S4E'; }
    };
  });

  function setChips() {
    document.querySelectorAll('#rfQuickFilters .rf-chip').forEach(chip => {
      chip.classList.toggle('is-active', (chip.dataset.rfStatus || '') === state.status);
    });
  }
}());

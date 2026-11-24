(() => {
  'use strict';

  const CATEGORY_LABELS = {
    attention: 'Atenção',
    finance: 'Financeiro',
    operation: 'Operação',
    indicators: 'Indicadores',
  };
  const TONE_LABELS = {
    attention: 'Atenção',
    running: 'Em andamento',
    ok: 'Disponível',
    empty: 'Sem dados',
    stale: 'Desatualizado',
    error: 'Indisponível',
    neutral: 'Ferramenta',
  };
  const SCHEDULE_LABELS = {
    demandas: 'Demandas',
    adesoes: 'Conferência de Adesões',
    semanal: 'Relatório Semanal',
    comissoes: 'Comissões',
    financeiro: 'Rateios P4X',
    apuracao: 'Apuração',
    rateio: 'Rateio de Faturamento',
    notas: 'Conferência de Notas',
    recibos: 'Recibos',
    vendas: 'Acompanhamento de Vendas',
    retornos: 'Retorno Instituição',
    cobranca: 'Cobranças',
  };
  const REPORTS = [
    { id: 'tasks', title: 'Demandas', icon: 'DM', category: 'attention', screen: 'tasksScreen', description: 'Fila do setor, prazos, responsáveis e prioridades.' },
    { id: 'retornos', title: 'Retorno Instituição', icon: 'IF', category: 'attention', screen: 'retornosScreen', description: 'Erros, correções e incidentes dos retornos bancários.' },
    { id: 'notas', title: 'Conferência de Notas', icon: 'NF', category: 'attention', screen: 'notasScreen', description: 'Notas e lotes duplicados, com valor em risco.' },
    { id: 'cobranca', title: 'Cobranças', icon: 'CB', category: 'attention', screen: 'cobrancaScreen', description: 'Empresas em atraso, contatos e promessas de pagamento.' },
    { id: 'contratos', title: 'Contratos', icon: 'CT', category: 'attention', screen: 'contractsScreen', description: 'Empresas, vidas e cadastros que ainda precisam de atenção.' },
    { id: 'comissoes', title: 'Comissões', icon: 'CM', category: 'attention', screen: 'commissionsScreen', description: 'Receita, comissão e vínculos de empresas com vendedores.' },
    { id: 'adesoes', title: 'Conferência de Adesões', icon: 'AD', category: 'attention', screen: 'adesiScreen', description: 'Lote, vidas e parcela conferidos dia a dia.' },
    { id: 'apuracao', title: 'Apuração', icon: 'AP', category: 'finance', screen: 'apuracaoScreen', description: 'Notas oficiais, pagamentos e grupos sem mapa.' },
    { id: 'rateio', title: 'Rateio de Faturamento', icon: 'RT', category: 'finance', screen: 'rateioScreen', description: 'Faturado, recebido, rateado e alertas por recebedor.' },
    { id: 'finance', title: 'Rateios P4X', icon: 'P4', category: 'finance', screen: 'financeScreen', description: 'Faturamento e recebimento consolidados por crédito.' },
    { id: 'recibos', title: 'Recibos', icon: 'RC', category: 'finance', screen: 'recibosScreen', description: 'Prévia, geração e download dos recibos do período.' },
    { id: 'vidas', title: 'Movimentação de Vidas', icon: 'MV', category: 'operation', screen: 'vidasScreen', description: 'Entradas, saídas, saldo e movimentos não atribuídos.' },
    { id: 'vendas', title: 'Acompanhamento de Vendas', icon: 'SV', category: 'operation', screen: 'vendasScreen', description: 'Vendas e cancelamentos já consultados no S4E.' },
    { id: 'semanal', title: 'Relatório Semanal', icon: 'RS', category: 'operation', screen: 'weeklyScreen', description: 'Empresas e estabelecimentos cadastrados no período.' },
    { id: 'exclusao', title: 'Exclusão de Vidas', icon: 'EX', category: 'operation', screen: 'movimentacoesScreen', description: 'Prévia e confirmação para cancelar vidas pelo portal.' },
    { id: 'odontoart', title: 'Odontoart', icon: 'OD', category: 'operation', screen: 'odontoartScreen', description: 'Controle e exportação da competência odontológica.' },
    { id: 'reports', title: 'Relatórios do Setor', icon: 'IN', category: 'indicators', screen: 'reportsScreen', description: 'Produtividade, entregas, atrasos e análise por pessoa.' },
  ];
  const MANUAL_REPORTS = new Set(['recibos', 'exclusao', 'odontoart', 'reports']);
  const state = {
    active: false,
    loading: false,
    loaded: false,
    generation: 0,
    loadedAt: '',
    data: {},
    errors: {},
    actionError: '',
    filter: 'all',
    search: '',
    downloading: '',
  };

  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const num = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const text = String(value ?? '').trim().replace(/[^\d,.-]/g, '');
    if (!text) return 0;
    if (text.includes(',')) return Number(text.replace(/\./g, '').replace(',', '.')) || 0;
    if (/^-?\d{1,3}(\.\d{3})+$/.test(text)) return Number(text.replace(/\./g, '')) || 0;
    return Number(text) || 0;
  };
  const integer = value => Math.round(num(value)).toLocaleString('pt-BR');
  const money = value => num(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const signed = value => `${num(value) > 0 ? '+' : ''}${integer(value)}`;
  const plural = (count, one, many) => `${integer(count)} ${num(count) === 1 ? one : many}`;

  function localISO(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function period() {
    const today = localISO();
    return { start: `${today.slice(0, 7)}-01`, end: today };
  }

  function stampLabel(value) {
    if (!value) return '';
    const raw = String(value);
    let date;
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (br) date = new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]), Number(br[4] || 0), Number(br[5] || 0));
    else date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    const hasTime = br ? Boolean(br[4]) : /T|\d{1,2}:\d{2}/.test(raw);
    return date.toLocaleString('pt-BR', hasTime
      ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function isAdmin() {
    return window.PortalAccess?.Access?.user?.role === 'admin';
  }

  async function request(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, {
        headers: window.PortalAccess.authHeaders(),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        clearSession();
        showLogin(data.error || 'Faça login para continuar.');
        throw new Error('Sua sessão terminou. Entre novamente no portal.');
      }
      if (response.status === 423) {
        showSystemLock(data);
        throw new Error('O portal está bloqueado pela administração.');
      }
      if (!response.ok) throw new Error(data.error || 'Não foi possível ler este relatório.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('A leitura demorou mais que o esperado. Tente novamente.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function taskMetrics(data) {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const today = localISO();
    const open = tasks.filter(task => task.status !== 'done');
    const todayCount = open.filter(task => {
      const due = String(task.periodStart || task.due || '');
      return Boolean(due) && due <= today;
    }).length;
    const overdue = open.filter(task => String(task.periodEnd || task.due || '') && String(task.periodEnd || task.due || '') < today).length;
    const stamps = tasks.map(task => task.updatedAt || task.createdAt).filter(Boolean).sort();
    return { tasks, open, todayCount, overdue, stamp: stamps.at(-1) || state.loadedAt };
  }

  function summarize(report, data) {
    const error = state.errors[report.id];
    if (error) return { tone: 'error', metric: '—', detail: error, stamp: '', severity: 0 };
    if (MANUAL_REPORTS.has(report.id)) {
      return { tone: 'neutral', metric: '—', detail: 'Abra a tela para consultar ou executar.', stamp: '', severity: 0 };
    }
    if (!data) return { tone: state.loading ? 'running' : 'empty', metric: '—', detail: state.loading ? 'Lendo dados salvos…' : 'Nenhuma leitura disponível.', stamp: '', severity: 0 };

    if (report.id === 'tasks') {
      const metrics = taskMetrics(data);
      return {
        tone: metrics.overdue ? 'attention' : metrics.todayCount ? 'running' : 'ok',
        metric: integer(metrics.todayCount),
        detail: `${plural(metrics.open.length, 'tarefa em aberto', 'tarefas em aberto')} · ${plural(metrics.overdue, 'atrasada', 'atrasadas')}`,
        stamp: metrics.stamp,
        severity: metrics.overdue ? 100 : metrics.todayCount ? 45 : 0,
        priority: metrics.overdue ? `${plural(metrics.overdue, 'demanda atrasada precisa de decisão', 'demandas atrasadas precisam de decisão')}.` : metrics.todayCount ? `${plural(metrics.todayCount, 'demanda para hoje está na fila', 'demandas para hoje estão na fila')}.` : '',
      };
    }
    if (report.id === 'retornos') {
      const open = num(data.globalOpen);
      const incidents = Array.isArray(data.incidents) ? data.incidents.length : 0;
      return {
        tone: open ? 'attention' : data.period?.checkedAt ? 'ok' : 'empty',
        metric: integer(open),
        detail: `${plural(incidents, 'incidente no período', 'incidentes no período')}`,
        stamp: data.period?.checkedAt || data.monitor?.lastChecked,
        severity: open ? 95 : 0,
        priority: open ? `${plural(open, 'retorno continua em aberto', 'retornos continuam em aberto')}.` : '',
      };
    }
    if (report.id === 'notas') {
      const summary = data.resumo || {};
      const groups = num(summary.grupos);
      return {
        tone: data.job?.running ? 'running' : groups ? 'attention' : data.run ? 'ok' : 'empty',
        metric: integer(groups),
        detail: `${money(summary.valorRisco)} em risco · ${integer(summary.totalNotas)} notas`,
        stamp: data.run?.finishedAt || data.run?.startedAt,
        severity: groups ? 90 : 0,
        priority: groups ? `${plural(groups, 'grupo de notas precisa de revisão', 'grupos de notas precisam de revisão')}.` : '',
      };
    }
    if (report.id === 'cobranca') {
      const summary = data.summary || {};
      const cases = num(data.total || summary.cases);
      return {
        tone: num(summary.old30) ? 'attention' : cases ? 'running' : 'ok',
        metric: integer(cases),
        detail: `${money(summary.total)} em aberto · ${plural(summary.old30, 'caso com mais de 30 dias', 'casos com mais de 30 dias')}`,
        stamp: data.imports?.[0]?.at,
        severity: num(summary.old30) ? 85 : 0,
        priority: num(summary.old30) ? `${plural(summary.old30, 'caso de cobrança passa de 30 dias', 'casos de cobrança passam de 30 dias')}.` : '',
      };
    }
    if (report.id === 'contratos') {
      const summary = data.summary || {};
      const pending = num(summary.companiesPending);
      return {
        tone: pending ? 'attention' : 'ok',
        metric: integer(pending),
        detail: `${integer(summary.companies)} empresas · ${integer(summary.lives)} vidas`,
        stamp: data.imports?.[0]?.createdAt,
        severity: pending ? 80 : 0,
        priority: pending ? `${plural(pending, 'empresa ainda não foi cadastrada no S4E', 'empresas ainda não foram cadastradas no S4E')}.` : '',
      };
    }
    if (report.id === 'comissoes') {
      const summary = data.summary || {};
      const pending = num(summary.companiesPending);
      return {
        tone: pending ? 'attention' : 'ok',
        metric: integer(pending),
        detail: `${money(summary.commission)} em comissão · ${integer(summary.contracts)} contratos`,
        stamp: '',
        severity: pending ? 55 : 0,
        priority: pending ? `${plural(pending, 'empresa está sem vínculo de vendedor', 'empresas estão sem vínculo de vendedor')}.` : '',
      };
    }
    if (report.id === 'adesoes') {
      const pending = num(data.pendentes);
      const total = num(data.total);
      return {
        tone: pending ? 'attention' : total ? 'ok' : 'empty',
        metric: integer(pending),
        detail: `${integer(total)} adesões salvas · atualização automática às 10h e 16h`,
        stamp: data.fontes?.vidas?.em,
        severity: pending ? 75 : 0,
        priority: pending ? `${plural(pending, 'adesão está pendente de conferência', 'adesões estão pendentes de conferência')}.` : '',
      };
    }
    if (report.id === 'apuracao') {
      const run = data.run;
      const unmapped = Array.isArray(data.unmapped) ? data.unmapped.length : 0;
      return {
        tone: data.job?.running ? 'running' : run?.error ? 'error' : unmapped ? 'attention' : run ? 'ok' : 'empty',
        metric: run ? integer(run.totalEmpresas) : '—',
        detail: run ? `${integer(run.pagas)} pagas · ${plural(unmapped, 'grupo sem mapa', 'grupos sem mapa')}` : 'Nenhuma apuração concluída.',
        stamp: run?.finishedAt || run?.startedAt,
        severity: unmapped ? 65 : 0,
        priority: unmapped ? `${plural(unmapped, 'grupo precisa de mapa na apuração', 'grupos precisam de mapa na apuração')}.` : '',
      };
    }
    if (report.id === 'rateio') {
      const alerts = Array.isArray(data.alerts) ? data.alerts.length : 0;
      const items = Array.isArray(data.items) ? data.items : [];
      const allocated = items.reduce((total, item) => total + num(item.totalRateado), 0);
      return {
        tone: alerts ? 'attention' : data.run ? 'ok' : 'empty',
        metric: integer(alerts),
        detail: `${plural(items.length, 'título rateado', 'títulos rateados')} · ${money(allocated)}`,
        stamp: data.run?.finishedAt,
        severity: alerts ? 70 : 0,
        priority: alerts ? `${plural(alerts, 'alerta de rateio precisa de revisão', 'alertas de rateio precisam de revisão')}.` : '',
      };
    }
    if (report.id === 'finance') {
      const summary = data.summary || {};
      return {
        tone: num(summary.rows) ? 'ok' : 'empty',
        metric: integer(summary.rows),
        detail: `${money(summary.nominal)} faturado · ${money(summary.paid)} recebido`,
        stamp: data.imports?.[0]?.createdAt,
        severity: 0,
        priority: '',
      };
    }
    if (report.id === 'vidas') {
      const totals = data.totais || {};
      const unassigned = num(totals.naoAtribuidas);
      return {
        tone: data.job?.running ? 'running' : unassigned ? 'attention' : data.movimentacao?.consultadoEm ? 'ok' : 'empty',
        metric: signed(totals.saldo),
        detail: `${integer(totals.entradas)} entradas · ${integer(totals.saidas)} saídas · ${integer(unassigned)} sem atribuição`,
        stamp: data.movimentacao?.consultadoEm,
        severity: unassigned ? 60 : 0,
        priority: unassigned ? `${plural(unassigned, 'movimento de vida está sem atribuição', 'movimentos de vidas estão sem atribuição')}.` : '',
      };
    }
    if (report.id === 'vendas') {
      const snapshot = data.snapshot;
      const teams = Array.isArray(snapshot?.teams) ? snapshot.teams : [];
      const lives = teams.reduce((total, team) => total + num(team.lives), 0);
      const value = teams.reduce((total, team) => total + num(team.value), 0);
      const cancelled = teams.reduce((total, team) => total + num(team.cancelledLives), 0);
      return {
        tone: data.job?.running ? 'running' : snapshot ? 'ok' : 'empty',
        metric: snapshot ? integer(lives) : '—',
        detail: snapshot ? `${money(value)} em vendas · ${integer(cancelled)} vidas canceladas` : 'O período atual ainda não foi consultado.',
        stamp: snapshot?.checkedAt,
        severity: 0,
        priority: '',
      };
    }
    if (report.id === 'semanal') {
      const companies = Array.isArray(data.empresas) ? data.empresas.length : 0;
      const establishments = Array.isArray(data.estabelecimentos) ? data.estabelecimentos.length : 0;
      const stale = data.empresasDesatualizadas || data.estabelecimentosDesatualizados;
      return {
        tone: data.job?.running ? 'running' : stale ? 'stale' : companies + establishments ? 'ok' : 'empty',
        metric: integer(companies + establishments),
        detail: `${integer(companies)} empresas · ${integer(establishments)} estabelecimentos`,
        stamp: data.empresasConsultadoEm || data.estabelecimentosConsultadoEm,
        severity: stale ? 35 : 0,
        priority: stale ? 'O Relatório Semanal está com dados velhos e pode ser atualizado na tela.' : '',
      };
    }
    return { tone: 'neutral', metric: '—', detail: 'Abra a tela para consultar.', stamp: '', severity: 0 };
  }

  function reportById(id) {
    return REPORTS.find(report => report.id === id);
  }

  function renderHero() {
    const summary = byId('sabiCenterSummary');
    const live = byId('sabiCenterLive');
    if (!summary || !live) return;
    const priorities = REPORTS.map(report => summarize(report, state.data[report.id])).filter(item => item.severity > 0);
    const errors = Object.keys(state.errors).length;
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
    if (state.loading && !state.loaded) summary.textContent = `${greeting}! Estou reunindo os dados salvos do portal para organizar seu dia.`;
    else if (errors && !priorities.length) summary.textContent = `${greeting}! Consegui ler parte do painel, mas algumas fontes ficaram indisponíveis.`;
    else if (priorities.length) summary.textContent = `${greeting}! Encontrei ${plural(priorities.length, 'ponto que merece sua atenção', 'pontos que merecem sua atenção')}. A fila está pronta abaixo.`;
    else summary.textContent = `${greeting}! Não encontrei pendências nos dados que consegui ler. Tudo está organizado abaixo.`;
    const liveText = live.querySelector('span');
    if (state.loading) liveText.textContent = 'Atualizando o painel';
    else if (errors) liveText.textContent = `${plural(errors, 'fonte indisponível', 'fontes indisponíveis')}`;
    else if (state.loadedAt) liveText.textContent = `Lido às ${new Date(state.loadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    else liveText.textContent = 'Aguardando leitura';
    live.classList.toggle('is-warning', errors > 0);
  }

  function renderNotice() {
    const notice = byId('sabiCenterNotice');
    if (!notice) return;
    const errors = Object.entries(state.errors);
    const message = state.actionError || (errors.length
      ? `Não foi possível ler ${errors.map(([id]) => reportById(id)?.title).filter(Boolean).slice(0, 3).join(', ')}${errors.length > 3 ? ' e outras fontes' : ''}. Os demais dados continuam disponíveis.`
      : '');
    notice.classList.toggle('hidden', !message);
    if (message) notice.textContent = message;
  }

  function renderKpis() {
    const box = byId('sabiCenterKpis');
    if (!box) return;
    const tasks = taskMetrics(state.data.tasks);
    const returnsOpen = num(state.data.retornos?.globalOpen);
    const notes = state.data.notas?.resumo || {};
    const items = [
      { label: 'Para hoje', value: state.data.tasks ? integer(tasks.todayCount) : '—', detail: state.data.tasks ? 'demandas na fila de hoje' : 'aguardando leitura', screen: 'tasksScreen', tone: state.data.tasks && tasks.todayCount ? 'running' : 'ok' },
      { label: 'Atrasadas', value: state.data.tasks ? integer(tasks.overdue) : '—', detail: state.data.tasks ? 'precisam de decisão' : 'aguardando leitura', screen: 'tasksScreen', tone: state.data.tasks && tasks.overdue ? 'attention' : 'ok' },
      { label: 'Retornos abertos', value: state.data.retornos ? integer(returnsOpen) : '—', detail: state.data.retornos ? 'incidentes ainda não corrigidos' : 'aguardando leitura', screen: 'retornosScreen', tone: returnsOpen ? 'attention' : 'ok' },
      { label: 'Notas em revisão', value: state.data.notas ? integer(notes.grupos) : '—', detail: state.data.notas ? `${money(notes.valorRisco)} em risco` : 'aguardando leitura', screen: 'notasScreen', tone: num(notes.grupos) ? 'attention' : 'ok' },
    ];
    box.innerHTML = items.map(item => `
      <button class="sabi-center-kpi tone-${item.tone}" type="button" data-open-screen="${item.screen}">
        <span>${esc(item.label)}</span><strong>${esc(item.value)}</strong><small>${esc(item.detail)}</small>
      </button>`).join('');
  }

  function renderPriorities() {
    const box = byId('sabiCenterPriorities');
    const count = byId('sabiCenterPriorityCount');
    if (!box || !count) return;
    const items = REPORTS.map(report => ({ report, summary: summarize(report, state.data[report.id]) }))
      .filter(item => item.summary.severity > 0 && item.summary.priority)
      .sort((a, b) => b.summary.severity - a.summary.severity)
      .slice(0, 6);
    count.textContent = state.loading && !state.loaded ? 'Lendo…' : plural(items.length, 'prioridade', 'prioridades');
    if (!items.length) {
      box.innerHTML = state.loading && !state.loaded
        ? '<div class="sabi-center-loading"><span></span><span></span><span></span><p>Sabi está conferindo as prioridades…</p></div>'
        : '<div class="sabi-center-empty"><strong>Nenhuma pendência encontrada</strong><p>Os dados disponíveis não apontam ações urgentes agora.</p></div>';
      return;
    }
    box.innerHTML = items.map(({ report, summary }, index) => `
      <button class="sabi-center-priority tone-${summary.tone}" type="button" data-open-screen="${report.screen}">
        <span class="sabi-center-priority-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="sabi-center-priority-copy"><strong>${esc(summary.priority)}</strong><small>${esc(report.title)}</small></span>
        <span class="sabi-center-priority-arrow" aria-hidden="true">→</span>
      </button>`).join('');
  }

  function renderReports() {
    const box = byId('sabiCenterReports');
    if (!box) return;
    const term = normalize(state.search);
    const reports = REPORTS.filter(report => {
      const category = state.filter === 'all' || report.category === state.filter;
      const text = normalize(`${report.title} ${report.description} ${CATEGORY_LABELS[report.category]}`);
      return category && (!term || text.includes(term));
    });
    if (!reports.length) {
      box.innerHTML = '<div class="sabi-center-empty"><strong>Nenhum relatório encontrado</strong><p>Tente outro termo ou escolha um assunto diferente.</p></div>';
      return;
    }
    box.innerHTML = reports.map(report => {
      const summary = summarize(report, state.data[report.id]);
      const path = downloadPath(report, state.data[report.id]);
      const downloading = state.downloading === report.id;
      return `
        <article class="sabi-center-report tone-${summary.tone}">
          <div class="sabi-center-report-top"><span class="sabi-center-report-icon">${esc(report.icon)}</span><span class="sabi-center-badge">${esc(TONE_LABELS[summary.tone] || '')}</span></div>
          <div class="sabi-center-report-heading"><h4>${esc(report.title)}</h4><span>${esc(CATEGORY_LABELS[report.category])}</span></div>
          <p>${esc(report.description)}</p>
          <div class="sabi-center-report-metric"><strong>${esc(summary.metric)}</strong><span>${esc(summary.detail)}</span></div>
          <div class="sabi-center-report-stamp">${summary.stamp ? `Última leitura: ${esc(stampLabel(summary.stamp) || 'horário indisponível')}` : 'Sem horário de leitura'}</div>
          <div class="sabi-center-report-actions">
            <button type="button" data-open-screen="${report.screen}">Abrir tela</button>
            ${path ? `<button type="button" class="sabi-center-download" data-download-report="${report.id}" ${downloading ? 'disabled' : ''}>${downloading ? 'Baixando…' : 'Baixar'}</button>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  function renderSchedules() {
    const box = byId('sabiCenterSchedules');
    if (!box) return;
    if (state.errors.schedules) {
      box.innerHTML = '<div class="sabi-center-empty"><strong>Agendamentos indisponíveis</strong><p>Tente atualizar o painel ou peça ao Sabi para verificar.</p></div>';
      return;
    }
    const schedules = Array.isArray(state.data.schedules?.schedules) ? state.data.schedules.schedules : [];
    if (!schedules.length && state.loading && !state.loaded) {
      box.innerHTML = '<div class="sabi-center-loading"><span></span><span></span><span></span><p>Lendo as rotinas automáticas…</p></div>';
      return;
    }
    if (!schedules.length) {
      box.innerHTML = '<div class="sabi-center-empty"><strong>Nenhuma rotina agendada</strong><p>Peça ao Sabi para agendar a exportação de um relatório.</p><button type="button" class="button button-secondary" data-ask-sabi="Quero agendar uma rotina para exportar ">Criar com o Sabi</button></div>';
      return;
    }
    box.innerHTML = schedules.map(schedule => `
      <article class="sabi-center-schedule ${schedule.enabled === false ? 'is-paused' : ''}">
        <span class="sabi-center-schedule-time">${esc(schedule.time || '--:--')}</span>
        <span class="sabi-center-schedule-copy"><strong>${esc(SCHEDULE_LABELS[schedule.kind] || schedule.kind || 'Exportação')}</strong><small>${schedule.enabled === false ? 'Rotina pausada' : 'Exportação automática todos os dias'}</small></span>
        <span class="sabi-center-schedule-state">${schedule.enabled === false ? 'Pausada' : 'Ativa'}</span>
      </article>`).join('');
  }

  function render() {
    renderHero();
    renderNotice();
    renderKpis();
    renderPriorities();
    renderReports();
    renderSchedules();
    const refresh = byId('sabiCenterRefresh');
    if (refresh) {
      refresh.disabled = state.loading;
      refresh.textContent = state.loading ? 'Atualizando…' : 'Atualizar painel';
    }
  }

  function endpoint(id) {
    const range = period();
    const query = new URLSearchParams({ start: range.start, end: range.end });
    const paths = {
      tasks: '/api/state',
      retornos: `/api/retornos?${query}`,
      notas: '/api/notas',
      cobranca: '/api/cobranca?mode=empresas&pageSize=1',
      contratos: '/api/contracts',
      comissoes: '/api/commissions',
      adesoes: '/api/adesoes/status',
      apuracao: '/api/apuracao',
      rateio: '/api/rateios-faturamento',
      finance: '/api/finance/rateios?pageSize=1',
      vidas: `/api/vidas?${query}`,
      vendas: `/api/vendas?${query}`,
      semanal: `/api/semanal?${query}`,
      schedules: '/api/sabi/schedules',
      sabi: '/api/sabi',
    };
    return paths[id] || '';
  }

  async function load() {
    if (!isAdmin() || state.loading || document.body.classList.contains('locked')) return;
    state.loading = true;
    const generation = ++state.generation;
    state.errors = {};
    state.actionError = '';
    render();
    const batches = [
      ['tasks', 'retornos', 'notas', 'contratos'],
      ['cobranca', 'adesoes', 'comissoes', 'vendas'],
      ['vidas', 'semanal', 'apuracao', 'finance'],
      ['rateio', 'schedules', 'sabi'],
    ];
    try {
      for (const batch of batches) {
        const results = await Promise.allSettled(batch.map(id => request(endpoint(id))));
        if (generation !== state.generation) return;
        results.forEach((result, index) => {
          const id = batch[index];
          if (result.status === 'fulfilled') state.data[id] = result.value;
          else state.errors[id] = result.reason?.message || 'Leitura indisponível.';
        });
        if (state.data.sabi?.effective) {
          const portrait = byId('sabiCenterPortrait');
          if (portrait) portrait.src = `assets/sabi/${encodeURIComponent(state.data.sabi.effective)}-stage.jpg?v=20261124a`;
        }
        render();
      }
      state.loaded = true;
      state.loadedAt = new Date().toISOString();
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        render();
      }
    }
  }

  function openScreen(screenId) {
    if (!screenId || !window.PortalAccess?.canSee(screenId)) return;
    window.PortalAccess.openScreen(screenId);
  }

  function openSabi(prompt = '') {
    const fab = byId('sabiFab');
    const panel = byId('sabiPanel');
    const input = byId('sabiInput');
    if (!fab || !panel || !input) return;
    if (panel.hidden) fab.click();
    if (prompt) input.value = prompt;
    setTimeout(() => input.focus(), 80);
  }

  function downloadPath(report, data) {
    const range = period();
    const query = new URLSearchParams({ start: range.start, end: range.end });
    const paths = {
      adesoes: '/api/adesoes/exportar',
      notas: data?.run?.id ? `/api/notas/export?run=${encodeURIComponent(data.run.id)}` : '',
      cobranca: '/api/cobranca/export',
      comissoes: '/api/commissions/export',
      apuracao: data?.run?.id ? `/api/apuracao/planilha?run=${encodeURIComponent(data.run.id)}` : '',
      rateio: '/api/rateios-faturamento/exportar',
      finance: '/api/finance/rateios/export',
      vidas: `/api/vidas/exportar?${query}`,
    };
    return paths[report.id] || '';
  }

  async function download(report) {
    const path = downloadPath(report, state.data[report.id]);
    if (!path || state.downloading) return;
    state.downloading = report.id;
    state.actionError = '';
    render();
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, { headers: window.PortalAccess.authHeaders() });
      if (response.status === 401) {
        clearSession();
        showLogin('Sua sessão terminou. Entre novamente no portal.');
        throw new Error('Sua sessão terminou. Entre novamente no portal.');
      }
      if (response.status === 423) {
        const error = await response.json().catch(() => ({}));
        showSystemLock(error);
        throw new Error('O portal está bloqueado pela administração.');
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || 'Não foi possível baixar este relatório.');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `${report.id}-${localISO()}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      state.actionError = error.message || 'Não foi possível baixar o relatório.';
    } finally {
      state.downloading = '';
      render();
    }
  }

  function bind() {
    byId('sabiCenterRefresh')?.addEventListener('click', load);
    byId('sabiCenterAsk')?.addEventListener('click', event => {
      event.stopPropagation();
      openSabi();
    });
    byId('sabiCenterRoutineAsk')?.addEventListener('click', event => {
      event.stopPropagation();
      openSabi('Quero agendar uma rotina para exportar ');
    });
    byId('sabiCenterSearch')?.addEventListener('input', event => {
      state.search = event.target.value;
      renderReports();
    });
    byId('sabiCenterFilters')?.addEventListener('click', event => {
      const button = event.target.closest('[data-sabi-filter]');
      if (!button) return;
      state.filter = button.dataset.sabiFilter;
      byId('sabiCenterFilters').querySelectorAll('button').forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      renderReports();
    });
    byId('sabiCenterScreen')?.addEventListener('click', event => {
      const ask = event.target.closest('[data-ask-sabi]');
      if (ask) {
        event.stopPropagation();
        openSabi(ask.dataset.askSabi);
        return;
      }
      const downloadButton = event.target.closest('[data-download-report]');
      if (downloadButton) {
        const report = reportById(downloadButton.dataset.downloadReport);
        if (report) void download(report);
        return;
      }
      const open = event.target.closest('[data-open-screen]');
      if (open) openScreen(open.dataset.openScreen);
    });
  }

  window.enterSabiCenterScreen = function () {
    state.active = true;
    const fresh = state.loadedAt && Date.now() - Date.parse(state.loadedAt) < 5 * 60 * 1000;
    if (!fresh) void load();
  };
  window.leaveSabiCenterScreen = function () { state.active = false; };
  window.resetSabiCenter = function () {
    state.active = false;
    state.loading = false;
    state.loaded = false;
    state.generation += 1;
    state.loadedAt = '';
    state.data = {};
    state.errors = {};
    state.actionError = '';
    state.filter = 'all';
    state.search = '';
    state.downloading = '';
    const search = byId('sabiCenterSearch');
    if (search) search.value = '';
    byId('sabiCenterFilters')?.querySelectorAll('[data-sabi-filter]').forEach(button => {
      const active = button.dataset.sabiFilter === 'all';
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();

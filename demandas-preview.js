/* Prévia local da nova tela de demandas — visível apenas para o admin. */
(() => {
  const STORE_KEY = 'portal-tasks-preview-v1';
  const state = { mode: 'list', status: 'all', owner: 'all', priority: 'all', search: '', from: '', to: '', periodOpen: false, checklistOnly: false, month: new Date() };
  let active = false;
  let originalSubtitle = '';
  const expandedGroups = new Set();
  const expandedCards = new Set();
  let dragId = '';
  let justDropped = false;
  const root = document.createElement('div');
  root.id = 'tasksPreview';
  root.className = 'tp';
  root.hidden = true;

  const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const user = () => window.PortalAccess?.Access?.user;
  const isManager = () => { const person = user(); return Boolean(person && (person.role === 'admin' || person.management)); };
  const canUseTasks = () => {
    if (!user()) return false;
    const access = window.PortalAccess;
    return typeof access?.canSee === 'function' ? access.canSee('tasksScreen') : true;
  };
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const pad = value => String(value).padStart(2, '0');
  const priorityName = { urgent: 'Crítica', high: 'Alta', medium: 'Normal', low: 'Baixa' };
  const priorityWeight = { urgent: 0, high: 1, medium: 2, low: 3 };
  const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
  const VALID_STATUSES = ['todo', 'progress', 'done'];
  const VALID_RECURRENCES = ['none', 'daily', 'weekly', 'fortnightly', 'monthly'];
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function isoAdd(iso, days) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function shortDate(iso) {
    if (!iso) return '—';
    const parts = String(iso).split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}` : '—';
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
  }
  function period(task) {
    return typeof taskPeriod === 'function'
      ? taskPeriod(task)
      : { start: task.periodStart || task.due || '', end: task.periodEnd || task.due || '' };
  }
  function scoped() {
    return typeof scopedTasks === 'function' ? scopedTasks() : [];
  }
  function statusOf(task) {
    return typeof normalizedStatus === 'function' ? normalizedStatus(task) : (task.status || 'todo');
  }
  function categoryOf(task) {
    if (typeof categoryLabel === 'function') return categoryLabel(task.category);
    return task.category || 'Sem categoria';
  }
  function mediaHref(item) {
    if (!item) return '';
    const path = item.media || item.data || '';
    return typeof taskMediaUrl === 'function' ? taskMediaUrl(path) : path;
  }
  function sizeLabel(item) {
    if (!item) return '';
    return typeof attachmentSizeLabel === 'function' ? attachmentSizeLabel(item) : String(item.size || '');
  }
  function openCount() {
    return scoped().filter(task => statusOf(task) !== 'done').length;
  }
  function dateLine() {
    const text = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${text.charAt(0).toUpperCase()}${text.slice(1)} · ${openCount()} demandas ativas`;
  }

  function ownerOptions() {
    return [...new Set(scoped().map(task => task.owner).filter(name => name && !window.isHiddenTaskOwner?.(name)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function filtered(includeDone) {
    const query = state.search.trim().toLowerCase();
    return scoped().filter(task => {
      const status = statusOf(task);
      if (!includeDone && state.status !== 'done' && status === 'done') return false;
      if (state.status === 'done' && status !== 'done') return false;
      if (state.status !== 'all' && state.status !== 'done' && status !== state.status) return false;
      if (state.owner !== 'all' && task.owner !== state.owner) return false;
      if (state.priority !== 'all' && (task.priority || 'medium') !== state.priority) return false;
      if (state.checklistOnly && !(task.checklist || []).length) return false;
      if (query && !`${task.title || ''} ${task.notes || ''} ${task.owner || ''}`.toLowerCase().includes(query)) return false;
      const range = period(task);
      if (state.from && range.end && range.end < state.from) return false;
      if (state.to && range.start && range.start > state.to) return false;
      return true;
    }).sort((a, b) => {
      const endA = period(a).end || '9999-12-31';
      const endB = period(b).end || '9999-12-31';
      return endA.localeCompare(endB)
        || String(a.dueTime || '99:99').localeCompare(String(b.dueTime || '99:99'))
        || (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2);
    });
  }

  function timeSuffix(task) {
    return /^\d{2}:\d{2}$/.test(String(task.dueTime || '')) ? ` · ${task.dueTime}` : '';
  }
  function dueInfo(task) {
    const range = period(task);
    const current = todayIso();
    const time = timeSuffix(task);
    if (!range.end) return { text: 'Sem prazo', cls: '' };
    if (range.end < current && statusOf(task) !== 'done') return { text: `Atrasada · ${shortDate(range.end)}${time}`, cls: 'is-overdue' };
    if ((!range.start || range.start <= current) && range.end >= current) return { text: `Hoje · ${shortDate(range.end)}${time}`, cls: 'is-today' };
    if (range.start && range.start !== range.end) return { text: `${shortDate(range.start)} a ${shortDate(range.end)}${time}`, cls: '' };
    return { text: `${shortDate(range.end)}${time}`, cls: '' };
  }

  function kpiHtml() {
    const all = scoped();
    const current = todayIso();
    const open = all.filter(task => statusOf(task) !== 'done');
    const todayTasks = open.filter(task => {
      const range = period(task);
      return range.start && range.start <= current && range.end >= current;
    });
    const overdue = open.filter(task => period(task).end && period(task).end < current);
    const progress = open.filter(task => statusOf(task) === 'progress');
    const checklist = open.filter(task => (task.checklist || []).length);
    const done = all.filter(task => statusOf(task) === 'done');
    const icon = {
      today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
      alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 21 19H3z"/><path d="M12 9v4M12 16.5v.5"/></svg>',
      progress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
      checklist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6h10M10 12h10M10 18h10"/><path d="m3 6 1.6 1.6L7.2 5"/><path d="m3 12 1.6 1.6L7.2 11"/><path d="m3 18 1.6 1.6L7.2 17"/></svg>',
      done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.5"/></svg>',
    };
    const card = (label, value, kind, alert, options = {}) => `<article class="tp-kpi${alert ? ' is-alert' : ''}${options.active ? ' is-selected' : ''}"${options.kpi ? ` data-tp-kpi="${options.kpi}" role="button" tabindex="0" aria-pressed="${options.active ? 'true' : 'false'}" title="${esc(options.title || '')}"` : ''}><span class="tp-kpi-icon">${icon[kind]}</span><span class="tp-kpi-label">${esc(label)}</span><strong>${value}</strong><small>demandas</small></article>`;
    return `<section class="tp-kpis" aria-label="Resumo">
      ${card('Para hoje', todayTasks.length, 'today', false)}
      ${card('Atrasadas', overdue.length, 'alert', true)}
      ${card('Em andamento', progress.length, 'progress', false)}
      ${card('Com checklist', checklist.length, 'checklist', false, { kpi: 'checklist', active: state.checklistOnly, title: 'Mostrar somente demandas com checklist' })}
      ${card('Concluídas', done.length, 'done', false)}
    </section>`;
  }

  function badgeHtml(task) {
    const due = dueInfo(task);
    const status = statusOf(task);
    const list = task.checklist || [];
    const checked = list.filter(item => item.done).length;
    const expanded = expandedCards.has(task.id);
    const next = status === 'progress' ? 'todo' : 'progress';
    const action = status === 'done' ? '' : `<button type="button" class="tp-start${status === 'progress' ? ' is-on' : ''}" data-tp-status="${esc(task.id)}" data-tp-next="${next}" title="${status === 'progress' ? 'Voltar para pendente' : 'Marcar como em andamento'}">${status === 'progress' ? 'Pausar' : 'Iniciar'}</button>`;
    return `<span class="tp-badge cat">${esc(categoryOf(task))}</span>
      <span class="tp-badge prio-${esc(task.priority || 'medium')}">${priorityName[task.priority] || 'Normal'}</span>
      <span class="tp-due ${due.cls}">${esc(due.text)}</span>
      ${status === 'progress' ? '<span class="tp-badge st-progress">Em andamento</span>' : ''}
      ${action}
      ${list.length ? `<button type="button" class="tp-extra${expanded ? ' is-open' : ''}" data-tp-expand="${esc(task.id)}">Checklist ${checked}/${list.length}</button>` : ''}
      ${task.attachments?.length ? `<button type="button" class="tp-extra${expanded ? ' is-open' : ''}" data-tp-expand="${esc(task.id)}">Anexos ${task.attachments.length}</button>` : ''}`;
  }

  function taskDetailHtml(task) {
    const list = task.checklist || [];
    const attachments = task.attachments || [];
    if (!expandedCards.has(task.id)) return '';
    const checklistHtml = list.length
      ? `<div class="tp-checklist">${list.map((item, index) => `<div class="tp-cl-item${item.done ? ' is-done' : ''}"><label><input type="checkbox" data-tp-check="${esc(task.id)}" data-tp-check-index="${index}"${item.done ? ' checked' : ''}><span>${esc(item.text)}</span></label><button type="button" class="tp-cl-remove" data-tp-check-remove="${esc(task.id)}" data-tp-check-index="${index}" aria-label="Remover etapa">×</button></div>`).join('')}<button type="button" class="tp-cl-add" data-tp-check-add="${esc(task.id)}">+ Adicionar etapa</button></div>`
      : `<div class="tp-checklist"><p class="tp-cl-empty">Sem etapas ainda.</p><button type="button" class="tp-cl-add" data-tp-check-add="${esc(task.id)}">+ Adicionar etapa</button></div>`;
    const attachmentsHtml = attachments.length
      ? `<div class="tp-attachments">${attachments.map(item => `<a class="tp-attach" href="${esc(mediaHref(item))}" target="_blank" rel="noopener" download="${esc(item.name)}"><span>📎 ${esc(item.name)}</span><small>${esc(sizeLabel(item))}</small></a>`).join('')}</div>`
      : '';
    return `<div class="tp-task-detail">${attachmentsHtml}${checklistHtml}</div>`;
  }

  function taskCard(task) {
    const done = statusOf(task) === 'done';
    const due = dueInfo(task);
    const cls = `tp-task prio-${esc(task.priority || 'medium')}${done ? ' is-done' : ''}${due.cls === 'is-overdue' ? ' is-overdue' : ''}`;
    return `<article class="${cls}" data-tp-id="${esc(task.id)}">
      <button type="button" class="tp-check" data-tp-toggle="${esc(task.id)}" aria-label="${done ? 'Reabrir demanda' : 'Concluir demanda'}"></button>
      <div class="tp-task-main">
        <div class="tp-task-title">${esc(task.title || 'Sem título')}</div>
        ${task.notes ? `<div class="tp-task-notes">${esc(task.notes)}</div>` : ''}
        <div class="tp-meta">${badgeHtml(task)}</div>
        ${taskDetailHtml(task)}
      </div>
      <div class="tp-task-side">
        <span class="tp-person"><span class="tp-avatar">${esc(initials(task.owner))}</span>${esc(task.owner || 'Sem responsável')}</span>
        <div class="tp-task-actions">
          <button type="button" class="tp-edit" data-tp-edit="${esc(task.id)}">Editar</button>
          <button type="button" class="tp-del" data-tp-delete="${esc(task.id)}" title="Excluir demanda" aria-label="Excluir demanda"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>
        </div>
      </div>
    </article>`;
  }

  function groupHtml(key, title, tasks) {
    if (!tasks.length) return '';
    const limit = 12;
    const expanded = expandedGroups.has(key);
    const visible = expanded ? tasks : tasks.slice(0, limit);
    const more = tasks.length > limit
      ? `<button type="button" class="tp-more" data-tp-more="${key}">${expanded ? 'Mostrar menos' : `Ver mais ${tasks.length - limit}`}</button>`
      : '';
    return `<section class="tp-group"><h3 class="tp-group-title">${title} · ${tasks.length}</h3>
      <div class="tp-list">${visible.map(taskCard).join('')}</div>${more}</section>`;
  }

  function listHtml() {
    const tasks = filtered(false);
    if (state.status === 'done') {
      return tasks.length
        ? groupHtml('done', 'Concluídas', tasks)
        : '<div class="tp-empty">Nenhuma demanda concluída com os filtros atuais.</div>';
    }
    const current = todayIso();
    const weekLimit = isoAdd(current, 7);
    const groups = { today: [], week: [], later: [], none: [] };
    tasks.forEach(task => {
      const range = period(task);
      if (!range.end) { groups.none.push(task); return; }
      if (range.end < current || (!range.start ? range.end >= current : range.start <= current)) { groups.today.push(task); return; }
      if (range.end <= weekLimit) { groups.week.push(task); return; }
      groups.later.push(task);
    });
    const html = groupHtml('today', 'Hoje', groups.today) + groupHtml('week', 'Esta semana', groups.week) + groupHtml('later', 'Mais adiante', groups.later) + groupHtml('none', 'Sem prazo', groups.none);
    return html || `<div class="tp-empty">${state.checklistOnly ? 'Nenhuma demanda em aberto com checklist.' : 'Nada por aqui com os filtros atuais.'}</div>`;
  }

  function boardHtml() {
    const tasks = filtered(true);
    const columns = [
      { key: 'todo', label: 'Pendentes' },
      { key: 'progress', label: 'Em andamento' },
      { key: 'done', label: 'Concluídas' },
    ];
    return `<p class="tp-board-hint">Arraste os cartões entre as colunas para mudar o status.</p><div class="tp-board">${columns.map(column => {
      let items = tasks.filter(task => statusOf(task) === column.key);
      if (column.key === 'done' && state.status !== 'done') {
        const cutoff = isoAdd(todayIso(), -30);
        items = items
          .filter(task => String(task.completedAt || task.updatedAt || '').slice(0, 10) >= cutoff)
          .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')))
          .slice(0, 30);
      }
      return `<section class="tp-col" data-tp-column="${column.key}"><div class="tp-col-head"><strong>${column.label}</strong><span>${items.length}</span></div>
        <div class="tp-board-list">${items.map(task => {
          const due = dueInfo(task);
          return `<article class="tp-board-card prio-${esc(task.priority || 'medium')}${statusOf(task) === 'done' ? ' is-done' : ''}" draggable="true" data-tp-task="${esc(task.id)}" data-tp-edit="${esc(task.id)}">
            <button type="button" class="tp-board-del" data-tp-delete="${esc(task.id)}" title="Excluir demanda" aria-label="Excluir demanda">×</button>
            <strong>${esc(task.title || 'Sem título')}</strong>
            <div class="tp-board-meta"><span class="tp-avatar">${esc(initials(task.owner))}</span><span>${esc(task.owner || 'Sem responsável')}</span><span class="${due.cls === 'is-overdue' ? 'tp-due is-overdue' : 'tp-due'}">${esc(due.text)}</span></div>
          </article>`;
        }).join('') || '<p class="tp-rail-empty">Nenhuma demanda.</p>'}</div></section>`;
    }).join('')}</div>`;
  }

  function calendarHtml() {
    const tasks = filtered(true);
    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const cells = Math.ceil((offset + days) / 7) * 7;
    const current = todayIso();
    const monthLabel = state.month.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(' de ', ' ').replace(/^./, char => char.toUpperCase());
    let grid = '';
    for (let index = 0; index < cells; index += 1) {
      const day = index - offset + 1;
      if (day < 1 || day > days) { grid += '<div class="tp-cal-day is-out"></div>'; continue; }
      const iso = `${year}-${pad(month + 1)}-${pad(day)}`;
      const dayTasks = tasks.filter(task => {
        const range = period(task);
        return range.start && range.end && range.start <= iso && range.end >= iso;
      }).sort((a, b) => (priorityWeight[a.priority] ?? 2) - (priorityWeight[b.priority] ?? 2));
      const chips = dayTasks.slice(0, 2).map(task => `<button type="button" class="tp-chip prio-${esc(task.priority || 'medium')}${statusOf(task) === 'done' ? ' is-done' : ''}" data-tp-day="${iso}" title="${esc(`${task.dueTime ? `${task.dueTime} · ` : ''}${task.title || ''}`)}">${esc(`${task.dueTime ? `${task.dueTime} ` : ''}${task.title || 'Sem título'}`)}</button>`).join('');
      grid += `<div class="tp-cal-day${iso === current ? ' is-today' : ''}" data-tp-day="${iso}"><span class="tp-cal-num">${day}</span>${chips}${dayTasks.length > 2 ? `<span class="tp-cal-more">+${dayTasks.length - 2}</span>` : ''}</div>`;
    }
    return `<section class="tp-calendar">
      <div class="tp-cal-head"><h3>${esc(monthLabel)}</h3><div class="tp-cal-controls">
        <button type="button" data-tp-cal="prev" aria-label="Mês anterior">‹</button>
        <button type="button" data-tp-cal="today">Hoje</button>
        <button type="button" data-tp-cal="next" aria-label="Próximo mês">›</button>
      </div></div>
      <div class="tp-cal-week"><span>Seg</span><span>Ter</span><span>Qua</span><span>Qui</span><span>Sex</span><span>Sáb</span><span>Dom</span></div>
      <div class="tp-cal-grid">${grid}</div>
    </section>`;
  }

  function railHtml() {
    const all = scoped();
    const current = todayIso();
    const todays = all.filter(task => {
      const range = period(task);
      return range.start && range.start <= current && range.end >= current;
    });
    const doneToday = todays.filter(task => statusOf(task) === 'done').length;
    const percent = todays.length ? Math.round((doneToday / todays.length) * 100) : 0;
    const open = all.filter(task => statusOf(task) !== 'done');
    const load = new Map();
    open.forEach(task => {
      if (window.isHiddenTaskOwner?.(task.owner)) return;
      const key = task.owner || 'Sem responsável';
      load.set(key, (load.get(key) || 0) + 1);
    });
    const loadRows = [...load.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const maxLoad = Math.max(1, ...loadRows.map(row => row[1]));
    const deadlines = open
      .filter(task => period(task).end && period(task).end >= current)
      .sort((a, b) => period(a).end.localeCompare(period(b).end) || String(a.dueTime || '99:99').localeCompare(String(b.dueTime || '99:99')))
      .slice(0, 3);
    return `<article class="tp-card">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>Resumo do dia</h3>
        <div class="tp-donut" style="--pct:${percent}"><strong>${percent}%</strong></div>
        <p class="tp-summary-caption">${todays.length ? `${doneToday} de ${todays.length} concluídas` : 'Sem demandas para hoje'}</p>
      </article>
      <article class="tp-card">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6S13.9 16 14.5 19"/><path d="M16 5.5a3 3 0 0 1 0 5.6M17.5 14.6c2 .6 3.2 2.1 3.6 4.4"/></svg>Carga da equipe</h3>
        ${loadRows.length ? loadRows.map(([name, count]) => `<div class="tp-team-row"><span class="tp-avatar">${esc(initials(name))}</span><span class="tp-team-name">${esc(name)}</span><span class="tp-team-bar"><i style="width:${Math.round((count / maxLoad) * 100)}%"></i></span><span class="tp-team-pct">${Math.round((count / maxLoad) * 100)}%</span></div>`).join('') : '<p class="tp-rail-empty">Nenhuma demanda em aberto.</p>'}
      </article>
      <article class="tp-card">
        <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Próximos prazos</h3>
        ${deadlines.length ? deadlines.map(task => {
          const range = period(task);
          return `<button type="button" class="tp-deadline" data-tp-edit="${esc(task.id)}"><strong>${shortDate(range.end)}${task.dueTime ? ` · ${esc(task.dueTime)}` : ''}</strong><span>${esc(categoryOf(task))}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg></button>`;
        }).join('') : '<p class="tp-rail-empty">Nenhum prazo em aberto.</p>'}
      </article>`;
  }

  function bodyHtml() {
    const main = state.mode === 'board' ? boardHtml() : state.mode === 'calendar' ? calendarHtml() : listHtml();
    return `<div class="tp-main">${main}</div><aside class="tp-rail" aria-label="Resumo e prazos">${railHtml()}</aside>`;
  }

  function periodText() {
    if (state.from && state.to) return `${shortDate(state.from)} – ${shortDate(state.to)}`;
    if (state.from) return `A partir de ${shortDate(state.from)}`;
    if (state.to) return `Até ${shortDate(state.to)}`;
    return 'Período';
  }

  function headerHtml() {
    const owners = ownerOptions();
    if (state.owner !== 'all' && !owners.includes(state.owner)) state.owner = 'all';
    const statusOptions = [['all', 'Status'], ['todo', 'Pendentes'], ['progress', 'Em andamento'], ['done', 'Concluídas']];
    const priorityOptions = [['all', 'Prioridade'], ['urgent', 'Crítica'], ['high', 'Alta'], ['medium', 'Normal'], ['low', 'Baixa']];
    const option = ([value, label], selected) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
    const periodOn = Boolean(state.from || state.to);
    return `<div class="tp-top">
      <div class="tp-switch" role="tablist" aria-label="Forma de visualizar as demandas">
        <button type="button" data-tp-mode="list" class="${state.mode === 'list' ? 'active' : ''}">Lista</button>
        <button type="button" data-tp-mode="board" class="${state.mode === 'board' ? 'active' : ''}">Quadro</button>
        <button type="button" data-tp-mode="calendar" class="${state.mode === 'calendar' ? 'active' : ''}">Calendário</button>
      </div>
      <div class="tp-filters">
        ${state.checklistOnly ? '<button type="button" class="tp-filter-chip" data-tp-checklist-clear title="Remover filtro de checklist">Com checklist ×</button>' : ''}
        <label class="tp-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg><input id="tpSearch" type="search" placeholder="Buscar demanda..." value="${esc(state.search)}" aria-label="Buscar demanda"></label>
        <select data-tp-filter="status" aria-label="Filtrar por status">${statusOptions.map(item => option(item, state.status)).join('')}</select>
        <select data-tp-filter="owner" aria-label="Filtrar por responsável"><option value="all"${state.owner === 'all' ? ' selected' : ''}>Responsável</option>${owners.map(name => `<option value="${esc(name)}"${name === state.owner ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <select data-tp-filter="priority" aria-label="Filtrar por prioridade">${priorityOptions.map(item => option(item, state.priority)).join('')}</select>
        <div class="tp-period-wrap${state.periodOpen ? ' is-open' : ''}">
          <button type="button" class="tp-period${periodOn ? ' is-on' : ''}" data-tp-period aria-expanded="${state.periodOpen}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
            <span class="tp-period-label">${esc(periodText())}</span>
          </button>
          <div class="tp-period-pop" role="dialog" aria-label="Filtrar por período">
            <label>De<input type="date" data-tp-period-from value="${esc(state.from)}"></label>
            <label>Até<input type="date" data-tp-period-to value="${esc(state.to)}"></label>
            <button type="button" class="tp-period-clear" data-tp-period-clear>Limpar período</button>
          </div>
        </div>
        <button type="button" class="tp-audit" data-tp-audit title="Verificar inconsistências nas demandas"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.3 3 8 7.5 9.5 4.5-1.5 7.5-5.2 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/></svg>Verificar</button>
        <button type="button" class="tp-old" data-tp-old title="Usar a visualização antiga">Tela antiga</button>
      </div>
    </div>`;
  }

  function paintBody() {
    const body = root.querySelector('.tp-body');
    if (body) body.innerHTML = bodyHtml();
  }

  function paint() {
    if (!active) return;
    if (!canUseTasks()) { deactivate(); return; }
    root.innerHTML = kpiHtml() + headerHtml() + `<div class="tp-body">${bodyHtml()}</div>`;
  }

  function findTask(id) {
    return scoped().find(task => task.id === id) || (typeof tasks !== 'undefined' ? tasks.find(task => task.id === id) : null);
  }

  function commit() {
    if (typeof save === 'function') save();
    if (typeof render === 'function') render();
    else paint();
  }

  function auditTasks() {
    const issues = [];
    const push = (severity, title, detail, fixable) => issues.push({ severity, title, detail, fix: Boolean(fixable) });
    const all = scoped();
    const seen = new Set();
    const duplicated = new Set();
    const signature = new Set();
    all.forEach(task => {
      if (!task || !task.id) {
        push('error', 'Demanda sem identificador', 'Um registro está sem id e pode não sincronizar corretamente.', false);
        return;
      }
      if (seen.has(task.id)) duplicated.add(task.id);
      seen.add(task.id);
    });
    all.forEach(task => {
      if (!task || !task.id) return;
      const label = `“${String(task.title || 'Sem título').slice(0, 56)}”`;
      const start = task.periodStart || task.due || '';
      const end = task.periodEnd || task.due || '';
      const status = statusOf(task);
      if (!String(task.title || '').trim()) push('error', `${label}: sem título`, 'A demanda precisa de um título para aparecer no quadro.', false);
      else if (String(task.title).length > 120) push('warning', `${label}: título muito longo`, 'Acima de 120 caracteres o título pode ser cortado.', false);
      if (duplicated.has(task.id)) push('error', `${label}: identificador duplicado`, 'Existem dois registros com o mesmo id. A cópia extra pode ser removida.', true);
      if (!task.owner) push('error', `${label}: sem responsável`, 'Defina um responsável para a demanda aparecer na carga da equipe.', false);
      if (!task.sectorId) push('error', `${label}: sem setor`, 'Sem setor a demanda pode não aparecer para o time correto.', false);
      if (!start || !end) push('error', `${label}: período incompleto`, 'Informe data inicial e final para o prazo funcionar.', true);
      else {
        if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) push('error', `${label}: datas inválidas`, 'As datas precisam estar no formato correto (AAAA-MM-DD).', false);
        if (start > end) push('warning', `${label}: data final antes da inicial`, 'As datas serão invertidas para corrigir o período.', true);
      }
      if (!VALID_STATUSES.includes(status)) push('warning', `${label}: status desconhecido`, `O status “${task.status || 'vazio'}” não é reconhecido e será normalizado.`, true);
      if (!VALID_PRIORITIES.includes(task.priority || 'medium')) push('warning', `${label}: prioridade desconhecida`, 'A prioridade será ajustada para Normal.', true);
      if (!VALID_RECURRENCES.includes(task.recurrence || 'none')) push('warning', `${label}: frequência desconhecida`, 'A frequência será ajustada para “uma vez”.', true);
      if (status === 'done' && !task.completedAt) push('warning', `${label}: concluída sem data de conclusão`, 'A data de conclusão será registrada agora.', true);
      if (status !== 'done' && task.completedAt) push('warning', `${label}: data de conclusão em demanda aberta`, 'A data de conclusão será removida.', true);
      if (task.completedAt && String(task.completedAt) > new Date().toISOString()) push('warning', `${label}: conclusão no futuro`, 'A data de conclusão está adiantada e será corrigida.', true);
      if (!task.createdAt) push('info', `${label}: sem data de criação`, 'A data de criação será preenchida com o momento atual.', true);
      if (task.checklist !== undefined && !Array.isArray(task.checklist)) push('warning', `${label}: checklist inválido`, 'O checklist será recriado vazio.', true);
      if (Array.isArray(task.checklist)) {
        task.checklist.forEach((item, index) => {
          if (!item || !String(item.text || '').trim()) push('warning', `${label}: etapa ${index + 1} vazia`, 'Etapas sem texto serão removidas.', true);
        });
      }
      if (task.attachments !== undefined && !Array.isArray(task.attachments)) push('warning', `${label}: lista de anexos inválida`, 'A lista de anexos será recriada.', true);
      if (Array.isArray(task.attachments)) {
        task.attachments.forEach(item => {
          if (!item || !(item.media || item.data) || !item.name) push('warning', `${label}: anexo incompleto`, 'Anexos sem arquivo ou nome serão removidos.', true);
        });
      }
      if (String(task.notes || '').length > 300) push('info', `${label}: observação muito longa`, 'Acima de 300 caracteres a observação pode ser cortada no formulário.', false);
      if (status !== 'done' && end && ISO_DATE.test(end) && end < todayIso()) push('info', `${label}: prazo vencido`, 'A demanda segue aberta depois da data final.', false);
      const key = `${String(task.title || '').trim().toLowerCase()}|${task.owner || ''}|${start}|${end}`;
      if (task.title && signature.has(key)) push('info', `${label}: possível duplicata`, 'Existe outra demanda com o mesmo título, responsável e período.', false);
      signature.add(key);
    });
    return issues;
  }

  function autoFixTasks() {
    if (typeof tasks === 'undefined' || !Array.isArray(tasks)) return 0;
    let fixes = 0;
    const seen = new Set();
    tasks = tasks.filter(task => {
      if (!task || !task.id) return true;
      if (seen.has(task.id)) { fixes += 1; return false; }
      seen.add(task.id);
      return true;
    });
    tasks.forEach(task => {
      if (!task || typeof task !== 'object' || !task.id) return;
      if (typeof task.title === 'string' && task.title !== task.title.trim()) { task.title = task.title.trim(); fixes += 1; }
      if (task.checklist !== undefined && !Array.isArray(task.checklist)) { task.checklist = []; fixes += 1; }
      if (Array.isArray(task.checklist)) {
        const cleaned = task.checklist.filter(item => item && String(item.text || '').trim()).map(item => ({ ...item, done: Boolean(item.done), text: String(item.text).trim() }));
        if (cleaned.length !== task.checklist.length) { task.checklist = cleaned; fixes += 1; }
      }
      if (task.attachments !== undefined && !Array.isArray(task.attachments)) { task.attachments = []; fixes += 1; }
      if (Array.isArray(task.attachments)) {
        const cleaned = task.attachments.filter(item => item && (item.media || item.data) && item.name);
        if (cleaned.length !== task.attachments.length) { task.attachments = cleaned; fixes += 1; }
      }
      if (!VALID_PRIORITIES.includes(task.priority || 'medium')) { task.priority = 'medium'; fixes += 1; }
      if (!VALID_RECURRENCES.includes(task.recurrence || 'none')) { task.recurrence = 'none'; fixes += 1; }
      const status = normalizedStatus(task);
      if (task.status !== status) { task.status = status; fixes += 1; }
      if (task.status === 'done' && (!task.completedAt || String(task.completedAt) > new Date().toISOString())) {
        task.completedAt = new Date().toISOString(); fixes += 1;
      }
      if (task.status !== 'done' && task.completedAt) { delete task.completedAt; fixes += 1; }
      if (!task.periodStart && task.due) { task.periodStart = task.due; fixes += 1; }
      if (!task.periodEnd && task.due) { task.periodEnd = task.due; fixes += 1; }
      if (!task.due && task.periodEnd) { task.due = task.periodEnd; fixes += 1; }
      if (task.periodStart && task.periodEnd && ISO_DATE.test(task.periodStart) && ISO_DATE.test(task.periodEnd) && task.periodStart > task.periodEnd) {
        const swap = task.periodStart;
        task.periodStart = task.periodEnd;
        task.periodEnd = swap;
        task.due = task.periodEnd;
        fixes += 1;
      }
      if (!task.createdAt) { task.createdAt = new Date().toISOString(); fixes += 1; }
    });
    if (fixes) {
      if (typeof save === 'function') save();
      paint();
    }
    return fixes;
  }

  function renderAudit(issues) {
    const summary = document.getElementById('tasksAuditSummary');
    const list = document.getElementById('tasksAuditList');
    const fixButton = document.getElementById('tasksAuditFix');
    const counts = { error: 0, warning: 0, info: 0 };
    issues.forEach(issue => { counts[issue.severity] += 1; });
    if (summary) {
      summary.innerHTML = issues.length
        ? `Encontramos <strong>${issues.length}</strong> ponto(s) em ${scoped().length} demandas: <span class="audit-count is-error">${counts.error} erro(s)</span>, <span class="audit-count is-warning">${counts.warning} alerta(s)</span> e <span class="audit-count is-info">${counts.info} observação(ões)</span>.`
        : `<strong>Tudo certo!</strong> Nenhuma inconsistência encontrada nas ${scoped().length} demandas.`;
    }
    if (fixButton) {
      const fixable = isManager() ? issues.filter(issue => issue.fix).length : 0;
      fixButton.classList.toggle('hidden', fixable === 0);
      fixButton.textContent = fixable ? `Corrigir ${fixable} ponto(s) automaticamente` : 'Corrigir automaticamente';
    }
    if (list) {
      list.innerHTML = issues.length
        ? issues.map(issue => `<div class="audit-issue is-${issue.severity}"><span class="audit-dot"></span><div><strong>${esc(issue.title)}</strong><small>${esc(issue.detail)}</small></div>${issue.fix ? '<span class="audit-fix-tag">Corrigível</span>' : ''}</div>`).join('')
        : '<div class="audit-ok"><span aria-hidden="true">✓</span> Nenhum problema encontrado.</div>';
    }
  }

  function openAudit() {
    const dialog = document.getElementById('tasksAuditDialog');
    if (!dialog) return;
    renderAudit(auditTasks());
    if (!dialog.open) dialog.showModal();
  }

  function setSubtitle(activePreview) {
    const subtitle = document.querySelector('.topbar .subtitle');
    if (!subtitle) return;
    if (activePreview) {
      if (!originalSubtitle) originalSubtitle = subtitle.textContent;
      subtitle.textContent = dateLine();
    } else if (originalSubtitle) {
      subtitle.textContent = originalSubtitle;
    }
  }

  function activate() {
    if (!canUseTasks()) return;
    const screen = document.getElementById('tasksScreen');
    if (!screen) return;
    if (!root.isConnected) screen.prepend(root);
    root.hidden = false;
    screen.classList.add('tp-on');
    active = true;
    setSubtitle(true);
    paint();
  }

  function deactivate() {
    active = false;
    root.hidden = true;
    document.getElementById('tasksScreen')?.classList.remove('tp-on');
    setSubtitle(false);
  }

  function setPreview(enabled) {
    localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off');
    if (enabled) activate();
    else deactivate();
  }

  root.addEventListener('keydown', event => {
    const kpi = event.target.closest?.('[data-tp-kpi]');
    if (!kpi || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    kpi.click();
  });

  root.addEventListener('click', event => {
    if (justDropped && event.target.closest?.('.tp-board-card')) { event.preventDefault(); return; }
    const mode = event.target.closest('[data-tp-mode]');
    if (mode) {
      state.mode = mode.dataset.tpMode;
      root.querySelectorAll('[data-tp-mode]').forEach(button => button.classList.toggle('active', button === mode));
      paintBody();
      return;
    }
    if (event.target.closest('[data-tp-old]')) { setPreview(false); return; }
    if (event.target.closest('[data-tp-audit]')) { openAudit(); return; }

    const kpi = event.target.closest('[data-tp-kpi]');
    if (kpi) {
      state.checklistOnly = !state.checklistOnly;
      if (state.checklistOnly) state.status = 'all';
      expandedGroups.clear();
      paint();
      return;
    }
    if (event.target.closest('[data-tp-checklist-clear]')) {
      state.checklistOnly = false;
      expandedGroups.clear();
      paint();
      return;
    }

    const periodButton = event.target.closest('[data-tp-period]');
    if (periodButton) {
      state.periodOpen = !state.periodOpen;
      periodButton.closest('.tp-period-wrap')?.classList.toggle('is-open', state.periodOpen);
      periodButton.setAttribute('aria-expanded', String(state.periodOpen));
      return;
    }
    if (event.target.closest('[data-tp-period-clear]')) {
      state.from = '';
      state.to = '';
      state.periodOpen = false;
      expandedGroups.clear();
      paint();
      return;
    }

    const more = event.target.closest('[data-tp-more]');
    if (more) {
      const key = more.dataset.tpMore;
      if (expandedGroups.has(key)) expandedGroups.delete(key);
      else expandedGroups.add(key);
      paintBody();
      return;
    }

    const status = event.target.closest('[data-tp-status]');
    if (status) {
      const task = findTask(status.dataset.tpStatus);
      if (task) {
        task.status = status.dataset.tpNext === 'progress' ? 'progress' : 'todo';
        if (task.status !== 'done') delete task.completedAt;
        if (typeof touchTask === 'function') touchTask(task);
        commit();
      }
      return;
    }

    const toggle = event.target.closest('[data-tp-toggle]');
    if (toggle) {
      const task = findTask(toggle.dataset.tpToggle);
      if (task) { completeTask(task); commit(); }
      return;
    }

    const expand = event.target.closest('[data-tp-expand]');
    if (expand) {
      const id = expand.dataset.tpExpand;
      if (expandedCards.has(id)) expandedCards.delete(id);
      else expandedCards.add(id);
      paintBody();
      return;
    }

    const addCheck = event.target.closest('[data-tp-check-add]');
    if (addCheck) {
      const task = findTask(addCheck.dataset.tpCheckAdd);
      const text = task ? prompt('Nova etapa do checklist:') : null;
      if (task && text?.trim()) {
        task.checklist = task.checklist || [];
        task.checklist.push({ id: typeof newId === 'function' ? newId() : `${Date.now()}`, text: text.trim(), done: false });
        if (typeof touchTask === 'function') touchTask(task);
        expandedCards.add(task.id);
        commit();
      }
      return;
    }

    const removeCheck = event.target.closest('[data-tp-check-remove]');
    if (removeCheck) {
      const task = findTask(removeCheck.dataset.tpCheckRemove);
      const index = Number(removeCheck.dataset.tpCheckIndex);
      if (task?.checklist && Number.isInteger(index)) {
        task.checklist.splice(index, 1);
        if (typeof touchTask === 'function') touchTask(task);
        commit();
      }
      return;
    }

    const remove = event.target.closest('[data-tp-delete]');
    if (remove) {
      event.preventDefault();
      event.stopPropagation();
      const task = findTask(remove.dataset.tpDelete);
      if (!task) return;
      if (!confirm(`Excluir a demanda "${task.title || 'Sem título'}"?`)) return;
      if (typeof window.deleteTaskById === 'function') window.deleteTaskById(task.id);
      else if (typeof save === 'function' && typeof tasks !== 'undefined') { tasks = tasks.filter(item => item.id !== task.id); save(); paint(); }
      if (typeof showToast === 'function') showToast('Demanda excluída');
      return;
    }

    const edit = event.target.closest('[data-tp-edit]');
    if (edit) {
      const task = findTask(edit.dataset.tpEdit);
      if (task) openDialog(task);
      return;
    }

    const day = event.target.closest('[data-tp-day]');
    if (day) {
      const iso = day.dataset.tpDay;
      if (iso && typeof openCalendarDay === 'function') openCalendarDay(iso);
      return;
    }

    const control = event.target.closest('[data-tp-cal]');
    if (control) {
      if (control.dataset.tpCal === 'prev') state.month.setMonth(state.month.getMonth() - 1);
      if (control.dataset.tpCal === 'next') state.month.setMonth(state.month.getMonth() + 1);
      if (control.dataset.tpCal === 'today') state.month = new Date();
      paintBody();
    }
  });

  root.addEventListener('dragstart', event => {
    const card = event.target.closest?.('.tp-board-card[data-tp-task]');
    if (!card) return;
    dragId = card.dataset.tpTask || '';
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', dragId); } catch {}
    }
    card.classList.add('is-dragging');
  });

  root.addEventListener('dragover', event => {
    if (!dragId) return;
    const column = event.target.closest?.('.tp-col[data-tp-column]');
    if (!column) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('.tp-col.is-drop-target').forEach(item => { if (item !== column) item.classList.remove('is-drop-target'); });
    column.classList.add('is-drop-target');
  });

  root.addEventListener('dragleave', event => {
    const column = event.target.closest?.('.tp-col[data-tp-column]');
    if (!column) return;
    if (event.relatedTarget && column.contains(event.relatedTarget)) return;
    column.classList.remove('is-drop-target');
  });

  root.addEventListener('drop', event => {
    const column = event.target.closest?.('.tp-col[data-tp-column]');
    if (!column || !dragId) return;
    event.preventDefault();
    const status = column.dataset.tpColumn;
    const task = findTask(dragId);
    dragId = '';
    column.classList.remove('is-drop-target');
    if (!task || statusOf(task) === status) return;
    justDropped = true;
    setTimeout(() => { justDropped = false; }, 400);
    if (status === 'done') {
      completeTask(task);
    } else {
      task.status = status;
      delete task.completedAt;
      if (typeof touchTask === 'function') touchTask(task);
    }
    commit();
    if (typeof showToast === 'function') {
      showToast(`Demanda movida para ${status === 'done' ? 'Concluídas' : status === 'progress' ? 'Em andamento' : 'Pendentes'}`);
    }
  });

  root.addEventListener('dragend', () => {
    dragId = '';
    root.querySelectorAll('.tp-board-card.is-dragging').forEach(card => card.classList.remove('is-dragging'));
    root.querySelectorAll('.tp-col.is-drop-target').forEach(column => column.classList.remove('is-drop-target'));
  });

  root.addEventListener('input', event => {
    if (event.target.id === 'tpSearch') {
      state.search = event.target.value;
      expandedGroups.clear();
      paintBody();
    }
  });

  root.addEventListener('change', event => {
    if (event.target.matches('[data-tp-period-from], [data-tp-period-to]')) {
      const fromInput = event.target.hasAttribute('data-tp-period-from');
      state[fromInput ? 'from' : 'to'] = event.target.value;
      if (state.from && state.to && state.from > state.to) {
        if (fromInput) state.to = state.from;
        else state.from = state.to;
        const pop = event.target.closest('.tp-period-pop');
        if (pop) {
          pop.querySelector('[data-tp-period-from]').value = state.from;
          pop.querySelector('[data-tp-period-to]').value = state.to;
        }
      }
      const button = root.querySelector('[data-tp-period]');
      const label = button?.querySelector('.tp-period-label');
      if (label) label.textContent = periodText();
      button?.classList.toggle('is-on', Boolean(state.from || state.to));
      expandedGroups.clear();
      paintBody();
      return;
    }

    const check = event.target.closest('[data-tp-check]');
    if (check) {
      const task = findTask(check.dataset.tpCheck);
      const index = Number(check.dataset.tpCheckIndex);
      if (task?.checklist && task.checklist[index]) {
        task.checklist[index].done = check.checked;
        if (typeof touchTask === 'function') touchTask(task);
        commit();
      }
      return;
    }

    const filter = event.target.closest('[data-tp-filter]');
    if (!filter) return;
    state[filter.dataset.tpFilter] = filter.value;
    expandedGroups.clear();
    paintBody();
  });

  document.addEventListener('click', event => {
    if (!state.periodOpen) return;
    if (event.target.closest?.('.tp-period-wrap')) return;
    state.periodOpen = false;
    root.querySelector('.tp-period-wrap')?.classList.remove('is-open');
  }, true);

  function ensureEnableButton() {
    const bar = document.querySelector('.display-switch');
    if (!bar || bar.querySelector('#tpEnableButton')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'tpEnableButton';
    button.className = 'display-switch-button tp-enable';
    button.textContent = 'Nova tela';
    button.addEventListener('click', () => setPreview(true));
    bar.appendChild(button);
  }

  function start() {
    if (!canUseTasks()) return;
    ensureEnableButton();
    document.getElementById('closeTasksAudit')?.addEventListener('click', () => document.getElementById('tasksAuditDialog')?.close());
    document.getElementById('tasksAuditClose')?.addEventListener('click', () => document.getElementById('tasksAuditDialog')?.close());
    document.getElementById('tasksAuditFix')?.addEventListener('click', () => {
      if (!isManager()) return;
      const fixed = autoFixTasks();
      renderAudit(auditTasks());
      if (typeof showToast === 'function') showToast(fixed ? `${fixed} ponto(s) corrigido(s).` : 'Nada pôde ser corrigido automaticamente.');
    });
    document.querySelector('.sidebar-nav')?.addEventListener('click', event => {
      const button = event.target.closest('[data-screen]');
      if (!button || !active) return;
      if (button.dataset.screen === 'tasksScreen') setTimeout(() => { setSubtitle(true); paint(); }, 40);
      else setSubtitle(false);
    });
    if (localStorage.getItem(STORE_KEY) !== 'off') activate();
    else {
      const subtitle = document.querySelector('.topbar .subtitle');
      if (subtitle) originalSubtitle = subtitle.textContent;
    }
  }

  const renderBase = window.render;
  if (typeof renderBase === 'function') {
    window.render = function () {
      const result = renderBase.apply(this, arguments);
      if (active) paint();
      return result;
    };
  }

  let started = false;
  const waitForAccess = setInterval(() => {
    if (started || !user()) return;
    started = true;
    clearInterval(waitForAccess);
    start();
  }, 200);
  setTimeout(() => clearInterval(waitForAccess), 60000);

  setInterval(() => { if (active && !canUseTasks()) deactivate(); }, 3000);
})();

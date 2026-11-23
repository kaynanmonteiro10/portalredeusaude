const HISTORY_KEY = 'plantao-cobrancas-history-v1';
const MERGE_QUEUE_KEY = 'plantao-mala-direta-fila-v1';
const LEARNING_KEY = 'plantao-treinamentos-v1';
const THEME_KEY = 'portal-theme-v1';
const COMPLETION_SOUND_KEY = 'portal-completion-sound-v1';
function newId() { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); if (globalThis.crypto?.getRandomValues) { const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128; return [...bytes].map((byte, index) => [4, 6, 8, 10].includes(index) ? `-${byte.toString(16).padStart(2, '0')}` : byte.toString(16).padStart(2, '0')).join(''); } return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
window.newPortalId = newId;
const boardHost = window.location.hostname || '127.0.0.1';
const boardUrl = `http://${boardHost}:5000`;
if ($('#boardLink')) $('#boardLink').href = boardUrl;
if ($('#boardAddress')) $('#boardAddress').textContent = `Endereço: ${boardUrl}`;
if ($('#boardFrame')) $('#boardFrame').src = boardUrl;
let tasks = [];
let deletedTaskIds = new Set();
let billingHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
let currentView = 'today';
let editingId = null;
let checklistDraft = [];
let attachmentDraft = [];
let attachmentUploads = 0;
let calendarCursor = new Date();
let calendarSelectedDate = null;
let displayMode = 'list';
let activeStatFilter = null;
let reminderTaskId = null;
let pausingTaskId = null;
let mergeRows = JSON.parse(localStorage.getItem(MERGE_QUEUE_KEY) || '[]');
let mergeTemplateBuffer = null;
let learningData = JSON.parse(localStorage.getItem(LEARNING_KEY) || '{"resources":[],"links":[],"notes":[],"flows":[{"id":"default","name":"Processo principal","nodes":[],"edges":[]}],"activeFlowId":"default"}');
document.body.dataset.theme = localStorage.getItem(THEME_KEY) || 'light';
if (!learningData.flows) { learningData.flows = [{ id: 'default', name: 'Processo principal', nodes: learningData.nodes || [], edges: learningData.edges || [] }]; learningData.activeFlowId = 'default'; delete learningData.nodes; delete learningData.edges; }
learningData.weeklyRecords = Array.isArray(learningData.weeklyRecords) ? learningData.weeklyRecords : [];
learningData.trainings = Array.isArray(learningData.trainings) ? learningData.trainings : [];
learningData.resources = Array.isArray(learningData.resources) ? learningData.resources : [];
learningData.links = Array.isArray(learningData.links) ? learningData.links : [];
learningData.notes = Array.isArray(learningData.notes) ? learningData.notes : [];
let learningTab = 'trainings';
let learningFilter = 'all';
let trainingDraftSteps = [];
let editingTrainingId = null;
let editingNoteIndex = null;
let editingLinkIndex = null;
function localIsoDate(value = new Date()) { const d = value instanceof Date ? value : new Date(`${value}T12:00:00`); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const today = () => localIsoDate();
function taskSeriesKey(task) { return `${task?.recurrence || 'none'}|${normalizeOwner(task?.owner)}|${String(task?.title || '').trim().toLowerCase()}`; }
function weekendSchedule() { const user = window.PortalAccess?.Access?.user; const people = [user, ...(user?.teammates || []), ...(window.__portalUsers || [])].filter(Boolean); const map = new Map(); const sectors = new Map(); people.forEach(person => { const name = normalizeOwner(person.displayName); if (!name) return; const flags = [!!person.worksSaturday, !!person.worksSunday]; map.set(name, flags); const ids = [...new Set([person.sectorId, ...(person.sectorIds || [])].filter(Boolean))]; ids.forEach(id => sectors.set(id, [...(sectors.get(id) || []), flags])); }); return { map, sectors }; }
function personWorksOn(owner, dateIso, sectorId) { const day = new Date(`${dateIso}T12:00:00`).getDay(); if (day !== 0 && day !== 6) return true; const index = day === 6 ? 0 : 1; const { map, sectors } = weekendSchedule(); const key = normalizeOwner(owner); if (key === 'ambos' || key === 'dupla') return (sectors.get(sectorId) || []).some(flags => flags[index]); return !!map.get(key)?.[index]; }
function touchTask(task) { if (task) task.updatedAt = new Date().toISOString(); }
function taskMediaUrl(path) { if (!path) return ''; const value = String(path); if (value.startsWith('data:')) return value; return `${window.PORTAL_API_BASE || ''}${value}${value.includes('?') ? '&' : '?'}t=${encodeURIComponent(window.PortalAccess?.Access?.token || '')}`; }
function attachmentSizeLabel(item) { const size = Number(item?.size); if (!Number.isFinite(size) || size <= 0) return typeof item?.size === 'string' ? item.size : ''; return size >= 1048576 ? `${(size / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`; }
async function uploadDemandFile(file) {
  if (window.PortalAccess?.Access?.offline || !navigator.onLine) throw new Error('Para enviar anexos, reconecte ao servidor do portal.');
  const params = new URLSearchParams({ name: file.name || 'arquivo', mime: file.type || 'application/octet-stream' });
  const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/demands/upload?${params.toString()}`, {
    method: 'POST',
    headers: window.PortalAccess?.authHeaders ? window.PortalAccess.authHeaders({ 'Content-Type': 'application/octet-stream' }) : { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível enviar o arquivo.');
  return data;
}
const dateLabel = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
const priorityNames = { urgent: 'Crítica', high: 'Alta', medium: 'Normal', low: 'Baixa' };
let toastTimer;
function showToast(message, tone = 'success') { const toast = $('#toast'); if (!toast) return; toast.textContent = message; toast.dataset.tone = tone; toast.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400); }
function updateThemeButton() { $('#themeButton').textContent = document.body.dataset.theme === 'dark' ? 'Modo claro' : 'Modo noturno'; }
updateThemeButton();
let demandDisplaySnapshot = new Map();
let demandRawSnapshot = new Map();
function applyDemandSnapshot(state) {
  demandRawSnapshot = new Map(state.tasks.map(task => [task.id, task]));
  tasks = normalizeTasks(state.tasks);
  demandDisplaySnapshot = new Map(tasks.map(task => [task.id, JSON.stringify(task)]));
  deletedTaskIds = new Set(state.deletedTaskIds || []);
  render();
}
function save() {
  try {
    const desired = tasks.map(task => demandDisplaySnapshot.get(task.id) === JSON.stringify(task) ? demandRawSnapshot.get(task.id) : task);
    window.PortalOffline.capture(desired, [...deletedTaskIds]);
    applyDemandSnapshot(window.PortalOffline.getSnapshot());
    void window.PortalOffline.flush().then(status => {
      if (status && status.phase === 'synced') {
        showToast('Demanda sincronizada');
      } else {
        showToast('Demanda salva localmente');
      }
    }).catch(() => {
      showToast('Demanda salva neste computador');
    });
  } catch (error) {
    applyDemandSnapshot(window.PortalOffline.getSnapshot());
    showToast(error.message || 'Não foi possível salvar a demanda.', 'warning');
    throw error;
  }
}
function persistBackend() {
  if (!window.PortalAccess?.Access?.token || window.PortalAccess.Access.offline) return;
  window.PortalAccess.api('/api/state', { method: 'PUT', body: JSON.stringify({ billingHistory, mergeRows, learningData }) })
    .catch(() => showToast('Estas alterações ainda não foram sincronizadas.', 'warning'));
}
function registerRecurrenceSkip(task) { if (!task || task.recurrence === 'none') return; const key = taskSeriesKey(task); const when = String(task.due || '').slice(0, 10); if (!when) return; tasks.forEach(item => { if (item.id === task.id || taskSeriesKey(item) !== key) return; const skips = new Set((item.recurrenceSkips || []).map(String)); skips.add(when); item.recurrenceSkips = [...skips]; touchTask(item); }); }
function deleteTaskById(id) {
  const task = tasks.find(item => item.id === id);
  if (!task) return false;
  registerRecurrenceSkip(task);
  deletedTaskIds.add(id);
    tasks = tasks.filter(item => item.id !== id);
  save();
  render();
  if (typeof renderReports === 'function' && !$('#reports').classList.contains('hidden')) renderReports();
  return true;
}
window.deleteTaskById = deleteTaskById;
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(billingHistory)); persistBackend(); }
function saveMergeQueue() { localStorage.setItem(MERGE_QUEUE_KEY, JSON.stringify(mergeRows)); persistBackend(); }
function saveLearning() { try { localStorage.setItem(LEARNING_KEY, JSON.stringify(learningData)); persistBackend(); } catch (error) { alert('O armazenamento do navegador ficou cheio. Remova arquivos grandes da biblioteca ou use arquivos menores.'); } }
function nextDate(days) { const d = new Date(); d.setDate(d.getDate() + days); return localIsoDate(d); }
// Mantida para consulta de datas; não cria mais demandas (ver completeTask).
function nextOccurrence(date, recurrence, task) {
  const d = new Date(`${date}T12:00:00`);
  const current = new Date(`${today()}T12:00:00`);
  if (!['daily', 'weekly', 'fortnightly', 'monthly'].includes(recurrence)) return localIsoDate(d);
  const advance = () => { if (recurrence === 'daily') d.setDate(d.getDate() + 1); if (recurrence === 'weekly') d.setDate(d.getDate() + 7); if (recurrence === 'fortnightly') d.setDate(d.getDate() + 14); if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1); };
  advance();
  if (recurrence === 'daily' && task) {
    const skips = new Set((task.recurrenceSkips || []).map(String));
    while (d < current || !personWorksOn(task.owner, localIsoDate(d), task.sectorId) || skips.has(localIsoDate(d))) advance();
    return localIsoDate(d);
  }
  while (d <= current) advance();
  return localIsoDate(d);
}
function scopedTasks() { const user = window.PortalAccess?.Access?.user; const isManager = user?.role === 'admin' || (user?.management || false); if (isManager) return tasks; const sectorIds = user?.sectorIds || (user?.sectorId ? [user.sectorId] : []); return tasks.filter(task => sectorIds.includes(task.sectorId)); }
function sameSector(person, user) {
  if (!person || !user) return false;
  if (person.id === user.id) return true;
  const mine = new Set(user.sectorIds || (user.sectorId ? [user.sectorId] : []));
  const theirs = person.sectorIds || (person.sectorId ? [person.sectorId] : []);
  return theirs.some(id => mine.has(id));
}
window.refreshOwnerFilter = function() { const user = window.PortalAccess?.Access?.user; const isManager = user?.role === 'admin' || (user?.management || false); const users = isManager ? (window.__portalUsers?.length ? window.__portalUsers : [user, ...(user?.teammates || [])]) : [user, ...(user?.teammates || [])].filter(item => sameSector(item, user)); const people = [...new Map(users.filter(item => item && !window.isHiddenTaskOwner?.(item.displayName)).map(item => [item.displayName, item.displayName])).values()]; const peopleOptions = people.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(''); const currentVal = $('#ownerFilter')?.value; $('#ownerFilter').innerHTML = '<option value="all">Demandas do setor</option>' + peopleOptions + '<option value="Ambos">Ambos</option>'; if (currentVal && [...$('#ownerFilter').options].some(o => o.value === currentVal)) { $('#ownerFilter').value = currentVal; } $('#taskOwner').innerHTML = '<option value="">Selecione um responsável</option>' + peopleOptions + '<option value="Ambos">Ambos</option>'; if ($('#recordOwner')) $('#recordOwner').innerHTML = '<option value="">Selecione um responsável</option>' + peopleOptions; };
window.refreshTaskCategory = function() { const user = window.PortalAccess?.Access?.user; const sectors = user?.role === 'admin' ? (window.PortalAccess.Access.sectors || []) : (user?.sectors || [{ id: user?.sectorId, name: user?.sectorName }]); $('#taskSectorChoice').innerHTML = '<option value="">Selecione um setor</option>' + sectors.filter(sector => sector?.id).map(sector => `<option value="${escapeHtml(sector.id)}">${escapeHtml(sector.name)}</option>`).join(''); const categories = user?.role === 'admin' ? [...new Set([...sectors.map(sector => sector.name), ...tasks.map(task => task.category).filter(Boolean)])] : sectors.map(sector => sector.name); $('#taskCategory').innerHTML = '<option value="">Selecione uma categoria</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join(''); };
function taskPeriod(task) { return { start: task.periodStart || task.due, end: task.periodEnd || task.due }; }
function normalizeOwner(name) { return String(name || '').trim().toLowerCase(); }
function matchOwner(taskOwner, targetOwner, myName, sectorId) {
  if (!targetOwner || targetOwner === 'all') return true;
  return normalizeOwner(taskOwner) === normalizeOwner(targetOwner);
}
function calendarTasks() {
  const owner = $('#ownerFilter')?.value || 'all';
  const priority = $('#priorityFilter')?.value || 'all';
  const status = $('#statusFilter')?.value || 'all';
  const search = $('#searchInput')?.value.toLowerCase().trim() || '';
  const currentUser = window.PortalAccess?.Access?.user;
  const myName = currentUser?.displayName;
  return scopedTasks().filter(t => {
    const ownerOk = matchOwner(t.owner, owner, myName, t.sectorId);
    const statusOk = status === 'all' || normalizedStatus(t) === status;
    const priorityOk = priority === 'all' || t.priority === priority;
    const searchOk = !search || `${t.title} ${t.notes} ${t.owner}`.toLowerCase().includes(search);
    return ownerOk && statusOk && priorityOk && searchOk;
  });
}
function visibleTasks() { const owner = $('#ownerFilter').value, priority = $('#priorityFilter').value, status = $('#statusFilter').value, search = $('#searchInput').value.toLowerCase(), filterStart = $('#periodFilterStart').value, filterEnd = $('#periodFilterEnd').value, current = today(); const currentUser = window.PortalAccess?.Access?.user; const myName = currentUser?.displayName; return scopedTasks().filter(t => { const period = taskPeriod(t); const statOk = !activeStatFilter || (activeStatFilter === 'today' && period.start <= current && t.status !== 'done') || (activeStatFilter === 'overdue' && period.end < current && t.status !== 'done') || (activeStatFilter === 'progress' && t.status === 'progress') || (activeStatFilter === 'done' && t.status === 'done'); const viewOk = activeStatFilter || currentView === 'all' || (currentView === 'today' ? period.start <= current : period.start > current); const periodOk = (!filterStart || period.end >= filterStart) && (!filterEnd || period.start <= filterEnd); const ownerOk = matchOwner(t.owner, owner, myName, t.sectorId); return statOk && viewOk && periodOk && (activeStatFilter || currentView === 'all' || t.status !== 'done') && (status === 'all' || normalizedStatus(t) === status) && ownerOk && (priority === 'all' || t.priority === priority) && (!search || `${t.title} ${t.notes} ${t.owner}`.toLowerCase().includes(search)); }).sort((a,b) => (a.status === 'done') - (b.status === 'done') || a.due.localeCompare(b.due) || ['urgent','high','medium','low'].indexOf(a.priority) - ['urgent','high','medium','low'].indexOf(b.priority)); }
function groupTaskCards(items) { const list = $('#taskList'); const groups = new Map(); [...list.children].forEach((card, index) => { const task = items[index]; const period = taskPeriod(task); card.classList.add(`priority-${task.priority}`); const key = task.status === 'done' ? 'Concluídas' : period.end < today() ? 'Atrasadas' : period.start <= today() ? 'Hoje' : 'Planejadas'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(card); }); list.replaceChildren(); groups.forEach((cards, label) => { const heading = document.createElement('h3'); heading.className = 'task-group-title'; heading.textContent = label; list.append(heading, ...cards); }); }
let groupingTasks = false;
new MutationObserver(() => { if (groupingTasks || !$('#taskList').children.length || $('#taskList').firstElementChild.classList.contains('task-group-title')) return; groupingTasks = true; groupTaskCards(visibleTasks()); groupingTasks = false; }).observe($('#taskList'), { childList: true });
function reportRange() { return { start: $('#reportStart')?.value || '', end: $('#reportEnd')?.value || '' }; }
function reportDateInRange(date, start, end) { return !date || ((!start || date >= start) && (!end || date <= end)); }
function taskActivityDates(task) { return [task.createdAt?.slice(0, 10), task.completedAt?.slice(0, 10), task.periodStart || task.due, task.periodEnd || task.due].filter(Boolean); }
function reportBaseTasks(sector) { const chosen = sector ?? ($('#reportSector')?.value || 'all'); return scopedTasks().filter(task => chosen === 'all' || task.sectorId === chosen); }
function reportTasksForRange(start, end, sector) { return reportBaseTasks(sector).filter(task => taskActivityDates(task).some(date => reportDateInRange(date, start, end))); }
function reportTasks() { const { start, end } = reportRange(); return reportTasksForRange(start, end); }
function dateTimeLabel(value) { return value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'Não registrado'; }
function normalizedStatus(task) { return task.status === 'done' ? 'done' : task.status === 'progress' ? 'progress' : 'todo'; }
function normalizeTasks(items) { return items.map(task => { const normalized = { ...task, owner: task.owner === 'Dupla' ? 'Pedro' : task.owner, status: normalizedStatus(task), createdAt: task.createdAt || null, updatedAt: task.updatedAt || task.createdAt || null, completedAt: task.completedAt || null, checklist: Array.isArray(task.checklist) ? task.checklist : [], attachments: Array.isArray(task.attachments) ? task.attachments : [] }; if (normalized.recurrence && normalized.recurrence !== 'none' && normalized.due && (!normalized.periodEnd || normalized.due > normalized.periodEnd)) { normalized.periodStart = normalized.due; normalized.periodEnd = normalized.due; } return normalized; }); }
function categoryLabel(category) { return { cadastro: 'Cadastro', faturamento: 'Faturamento' }[category] || category || 'Sem categoria'; }
function periodLabel(task) { const start = task.periodStart || task.due; const end = task.periodEnd || task.due; return start && end && start !== end ? `${dateLabel(start)} a ${dateLabel(end)}` : dateLabel(end); }
function renderChecklistEditor() { $('#checklistItems').innerHTML = checklistDraft.map((item, index) => `<div class="checklist-editor-row"><input type="checkbox" data-checklist-draft-toggle="${index}" ${item.done ? 'checked' : ''}><span>${escapeHtml(item.text)}</span><button type="button" data-checklist-draft-remove="${index}" aria-label="Remover etapa">×</button></div>`).join(''); }
function renderAttachmentEditor() { $('#taskAttachmentList').innerHTML = attachmentDraft.map((item, index) => `<div class="attachment-row"><a href="${escapeHtml(taskMediaUrl(item.media || item.data))}" target="_blank" rel="noopener" download="${escapeHtml(item.name)}">📎 ${escapeHtml(item.name)}</a><small>${escapeHtml(attachmentSizeLabel(item))}</small><button type="button" data-attachment-remove="${index}" aria-label="Remover anexo">×</button></div>`).join(''); }
function taskDetailsHtml(task) { const checklist = task.checklist || []; const attachments = task.attachments || []; const checklistHtml = checklist.length ? `<div class="task-checklist-inline">${checklist.map((item, index) => `<label class="task-check ${item.done ? 'done' : ''}"><input type="checkbox" data-checklist-task="${task.id}" data-checklist-index="${index}" ${item.done ? 'checked' : ''}>${escapeHtml(item.text)}</label>`).join('')}</div>` : ''; const attachmentHtml = attachments.length ? `<div class="task-attachments-inline">${attachments.map(item => `<a href="${escapeHtml(taskMediaUrl(item.media || item.data))}" target="_blank" rel="noopener" download="${escapeHtml(item.name)}">📎 ${escapeHtml(item.name)}</a>`).join('')}</div>` : ''; return checklistHtml + attachmentHtml; }
function addTaskChecklistItem(task) { const text = prompt('Nova etapa do checklist:'); if (!text?.trim()) return; task.checklist ||= []; task.checklist.push({ id: newId(), text: text.trim(), done: false }); touchTask(task); save(); render(); }
function renderCalendar() { const grid = $('#calendarGrid'); if (!grid) return; const year = calendarCursor.getFullYear(); const month = calendarCursor.getMonth(); const firstDay = (new Date(year, month, 1).getDay() + 6) % 7; const days = new Date(year, month + 1, 0).getDate(); const monthLabel = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(calendarCursor); $('#calendarMonth').textContent = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1); const allTasks = calendarTasks(); const cells = []; for (let index = 0; index < firstDay; index += 1) cells.push('<span class="calendar-day outside"></span>'); for (let day = 1; day <= days; day += 1) { const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; const dayTasks = allTasks.filter(task => { const period = taskPeriod(task); return period.start <= date && period.end >= date; }).sort((a, b) => { const rank = { urgent: 0, high: 1, medium: 2, low: 3, done: 4 }; return (rank[a.status === 'done' ? 'done' : a.priority] ?? 3) - (rank[b.status === 'done' ? 'done' : b.priority] ?? 3); }); const limit = 3; const chips = dayTasks.slice(0, limit).map(task => `<span class="calendar-chip p-${task.priority} ${task.status === 'done' ? 'done' : ''}">${escapeHtml(task.title)}</span>`).join(''); const rest = dayTasks.length - limit; const more = rest > 0 ? `<span class="calendar-more">+${rest} outra${rest > 1 ? 's' : ''}</span>` : ''; const todayClass = date === today() ? 'today' : ''; const weekend = [0, 6].includes(new Date(`${date}T12:00:00`).getDay()) ? 'weekend' : ''; cells.push(`<button type="button" class="calendar-day ${todayClass} ${weekend}" data-calendar-date="${date}"><span class="calendar-day-number">${day}</span><span class="calendar-chips">${chips}</span>${more}</button>`); } grid.innerHTML = cells.join(''); }
function render() { const list = $('#taskList'); const items = visibleTasks(); list.innerHTML = items.map(task => { const period = taskPeriod(task); const overdue = period.end < today() && task.status !== 'done'; const isToday = period.start <= today() && period.end >= today(); const checklist = task.checklist || []; const checked = checklist.filter(item => item.done).length; const checklistHtml = checklist.length ? `<div class="task-checklist-summary">Checklist ${checked}/${checklist.length} concluído</div>` : '<button type="button" class="task-action checklist-add-inline" data-action="add-checklist" data-id="'+task.id+'">+ Adicionar etapa</button>'; const attachmentHtml = task.attachments?.length ? `<span class="task-attachment-count">📎 ${task.attachments.length}</span>` : ''; const currentUser = window.PortalAccess?.Access?.user; const claimHtml = currentUser && task.owner !== currentUser.displayName && task.status !== 'done' ? `<button class="task-action" data-action="claim" data-id="${task.id}">Assumir</button>` : ''; return `<article class="task ${task.status === 'done' ? 'completed' : ''}"><button class="check" data-action="toggle" data-id="${task.id}" aria-label="Concluir demanda"></button><div><div class="task-title">${escapeHtml(task.title)}</div>${task.notes ? `<div class="task-notes">${escapeHtml(task.notes)}</div>` : ''}<div class="meta"><span class="badge category-cadastro">${escapeHtml(categoryLabel(task.category))}</span><span class="badge priority-${task.priority}">${priorityNames[task.priority]}</span><span class="due ${overdue ? 'overdue' : isToday ? 'today' : ''}">${overdue ? 'Atrasada · ' : isToday ? 'Hoje · ' : ''}${periodLabel(task)}${task.dueTime ? ` · ${task.dueTime}` : ''}</span>${task.recurrence !== 'none' ? `<span class="due">↻ ${recurrenceName(task.recurrence)}</span>` : ''}${attachmentHtml}</div>${checklistHtml}${taskDetailsHtml(task)}<div class="task-dates">Criada: ${dateTimeLabel(task.createdAt)} · ${task.status === 'done' ? `Concluída: ${dateTimeLabel(task.completedAt)}` : 'Ainda não concluída'}</div></div><div class="task-actions"><span class="owner">${escapeHtml(task.owner)}</span>${claimHtml}<button class="task-action" data-action="edit" data-id="${task.id}">Editar</button><button class="delete" data-action="delete" data-id="${task.id}" aria-label="Excluir demanda">×</button></div></article>`; }).join(''); $('#emptyState').classList.toggle('hidden', items.length > 0); document.querySelectorAll('.stat-filter').forEach(card => card.classList.toggle('selected', card.dataset.statFilter === activeStatFilter)); updateStats(); renderCalendar(); renderDemandClock(); }
function recurrenceName(value) { return { daily: 'diária', weekly: 'semanal', fortnightly: 'quinzenal', monthly: 'mensal' }[value] || ''; }
function updateStats() { const user = window.PortalAccess?.Access?.user; const ownerVal = $('#ownerFilter')?.value || 'all'; const myName = user?.displayName; const visible = scopedTasks().filter(t => matchOwner(t.owner, ownerVal, myName, t.sectorId)); const current = today(); const monthStart = `${current.slice(0, 7)}-01`; const monthEnd = new Date(Number(current.slice(0, 4)), Number(current.slice(5, 7)), 0).toISOString().slice(0, 10); const inMonth = task => { const period = taskPeriod(task); return period.start <= monthEnd && period.end >= monthStart; }; const completedInMonth = task => task.completedAt?.slice(0, 7) === current.slice(0, 7); const todayTasks = visible.filter(t => taskPeriod(t).start <= current && t.status !== 'done'); const overdueTasks = visible.filter(t => taskPeriod(t).end < current && t.status !== 'done'); const progressTasks = visible.filter(t => t.status === 'progress'); const doneTasks = visible.filter(t => t.status === 'done'); $('#todayCount').textContent = todayTasks.length; $('#overdueCount').textContent = overdueTasks.length; $('#progressCount').textContent = progressTasks.length; $('#doneCount').textContent = doneTasks.length; $('#todayMonthCount').textContent = `No mês: ${todayTasks.filter(inMonth).length}`; $('#overdueMonthCount').textContent = `No mês: ${overdueTasks.filter(inMonth).length}`; $('#progressMonthCount').textContent = `No mês: ${progressTasks.filter(inMonth).length}`; $('#doneMonthCount').textContent = `No mês: ${doneTasks.filter(completedInMonth).length}`; }
function setDisplayMode(mode) { displayMode = mode; const calendar = mode === 'calendar'; $('#taskList').classList.toggle('hidden', calendar); $('#emptyState').classList.toggle('hidden', calendar || $('#taskList').children.length > 0); $('#calendarPanel').classList.toggle('hidden', !calendar); $('#listViewButton').classList.toggle('active', !calendar); $('#calendarViewButton').classList.toggle('active', calendar); if (calendar) renderCalendar(); }
function openCalendarDay(date) { calendarSelectedDate = date; const tasksForDay = calendarTasks().filter(task => { const period = taskPeriod(task); return period.start <= date && period.end >= date; }); $('#calendarDayTitle').textContent = new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }); $('#calendarDayList').innerHTML = tasksForDay.length ? tasksForDay.map(task => `<article class="calendar-day-task"><strong>${escapeHtml(task.title)}</strong><span>${escapeHtml(task.owner)} · ${escapeHtml(periodLabel(task))}${task.dueTime ? ` · ${escapeHtml(task.dueTime)}` : ''}</span>${taskDetailsHtml(task)}<div class="calendar-task-actions"><button type="button" data-calendar-action="toggle" data-id="${task.id}">${task.status === 'done' ? 'Reabrir' : 'Concluir'}</button>${task.owner !== window.PortalAccess?.Access?.user?.displayName && task.status !== 'done' ? `<button type="button" data-calendar-action="claim" data-id="${task.id}">Assumir</button>` : ''}<button type="button" data-calendar-action="edit" data-id="${task.id}">Editar</button></div></article>`).join('') : '<p class="empty-state">Nenhuma demanda neste dia com os filtros atuais.</p>'; $('#calendarDayDialog').showModal(); }
function claimTask(task) { const user = window.PortalAccess?.Access?.user; if (!task || !user) return; task.owner = user.displayName; task.assignedAt = new Date().toISOString(); touchTask(task); window.PortalNotify?.markLocal?.(task.id); showToast(`Demanda assumida por ${user.displayName}`); }
function resourceKind(item) { if (item.type === 'application/pdf' || item.name.match(/\.pdf$/i)) return 'PDF'; if (item.type.includes('sheet') || item.name.match(/\.xlsx?$/i)) return 'XLS'; if (item.type.includes('word') || item.name.match(/\.docx?$/i)) return 'DOC'; return 'IMG'; }
function learningUser() { return window.PortalAccess?.Access?.user || null; }
function learningManager() { const user = learningUser(); return user?.role === 'admin' || !!user?.management; }
function learningUserKey() { const user = learningUser(); return String(user?.id || user?.displayName || 'anon'); }
function learningSectors() { const user = learningUser(); return [...new Set([...(user?.sectorIds || []), ...(user?.sectorId ? [user.sectorId] : [])].filter(Boolean))]; }
function learningSectorOptions() {
  const known = [['cadastro', 'Cadastro'], ['financeiro', 'Financeiro'], ['gerencia', 'Gerência'], ['credenciamento', 'Credenciamento'], ['cadastro-faturamento', 'Cadastro e Faturamento']];
  const map = new Map(known);
  [...(window.PortalAccess?.Access?.sectors || []), ...(learningUser()?.sectors || [])].forEach(item => { if (item?.id) map.set(item.id, item.name || item.id); });
  const all = [...map.entries()];
  return learningManager() ? all : all.filter(([id]) => learningSectors().includes(id));
}
function normalizeLearning() {
  if (!learningData || typeof learningData !== 'object') learningData = {};
  ['resources', 'links', 'notes', 'flows', 'trainings', 'weeklyRecords'].forEach(key => { if (!Array.isArray(learningData[key])) learningData[key] = []; });
  if (!learningData.flows.length) learningData.flows = [{ id: 'default', name: 'Processo principal', nodes: [], edges: [] }];
  if (!learningData.activeFlowId || !learningData.flows.some(flow => flow.id === learningData.activeFlowId)) learningData.activeFlowId = learningData.flows[0].id;
  learningData.trainings = learningData.trainings.map(training => ({
    id: training.id || newId(),
    title: training.title || 'Trilha sem nome',
    description: training.description || '',
    category: training.category || 'Processos',
    required: !!training.required,
    sectorId: training.sectorId || 'all',
    createdBy: training.createdBy || '',
    createdAt: training.createdAt || new Date().toISOString(),
    steps: (Array.isArray(training.steps) ? training.steps : []).map(step => ({ id: step.id || newId(), text: step.text || '' })).filter(step => step.text),
    completions: training.completions && typeof training.completions === 'object' ? training.completions : {},
  }));
  return learningData;
}
function trainingVisible(training) { if (learningManager()) return true; if (!training.sectorId || training.sectorId === 'all') return true; return learningSectors().includes(training.sectorId); }
function trainingCompletion(training) {
  const key = learningUserKey();
  const record = training.completions?.[key] || {};
  const steps = (record.steps || []).filter(id => training.steps.some(step => step.id === id));
  const total = training.steps.length;
  const percent = total ? Math.round(steps.length / total * 100) : 0;
  return { key, steps, total, percent, done: steps.length, completedAt: record.completedAt || null, updatedAt: record.updatedAt || null };
}
function trainingTeamStats(training) {
  const records = Object.values(training.completions || {});
  const full = records.filter(record => training.steps.length && (record.steps || []).length >= training.steps.length).length;
  return { people: records.length, full };
}
function renderTrainingCategories() {
  const select = $('#trainingCategory'); if (!select) return;
  const current = select.value;
  const categories = ['Processos', 'Sistemas', 'Atendimento', 'Compliance e LGPD', 'Financeiro', 'Cadastro', 'Outros'];
  select.innerHTML = categories.map(item => `<option>${escapeHtml(item)}</option>`).join('');
  if (categories.includes(current)) select.value = current;
}
function renderTrainingKpis(visible) {
  const host = $('#learningKpis'); if (!host) return;
  const rows = visible.map(training => ({ training, completion: trainingCompletion(training) }));
  const required = rows.filter(item => item.training.required);
  const requiredDone = required.filter(item => item.completion.total && item.completion.percent >= 100).length;
  const started = rows.filter(item => item.completion.done > 0 && item.completion.percent < 100).length;
  const finished = rows.filter(item => item.completion.total && item.completion.percent >= 100).length;
  const average = rows.length ? Math.round(rows.reduce((sum, item) => sum + item.completion.percent, 0) / rows.length) : 0;
  const cards = [
    { label: 'Trilhas no setor', value: rows.length, hint: `${learningData.trainings.length} no portal` },
    { label: 'Obrigatórias', value: required.length, hint: `${requiredDone} de ${required.length} concluídas por você`, tone: required.length && requiredDone < required.length ? 'kpi-alert' : '' },
    { label: 'Em andamento', value: started, hint: 'começadas e ainda abertas' },
    { label: 'Concluídas', value: finished, hint: '100% das etapas' },
    { label: 'Seu progresso', value: `${average}%`, hint: 'média das trilhas visíveis', tone: 'kpi-dark' },
  ];
  host.innerHTML = cards.map(card => `<article class="learning-kpi ${card.tone || ''}"><span>${card.label}</span><strong>${card.value}</strong><small>${card.hint}</small></article>`).join('');
}
function visibleTrainings() {
  const query = ($('#learningSearch')?.value || '').trim().toLowerCase();
  return learningData.trainings.filter(trainingVisible).filter(training => {
    const completion = trainingCompletion(training);
    const finished = completion.total > 0 && completion.percent >= 100;
    if (learningFilter === 'required' && !training.required) return false;
    if (learningFilter === 'pending' && (finished || completion.total === 0)) return false;
    if (learningFilter === 'done' && !finished) return false;
    return !query || `${training.title} ${training.description} ${training.category}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    const ca = trainingCompletion(a), cb = trainingCompletion(b);
    const fa = ca.total > 0 && ca.percent >= 100 ? 1 : 0, fb = cb.total > 0 && cb.percent >= 100 ? 1 : 0;
    return (b.required - a.required) || (fa - fb) || String(a.title).localeCompare(String(b.title));
  });
}
function renderTrainings() {
  const host = $('#learningTrainings'); if (!host) return;
  const list = visibleTrainings();
  host.innerHTML = list.map(training => {
    const completion = trainingCompletion(training);
    const finished = completion.total > 0 && completion.percent >= 100;
    const team = trainingTeamStats(training);
    const tags = [
      training.required ? '<span class="training-tag required">Obrigatória</span>' : '',
      `<span class="training-tag sector">${escapeHtml(training.sectorId === 'all' ? 'Todo o setor' : reportSectorLabel(training.sectorId))}</span>`,
      `<span class="training-tag">${escapeHtml(training.category)}</span>`,
      finished ? '<span class="training-tag done">Concluída</span>' : '',
    ].join('');
    const menu = learningManager() ? `<button type="button" class="training-icon" data-training-edit="${training.id}" title="Editar trilha">Editar</button><button type="button" class="training-icon danger" data-training-delete="${training.id}" title="Excluir trilha">Excluir</button>` : '';
    const steps = training.steps.map(step => `<label class="training-step ${completion.steps.includes(step.id) ? 'done' : ''}"><input type="checkbox" data-training-id="${training.id}" data-training-step="${step.id}" ${completion.steps.includes(step.id) ? 'checked' : ''}><span>${escapeHtml(step.text)}</span></label>`).join('');
    const actions = finished
      ? `<button type="button" class="training-btn ghost" data-training-reset="${training.id}">Refazer</button><button type="button" class="training-btn primary" data-training-certificate="${training.id}">Certificado</button>`
      : `<button type="button" class="training-btn primary" data-training-complete="${training.id}" ${completion.total ? '' : 'disabled'}>Concluir trilha</button>`;
    return `<article class="training-card ${finished ? 'is-done' : ''} ${training.required ? 'is-required' : ''}"><div class="training-top"><div class="training-tags">${tags}</div><div class="training-menu">${menu}</div></div><h4>${escapeHtml(training.title)}</h4>${training.description ? `<p class="training-desc">${escapeHtml(training.description)}</p>` : ''}<div class="training-progress"><div class="training-progress-line"><span>${completion.total ? `${completion.done} de ${completion.total} etapas` : 'Sem etapas'}</span><strong>${completion.percent}%</strong></div><div class="training-track"><i style="width:${completion.percent}%"></i></div></div><div class="training-steps">${steps || '<p class="training-step-empty">Esta trilha ainda não tem etapas.</p>'}</div><div class="training-foot"><div class="training-team"><strong>${team.people}</strong> começaram · <strong>${team.full}</strong> concluíram${completion.completedAt ? ` · você concluiu em ${new Date(completion.completedAt).toLocaleDateString('pt-BR')}` : ''}</div><div class="training-actions">${actions}</div></div></article>`;
  }).join('');
  const empty = $('#trainingsEmpty');
  if (empty) {
    empty.classList.toggle('hidden', list.length > 0);
    const hasTrainings = learningData.trainings.some(trainingVisible);
    const heading = empty.querySelector('strong'), text = empty.querySelector('p');
    if (heading) heading.textContent = hasTrainings ? 'Nenhuma trilha nesta seleção.' : 'Nenhuma trilha por aqui ainda.';
    if (text) text.textContent = hasTrainings ? 'Ajuste a busca ou o filtro para ver outras trilhas do setor.' : 'Crie uma trilha com etapas para orientar quem chega e padronizar o que o setor já sabe fazer.';
    $('#emptyNewTraining')?.classList.toggle('hidden', hasTrainings);
    $('#seedTrainings')?.classList.toggle('hidden', hasTrainings);
  }
}
function toggleTrainingStep(trainingId, stepId, done) {
  const training = learningData.trainings.find(item => item.id === trainingId);
  if (!training || !training.steps.some(step => step.id === stepId)) return;
  const key = learningUserKey();
  const record = training.completions[key] || {};
  const steps = new Set(record.steps || []);
  if (done) steps.add(stepId); else steps.delete(stepId);
  const now = new Date().toISOString();
  record.steps = [...steps].filter(id => training.steps.some(step => step.id === id));
  record.updatedAt = now;
  record.by = learningUser()?.displayName || '';
  if (training.steps.length && record.steps.length >= training.steps.length) { record.completedAt = record.completedAt || now; showToast('Trilha concluída!'); }
  else record.completedAt = null;
  if (record.steps.length) training.completions[key] = record;
  else delete training.completions[key];
  saveLearning(); renderLearning();
}
function completeTraining(trainingId) {
  const training = learningData.trainings.find(item => item.id === trainingId);
  if (!training || !training.steps.length) return;
  const completion = trainingCompletion(training);
  if (completion.percent < 100 && !confirm(`Marcar todas as ${training.steps.length} etapas de "${training.title}" como concluídas?`)) return;
  const now = new Date().toISOString();
  training.completions[learningUserKey()] = { steps: training.steps.map(step => step.id), updatedAt: now, completedAt: now, by: learningUser()?.displayName || '' };
  saveLearning(); renderLearning(); showToast('Trilha concluída!');
}
function resetTraining(trainingId) {
  const training = learningData.trainings.find(item => item.id === trainingId);
  if (!training || !confirm(`Refazer a trilha "${training.title}"? Seu progresso atual será apagado.`)) return;
  delete training.completions[learningUserKey()];
  saveLearning(); renderLearning(); showToast('Trilha reiniciada');
}
function downloadTrainingCertificate(trainingId) {
  const training = learningData.trainings.find(item => item.id === trainingId);
  if (!training) return;
  const completion = trainingCompletion(training);
  if (completion.percent < 100) { showToast('Conclua todas as etapas para emitir o certificado', 'warning'); return; }
  const name = learningUser()?.displayName || 'Colaborador';
  const date = completion.completedAt ? new Date(completion.completedAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : new Date().toLocaleDateString('pt-BR');
  const win = window.open('', '_blank');
  if (!win) { showToast('Libere pop-ups para emitir o certificado', 'warning'); return; }
  win.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Certificado · ${escapeHtml(training.title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef4f4;font-family:Georgia,'Times New Roman',serif;color:#17232f}article{background:#fff;width:min(920px,92vw);padding:64px 72px;border:14px solid #0b8f87;text-align:center}h1{font:700 15px 'Segoe UI',sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#0b8f87;margin:0 0 6px}p{margin:10px 0;font-size:16px;color:#52616a}h2{font-size:40px;margin:26px 0 8px;line-height:1.2}h3{font-size:28px;margin:14px 0 26px;color:#0b8f87}.line{height:1px;background:#d8e2e3;margin:34px auto;max-width:520px}.sig{display:flex;justify-content:center;gap:80px;font:600 12px 'Segoe UI',sans-serif;color:#52616a}.sig span{border-top:1px solid #9fb0b5;padding-top:8px;min-width:190px}small{display:block;font:600 11px 'Segoe UI',sans-serif;color:#89969d;margin-top:30px}@media print{body{background:#fff}article{border-width:10px}}</style></head><body><article><h1>Rede Saúde · Portal do Setor</h1><p>Certificamos que</p><h2>${escapeHtml(name)}</h2><p>concluiu a trilha de treinamento</p><h3>${escapeHtml(training.title)}</h3><p>${training.steps.length} etapas · ${escapeHtml(training.category)} · carga estimada de ${training.steps.length * 15} minutos</p><div class="line"></div><div class="sig"><span>${escapeHtml(name)}</span><span>Coordenação do setor</span></div><small>Emitido em ${date} pelo Portal do Setor</small></article></body></html>`);
  win.document.close(); win.focus(); setTimeout(() => win.print(), 500);
}
function renderTrainingSteps() {
  const host = $('#trainingSteps'); if (!host) return;
  host.innerHTML = trainingDraftSteps.length
    ? trainingDraftSteps.map((step, index) => `<div class="training-step-draft-row"><span>${index + 1}. ${escapeHtml(step.text)}</span><button type="button" data-training-draft-remove="${index}" aria-label="Remover etapa">×</button></div>`).join('')
    : '<p class="training-step-empty">Nenhuma etapa ainda. Adicione pelo menos uma para acompanhar o progresso.</p>';
}
function addTrainingDraftStep() {
  const input = $('#trainingStepInput'); if (!input) return;
  const text = input.value.trim(); if (!text) return;
  trainingDraftSteps.push({ id: newId(), text });
  input.value = ''; renderTrainingSteps(); input.focus();
}
function openTrainingDialog(training = null) {
  if (training && !trainingVisible(training)) return;
  editingTrainingId = training?.id || null;
  trainingDraftSteps = (training?.steps || []).map(step => ({ ...step }));
  renderTrainingCategories();
  const manager = learningManager();
  const sectors = learningSectorOptions();
  const wrap = $('#trainingSectorWrap');
  if (wrap) wrap.classList.toggle('hidden', !manager);
  const sector = $('#trainingSector');
  if (sector) {
    sector.innerHTML = '<option value="all">Todo o setor</option>' + sectors.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
    sector.value = training?.sectorId || (manager ? 'all' : (learningSectors()[0] || 'all'));
  }
  $('#trainingEyebrow').textContent = training ? 'EDITAR TRILHA' : 'NOVA TRILHA';
  $('#trainingDialogTitle').textContent = training ? 'Atualizar trilha' : 'Criar trilha de treinamento';
  $('#trainingTitle').value = training?.title || '';
  $('#trainingDescription').value = training?.description || '';
  const category = $('#trainingCategory');
  category.value = training?.category && [...category.options].some(option => option.value === training.category) ? training.category : category.options[0]?.value || 'Processos';
  $('#trainingRequired').checked = !!training?.required;
  $('#trainingStepInput').value = '';
  renderTrainingSteps();
  $('#trainingDialog').showModal();
  $('#trainingTitle').focus();
}
function saveTrainingFromForm(event) {
  event.preventDefault();
  const title = $('#trainingTitle').value.trim();
  if (!title) return;
  const manager = learningManager();
  const sectorId = manager ? ($('#trainingSector').value || 'all') : (learningSectors()[0] || 'all');
  const values = { title, description: $('#trainingDescription').value.trim(), category: $('#trainingCategory').value || 'Processos', required: $('#trainingRequired').checked, sectorId, steps: trainingDraftSteps.map(step => ({ id: step.id, text: step.text })) };
  if (editingTrainingId) {
    const training = learningData.trainings.find(item => item.id === editingTrainingId);
    if (training) {
      Object.assign(training, values, { updatedAt: new Date().toISOString() });
      Object.values(training.completions || {}).forEach(record => { record.steps = (record.steps || []).filter(id => training.steps.some(step => step.id === id)); });
      showToast('Trilha atualizada');
    }
  } else {
    learningData.trainings.unshift({ id: newId(), ...values, createdBy: learningUser()?.displayName || '', createdAt: new Date().toISOString(), completions: {} });
    showToast('Trilha criada');
  }
  saveLearning(); $('#trainingDialog').close(); renderLearning();
}
function seedTrainings() {
  if (learningData.trainings.length) return;
  if (!confirm('Criar três trilhas de exemplo para o setor?')) return;
  const sectorId = learningManager() ? 'all' : (learningSectors()[0] || 'all');
  const samples = [
    { title: 'Onboarding do setor', description: 'Caminho inicial para quem chega: entender o portal, acompanhar o fluxo e registrar a primeira demanda com segurança.', category: 'Processos', required: true, steps: ['Conhecer o portal e onde cada demanda é registrada', 'Ler as anotações de "Como fazemos" do setor', 'Acompanhar uma demanda do início à conclusão com alguém experiente', 'Registrar a primeira demanda sozinho e revisar com o responsável'] },
    { title: 'LGPD no dia a dia', description: 'Cuidados obrigatórios no tratamento de dados de beneficiários e empresas dentro do setor.', category: 'Compliance e LGPD', required: true, steps: ['Saber quais dados podem ser acessados no seu dia a dia', 'Nunca compartilhar planilhas ou prints com dados fora do setor', 'Encaminhar dúvidas sobre dados pessoais à gerência'] },
    { title: 'Rotina de faturamento e cobrança', description: 'Passo a passo para conferir competências, montar a mala direta e registrar a cobrança no portal.', category: 'Financeiro', required: false, steps: ['Conferir as competências em aberto no sistema financeiro', 'Gerar a mala direta e revisar empresa, e-mail e valores', 'Registrar a cobrança no histórico do portal'] },
  ];
  samples.forEach(sample => learningData.trainings.push({ id: newId(), title: sample.title, description: sample.description, category: sample.category, required: sample.required, sectorId, createdBy: 'Portal', createdAt: new Date().toISOString(), steps: sample.steps.map(text => ({ id: newId(), text })), completions: {} }));
  saveLearning(); renderLearning(); showToast('Trilhas de exemplo criadas');
}
function renderLearning() {
  normalizeLearning();
  const query = ($('#learningSearch')?.value || '').trim().toLowerCase();
  $('#clearLearningSearch')?.classList.toggle('hidden', !query);
  const visible = learningData.trainings.filter(trainingVisible);
  $('#countTrainings').textContent = visible.length;
  $('#countResources').textContent = learningData.resources.length;
  $('#countNotes').textContent = learningData.notes.length;
  $('#countFlows').textContent = learningData.flows.length;
  renderTrainingKpis(visible);
  renderTrainings();
  const resources = learningData.resources.filter(item => !query || String(item.name).toLowerCase().includes(query));
  $('#learningResources').innerHTML = resources.map(item => `<div class="resource-item"><span class="resource-icon">${resourceKind(item)}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.size || '')} · ${new Date(item.createdAt || Date.now()).toLocaleDateString('pt-BR')}</small></div><button class="icon-action" data-learning-delete="resource" data-index="${learningData.resources.indexOf(item)}">×</button><a class="icon-action" href="${item.data}" download="${escapeHtml(item.name)}">Baixar</a></div>`).join('');
  $('#learningEmpty').classList.toggle('hidden', resources.length > 0);
  const links = learningData.links.filter(item => !query || `${item.title} ${item.url}`.toLowerCase().includes(query));
  $('#learningLinks').innerHTML = links.map(item => `<div class="resource-item"><span class="resource-icon link-icon">↗</span><div><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer"><strong>${escapeHtml(item.title)}</strong></a><small>${escapeHtml(item.url)}</small></div><button class="icon-action" data-link-edit="${learningData.links.indexOf(item)}" aria-label="Editar link">✎</button><button class="icon-action" data-learning-delete="link" data-index="${learningData.links.indexOf(item)}">×</button></div>`).join('');
  $('#linksEmpty').classList.toggle('hidden', links.length > 0);
  const notes = learningData.notes.filter(item => !query || `${item.title} ${item.text}`.toLowerCase().includes(query));
  $('#learningNotes').innerHTML = notes.map(item => `<article class="learning-note"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text).replace(/\n/g, '<br>')}</p></div><div class="note-actions"><button class="icon-action" data-note-edit="${learningData.notes.indexOf(item)}" aria-label="Editar anotação">✎</button><button class="icon-action" data-learning-delete="note" data-index="${learningData.notes.indexOf(item)}">×</button></div></article>`).join('');
  $('#notesEmpty').classList.toggle('hidden', notes.length > 0);
  setLearningTab(learningTab);
  renderFlow();
}
function setLearningTab(tab) {
  learningTab = ['trainings', 'library', 'notes', 'flows', 'tools'].includes(tab) ? tab : 'trainings';
  document.querySelectorAll('[data-learning-tab]').forEach(button => { const active = button.dataset.learningTab === learningTab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('[data-learning-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.learningPanel !== learningTab));
  if (learningTab === 'flows') renderFlow();
}
function activeFlow() { return learningData.flows.find(flow => flow.id === learningData.activeFlowId) || learningData.flows[0]; }
let flowSourceId = null;
function renderFlow() { const canvas = $('#flowCanvas'); if (!canvas) return; const flow = activeFlow(); const edges = $('#flowEdges'); const width = Math.max(canvas.clientWidth || 800, 800); const height = Math.max(canvas.clientHeight || 420, 420); edges.setAttribute('viewBox', `0 0 ${width} ${height}`); edges.innerHTML = '<defs><marker id="flowArrow" markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto"><path d="M0,0 L0,14 L14,7 z" fill="#0b8f87"/></marker></defs>' + flow.edges.map(edge => { const from = flow.nodes.find(node => node.id === edge.from); const to = flow.nodes.find(node => node.id === edge.to); if (!from || !to) return ''; const startX = from.x + 90; const startY = from.y + 38; const endX = to.x + 90; const endY = to.y + 38; const bend = Math.max(Math.abs(endX - startX) * .35, 40); return `<path d="M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}" fill="none" stroke="#0b8f87" stroke-width="4" stroke-linecap="round" marker-end="url(#flowArrow)"/>`; }).join(''); $('#flowNodes').innerHTML = flow.nodes.map(node => `<button class="flow-node shape-${node.shape || 'process'} ${node.id === flowSourceId ? 'selected' : ''}" data-flow-node="${node.id}" style="left:${node.x}px;top:${node.y}px">${escapeHtml(node.label)}<span>×</span></button>`).join(''); $('#flowSelector').innerHTML = learningData.flows.map(item => `<option value="${item.id}" ${item.id === learningData.activeFlowId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join(''); }
function addFlowNode() { const flow = activeFlow(); const label = prompt('Nome da etapa:'); if (!label?.trim()) return; flow.nodes.push({ id: newId(), label: label.trim(), shape: $('#flowShape').value || 'process', x: 30 + (flow.nodes.length % 4) * 190, y: 35 + Math.floor(flow.nodes.length / 4) * 90 }); saveLearning(); renderFlow(); }
function createFlow() { const name = prompt('Nome do novo fluxograma:'); if (!name?.trim()) return; const flow = { id: newId(), name: name.trim(), nodes: [], edges: [] }; learningData.flows.push(flow); learningData.activeFlowId = flow.id; saveLearning(); renderFlow(); }
function renameFlow() { const flow = activeFlow(); const name = prompt('Novo nome do fluxograma:', flow.name); if (name?.trim()) { flow.name = name.trim(); saveLearning(); renderFlow(); } }
function openNoteDialog(index = null) {
  editingNoteIndex = Number.isInteger(index) ? index : null;
  const note = editingNoteIndex !== null ? learningData.notes[editingNoteIndex] : null;
  $('#noteEyebrow').textContent = note ? 'EDITAR ANOTAÇÃO' : 'NOVA ANOTAÇÃO';
  $('#noteDialogTitle').textContent = note ? 'Atualizar anotação' : 'Registrar como fazemos';
  $('#noteTitleInput').value = note?.title || '';
  $('#noteTextInput').value = note?.text || '';
  $('#noteDialog').showModal();
  $('#noteTitleInput').focus();
}
function saveNoteFromForm(event) {
  event.preventDefault();
  const title = $('#noteTitleInput').value.trim();
  const text = $('#noteTextInput').value.trim();
  if (!title || !text) return;
  if (editingNoteIndex !== null && learningData.notes[editingNoteIndex]) Object.assign(learningData.notes[editingNoteIndex], { title, text, updatedAt: Date.now() });
  else learningData.notes.unshift({ title, text, createdAt: Date.now() });
  editingNoteIndex = null;
  saveLearning(); $('#noteDialog').close(); renderLearning();
  showToast('Anotação salva');
}
function openLinkDialog(index = null) {
  editingLinkIndex = Number.isInteger(index) ? index : null;
  const link = editingLinkIndex !== null ? learningData.links[editingLinkIndex] : null;
  $('#linkEyebrow').textContent = link ? 'EDITAR LINK' : 'NOVO LINK';
  $('#linkDialogTitle').textContent = link ? 'Atualizar referência' : 'Adicionar referência';
  $('#linkTitleInput').value = link?.title || '';
  $('#linkUrlInput').value = link?.url || '';
  $('#linkDialog').showModal();
  $('#linkTitleInput').focus();
}
function saveLinkFromForm(event) {
  event.preventDefault();
  const title = $('#linkTitleInput').value.trim();
  const url = $('#linkUrlInput').value.trim();
  if (!title || !url) return;
  if (editingLinkIndex !== null && learningData.links[editingLinkIndex]) Object.assign(learningData.links[editingLinkIndex], { title, url });
  else learningData.links.unshift({ title, url });
  editingLinkIndex = null;
  saveLearning(); $('#linkDialog').close(); renderLearning();
  showToast('Link salvo');
}
function addLearningNote() { openNoteDialog(); }
function addLearningLink() { openLinkDialog(); }
function handleLearningFiles(files) { [...files].forEach(file => { if (file.size > 4 * 1024 * 1024) { alert(`${file.name} é maior que 4 MB e não foi adicionado. Use um arquivo menor para manter o armazenamento local estável.`); return; } const reader = new FileReader(); reader.onload = () => { learningData.resources.unshift({ name: file.name, type: file.type, size: `${Math.ceil(file.size / 1024)} KB`, data: reader.result, createdAt: Date.now() }); saveLearning(); renderLearning(); }; reader.readAsDataURL(file); }); }
function downloadFile(name, content, type) { const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([content], { type })); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function exportJson() { downloadFile(`backup-plantao-${today()}.json`, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks, billingHistory, mergeRows, learningData }, null, 2), 'application/json;charset=utf-8'); }
function importJson(file) { const reader = new FileReader(); reader.onload = () => { try { const backup = JSON.parse(reader.result); if (!Array.isArray(backup.tasks) || !Array.isArray(backup.billingHistory) || !Array.isArray(backup.mergeRows) || !backup.learningData) throw new Error('formato'); tasks = backup.tasks; billingHistory = backup.billingHistory; mergeRows = backup.mergeRows; learningData = backup.learningData; localStorage.setItem(HISTORY_KEY, JSON.stringify(billingHistory)); localStorage.setItem(MERGE_QUEUE_KEY, JSON.stringify(mergeRows)); localStorage.setItem(LEARNING_KEY, JSON.stringify(learningData)); save(); saveHistory(); saveMergeQueue(); saveLearning(); render(); renderHistory(); renderMergePreview(); renderLearning(); alert('Backup restaurado com sucesso.'); } catch { alert('Este arquivo não é um backup JSON válido da Intranet Rede Saúde.'); } }; reader.readAsText(file, 'utf-8'); }
function taskStatusLabel(status) { return status === 'done' ? 'CONCLUÍDA' : status === 'progress' ? 'EM ANDAMENTO' : 'PENDENTE'; }
function exportTxt() { const selected = tasks.filter(task => task.due === today()); const lines = [`CHECKLIST DE ATIVIDADES ${new Date().toLocaleDateString('pt-BR')}`, '']; selected.forEach(task => lines.push(`* [${taskStatusLabel(task.status)}] ${task.title} — Responsável: ${task.owner}`)); if (!selected.length) lines.push('Nenhuma atividade cadastrada para hoje.'); downloadFile('checklist-atividades-hoje.txt', lines.join('\n'), 'text/plain;charset=utf-8'); }
function csvCell(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function chartImage(title, labels, values, color) { const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 300; const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#17232f'; context.font = 'bold 22px Arial'; context.fillText(title, 24, 34); const max = Math.max(...values, 1); labels.forEach((label, index) => { const y = 70 + index * 65; const width = values[index] ? Math.max(values[index] / max * 500, 12) : 0; context.fillStyle = '#edf1f2'; context.fillRect(150, y, 500, 28); context.fillStyle = color[index % color.length]; context.fillRect(150, y, width, 28); context.fillStyle = '#52616a'; context.font = '16px Arial'; context.fillText(label, 24, y + 20); context.fillStyle = '#17232f'; context.font = 'bold 16px Arial'; context.fillText(String(values[index]), 665, y + 20); }); return canvas.toDataURL('image/png'); }
async function exportXlsx() {
  if (!window.ExcelJS) throw new Error('ExcelJS não foi carregado pelas CDNs');
  const selected = reportTasks();
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Intranet Rede Saúde';
  const detail = workbook.addWorksheet('Demandas');
  detail.columns = [{ header: 'Demanda', key: 'title', width: 46 }, { header: 'Setor', key: 'sector', width: 20 }, { header: 'Prazo', key: 'due', width: 13 }, { header: 'Responsável', key: 'owner', width: 18 }, { header: 'Prioridade', key: 'priority', width: 12 }, { header: 'Status', key: 'status', width: 15 }, { header: 'Criada em', key: 'created', width: 19 }, { header: 'Concluída em', key: 'completed', width: 19 }, { header: 'Dias até concluir', key: 'cycle', width: 14 }, { header: 'Observação', key: 'notes', width: 46 }];
  detail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F78' } };
  selected.forEach(task => detail.addRow({ title: task.title, sector: reportSectorLabel(task.sectorId), due: task.periodEnd || task.due, owner: task.owner, priority: priorityNames[task.priority], status: task.status === 'done' ? 'Concluída' : task.status === 'progress' ? 'Em andamento' : 'Pendente', created: dateTimeLabel(task.createdAt), completed: dateTimeLabel(task.completedAt), cycle: reportCycleDays(task) ?? '', notes: task.notes }));
  detail.autoFilter = 'A1:J1';

  const summary = workbook.addWorksheet('Resumo');
  summary.getCell('A1').value = 'RELATÓRIO DO PLANTÃO'; summary.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF087F78' } };
  summary.getCell('A2').value = `Período: ${$('#reportStart').value || 'início'} até ${$('#reportEnd').value || 'fim'}${$('#reportSector').value !== 'all' ? ` · Setor: ${reportSectorLabel($('#reportSector').value)}` : ''}`;
  summary.getCell('A3').value = 'Indicador'; summary.getCell('B3').value = 'Valor';
  summary.getRow(3).font = { bold: true };
  const doneInRange = selected.filter(t => t.status === 'done' && t.completedAt && reportDateInRange(t.completedAt.slice(0, 10), $('#reportStart').value, $('#reportEnd').value));
  const openNow = selected.filter(t => t.status !== 'done');
  const lateNow = openNow.filter(t => (t.periodEnd || t.due) < today());
  [['Total de demandas no período', selected.length], ['Concluídas no período', doneInRange.length], ['Em aberto agora', openNow.length], ['Atrasadas agora', lateNow.length], ['Taxa de conclusão', `${selected.length ? Math.round(doneInRange.length / selected.length * 100) : 0}%`], ['Ciclo médio (dias)', reportAvgCycle(doneInRange) === null ? '—' : Number(reportAvgCycle(doneInRange).toFixed(1))]].forEach(row => summary.addRow(row));
  const statusLabels = ['Pendentes', 'Andamento', 'Concluídas'];
  const statusValues = [selected.filter(t => normalizedStatus(t) === 'todo').length, selected.filter(t => normalizedStatus(t) === 'progress').length, selected.filter(t => normalizedStatus(t) === 'done').length];
  const ownerCounts = [...selected.reduce((map, task) => { const name = task.owner || 'Sem responsável'; map.set(name, (map.get(name) || 0) + 1); return map; }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const statusImage = workbook.addImage({ base64: chartImage('Status das demandas', statusLabels, statusValues, ['#c88921', '#3d72b8', '#0b8f87']), extension: 'png' });
  const ownerImage = workbook.addImage({ base64: chartImage('Distribuição por responsável', ownerCounts.map(([name]) => name), ownerCounts.map(([, value]) => value), ['#0b8f87', '#3d72b8', '#c88921', '#89969d']), extension: 'png' });
  summary.addImage(statusImage, 'A11:H25');
  summary.addImage(ownerImage, 'A27:H41');
  summary.getColumn(1).width = 32; summary.getColumn(2).width = 22;

  const peopleSheet = workbook.addWorksheet('Por pessoa');
  peopleSheet.columns = [{ header: 'Pessoa', key: 'name', width: 26 }, { header: 'No período', key: 'total', width: 11 }, { header: 'Concluídas', key: 'done', width: 12 }, { header: 'Em aberto', key: 'open', width: 11 }, { header: 'Atrasadas', key: 'late', width: 11 }, { header: 'Taxa de conclusão', key: 'rate', width: 16 }, { header: 'Ciclo médio (dias)', key: 'cycle', width: 15 }];
  peopleSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  peopleSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F78' } };
  const xlsxPeople = reportPeopleList(selected);
  const xlsxOwnerIndex = reportOwnerIndex(xlsxPeople);
  xlsxPeople.forEach(person => {
    const list = selected.filter(task => reportOwnerName(task, xlsxOwnerIndex) === person.displayName);
    const done = list.filter(task => task.status === 'done');
    const open = list.filter(task => task.status !== 'done');
    const avg = reportAvgCycle(done);
    peopleSheet.addRow({ name: person.displayName, total: list.length, done: done.length, open: open.length, late: open.filter(task => (task.periodEnd || task.due) < today()).length, rate: `${list.length ? Math.round(done.length / list.length * 100) : 0}%`, cycle: avg === null ? '—' : Number(avg.toFixed(1)) });
  });
  peopleSheet.autoFilter = 'A1:G1';

  const buffer = await workbook.xlsx.writeBuffer();
  downloadFile(`relatorio-demandas-${today()}.xlsx`, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
function chart(target, values, colors) {
  const host = $(target); if (!host) return;
  if (!values.length || !values.some(item => Number(item.value) > 0)) { host.innerHTML = '<p class="report-empty">Sem dados no período.</p>'; return; }
  const max = Math.max(...values.map(item => Number(item.value) || 0), 1);
  host.innerHTML = values.map((item, index) => {
    const value = Number(item.value) || 0;
    return `<div class="bar-row"><span>${escapeHtml(item.label)}</span><div class="bar-track"><i style="width:${Math.max(value / max * 100, value ? 8 : 0)}%;background:${colors[index % colors.length]}"></i></div><strong>${escapeHtml(item.display ?? String(item.value))}</strong></div>`;
  }).join('');
}
function reportSectorLabel(id) {
  if (!id) return 'Sem setor';
  const known = { cadastro: 'Cadastro', financeiro: 'Financeiro', gerencia: 'Gerência', credenciamento: 'Credenciamento', 'cadastro-faturamento': 'Cadastro e Faturamento' };
  const user = window.PortalAccess?.Access?.user;
  const pool = [...(window.PortalAccess?.Access?.sectors || []), ...(user?.sectors || [])];
  return pool.find(item => item?.id === id)?.name || known[id] || id;
}
function reportDayDiff(a, b) { if (!a || !b) return NaN; return Math.round((new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / 864e5); }
function reportShiftDate(date, days) { const base = new Date(`${date}T12:00:00`); base.setDate(base.getDate() + days); return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`; }
function reportCycleDays(task) { const start = task.createdAt?.slice(0, 10) || task.periodStart || task.due; const end = task.completedAt?.slice(0, 10); if (!start || !end) return null; const diff = reportDayDiff(end, start); return Number.isFinite(diff) ? Math.max(0, diff) : null; }
function reportAvgCycle(list) { const values = list.map(reportCycleDays).filter(value => value !== null); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function reportFormatDays(value) { return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(1).replace('.', ',')} d`; }
function reportPrevRange(start, end) {
  if (!start || !end) return null;
  const length = Math.max(1, (reportDayDiff(end, start) || 0) + 1);
  const prevEnd = reportShiftDate(start, -1);
  return { start: reportShiftDate(prevEnd, -(length - 1)), end: prevEnd };
}
function reportDelta(current, previous, suffix = '', invert = false) {
  if (previous === null || previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous)) return '';
  const diff = current - previous;
  const shown = Math.abs(diff) >= 10 || Number.isInteger(diff) ? Math.round(diff) : Math.round(diff * 10) / 10;
  const good = invert ? diff < 0 : diff > 0;
  const bad = invert ? diff > 0 : diff < 0;
  return `<span class="kpi-delta ${good ? 'up' : bad ? 'down' : ''}">${shown > 0 ? '+' : ''}${String(shown).replace('.', ',')}${suffix} vs. período anterior</span>`;
}
function syncReportSectorFilter() {
  const wrap = $('#reportSectorWrap'); const select = $('#reportSector'); if (!wrap || !select) return;
  const user = window.PortalAccess?.Access?.user;
  const manager = user?.role === 'admin' || !!user?.management;
  wrap.classList.toggle('hidden', !manager);
  if (!manager) { select.value = 'all'; return; }
  const current = select.value;
  const ids = [...new Set(scopedTasks().map(task => task.sectorId).filter(Boolean))].sort((a, b) => reportSectorLabel(a).localeCompare(reportSectorLabel(b)));
  select.innerHTML = '<option value="all">Todos os setores</option>' + ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(reportSectorLabel(id))}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}
function reportPeopleList(selected) {
  const user = window.PortalAccess?.Access?.user;
  const manager = user?.role === 'admin' || !!user?.management;
  const pool = manager ? (window.__portalUsers?.length ? window.__portalUsers : [user, ...(user?.teammates || [])]) : [user, ...(user?.teammates || [])];
  const map = new Map();
  pool.filter(person => person?.displayName && !window.isHiddenTaskOwner?.(person.displayName)).forEach(person => { const key = normalizeOwner(person.displayName); if (!map.has(key)) map.set(key, person); });
  selected.forEach(task => { const raw = task.owner || 'Sem responsável'; const key = normalizeOwner(raw); if (!map.has(key) && !window.isHiddenTaskOwner?.(raw)) map.set(key, { displayName: raw }); });
  return [...map.values()];
}
function reportOwnerIndex(people) { const index = new Map(); people.forEach(person => { const key = normalizeOwner(person.displayName); if (!index.has(key)) index.set(key, person.displayName); }); return index; }
function reportOwnerName(task, index) { const raw = task.owner || 'Sem responsável'; return index.get(normalizeOwner(raw)) || raw; }
function reportAgingBuckets(open) {
  const buckets = [{ label: 'Até 2 dias', min: 0, max: 2 }, { label: '3 a 7 dias', min: 3, max: 7 }, { label: '8 a 15 dias', min: 8, max: 15 }, { label: '16+ dias', min: 16, max: Infinity }];
  const ages = open.map(task => { const start = task.createdAt?.slice(0, 10) || task.periodStart || task.due; const age = start ? reportDayDiff(today(), start) : 0; return Number.isFinite(age) ? Math.max(0, age) : 0; });
  return buckets.map(bucket => ({ label: bucket.label, value: ages.filter(age => age >= bucket.min && age <= bucket.max).length }));
}
function renderReportTrend(selected, start, end) {
  const host = $('#trendChart'); if (!host) return;
  const dates = selected.flatMap(task => [task.createdAt?.slice(0, 10), task.completedAt?.slice(0, 10)]).filter(Boolean).sort();
  const from = start || dates[0] || reportShiftDate(today(), -29);
  const to = end || dates[dates.length - 1] || today();
  const span = reportDayDiff(to, from);
  const buckets = [];
  if (span > 62) {
    const [fromYear, fromMonth] = from.slice(0, 7).split('-').map(Number);
    const [toYear, toMonth] = to.slice(0, 7).split('-').map(Number);
    let year = fromYear, month = fromMonth;
    while (year < toYear || (year === toYear && month <= toMonth)) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      buckets.push({ key, label: `${new Date(`${key}-01T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}/${String(year).slice(2)}` });
      month += 1; if (month > 12) { month = 1; year += 1; }
    }
  } else {
    for (let date = from; date <= to; date = reportShiftDate(date, 1)) {
      const parsed = new Date(`${date}T12:00:00`);
      buckets.push({ key: date, label: `${String(parsed.getDate()).padStart(2, '0')}/${String(parsed.getMonth() + 1).padStart(2, '0')}` });
    }
  }
  if (!buckets.length) buckets.push({ key: today(), label: dateLabel(today()) });
  const keyOf = date => span > 62 ? date.slice(0, 7) : date;
  const createdMap = {}, doneMap = {};
  selected.forEach(task => {
    const created = task.createdAt?.slice(0, 10); if (created) { const key = keyOf(created); createdMap[key] = (createdMap[key] || 0) + 1; }
    const done = task.completedAt?.slice(0, 10); if (done) { const key = keyOf(done); doneMap[key] = (doneMap[key] || 0) + 1; }
  });
  if (!buckets.some(bucket => createdMap[bucket.key] || doneMap[bucket.key])) { host.innerHTML = '<div class="trend-chart-empty">Sem criações ou conclusões no período.</div>'; return; }
  const width = 680, height = 210, left = 28, right = 8, top = 10, bottom = 24;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(1, ...buckets.map(bucket => Math.max(createdMap[bucket.key] || 0, doneMap[bucket.key] || 0)));
  const x = index => left + (buckets.length === 1 ? plotWidth / 2 : index * plotWidth / (buckets.length - 1));
  const y = value => top + (1 - value / max) * plotHeight;
  const points = map => buckets.map((bucket, index) => `${x(index).toFixed(1)},${y(map[bucket.key] || 0).toFixed(1)}`).join(' ');
  const area = map => { const list = points(map).split(' '); return `M ${list[0]} L ${list.slice(1).join(' L ')} L ${x(buckets.length - 1).toFixed(1)} ${y(0).toFixed(1)} L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`; };
  const grid = [0, 0.5, 1].map(ratio => { const lineY = top + plotHeight * (1 - ratio); return `<line class="grid-line" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"></line><text class="axis-label" x="${left - 6}" y="${lineY + 3}" text-anchor="end">${Math.round(max * ratio)}</text>`; }).join('');
  const labelStep = Math.max(1, Math.ceil(buckets.length / 7));
  const labels = buckets.map((bucket, index) => (index % labelStep === 0 || index === buckets.length - 1) ? `<text class="axis-label" x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(bucket.label)}</text>` : '').join('');
  const dots = (map, cls) => buckets.map((bucket, index) => { const value = map[bucket.key] || 0; return value ? `<circle class="${cls}" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3.2"><title>${escapeHtml(bucket.label)}: ${value}</title></circle>` : ''; }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Demandas criadas e concluídas ao longo do período">${grid}<path d="${area(doneMap)}" fill="#0b8f8714"></path><path d="${area(createdMap)}" fill="#3d72b810"></path><polyline points="${points(createdMap)}" fill="none" stroke="#3d72b8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline><polyline points="${points(doneMap)}" fill="none" stroke="#0b8f87" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>${dots(createdMap, 'point-created')}${dots(doneMap, 'point-done')}${labels}</svg>`;
}
function renderStatusDonut(selected) {
  const host = $('#statusChart'); if (!host) return;
  const rows = [{ key: 'todo', label: 'Pendentes', color: '#c88921' }, { key: 'progress', label: 'Em andamento', color: '#3d72b8' }, { key: 'done', label: 'Concluídas', color: '#0b8f87' }].map(row => ({ ...row, value: selected.filter(task => normalizedStatus(task) === row.key).length }));
  const total = selected.length;
  const circumference = 2 * Math.PI * 48;
  let offset = 0;
  const segments = rows.map(row => {
    const dash = (total ? row.value / total : 0) * circumference;
    const segment = `<circle cx="60" cy="60" r="48" fill="none" stroke="${row.color}" stroke-width="15" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)"></circle>`;
    offset += dash;
    return segment;
  }).join('');
  host.innerHTML = `<svg class="donut-svg" viewBox="0 0 120 120" role="img" aria-label="Distribuição por status"><circle cx="60" cy="60" r="48" fill="none" stroke="var(--line)" stroke-width="15"></circle>${segments}<text class="donut-center" x="60" y="61" text-anchor="middle">${total}</text><text class="donut-center-label" x="60" y="75" text-anchor="middle">DEMANDAS</text></svg><div class="donut-legend">${rows.map(row => `<button type="button" data-report-status="${row.key}"><i style="background:${row.color}"></i><span>${row.label}<small>${total ? Math.round(row.value / total * 100) : 0}% do período</small></span><strong>${row.value}</strong></button>`).join('')}</div>`;
}
function renderOwnerBars(selected, people) {
  const host = $('#ownerChart'); if (!host) return;
  const index = reportOwnerIndex(people);
  const names = [...new Set([...people.map(person => reportOwnerName({ owner: person.displayName }, index)), ...selected.map(task => reportOwnerName(task, index))].filter(Boolean))];
  const rows = names.map(name => {
    const list = selected.filter(task => reportOwnerName(task, index) === name);
    return { name, total: list.length, todo: list.filter(task => normalizedStatus(task) === 'todo').length, progress: list.filter(task => normalizedStatus(task) === 'progress').length, done: list.filter(task => normalizedStatus(task) === 'done').length };
  }).sort((a, b) => b.total - a.total).slice(0, 8);
  if (!rows.length) { host.innerHTML = '<p class="report-empty">Sem demandas no período.</p>'; return; }
  const max = Math.max(1, ...rows.map(row => row.total));
  host.innerHTML = rows.map(row => {
    const share = value => row.total ? (value / row.total * 100) : 0;
    return `<button type="button" class="owner-row" data-report-owner="${escapeHtml(row.name)}"><span class="owner-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span class="owner-track"><span class="owner-stack" style="width:${Math.max(row.total / max * 100, row.total ? 4 : 0)}%">${row.todo ? `<i class="st-todo" style="width:${share(row.todo)}%"></i>` : ''}${row.progress ? `<i class="st-progress" style="width:${share(row.progress)}%"></i>` : ''}${row.done ? `<i class="st-done" style="width:${share(row.done)}%"></i>` : ''}</span></span><strong>${row.total}</strong></button>`;
  }).join('') + '<div class="owner-legend"><span><i class="legend-dot st-todo"></i>Pendentes</span><span><i class="legend-dot st-progress"></i>Em andamento</span><span><i class="legend-dot st-done"></i>Concluídas</span></div>';
}
function renderLateList(open) {
  const host = $('#lateList'); if (!host) return;
  const list = open.filter(task => (task.periodEnd || task.due) < today()).sort((a, b) => (a.periodEnd || a.due).localeCompare(b.periodEnd || b.due)).slice(0, 5);
  host.innerHTML = list.length ? list.map(task => {
    const due = task.periodEnd || task.due;
    const days = Math.abs(reportDayDiff(today(), due));
    return `<button type="button" class="report-list-item" data-report-task="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.owner || 'Sem responsável')} · venceu em ${dateLabel(due)}</small></span><span class="report-days">${Number.isFinite(days) ? days : 0} d</span></button>`;
  }).join('') : '<p class="report-list-empty">Nenhuma demanda atrasada. Bom sinal.</p>';
}
function renderStaleList(open) {
  const host = $('#staleList'); if (!host) return;
  const list = open.map(task => ({ task, last: (task.updatedAt || task.createdAt || task.periodStart || task.due || '').slice(0, 10) })).filter(item => item.last).sort((a, b) => a.last.localeCompare(b.last)).slice(0, 5);
  host.innerHTML = list.length ? list.map(item => {
    const days = Math.max(0, reportDayDiff(today(), item.last) || 0);
    return `<button type="button" class="report-list-item" data-report-task="${escapeHtml(item.task.id)}"><span><strong>${escapeHtml(item.task.title)}</strong><small>${escapeHtml(item.task.owner || 'Sem responsável')} · sem movimento há ${days} dia(s)</small></span><span class="report-days ${days >= 7 ? '' : 'neutral'}">${days} d</span></button>`;
  }).join('') : '<p class="report-list-empty">Tudo se moveu recentemente.</p>';
}
function renderDailyChart(selected, end) {
  const host = $('#dailyChart'); if (!host) return;
  const last = end || today();
  const days = Array.from({ length: 14 }, (_, index) => reportShiftDate(last, index - 13));
  const doneByDay = {};
  selected.forEach(task => { const date = task.completedAt?.slice(0, 10); if (date) doneByDay[date] = (doneByDay[date] || 0) + 1; });
  const max = Math.max(1, ...days.map(date => doneByDay[date] || 0));
  const total = days.reduce((sum, date) => sum + (doneByDay[date] || 0), 0);
  const bars = days.map((date, index) => {
    const value = doneByDay[date] || 0;
    const parsed = new Date(`${date}T12:00:00`);
    const label = index % 2 === 0 || index === days.length - 1 ? `${String(parsed.getDate()).padStart(2, '0')}/${String(parsed.getMonth() + 1).padStart(2, '0')}` : '';
    return `<div class="daily-bar" title="${dateLabel(date)}: ${value} conclusão(ões)"><span class="daily-col"><i style="height:${value / max * 100}%"></i></span><small>${label}</small></div>`;
  }).join('');
  host.innerHTML = `<div class="daily-bars">${bars}</div><span class="daily-total">${total} conclusões nos últimos 14 dias do período</span>`;
}
function renderPeopleCards(selected, people) {
  const host = $('#individualReports'); if (!host) return;
  if (!people.length) { host.innerHTML = '<p class="report-empty">Ninguém para exibir no período.</p>'; return; }
  const index = reportOwnerIndex(people);
  host.innerHTML = people.map(person => {
    const name = person.displayName;
    const list = selected.filter(task => reportOwnerName(task, index) === name);
    const done = list.filter(task => task.status === 'done');
    const open = list.filter(task => task.status !== 'done');
    const late = open.filter(task => (task.periodEnd || task.due) < today());
    const percent = list.length ? Math.round(done.length / list.length * 100) : 0;
    const avg = reportAvgCycle(done);
    const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('');
    const avatar = person.photo ? `<span class="person-avatar"><img src="${escapeHtml(person.photo)}" alt="${escapeHtml(name)}"></span>` : `<span class="person-avatar">${escapeHtml(initials || '?')}</span>`;
    const role = person.role === 'admin' ? 'Administração' : person.management ? 'Gerência' : (person.sectorName || 'Equipe');
    return `<article class="person-card"><div class="person-card-head">${avatar}<div class="person-ident"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(role)}</small></div><span class="person-ring" style="--pct:${percent}" title="${percent}% concluídas no período"><span>${percent}%</span></span></div><div class="person-stats"><div class="person-stat"><strong>${list.length}</strong><small>no período</small></div><div class="person-stat"><strong>${done.length}</strong><small>concluídas</small></div><div class="person-stat"><strong>${open.length}</strong><small>abertas</small></div><div class="person-stat ${late.length ? 'alert' : ''}"><strong>${late.length}</strong><small>atrasadas</small></div></div><div class="person-card-foot"><small>Ciclo médio: ${reportFormatDays(avg)}</small><button type="button" class="person-open" data-report-owner="${escapeHtml(name)}">Ver demandas</button></div></article>`;
  }).join('');
}
function openReportTasksDialog(title, list, eyebrow = 'DEMANDAS') {
  const host = $('#reportDialogList'); if (!host) return;
  const sorted = [...list].sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.periodEnd || a.due || '').localeCompare(b.periodEnd || b.due || ''));
  const late = sorted.filter(task => task.status !== 'done' && (task.periodEnd || task.due) < today()).length;
  $('#reportDialogTitle').textContent = title;
  $('#reportDialogEyebrow').textContent = eyebrow;
  $('#reportDialogSummary').textContent = `${sorted.length} demanda(s)${late ? ` · ${late} atrasada(s)` : ''} · clique em uma linha para abrir a demanda`;
  host.innerHTML = sorted.length ? sorted.map(task => {
    const due = task.periodEnd || task.due;
    const overdue = task.status !== 'done' && due < today();
    const days = Number.isFinite(reportDayDiff(today(), due)) ? Math.abs(reportDayDiff(today(), due)) : 0;
    const tail = task.status === 'done' ? 'concluída' : overdue ? `${days} d atrasada` : 'no prazo';
    return `<button type="button" class="report-dialog-row" data-report-task="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.owner || 'Sem responsável')} · ${escapeHtml(reportSectorLabel(task.sectorId))} · vence ${dateLabel(due)}</small></span><span class="report-days ${task.status === 'done' || !overdue ? 'neutral' : ''}">${tail}</span></button>`;
  }).join('') : '<p class="report-dialog-empty">Nenhuma demanda nesta seleção.</p>';
  $('#reportTasksDialog').showModal();
}
function openReportDrill(kind) {
  const { start, end } = reportRange();
  const selected = reportTasksForRange(start, end, $('#reportSector')?.value || 'all');
  const active = selected.filter(task => task.status !== 'done');
  const ownerIndex = reportOwnerIndex(reportPeopleList(selected));
  if (kind === 'all') return openReportTasksDialog('Atividade no período', selected, 'PERÍODO');
  if (kind === 'created') return openReportTasksDialog('Criadas no período', selected.filter(task => task.createdAt && reportDateInRange(task.createdAt.slice(0, 10), start, end)), 'CRIADAS');
  if (kind === 'done') return openReportTasksDialog('Concluídas no período', selected.filter(task => task.status === 'done' && task.completedAt && reportDateInRange(task.completedAt.slice(0, 10), start, end)), 'CONCLUÍDAS');
  if (kind === 'open') return openReportTasksDialog('Demandas em aberto', active, 'EM ABERTO');
  if (kind === 'overdue') return openReportTasksDialog('Demandas atrasadas', active.filter(task => (task.periodEnd || task.due) < today()), 'ATRASADAS');
  if (kind.startsWith('status:')) { const status = kind.split(':')[1]; return openReportTasksDialog({ todo: 'Demandas pendentes', progress: 'Demandas em andamento', done: 'Demandas concluídas' }[status] || 'Demandas', selected.filter(task => normalizedStatus(task) === status), 'STATUS'); }
  if (kind.startsWith('owner:')) { const owner = kind.slice(6); return openReportTasksDialog(`Demandas de ${owner}`, selected.filter(task => reportOwnerName(task, ownerIndex) === owner), 'POR PESSOA'); }
}
function setReportPreset(value) {
  const start = $('#reportStart'); const end = $('#reportEnd');
  if (!start || !end) return;
  const now = new Date();
  const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (!value || value === 'all') { start.value = ''; end.value = ''; }
  else if (value === 'week') { const shift = (now.getDay() + 6) % 7; const monday = new Date(now); monday.setDate(now.getDate() - shift); start.value = iso(monday); end.value = today(); }
  else if (value === 'month') { start.value = `${today().slice(0, 7)}-01`; end.value = today(); }
  else if (value === 'year') { start.value = `${today().slice(0, 4)}-01-01`; end.value = today(); }
  else { const days = Number(value); if (!days) return; start.value = iso(new Date(Date.now() - days * 864e5)); end.value = today(); }
  document.querySelectorAll('[data-report-range]').forEach(button => button.classList.toggle('active', button.dataset.reportRange === String(value)));
  const preset = $('#reportPreset'); if (preset) preset.value = ['week', 'month', '30', '90'].includes(String(value)) ? String(value) : '';
  renderReports();
}
function exportReportCsv() {
  const selected = reportTasks();
  const header = ['Demanda', 'Status', 'Prioridade', 'Responsável', 'Setor', 'Início', 'Fim', 'Criada em', 'Concluída em', 'Dias até concluir', 'Observação'];
  const rows = selected.map(task => [task.title, normalizedStatus(task) === 'done' ? 'Concluída' : normalizedStatus(task) === 'progress' ? 'Em andamento' : 'Pendente', priorityNames[task.priority] || task.priority || '', task.owner || 'Sem responsável', reportSectorLabel(task.sectorId), task.periodStart || task.due || '', task.periodEnd || task.due || '', task.createdAt?.slice(0, 10) || '', task.completedAt?.slice(0, 10) || '', reportCycleDays(task) ?? '', task.notes || '']);
  const csv = '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n');
  downloadFile(`relatorio-demandas-${today()}.csv`, csv, 'text/csv;charset=utf-8');
}
function exportPeopleCsv() {
  const selected = reportTasks();
  const header = ['Pessoa', 'No período', 'Concluídas', 'Em aberto', 'Atrasadas', 'Taxa de conclusão', 'Ciclo médio (dias)'];
  const people = reportPeopleList(selected);
  const index = reportOwnerIndex(people);
  const rows = people.map(person => {
    const list = selected.filter(task => reportOwnerName(task, index) === person.displayName);
    const done = list.filter(task => task.status === 'done');
    const open = list.filter(task => task.status !== 'done');
    const avg = reportAvgCycle(done);
    return [person.displayName, list.length, done.length, open.length, open.filter(task => (task.periodEnd || task.due) < today()).length, `${list.length ? Math.round(done.length / list.length * 100) : 0}%`, avg === null ? '' : avg.toFixed(1).replace('.', ',')];
  });
  const csv = '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n');
  downloadFile(`relatorio-por-pessoa-${today()}.csv`, csv, 'text/csv;charset=utf-8');
}
function renderReports() {
  if (!$('#reportStats')) return;
  syncReportSectorFilter();
  const { start, end } = reportRange();
  const selected = reportTasksForRange(start, end, $('#reportSector')?.value || 'all');
  const created = selected.filter(task => task.createdAt && reportDateInRange(task.createdAt.slice(0, 10), start, end));
  const completed = selected.filter(task => task.status === 'done' && task.completedAt && reportDateInRange(task.completedAt.slice(0, 10), start, end));
  const open = selected.filter(task => task.status !== 'done');
  const overdue = open.filter(task => (task.periodEnd || task.due) < today());
  const onTime = completed.filter(task => (task.periodEnd || task.due) >= task.completedAt.slice(0, 10));
  const onTimePercent = completed.length ? Math.round(onTime.length / completed.length * 100) : 0;
  const rate = selected.length ? Math.round(completed.length / selected.length * 100) : 0;
  const avgCycle = reportAvgCycle(completed);
  const previous = reportPrevRange(start, end);
  let prevCreated = null, prevCompleted = null, prevRate = null, prevAvg = null;
  if (previous) {
    const previousSelected = reportTasksForRange(previous.start, previous.end, $('#reportSector')?.value || 'all');
    prevCreated = previousSelected.filter(task => task.createdAt && reportDateInRange(task.createdAt.slice(0, 10), previous.start, previous.end)).length;
    const previousDone = previousSelected.filter(task => task.status === 'done' && task.completedAt && reportDateInRange(task.completedAt.slice(0, 10), previous.start, previous.end));
    prevCompleted = previousDone.length;
    prevRate = previousSelected.length ? Math.round(previousDone.length / previousSelected.length * 100) : 0;
    prevAvg = reportAvgCycle(previousDone);
  }
  const cards = [
    { tone: '', drill: 'all', label: 'Atividade no período', value: selected.length, hint: `${open.length} em aberto agora`, delta: '' },
    { tone: 'kpi-created', drill: 'created', label: 'Criadas', value: created.length, hint: 'entraram no período', delta: reportDelta(created.length, prevCreated) },
    { tone: 'kpi-done', drill: 'done', label: 'Concluídas', value: completed.length, hint: completed.length ? `${onTimePercent}% dentro do prazo` : 'nenhuma conclusão no período', delta: reportDelta(completed.length, prevCompleted) },
    { tone: 'kpi-rate', drill: 'open', label: 'Taxa de conclusão', value: `${rate}%`, hint: `${open.length} demandas em aberto`, delta: reportDelta(rate, prevRate, ' p.p.') },
    { tone: 'kpi-late', drill: 'overdue', label: 'Atrasadas agora', value: overdue.length, hint: overdue.length ? 'precisam de decisão' : 'nada passou do prazo', alert: overdue.length > 0 },
    { tone: 'kpi-cycle', drill: 'done', label: 'Ciclo médio', value: reportFormatDays(avgCycle), hint: 'da criação à conclusão', delta: avgCycle !== null && prevAvg !== null ? reportDelta(avgCycle, prevAvg, ' d', true) : '' },
  ];
  $('#reportStats').innerHTML = cards.map(card => `<button type="button" class="report-kpi ${card.tone} ${card.alert ? 'alert' : ''}" data-report-drill="${card.drill}"><span>${card.label}</span><strong>${card.value}</strong><small>${card.hint}</small>${card.delta || ''}</button>`).join('');
  renderReportTrend(selected, start, end);
  renderStatusDonut(selected);
  const people = reportPeopleList(selected);
  renderOwnerBars(selected, people);
  chart('#priorityChart', Object.entries(priorityNames).map(([key, label]) => ({ label, value: open.filter(task => task.priority === key).length })), ['#d94c52', '#c88921', '#3d72b8', '#89969d']);
  const sectorEntries = [...selected.reduce((map, task) => { const key = task.sectorId || 'none'; map.set(key, (map.get(key) || 0) + 1); return map; }, new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const sectorCard = $('#sectorCard');
  if (sectorCard) sectorCard.classList.toggle('hidden', sectorEntries.length < 2);
  if (sectorEntries.length >= 2) chart('#sectorChart', sectorEntries.map(([id, value]) => ({ label: reportSectorLabel(id === 'none' ? '' : id), value })), ['#0b8f87', '#3d72b8', '#c88921', '#6b5bd2', '#89969d']);
  chart('#cycleChart', Object.entries(priorityNames).map(([key, label]) => { const value = reportAvgCycle(completed.filter(task => task.priority === key)); return { label, value: value ?? 0, display: value === null ? '—' : reportFormatDays(value) }; }), ['#d94c52', '#c88921', '#3d72b8', '#89969d']);
  chart('#agingChart', reportAgingBuckets(open), ['#0b8f87', '#3d72b8', '#c88921', '#d94c52']);
  renderLateList(open);
  renderStaleList(open);
  renderDailyChart(selected, end);
  renderPeopleCards(selected, people);
  $('#reportDate').textContent = `${selected.length} demandas · ${completed.length} concluídas · ${open.length} em aberto`;
  renderReportInsights(buildReportSnapshot());
}

// ══════════ Relatórios: leitura automática e prompt para IA ══════════
const AI_PREFS_KEY = 'plantao-relatorio-ia-v1';
const aiFocusQuestions = {
  atrasos: 'Como estão os prazos, quais pontos merecem acompanhamento e quais ações podem regularizar o fluxo.',
  produtividade: 'Como está a distribuição de carga e entregas por pessoa, identificando oportunidades de apoio e equilíbrio.',
  gargalos: 'Quais pontos do fluxo estão mais lentos ou sem movimento e quais causas devem ser verificadas.',
  qualidade: 'Como estão o cumprimento de prazo e o tempo de ciclo, destacando aprendizados do período.',
  tendencia: 'O que mudou em relação ao período anterior e qual tendência merece atenção.',
  prioridades: 'Quais são as prioridades e riscos imediatos, na ordem de acompanhamento.',
  setores: 'Como os setores se comparam em volume, prazos e ritmo de entrega.',
  recomendacoes: 'Qual plano de ação pode apoiar o time, com responsável sugerido e prazo realista.',
};
function isReportManager() { const user = window.PortalAccess?.Access?.user; return user?.role === 'admin' || !!user?.management; }
function reportFullDate(date) { return date ? new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR') : ''; }
function reportRangeText(start, end) {
  if (start && end) return `${reportFullDate(start)} a ${reportFullDate(end)}`;
  if (start) return `a partir de ${reportFullDate(start)}`;
  if (end) return `até ${reportFullDate(end)}`;
  return 'todo o histórico disponível';
}
function buildReportSnapshot() {
  const start = $('#reportStart')?.value || '';
  const end = $('#reportEnd')?.value || '';
  const sector = $('#reportSector')?.value || 'all';
  const current = today();
  const selected = reportTasksForRange(start, end, sector);
  const created = selected.filter(task => task.createdAt && reportDateInRange(task.createdAt.slice(0, 10), start, end));
  const completed = selected.filter(task => task.status === 'done' && task.completedAt && reportDateInRange(task.completedAt.slice(0, 10), start, end));
  const open = selected.filter(task => task.status !== 'done');
  const overdue = open.filter(task => (task.periodEnd || task.due) < current);
  const onTime = completed.filter(task => (task.periodEnd || task.due) >= task.completedAt.slice(0, 10));
  const previous = reportPrevRange(start, end);
  let prevSelected = null, prevCreated = null, prevCompleted = null, prevRate = null, prevAvg = null;
  if (previous) {
    const previousSelected = reportTasksForRange(previous.start, previous.end, sector);
    const previousDone = previousSelected.filter(task => task.status === 'done' && task.completedAt && reportDateInRange(task.completedAt.slice(0, 10), previous.start, previous.end));
    prevSelected = previousSelected.length;
    prevCreated = previousSelected.filter(task => task.createdAt && reportDateInRange(task.createdAt.slice(0, 10), previous.start, previous.end)).length;
    prevCompleted = previousDone.length;
    prevRate = previousSelected.length ? Math.round(previousDone.length / previousSelected.length * 100) : 0;
    prevAvg = reportAvgCycle(previousDone);
  }
  const people = reportPeopleList(selected);
  const ownerIndex = reportOwnerIndex(people);
  const peopleStats = people.map(person => {
    const list = selected.filter(task => reportOwnerName(task, ownerIndex) === person.displayName);
    const done = list.filter(task => task.status === 'done');
    const personOpen = list.filter(task => task.status !== 'done');
    return { name: person.displayName, total: list.length, done: done.length, open: personOpen.length, late: personOpen.filter(task => (task.periodEnd || task.due) < current).length, rate: list.length ? Math.round(done.length / list.length * 100) : 0, cycle: reportAvgCycle(done) };
  }).filter(person => person.total > 0).sort((a, b) => b.open - a.open || b.total - a.total);
  const sectorMap = new Map();
  selected.forEach(task => { const id = task.sectorId || ''; if (!sectorMap.has(id)) sectorMap.set(id, []); sectorMap.get(id).push(task); });
  const sectors = [...sectorMap.entries()].map(([id, list]) => {
    const listOpen = list.filter(task => task.status !== 'done');
    return { id, name: reportSectorLabel(id), total: list.length, open: listOpen.length, done: list.length - listOpen.length, late: listOpen.filter(task => (task.periodEnd || task.due) < current).length };
  }).sort((a, b) => b.total - a.total);
  const late = overdue.map(task => ({ task, due: task.periodEnd || task.due, days: Math.max(0, reportDayDiff(current, task.periodEnd || task.due) || 0) })).sort((a, b) => b.days - a.days);
  const stale = open.map(task => {
    const last = (task.updatedAt || task.createdAt || task.periodStart || task.due || '').slice(0, 10);
    return { task, last, days: last ? Math.max(0, reportDayDiff(current, last) || 0) : 0 };
  }).filter(item => item.last && item.days >= 7).sort((a, b) => b.days - a.days);
  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = reportShiftDate(end || current, index - 13);
    return { date, value: selected.filter(task => task.completedAt?.slice(0, 10) === date).length };
  });
  return {
    start, end, sector, sectorName: sector === 'all' ? 'Todos os setores' : reportSectorLabel(sector),
    selected, created, completed, open, overdue, onTime,
    onTimePercent: completed.length ? Math.round(onTime.length / completed.length * 100) : 0,
    rate: selected.length ? Math.round(completed.length / selected.length * 100) : 0,
    avgCycle: reportAvgCycle(completed),
    previous, prevSelected, prevCreated, prevCompleted, prevRate, prevAvg,
    people: peopleStats,
    sectors,
    late,
    stale,
    daily,
    aging: reportAgingBuckets(open),
    priorityOpen: Object.keys(priorityNames).reduce((map, key) => { map[key] = open.filter(task => task.priority === key).length; return map; }, {}),
    generatedAt: new Date(),
  };
}
function deriveReportInsights(snapshot) {
  const s = snapshot;
  const insights = [];
  const share = (value, total) => total ? Math.round(value / total * 100) : 0;
  const entryDiff = s.created.length - s.completed.length;
  if (entryDiff > 0) {
    insights.push({
      tag: 'Ritmo', tone: entryDiff >= Math.max(3, Math.ceil(s.open.length * 0.4)) ? 'warn' : 'info',
      title: `Entraram ${entryDiff} demanda(s) a mais do que saíram`,
      text: `${s.created.length} criadas e ${s.completed.length} concluídas no recorte. Restam ${s.open.length} em aberto.`,
      drill: 'created', prompt: 'tendencia',
    });
  } else if (s.completed.length) {
    insights.push({
      tag: 'Ritmo', tone: 'good',
      title: 'As conclusões acompanharam as entradas',
      text: `${s.completed.length} concluídas para ${s.created.length} criadas no recorte. ${s.open.length} seguem em aberto.`,
      drill: 'done', prompt: 'tendencia',
    });
  } else {
    insights.push({
      tag: 'Ritmo', tone: 'info',
      title: 'Nenhuma conclusão registrada no período',
      text: `Há ${s.created.length} criação(ões) e ${s.open.length} demanda(s) em aberto. Confira se o recorte está correto e se as entregas foram registradas.`,
      drill: 'open', prompt: 'tendencia',
    });
  }
  if (s.overdue.length) {
    const worst = s.late[0]?.days || 0;
    insights.push({
      tag: 'Prazo', tone: worst >= 7 || share(s.overdue.length, s.open.length) >= 30 ? 'risk' : 'warn',
      title: `${s.overdue.length} demanda(s) fora do prazo`,
      text: `${share(s.overdue.length, s.open.length)}% das ${s.open.length} abertas já passaram do prazo. A mais antiga está ${worst} dia(s) atrasada.`,
      drill: 'overdue', prompt: 'atrasos',
    });
  } else {
    insights.push({
      tag: 'Prazo', tone: 'good',
      title: 'Nenhuma demanda atrasada agora',
      text: s.open.length ? `As ${s.open.length} demandas abertas estão dentro do prazo.` : 'Não há demandas abertas neste recorte.',
      drill: 'open', prompt: 'atrasos',
    });
  }
  const sectorPressure = s.sectors.filter(item => item.open > 0).sort((a, b) => b.late - a.late || b.open - a.open)[0];
  const personPressure = s.people.filter(item => item.open > 0).sort((a, b) => b.late - a.late || b.open - a.open)[0];
  if (s.stale.length >= 2) {
    insights.push({
      tag: 'Gargalo', tone: 'warn',
      title: `${s.stale.length} demanda(s) sem movimento há 7 dias ou mais`,
      text: `A mais parada está há ${s.stale[0].days} dia(s): "${s.stale[0].task.title}".`,
      drill: 'open', prompt: 'gargalos',
    });
  } else if (s.sectors.length > 1 && sectorPressure) {
    insights.push({
      tag: 'Gargalo', tone: sectorPressure.late ? 'warn' : 'info',
      title: `${sectorPressure.name} concentra a maior pressão`,
      text: `${sectorPressure.open} aberta(s) e ${sectorPressure.late} atrasada(s) no setor, de ${sectorPressure.total} demanda(s) no recorte.`,
      drill: 'open', prompt: 'gargalos',
    });
  } else if (personPressure && personPressure.open >= 2) {
    insights.push({
      tag: 'Gargalo', tone: personPressure.late ? 'warn' : 'info',
      title: `${personPressure.name} concentra as pendências`,
      text: `${personPressure.open} demanda(s) aberta(s)${personPressure.late ? `, sendo ${personPressure.late} atrasada(s)` : ''} sob a mesma responsabilidade.`,
      drill: `owner:${personPressure.name}`, prompt: 'gargalos',
    });
  } else {
    insights.push({
      tag: 'Gargalo', tone: 'good',
      title: 'Nenhum gargalo evidente',
      text: s.open.length ? 'As demandas abertas estão andando e não há acúmulo relevante em um único setor ou pessoa.' : 'Não há demandas abertas para travar o fluxo.',
      drill: 'all', prompt: 'gargalos',
    });
  }
  if (s.people.length > 1) {
    const top = s.people[0];
    const avgOpen = s.open.length / s.people.length;
    const imbalanced = top.open >= 3 && top.open >= avgOpen * 1.6;
    insights.push({
      tag: 'Carga', tone: imbalanced ? 'warn' : 'good',
      title: imbalanced ? `Carga concentrada em ${top.name}` : 'Carga equilibrada entre a equipe',
      text: imbalanced ? `${top.name} está com ${top.open} aberta(s), acima da média de ${avgOpen.toFixed(1).replace('.', ',')} por pessoa.` : `${s.people.length} pessoas com demandas no recorte; a maior carga é de ${top.open} aberta(s).`,
      drill: `owner:${top.name}`, prompt: 'produtividade',
    });
  } else if (s.people.length === 1) {
    insights.push({
      tag: 'Carga', tone: 'info',
      title: `Toda a carga está com ${s.people[0].name}`,
      text: `${s.people[0].total} demanda(s) no recorte, ${s.people[0].open} ainda em aberto.`,
      drill: `owner:${s.people[0].name}`, prompt: 'produtividade',
    });
  }
  if (s.completed.length) {
    const cycleText = s.avgCycle === null ? 'sem ciclo calculável' : `ciclo médio de ${reportFormatDays(s.avgCycle)}${s.prevAvg !== null ? ` (${Number((s.avgCycle - s.prevAvg).toFixed(1)).toString().replace('.', ',')} d vs. período anterior)` : ''}`;
    insights.push({
      tag: 'Qualidade', tone: s.onTimePercent >= 85 ? 'good' : s.onTimePercent >= 60 ? 'warn' : 'risk',
      title: `${s.onTimePercent}% das entregas dentro do prazo`,
      text: `${s.onTime.length} de ${s.completed.length} concluídas no prazo, com ${cycleText}.`,
      drill: 'done', prompt: 'qualidade',
    });
  } else {
    insights.push({
      tag: 'Qualidade', tone: 'info',
      title: 'Ainda não há entregas para medir qualidade',
      text: 'Nenhuma demanda foi concluída no recorte; o indicador aparece assim que houver conclusões.',
      drill: 'open', prompt: 'qualidade',
    });
  }
  if (s.previous) {
    const createdDelta = s.created.length - (s.prevCreated || 0);
    const doneDelta = s.completed.length - (s.prevCompleted || 0);
    insights.push({
      tag: 'Tendência', tone: doneDelta > 0 ? 'good' : doneDelta < 0 ? 'warn' : 'info',
      title: doneDelta > 0 ? 'As conclusões cresceram frente ao período anterior' : doneDelta < 0 ? 'As conclusões caíram frente ao período anterior' : 'Ritmo de conclusão estável',
      text: `Entradas ${createdDelta >= 0 ? '+' : ''}${createdDelta} e conclusões ${doneDelta >= 0 ? '+' : ''}${doneDelta} em relação a ${reportRangeText(s.previous.start, s.previous.end)}.`,
      prompt: 'tendencia',
    });
  } else {
    insights.push({
      tag: 'Tendência', tone: 'info',
      title: 'Sem base para comparar períodos',
      text: 'Defina data inicial e final para o sistema comparar com o intervalo anterior de mesmo tamanho.',
      prompt: 'tendencia',
    });
  }
  const urgent = s.priorityOpen.urgent || 0;
  const high = s.priorityOpen.high || 0;
  if (urgent || high) {
    insights.push({
      tag: 'Prioridades', tone: urgent ? 'risk' : 'warn',
      title: `${urgent + high} demanda(s) de alta criticidade em aberto`,
      text: `${urgent} crítica(s) e ${high} alta(s) entre as ${s.open.length} abertas.`,
      drill: 'open', prompt: 'prioridades',
    });
  } else if (s.open.length) {
    insights.push({
      tag: 'Prioridades', tone: 'good',
      title: 'Nenhuma prioridade crítica em aberto',
      text: `As ${s.open.length} demandas abertas estão classificadas como normal ou baixa.`,
      drill: 'open', prompt: 'prioridades',
    });
  }
  if (s.overdue.length) {
    const worst = s.late[0];
    insights.push({
      tag: 'Próximo passo', tone: 'risk',
      title: 'Renegociar prazos antes de assumir novas demandas',
      text: `Comece por "${worst.task.title}" (${worst.days} d de atraso) e redistribua o que estiver travado.`,
      drill: 'overdue', prompt: 'recomendacoes',
    });
  } else if (s.stale.length) {
    insights.push({
      tag: 'Próximo passo', tone: 'warn',
      title: `Destravar ${s.stale.length} demanda(s) parada(s)`,
      text: `A mais parada é "${s.stale[0].task.title}", sem movimento há ${s.stale[0].days} dia(s).`,
      drill: 'open', prompt: 'recomendacoes',
    });
  } else if (s.created.length > s.completed.length) {
    insights.push({
      tag: 'Próximo passo', tone: 'warn',
      title: 'Fechar o que já está aberto antes de abrir novo ciclo',
      text: `O período abriu ${s.created.length} e concluiu ${s.completed.length}; priorize as ${s.open.length} abertas.`,
      drill: 'open', prompt: 'recomendacoes',
    });
  } else {
    insights.push({
      tag: 'Próximo passo', tone: 'good',
      title: 'Manter o ritmo e registrar o que funcionou',
      text: 'As entregas acompanham as entradas e não há atraso nem demanda parada no recorte.',
      prompt: 'recomendacoes',
    });
  }
  return insights;
}
function renderReportInsights(snapshot) {
  const host = $('#reportInsights'); if (!host) return;
  if (!snapshot.selected.length) { host.innerHTML = '<div class="insight-empty">Sem demandas neste recorte. Ajuste o período ou o setor para a leitura automática.</div>'; return; }
  host.innerHTML = deriveReportInsights(snapshot).map(item => `<article class="insight-card tone-${item.tone}"><span class="insight-tag">${escapeHtml(item.tag)}</span><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p><div class="insight-actions">${item.drill ? `<button type="button" class="insight-action" data-report-drill="${escapeHtml(item.drill)}">Ver lista</button>` : ''}${item.prompt ? `<button type="button" class="insight-action" data-insight-prompt="${escapeHtml(item.prompt)}">Gerar prompt</button>` : ''}</div></article>`).join('');
}
function aiPrefsStore() { try { const raw = JSON.parse(localStorage.getItem(AI_PREFS_KEY) || '{}'); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; } }
function aiPrefsSectorKey() { return $('#reportSector')?.value || 'all'; }
function loadAiPrefs() { return aiPrefsStore()[aiPrefsSectorKey()] || null; }
function saveAiPrefs(partial) { const store = aiPrefsStore(); const key = aiPrefsSectorKey(); store[key] = { ...(store[key] || {}), ...partial, updatedAt: new Date().toISOString() }; try { localStorage.setItem(AI_PREFS_KEY, JSON.stringify(store)); } catch { /* armazenamento cheio: preferências são opcionais */ } }
function suggestedAiFocus(snapshot) {
  const focus = [];
  if (snapshot.overdue.length) focus.push('atrasos');
  if (snapshot.stale.length) focus.push('gargalos');
  if (snapshot.people.length > 1) focus.push('produtividade');
  if (snapshot.completed.length) focus.push('qualidade');
  if (snapshot.previous) focus.push('tendencia');
  if (snapshot.priorityOpen.urgent || snapshot.priorityOpen.high) focus.push('prioridades');
  if (isReportManager() && snapshot.sectors.length > 1) focus.push('setores');
  focus.push('recomendacoes');
  return focus;
}
function selectedAiFocus() { return [...document.querySelectorAll('#aiPromptDialog .ai-focus label:not(.hidden) input:checked')].map(input => input.value); }
function persistAiDialogPrefs() {
  if (!$('#aiPromptDialog')?.open) return;
  saveAiPrefs({ focus: selectedAiFocus(), ask: $('#aiPromptAsk').value.trim(), format: $('#aiPromptFormat').value, include: $('#aiPromptIncludeTasks').value });
}
function composeAiPrompt(snapshot, prefs) {
  const s = snapshot;
  const lines = [];
  const share = (value, total) => total ? Math.round(value / total * 100) : 0;
  const number = value => Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10).replace('.', ',');
  const variation = (value, previous, suffix = '') => previous === null || previous === undefined ? 'sem base anterior' : `${value - previous >= 0 ? '+' : ''}${number(value - previous)}${suffix}`;
  const cycleVariation = s.avgCycle === null || s.prevAvg === null ? 'sem base anterior' : `${s.avgCycle - s.prevAvg >= 0 ? '+' : ''}${number(s.avgCycle - s.prevAvg)} d vs. período anterior`;
  lines.push('Você é analista de gestão da Rede Saúde. Gere o relatório final em uma única resposta, usando exclusivamente os dados abaixo.');
  lines.push('');
  lines.push('REGRAS ESSENCIAIS');
  lines.push('1. Faça tudo agora, sem pedir confirmação, sem fazer perguntas e sem dividir o trabalho em etapas ou novas mensagens.');
  lines.push('2. Use exclusivamente os números e nomes desta mensagem. Não invente, estime ou complete dados ausentes; escreva "não registrado" quando faltar informação.');
  lines.push('3. Responda em português do Brasil, com tom profissional, acolhedor, objetivo e orientado a decisões.');
  lines.push('4. Este é um relatório de trabalho, não uma avaliação de pessoas. Não culpe, ridicularize, humilhe ou use rótulos como "incompetente", "desorganizado" ou "preguiçoso". Descreva fatos, contexto, esforço realizado, impactos e próximos passos; use "o time" e "a equipe" sempre que possível.');
  lines.push('5. Não transforme atraso ou demanda aberta em julgamento individual. Quando houver responsável registrado, trate-o apenas como informação operacional e proponha apoio, redistribuição ou alinhamento.');
  lines.push('');
  lines.push('CONTEXTO');
  lines.push(`- Instituição: Rede Saúde`);
  lines.push(`- Período analisado: ${reportRangeText(s.start, s.end)}`);
  lines.push(`- Recorte: ${s.sector === 'all' ? 'todos os setores visíveis' : s.sectorName}`);
  lines.push(`- Data de geração: ${s.generatedAt.toLocaleString('pt-BR')}`);
  lines.push(`- Solicitado por: ${window.PortalAccess?.Access?.user?.displayName || 'não informado'}`);
  lines.push('');
  lines.push('INDICADORES DO PERÍODO');
  lines.push(`- Demandas no recorte: ${s.selected.length}`);
  lines.push(`- Criadas: ${s.created.length} (${variation(s.created.length, s.prevCreated)})`);
  lines.push(`- Concluídas: ${s.completed.length} (${variation(s.completed.length, s.prevCompleted)})`);
  lines.push(`- Taxa de conclusão: ${s.rate}% (${variation(s.rate, s.prevRate, ' p.p.')})`);
  lines.push(`- Entregas dentro do prazo: ${s.onTime.length} de ${s.completed.length} (${s.onTimePercent}%)`);
  lines.push(`- Ciclo médio até concluir: ${s.avgCycle === null ? 'não calculável' : reportFormatDays(s.avgCycle)} (${cycleVariation})`);
  lines.push(`- Em aberto agora: ${s.open.length}`);
  lines.push(`- Atrasadas agora: ${s.overdue.length} (${share(s.overdue.length, s.open.length)}% das abertas)`);
  lines.push(`- Sem movimento há 7 dias ou mais: ${s.stale.length}`);
  lines.push('');
  lines.push('SITUAÇÃO E PESO DAS ABERTAS');
  lines.push(`- Status no recorte: pendentes ${s.selected.filter(task => normalizedStatus(task) === 'todo').length} · em andamento ${s.selected.filter(task => normalizedStatus(task) === 'progress').length} · concluídas ${s.selected.filter(task => normalizedStatus(task) === 'done').length}`);
  lines.push(`- Prioridade das abertas: crítica ${s.priorityOpen.urgent || 0} · alta ${s.priorityOpen.high || 0} · normal ${s.priorityOpen.medium || 0} · baixa ${s.priorityOpen.low || 0}`);
  lines.push('');
  lines.push('PESSOAS (carga no recorte)');
  if (s.people.length) s.people.forEach(person => lines.push(`- ${person.name}: ${person.total} no período · ${person.done} concluídas · ${person.open} abertas · ${person.late} atrasadas · ${person.rate}% de conclusão · ciclo médio ${person.cycle === null ? '—' : reportFormatDays(person.cycle)}`));
  else lines.push('- Nenhuma pessoa com demanda no recorte.');
  if (isReportManager() && s.sectors.length) {
    lines.push('');
    lines.push('SETORES');
    s.sectors.forEach(sector => lines.push(`- ${sector.name}: ${sector.total} no recorte · ${sector.open} abertas · ${sector.late} atrasadas · ${sector.done} concluídas`));
  }
  lines.push('');
  lines.push('ENVELHECIMENTO DAS ABERTAS');
  lines.push(`- ${s.aging.map(item => `${item.label}: ${item.value}`).join(' · ')}`);
  lines.push('');
  lines.push('CONCLUSÕES NOS ÚLTIMOS 14 DIAS DO RECORTE');
  lines.push(`- ${s.daily.map(item => `${reportFullDate(item.date)}: ${item.value}`).join(' · ')}`);
  if (s.late.length) {
    lines.push('');
    lines.push('ATRASADAS MAIS ANTIGAS');
    s.late.slice(0, 15).forEach(item => lines.push(`- ${item.task.title} · ${item.task.owner || 'Sem responsável'} · ${reportSectorLabel(item.task.sectorId)} · venceu em ${reportFullDate(item.due)} (${item.days} dia(s) de atraso)`));
  }
  if (s.stale.length) {
    lines.push('');
    lines.push('DEMANDAS SEM MOVIMENTO');
    s.stale.slice(0, 10).forEach(item => lines.push(`- ${item.task.title} · ${item.task.owner || 'Sem responsável'} · ${reportSectorLabel(item.task.sectorId)} · último movimento em ${reportFullDate(item.last)} (${item.days} dia(s) parada)`));
  }
  lines.push('');
  if (prefs.includeTasks) {
    lines.push('LISTA COMPLETA DE DEMANDAS (CSV, separador ponto e vírgula)');
    lines.push(['Demanda', 'Setor', 'Início', 'Fim', 'Responsável', 'Prioridade', 'Status', 'Criada em', 'Concluída em', 'Dias até concluir', 'Observação'].join(';'));
    [...s.selected].sort((a, b) => (a.periodEnd || a.due || '').localeCompare(b.periodEnd || b.due || '') || (a.status === 'done') - (b.status === 'done')).forEach(task => {
      lines.push([task.title, reportSectorLabel(task.sectorId), task.periodStart || task.due || '', task.periodEnd || task.due || '', task.owner || 'Sem responsável', priorityNames[task.priority] || task.priority || '', normalizedStatus(task) === 'done' ? 'Concluída' : normalizedStatus(task) === 'progress' ? 'Em andamento' : 'Pendente', task.createdAt?.slice(0, 10) || '', task.completedAt?.slice(0, 10) || '', reportCycleDays(task) ?? '', task.notes || ''].map(csvCell).join(';'));
    });
  } else {
    lines.push('LISTA COMPLETA DE DEMANDAS: não incluída nesta versão. Trabalhe apenas com os indicadores e destaques acima e não invente a lista.');
  }
  lines.push('');
  lines.push('IDENTIDADE VISUAL OBRIGATÓRIA (imagem anexada)');
  lines.push("- Capa: fundo branco, colagem de pessoas sorrindo em tons suaves e translúcidos, marca d'água grande em verde e azul e o logotipo da Rede Saúde.");
  lines.push('- Use a mesma imagem como referência de estilo nas divisórias e no fechamento, sem cortar nem alterar o logotipo.');
  lines.push('- Paleta: verde-petróleo #087F78, verde-claro #0B8F87, azul #3D72B8, âmbar #C88921 e vermelho #D94C52. Tipografia sem serifa, títulos fortes e corpo leve.');
  lines.push('- Inclua gráficos reais no relatório, não apenas sugestões: no mínimo 3 gráficos, usando somente os dados fornecidos. Prefira (a) barras para abertas/concluídas por período ou setor, (b) linha para conclusões nos últimos 14 dias e (c) rosca ou barras para status/prioridades. Mostre título, legenda, unidade e valores; se a ferramenta não puder desenhar, entregue tabelas prontas para virar gráficos.');
  lines.push('- Não invente logotipos, fotos ou marcas; use somente a imagem anexada como base visual.');
  lines.push('');
  lines.push('O QUE ESTE RELATÓRIO PRECISA RESPONDER');
  const chosen = prefs.focus.filter(key => aiFocusQuestions[key]);
  if (chosen.length) chosen.forEach((key, index) => lines.push(`${index + 1}. ${aiFocusQuestions[key]}`));
  else lines.push('1. Faça uma leitura geral do período, destacando os pontos que exigem decisão.');
  if (prefs.ask) {
    lines.push('');
    lines.push('PEDIDO ESPECÍFICO DO SETOR');
    lines.push(prefs.ask);
  }
  lines.push('');
  lines.push('FORMATO DE SAÍDA');
  if (prefs.format === 'executive') {
    lines.push('- Resumo executivo de 1 página, com capa no modelo anexado.');
    lines.push('- Estrutura: 3 achados principais, indicadores em destaque, 3 gráficos, pontos de atenção e 5 recomendações objetivas.');
    lines.push('- Texto curto, pronto para leitura da diretoria.');
  } else if (prefs.format === 'slides') {
    lines.push('- Apresentação de 6 a 8 slides, com capa no modelo anexado.');
    lines.push('- Estrutura: capa, visão geral do período, ritmo de entradas e entregas, prazos, carga do time, gargalos, pontos de atenção e plano de ação.');
    lines.push('- Cada slide com título curto, 3 a 5 tópicos e um gráfico gerado com os dados do recorte.');
  } else {
    lines.push('- Relatório analítico enxuto de até 3 páginas, com capa no modelo anexado.');
    lines.push('- Estrutura: capa, sumário executivo, indicadores, prazos, carga do time, gargalos, tendência, 3 gráficos e plano de ação.');
    lines.push('- Cada seção deve ser breve e usar os números que sustentam a conclusão.');
  }
  lines.push('- Encerre com o plano de ação em formato de tabela: ação, responsável sugerido e prazo.');
  lines.push('- Não repita a lista completa de demandas dentro do texto; use-a apenas como base de análise.');
  lines.push('');
  lines.push('CRITÉRIOS DE QUALIDADE');
  lines.push('- Toda afirmação deve citar um número ou uma demanda específica.');
  lines.push('- Apresente pontos de atenção e decisões pendentes em blocos curtos e visíveis, sem procurar culpados.');
  lines.push('- Sugira responsáveis e prazos realistas, sem inventar pessoas: use os nomes citados nos dados.');
  lines.push('- Se os dados não sustentarem uma conclusão, diga explicitamente o que falta registrar.');
  return lines.join('\n');
}
function openAiPromptDialog(focusKey = '') {
  const dialog = $('#aiPromptDialog'); if (!dialog) return;
  const manager = isReportManager();
  const managerField = dialog.querySelector('[data-manager-only]');
  if (managerField) managerField.classList.toggle('hidden', !manager);
  const snapshot = buildReportSnapshot();
  const saved = loadAiPrefs();
  const suggested = suggestedAiFocus(snapshot);
  const chosen = focusKey ? [focusKey] : (Array.isArray(saved?.focus) && saved.focus.length ? saved.focus : suggested);
  dialog.querySelectorAll('.ai-focus input').forEach(input => { input.checked = chosen.includes(input.value); });
  $('#aiPromptAsk').value = focusKey ? '' : (saved?.ask || '');
  $('#aiPromptFormat').value = ['full', 'executive', 'slides'].includes(saved?.format) ? saved.format : 'full';
  $('#aiPromptIncludeTasks').value = saved?.include === 'yes' ? 'yes' : 'no';
  $('#aiPromptText').value = '';
  $('#aiPromptMeta').textContent = snapshot.selected.length ? `${snapshot.selected.length} demandas no recorte atual` : 'Sem demandas no recorte atual';
  if (!dialog.open) dialog.showModal();
  generateAiPrompt();
}
function generateAiPrompt() {
  if (!$('#aiPromptText')) return;
  const snapshot = buildReportSnapshot();
  const focus = selectedAiFocus();
  const ask = $('#aiPromptAsk').value.trim();
  const format = $('#aiPromptFormat').value;
  const includeTasks = $('#aiPromptIncludeTasks').value !== 'no';
  $('#aiPromptText').value = composeAiPrompt(snapshot, { focus, ask, format, includeTasks });
  $('#aiPromptMeta').textContent = `${snapshot.selected.length} demandas · ${focus.length} foco(s) · gerado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  saveAiPrefs({ focus, ask, format, include: includeTasks ? 'yes' : 'no' });
}
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function moneyValue(value) { return Number(value.replace(/\./g, '').replace(',', '.')); }
function moneyLabel(value) { return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function parseFinancialText(text) { const matches = [...text.matchAll(/Vencimento\s*:\s*(\d{2}\/\d{2}\/\d{4})/gi)]; const currentDate = today(); const entries = matches.map((match, index) => { const block = text.slice(match.index, matches[index + 1]?.index || text.length); const [, day, month, year] = match[1].match(/(\d{2})\/(\d{2})\/(\d{4})/); const date = `${year}-${month}-${day}`; const due = new Date(`${date}T12:00:00`); const titleMatch = block.match(/(?:Título|Titulo)[^\d]{0,24}([\d.]+,\d{2})/i); const finalMatch = block.match(/Valor final[^\d]{0,24}([\d.]+,\d{2})/i); const title = titleMatch ? moneyValue(titleMatch[1]) : null; const final = finalMatch ? moneyValue(finalMatch[1]) : null; const amount = date >= currentDate ? title ?? final : final ?? title; return { date, label: `${due.toLocaleDateString('pt-BR', { month: 'long' }).toUpperCase()} - ${amount == null ? 'VALOR NÃO IDENTIFICADO' : moneyLabel(amount)}`, amount, title, final }; }).filter(entry => entry.amount != null).sort((a, b) => b.date.localeCompare(a.date)); return entries.slice(0, 3).map(entry => entry.label); }
function renderMergePreview() { if (!mergeRows.length) return; $('#mergePreview').classList.remove('hidden'); const header = '<strong>EMPRESA</strong><strong>EMAIL</strong><strong>COMP1</strong><strong>COMP2</strong><strong>COMP3</strong><strong>AÇÕES</strong>'; const rows = mergeRows.map((row, index) => `<input data-merge-field="EMPRESA" data-index="${index}" value="${escapeHtml(row.EMPRESA)}"><input data-merge-field="EMAIL" data-index="${index}" value="${escapeHtml(row.EMAIL)}"><input data-merge-field="COMP1" data-index="${index}" value="${escapeHtml(row.COMP1 || '')}"><input data-merge-field="COMP2" data-index="${index}" value="${escapeHtml(row.COMP2 || '')}"><input data-merge-field="COMP3" data-index="${index}" value="${escapeHtml(row.COMP3 || '')}"><span class="queue-actions"><button data-queue-action="up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button><button data-queue-action="down" data-index="${index}" ${index === mergeRows.length - 1 ? 'disabled' : ''}>↓</button><button data-queue-action="delete" data-index="${index}">Excluir</button></span>`).join(''); $('#mergePreviewContent').innerHTML = `<div class="merge-row merge-queue">${header}${rows}</div>`; $('#mergeQueueNote').textContent = `${mergeRows.length} linha(s) pronta(s) para a mala direta.`; }
function extractCompanyAndEmails(text) { const commercialMatch = text.match(/Empresa\s*\d+\s*-\s*([\s\S]*?)(?=Raz[aã]o Social|Tipo de empresa|Grupo|Centro de custo|Situa[cç][aã]o)/i); const legalMatch = text.match(/Raz[aã]o Social\s*[:\-]?\s*(.+?)(?=Tipo de empresa|Grupo|Centro de custo|Situa[cç][aã]o|\r?\n|$)/i) || text.match(/Raz[aã]o Social\s*[:\-]?\s*([^\r\n]+)/i); const blockedEmails = new Set(['carla.vieira@appredesaude.com.br']); const labeledEmails = [...text.matchAll(/E-?mail\s*[:\-]?\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map(match => match[1].toLowerCase()); const separatedEmails = [...text.matchAll(/(?:^|[\s,;])([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map(match => match[1].replace(/^e-?mail/i, '').toLowerCase()); const emails = [...new Set([...labeledEmails, ...separatedEmails])].filter(email => !blockedEmails.has(email)); return { commercial: commercialMatch ? commercialMatch[1].replace(/\s+/g, ' ').trim() : '', legal: legalMatch ? legalMatch[1].replace(/\s+/g, ' ').trim() : '', emails: emails.join(', ') }; }
function parseMerge() { const extracted = extractCompanyAndEmails($('#financialText').value); const company = $('#mergeNameMode').value === 'legal' ? extracted.legal : extracted.commercial; if (company) $('#mergeCompany').value = company; if (extracted.emails) $('#mergeEmail').value = extracted.emails; const selectedCompany = $('#mergeCompany').value.trim(); const email = $('#mergeEmail').value.trim(); const competencies = parseFinancialText($('#financialText').value); if (!selectedCompany || !email || !competencies.length) { alert('Cole a página completa ou informe empresa, e-mail e um texto com vencimentos e valores identificáveis.'); return; } mergeRows.push({ EMPRESA: selectedCompany, EMAIL: email, COMP1: competencies[0] || '', COMP2: competencies[1] || '', COMP3: competencies[2] || '' }); saveMergeQueue(); renderMergePreview(); }
function renderHistory() { const grouped = billingHistory.reduce((result, item) => { const key = item.company.toUpperCase(); result[key] ||= { company: item.company, emails: item.emails, dates: [], competencies: [] }; result[key].dates.push(item.date); result[key].competencies.push(...item.competencies.filter(Boolean)); return result; }, {}); const rows = Object.values(grouped).sort((a, b) => b.dates[0].localeCompare(a.dates[0])); $('#historyBody').innerHTML = rows.map(row => { const sortedDates = [...row.dates].sort(); return `<tr><td><strong>${escapeHtml(row.company)}</strong></td><td>${escapeHtml(row.emails)}</td><td>${sortedDates.map(date => dateLabel(date)).join(', ')}</td><td><span class="history-count">${row.dates.length}x</span></td><td>${escapeHtml([...new Set(row.competencies)].join(' | '))}</td></tr>`; }).join(''); $('#historyEmpty').classList.toggle('hidden', rows.length > 0); $('#historySummary').textContent = `${billingHistory.length} cobrança(s) registrada(s)`; }
function registerBillingHistory() { mergeRows.forEach(row => billingHistory.push({ company: row.EMPRESA, emails: row.EMAIL, date: today(), competencies: [row.COMP1, row.COMP2, row.COMP3] })); saveHistory(); renderHistory(); }
async function downloadMergeWorkbook() { if (!window.ExcelJS || (!mergeRows.length && !mergeTemplateBuffer)) { alert('Adicione pelo menos uma linha à fila ou carregue um modelo.'); return; } const workbook = new ExcelJS.Workbook(); if (mergeTemplateBuffer) await workbook.xlsx.load(mergeTemplateBuffer); const sheet = workbook.worksheets[0] || workbook.addWorksheet('Mala direta'); if (!sheet.getCell('A1').value) sheet.addRow(['EMPRESA', 'EMAIL', 'COMP1', 'COMP2', 'COMP3']); mergeRows.forEach(row => sheet.addRow([row.EMPRESA, row.EMAIL, row.COMP1, row.COMP2, row.COMP3])); sheet.columns = [{ width: 34 }, { width: 34 }, { width: 32 }, { width: 32 }, { width: 32 }]; sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F78' } }; const buffer = await workbook.xlsx.writeBuffer(); registerBillingHistory(); downloadFile('mala-direta-atualizada.xlsx', buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
function syncTaskTimeQuick() {
  const value = $('#taskDueTime')?.value || '';
  document.querySelectorAll('#taskDialog [data-time-quick]').forEach(button => {
    const active = (button.dataset.timeQuick || '') === value;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const hint = $('#taskDueTimeHint');
  if (hint) hint.textContent = value ? `Com horário: o relógio e o alarme tocam às ${value}.` : 'Sem horário: a demanda fica só na data.';
}
function openDialog(task = null, initialDate = null) { editingId = task?.id || null; const user = window.PortalAccess?.Access?.user; checklistDraft = (task?.checklist || []).map(item => ({ ...item })); attachmentDraft = (task?.attachments || []).map(item => ({ ...item })); $('#dialogEyebrow').textContent = task ? 'EDITAR DEMANDA' : 'NOVA ENTRADA'; $('#dialogTitle').textContent = task ? 'Atualizar demanda' : 'Registrar demanda'; $('#saveTaskButton').textContent = task ? 'Salvar alterações' : 'Adicionar demanda'; $('#deleteDialog')?.classList.toggle('hidden', !task); $('#taskTitle').value = task?.title || ''; $('#taskPeriodStart').value = task?.periodStart || task?.due || initialDate || today(); $('#taskPeriodEnd').value = task?.periodEnd || task?.due || initialDate || today(); $('#taskDueTime').value = task?.dueTime || ''; syncTaskTimeQuick(); $('#taskSectorChoice').value = task?.sectorId || user?.sectorId || ''; $('#taskOwner').value = task?.owner || user?.displayName || ''; $('#taskCategory').value = task?.category || user?.sectorName || ''; $('#taskPriority').value = task?.priority || 'medium'; $('#taskRecurrence').value = task?.recurrence || 'none'; $('#taskStatus').value = normalizedStatus(task || {}); $('#taskNotes').value = task?.notes || ''; renderChecklistEditor(); renderAttachmentEditor(); renderEmailTaskSource(task); $('#taskDialog').showModal(); clearTaskDuplicateWarning(); $('#taskTitle').focus(); }
$('#taskDialog')?.addEventListener('click', event => {
  const chip = event.target.closest('[data-time-quick]');
  if (!chip) return;
  const input = $('#taskDueTime');
  input.value = chip.dataset.timeQuick || '';
  syncTaskTimeQuick();
});
$('#taskDueTime')?.addEventListener('input', syncTaskTimeQuick);
function renderEmailTaskSource(task) {
  let host = $('#emailTaskSource');
  if (!host) {
    host = document.createElement('p');
    host.id = 'emailTaskSource';
    host.className = 'panel-help';
    $('#taskNotes').closest('label').before(host);
  }
  host.replaceChildren();
  host.hidden = !task?.emailSource;
  if (!task?.emailSource) return;
  host.append(document.createTextNode(`Origem: ${task.emailSource.mailbox || 'e-mail'} · `));
  try {
    const url = new URL(task.emailSource.webLink);
    if (url.protocol !== 'https:' || url.username || url.password || !['outlook.office.com', 'outlook.office365.com'].includes(url.hostname)) return;
    const link = document.createElement('a');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = 'Abrir mensagem original no Outlook';
    host.append(link);
  } catch {}
}
window.acceptEmailTask = task => {
  if (!task?.id || window.PortalAccess?.Access?.user?.role !== 'admin') return;
  const index = tasks.findIndex(item => item.id === task.id);
  if (index < 0) tasks.push(task);
  else tasks[index] = task;
  window.PortalNotify?.markLocal?.(task.id);
  window.PortalNotify?.syncTasks?.(tasks);
  render();
};
window.openEmailTask = async taskId => {
  const token = window.PortalAccess?.Access?.token;
  if (!token || window.PortalAccess.Access.user?.role !== 'admin') return;
  try {
    const response = await window.PortalAccess.api('/api/state');
    if (token !== window.PortalAccess.Access.token || window.PortalAccess.Access.user?.role !== 'admin') return;
    const task = (response.state?.tasks || response.tasks || []).find(item => item.id === taskId);
    if (!task) { showToast('A demanda não está mais disponível', 'warning'); return; }
    window.acceptEmailTask(task);
    openDialog(task);
  } catch (error) { showToast(error.message, 'warning'); }
};
$('#themeButton').addEventListener('click', () => { const theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; document.body.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); updateThemeButton(); showToast(theme === 'dark' ? 'Modo noturno ativado' : 'Modo claro ativado'); }); $('#newTaskButton').addEventListener('click', () => openDialog()); $('#mobileNewTaskButton').addEventListener('click', () => openDialog()); $('#closeDialog').addEventListener('click', () => $('#taskDialog').close()); $('#cancelDialog').addEventListener('click', () => $('#taskDialog').close());
$('#deleteDialog')?.addEventListener('click', () => { const task = tasks.find(item => item.id === editingId); if (!task) return; if (!confirm(`Excluir a demanda "${task.title}"?`)) return; deleteTaskById(task.id); $('#taskDialog').close(); editingId = null; showToast('Demanda excluída'); });
['#taskTitle', '#taskOwner', '#taskPeriodEnd', '#taskPeriodStart'].forEach(sel => {
  $(sel)?.addEventListener('input', checkTaskDuplicate);
  $(sel)?.addEventListener('change', checkTaskDuplicate);
});
$('#taskSectorChoice').addEventListener('change', () => { const selected = window.PortalAccess.Access.user?.sectors?.find(sector => sector.id === $('#taskSectorChoice').value); if (selected) $('#taskCategory').value = selected.name; }); $('#addChecklistItem').addEventListener('click', () => { const input = $('#checklistInput'); const text = input.value.trim(); if (!text) return; checklistDraft.push({ id: newId(), text, done: false }); input.value = ''; renderChecklistEditor(); input.focus(); }); $('#checklistInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('#addChecklistItem').click(); } }); $('#checklistItems').addEventListener('change', event => { const index = Number(event.target.dataset.checklistDraftToggle); if (Number.isInteger(index) && checklistDraft[index]) checklistDraft[index].done = event.target.checked; }); $('#checklistItems').addEventListener('click', event => { const index = Number(event.target.closest('[data-checklist-draft-remove]')?.dataset.checklistDraftRemove); if (Number.isInteger(index)) { checklistDraft.splice(index, 1); renderChecklistEditor(); } }); $('#taskAttachments').addEventListener('change', async event => { const files = [...event.target.files]; event.target.value = ''; if (!files.length) return; const list = $('#taskAttachmentList'); const note = document.createElement('div'); note.className = 'attachment-row attachment-pending'; note.textContent = files.length > 1 ? `Enviando ${files.length} arquivos…` : `Enviando ${files[0].name}…`; list.appendChild(note); attachmentUploads += 1; $('#saveTaskButton').disabled = true; try { for (const file of files) { try { const info = await uploadDemandFile(file); attachmentDraft.push({ id: info.mediaId || newId(), name: info.name || file.name, type: info.mime || file.type, size: info.size || file.size, media: info.media }); renderAttachmentEditor(); list.appendChild(note); } catch (error) { alert(`${file.name}: ${error.message}`); } } } finally { attachmentUploads -= 1; note.remove(); renderAttachmentEditor(); $('#saveTaskButton').disabled = false; } }); $('#taskAttachmentList').addEventListener('click', event => { const index = Number(event.target.closest('[data-attachment-remove]')?.dataset.attachmentRemove); if (Number.isInteger(index)) { attachmentDraft.splice(index, 1); renderAttachmentEditor(); } }); $('#taskForm').addEventListener('submit', (event) => { event.preventDefault(); if (attachmentUploads > 0) { alert('Aguarde o envio dos anexos terminar antes de salvar.'); return; } if (!editingId) { const twin = findTaskDuplicate({ title: $('#taskTitle').value, owner: $('#taskOwner').value, due: $('#taskPeriodEnd').value || $('#taskPeriodStart').value }); if (twin) { showTaskDuplicateWarning(twin); return; } } if (!$('#taskOwner').value || !$('#taskCategory').value || !$('#taskSectorChoice').value) { alert('Selecione o setor, responsável e categoria da demanda.'); return; } const periodStart = $('#taskPeriodStart').value; const periodEnd = $('#taskPeriodEnd').value; if (!periodStart || !periodEnd || periodEnd < periodStart) { alert('A data final precisa ser igual ou posterior à data inicial.'); return; } const values = { title: $('#taskTitle').value.trim(), due: periodEnd, periodStart, periodEnd, dueTime: $('#taskDueTime').value || '', sectorId: $('#taskSectorChoice').value, owner: $('#taskOwner').value, category: $('#taskCategory').value, priority: $('#taskPriority').value, recurrence: $('#taskRecurrence').value, status: $('#taskStatus').value, notes: $('#taskNotes').value.trim(), checklist: checklistDraft, attachments: attachmentDraft, updatedAt: new Date().toISOString() }; if (editingId) { const target = tasks.find(task => task.id === editingId); Object.assign(target, values); if (values.status === 'done') { target.completedAt = target.completedAt || new Date().toISOString(); } else { delete target.completedAt; } window.PortalNotify?.markLocal?.(editingId); } else { const created = { id: newId(), ...values, createdAt: new Date().toISOString(), completedAt: values.status === 'done' ? new Date().toISOString() : null }; tasks.push(created); window.PortalNotify?.markLocal?.(created.id); } save(); window.PortalNotify?.syncTasks?.(tasks); render(); if (!$('#reports').classList.contains('hidden')) renderReports(); $('#taskForm').reset(); checklistDraft = []; attachmentDraft = []; $('#taskDialog').close(); editingId = null; });
function syncManagerScopeTabs() { /* removido - filtro simplificado */ }
window.syncManagerScopeTabs = syncManagerScopeTabs;
// scope-tab pills removidas do HTML; listener mantido vazio por segurança
document.querySelectorAll('.scope-tab').forEach(tab => {
  tab.addEventListener('click', () => {});
});
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { activeStatFilter = null; document.querySelectorAll('.tab').forEach(t => t.classList.remove('active')); tab.classList.add('active'); currentView = tab.dataset.view; render(); }));
['statusFilter','ownerFilter','priorityFilter','periodFilterStart','periodFilterEnd','searchInput'].forEach(id => $(`#${id}`).addEventListener('input', () => { activeStatFilter = null; if (id === 'ownerFilter') { const val = $('#ownerFilter').value; if (val && val !== 'all') { currentView = 'all'; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'all')); } } render(); })); $('#ownerFilter')?.addEventListener('change', () => { activeStatFilter = null; const val = $('#ownerFilter').value; if (val && val !== 'all') { currentView = 'all'; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'all')); } render(); }); $('#clearPeriodFilter').addEventListener('click', () => { activeStatFilter = null; $('#periodFilterStart').value = ''; $('#periodFilterEnd').value = ''; render(); });
$('#listViewButton').addEventListener('click', () => setDisplayMode('list')); $('#calendarViewButton').addEventListener('click', () => setDisplayMode('calendar')); document.querySelectorAll('.stat-filter').forEach(card => { const activate = () => { activeStatFilter = card.dataset.statFilter; currentView = 'all'; $('#statusFilter').value = 'all'; $('#ownerFilter').value = 'all'; $('#priorityFilter').value = 'all'; $('#periodFilterStart').value = ''; $('#periodFilterEnd').value = ''; $('#searchInput').value = ''; document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item.dataset.view === 'all')); render(); }; card.addEventListener('click', activate); card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }); }); $('#calendarPrev').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth() - 1); renderCalendar(); }); $('#calendarNext').addEventListener('click', () => { calendarCursor.setMonth(calendarCursor.getMonth() + 1); renderCalendar(); }); $('#calendarToday').addEventListener('click', () => { calendarCursor = new Date(); renderCalendar(); }); $('#calendarGrid').addEventListener('click', event => { const day = event.target.closest('[data-calendar-date]'); if (day) openCalendarDay(day.dataset.calendarDate); }); $('#closeCalendarDay').addEventListener('click', () => $('#calendarDayDialog').close()); $('#newCalendarDemand').addEventListener('click', () => { const date = calendarSelectedDate || today(); $('#calendarDayDialog').close(); openDialog(null, date); }); $('#calendarDayList').addEventListener('change', event => { const input = event.target.closest('[data-checklist-task]'); if (!input) return; const task = tasks.find(item => item.id === input.dataset.checklistTask); const item = task?.checklist?.[Number(input.dataset.checklistIndex)]; if (!item) return; item.done = input.checked; save(); openCalendarDay(calendarSelectedDate); }); $('#calendarDayList').addEventListener('click', event => { const button = event.target.closest('[data-calendar-action]'); if (!button) return; const task = tasks.find(item => item.id === button.dataset.id); if (!task) return; if (button.dataset.calendarAction === 'claim') claimTask(task); if (button.dataset.calendarAction === 'toggle') completeTask(task); if (button.dataset.calendarAction === 'edit') { $('#calendarDayDialog').close(); openDialog(task); return; } save(); render(); openCalendarDay(calendarSelectedDate); });
$('#newLearningNote').addEventListener('click', addLearningNote); $('#addLearningLink').addEventListener('click', addLearningLink); $('#learningFiles').addEventListener('change', event => handleLearningFiles(event.target.files)); $('#learningSearch').addEventListener('input', renderLearning); $('#addFlowNode').addEventListener('click', addFlowNode); $('#newFlow').addEventListener('click', createFlow); $('#renameFlow').addEventListener('click', renameFlow); $('#flowSelector').addEventListener('change', event => { learningData.activeFlowId = event.target.value; flowSourceId = null; saveLearning(); renderFlow(); }); $('#clearFlowConnections').addEventListener('click', () => { if (confirm('Remover todas as setas deste fluxograma?')) { activeFlow().edges = []; flowSourceId = null; saveLearning(); renderFlow(); } }); $('#cancelFlowConnection').addEventListener('click', () => { flowSourceId = null; $('#flowStatus').textContent = 'Modo conectar: clique na etapa de origem e depois na etapa de destino.'; renderFlow(); }); $('#clearFlow').addEventListener('click', () => { if (confirm('Limpar todas as etapas e conexões deste fluxograma?')) { const flow = activeFlow(); flow.nodes = []; flow.edges = []; flowSourceId = null; saveLearning(); renderFlow(); } });
$('#copyToolsPath').addEventListener('click', async () => { const path = 'C:\\Users\\Rede Saude\\Documents\\KAYNAN\\meusarquivos\\meusarquivos\\Organizacao'; try { await navigator.clipboard.writeText(path); $('#copyToolsPath').textContent = 'Caminho copiado'; setTimeout(() => { $('#copyToolsPath').textContent = 'Copiar caminho da pasta'; }, 1800); } catch { alert(`Copie este caminho no Explorador de Arquivos:\n${path}`); } });
document.querySelector('#learningScreen').addEventListener('click', event => { const deleteButton = event.target.closest('[data-learning-delete]'); if (deleteButton) { learningData[`${deleteButton.dataset.learningDelete}s`].splice(Number(deleteButton.dataset.index), 1); saveLearning(); renderLearning(); return; } const node = event.target.closest('[data-flow-node]'); if (!node) return; const flow = activeFlow(); const nodeId = node.dataset.flowNode; if (event.target.tagName === 'SPAN') { flow.nodes = flow.nodes.filter(item => item.id !== nodeId); flow.edges = flow.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId); if (flowSourceId === nodeId) flowSourceId = null; saveLearning(); renderFlow(); return; } if (!flowSourceId) { flowSourceId = nodeId; $('#flowStatus').textContent = `Origem: ${flow.nodes.find(item => item.id === nodeId)?.label || 'etapa'}. Agora clique no destino.`; renderFlow(); return; } if (flowSourceId === nodeId) { flowSourceId = null; $('#flowStatus').textContent = 'Modo conectar: clique na etapa de origem e depois na etapa de destino.'; renderFlow(); return; } if (!flow.edges.some(edge => edge.from === flowSourceId && edge.to === nodeId)) flow.edges.push({ from: flowSourceId, to: nodeId }); flowSourceId = null; $('#flowStatus').textContent = 'Seta criada. Escolha outra origem para continuar.'; saveLearning(); renderFlow(); });
document.querySelector('#learningScreen').addEventListener('click', event => {
  const action = event.target.closest('[data-training-complete],[data-training-reset],[data-training-certificate],[data-training-edit],[data-training-delete],[data-note-edit],[data-link-edit]');
  if (!action) return;
  const data = action.dataset;
  if (data.trainingComplete) return completeTraining(data.trainingComplete);
  if (data.trainingReset) return resetTraining(data.trainingReset);
  if (data.trainingCertificate) return downloadTrainingCertificate(data.trainingCertificate);
  if (data.trainingEdit) return openTrainingDialog(learningData.trainings.find(item => item.id === data.trainingEdit));
  if (data.trainingDelete) { if (confirm('Excluir esta trilha e todo o progresso registrado?')) { learningData.trainings = learningData.trainings.filter(item => item.id !== data.trainingDelete); saveLearning(); renderLearning(); } return; }
  if (data.noteEdit !== undefined) return openNoteDialog(Number(data.noteEdit));
  if (data.linkEdit !== undefined) return openLinkDialog(Number(data.linkEdit));
});
$('#learningTrainings')?.addEventListener('change', event => { const input = event.target.closest('[data-training-step]'); if (!input) return; toggleTrainingStep(input.dataset.trainingId, input.dataset.trainingStep, input.checked); });
document.querySelectorAll('[data-learning-tab]').forEach(button => button.addEventListener('click', () => setLearningTab(button.dataset.learningTab)));
document.querySelectorAll('[data-training-filter]').forEach(button => button.addEventListener('click', () => { learningFilter = button.dataset.trainingFilter; document.querySelectorAll('[data-training-filter]').forEach(item => item.classList.toggle('active', item === button)); renderTrainings(); }));
$('#newTraining')?.addEventListener('click', () => openTrainingDialog());
$('#emptyNewTraining')?.addEventListener('click', () => openTrainingDialog());
$('#seedTrainings')?.addEventListener('click', seedTrainings);
$('#newLearningNoteInline')?.addEventListener('click', () => openNoteDialog());
$('#clearLearningSearch')?.addEventListener('click', () => { $('#learningSearch').value = ''; renderLearning(); $('#learningSearch').focus(); });
$('#trainingForm')?.addEventListener('submit', saveTrainingFromForm);
$('#addTrainingStep')?.addEventListener('click', addTrainingDraftStep);
$('#trainingStepInput')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTrainingDraftStep(); } });
$('#trainingSteps')?.addEventListener('click', event => { const button = event.target.closest('[data-training-draft-remove]'); if (!button) return; trainingDraftSteps.splice(Number(button.dataset.trainingDraftRemove), 1); renderTrainingSteps(); });
['closeTrainingDialog', 'cancelTraining'].forEach(id => $(`#${id}`)?.addEventListener('click', () => $('#trainingDialog').close()));
$('#noteForm')?.addEventListener('submit', saveNoteFromForm);
['closeNoteDialog', 'cancelNoteDialog'].forEach(id => $(`#${id}`)?.addEventListener('click', () => $('#noteDialog').close()));
$('#linkForm')?.addEventListener('submit', saveLinkFromForm);
['closeLinkDialog', 'cancelLinkDialog'].forEach(id => $(`#${id}`)?.addEventListener('click', () => $('#linkDialog').close()));
let draggingFlowNode = null; let dragOffset = { x: 0, y: 0 }; document.querySelector('#flowNodes').addEventListener('mousedown', event => { const nodeElement = event.target.closest('[data-flow-node]'); if (!nodeElement || event.target.tagName === 'SPAN') return; const node = activeFlow().nodes.find(item => item.id === nodeElement.dataset.flowNode); const bounds = $('#flowCanvas').getBoundingClientRect(); draggingFlowNode = node; dragOffset = { x: event.clientX - bounds.left - node.x, y: event.clientY - bounds.top - node.y }; }); document.addEventListener('mousemove', event => { if (!draggingFlowNode) return; const bounds = $('#flowCanvas').getBoundingClientRect(); draggingFlowNode.x = Math.max(8, event.clientX - bounds.left - dragOffset.x); draggingFlowNode.y = Math.max(8, event.clientY - bounds.top - dragOffset.y); renderFlow(); }); document.addEventListener('mouseup', () => { if (draggingFlowNode) { saveLearning(); draggingFlowNode = null; } });
$('#reportButton').addEventListener('click', () => window.PortalAccess?.openScreen('reportsScreen'));
['reportStart', 'reportEnd'].forEach(id => $(`#${id}`).addEventListener('change', () => { document.querySelectorAll('[data-report-range]').forEach(button => button.classList.remove('active')); const preset = $('#reportPreset'); if (preset) preset.value = ''; renderReports(); }));
$('#clearPeriod').addEventListener('click', () => setReportPreset('all'));
document.querySelectorAll('[data-report-range]').forEach(button => button.addEventListener('click', () => setReportPreset(button.dataset.reportRange)));
$('#reportSector')?.addEventListener('change', renderReports);
$('#reportPrint')?.addEventListener('click', () => window.print());
$('#reportCsv')?.addEventListener('click', exportReportCsv);
$('#reportPeopleCsv')?.addEventListener('click', exportPeopleCsv);
$('#closeReportDialog')?.addEventListener('click', () => $('#reportTasksDialog').close());
$('#reportStats')?.addEventListener('click', event => { const button = event.target.closest('[data-report-drill]'); if (button) openReportDrill(button.dataset.reportDrill); });
$('#reportAiPrompt')?.addEventListener('click', () => openAiPromptDialog());
$('#reportInsightsPrompt')?.addEventListener('click', () => openAiPromptDialog());
$('#reportInsights')?.addEventListener('click', event => {
  const promptButton = event.target.closest('[data-insight-prompt]');
  if (promptButton) { openAiPromptDialog(promptButton.dataset.insightPrompt); return; }
  const drillButton = event.target.closest('[data-report-drill]');
  if (drillButton) openReportDrill(drillButton.dataset.reportDrill);
});
$('#closeAiPrompt')?.addEventListener('click', () => $('#aiPromptDialog').close());
$('#generateAiPrompt')?.addEventListener('click', generateAiPrompt);
$('#aiPromptDialog')?.addEventListener('change', event => { if (event.target.closest('.ai-focus, #aiPromptFormat, #aiPromptIncludeTasks')) persistAiDialogPrefs(); });
$('#copyAiPrompt')?.addEventListener('click', async () => {
  const field = $('#aiPromptText');
  if (!field.value) { showToast('Gere o prompt antes de copiar', 'warning'); return; }
  try { await navigator.clipboard.writeText(field.value); showToast('Prompt copiado. Cole na IA e anexe a imagem modelo.'); }
  catch { field.focus(); field.select(); showToast('Selecione o texto e use Ctrl+C para copiar', 'warning'); }
});
$('#downloadAiPrompt')?.addEventListener('click', () => {
  const text = $('#aiPromptText').value;
  if (!text) { showToast('Gere o prompt antes de baixar', 'warning'); return; }
  downloadFile(`prompt-relatorio-${today()}.txt`, text, 'text/plain;charset=utf-8');
});
$('#downloadAiModel')?.addEventListener('click', () => {
  const link = document.createElement('a'); link.href = 'assets/modelo-relatorio.png'; link.download = 'modelo-relatorio-rede-saude.png'; document.body.appendChild(link); link.click(); link.remove();
  showToast('Imagem modelo baixada. Anexe na conversa com a IA.');
});
$('#statusChart')?.addEventListener('click', event => { const button = event.target.closest('[data-report-status]'); if (button) openReportDrill(`status:${button.dataset.reportStatus}`); });
$('#ownerChart')?.addEventListener('click', event => { const button = event.target.closest('[data-report-owner]'); if (button) openReportDrill(`owner:${button.dataset.reportOwner}`); });
$('#individualReports')?.addEventListener('click', event => { const button = event.target.closest('[data-report-owner]'); if (button) openReportDrill(`owner:${button.dataset.reportOwner}`); });
function openReportTask(taskId) { const task = tasks.find(item => item.id === taskId); if (!task) return; if ($('#reportTasksDialog')?.open) $('#reportTasksDialog').close(); openDialog(task); }
$('#reports')?.addEventListener('click', event => { const row = event.target.closest('[data-report-task]'); if (row) openReportTask(row.dataset.reportTask); });
$('#reportDialogList')?.addEventListener('click', event => { const row = event.target.closest('[data-report-task]'); if (row) openReportTask(row.dataset.reportTask); });
$('#exportButton').addEventListener('click', () => $('#exportMenu').classList.toggle('hidden')); $('#exportTxt').addEventListener('click', () => { exportTxt(); $('#exportMenu').classList.add('hidden'); }); $('#exportXlsx').addEventListener('click', async () => { try { await exportXlsx(); } catch (error) { console.error(error); alert(`Não foi possível gerar o Excel. Motivo: ${error.message}`); } $('#exportMenu').classList.add('hidden'); }); $('#exportJson').addEventListener('click', () => { exportJson(); $('#exportMenu').classList.add('hidden'); }); $('#importJsonButton').addEventListener('click', () => $('#importJson').click()); $('#importJson').addEventListener('change', event => { const file = event.target.files[0]; if (file) importJson(file); event.target.value = ''; });
function fillMergeFields() { const extracted = extractCompanyAndEmails($('#financialText').value); const company = $('#mergeNameMode').value === 'legal' ? extracted.legal : extracted.commercial; if (company) $('#mergeCompany').value = company; if (extracted.emails) $('#mergeEmail').value = extracted.emails; }
$('#mergePreviewContent')?.addEventListener('input', event => { const field = event.target.dataset.mergeField; const index = Number(event.target.dataset.index); if (field && mergeRows[index]) { mergeRows[index][field] = event.target.value; saveMergeQueue(); } }); $('#mergePreviewContent')?.addEventListener('click', event => { const button = event.target.closest('[data-queue-action]'); if (!button) return; const index = Number(button.dataset.index); const action = button.dataset.queueAction; if (action === 'delete') mergeRows.splice(index, 1); if (action === 'up' && index > 0) [mergeRows[index - 1], mergeRows[index]] = [mergeRows[index], mergeRows[index - 1]]; if (action === 'down' && index < mergeRows.length - 1) [mergeRows[index + 1], mergeRows[index]] = [mergeRows[index], mergeRows[index + 1]]; saveMergeQueue(); if (mergeRows.length) renderMergePreview(); else $('#mergePreview')?.classList.add('hidden'); });
$('#financialText')?.addEventListener('input', fillMergeFields); $('#mergeNameMode')?.addEventListener('change', fillMergeFields); $('#parseMerge')?.addEventListener('click', parseMerge); $('#clearMerge')?.addEventListener('click', () => { $('#mergeCompany').value = ''; $('#mergeEmail').value = ''; $('#financialText').value = ''; $('#mergePreview').classList.toggle('hidden', !mergeRows.length); renderMergePreview(); }); $('#addMergeRow')?.addEventListener('click', () => { $('#mergeCompany').value = ''; $('#mergeEmail').value = ''; $('#financialText').value = ''; $('#mergePreview').classList.toggle('hidden', !mergeRows.length); renderMergePreview(); }); $('#downloadMerge')?.addEventListener('click', downloadMergeWorkbook); $('#mergeTemplate')?.addEventListener('change', async event => { const file = event.target.files[0]; if (file) { mergeTemplateBuffer = await file.arrayBuffer(); $('#mergeQueueNote').textContent = `Modelo carregado: ${file.name}. As novas linhas serão adicionadas abaixo do conteúdo existente.`; } });
$('#taskList').addEventListener('change', event => { const input = event.target.closest('[data-checklist-task]'); if (!input) return; const task = tasks.find(item => item.id === input.dataset.checklistTask); const item = task?.checklist?.[Number(input.dataset.checklistIndex)]; if (!item) return; item.done = input.checked; touchTask(task); save(); render(); }); $('#taskList').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (!button) return; const task = tasks.find(t => t.id === button.dataset.id); if (button.dataset.action === 'toggle') completeTask(task); if (button.dataset.action === 'claim') claimTask(task); if (button.dataset.action === 'add-checklist') { addTaskChecklistItem(task); return; } if (button.dataset.action === 'edit') openDialog(task); if (button.dataset.action === 'delete' && confirm(`Excluir a demanda "${task.title}"?`)) { registerRecurrenceSkip(task); deletedTaskIds.add(task.id); localStorage.setItem(DELETED_TASKS_KEY, JSON.stringify([...deletedTaskIds])); tasks = tasks.filter(t => t.id !== button.dataset.id); } save(); render(); if (!$('#reports').classList.contains('hidden')) renderReports(); });
let completionAudioContext = null;
const completionSoundPatterns = {
  success: [
    { frequency: 523.25, delay: 0, duration: .22 },
    { frequency: 659.25, delay: .12, duration: .22 },
    { frequency: 783.99, delay: .24, duration: .42 },
  ],
  bell: [
    { frequency: 880, delay: 0, duration: .55 },
    { frequency: 1318.51, delay: .08, duration: .42 },
  ],
  goal: [
    { frequency: 392, delay: 0, duration: .16, type: 'square' },
    { frequency: 523.25, delay: .13, duration: .16, type: 'square' },
    { frequency: 659.25, delay: .26, duration: .18, type: 'square' },
    { frequency: 783.99, delay: .40, duration: .55, type: 'sawtooth' },
  ],
  sparkle: [
    { frequency: 1046.5, delay: 0, duration: .16 },
    { frequency: 1318.51, delay: .10, duration: .16 },
    { frequency: 1567.98, delay: .20, duration: .28 },
  ],
  fanfare: [
    { frequency: 392, delay: 0, duration: .16, type: 'triangle' },
    { frequency: 523.25, delay: .13, duration: .16, type: 'triangle' },
    { frequency: 659.25, delay: .26, duration: .16, type: 'triangle' },
    { frequency: 783.99, delay: .39, duration: .48, type: 'triangle' },
  ],
  victory: [
    { frequency: 261.63, delay: 0, duration: .18, type: 'triangle' },
    { frequency: 329.63, delay: .11, duration: .18, type: 'triangle' },
    { frequency: 392, delay: .22, duration: .18, type: 'triangle' },
    { frequency: 523.25, delay: .33, duration: .58, type: 'triangle' },
  ],
  celebration: [
    { frequency: 659.25, delay: 0, duration: .14, type: 'sine' },
    { frequency: 783.99, delay: .10, duration: .14, type: 'sine' },
    { frequency: 987.77, delay: .20, duration: .18, type: 'sine' },
    { frequency: 1318.51, delay: .33, duration: .38, type: 'sine' },
  ],
  digital: [
    { frequency: 880, delay: 0, duration: .08, type: 'square' },
    { frequency: 1174.66, delay: .11, duration: .08, type: 'square' },
    { frequency: 1567.98, delay: .22, duration: .16, type: 'square' },
  ],
  doubleBell: [
    { frequency: 783.99, delay: 0, duration: .38, type: 'sine' },
    { frequency: 1046.5, delay: .26, duration: .55, type: 'sine' },
  ],
  positive: [
    { frequency: 493.88, delay: 0, duration: .15, type: 'triangle' },
    { frequency: 659.25, delay: .13, duration: .15, type: 'triangle' },
    { frequency: 783.99, delay: .26, duration: .32, type: 'triangle' },
  ],
};
function playCompletionSound(sound = localStorage.getItem(COMPLETION_SOUND_KEY) || 'success') {
  if (sound === 'off') return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    completionAudioContext ||= new AudioContextClass();
    const context = completionAudioContext;
    if (context.state === 'suspended') context.resume();
    const start = context.currentTime;
    const notes = completionSoundPatterns[sound] || completionSoundPatterns.success;
    notes.forEach(note => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = start + note.delay;
      const noteEnd = noteStart + note.duration;
      oscillator.type = note.type || 'sine';
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(.12, noteStart + .025);
      gain.gain.exponentialRampToValueAtTime(.0001, noteEnd);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteEnd + .02);
    });
  } catch (error) {
    console.warn('Não foi possível reproduzir o som de conclusão.', error);
  }
}
function renderCompletionSoundPreference() {
  const select = $('#completionSoundSelect');
  if (select) select.value = localStorage.getItem(COMPLETION_SOUND_KEY) || 'success';
}
window.renderCompletionSoundPreference = renderCompletionSoundPreference;
$('#completionSoundSelect')?.addEventListener('change', event => {
  localStorage.setItem(COMPLETION_SOUND_KEY, event.target.value);
  showToast(event.target.value === 'off' ? 'Som de conclusão desativado' : 'Som de conclusão atualizado');
});
$('#testCompletionSound')?.addEventListener('click', () => playCompletionSound($('#completionSoundSelect')?.value));
function normTaskText(value) { return String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' '); }
function findTaskDuplicate(candidate, excludeId) {
  const title = normTaskText(candidate?.title);
  const owner = normTaskText(candidate?.owner);
  const due = String(candidate?.due || candidate?.periodEnd || '').slice(0, 10);
  if (!title || !owner || !due) return null;
  return tasks.find(item => {
    if (excludeId && item.id === excludeId) return false;
    if (normTaskText(item.title) !== title) return false;
    if (normTaskText(item.owner) !== owner) return false;
    return String(item.due || item.periodEnd || '').slice(0, 10) === due;
  }) || null;
}
function clearTaskDuplicateWarning() {
  const box = $('#taskDuplicateWarn');
  if (box) box.classList.add('hidden');
  const btn = $('#saveTaskButton');
  if (btn) btn.textContent = editingId ? 'Salvar alterações' : 'Adicionar demanda';
}
function showTaskDuplicateWarning(twin) {
  const box = $('#taskDuplicateWarn');
  if (!box || !twin) return;
  $('#taskDuplicateTitle').textContent = 'Já existe uma demanda igual';
  $('#taskDuplicateText').textContent = `"${twin.title}" para ${twin.owner} em ${formatDate(twin.due)}${twin.status === 'done' ? ' (já concluída)' : ''}. Se salvar assim, ficam duas.`;
  $('#taskDuplicateOpen').dataset.openDuplicate = twin.id;
  box.classList.remove('hidden');
  const btn = $('#saveTaskButton');
  if (btn) btn.textContent = 'Criar mesmo assim';
}
function formatDate(iso) {
  const d = new Date(`${String(iso || '').slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function checkTaskDuplicate() {
  if (editingId) { clearTaskDuplicateWarning(); return; }
  const title = $('#taskTitle').value;
  const owner = $('#taskOwner').value;
  const due = $('#taskPeriodEnd').value || $('#taskPeriodStart').value;
  const twin = findTaskDuplicate({ title, owner, due });
  if (twin) showTaskDuplicateWarning(twin); else clearTaskDuplicateWarning();
}

$('#taskDuplicateOpen')?.addEventListener('click', event => {
  const id = event.currentTarget.dataset.openDuplicate;
  const twin = tasks.find(item => item.id === id);
  if (!twin) return;
  $('#taskDialog').close();
  clearTaskDuplicateWarning();
  openDialog(twin);
});
function completeTask(task) {
  if (task.status === 'done') { task.status = 'todo'; delete task.completedAt; touchTask(task); return; }
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  touchTask(task);
  playCompletionSound();
  // A próxima ocorrência de uma série é criada pelo servidor
  // (ensure_recurring_occurrences), que reserva a vaga (série, dia) no banco.
  // Criar aqui também era o que gerava duas demandas iguais no mesmo dia.
}
/* ══════════ AVISOS DO SISTEMA (bandeja do Windows) ══════════ */
const NOTIFY_LEGACY_KEY = 'portal-avisos-v1';
const NOTIFY_PREFS_KEY = 'portal-avisos-prefs-v1';
const NOTIFY_ICON = 'assets/rede-saude-icone.png';
const NOTIFY_DEFAULTS = { enabled: false, chat: true, retornos: true, contracts: true, registration: true, tasks: true, deadlines: true };
const NOTIFY_CATEGORY_LABELS = { chat: 'Mensagens do chat', retornos: 'Retornos das instituições financeiras', contracts: 'Novos contratos', registration: 'Cadastro de empresas', tasks: 'Demandas para mim', deadlines: 'Prazos com horário' };
const portalNotifyState = {
  userId: null,
  chats: new Map(),
  chatReady: false,
  tasks: new Map(),
  tasksReady: false,
  seenMessages: new Set(),
  seenTasks: new Set(),
  localTaskIds: new Set(),
};

function notifyPrefsStore() {
  try {
    const store = JSON.parse(localStorage.getItem(NOTIFY_PREFS_KEY) || '{}');
    return store && typeof store === 'object' ? store : {};
  } catch { return {}; }
}

function notifyUserKey() { return String(window.PortalAccess?.Access?.user?.id || 'anon'); }

function notifyPrefs() {
  const saved = notifyPrefsStore()[notifyUserKey()];
  const prefs = { ...NOTIFY_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!saved && localStorage.getItem(NOTIFY_LEGACY_KEY) === 'on') prefs.enabled = true;
  return prefs;
}

function saveNotifyPrefs(patch) {
  const store = notifyPrefsStore();
  const key = notifyUserKey();
  const next = { ...NOTIFY_DEFAULTS, ...(store[key] || {}), ...patch };
  store[key] = next;
  localStorage.setItem(NOTIFY_PREFS_KEY, JSON.stringify(store));
  localStorage.removeItem(NOTIFY_LEGACY_KEY);
  return next;
}

function notifySupported() { return 'Notification' in window && Boolean(window.isSecureContext); }
function notifyPermission() { return 'Notification' in window ? Notification.permission : 'unsupported'; }
function notifyEnabled() { return notifySupported() && notifyPermission() === 'granted' && notifyPrefs().enabled; }
function notifyAllows(category) { const prefs = notifyPrefs(); return Object.hasOwn(NOTIFY_CATEGORY_LABELS, category) && prefs.enabled && prefs[category] !== false; }
function notifyTrim(value, limit = 120) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; }
function notifyOwnerName(value) { return String(value || '').trim().toLowerCase(); }
function notifyDateLabel(value) { const date = new Date(`${value || ''}T12:00:00`); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); }

function portalNotify(options) {
  if (!options) return null;
  if (options.category && !notifyAllows(options.category)) return null;
  if (notifyPermission() !== 'granted') return null;
  try {
    const item = new Notification(options.title, {
      body: options.body || '',
      tag: options.tag || `portal-${Date.now()}`,
      icon: NOTIFY_ICON,
      badge: NOTIFY_ICON,
      requireInteraction: Boolean(options.requireInteraction),
    });
    item.onclick = () => {
      try { window.focus(); } catch {}
      try { options.onClick?.(); } catch (error) { console.warn('Aviso: falha ao abrir o destino', error); }
      item.close();
    };
    return item;
  } catch (error) {
    console.warn('Aviso: não foi possível exibir a notificação', error);
    return null;
  }
}

function resetNotifyState(userId = null) {
  portalNotifyState.userId = userId;
  portalNotifyState.chats = new Map();
  portalNotifyState.chatReady = false;
  portalNotifyState.tasks = new Map();
  portalNotifyState.tasksReady = false;
  portalNotifyState.seenMessages.clear();
  portalNotifyState.seenTasks.clear();
  portalNotifyState.localTaskIds.clear();
}

function notifyPreview(message) {
  const kind = message?.kind;
  const label = kind === 'image' ? 'Foto' : kind === 'video' ? 'Vídeo' : kind === 'audio' ? 'Áudio' : kind === 'file' ? 'Arquivo' : '';
  const body = notifyTrim(message?.body, 110);
  if (!label) return body || 'Nova mensagem.';
  return body ? `${label}: ${body}` : `Enviou ${label === 'Foto' ? 'uma foto' : label === 'Vídeo' ? 'um vídeo' : label === 'Arquivo' ? 'um arquivo' : 'um áudio'}.`;
}

function syncChatNotifications(entries, context = {}) {
  const user = window.PortalAccess?.Access?.user;
  if (!user) return;
  if (portalNotifyState.userId !== user.id) resetNotifyState(user.id);
  const ready = portalNotifyState.chatReady;
  (entries || []).forEach(entry => {
    const last = entry?.lastMessage;
    if (!entry?.scope || !last?.id) return;
    const key = `${entry.scope}:${entry.scopeId || ''}`;
    const previousId = portalNotifyState.chats.get(key) || '';
    portalNotifyState.chats.set(key, last.id);
    if (!ready) return;
    if (last.id === previousId || !entry.unread) return;
    if (last.userId === user.id) return;
    if (context.activeKey === key && context.visible && context.focused) return;
    if (portalNotifyState.seenMessages.has(last.id)) return;
    portalNotifyState.seenMessages.add(last.id);
    if (!notifyAllows('chat')) return;
    const isDirect = entry.scope === 'direct';
    portalNotify({
      title: isDirect ? `Mensagem de ${entry.name}` : `Nova mensagem · ${entry.name}`,
      body: `${last.userName || 'Alguém'}: ${notifyPreview(last)}`,
      tag: `chat-${key}`,
      onClick: () => {
        window.PortalAccess?.openScreen?.('chatScreen');
        setTimeout(() => window.openChatTarget?.({
          scope: entry.scope,
          scopeId: entry.scopeId || '',
          name: entry.name,
          sector: entry.sector,
          role: entry.role,
          photo: entry.photo,
        }), 150);
      },
    });
  });
  portalNotifyState.chatReady = true;
}

function syncTaskNotifications(list) {
  if (!notifyAllows('tasks')) return;
  const user = window.PortalAccess?.Access?.user;
  if (!user) return;
  if (portalNotifyState.userId !== user.id) resetNotifyState(user.id);
  const myName = notifyOwnerName(user.displayName);
  const isMine = task => {
    const owner = notifyOwnerName(task?.owner);
    return Boolean(owner) && (owner === myName || owner === 'ambos');
  };
  const previousTasks = portalNotifyState.tasks;
  const ready = portalNotifyState.tasksReady;
  const current = new Map();
  (list || []).forEach(task => {
    if (!task?.id) return;
    current.set(String(task.id), { owner: notifyOwnerName(task.owner), task });
  });
  portalNotifyState.tasks = current;
  portalNotifyState.tasksReady = true;
  if (!ready) return;
  current.forEach((entry, id) => {
    if (!isMine(entry.task)) return;
    if (portalNotifyState.localTaskIds.has(id)) return;
    const before = previousTasks.get(id);
    if (!before) {
      if (portalNotifyState.seenTasks.has(id)) return;
      portalNotifyState.seenTasks.add(id);
      if (!notifyAllows('tasks')) return;
      const due = notifyDateLabel(entry.task.due);
      portalNotify({
        title: 'Nova demanda para você',
        body: `${notifyTrim(entry.task.title, 90)}${due ? ` · prazo ${due}` : ''}`,
        tag: `demanda-${id}`,
        onClick: () => window.PortalAccess?.openScreen?.('tasksScreen'),
      });
      return;
    }
    if (before.owner === entry.owner) return;
    if (before.owner === myName || before.owner === 'ambos') return;
    if (portalNotifyState.seenTasks.has(`${id}:assigned`)) return;
    portalNotifyState.seenTasks.add(`${id}:assigned`);
    if (!notifyAllows('tasks')) return;
    portalNotify({
      title: 'Demanda atribuída a você',
      body: notifyTrim(entry.task.title, 90),
      tag: `demanda-${id}-atribuida`,
      onClick: () => window.PortalAccess?.openScreen?.('tasksScreen'),
    });
  });
}

function notifySecureAddress() { const host = window.location.hostname || '127.0.0.1'; return `https://${host}:5443`; }

function renderNotifyButton() {
  const button = $('#notifyButton');
  if (!button) return;
  const permission = notifyPermission();
  const prefs = notifyPrefs();
  let state = 'off';
  let label = 'Ativar avisos';
  let title = 'Escolher o que receber na bandeja do Windows.';
  if (!notifySupported()) {
    state = 'unavailable';
    label = 'Avisos indisponíveis';
    title = `Este endereço não libera avisos no navegador. Abra o portal pelo endereço seguro (${notifySecureAddress()}) e aceite o certificado.`;
  } else if (permission === 'denied') {
    state = 'blocked';
    label = 'Avisos bloqueados';
    title = 'O navegador bloqueou os avisos deste site. Libere em Configurações do site e recarregue o portal.';
  } else if (notifyEnabled()) {
    const tipos = Object.keys(NOTIFY_CATEGORY_LABELS).filter(key => prefs[key] !== false).length;
    state = 'on';
    label = 'Avisos ativos';
    title = `Avisos ligados neste computador (${tipos} de ${Object.keys(NOTIFY_CATEGORY_LABELS).length} tipos). Clique para ajustar.`;
  } else if (permission === 'granted') {
    state = 'granted';
    label = 'Ligar avisos';
    title = 'O navegador já autoriza. Clique para escolher o que receber.';
  }
  button.dataset.state = state;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false');
}

function notifyStatusInfo() {
  if (!notifySupported()) {
    return {
      tone: 'warn',
      text: `Este endereço não libera avisos. Abra o portal por ${notifySecureAddress()} e aceite o certificado do portal.`,
    };
  }
  const permission = notifyPermission();
  if (permission === 'denied') {
    return { tone: 'warn', text: 'O navegador bloqueou os avisos deste site. Libere em Configurações do site → Notificações e recarregue o portal.' };
  }
  if (permission === 'granted') {
    return notifyPrefs().enabled
      ? { tone: 'good', text: 'Avisos ligados neste computador.' }
      : { tone: 'info', text: 'O navegador já autoriza. Marque a opção acima para ligar os avisos.' };
  }
  return { tone: 'info', text: 'Ao ligar, o navegador vai pedir autorização. Escolha “Permitir”.' };
}

function renderNotifyDialog() {
  const dialog = $('#notifyDialog');
  if (!dialog) return;
  const supported = notifySupported();
  const permission = notifyPermission();
  const prefs = notifyPrefs();
  const blocked = !supported || permission === 'denied';
  const toggle = $('#notifyEnabledToggle');
  if (toggle) {
    toggle.checked = notifyEnabled();
    toggle.disabled = blocked;
  }
  document.querySelectorAll('[data-notify-cat]').forEach(input => {
    input.checked = prefs[input.dataset.notifyCat] !== false;
    input.disabled = blocked;
    input.closest('label')?.classList.toggle('is-off', !prefs.enabled);
  });
  const status = notifyStatusInfo();
  const statusBox = $('#notifyStatus');
  if (statusBox) {
    statusBox.textContent = status.text;
    statusBox.dataset.tone = status.tone;
  }
  const note = $('#notifyNote');
  if (note) {
    note.textContent = notifyPrefs().enabled
      ? 'Estas escolhas valem para a sua conta neste navegador. Os avisos aparecem enquanto o portal estiver aberto nesta aba (pode ficar minimizado).'
      : 'A escolha do que receber fica guardada mesmo com os avisos desligados.';
  }
  const test = $('#notifyTest');
  if (test) test.disabled = !notifyEnabled();
}

function openNotifyDialog() {
  renderNotifyDialog();
  const dialog = $('#notifyDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

async function setNotifyEnabled(checked) {
  if (!checked) {
    saveNotifyPrefs({ enabled: false });
    renderNotifyButton();
    renderNotifyDialog();
    showToast('Avisos desligados neste computador.');
    return;
  }
  if (!notifySupported() || notifyPermission() === 'denied') {
    renderNotifyDialog();
    showToast(notifyStatusInfo().text, 'warning');
    return;
  }
  let permission = notifyPermission();
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { permission = 'denied'; }
  }
  if (permission !== 'granted') {
    renderNotifyButton();
    renderNotifyDialog();
    showToast('O navegador não liberou os avisos. Autorize nas permissões do site.', 'warning');
    return;
  }
  saveNotifyPrefs({ enabled: true });
  renderNotifyButton();
  renderNotifyDialog();
  portalNotify({ title: 'Avisos ativados', body: 'Você vai receber os tipos escolhidos: mensagens do chat, novos contratos e erros ou correções de retornos financeiros.', tag: 'portal-avisos' });
  showToast('Avisos ativados neste computador.');
}

function refreshNotifyButton() { renderNotifyButton(); }

window.PortalNotify = {
  push: portalNotify,
  syncChat: syncChatNotifications,
  syncTasks: syncTaskNotifications,
  markLocal(id) { if (id) portalNotifyState.localTaskIds.add(String(id)); },
  refresh: renderNotifyButton,
  reset() { resetNotifyState(null); },
  enabled: notifyEnabled,
  allows: notifyAllows,
  supported: notifySupported,
};
$('#notifyButton')?.addEventListener('click', openNotifyDialog);
['closeNotifyDialog', 'notifyDialogDone'].forEach(id => $(`#${id}`)?.addEventListener('click', () => $('#notifyDialog')?.close()));
$('#notifyEnabledToggle')?.addEventListener('change', event => { setNotifyEnabled(event.target.checked); });
document.querySelectorAll('[data-notify-cat]').forEach(input => {
  input.addEventListener('change', () => {
    saveNotifyPrefs({ [input.dataset.notifyCat]: input.checked });
    renderNotifyButton();
    renderNotifyDialog();
  });
});
$('#notifyTest')?.addEventListener('click', () => {
  const item = portalNotify({ title: 'Teste de aviso', body: 'Se você está vendo isto na bandeja do Windows, os avisos estão funcionando.', tag: 'portal-avisos-teste' });
  showToast(item ? 'Aviso de teste enviado.' : 'Não foi possível enviar o aviso de teste. Confira a autorização do navegador.', item ? 'success' : 'warning');
});
$('#notifyDialog')?.addEventListener('close', renderNotifyButton);
renderNotifyButton();
window.addEventListener('focus', renderNotifyButton);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderNotifyButton(); });

/* ── Prazos com horário: lembretes e relógio ── */
const REMINDER_OFFSETS = [
  { ms: 3 * 86400000, label: '3 dias' },
  { ms: 86400000, label: '1 dia' },
  { ms: 5 * 3600000, label: '5 horas' },
  { ms: 30 * 60000, label: '30 minutos' },
  { ms: 5 * 60000, label: '5 minutos' },
];
const REMINDER_STORE_KEY = 'portal-lembretes-v1';
const REMINDER_WINDOW = 10 * 60000;
function reminderStore() { try { const value = JSON.parse(localStorage.getItem(REMINDER_STORE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function reminderEntries(store) { const key = notifyUserKey(); if (!store[key] || typeof store[key] !== 'object') store[key] = {}; return store[key]; }
function saveReminderStore(store) { try { localStorage.setItem(REMINDER_STORE_KEY, JSON.stringify(store)); } catch {} }
function pruneReminderStore(entries, now = Date.now()) { Object.keys(entries).forEach(key => { const value = Number(entries[key]); if (!(value > 0) || value < now - 30 * 86400000) delete entries[key]; }); }
function dueTimestamp(task) {
  if (!task || !/^\d{2}:\d{2}$/.test(String(task.dueTime || ''))) return null;
  const end = task.periodEnd || task.due;
  if (!end) return null;
  const stamp = new Date(`${end}T${task.dueTime}:00`).getTime();
  return Number.isFinite(stamp) ? stamp : null;
}
function requestNotificationPermission() { if (!notifySupported()) return; if (notifyPermission() === 'default' && notifyPrefs().enabled) Notification.requestPermission().then(refreshNotifyButton).catch(() => {}); }
function checkTimedReminders() {
  if (!notifyEnabled() || !notifyAllows('deadlines')) return;
  const now = Date.now();
  const store = reminderStore();
  const entries = reminderEntries(store);
  let changed = false;
  scopedTasks().forEach(task => {
    if (task.status === 'done') return;
    const at = dueTimestamp(task);
    if (!at) return;
    REMINDER_OFFSETS.forEach(({ ms, label }) => {
      const trigger = at - ms;
      const key = `${task.id}|${at}|${ms}`;
      if (entries[key]) return;
      if (now < trigger || now >= at || now - trigger > REMINDER_WINDOW) return;
      entries[key] = now;
      changed = true;
      portalNotify({
        title: `Prazo em ${label}: ${notifyTrim(task.title, 45)}`,
        body: `${dateLabel(String(task.periodEnd || task.due))} às ${task.dueTime} · ${task.owner || 'sem responsável'}`,
        tag: `prazo-${task.id}-${ms}`,
        requireInteraction: ms <= 30 * 60000,
        onClick: () => {
          window.PortalAccess?.openScreen?.('tasksScreen');
          const fresh = tasks.find(item => item.id === task.id);
          if (fresh) openDialog(fresh);
        },
      });
    });
  });
  if (changed) { pruneReminderStore(entries, now); saveReminderStore(store); }
}
function clockDayLabel(at) {
  const date = new Date(at);
  const target = localIsoDate(date);
  const now = Date.now();
  if (target === localIsoDate(new Date(now))) return 'hoje';
  if (target === localIsoDate(new Date(now + 86400000))) return 'amanhã';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function countdownText(at, now) {
  let total = Math.ceil(Math.abs(at - now) / 1000);
  const days = Math.floor(total / 86400); total -= days * 86400;
  const hours = Math.floor(total / 3600); total -= hours * 3600;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  let text;
  if (days) text = `${days}d ${hours}h`;
  else if (hours) text = `${hours}h ${String(minutes).padStart(2, '0')}min`;
  else if (minutes) text = `${minutes}min ${String(seconds).padStart(2, '0')}s`;
  else text = `${seconds}s`;
  return at < now ? `atrasada há ${text}` : `faltam ${text}`;
}
function timedDemands() {
  return scopedTasks()
    .filter(task => task.status !== 'done' && dueTimestamp(task))
    .map(task => ({ task, at: dueTimestamp(task) }))
    .sort((a, b) => a.at - b.at);
}
const CLOCK_OVERDUE_WINDOW = 6 * 3600000;
function nextTimedDemand(items, now = Date.now()) {
  return items.find(item => item.at >= now) || items.find(item => item.at >= now - CLOCK_OVERDUE_WINDOW);
}
function buildClockTicks() {
  const ticks = $('#dcTicks');
  if (!ticks || ticks.childElementCount || typeof document.createElementNS !== 'function') return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let index = 0; index < 60; index += 1) {
    const angle = index * 6 * Math.PI / 180;
    const major = index % 5 === 0;
    const inner = major ? 96 : 101;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String((120 + inner * Math.sin(angle)).toFixed(2)));
    line.setAttribute('y1', String((120 - inner * Math.cos(angle)).toFixed(2)));
    line.setAttribute('x2', String((120 + 107 * Math.sin(angle)).toFixed(2)));
    line.setAttribute('y2', String((120 - 107 * Math.cos(angle)).toFixed(2)));
    line.setAttribute('class', major ? 'dc-tick major' : 'dc-tick');
    ticks.appendChild(line);
  }
  const numerals = $('#dcNumerals');
  if (numerals && !numerals.childElementCount) {
    [[12, 0], [3, 90], [9, 270]].forEach(([value, degrees]) => {
      const angle = degrees * Math.PI / 180;
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', (120 + 73 * Math.sin(angle)).toFixed(2));
      text.setAttribute('y', (120 - 73 * Math.cos(angle)).toFixed(2));
      text.setAttribute('class', 'dc-numeral');
      text.textContent = String(value);
      numerals.appendChild(text);
    });
  }
}
function renderClockMarkers(items) {
  const group = $('#dcMarkers');
  if (!group) return;
  const now = Date.now();
  const visible = items.filter(item => item.at >= now - CLOCK_OVERDUE_WINDOW && item.at <= now + 12 * 3600000).slice(0, 12);
  const signature = visible.map(item => `${item.task.id}:${item.at}`).join('|');
  if (group.dataset.sig === signature) return;
  group.dataset.sig = signature;
  group.innerHTML = visible.map(item => {
    const date = new Date(item.at);
    const angle = ((date.getHours() * 60 + date.getMinutes()) / 720) * 2 * Math.PI;
    const x = (120 + 90 * Math.sin(angle)).toFixed(1);
    const y = (120 - 90 * Math.cos(angle)).toFixed(1);
    const label = `${item.task.dueTime} · ${item.task.title}`;
    return `<g class="dc-marker${item.at < now ? ' late' : ''}" data-dc-open="${escapeHtml(item.task.id)}" data-dc-at="${item.at}" role="button" tabindex="0" aria-label="${escapeHtml(label)}"><circle cx="${x}" cy="${y}" r="7"></circle><title>${escapeHtml(label)}</title></g>`;
  }).join('');
}
function updateAnalogClock(now) {
  const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
  const minutes = now.getMinutes() + seconds / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const set = (id, degrees) => { const node = $('#' + id); if (node) node.style.transform = `rotate(${degrees}deg)`; };
  set('dcHandSecond', seconds * 6);
  set('dcHandMinute', minutes * 6);
  set('dcHandHour', hours * 30);
}
function updateMiniClock(now) {
  const minutes = now.getMinutes() + now.getSeconds() / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const hour = $('#clockMiniHour');
  if (hour) hour.style.transform = `rotate(${hours * 30}deg)`;
  const minute = $('#clockMiniMinute');
  if (minute) minute.style.transform = `rotate(${minutes * 6}deg)`;
}
let demandClockSignature = '';
function renderDemandClock(force = false) {
  const list = $('#dcList');
  const now = Date.now();
  const items = timedDemands();
  const visible = items.filter(item => item.at >= now - CLOCK_OVERDUE_WINDOW).slice(0, 6);
  if (list) {
    const signature = visible.map(item => `${item.task.id}:${item.at}:${item.task.title}:${snoozeFor(item.task.id, item.at) || 0}`).join('|');
    if (force || signature !== demandClockSignature) {
      demandClockSignature = signature;
      list.innerHTML = visible.map(item => {
        const snoozeUntil = snoozeFor(item.task.id, item.at);
        const snoozed = snoozeUntil > now;
        return `<li class="dc-item${item.at < now && !snoozed ? ' late' : ''}"><button type="button" data-dc-open="${escapeHtml(item.task.id)}"><span class="dc-item-time">${escapeHtml(item.task.dueTime)}</span><span class="dc-item-title">${escapeHtml(item.task.title)}</span><span class="dc-item-count" data-dc-at="${snoozed ? snoozeUntil : item.at}"${snoozed ? ` data-dc-snooze="${snoozeUntil}"` : ''}></span></button></li>`;
      }).join('');
    }
  }
  renderClockMarkers(items);
  tickDemandClock();
}
function tickDemandClock() {
  const now = new Date();
  const clockTime = $('#clockButtonTime');
  if (clockTime) clockTime.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  updateMiniClock(now);
  const dialog = $('#demandClockDialog');
  if (dialog?.open) {
    buildClockTicks();
    updateAnalogClock(now);
    const digital = $('#dcDialogTime');
    if (digital) digital.textContent = now.toLocaleTimeString('pt-BR', { hour12: false });
    const date = $('#dcDialogDate');
    if (date) date.textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    const day = $('#dcDateDay');
    if (day) day.textContent = String(now.getDate()).padStart(2, '0');
  }
  const stamp = now.getTime();
  document.querySelectorAll('#dcList [data-dc-at]').forEach(node => {
    const snoozed = Boolean(node.dataset.dcSnooze);
    node.textContent = snoozed ? `adiada · ${countdownText(Number(node.dataset.dcAt), stamp)}` : countdownText(Number(node.dataset.dcAt), stamp);
    node.closest('.dc-item')?.classList.toggle('late', !snoozed && Number(node.dataset.dcAt) < stamp);
  });
  document.querySelectorAll('#dcMarkers [data-dc-at]').forEach(node => { node.classList.toggle('late', Number(node.dataset.dcAt) < stamp); });
  const items = timedDemands();
  const next = nextTimedDemand(items, stamp);
  const nextTitle = $('#dcNextTitle');
  const nextCountdown = $('#dcNextCountdown');
  if (nextTitle) nextTitle.textContent = next ? next.task.title : 'Nenhuma demanda com horário';
  if (nextCountdown) nextCountdown.textContent = next
    ? `${clockDayLabel(next.at)} às ${next.task.dueTime} · ${countdownText(next.at, stamp)}`
    : 'Cadastre uma demanda com hora para acompanhar o prazo aqui.';
  const open = $('#dcNextOpen');
  if (open) {
    open.classList.toggle('hidden', !next);
    if (next) open.dataset.taskId = next.task.id; else delete open.dataset.taskId;
  }
  const button = $('#demandClockButton');
  if (button) {
    button.classList.toggle('has-next', Boolean(next) && next.at - stamp <= 3600000);
    button.title = next ? `${next.task.dueTime} · ${next.task.title}` : 'Abrir o relógio das demandas';
  }
}
function openDemandClock() {
  buildClockTicks();
  renderDemandClock(true);
  const dialog = $('#demandClockDialog');
  if (dialog && !dialog.open) dialog.showModal();
  tickDemandClock();
}
$('#demandClockButton')?.addEventListener('click', openDemandClock);
$('#closeDemandClock')?.addEventListener('click', () => $('#demandClockDialog')?.close());
$('#demandClockDialog')?.addEventListener('click', event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDueAlarms(); if ($('#demandClockDialog')?.open) renderDemandClock(true); } });
$('#dcList')?.addEventListener('click', event => {
  const button = event.target.closest('[data-dc-open]');
  if (!button) return;
  const task = tasks.find(item => item.id === button.dataset.dcOpen);
  if (task) openDialog(task);
});
$('#dcMarkers')?.addEventListener('click', event => {
  const marker = event.target.closest('[data-dc-open]');
  if (!marker) return;
  const task = tasks.find(item => item.id === marker.dataset.dcOpen);
  if (task) { $('#demandClockDialog')?.close(); openDialog(task); }
});
$('#dcMarkers')?.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const marker = event.target.closest('[data-dc-open]');
  if (!marker) return;
  event.preventDefault();
  const task = tasks.find(item => item.id === marker.dataset.dcOpen);
  if (task) { $('#demandClockDialog')?.close(); openDialog(task); }
});
$('#dcNextOpen')?.addEventListener('click', () => {
  const task = tasks.find(item => item.id === $('#dcNextOpen')?.dataset.taskId);
  if (task) { $('#demandClockDialog')?.close(); openDialog(task); }
});

const ALARM_STORE_KEY = 'portal-alarmes-v1';
const ALARM_SNOOZE_KEY = 'portal-alarmes-adiados-v1';
const ALARM_SOUND_KEY = 'portal-alarme-som-v1';
const ALARM_WINDOW = 120000;
const ALARM_SNOOZE_MINUTES = 10;
const portalBaseTitle = typeof document.title === 'string' ? document.title : '';
let alarmTaskId = null;
let alarmAudio = null;
let alarmSoundTimer = null;
let alarmSoundStop = null;
let alarmOscillators = [];
function alarmStore() { try { const value = JSON.parse(localStorage.getItem(ALARM_STORE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function alarmEntries(store) { const key = notifyUserKey(); if (!store[key] || typeof store[key] !== 'object') store[key] = {}; return store[key]; }
function snoozeStore() { try { const value = JSON.parse(localStorage.getItem(ALARM_SNOOZE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function snoozeEntries(store) { const key = notifyUserKey(); if (!store[key] || typeof store[key] !== 'object') store[key] = {}; return store[key]; }
function snoozeFor(taskId, at) { const entry = snoozeEntries(snoozeStore())[taskId]; return entry && Number(entry.at) === Number(at) && Number(entry.until) > 0 ? Number(entry.until) : 0; }
function alarmSoundOn() { try { return localStorage.getItem(ALARM_SOUND_KEY) !== 'off'; } catch { return true; } }
function alarmAllowed() { const prefs = notifyPrefs(); return Boolean(prefs.enabled) && prefs.deadlines !== false; }
function renderAlarmSoundButton() {
  const button = $('#dcSoundToggle');
  if (!button) return;
  button.textContent = `Som do alarme: ${alarmSoundOn() ? 'ligado' : 'desligado'}`;
  button.setAttribute('aria-pressed', String(alarmSoundOn()));
}
function audioContext() {
  if (alarmAudio) return alarmAudio;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try { alarmAudio = new Ctx(); } catch { return null; }
  return alarmAudio;
}
function unlockAudio() { const ctx = audioContext(); if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
function playAlarmTune() {
  const ctx = audioContext();
  if (!ctx) return;
  unlockAudio();
  stopAlarmSound();
  const master = ctx.createGain();
  master.gain.value = 0.16;
  master.connect(ctx.destination);
  const notes = [784, 988, 1175, 988, 784, 659];
  const step = 0.3;
  const cycle = notes.length * step + 0.7;
  let cursor = ctx.currentTime + 0.05;
  const schedule = () => {
    notes.forEach((freq, index) => {
      const start = cursor + index * step;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(1, start + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + step * 0.85);
      osc.connect(gain); gain.connect(master);
      osc.start(start); osc.stop(start + step);
      alarmOscillators.push(osc);
    });
    cursor += cycle;
  };
  schedule();
  alarmSoundTimer = setInterval(schedule, cycle * 1000);
  alarmSoundStop = setTimeout(stopAlarmSound, 30000);
}
function stopAlarmSound() {
  if (alarmSoundTimer) { clearInterval(alarmSoundTimer); alarmSoundTimer = null; }
  if (alarmSoundStop) { clearTimeout(alarmSoundStop); alarmSoundStop = null; }
  alarmOscillators.forEach(osc => { try { osc.stop(); } catch {} });
  alarmOscillators = [];
}
function triggerAlarm(task, at, snoozed = false) {
  alarmTaskId = task.id;
  const title = $('#alarmTitle');
  if (title) title.textContent = task.title;
  const time = $('#alarmTime');
  if (time) time.textContent = `${task.dueTime} · ${dateLabel(String(task.periodEnd || task.due))}${snoozed ? ' · adiado' : ''}`;
  const owner = $('#alarmOwner');
  if (owner) owner.textContent = task.owner ? `Responsável: ${task.owner}` : 'Sem responsável';
  const dialog = $('#alarmDialog');
  if (dialog && !dialog.open) dialog.showModal();
  if (alarmSoundOn()) playAlarmTune();
  if (portalBaseTitle) document.title = `Alarme: ${task.title}`;
  portalNotify({
    title: `Hora da demanda: ${notifyTrim(task.title, 45)}`,
    body: `${task.dueTime} · ${task.owner || 'sem responsável'}`,
    tag: `alarme-${task.id}-${at}`,
    requireInteraction: true,
    onClick: () => {
      window.PortalAccess?.openScreen?.('tasksScreen');
      const fresh = tasks.find(item => item.id === task.id);
      if (fresh) openDialog(fresh);
    },
  });
}
function checkDueAlarms() {
  if (!alarmAllowed() || $('#alarmDialog')?.open) return;
  const now = Date.now();
  const store = alarmStore();
  const entries = alarmEntries(store);
  const snoozeData = snoozeStore();
  const snoozes = snoozeEntries(snoozeData);
  let changed = false;
  let snoozesChanged = false;
  const candidates = [];
  scopedTasks().filter(task => task.status !== 'done').forEach(task => {
    const at = dueTimestamp(task);
    if (!at) return;
    const snooze = snoozes[task.id];
    if (snooze && Number(snooze.at) === at) {
      const until = Number(snooze.until);
      if (until && now >= until && now - until <= ALARM_WINDOW) candidates.push({ task, at, ringAt: until, key: `${task.id}|${at}|s${until}`, snoozed: true });
      else if (until && now - until > ALARM_WINDOW) { delete snoozes[task.id]; snoozesChanged = true; }
      return;
    }
    if (now >= at && now - at <= ALARM_WINDOW) candidates.push({ task, at, ringAt: at, key: `${task.id}|${at}`, snoozed: false });
  });
  candidates.sort((a, b) => a.ringAt - b.ringAt);
  for (const item of candidates) {
    if (entries[item.key]) continue;
    entries[item.key] = now;
    if (item.snoozed) { delete snoozes[item.task.id]; snoozesChanged = true; }
    changed = true;
    triggerAlarm(item.task, item.at, item.snoozed);
    break;
  }
  Object.keys(snoozes).forEach(id => { const entry = snoozes[id]; if (!entry || !(Number(entry.until) > now - 86400000)) { delete snoozes[id]; snoozesChanged = true; } });
  if (changed) {
    Object.keys(entries).forEach(key => { const value = Number(entries[key]); if (!(value > 0) || value < now - 30 * 86400000) delete entries[key]; });
    try { localStorage.setItem(ALARM_STORE_KEY, JSON.stringify(store)); } catch {}
  }
  if (snoozesChanged) { try { localStorage.setItem(ALARM_SNOOZE_KEY, JSON.stringify(snoozeData)); } catch {} }
}
function closeAlarmDialog() {
  const dialog = $('#alarmDialog');
  if (dialog?.open) dialog.close();
  stopAlarmSound();
  if (portalBaseTitle) document.title = portalBaseTitle;
}
$('#alarmSnooze')?.addEventListener('click', closeAlarmDialog);
function postponeAlarm() {
  const task = tasks.find(item => item.id === alarmTaskId);
  const at = task ? dueTimestamp(task) : null;
  if (!task || !at) { closeAlarmDialog(); return; }
  const until = Date.now() + ALARM_SNOOZE_MINUTES * 60000;
  const store = snoozeStore();
  const entries = snoozeEntries(store);
  entries[task.id] = { at, until };
  try { localStorage.setItem(ALARM_SNOOZE_KEY, JSON.stringify(store)); } catch {}
  closeAlarmDialog();
  showToast(`Alarme adiado para ${new Date(until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  renderDemandClock(true);
}
$('#alarmPostpone')?.addEventListener('click', postponeAlarm);
$('#alarmOpen')?.addEventListener('click', () => {
  const task = tasks.find(item => item.id === alarmTaskId);
  closeAlarmDialog();
  if (task) { window.PortalAccess?.openScreen?.('tasksScreen'); openDialog(task); }
});
$('#alarmDone')?.addEventListener('click', () => {
  const task = tasks.find(item => item.id === alarmTaskId);
  closeAlarmDialog();
  if (!task) return;
  if (task.status !== 'done') completeTask(task);
  save();
  render();
  window.PortalNotify?.syncTasks?.(tasks);
});
$('#alarmDialog')?.addEventListener('close', () => { stopAlarmSound(); if (portalBaseTitle) document.title = portalBaseTitle; });
$('#dcSoundToggle')?.addEventListener('click', () => {
  try { localStorage.setItem(ALARM_SOUND_KEY, alarmSoundOn() ? 'off' : 'on'); } catch {}
  if (!alarmSoundOn()) stopAlarmSound();
  renderAlarmSoundButton();
});
renderAlarmSoundButton();
$('#reminderDone').addEventListener('click', () => { const task = tasks.find(item => item.id === reminderTaskId); if (task) completeTask(task); save(); render(); $('#reminderDialog').close(); }); $('#reminderLater').addEventListener('click', () => $('#reminderDialog').close());
async function bootstrap() {
  const access = window.PortalAccess.Access;
  if (!access.user || !access.token) return;
  if (window.PortalOffline.getStatus().userId !== String(access.user.id)) window.PortalOffline.begin(access.user, access.token);
  await window.PortalOffline.start();
  if (!access.offline) window.PortalOffline.registerWorker().catch(() => {
    $('#lastSaved').title = 'A reabertura offline ainda não foi preparada neste navegador.';
  });
}
window.PortalOffline.configure({
  authHeaders: window.PortalAccess.authHeaders,
  apiBase: window.PORTAL_API_BASE || '',
  canSync: () => !document.querySelector('#taskDialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName),
  beforeSync: () => window.PortalAccess.refreshSessionForSync(),
  onState: applyDemandSnapshot,
  onRemoteState: state => {
    billingHistory = state.billingHistory || billingHistory;
    mergeRows = state.mergeRows || mergeRows;
    learningData = state.learningData || learningData;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(billingHistory));
    localStorage.setItem(MERGE_QUEUE_KEY, JSON.stringify(mergeRows));
    localStorage.setItem(LEARNING_KEY, JSON.stringify(learningData));
    if ($('#historyBody')) renderHistory();
    if ($('#mergePreviewContent')) renderMergePreview();
    renderLearning();
  },
  onStatus: status => {
    if (status.authFailure) { window.PortalAccess.rejectOfflineAuth(status.authFailure); return; }
    $('#lastSaved').textContent = status.storageError || (status.readOnly ? 'Demandas em outra aba' : status.busy ? 'Sincronizando demandas...' : status.conflicts ? `${status.conflicts} alteração(ões) para revisar` : status.pending ? `${status.pending} alteração(ões) salva(s) localmente; aguardando sincronização` : status.phase === 'synced' ? 'Demandas sincronizadas' : 'Demandas salvas neste computador');
    $('#newTaskButton').disabled = status.readOnly;
    $('#saveTaskButton').disabled = status.readOnly;
  },
});
window.bootstrapPortal = bootstrap;
window.PortalAccess.restoreSession().then(async ok => {
  if (!ok) { window.PortalLoading?.endBoot?.(); return; }
  try { await bootstrap(); } catch (error) { console.error(error); } finally { window.PortalLoading?.endBoot?.(); }
});
window.addEventListener('pageshow', event => { if (event.persisted) bootstrap(); });

// Assistente local: registra somente atividades relevantes dentro do portal.
const AGENT_IGNORED_KEY = 'portal-agent-ignored-v1';
let agentSuggestions = [];
let agentTimer = null;
function agentScreen() {
  return document.querySelector('.screen:not(.hidden)')?.id || '';
}
function agentRecord(text, eventType = 'activity') {
  const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (value.length < 20 || !window.PortalAccess?.Access?.token || window.PortalAccess.Access.offline) return;
  fetch(`${window.PORTAL_API_BASE || ''}/api/agent/events`, {
    method: 'POST',
    headers: window.PortalAccess.authHeaders(),
    body: JSON.stringify({ text: value, eventType, screen: agentScreen() }),
  }).catch(() => {});
}
function renderAgentSuggestions() {
  const host = $('#agentSuggestions');
  if (!host) return;
  const ignored = new Set(JSON.parse(localStorage.getItem(AGENT_IGNORED_KEY) || '[]'));
  const visible = agentSuggestions.filter(item => !ignored.has(item.id));
  host.innerHTML = visible.map(item => `<article class="admin-item">
    <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.source)} · ${escapeHtml(item.screen || 'portal')}</small></div>
    <div class="admin-item-actions"><button type="button" class="button button-primary" data-agent-create="${escapeHtml(item.title)}">Criar</button><button type="button" class="button button-secondary" data-agent-ignore="${escapeHtml(item.id)}">Ignorar</button></div>
  </article>`).join('') || '<p class="empty-state">Nenhuma sugestão no momento.</p>';
}
async function loadAgentSuggestions() {
  if (window.PortalAccess?.Access?.user?.role !== 'admin' || window.PortalAccess.Access.offline) return;
  try {
    const data = await window.PortalAccess.api('/api/agent/suggestions');
    agentSuggestions = data.suggestions || [];
    renderAgentSuggestions();
  } catch (error) {
    if (error.message !== 'auth') console.error('Assistente local:', error);
  }
}
function startAgentForAdmin() {
  if (window.PortalAccess?.Access?.user?.role !== 'admin' || agentTimer) return;
  loadAgentSuggestions();
  agentTimer = setInterval(loadAgentSuggestions, 15000);
}
document.addEventListener('click', event => {
  const button = event.target.closest('button, a');
  if (button && !button.closest('#agentSuggestions') && button.textContent.trim().length >= 20) {
    agentRecord(button.textContent, 'action');
  }
  const create = event.target.closest('[data-agent-create]');
  if (create) {
    openDialog();
    $('#taskTitle').value = create.dataset.agentCreate;
    $('#taskTitle').focus();
    return;
  }
  const ignore = event.target.closest('[data-agent-ignore]');
  if (ignore) {
    const ignored = new Set(JSON.parse(localStorage.getItem(AGENT_IGNORED_KEY) || '[]'));
    ignored.add(ignore.dataset.agentIgnore);
    localStorage.setItem(AGENT_IGNORED_KEY, JSON.stringify([...ignored]));
    renderAgentSuggestions();
  }
});
document.addEventListener('blur', event => {
  const field = event.target;
  if (field.matches('textarea, input[type="text"], input[type="search"]') && field.value.trim().length >= 20) {
    agentRecord(field.value, 'text');
  }
}, true);
document.addEventListener('submit', event => {
  const text = [...event.target.querySelectorAll('input, textarea, select')]
    .filter(field => field.type !== 'password' && field.type !== 'file')
    .map(field => field.value).filter(value => value && value.trim()).join(' · ');
  agentRecord(text, 'form');
}, true);
window.addEventListener('portal:session-ready', startAgentForAdmin);
setTimeout(startAgentForAdmin, 1200);
$('#agentRefresh')?.addEventListener('click', loadAgentSuggestions);

// ===== Sincronização automática entre notebooks (servidor central) =====
function syncFromServer() {
  if (window.PortalAccess?.Access?.token) return window.PortalOffline.flush();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFromServer(); });

setTimeout(checkTimedReminders, 8000); setInterval(checkTimedReminders, 20000); setTimeout(checkDueAlarms, 4000); setInterval(checkDueAlarms, 5000); setInterval(tickDemandClock, 1000); setInterval(() => { const dialog = $('#demandClockDialog'); if (dialog?.open) updateAnalogClock(new Date()); }, 120); $('#loginForm').addEventListener('submit', requestNotificationPermission, { once: true });

// ===== Relatório Semanal (cadastros lidos do S4E) =====
let weeklyOffset = 0;
const weeklyState = { active: false, busy: false, data: null, job: null, error: '', timer: null, controller: null, attempted: new Set(), polls: 0, epoch: 0 };
function weekRange(offset = weeklyOffset) { const base = new Date(); base.setDate(base.getDate() + offset * 7); const shift = (base.getDay() + 6) % 7; const start = new Date(base); start.setDate(base.getDate() - shift); const end = new Date(start); end.setDate(start.getDate() + 6); const limit = localIsoDate(); const last = localIsoDate(end) > limit ? limit : localIsoDate(end); return { start: localIsoDate(start), end: last }; }
function weekRangeLabel(range) { return range.start === range.end ? weekLabelDate(range.start) : `${weekLabelDate(range.start)} – ${weekLabelDate(range.end)}`; }
function weekRangePeriod(range) { const format = date => new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR'); return range.start === range.end ? format(range.start) : `${format(range.start)} a ${format(range.end)}`; }
function weekLabelDate(date) { return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }); }
function weekdayLong(date) { return new Date(`${date}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long' }); }
function weeklyDate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '—'; const [year, month, day] = value.split('-'); return `${day}/${month}/${year}`; }
function weeklyStamp(value) { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function weeklyKey() { const range = weekRange(); return `${range.start}/${range.end}`; }
function weeklyVisible() { return weeklyState.active && !$('#weeklyScreen').classList.contains('hidden'); }
function weeklyRows() {
  const data = weeklyState.data || {};
  return [
    ...(data.empresas || []).map(item => ({ ...item, kind: 'empresa' })),
    ...(data.estabelecimentos || []).map(item => ({ ...item, kind: 'estabelecimento' })),
  ].sort((a, b) => a.data.localeCompare(b.data) || a.kind.localeCompare(b.kind) || a.nome.localeCompare(b.nome, 'pt-BR'));
}
function weeklyPlainDetail(item) {
  if (item.kind === 'empresa') return [item.tipo, item.centro, item.situacao].filter(Boolean).join(' · ');
  return [item.cro ? `CRO ${item.cro}` : '', item.credenciamento ? `credenciado em ${weeklyDate(item.credenciamento)}` : ''].filter(Boolean).join(' · ');
}
function weeklyDetailHtml(item) {
  const main = item.kind === 'empresa' ? (item.tipo || 'Empresa') : (item.cro ? `CRO ${item.cro}` : 'Livre escolha');
  const note = item.kind === 'empresa'
    ? [item.centro || 'Sem centro de custo', item.situacao].filter(Boolean).join(' · ')
    : (item.credenciamento ? `Credenciado em ${weeklyDate(item.credenciamento)}` : 'Estabelecimento cadastrado');
  return `<span class="week-detail">${escapeHtml(main)}</span><small>${escapeHtml(note)}</small>`;
}
function weeklyInvalidate() { clearTimeout(weeklyState.timer); weeklyState.timer = null; weeklyState.controller?.abort(); weeklyState.controller = null; }
function weeklyErrorMessage(error) {
  const text = String(error?.message || '');
  if (!text || /failed to fetch|networkerror|load failed/i.test(text)) return 'Sem resposta do portal agora. Verifique a conexão e tente novamente.';
  return text;
}
async function weeklyFetch(path, options = {}) {
  const controller = new AbortController();
  weeklyState.controller = controller;
  const attempt = async () => {
    const response = await fetch(`${window.PORTAL_API_BASE || ''}${path}`, { ...options, signal: controller.signal, headers: window.PortalAccess.authHeaders(options.headers || {}) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { clearSession(); showLogin(data.error || 'Faça login para continuar.'); throw new DOMException('Sessão encerrada', 'AbortError'); }
    if (response.status === 423) throw new DOMException('Portal bloqueado', 'AbortError');
    if (!response.ok) throw new Error(data.error || 'Não foi possível consultar os cadastros.');
    return data;
  };
  try {
    return await attempt();
  } catch (error) {
    const retryable = error instanceof TypeError && (!options.method || options.method === 'GET');
    if (!retryable) throw error;
    await new Promise(resolve => setTimeout(resolve, 700));
    return attempt();
  }
}
function weeklySchedule() {
  clearTimeout(weeklyState.timer);
  if (!weeklyVisible() || weeklyState.error) return;
  if (weeklyState.job?.running && weeklyState.polls >= 360) { weeklyState.error = 'A consulta continua em andamento. O acompanhamento foi pausado; use Atualizar do S4E para verificar novamente.'; weeklyRender(); return; }
  weeklyState.timer = setTimeout(() => weeklyLoad(false), weeklyState.job?.running ? 3000 : 60000);
}
async function weeklyStart(force) {
  const range = weekRange();
  const data = await weeklyFetch('/api/semanal/atualizar', { method: 'POST', body: JSON.stringify({ start: range.start, end: range.end, force: Boolean(force) }) });
  weeklyState.job = data.job || null;
  weeklyState.polls = 0;
  weeklyRender();
}
async function weeklyLoad(auto = false) {
  if (!weeklyVisible()) return;
  const epoch = ++weeklyState.epoch;
  weeklyInvalidate();
  weeklyState.busy = true;
  weeklyRender();
  try {
    const range = weekRange();
    const data = await weeklyFetch(`/api/semanal?start=${range.start}&end=${range.end}`);
    if (epoch !== weeklyState.epoch) return;
    weeklyState.data = data;
    weeklyState.job = data.job || null;
    weeklyState.error = '';
    weeklyState.polls = weeklyState.job?.running ? weeklyState.polls + 1 : 0;
    weeklyRender();
    const runningCurrent = weeklyState.job?.running && weeklyState.job?.start === range.start && weeklyState.job?.end === range.end;
    if (!runningCurrent && auto && (data.empresasDesatualizadas || data.estabelecimentosDesatualizados) && !weeklyState.attempted.has(weeklyKey())) {
      weeklyState.attempted.add(weeklyKey());
      await weeklyStart(false);
      if (epoch !== weeklyState.epoch) return;
    }
  } catch (error) {
    if (epoch === weeklyState.epoch && error.name !== 'AbortError') weeklyState.error = weeklyErrorMessage(error);
  } finally {
    if (epoch === weeklyState.epoch) {
      weeklyState.busy = false;
      weeklyRender();
      weeklySchedule();
    }
  }
}
async function weeklyRefresh() {
  if (weeklyState.busy || weeklyState.job?.running) return;
  const epoch = ++weeklyState.epoch;
  weeklyInvalidate();
  weeklyState.busy = true;
  weeklyState.error = '';
  weeklyRender();
  try { await weeklyStart(true); if (epoch !== weeklyState.epoch) return; }
  catch (error) { if (epoch === weeklyState.epoch && error.name !== 'AbortError') weeklyState.error = weeklyErrorMessage(error); }
  finally { if (epoch === weeklyState.epoch) { weeklyState.busy = false; weeklyRender(); weeklySchedule(); } }
}
function weeklyRender() {
  const range = weekRange();
  const data = weeklyState.data || {};
  const companies = data.empresas || [];
  const establishments = data.estabelecimentos || [];
  const rows = weeklyRows();
  $('#weekLabel').textContent = weekRangeLabel(range);
  $('#weekCurrentTag').classList.toggle('hidden', weeklyOffset !== 0);
  $('#weeklyCompanyCount').textContent = companies.length;
  $('#weeklyEstablishmentCount').textContent = establishments.length;
  $('#weeklyTotalCount').textContent = rows.length;
  $('#weeklyBody').innerHTML = rows.map(item => `<tr><td><span class="week-day">${escapeHtml(weekdayLong(item.data))}</span>${weekLabelDate(item.data)}</td><td><span class="badge kind-${item.kind}">${item.kind === 'empresa' ? 'Empresa' : 'Estabelecimento'}</span></td><td><strong>${escapeHtml(item.nome)}</strong>${item.id ? `<small class="weekly-id">#${escapeHtml(item.id)}</small>` : ''}</td><td>${weeklyDetailHtml(item)}</td></tr>`).join('');
  $('#weeklyEmpty').classList.toggle('hidden', rows.length > 0 || weeklyState.busy);
  const stamps = [data.empresasConsultadoEm, data.estabelecimentosConsultadoEm].filter(Boolean).sort();
  $('#weeklySummary').textContent = rows.length
    ? `${companies.length} ${companies.length === 1 ? 'empresa' : 'empresas'} e ${establishments.length} ${establishments.length === 1 ? 'estabelecimento' : 'estabelecimentos'}${stamps.length ? ` · S4E em ${weeklyStamp(stamps[stamps.length - 1])}` : ''}`
    : (weeklyState.busy ? 'Carregando cadastros...' : 'Nenhum cadastro no período');
  const job = weeklyState.job;
  let message;
  if (job?.running) { message = `${job.message || 'Consultando o S4E...'} · ${weeklyDate(job.start)} a ${weeklyDate(job.end)}`; if (Number(job.total) > 0) message += ` · ${job.done}/${job.total}`; }
  else if (weeklyState.busy) message = 'Carregando cadastros...';
  else if (weeklyState.error) message = weeklyState.error;
  else if (data.empresasConsultadoEm || data.estabelecimentosConsultadoEm) message = `Empresas: ${weeklyStamp(data.empresasConsultadoEm) || 'ainda não consultadas'} · Estabelecimentos: ${weeklyStamp(data.estabelecimentosConsultadoEm) || 'ainda não consultados'}`;
  else message = 'Ainda não consultamos o S4E para esta semana.';
  $('#weeklyMonitor').textContent = message;
  const progress = $('#weeklyProgress');
  progress.classList.toggle('hidden', !job?.running);
  if (Number(job?.total) > 0) { progress.max = Number(job.total); progress.value = Math.max(0, Number(job.done) || 0); }
  else { progress.removeAttribute('value'); progress.max = 100; }
  $('#weeklyError').textContent = weeklyState.error;
  $('#weeklyError').classList.toggle('hidden', !weeklyState.error);
  $('#weeklyRefresh').disabled = weeklyState.busy || Boolean(job?.running);
  $('#copyWeeklyReport').disabled = !rows.length;
  $('#exportWeeklyXlsx').disabled = !rows.length;
}
function weeklyReportText() {
  const range = weekRange();
  const rows = weeklyRows();
  const period = `Período: ${weekRangePeriod(range)}`;
  const lines = ['RELATÓRIO SEMANAL DE CADASTROS', period, ''];
  [['EMPRESAS CADASTRADAS', 'empresa', 'Nenhuma empresa cadastrada nesta semana'], ['ESTABELECIMENTOS CADASTRADOS', 'estabelecimento', 'Nenhum estabelecimento cadastrado nesta semana']].forEach(([heading, kind, empty]) => {
    const items = rows.filter(item => item.kind === kind);
    lines.push(`${heading} (${items.length})`);
    items.forEach(item => { const detail = weeklyPlainDetail(item); lines.push(`- ${item.nome} — ${weekdayLong(item.data)}, ${weekLabelDate(item.data)}${detail ? ` · ${detail}` : ''}`); });
    if (!items.length) lines.push(empty);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
async function copyWeeklyReport() {
  const text = weeklyReportText();
  try { await navigator.clipboard.writeText(text); }
  catch { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); }
  const button = $('#copyWeeklyReport');
  button.textContent = 'Mensagem copiada!';
  setTimeout(() => { button.textContent = 'Copiar mensagem para envio'; }, 2000);
}
async function exportWeeklyXlsx() {
  if (!window.ExcelJS) throw new Error('ExcelJS não foi carregado pelas CDNs');
  const range = weekRange();
  const rows = weeklyRows();
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'Intranet Rede Saúde';
  const sheet = workbook.addWorksheet('Relatório Semanal');
  sheet.getCell('A1').value = 'RELATÓRIO SEMANAL DE CADASTROS'; sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF087F78' } };
  sheet.getCell('A2').value = `Período: ${weekRangePeriod(range)} · Fonte: S4E`; sheet.getCell('A2').font = { color: { argb: 'FF70808C' } };
  let row = 4;
  [['EMPRESAS CADASTRADAS', 'empresa', 'Empresa'], ['ESTABELECIMENTOS CADASTRADOS', 'estabelecimento', 'Estabelecimento']].forEach(([heading, kind, column]) => {
    sheet.getCell(`A${row}`).value = heading; sheet.getCell(`A${row}`).font = { bold: true, size: 12 }; row += 1;
    const header = sheet.getRow(row); header.values = [column, 'Dia', 'Data', 'Detalhes']; header.font = { bold: true, color: { argb: 'FFFFFFFF' } }; header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F78' } }; row += 1;
    const items = rows.filter(item => item.kind === kind);
    if (!items.length) { sheet.getCell(`A${row}`).value = 'Nenhum cadastro no período'; row += 1; } else items.forEach(item => { sheet.getRow(row).values = [item.nome, weekdayLong(item.data), new Date(`${item.data}T12:00:00`).toLocaleDateString('pt-BR'), weeklyPlainDetail(item)]; row += 1; });
    row += 2;
  });
  sheet.getColumn(1).width = 46; sheet.getColumn(2).width = 24; sheet.getColumn(3).width = 14; sheet.getColumn(4).width = 46;
  const buffer = await workbook.xlsx.writeBuffer();
  downloadFile(`relatorio-semanal-${range.start}_a_${range.end}.xlsx`, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
function weeklyNavigate(delta) { weeklyOffset = delta; weeklyState.error = ''; weeklyState.polls = 0; weeklyState.data = null; weeklyRender(); weeklyLoad(true); }
window.enterWeeklyScreen = () => { weeklyState.active = true; weeklyOffset = 0; weeklyState.error = ''; weeklyState.polls = 0; weeklyState.attempted.clear(); weeklyRender(); weeklyLoad(true); };
window.leaveWeeklyScreen = () => { weeklyState.active = false; weeklyInvalidate(); };
$('#weekPrev').addEventListener('click', () => weeklyNavigate(weeklyOffset - 1));
$('#weekNext').addEventListener('click', () => weeklyNavigate(weeklyOffset + 1));
$('#weekToday').addEventListener('click', () => weeklyNavigate(0));
$('#weeklyRefresh').addEventListener('click', weeklyRefresh);
$('#copyWeeklyReport').addEventListener('click', copyWeeklyReport);
$('#exportWeeklyXlsx').addEventListener('click', async () => { try { await exportWeeklyXlsx(); } catch (error) { console.error(error); alert(`Não foi possível gerar o Excel. Motivo: ${error.message}`); } });

// ── Tela de Sindicatos ──────────────────────────────────────────────────────
(function () {
  const PROXY_URL = '/api/proxy/sindicatos';
  let loaded = false;

  function loadSindicatos() {
    if (loaded) return;
    loaded = true;
    const frame = document.getElementById('sindicatosFrame');
    if (frame) frame.src = PROXY_URL;
  }

  // O openScreen() remove a classe 'hidden' quando ativa a tela
  const observer = new MutationObserver(() => {
    const screen = document.getElementById('sindicatosScreen');
    if (screen && !screen.classList.contains('hidden')) loadSindicatos();
  });
  const screen = document.getElementById('sindicatosScreen');
  if (screen) observer.observe(screen, { attributes: true, attributeFilter: ['class'] });

  // Botão recarregar: força nova busca
  document.getElementById('sindicatosReload')?.addEventListener('click', () => {
    loaded = false;
    const frame = document.getElementById('sindicatosFrame');
    if (frame) frame.src = 'about:blank';
    loadSindicatos();
  });
})();

// ── Tela de Contratos ────────────────────────────────────────
(function () {
  const byId = id => document.getElementById(id);
  const esc = value => (window.escapeHtml ? window.escapeHtml(String(value == null ? '' : value)) : String(value == null ? '' : value));
  const state = {
    loading: false,
    loaded: false,
    companies: [],
    summary: { companies: 0, lives: 0, birthdaysMonth: 0, incomplete: 0, avgLives: 0 },
    imports: [],
    search: '',
    status: 'all',
    sort: 'name',
    month: 'all',
    monthField: 'start',
    canRegister: false,
    selectedId: null,
    selected: null,
    lives: [],
    lifeSearch: '',
    showCpf: false,
    canSeeValues: false,
    file: null,
    preview: null,
    importing: false,
    importPrefix: '/api/contracts',
    importAfter: null,
    editingLife: null,
  };

  function statusLabel(status) {
    return { ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado' }[status] || 'Ativo';
  }
  function contractsMoney(value) {
    return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function contractsDate(value) {
    if (!value) return '—';
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const parts = raw.slice(0, 10).split('-');
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return raw;
  }
  function contractsDateTime(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return contractsDate(value);
    return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function contractsAge(birthDate) {
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return '';
    const parts = birthDate.slice(0, 10).split('-').map(Number);
    const now = new Date();
    let age = now.getFullYear() - parts[0];
    if (now.getMonth() + 1 < parts[1] || (now.getMonth() + 1 === parts[1] && now.getDate() < parts[2])) age -= 1;
    return age >= 0 && age < 130 ? `${age} anos` : '';
  }
  function contractsDaysToBirthday(birthDate) {
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
    const parts = birthDate.slice(0, 10).split('-').map(Number);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    let next = new Date(now.getFullYear(), parts[1] - 1, parts[2]);
    if (next < now) next = new Date(now.getFullYear() + 1, parts[1] - 1, parts[2]);
    return Math.round((next - now) / 86400000);
  }
  function maskCpf(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length !== 11) return value || '—';
    return `${digits.slice(0, 3)}.•••.•••-${digits.slice(9)}`;
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '--';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }
  function slug(value) {
    return String(value || 'contratos').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'contratos';
  }

  function renderContractKpis() {
    const summary = state.summary || {};
    byId('contractsKpis').innerHTML = `
      <article class="stat-card highlight"><span>Empresas</span><strong>${summary.companies || 0}</strong><small>${summary.companiesRegistered || 0} cadastrada${(summary.companiesRegistered || 0) === 1 ? '' : 's'} · ${summary.companiesPending || 0} aguardando</small></article>
      <article class="stat-card"><span>Vidas</span><strong>${summary.lives || 0}</strong><small>colaboradores na base</small></article>
      <article class="stat-card"><span>Aniversários no mês</span><strong>${summary.birthdaysMonth || 0}</strong><small>vidas que fazem aniversário agora</small></article>
      <article class="stat-card ${summary.incomplete ? 'alert-card' : ''}"><span>Cadastros incompletos</span><strong>${summary.incomplete || 0}</strong><small>CNPJ, contato, telefone ou e-mail</small></article>
      <article class="stat-card"><span>Média de vidas</span><strong>${Number(summary.avgLives || 0).toLocaleString('pt-BR')}</strong><small>por empresa</small></article>`;
  }

  function calendarMonthLabel(key) {
    const [year, month] = String(key).split('-').map(Number);
    if (!year || !month) return key;
    const label = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function fillContractMonths() {
    const select = byId('contractsMonthFilter');
    const field = byId('contractsDateField');
    if (!select) return;
    if (field) field.value = state.monthField;
    const source = company => state.monthField === 'updated' ? company.updatedAt : company.contractStart;
    const keys = [...new Set(state.companies
      .map(company => String(source(company) || '').slice(0, 7))
      .filter(key => /^\d{4}-\d{2}$/.test(key)))].sort().reverse();
    select.innerHTML = '<option value="all">Todos os meses</option>'
      + keys.map(key => `<option value="${key}">${esc(calendarMonthLabel(key))}</option>`).join('')
      + '<option value="none">Sem data</option>';
    select.value = state.month === 'none' || keys.includes(state.month) ? state.month : 'all';
    state.month = select.value;
  }

  function filteredCompanies() {
    const query = state.search.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    const list = state.companies.filter(company => {
      if (state.status !== 'all' && company.status !== state.status) return false;
      if (state.month !== 'all') {
        const source = state.monthField === 'updated' ? company.updatedAt : company.contractStart;
        const monthKey = String(source || '').slice(0, 7);
        if (state.month === 'none' ? monthKey : monthKey !== state.month) return false;
      }
      if (!query) return true;
      const haystack = [company.name, company.cnpj, company.contactName, company.email, company.phone, company.plan, company.seller, company.accountantName, company.accountantEmail]
        .filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(query)) return true;
      return digits.length >= 3 && String(company.cnpj || '').replace(/\D/g, '').includes(digits);
    });
    const sorters = {
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'),
      lives: (a, b) => (b.livesCount || 0) - (a.livesCount || 0) || String(a.name).localeCompare(String(b.name), 'pt-BR'),
      updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
      birthdays: (a, b) => (b.birthdaysMonth || 0) - (a.birthdaysMonth || 0) || String(a.name).localeCompare(String(b.name), 'pt-BR'),
    };
    return list.sort(sorters[state.sort] || sorters.name);
  }

  function companyCard(company) {
    const birthdays = company.birthdaysMonth || 0;
    const incomplete = !company.cnpj || !company.contactName || !company.phone || !company.email;
    const lives = company.livesCount || 0;
    const registered = company.registeredCount || 0;
    const pending = Math.max(0, lives - registered);
    const companyRegistration = company.companyRegistered
      ? '<span class="contract-tag contract-tag-ok">Empresa cadastrada</span>'
      : '<span class="contract-tag contract-tag-pending">Empresa aguardando cadastro</span>';
    const registration = lives
      ? (pending
        ? `<span class="contract-tag contract-tag-pending">${registered}/${lives} cadastradas</span>`
        : `<span class="contract-tag contract-tag-ok">Todas cadastradas</span>`)
      : '';
    return `<article class="contract-card" data-company-id="${esc(company.id)}" tabindex="0" role="button" aria-label="Abrir ficha de ${esc(company.name)}">
      <span class="contracts-avatar">${esc(initials(company.name))}</span>
      <div class="contract-card-main">
        <div class="contract-card-title"><h3>${esc(company.name)}</h3><span class="contract-status ${esc(company.status)}">${esc(statusLabel(company.status))}</span></div>
        <div class="contract-card-meta">
          <span>${esc(company.cnpj || 'CNPJ não informado')}</span>
          ${company.contactName ? `<span>${esc(company.contactName)}</span>` : ''}
          ${company.phone ? `<span>${esc(company.phone)}</span>` : ''}
        </div>
        <div class="contract-card-tags">
          ${companyRegistration}
          ${registration}
          ${company.plan ? `<span class="contract-tag">${esc(company.plan)}</span>` : ''}
          ${registration}
          ${birthdays ? `<span class="contract-tag contract-tag-birthday">${birthdays} aniversário${birthdays === 1 ? '' : 's'} no mês</span>` : ''}
          ${incomplete ? '<span class="contract-tag contract-tag-warn">Cadastro incompleto</span>' : ''}
        </div>
      </div>
      <div class="contract-card-side"><strong>${lives}</strong><span>vida${lives === 1 ? '' : 's'}</span><small>abrir ficha</small></div>
    </article>`;
  }

  function renderContractList() {
    const list = filteredCompanies();
    const total = state.companies.length;
    byId('contractsCount').textContent = list.length === total
      ? `${total} empresa${total === 1 ? '' : 's'}`
      : `${list.length} de ${total} empresas`;
    const hasFilter = Boolean(state.search.trim()) || state.status !== 'all' || state.month !== 'all';
    byId('contractsFilterHint').textContent = hasFilter ? 'Filtros ativos' : '';
    byId('contractsSearchClear').hidden = !state.search;
    byId('contractsList').innerHTML = list.length
      ? list.map(companyCard).join('')
      : (total ? '<p class="empty-state">Nenhuma empresa encontrada com esses filtros.</p>' : '');
    byId('contractsEmpty').classList.toggle('hidden', total > 0);
  }

  function renderContractImports() {
    const imports = state.imports || [];
    byId('contractsImportsBody').innerHTML = imports.map(item => `<tr>
      <td>${esc(contractsDateTime(item.createdAt))}</td>
      <td><strong>${esc(item.companyName)}</strong></td>
      <td>${esc(item.fileName)}</td>
      <td>${item.livesCreated}</td>
      <td>${item.livesUpdated}</td>
      <td>${item.livesRemoved}</td>
      <td>${esc(item.userName || '—')}</td>
    </tr>`).join('');
    byId('contractsImportsEmpty').classList.toggle('hidden', imports.length > 0);
    const last = imports[0];
    byId('contractsLastImport').innerHTML = last
      ? `<strong>Última importação</strong><br>${esc(last.companyName)} · ${esc(contractsDateTime(last.createdAt))}<br>${last.livesCreated} nova${last.livesCreated === 1 ? '' : 's'} vida${last.livesCreated === 1 ? '' : 's'} · ${last.livesUpdated} atualizada${last.livesUpdated === 1 ? '' : 's'}`
      : 'Nenhuma planilha importada ainda.';
  }

  function renderContracts() {
    renderContractKpis();
    fillContractMonths();
    renderContractList();
    renderContractImports();
  }

  async function loadContracts() {
    if (!window.PortalAccess?.Access?.token || state.loading) return;
    state.loading = true;
    byId('contractsRefreshButton')?.setAttribute('disabled', '');
    try {
      const data = await window.PortalAccess.api('/api/contracts');
      state.companies = data.companies || [];
      state.summary = data.summary || state.summary;
      state.imports = data.imports || [];
      const viewer = window.PortalAccess?.Access?.user;
      state.canSeeValues = viewer?.role === 'admin' || Boolean(viewer?.management);
      state.canRegister = Boolean(data.canRegister);
      state.loaded = true;
      renderContracts();
    } catch (error) {
      if (error.message !== 'auth') {
        byId('contractsList').innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
      }
    } finally {
      state.loading = false;
      byId('contractsRefreshButton')?.removeAttribute('disabled');
    }
  }

  function contractInfo(label, value, wide) {
    return `<div class="contracts-info-item${wide ? ' wide' : ''}"><span>${esc(label)}</span><strong>${value ? esc(value) : '—'}</strong></div>`;
  }

  function renderCompanyDetail() {
    const company = state.selected;
    if (!company) return;
    byId('contractsCompanyAvatar').textContent = initials(company.name);
    byId('contractsCompanyName').textContent = company.name;
    byId('contractsCompanyEyebrow').textContent = `EMPRESA · ${statusLabel(company.status).toUpperCase()}`;
    byId('contractsCompanySub').textContent = [company.cnpj || 'CNPJ não informado', `${company.livesCount} vida${company.livesCount === 1 ? '' : 's'}`, company.companyRegistered ? 'Empresa cadastrada' : 'Empresa aguardando cadastro'].join(' · ');
    byId('contractsCompanyInfo').innerHTML = [
      contractInfo('CNPJ', company.cnpj),
      contractInfo('Contato', company.contactName),
      contractInfo('Telefone', company.phone),
      contractInfo('E-mail', company.email),
      contractInfo('Plano / produto', company.plan),
      state.canSeeValues ? contractInfo('Valor mensal', company.monthlyValue ? contractsMoney(company.monthlyValue) : '') : '',
      contractInfo('Vendedor', company.seller),
      contractInfo('Início', company.contractStart ? contractsDate(company.contractStart) : ''),
      contractInfo('Cadastro da empresa', company.companyRegistered ? 'Cadastrada' : 'Aguardando cadastro'),
      contractInfo('Confirmação', [company.companyRegisteredBy, company.companyRegisteredAt ? contractsDateTime(company.companyRegisteredAt) : ''].filter(Boolean).join(' · ')),
      contractInfo('Contador', company.accountantName),
      contractInfo('E-mail do contador', company.accountantEmail),
      contractInfo('Atualizado em', company.updatedAt ? contractsDateTime(company.updatedAt) : ''),
      contractInfo('Arquivo de origem', company.sourceFile),
      contractInfo('Observações', company.notes, true),
    ].join('');
    if (window.PortalAccess?.canSee('vendasScreen')) {
      const block = document.createElement('div');
      block.className = 'contracts-info-item wide vendas-contract-block';
      block.innerHTML = '<span>Vendas S4E</span><button type="button" class="button button-secondary">Ver vendas vinculadas</button>';
      block.querySelector('button').addEventListener('click', () => {
        byId('contractsCompanyDialog').close();
        window.openVendasForCompany?.(company.id);
      });
      byId('contractsCompanyInfo').append(block);
    }
    byId('contractsLivesSub').textContent = state.showCpf ? 'CPFs visíveis' : 'CPFs protegidos — use "Mostrar CPFs" para ver';
    byId('contractsCpfToggle').textContent = state.showCpf ? 'Ocultar CPFs' : 'Mostrar CPFs';
    const pendingLives = state.lives.filter(life => !life.registered).length;
    const registerAllButton = byId('contractsRegisterAllLives');
    registerAllButton?.classList.toggle('hidden', !state.canRegister || pendingLives === 0);
    const companyRegisterButton = byId('contractsCompanyRegister');
    if (companyRegisterButton) {
      companyRegisterButton.classList.toggle('hidden', !state.canRegister);
      companyRegisterButton.textContent = company.companyRegistered ? 'Desmarcar empresa cadastrada' : 'Marcar empresa como cadastrada';
      companyRegisterButton.dataset.registered = company.companyRegistered ? '1' : '0';
    }
    renderContractLives();
  }

  function renderContractLives() {
    if (!state.selected) return;
    const query = state.lifeSearch.trim().toLowerCase();
    const list = state.lives.filter(life => !query || [life.name, life.cpf, life.phone, life.email, life.motherName]
      .filter(Boolean).join(' ').toLowerCase().includes(query));
    byId('contractsLivesTitle').textContent = `Vidas (${state.lives.length})`;
    byId('contractsLivesSub').textContent = `${state.selected.registeredCount || 0} de ${state.lives.length} cadastradas · ${state.showCpf ? 'CPFs visíveis' : 'CPFs protegidos — use "Mostrar CPFs" para ver'}`;
    byId('contractsLivesBody').innerHTML = list.map(life => {
      const age = contractsAge(life.birthDate);
      const birth = life.birthDate ? `${contractsDate(life.birthDate)}${age ? ` · ${age}` : ''}` : '—';
      const days = contractsDaysToBirthday(life.birthDate);
      const badge = days !== null && days <= 30
        ? `<small class="contracts-inline-badge">${days === 0 ? 'aniversário hoje' : `em ${days} dia${days === 1 ? '' : 's'}`}</small>`
        : '';
      const status = life.registered
        ? '<span class="life-status ok">Cadastrada</span>'
        : '<span class="life-status pending">Pendente</span>';
      const statusCell = state.canRegister
        ? `<button type="button" class="life-status ${life.registered ? 'ok' : 'pending'}" data-life-register="${esc(life.id)}" title="${life.registered ? 'Marcar como pendente' : 'Marcar como cadastrada'}">${life.registered ? 'Cadastrada' : 'Pendente'}</button>`
        : status;
      return `<tr>
        <td><strong>${esc(life.name)}</strong>${badge}</td>
        <td>${esc(state.showCpf ? (life.cpf || '—') : maskCpf(life.cpf))}</td>
        <td>${esc(birth)}</td>
        <td>${esc(life.motherName || '—')}</td>
        <td>${esc(life.phone || '—')}</td>
        <td>${esc(life.email || '—')}</td>
        <td>${statusCell}</td>
        <td class="contracts-row-actions"><button type="button" data-life-edit="${esc(life.id)}">Editar</button><button type="button" data-life-delete="${esc(life.id)}">Excluir</button></td>
      </tr>`;
    }).join('');
    byId('contractsLivesEmpty').classList.toggle('hidden', list.length > 0);
    byId('contractsLivesEmpty').textContent = state.lives.length
      ? 'Nenhuma vida encontrada nessa busca.'
      : 'Esta empresa ainda não tem vidas cadastradas. Use "Adicionar vida" ou importe a planilha novamente.';
  }

  async function openContractCompany(companyId) {
    const sessionToken = window.PortalAccess?.Access?.token;
    try {
      const data = await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(companyId)}`);
      if (!sessionToken || sessionToken !== window.PortalAccess?.Access?.token || !window.PortalAccess.Access.user) return;
      state.selectedId = companyId;
      state.selected = data.company;
      state.lives = data.lives || [];
      state.canRegister = Boolean(data.canRegister);
      state.lifeSearch = '';
      state.showCpf = false;
      byId('contractsLifeSearch').value = '';
      renderCompanyDetail();
      const dialog = byId('contractsCompanyDialog');
      if (!dialog.open) dialog.showModal();
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  window.openContractFromVendas = companyId => {
    if (!companyId || window.PortalAccess?.Access?.user?.role !== 'admin') return;
    window.PortalAccess.openScreen('contractsScreen');
    return openContractCompany(companyId);
  };

  async function refreshSelectedCompany() {
    if (!state.selectedId) return;
    const data = await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}`);
    state.selected = data.company;
    state.lives = data.lives || [];
    if (typeof data.canRegister === 'boolean') state.canRegister = data.canRegister;
    renderCompanyDetail();
  }

  async function toggleLifeRegistered(lifeId) {
    const life = state.lives.find(item => item.id === lifeId);
    if (!life || !state.canRegister) return;
    try {
      await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}/lives/${encodeURIComponent(lifeId)}`, {
        method: 'PATCH', body: JSON.stringify({ registered: !life.registered }),
      });
      await refreshSelectedCompany();
      await loadContracts();
      showToast(life.registered ? 'Vida marcada como pendente.' : 'Vida marcada como cadastrada.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function registerAllLives() {
    if (!state.selectedId || !state.canRegister) return;
    const pendingLives = state.lives.filter(life => !life.registered);
    if (!pendingLives.length) return;
    if (!window.confirm(`Marcar ${pendingLives.length} vida${pendingLives.length === 1 ? '' : 's'} como cadastrada${pendingLives.length === 1 ? '' : 's'}?`)) return;
    try {
      await Promise.all(pendingLives.map(life => window.PortalAccess.api(
        `/api/contracts/${encodeURIComponent(state.selectedId)}/lives/${encodeURIComponent(life.id)}`,
        { method: 'PATCH', body: JSON.stringify({ registered: true }) },
      )));
      await refreshSelectedCompany();
      await loadContracts();
      showToast(`${pendingLives.length} vida${pendingLives.length === 1 ? '' : 's'} marcada${pendingLives.length === 1 ? '' : 's'} como cadastrada${pendingLives.length === 1 ? '' : 's'}.`);
    } catch (error) {
      try {
        await refreshSelectedCompany();
      } catch (refreshError) {
        if (refreshError.message !== 'auth') showToast(refreshError.message, 'warning');
      }
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function toggleCompanyRegistered() {
    const company = state.selected;
    if (!company || !state.canRegister) return;
    const registered = !company.companyRegistered;
    const question = registered
      ? `Marcar a empresa "${company.name}" como cadastrada?`
      : `Voltar a empresa "${company.name}" para cadastro pendente?`;
    if (!window.confirm(`${question} O vendedor ${company.seller || 'do contrato'} será avisado.`)) return;
    try {
      const data = await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(company.id)}/registration`, {
        method: 'PATCH', body: JSON.stringify({ registered }),
      });
      state.selected = data.company;
      state.lives = data.lives || state.lives;
      renderCompanyDetail();
      await loadContracts();
      showToast(registered ? 'Empresa marcada como cadastrada.' : 'Empresa marcada como aguardando cadastro.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function previewItem(label, value) {
    return `<div class="contracts-preview-item"><span>${esc(label)}</span><strong>${esc(value || '—')}</strong></div>`;
  }

  function renderImportPreview(data) {
    const company = data.company || {};
    const lives = data.lives || [];
    const revenue = Number(company.monthly_value) || 0;
    const commissionImport = state.importPrefix === '/api/commissions';
    const finance = commissionImport ? `
      <div class="contracts-preview-finance">
        <div><span>Vendedor</span><strong>${esc(company.seller || '—')}</strong></div>
        <div><span>Receita inicial</span><strong>${contractsMoney(revenue)}</strong></div>
        <div><span>Comissão (40%)</span><strong>${contractsMoney(revenue * 0.4)}</strong></div>
      </div>
      ${revenue ? '' : '<p class="contracts-note">A planilha não trouxe valor. Depois de importar, edite o contrato para informar o valor mensal ou por vida.</p>'}` : '';
    const rows = lives.slice(0, 8).map(life => `<tr>
      <td>${esc(life.name)}</td><td>${esc(life.cpf || '—')}</td><td>${esc(contractsDate(life.birth_date))}</td><td>${esc(life.phone || '—')}</td>
    </tr>`).join('');
    byId('contractsPreview').innerHTML = `<div class="contracts-preview-card">
      <div class="contracts-preview-head">
        <div><p class="eyebrow">PLANILHA LIDA</p><h3>${esc(company.name || 'Empresa sem nome')}</h3></div>
        <span class="contract-pill">${data.livesCount} vida${data.livesCount === 1 ? '' : 's'}</span>
      </div>
      <div class="contracts-preview-grid">
        ${previewItem('CNPJ', company.cnpj)}
        ${previewItem('Contato', company.contact_name)}
        ${previewItem('Telefone', company.phone)}
        ${previewItem('E-mail', company.email)}
        ${previewItem('Contador', company.accountant_name)}
        ${previewItem('Plano', company.plan)}
      </div>
      ${finance}
      ${data.existing ? `<p class="contracts-existing">Já existe uma empresa com esse CNPJ/nome: <strong>${esc(data.existing.name)}</strong> (${data.existing.livesCount} vidas). A importação atualiza o cadastro e completa as vidas.</p>
        <label class="contracts-check"><input type="checkbox" id="contractsReplaceLives"> Substituir a lista de vidas pela planilha (remove quem não estiver nela)</label>` : ''}
      ${(data.warnings || []).map(warning => `<p class="contracts-warning">${esc(warning)}</p>`).join('')}
      ${lives.length ? `<div class="history-table-wrap" style="margin-top:12px"><table class="history-table contracts-preview-table"><thead><tr><th>Nome</th><th>CPF</th><th>Nascimento</th><th>Celular</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="contracts-note">Nenhuma vida encontrada nesta planilha.</p>'}
      ${data.livesCount > lives.length ? `<p class="contracts-note">Mostrando ${lives.length} de ${data.livesCount} vidas.</p>` : ''}
    </div>`;
    byId('contractsPreview').classList.remove('hidden');
  }

  function showImportError(message) {
    const box = byId('contractsImportError');
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
  }

  function resetImportDialog() {
    state.file = null;
    state.preview = null;
    state.importing = false;
    state.importPrefix = '/api/contracts';
    state.importAfter = null;
    const input = byId('contractsFile');
    if (input) input.value = '';
    byId('contractsFileName').hidden = true;
    byId('contractsFileName').textContent = '';
    byId('contractsPreview').classList.add('hidden');
    byId('contractsPreview').innerHTML = '';
    showImportError('');
    const confirm = byId('contractsImportConfirm');
    confirm.disabled = true;
    confirm.textContent = 'Importar planilha';
    byId('contractsDrop').classList.remove('dragover');
  }

  function openImportDialog(options = {}) {
    resetImportDialog();
    state.importPrefix = options.prefix || '/api/contracts';
    state.importAfter = typeof options.after === 'function' ? options.after : null;
    byId('contractsImportDialog').showModal();
  }

  function closeImportDialog() {
    const dialog = byId('contractsImportDialog');
    if (dialog.open) dialog.close();
  }

  async function previewContractFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      showImportError('Escolha um arquivo .xlsx. Se a planilha estiver em outro formato, salve como .xlsx e tente novamente.');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      showImportError('A planilha deve ter no máximo 12 MB.');
      return;
    }
    state.file = file;
    byId('contractsFileName').hidden = false;
    byId('contractsFileName').textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
    byId('contractsPreview').classList.add('hidden');
    showImportError('');
    const confirm = byId('contractsImportConfirm');
    confirm.disabled = true;
    confirm.textContent = 'Lendo planilha...';
    try {
      const data = await window.PortalAccess.api(`${state.importPrefix}/preview?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      state.preview = data;
      renderImportPreview(data);
      confirm.disabled = false;
      confirm.textContent = 'Importar planilha';
    } catch (error) {
      if (error.message !== 'auth') showImportError(error.message);
      confirm.textContent = 'Importar planilha';
    }
  }

  async function confirmContractImport() {
    if (!state.file || !state.preview || state.importing) return;
    const prefix = state.importPrefix;
    const after = state.importAfter;
    state.importing = true;
    const confirm = byId('contractsImportConfirm');
    confirm.disabled = true;
    confirm.textContent = 'Importando...';
    const replace = byId('contractsReplaceLives')?.checked ? '1' : '0';
    try {
      const data = await window.PortalAccess.api(`${prefix}/import?name=${encodeURIComponent(state.file.name)}&replace=${replace}`, { method: 'POST', body: state.file });
      closeImportDialog();
      if (after) {
        await after(data);
        return;
      }
      await loadContracts();
      const imported = data.imported || {};
      showToast(`${imported.livesCreated || 0} nova(s) vida(s) e ${imported.livesUpdated || 0} atualizada(s) em ${data.company?.name || 'empresa'}.`);
      if (data.company?.id) openContractCompany(data.company.id);
    } catch (error) {
      if (error.message !== 'auth') showImportError(error.message);
      confirm.disabled = false;
      confirm.textContent = 'Importar planilha';
    } finally {
      state.importing = false;
    }
  }

  async function exportContracts(scope, company) {
    try {
      const params = new URLSearchParams({ scope });
      if (company?.id && scope === 'lives') params.set('companyId', company.id);
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/contracts/export?${params}`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível exportar.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = scope === 'lives' ? `vidas-${slug(company?.name || 'contratos')}.csv` : 'contratos-empresas.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast('Exportação pronta.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function openCompanyEdit() {
    const company = state.selected;
    if (!company) return;
    byId('contractsFormName').value = company.name || '';
    byId('contractsFormCnpj').value = company.cnpj || '';
    byId('contractsFormContact').value = company.contactName || '';
    byId('contractsFormPhone').value = company.phone || '';
    byId('contractsFormEmail').value = company.email || '';
    byId('contractsFormAccountant').value = company.accountantName || '';
    byId('contractsFormAccountantEmail').value = company.accountantEmail || '';
    byId('contractsFormPlan').value = company.plan || '';
    byId('contractsFormValue').value = company.monthlyValue || '';
    const valueLabel = byId('contractsFormValue')?.closest('label');
    if (valueLabel) valueLabel.hidden = !state.canSeeValues;
    byId('contractsFormSeller').value = company.seller || '';
    byId('contractsFormStart').value = company.contractStart || '';
    byId('contractsFormStatus').value = company.status || 'ativo';
    byId('contractsFormNotes').value = company.notes || '';
    byId('contractsCompanyEditDialog').showModal();
  }

  async function saveCompany(event) {
    event.preventDefault();
    if (!state.selectedId) return;
    const payload = {
      name: byId('contractsFormName').value.trim(),
      cnpj: byId('contractsFormCnpj').value.trim(),
      contact_name: byId('contractsFormContact').value.trim(),
      phone: byId('contractsFormPhone').value.trim(),
      email: byId('contractsFormEmail').value.trim(),
      accountant_name: byId('contractsFormAccountant').value.trim(),
      accountant_email: byId('contractsFormAccountantEmail').value.trim(),
      plan: byId('contractsFormPlan').value.trim(),
      seller: byId('contractsFormSeller').value.trim(),
      contract_start: byId('contractsFormStart').value,
      status: byId('contractsFormStatus').value,
      notes: byId('contractsFormNotes').value.trim(),
    };
    if (state.canSeeValues) payload.monthly_value = byId('contractsFormValue').value;
    try {
      const data = await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      state.selected = data.company;
      state.lives = data.lives || [];
      byId('contractsCompanyEditDialog').close();
      renderCompanyDetail();
      await loadContracts();
      showToast('Empresa atualizada.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function openLifeDialog(life) {
    state.editingLife = life || null;
    byId('contractsLifeDialogTitle').textContent = life ? 'Editar vida' : 'Adicionar vida';
    byId('contractsLifeName').value = life?.name || '';
    byId('contractsLifeCpf').value = life?.cpf || '';
    byId('contractsLifeBirth').value = life?.birthDate || '';
    byId('contractsLifeMother').value = life?.motherName || '';
    byId('contractsLifePhone').value = life?.phone || '';
    byId('contractsLifeEmail').value = life?.email || '';
    byId('contractsLifeRole').value = life?.role || '';
    byId('contractsLifeNotes').value = life?.notes || '';
    byId('contractsLifeDialog').showModal();
    byId('contractsLifeName').focus();
  }

  async function saveLife(event) {
    event.preventDefault();
    if (!state.selectedId) return;
    const payload = {
      name: byId('contractsLifeName').value.trim(),
      cpf: byId('contractsLifeCpf').value.trim(),
      birth_date: byId('contractsLifeBirth').value,
      mother_name: byId('contractsLifeMother').value.trim(),
      phone: byId('contractsLifePhone').value.trim(),
      email: byId('contractsLifeEmail').value.trim(),
      role: byId('contractsLifeRole').value.trim(),
      notes: byId('contractsLifeNotes').value.trim(),
    };
    if (!payload.name) return;
    try {
      if (state.editingLife) {
        await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}/lives/${encodeURIComponent(state.editingLife.id)}`, {
          method: 'PATCH', body: JSON.stringify(payload),
        });
      } else {
        await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}/lives`, {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      byId('contractsLifeDialog').close();
      state.editingLife = null;
      await refreshSelectedCompany();
      await loadContracts();
      showToast('Vida salva.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function deleteLife(lifeId) {
    const life = state.lives.find(item => item.id === lifeId);
    if (!life || !confirm(`Excluir ${life.name} desta empresa?`)) return;
    try {
      await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.selectedId)}/lives/${encodeURIComponent(lifeId)}`, { method: 'DELETE' });
      await refreshSelectedCompany();
      await loadContracts();
      showToast('Vida excluída.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function deleteCompany() {
    const company = state.selected;
    if (!company) return;
    if (!confirm(`Excluir ${company.name} e as ${company.livesCount} vidas vinculadas? Essa ação não pode ser desfeita.`)) return;
    try {
      await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(company.id)}`, { method: 'DELETE' });
      byId('contractsCompanyDialog').close();
      state.selected = null;
      state.selectedId = null;
      state.lives = [];
      await loadContracts();
      showToast('Empresa excluída.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function bindContracts() {
    byId('contractsImportButton')?.addEventListener('click', openImportDialog);
    document.querySelectorAll('[data-contracts-import]').forEach(button => button.addEventListener('click', openImportDialog));
    byId('contractsExportButton')?.addEventListener('click', () => exportContracts('lives'));
    byId('contractsRefreshButton')?.addEventListener('click', loadContracts);

    byId('contractsSearch')?.addEventListener('input', event => {
      state.search = event.target.value;
      renderContractList();
    });
    byId('contractsSearchClear')?.addEventListener('click', () => {
      state.search = '';
      byId('contractsSearch').value = '';
      renderContractList();
      byId('contractsSearch').focus();
    });
    byId('contractsStatusFilter')?.addEventListener('change', event => {
      state.status = event.target.value;
      renderContractList();
    });
    byId('contractsDateField')?.addEventListener('change', event => {
      state.monthField = event.target.value;
      state.month = 'all';
      fillContractMonths();
      renderContractList();
    });
    byId('contractsMonthFilter')?.addEventListener('change', event => {
      state.month = event.target.value;
      renderContractList();
    });
    byId('contractsSort')?.addEventListener('change', event => {
      state.sort = event.target.value;
      renderContractList();
    });
    byId('contractsList')?.addEventListener('click', event => {
      const card = event.target.closest('[data-company-id]');
      if (card) openContractCompany(card.dataset.companyId);
    });
    byId('contractsList')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-company-id]');
      if (card) { event.preventDefault(); openContractCompany(card.dataset.companyId); }
    });

    byId('contractsImportClose')?.addEventListener('click', closeImportDialog);
    byId('contractsImportCancel')?.addEventListener('click', closeImportDialog);
    byId('contractsImportDialog')?.addEventListener('close', resetImportDialog);
    byId('contractsFile')?.addEventListener('change', event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) previewContractFile(file);
    });
    const drop = byId('contractsDrop');
    if (drop) {
      ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragover'); }));
      drop.addEventListener('drop', event => {
        const file = event.dataTransfer?.files?.[0];
        if (file) previewContractFile(file);
      });
    }
    byId('contractsImportConfirm')?.addEventListener('click', confirmContractImport);

    byId('contractsCompanyClose')?.addEventListener('click', () => byId('contractsCompanyDialog').close());
    byId('contractsCompanyRegister')?.addEventListener('click', toggleCompanyRegistered);
    byId('contractsCompanyEdit')?.addEventListener('click', openCompanyEdit);
    byId('contractsCompanyExport')?.addEventListener('click', () => exportContracts('lives', state.selected));
    byId('contractsCompanyDelete')?.addEventListener('click', deleteCompany);
    byId('contractsLifeSearch')?.addEventListener('input', event => {
      state.lifeSearch = event.target.value;
      renderContractLives();
    });
    byId('contractsCpfToggle')?.addEventListener('click', () => {
      state.showCpf = !state.showCpf;
      renderCompanyDetail();
    });
    byId('contractsRegisterAllLives')?.addEventListener('click', registerAllLives);
    byId('contractsAddLife')?.addEventListener('click', () => openLifeDialog(null));
    byId('contractsLivesBody')?.addEventListener('click', event => {
      const edit = event.target.closest('[data-life-edit]');
      const remove = event.target.closest('[data-life-delete]');
      const register = event.target.closest('[data-life-register]');
      if (register) { toggleLifeRegistered(register.dataset.lifeRegister); return; }
      if (edit) {
        const life = state.lives.find(item => item.id === edit.dataset.lifeEdit);
        if (life) openLifeDialog(life);
      }
      if (remove) deleteLife(remove.dataset.lifeDelete);
    });

    byId('contractsCompanyEditClose')?.addEventListener('click', () => byId('contractsCompanyEditDialog').close());
    byId('contractsCompanyEditCancel')?.addEventListener('click', () => byId('contractsCompanyEditDialog').close());
    byId('contractsCompanyForm')?.addEventListener('submit', saveCompany);
    byId('contractsLifeClose')?.addEventListener('click', () => byId('contractsLifeDialog').close());
    byId('contractsLifeCancel')?.addEventListener('click', () => byId('contractsLifeDialog').close());
    byId('contractsLifeForm')?.addEventListener('submit', saveLife);
    byId('contractsCompanyDialog')?.addEventListener('close', () => {
      state.selectedId = null;
      state.selected = null;
      state.lives = [];
    });
  }

  bindContracts();

  const screen = byId('contractsScreen');
  if (screen) {
    new MutationObserver(() => {
      if (!screen.classList.contains('hidden')) loadContracts();
    }).observe(screen, { attributes: true, attributeFilter: ['class'] });
  }
  window.enterContractsScreen = loadContracts;
  window.PortalContractImport = { open: openImportDialog };
})();

// ── Tela de Comissões ────────────────────────────────────────
(function () {
  const byId = id => document.getElementById(id);
  const esc = value => (window.escapeHtml ? window.escapeHtml(String(value == null ? '' : value)) : String(value == null ? '' : value));
  const state = {
    loading: false,
    loaded: false,
    companies: [],
    summary: { contracts: 0, lives: 0, revenue: 0, commission: 0, movements: 0 },
    sellers: [],
    rate: 0.4,
    canManage: false,
    sellerName: '',
    search: '',
    seller: 'all',
    status: 'all',
    registration: 'all',
    month: 'all',
    sort: 'commission',
    editingId: null,
    movement: null,
    movementCompanyId: null,
    detailCompanyId: null,
    detail: null,
    detailLives: [],
    detailSearch: '',
    detailCpf: false,
    editingLife: null,
  };

  function money(value) {
    return (Number(value) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function statusLabel(status) {
    return { ativo: 'Ativo', pausado: 'Pausado', encerrado: 'Encerrado' }[status] || 'Ativo';
  }
  function commissionsDate(value) {
    if (!value) return '—';
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const parts = raw.slice(0, 10).split('-');
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return raw;
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '--';
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }
  function monthLabel(month) {
    return `Mês ${month}`;
  }

  function renderKpis() {
    const summary = state.summary || {};
    byId('commissionsKpis').innerHTML = `
      <article class="stat-card highlight"><span>Contratos</span><strong>${summary.contracts || 0}</strong><small>${summary.companiesRegistered || 0} cadastrada${(summary.companiesRegistered || 0) === 1 ? '' : 's'} · ${summary.companiesPending || 0} aguardando</small></article>
      <article class="stat-card"><span>Total de vidas</span><strong>${summary.lives || 0}</strong><small>iniciais + movimentações</small></article>
      <article class="stat-card"><span>Receita total</span><strong>${money(summary.revenue)}</strong><small>soma dos contratos</small></article>
      <article class="stat-card"><span>Comissão (${Math.round((state.rate || 0.4) * 100)}%)</span><strong>${money(summary.commission)}</strong><small>a receber pelo vendedor</small></article>
      <article class="stat-card"><span>Movimentações</span><strong>${summary.movements || 0}</strong><small>lançamentos nos meses 1 a 3</small></article>`;
    byId('commissionsSellerTag').textContent = state.canManage
      ? `Visão da equipe · ${state.sellerName}`
      : `Vendedor: ${state.sellerName || '—'}`;
  }

  function renderSellerPanel() {
    const panel = byId('commissionsSellersPanel');
    panel.classList.toggle('hidden', !state.canManage);
    if (!state.canManage) return;
    byId('commissionsSellersBody').innerHTML = (state.sellers || []).length
      ? state.sellers.map(seller => `<tr>
          <td><strong>${esc(seller.name)}</strong></td>
          <td>${seller.contracts}</td>
          <td>${seller.lives}</td>
          <td>${money(seller.revenue)}</td>
          <td><strong>${money(seller.commission)}</strong></td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty-state">Nenhum vendedor com contrato visível.</td></tr>';
  }

  function filterSellers() {
    const select = byId('commissionsSellerFilter');
    if (!select) return;
    select.classList.toggle('hidden', !state.canManage);
    if (!state.canManage) { state.seller = 'all'; return; }
    const names = [...new Set(state.companies.map(company => company.seller).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const current = state.seller;
    select.innerHTML = '<option value="all">Todos os vendedores</option>' + names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    select.value = names.includes(current) ? current : 'all';
    state.seller = select.value;
  }

  function calendarMonthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    if (!year || !month) return key;
    const label = new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function fillMonthFilter() {
    const select = byId('commissionsMonthFilter');
    if (!select) return;
    const keys = [...new Set(state.companies
      .map(company => String(company.contractStart || '').slice(0, 7))
      .filter(key => /^\d{4}-\d{2}$/.test(key)))].sort().reverse();
    const current = state.month;
    select.innerHTML = '<option value="all">Todos os meses</option>'
      + keys.map(key => `<option value="${key}">${esc(calendarMonthLabel(key))}</option>`).join('')
      + '<option value="none">Sem data de início</option>';
    select.value = current === 'none' || keys.includes(current) ? current : 'all';
    state.month = select.value;
  }

  function filteredCompanies() {
    const query = state.search.trim().toLowerCase();
    const digits = query.replace(/\D/g, '');
    const list = state.companies.filter(company => {
      if (state.status !== 'all' && company.status !== state.status) return false;
      if (state.seller !== 'all' && company.seller !== state.seller) return false;
      if (state.registration === 'registered' && !company.companyRegistered) return false;
      if (state.registration === 'pending' && company.companyRegistered) return false;
      if (state.month !== 'all') {
        const monthKey = String(company.contractStart || '').slice(0, 7);
        if (state.month === 'none' ? monthKey : monthKey !== state.month) return false;
      }
      if (!query) return true;
      const haystack = [company.name, company.cnpj, company.seller, company.plan, company.contactName, company.email, company.phone]
        .filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(query)) return true;
      return digits.length >= 3 && String(company.cnpj || '').replace(/\D/g, '').includes(digits);
    });
    const sorters = {
      commission: (a, b) => (b.totalCommission || 0) - (a.totalCommission || 0) || String(a.name).localeCompare(String(b.name), 'pt-BR'),
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'),
      lives: (a, b) => (b.totalLives || 0) - (a.totalLives || 0),
      updated: (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
    };
    return list.sort(sorters[state.sort] || sorters.commission);
  }

  function movementRow(movement) {
    return `<div class="commission-mov">
      <span class="commission-mov-month">${esc(monthLabel(movement.monthNumber))}</span>
      <div class="commission-mov-info">${movement.livesAdded} vida${movement.livesAdded === 1 ? '' : 's'} × ${money(movement.valuePerLife)}
        ${movement.note ? `<small>${esc(movement.note)}</small>` : ''}</div>
      <span class="commission-mov-value">${money(movement.totalMonth)}</span>
      <span class="commission-mov-commission">${money(movement.commission)}</span>
      <span class="commission-mov-actions">
        <button type="button" data-mov-edit="${esc(movement.id)}">Editar</button>
        <button type="button" data-mov-delete="${esc(movement.id)}">Excluir</button>
      </span>
    </div>`;
  }

  function commissionCard(company) {
    const lives = company.livesCount || 0;
    const registered = company.registeredCount || 0;
    const pending = Math.max(0, lives - registered);
    const registration = lives
      ? (pending
        ? `<span class="contract-tag contract-tag-pending">${registered}/${lives} cadastradas</span>`
        : `<span class="contract-tag contract-tag-ok">Todas cadastradas</span>`)
      : '<span class="contract-tag contract-tag-pending">Sem vidas</span>';
    const companyRegistration = company.companyRegistered
      ? '<span class="contract-tag contract-tag-ok">Empresa cadastrada</span>'
      : '<span class="contract-tag contract-tag-pending">Empresa aguardando cadastro</span>';
    const movements = (company.movements || []).length;
    return `<article class="commission-card" data-commission-id="${esc(company.id)}" tabindex="0" role="button" aria-label="Abrir contrato de ${esc(company.name)}">
      <span class="commission-avatar">${esc(initials(company.name))}</span>
      <div class="contract-card-main">
        <div class="commission-title"><h3>${esc(company.name)}</h3><span class="contract-status ${esc(company.status)}">${esc(statusLabel(company.status))}</span></div>
        <div class="commission-meta">
          <span>${esc(company.seller || 'Sem vendedor')}</span>
          ${company.plan ? `<span>${esc(company.plan)}</span>` : ''}
          <span>${company.totalLives || 0} vida${company.totalLives === 1 ? '' : 's'}</span>
          <span>${movements} movimentaç${movements === 1 ? 'ão' : 'ões'}</span>
        </div>
        <div class="contract-card-tags">
          ${companyRegistration}
          ${registration}
          <span class="contract-tag">${esc(company.clientType || 'Empresa')}</span>
        </div>
      </div>
      <div class="commission-side"><strong>${money(company.totalCommission)}</strong><span>comissão total</span><small>abrir contrato</small></div>
    </article>`;
  }

  function renderList() {
    const list = filteredCompanies();
    const total = state.companies.length;
    byId('commissionsCount').textContent = list.length === total
      ? `${total} contrato${total === 1 ? '' : 's'}`
      : `${list.length} de ${total} contratos`;
    byId('commissionsFilterHint').textContent = (state.search.trim() || state.status !== 'all' || state.seller !== 'all' || state.registration !== 'all' || state.month !== 'all') ? 'Filtros ativos' : '';
    byId('commissionsSearchClear').hidden = !state.search;
    byId('commissionsList').innerHTML = list.length
      ? list.map(commissionCard).join('')
      : (total ? '<p class="empty-state">Nenhum contrato encontrado com esses filtros.</p>' : '');
    byId('commissionsEmpty').classList.toggle('hidden', total > 0);
  }

  function renderRegistrationNotice() {
    const notice = byId('commissionsRegistrationNotice');
    if (!notice) return;
    const pending = (state.summary || {}).companiesPending || 0;
    notice.classList.toggle('hidden', pending === 0);
    notice.textContent = pending
      ? `${pending} contrato${pending === 1 ? '' : 's'} aguardando confirmação de cadastro pela equipe de Contratos.`
      : '';
  }

  function maskCpf(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length !== 11) return value || '—';
    return `${digits.slice(0, 3)}.•••.•••-${digits.slice(9)}`;
  }
  function lifeAge(birthDate) {
    if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return '';
    const parts = birthDate.slice(0, 10).split('-').map(Number);
    const now = new Date();
    let age = now.getFullYear() - parts[0];
    if (now.getMonth() + 1 < parts[1] || (now.getMonth() + 1 === parts[1] && now.getDate() < parts[2])) age -= 1;
    return age >= 0 && age < 130 ? `${age} anos` : '';
  }
  function detailInfoItem(label, value, wide) {
    return `<div class="contracts-info-item${wide ? ' wide' : ''}"><span>${esc(label)}</span><strong>${value ? esc(value) : '—'}</strong></div>`;
  }

  function renderCommissionDetail() {
    const company = state.detail;
    if (!company) return;
    const lives = company.livesCount || 0;
    byId('commissionsDetailAvatar').textContent = initials(company.name);
    byId('commissionsDetailName').textContent = company.name;
    byId('commissionsDetailEyebrow').textContent = `CONTRATO · ${statusLabel(company.status).toUpperCase()}`;
    byId('commissionsDetailSub').textContent = [
      company.cnpj || 'CNPJ não informado',
      `${lives} vida${lives === 1 ? '' : 's'}`,
      company.companyRegistered ? 'Empresa cadastrada' : 'Empresa aguardando cadastro',
    ].join(' · ');
    byId('commissionsDetailInfo').innerHTML = [
      detailInfoItem('CNPJ / CPF', company.cnpj),
      detailInfoItem('Contato', company.contactName),
      detailInfoItem('Telefone', company.phone),
      detailInfoItem('E-mail', company.email),
      detailInfoItem('Produto', company.plan),
      detailInfoItem('Vendedor', company.seller),
      detailInfoItem('Início', company.contractStart ? commissionsDate(company.contractStart) : ''),
      detailInfoItem('Status', statusLabel(company.status)),
      detailInfoItem('Cadastro da empresa', company.companyRegistered ? 'Cadastrada' : 'Aguardando cadastro'),
      detailInfoItem('Confirmação', [company.companyRegisteredBy, company.companyRegisteredAt ? commissionsDate(company.companyRegisteredAt) : ''].filter(Boolean).join(' · ')),
      detailInfoItem('Observações', company.notes, true),
    ].join('');
    if (window.PortalAccess?.canSee('vendasScreen')) {
      const block = document.createElement('div');
      block.className = 'contracts-info-item wide vendas-contract-block';
      block.innerHTML = '<span>Vendas S4E</span><button type="button" class="button button-secondary">Ver vendas vinculadas</button>';
      block.querySelector('button').addEventListener('click', () => {
        byId('commissionsDetailDialog').close();
        window.openVendasForCompany?.(company.id);
      });
      byId('commissionsDetailInfo').append(block);
    }
    byId('commissionsDetailFinance').innerHTML = [
      ['Receita inicial', money(company.initialTotal), ''],
      ['Comissão inicial', money(company.initialCommission), 'accent'],
      ['Receita movimentos', money(company.movementTotal), ''],
      ['Comissão movimentos', money(company.movementCommission), 'accent'],
      ['Receita total', money(company.totalRevenue), ''],
      ['Comissão total', money(company.totalCommission), 'accent'],
      ['Vidas iniciais', company.initialLives || 0, ''],
      ['Vidas movimentadas', company.movementLives || 0, ''],
    ].map(([label, value, cls]) => `<div class="commission-fin-item ${cls}"><span>${esc(label)}</span><strong>${value}</strong></div>`).join('');
    const movements = (company.movements || []).length
      ? company.movements.map(movementRow).join('')
      : '<div class="commission-empty-mov">Nenhuma movimentação lançada. Use os três primeiros meses para registrar entradas de vidas.</div>';
    byId('commissionsDetailMovements').innerHTML = movements;
    renderCommissionLives();
  }

  function renderCommissionLives() {
    const company = state.detail;
    if (!company) return;
    const query = state.detailSearch.trim().toLowerCase();
    const list = state.detailLives.filter(life => !query || [life.name, life.cpf, life.phone, life.email, life.motherName]
      .filter(Boolean).join(' ').toLowerCase().includes(query));
    const registered = company.registeredCount || 0;
    byId('commissionsLivesTitle').textContent = `Vidas (${state.detailLives.length})`;
    byId('commissionsLivesSub').textContent = `${registered} cadastrada${registered === 1 ? '' : 's'} · ${Math.max(0, state.detailLives.length - registered)} pendente${state.detailLives.length - registered === 1 ? '' : 's'} · ${state.detailCpf ? 'CPFs visíveis' : 'CPFs protegidos'}`;
    byId('commissionsCpfToggle').textContent = state.detailCpf ? 'Ocultar CPFs' : 'Mostrar CPFs';
    byId('commissionsLivesBody').innerHTML = list.map(life => {
      const age = lifeAge(life.birthDate);
      const birth = life.birthDate ? `${commissionsDate(life.birthDate)}${age ? ` · ${age}` : ''}` : '—';
      const statusCell = `<span class="life-status ${life.registered ? 'ok' : 'pending'}">${life.registered ? 'Cadastrada' : 'Pendente'}</span>`;
      return `<tr>
        <td><strong>${esc(life.name)}</strong></td>
        <td>${esc(state.detailCpf ? (life.cpf || '—') : maskCpf(life.cpf))}</td>
        <td>${esc(birth)}</td>
        <td>${esc(life.motherName || '—')}</td>
        <td>${esc(life.phone || '—')}</td>
        <td>${esc(life.email || '—')}</td>
        <td>${statusCell}</td>
        <td class="contracts-row-actions"><button type="button" data-commission-life-edit="${esc(life.id)}">Editar</button><button type="button" data-commission-life-delete="${esc(life.id)}">Excluir</button></td>
      </tr>`;
    }).join('');
    byId('commissionsLivesEmpty').classList.toggle('hidden', list.length > 0);
    byId('commissionsLivesEmpty').textContent = state.detailLives.length
      ? 'Nenhuma vida encontrada nessa busca.'
      : 'Este contrato ainda não tem vidas cadastradas. Use "Adicionar vida" ou importe a planilha.';
  }

  async function openCommissionDetail(companyId) {
    const sessionToken = window.PortalAccess?.Access?.token;
    try {
      const data = await window.PortalAccess.api(`/api/commissions/companies/${encodeURIComponent(companyId)}`);
      if (!sessionToken || sessionToken !== window.PortalAccess?.Access?.token || !window.PortalAccess.Access.user) return;
      state.detailCompanyId = companyId;
      state.detail = data.company;
      state.detailLives = data.lives || [];
      state.detailSearch = '';
      state.detailCpf = false;
      byId('commissionsLifeSearch').value = '';
      renderCommissionDetail();
      const dialog = byId('commissionsDetailDialog');
      if (!dialog.open) dialog.showModal();
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  window.openCommissionFromVendas = companyId => {
    if (!companyId || window.PortalAccess?.Access?.user?.role !== 'admin') return;
    window.PortalAccess.openScreen('commissionsScreen');
    return openCommissionDetail(companyId);
  };

  async function refreshCommissionDetail() {
    if (!state.detailCompanyId) return;
    const data = await window.PortalAccess.api(`/api/commissions/companies/${encodeURIComponent(state.detailCompanyId)}`);
    state.detail = data.company;
    state.detailLives = data.lives || [];
    renderCommissionDetail();
  }

  function openCommissionsLifeDialog(life) {
    if (!state.detailCompanyId) return;
    state.editingLife = life || null;
    byId('commissionsLifeDialogTitle').textContent = life ? 'Editar vida' : 'Adicionar vida';
    byId('commissionsLifeName').value = life?.name || '';
    byId('commissionsLifeCpf').value = life?.cpf || '';
    byId('commissionsLifeBirth').value = life?.birthDate || '';
    byId('commissionsLifeMother').value = life?.motherName || '';
    byId('commissionsLifePhone').value = life?.phone || '';
    byId('commissionsLifeEmail').value = life?.email || '';
    byId('commissionsLifeRole').value = life?.role || '';
    byId('commissionsLifeNotes').value = life?.notes || '';
    byId('commissionsLifeRegisteredWrap').classList.add('hidden');
    byId('commissionsLifeRegistered').checked = false;
    byId('commissionsLifeDialog').showModal();
    byId('commissionsLifeName').focus();
  }

  async function saveCommissionsLife(event) {
    event.preventDefault();
    if (!state.detailCompanyId) return;
    const payload = {
      name: byId('commissionsLifeName').value.trim(),
      cpf: byId('commissionsLifeCpf').value.trim(),
      birth_date: byId('commissionsLifeBirth').value,
      mother_name: byId('commissionsLifeMother').value.trim(),
      phone: byId('commissionsLifePhone').value.trim(),
      email: byId('commissionsLifeEmail').value.trim(),
      role: byId('commissionsLifeRole').value.trim(),
      notes: byId('commissionsLifeNotes').value.trim(),
    };
    if (!payload.name) return;
    try {
      if (state.editingLife) {
        await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.detailCompanyId)}/lives/${encodeURIComponent(state.editingLife.id)}`, {
          method: 'PATCH', body: JSON.stringify(payload),
        });
      } else {
        await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.detailCompanyId)}/lives`, {
          method: 'POST', body: JSON.stringify(payload),
        });
      }
      byId('commissionsLifeDialog').close();
      state.editingLife = null;
      await refreshCommissionDetail();
      await loadCommissions();
      showToast('Vida salva.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function deleteCommissionsLife(lifeId) {
    const life = state.detailLives.find(item => item.id === lifeId);
    if (!life || !window.confirm(`Excluir ${life.name} deste contrato?`)) return;
    try {
      await window.PortalAccess.api(`/api/contracts/${encodeURIComponent(state.detailCompanyId)}/lives/${encodeURIComponent(lifeId)}`, { method: 'DELETE' });
      await refreshCommissionDetail();
      await loadCommissions();
      showToast('Vida excluída.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function render() {
    renderKpis();
    filterSellers();
    fillMonthFilter();
    renderSellerPanel();
    renderList();
    renderRegistrationNotice();
  }

  async function loadCommissions() {
    if (!window.PortalAccess?.Access?.token || state.loading) return;
    state.loading = true;
    byId('commissionsRefreshButton')?.setAttribute('disabled', '');
    try {
      const data = await window.PortalAccess.api('/api/commissions');
      state.companies = data.companies || [];
      state.summary = data.summary || state.summary;
      state.sellers = data.sellers || [];
      state.rate = Number(data.rate) || 0.4;
      state.canManage = Boolean(data.canManage);
      state.sellerName = data.sellerName || '';
      state.loaded = true;
      render();
    } catch (error) {
      if (error.message !== 'auth') {
        byId('commissionsList').innerHTML = `<p class="empty-state">${esc(error.message)}</p>`;
      }
    } finally {
      state.loading = false;
      byId('commissionsRefreshButton')?.removeAttribute('disabled');
    }
  }

  async function afterCommissionImport(data) {
    const imported = data.imported || {};
    showToast(`${imported.livesCreated || 0} nova(s) vida(s) e ${imported.livesUpdated || 0} atualizada(s) em ${data.company?.name || 'empresa'}.`);
    state.month = 'all';
    await loadCommissions();
    if (data.company?.id && state.companies.some(item => item.id === data.company.id)) {
      openCommissionDetail(data.company.id);
    }
  }

  function commissionFormPayload() {
    return {
      name: byId('commissionsFormName').value.trim(),
      client_type: byId('commissionsFormType').value,
      cnpj: byId('commissionsFormCnpj').value.trim(),
      contact_name: byId('commissionsFormContact').value.trim(),
      phone: byId('commissionsFormPhone').value.trim(),
      email: byId('commissionsFormEmail').value.trim(),
      plan: byId('commissionsFormPlan').value.trim(),
      seller: byId('commissionsFormSeller').value.trim(),
      value_per_life: byId('commissionsFormValue').value,
      initial_lives: byId('commissionsFormLives').value,
      contract_start: byId('commissionsFormStart').value,
      status: byId('commissionsFormStatus').value,
      notes: byId('commissionsFormNotes').value.trim(),
    };
  }

  function updateCompanyPreview() {
    const lives = Number(byId('commissionsFormLives').value) || 0;
    const value = Number(byId('commissionsFormValue').value) || 0;
    const revenue = lives * value;
    byId('commissionsFormPreview').innerHTML = `Receita inicial: <strong>${money(revenue)}</strong> · Comissão (${Math.round((state.rate || 0.4) * 100)}%): <span class="big">${money(revenue * (state.rate || 0.4))}</span>`;
  }

  function openCompanyDialog(company) {
    state.editingId = company?.id || null;
    byId('commissionsCompanyTitle').textContent = company ? 'Editar contrato' : 'Novo contrato';
    byId('commissionsFormName').value = company?.name || '';
    byId('commissionsFormType').value = company?.clientType || 'Empresa';
    byId('commissionsFormCnpj').value = company?.cnpj || '';
    byId('commissionsFormContact').value = company?.contactName || '';
    byId('commissionsFormPhone').value = company?.phone || '';
    byId('commissionsFormEmail').value = company?.email || '';
    byId('commissionsFormPlan').value = company?.plan || '';
    byId('commissionsFormSeller').value = company?.seller || state.sellerName;
    byId('commissionsFormSeller').readOnly = !state.canManage;
    byId('commissionsFormValue').value = company?.valuePerLife || '';
    byId('commissionsFormLives').value = company?.initialLives || '';
    byId('commissionsFormStart').value = company?.contractStart || '';
    byId('commissionsFormStatus').value = company?.status || 'ativo';
    byId('commissionsFormNotes').value = company?.notes || '';
    byId('commissionsCompanySubmit').textContent = company ? 'Salvar contrato' : 'Cadastrar contrato';
    updateCompanyPreview();
    const dialog = byId('commissionsCompanyDialog');
    if (!dialog.open) dialog.showModal();
    byId('commissionsFormName').focus();
  }

  async function saveCompany(event) {
    event.preventDefault();
    const payload = commissionFormPayload();
    if (!payload.name) return;
    try {
      if (state.editingId) {
        await window.PortalAccess.api(`/api/commissions/companies/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Contrato atualizado.');
      } else {
        await window.PortalAccess.api('/api/commissions/companies', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Contrato cadastrado.');
      }
      byId('commissionsCompanyDialog').close();
      state.editingId = null;
      await loadCommissions();
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function deleteCompany(company) {
    if (!company) return;
    if (!window.confirm(`Excluir o contrato de "${company.name}"? As vidas e movimentações vinculadas também serão removidas.`)) return;
    try {
      await window.PortalAccess.api(`/api/commissions/companies/${encodeURIComponent(company.id)}`, { method: 'DELETE' });
      if (state.detailCompanyId === company.id) {
        byId('commissionsDetailDialog').close();
      }
      await loadCommissions();
      showToast('Contrato excluído.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function updateMovementPreview() {
    const lives = Number(byId('commissionsMovementLives').value) || 0;
    const value = Number(byId('commissionsMovementValue').value) || 0;
    const revenue = lives * value;
    byId('commissionsMovementPreview').innerHTML = `Receita da movimentação: <strong>${money(revenue)}</strong> · Comissão (${Math.round((state.rate || 0.4) * 100)}%): <span class="big">${money(revenue * (state.rate || 0.4))}</span>`;
  }

  function openMovementDialog(company, movement) {
    state.movement = movement || null;
    state.movementCompanyId = company.id;
    byId('commissionsMovementTitle').textContent = movement ? 'Editar movimentação' : 'Lançar movimentação';
    byId('commissionsMovementCompany').textContent = `${company.name} · ${company.seller || 'sem vendedor'}`;
    byId('commissionsMovementMonth').value = String(movement?.monthNumber || 1);
    byId('commissionsMovementLives').value = movement?.livesAdded ?? '';
    byId('commissionsMovementValue').value = movement?.valuePerLife ?? (company.valuePerLife || '');
    byId('commissionsMovementNote').value = movement?.note || '';
    byId('commissionsMovementSubmit').textContent = movement ? 'Salvar movimentação' : 'Lançar movimentação';
    updateMovementPreview();
    const dialog = byId('commissionsMovementDialog');
    if (!dialog.open) dialog.showModal();
    byId('commissionsMovementLives').focus();
  }

  async function saveMovement(event) {
    event.preventDefault();
    if (!state.movementCompanyId) return;
    const payload = {
      monthNumber: Number(byId('commissionsMovementMonth').value) || 1,
      livesAdded: Number(byId('commissionsMovementLives').value) || 0,
      valuePerLife: byId('commissionsMovementValue').value,
      note: byId('commissionsMovementNote').value.trim(),
    };
    try {
      if (state.movement) {
        await window.PortalAccess.api(`/api/commissions/movements/${encodeURIComponent(state.movement.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showToast('Movimentação atualizada.');
      } else {
        await window.PortalAccess.api(`/api/commissions/companies/${encodeURIComponent(state.movementCompanyId)}/movements`, { method: 'POST', body: JSON.stringify(payload) });
        showToast('Movimentação lançada.');
      }
      byId('commissionsMovementDialog').close();
      state.movement = null;
      state.movementCompanyId = null;
      await loadCommissions();
      await refreshCommissionDetail();
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function deleteMovement(movement, company) {
    if (!movement) return;
    if (!window.confirm(`Excluir a movimentação do ${monthLabel(movement.monthNumber)} de "${company.name}"?`)) return;
    try {
      await window.PortalAccess.api(`/api/commissions/movements/${encodeURIComponent(movement.id)}`, { method: 'DELETE' });
      await loadCommissions();
      await refreshCommissionDetail();
      showToast('Movimentação excluída.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  async function exportCommissions() {
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/commissions/export`, { headers: window.PortalAccess.authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Não foi possível exportar.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'comissoes.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast('Exportação pronta.');
    } catch (error) {
      if (error.message !== 'auth') showToast(error.message, 'warning');
    }
  }

  function bindCommissions() {
    byId('commissionsNewButton')?.addEventListener('click', () => openCompanyDialog(null));
    byId('commissionsEmptyNew')?.addEventListener('click', () => openCompanyDialog(null));
    byId('commissionsImportButton')?.addEventListener('click', () => {
      window.PortalContractImport?.open({ prefix: '/api/commissions', after: afterCommissionImport });
    });
    byId('commissionsRefreshButton')?.addEventListener('click', loadCommissions);
    byId('commissionsExportButton')?.addEventListener('click', exportCommissions);
    byId('commissionsSearch')?.addEventListener('input', event => { state.search = event.target.value; renderList(); });
    byId('commissionsSearchClear')?.addEventListener('click', () => {
      state.search = '';
      byId('commissionsSearch').value = '';
      renderList();
      byId('commissionsSearch').focus();
    });
    byId('commissionsSellerFilter')?.addEventListener('change', event => { state.seller = event.target.value; renderList(); });
    byId('commissionsStatusFilter')?.addEventListener('change', event => { state.status = event.target.value; renderList(); });
    byId('commissionsRegistrationFilter')?.addEventListener('change', event => { state.registration = event.target.value; renderList(); });
    byId('commissionsMonthFilter')?.addEventListener('change', event => { state.month = event.target.value; renderList(); });
    byId('commissionsSort')?.addEventListener('change', event => { state.sort = event.target.value; renderList(); });

    byId('commissionsList')?.addEventListener('click', event => {
      const card = event.target.closest('[data-commission-id]');
      if (card) openCommissionDetail(card.dataset.commissionId);
    });
    byId('commissionsList')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-commission-id]');
      if (!card) return;
      event.preventDefault();
      openCommissionDetail(card.dataset.commissionId);
    });

    byId('commissionsDetailClose')?.addEventListener('click', () => byId('commissionsDetailDialog').close());
    byId('commissionsDetailEdit')?.addEventListener('click', () => {
      const company = state.detail;
      if (!company) return;
      byId('commissionsDetailDialog').close();
      openCompanyDialog(company);
    });
    byId('commissionsDetailAddMovement')?.addEventListener('click', () => {
      if (state.detail) openMovementDialog(state.detail, null);
    });
    byId('commissionsDetailDelete')?.addEventListener('click', () => {
      if (state.detail) deleteCompany(state.detail);
    });
    byId('commissionsDetailMovements')?.addEventListener('click', event => {
      if (!state.detail) return;
      const edit = event.target.closest('[data-mov-edit]');
      const remove = event.target.closest('[data-mov-delete]');
      const id = edit ? edit.dataset.movEdit : remove ? remove.dataset.movDelete : null;
      if (!id) return;
      const movement = (state.detail.movements || []).find(item => item.id === id);
      if (edit && movement) openMovementDialog(state.detail, movement);
      if (remove && movement) deleteMovement(movement, state.detail);
    });
    byId('commissionsAddLife')?.addEventListener('click', () => openCommissionsLifeDialog(null));
    byId('commissionsLifeSearch')?.addEventListener('input', event => {
      state.detailSearch = event.target.value;
      renderCommissionLives();
    });
    byId('commissionsCpfToggle')?.addEventListener('click', () => {
      state.detailCpf = !state.detailCpf;
      renderCommissionLives();
    });
    byId('commissionsLivesBody')?.addEventListener('click', event => {
      const edit = event.target.closest('[data-commission-life-edit]');
      const remove = event.target.closest('[data-commission-life-delete]');
      if (edit) {
        const life = state.detailLives.find(item => item.id === edit.dataset.commissionLifeEdit);
        if (life) openCommissionsLifeDialog(life);
      }
      if (remove) deleteCommissionsLife(remove.dataset.commissionLifeDelete);
    });
    byId('commissionsDetailDialog')?.addEventListener('close', () => {
      state.detailCompanyId = null;
      state.detail = null;
      state.detailLives = [];
      state.detailSearch = '';
      state.editingLife = null;
    });
    byId('commissionsLifeClose')?.addEventListener('click', () => byId('commissionsLifeDialog').close());
    byId('commissionsLifeCancel')?.addEventListener('click', () => byId('commissionsLifeDialog').close());
    byId('commissionsLifeForm')?.addEventListener('submit', saveCommissionsLife);

    byId('commissionsCompanyClose')?.addEventListener('click', () => byId('commissionsCompanyDialog').close());
    byId('commissionsCompanyCancel')?.addEventListener('click', () => byId('commissionsCompanyDialog').close());
    byId('commissionsCompanyForm')?.addEventListener('submit', saveCompany);
    byId('commissionsFormValue')?.addEventListener('input', updateCompanyPreview);
    byId('commissionsFormLives')?.addEventListener('input', updateCompanyPreview);
    byId('commissionsMovementClose')?.addEventListener('click', () => byId('commissionsMovementDialog').close());
    byId('commissionsMovementCancel')?.addEventListener('click', () => byId('commissionsMovementDialog').close());
    byId('commissionsMovementForm')?.addEventListener('submit', saveMovement);
    byId('commissionsMovementLives')?.addEventListener('input', updateMovementPreview);
    byId('commissionsMovementValue')?.addEventListener('input', updateMovementPreview);
  }

  bindCommissions();

  const screen = byId('commissionsScreen');
  if (screen) {
    new MutationObserver(() => {
      if (!screen.classList.contains('hidden')) loadCommissions();
    }).observe(screen, { attributes: true, attributeFilter: ['class'] });
  }
  window.enterCommissionsScreen = loadCommissions;
})();

// ── Sidebar (menu abre/fecha) ────────────────────────────────
(function () {
  const KEY = 'portal-sidebar-v1';
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  const fab = document.getElementById('sidebarFab');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar) return;

  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  if (localStorage.getItem(KEY) === 'collapsed') sidebar.classList.add('collapsed');

  function setMobileOpen(open) {
    sidebar.classList.toggle('open', open);
    if (backdrop) backdrop.hidden = !open;
    fab?.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sidebar-open', open);
  }

  toggle?.addEventListener('click', () => {
    if (isMobile()) { setMobileOpen(false); return; }
    sidebar.classList.toggle('collapsed');
    localStorage.setItem(KEY, sidebar.classList.contains('collapsed') ? 'collapsed' : 'open');
  });

  fab?.addEventListener('click', () => setMobileOpen(!sidebar.classList.contains('open')));
  backdrop?.addEventListener('click', () => setMobileOpen(false));
  document.querySelector('.sidebar-nav')?.addEventListener('click', event => {
    if (isMobile() && event.target.closest('.nav-button')) setMobileOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) setMobileOpen(false);
  });
  window.addEventListener('resize', () => { if (!isMobile()) setMobileOpen(false); });

  // avatar com a inicial do usuário logado
  const avatar = document.getElementById('sessionAvatar');
  if (avatar) {
    const update = () => {
      const nome = document.getElementById('sessionName')?.textContent?.trim();
      avatar.textContent = nome ? nome.charAt(0).toUpperCase() : '?';
    };
    new MutationObserver(update).observe(document.getElementById('sessionName') || document.body, { childList: true, characterData: true, subtree: true });
    [300, 800, 1600, 3000].forEach(delay => setTimeout(update, delay));
    update();
  }
})();

// ── Painel da Gestão + aba Relatórios ────────────────────────
(function () {
  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  async function carregarPainel() {
    const apiFn = window.PortalAccess?.api;
    if (!apiFn || window.PortalAccess?.canSee?.('managementScreen') !== true) return;
    try {
      const data = await apiFn('/api/team/pulse');
      const resumo = document.getElementById('mgmtSummary');
      const lista = document.getElementById('mgmtPeople');
      const chartEl = document.getElementById('mgmtChart');
      if (!resumo || !lista) return;

      const total = data.members.reduce((sum, m) => sum + m.total, 0);
      const done = data.members.reduce((sum, m) => sum + m.done, 0);
      const overdue = data.members.reduce((sum, m) => sum + m.overdue, 0);
      const semDono = data.unassigned;
      resumo.innerHTML = `
        <article class="stat-card teal"><span>Na equipe</span><strong>${data.members.length}</strong><small>pessoas com acesso</small></article>
        <article class="stat-card"><span>Demandas ativas</span><strong>${total - done}</strong><small>${done} concluídas até agora</small></article>
        <article class="stat-card ${overdue ? 'alert-card' : ''}"><span>Atrasadas</span><strong>${overdue}</strong><small>passaram do prazo</small></article>
        <article class="stat-card"><span>Sem responsável</span><strong>${semDono}</strong><small>precisam ser atribuídas</small></article>`;

      lista.innerHTML = data.members.map(m => {
        const carga = m.total ? Math.round(m.done / m.total * 100) : 0;
        const alerta = m.overdue > 0 ? 'admin-item-alert' : '';
        return `<article class="admin-item ${alerta}">
          <div>
            <strong>${escapeHtml(m.name)}${m.role === 'admin' ? ' · gestor' : ''}</strong>
            <small>${m.total} demandas · ${m.done} concluídas · ${m.progress} em andamento · ${m.todo} pendentes${m.overdue ? ` · ⚠ ${m.overdue} atrasadas` : ''}</small>
            <small>No portal pela última vez: ${fmtDate(m.lastLogin)}</small>
            <div class="carga-bar"><i style="width:${carga}%"></i></div>
          </div>
          <span class="muted-tag">${m.total ? carga + '%' : 'sem demandas'}</span>
        </article>`;
      }).join('') || '<p class="empty-state">Ninguém na equipe ainda.</p>';

      if (chartEl && typeof chart === 'function') {
        chart('#mgmtChart', data.members.map(m => ({ label: m.name.split(' ')[0], value: m.total })),
          data.members.map((_, i) => ['#0b8f87', '#3d72b8', '#c88921', '#d94c52', '#89969d'][i % 5]));
      }
    } catch (error) {
      if (error.message !== 'auth' && typeof showToast === 'function') showToast(error.message || 'Erro ao carregar painel', 'error');
    }
  }

  document.getElementById('mgmtRefresh')?.addEventListener('click', carregarPainel);
  window.refreshManagement = carregarPainel;
  const mgmtScreen = document.getElementById('managementScreen');
  if (mgmtScreen) {
    new MutationObserver(() => { if (!mgmtScreen.classList.contains('hidden')) setTimeout(carregarPainel, 120); })
      .observe(mgmtScreen, { attributes: true, attributeFilter: ['class'] });
  }
  // primeira carga quando a sessão existir
  const tryBoot = setInterval(() => {
    if (window.PortalAccess?.Access?.user) { clearInterval(tryBoot); setTimeout(carregarPainel, 300); }
  }, 500);
  setTimeout(() => clearInterval(tryBoot), 15000);

  document.getElementById('reportPreset')?.addEventListener('change', event => {
    const value = event.target.value;
    if (!value) { document.querySelectorAll('[data-report-range]').forEach(button => button.classList.remove('active')); renderReports(); return; }
    setReportPreset(value);
  });
})();


// ═══════════════════════════════════════════════════════════════════════════
// ANIVERSARIANTES — tela compartilhada do time
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  let items = [];
  let filter = 'upcoming';
  let term = '';

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0).toUpperCase()).join('');
  }

  function dateLabel(item) {
    const d = new Date(`${item.nextDate}T12:00:00`);
    return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  }

  function countdown(item) {
    if (item.daysUntil === 0) return 'É hoje';
    if (item.daysUntil === 1) return 'Amanhã';
    return `Em ${item.daysUntil} dias`;
  }

  function avatar(item, className) {
    const photo = item.photo || item.profilePhoto;
    if (photo) {
      return `<span class="${className} bd-photo-avatar"><img src="${escapeHtml(photo)}" alt="${escapeHtml(item.name)}"></span>`;
    }
    return `<span class="${className}">${escapeHtml(initials(item.name))}</span>`;
  }

  function groupByDate(list) {
    const map = new Map();
    list.forEach(item => {
      const key = `${item.month}-${item.day}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          month: item.month,
          day: item.day,
          nextDate: item.nextDate,
          weekday: item.weekday,
          daysUntil: item.daysUntil,
          people: [],
        });
      }
      map.get(key).people.push(item);
    });
    return [...map.values()].sort((a, b) => a.daysUntil - b.daysUntil || a.month - b.month || a.day - b.day);
  }

  function groupCard(group) {
    const today = group.daysUntil === 0;
    const people = group.people;
    const metaBits = [...new Set(people.map(item => item.kind === 'partner' ? item.note : item.sector).filter(Boolean))];
    const lines = people.map((item, index) => {
      const tag = item.kind === 'partner' ? '<span class="bd-kind">Parceiro</span>' : '';
      const age = item.age ? `<span class="bd-age">${item.age} anos</span>` : '';
      const pill = index === 0 && group.daysUntil <= 7 ? `<span class="bd-pill${today ? ' bd-pill-today' : ''}">${countdown(group)}</span>` : '';
      return `<div class="bd-card-title"><strong>${escapeHtml(item.name)}</strong>${tag}${age}${pill}</div>`;
    }).join('');
    return `
      <article class="bd-card${today ? ' is-today' : ''}${people.length > 1 ? ' bd-card-group' : ''}">
        <div class="bd-avatar-stack">${people.map(item => avatar(item, 'bd-avatar')).join('')}</div>
        <div class="bd-card-copy">
          ${lines}
          <p class="bd-card-date">${escapeHtml(dateLabel(group))}</p>
          ${metaBits.length ? `<p class="bd-card-meta">${escapeHtml(metaBits.join(' · '))}</p>` : ''}
        </div>
        <div class="bd-card-day"><strong>${String(group.day).padStart(2, '0')}</strong><span>${MONTHS[group.month - 1].slice(0, 3)}</span></div>
      </article>`;
  }

  function filteredGroups() {
    let list = items.slice();
    if (filter === 'month') {
      const month = new Date().getMonth() + 1;
      list = list.filter(item => item.month === month);
    }
    if (term) {
      list = list.filter(item => item.name.toLowerCase().includes(term) || (item.sector || '').toLowerCase().includes(term) || (item.note || '').toLowerCase().includes(term));
    }
    return groupByDate(list);
  }

  function namesLabel(people) {
    const names = people.map(item => item.name);
    if (names.length <= 1) return names[0] || '';
    return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
  }

  function render() {
    const host = document.getElementById('bdMonths');
    if (!host) return;
    const month = new Date().getMonth() + 1;
    const groups = groupByDate(items);
    const inMonth = items.filter(item => item.month === month);
    const next30 = items.filter(item => item.daysUntil <= 30);
    const soonest = groups[0];

    const todayLabel = document.getElementById('bdTodayLabel');
    if (todayLabel) todayLabel.textContent = `Hoje, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}`;
    const totalLabel = document.getElementById('bdTotalLabel');
    if (totalLabel) totalLabel.textContent = `${items.length} ${items.length === 1 ? 'pessoa' : 'pessoas'} · ${groups.length} ${groups.length === 1 ? 'data' : 'datas'}`;

    const nextCard = document.getElementById('bdNextCard');
    if (nextCard) {
      nextCard.innerHTML = soonest ? `
        <span class="bd-next-eyebrow">${soonest.daysUntil === 0 ? 'Hoje é dia de festa' : soonest.people.length > 1 ? `${soonest.people.length} pessoas nesta data` : 'Próximo a celebrar'}</span>
        <div class="bd-next-main">
          <div class="bd-next-avatars">${soonest.people.slice(0, 4).map(item => avatar(item, 'bd-next-avatar')).join('')}</div>
          <div>
            <strong>${escapeHtml(namesLabel(soonest.people))}</strong>
            <p>${escapeHtml(dateLabel(soonest))}</p>
          </div>
        </div>
        <div class="bd-next-foot">
          <span class="bd-next-day">${String(soonest.day).padStart(2, '0')}<small>/${String(soonest.month).padStart(2, '0')}</small></span>
          <span class="bd-next-count">${countdown(soonest)}${soonest.people.length > 1 ? ` · ${soonest.people.length} pessoas` : soonest.people[0].age ? ` · ${soonest.people[0].age} anos` : ''}</span>
        </div>` : '<span class="bd-next-eyebrow">Ainda sem datas</span><p class="bd-next-empty">Quando o administrador cadastrar os aniversários, o próximo aparece aqui.</p>';
    }

    const kpis = [
      { label: 'Neste mês', value: inMonth.length, icon: '✦' },
      { label: 'Próximos 30 dias', value: next30.length, icon: '◷' },
      { label: 'Total cadastrado', value: items.length, icon: '☺' },
    ];
    const kpiHost = document.getElementById('bdKpis');
    if (kpiHost) kpiHost.innerHTML = kpis.map(kpi => `<article class="bd-kpi"><span>${kpi.icon}</span><strong>${kpi.value}</strong><p>${kpi.label}</p></article>`).join('');

    const list = filteredGroups();
    const empty = document.getElementById('bdEmpty');
    if (empty) empty.classList.toggle('hidden', list.length > 0);
    if (!list.length) { host.innerHTML = ''; return; }

    if (filter === 'all') {
      host.innerHTML = MONTHS.map((name, index) => {
        const monthGroups = list.filter(group => group.month === index + 1);
        if (!monthGroups.length) return '';
        const count = monthGroups.reduce((total, group) => total + group.people.length, 0);
        return `<section class="bd-month-group"><header><h3>${name}</h3><span>${count} aniversariante${count > 1 ? 's' : ''}</span></header><div class="bd-cards">${monthGroups.map(groupCard).join('')}</div></section>`;
      }).join('');
    } else {
      host.innerHTML = `<div class="bd-cards">${list.map(groupCard).join('')}</div>`;
    }
  }

  async function loadBirthdays() {
    if (!window.PortalAccess?.Access?.token) return;
    try {
      const data = await window.PortalAccess.api('/api/birthdays');
      items = data.birthdays || [];
      render();
    } catch (error) {
      console.warn('Aniversariantes: falha ao carregar', error);
    }
  }

  const screen = document.getElementById('birthdaysScreen');
  if (screen) {
    const observer = new MutationObserver(() => { if (!screen.classList.contains('hidden')) loadBirthdays(); });
    observer.observe(screen, { attributes: true, attributeFilter: ['class'] });
  }

  document.getElementById('bdFilters')?.addEventListener('click', event => {
    const button = event.target.closest('[data-bd-filter]');
    if (!button) return;
    filter = button.dataset.bdFilter;
    document.querySelectorAll('[data-bd-filter]').forEach(item => item.classList.toggle('active', item === button));
    render();
  });

  document.getElementById('bdSearch')?.addEventListener('input', event => {
    term = event.target.value.trim().toLowerCase();
    render();
  });

  const boot = setInterval(() => {
    if (window.PortalAccess?.Access?.token) {
      clearInterval(boot);
      loadBirthdays();
    }
  }, 900);
  setTimeout(() => clearInterval(boot), 20000);

  window.loadBirthdays = loadBirthdays;
})();


// ═══════════════════════════════════════════════════════════════════════════
// COMUNICADOS & EVENTOS — sistema de avisos com intro cinematográfico
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const ANN_SEEN_KEY = 'portal-announcements-seen-ids-v1';
  let announcements = [];
  let annCurrent = 0;
  let annEditingId = null;
  let autoTimer = null;
  let announcementsLoadPromise = null;
  let autoOpenTimer = null;

  // ── tipos de comunicado ──────────────────────────────────────────────────
  const ANN_ICONS = { event: '📅', birthday: '🎂', notice: '📢', congrats: '🏆' };
  const ANN_LABELS = { event: 'Evento', birthday: 'Aniversariante', notice: 'Aviso', congrats: 'Parabéns' };

  // Datas passadas não entram no carrossel: o aviso deixa de ser "de hoje".
  function annTodayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function isCurrentAnnouncement(ann) {
    if (!ann || ann.active === false) return false;
    return !ann.date || ann.date >= annTodayIso();
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  function fmtAnnDate(d) {
    if (!d) return '';
    return new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
  }

  // ── renderiza os slides no modal ──────────────────────────────────────────
  function renderSlides() {
    const active = announcements.filter(isCurrentAnnouncement);
    const container = document.getElementById('annSlides');
    const dots = document.getElementById('annDots');
    if (!container || !dots) return;

    container.innerHTML = active.map((ann, i) => `
      <div class="ann-slide ${i === 0 ? 'ann-slide-active' : ''}" data-ann-index="${i}" style="--ann-color:${ann.color || '#0b8f87'}">
        ${ann.imageData
          ? `<button class="ann-slide-img" type="button" data-ann-zoom="${i}" aria-label="Ampliar imagem de ${escapeHtml(ann.title)}">
               <img src="${ann.imageData}" alt="${escapeHtml(ann.title)}">
               <span class="ann-zoom-hint">⤢ Ampliar</span>
             </button>`
          : `<div class="ann-slide-icon">${ANN_ICONS[ann.type] || '📢'}</div>`}
        <div class="ann-slide-body">
          <div class="ann-meta">
            <span class="ann-badge">${ANN_LABELS[ann.type] || 'Aviso'}</span>
            ${ann.date ? `<span class="ann-date">${fmtAnnDate(ann.date)}</span>` : ''}
          </div>
          <h2 class="ann-title">${escapeHtml(ann.title)}</h2>
          ${ann.description ? `<p class="ann-desc">${escapeHtml(ann.description).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
      </div>
    `).join('');

    dots.innerHTML = active.map((_, i) => `<button class="ann-dot ${i === 0 ? 'active' : ''}" data-ann-dot="${i}" type="button" aria-label="Slide ${i + 1}"></button>`).join('');
    annCurrent = 0;
  }

  function seenIds() {
    try { return JSON.parse(localStorage.getItem(ANN_SEEN_KEY) || '[]'); } catch { return []; }
  }
  function markSeen(ids) {
    localStorage.setItem(ANN_SEEN_KEY, JSON.stringify([...new Set([...seenIds(), ...ids])]));
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  function startAuto() {
    stopAuto();
    const active = announcements.filter(isCurrentAnnouncement);
    if (active.length < 2) return;
    autoTimer = setInterval(() => {
      const last = announcements.filter(isCurrentAnnouncement).length - 1;
      if (annCurrent >= last) stopAuto();
      else goToSlide(annCurrent + 1);
    }, 5200);
  }

  function goToSlide(index) {
    const active = announcements.filter(isCurrentAnnouncement);
    if (!active.length) return;
    annCurrent = Math.max(0, Math.min(index, active.length - 1));
    document.querySelectorAll('.ann-slide').forEach((s, i) => {
      s.classList.toggle('ann-slide-active', i === annCurrent);
      s.classList.toggle('ann-slide-exit', i < annCurrent);
    });
    document.querySelectorAll('.ann-dot').forEach((d, i) => d.classList.toggle('active', i === annCurrent));
    const prevBtn = document.getElementById('annPrev');
    const nextBtn = document.getElementById('annNext');
    const nav = document.querySelector('.ann-nav');
    if (nav) nav.style.display = active.length > 1 ? 'flex' : 'none';
    if (prevBtn) prevBtn.style.visibility = annCurrent === 0 ? 'hidden' : 'visible';
    if (nextBtn) nextBtn.style.visibility = annCurrent === active.length - 1 ? 'hidden' : 'visible';

    const progress = document.querySelector('.ann-progress');
    const bar = progress?.querySelector('i');
    const stage = document.querySelector('.ann-stage');
    if (stage) stage.style.setProperty('--ann-color', active[annCurrent].color || '#0b8f87');
    if (progress) progress.style.display = active.length > 1 ? 'block' : 'none';
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width = '0%';
      if (active.length > 1 && annCurrent < active.length - 1) {
        requestAnimationFrame(() => {
          bar.style.transition = 'width 5.2s linear';
          bar.style.width = '100%';
        });
      }
    }
  }

  // ── visualizador de imagem (tela cheia) ──────────────────────────────────
  function openImageViewer(src, alt) {
    const box = document.getElementById('annLightbox');
    const img = document.getElementById('annLightboxImg');
    if (!box || !img || !src) return;
    img.src = src;
    img.alt = alt || '';
    box.classList.remove('hidden');
    requestAnimationFrame(() => box.classList.add('ann-visible'));
  }

  function closeImageViewer() {
    const box = document.getElementById('annLightbox');
    if (!box || box.classList.contains('hidden')) return;
    box.classList.remove('ann-visible');
    setTimeout(() => {
      box.classList.add('hidden');
      const img = document.getElementById('annLightboxImg');
      if (img) img.src = '';
    }, 220);
  }

  function isImageViewerOpen() {
    const box = document.getElementById('annLightbox');
    return !!box && !box.classList.contains('hidden');
  }

  // ── abre o overlay cinematográfico ───────────────────────────────────────
  function openAnnouncements(force = false) {
    const active = announcements.filter(isCurrentAnnouncement);
    if (!active.length) {
      if (force) showToast('Nenhum comunicado ativo no momento.', 'info');
      return;
    }
    renderSlides();
    const overlay = document.getElementById('announcementOverlay');
    if (!overlay) return;
    if (!overlay.classList.contains('hidden') && !force) return;
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      overlay.classList.add('ann-visible');
      goToSlide(0);
      startAuto();
    });
    markSeen(active.map(a => a.id));
    const fab = document.getElementById('annReopenBtn');
    if (fab) fab.classList.add('hidden');
  }

  function closeAnnouncements() {
    stopAuto();
    const overlay = document.getElementById('announcementOverlay');
    if (!overlay) return;
    overlay.classList.remove('ann-visible');
    setTimeout(() => { overlay.classList.add('hidden'); }, 480);
    const fab = document.getElementById('annReopenBtn');
    if (fab && announcements.some(isCurrentAnnouncement)) fab.classList.remove('hidden');
  }

  // ── busca comunicados do servidor ─────────────────────────────────────────
  async function loadAnnouncements() {
    if (!window.PortalAccess?.Access?.token) return;
    if (announcementsLoadPromise) return announcementsLoadPromise;
    announcementsLoadPromise = (async () => {
      try {
        const data = await window.PortalAccess.api('/api/announcements');
        announcements = data.announcements || [];
        window.__portalAnnouncements = announcements;
        renderAdminList();
        window.PortalAccess?.renderAdminDashboard?.();
        const active = announcements.filter(isCurrentAnnouncement);
        const unseen = active.filter(a => !seenIds().includes(a.id));
        if (unseen.length) {
          if (autoOpenTimer) clearTimeout(autoOpenTimer);
          autoOpenTimer = setTimeout(() => {
            autoOpenTimer = null;
            openAnnouncements();
          }, 700);
        } else if (active.length) {
          const fab = document.getElementById('annReopenBtn');
          if (fab) fab.classList.remove('hidden');
        }
      } catch (e) {
        console.warn('Comunicados: falha ao carregar', e);
      }
    })();
    try {
      await announcementsLoadPromise;
    } finally {
      announcementsLoadPromise = null;
    }
  }

  // ── renderiza lista no Admin ──────────────────────────────────────────────
  function renderAdminList() {
    const list = document.getElementById('announcementsList');
    if (!list) return;
    const user = window.PortalAccess?.Access?.user;
    if (user?.role !== 'admin') {
      const section = document.getElementById('announcementsAdminSection');
      if (section) section.classList.add('hidden');
      return;
    }
    if (!announcements.length) {
      list.innerHTML = '<p class="empty-state">Nenhum comunicado ainda. Crie o primeiro!</p>';
      return;
    }
    list.innerHTML = announcements.map(ann => `
      <div class="admin-item adm-ann" style="--ann-accent:${ann.color || '#0b8f87'}">
        <span class="adm-ann-swatch" aria-hidden="true"></span>
        <div class="adm-item-copy">
          <div class="adm-person-title">
            <strong>${escapeHtml(ann.title)}</strong>
            ${ann.autoDraft && !ann.active
              ? '<span class="adm-chip-sm is-muted">rascunho</span>'
              : `<span class="adm-chip-sm${ann.active ? '' : ' is-muted'}">${ann.active ? 'ativo' : 'inativo'}</span>`}
          </div>
          <small>${ANN_LABELS[ann.type] || 'Aviso'}${ann.date ? ' · ' + fmtAnnDate(ann.date) : ''}</small>
          ${ann.description ? `<small class="adm-ann-desc">${escapeHtml(ann.description).slice(0, 90)}${ann.description.length > 90 ? '…' : ''}</small>` : ''}
        </div>
        <div class="ann-admin-actions adm-actions">
          <button class="adm-btn" type="button" data-ann-toggle="${ann.id}">${ann.active ? 'Recolher' : 'Publicar'}</button>
          <button class="adm-icon-btn" type="button" data-ann-preview="${ann.id}" title="Pré-visualizar" aria-label="Pré-visualizar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg></button>
          <button class="adm-btn" type="button" data-ann-edit="${ann.id}">Editar</button>
          <button class="adm-icon-btn is-danger" type="button" data-ann-delete="${ann.id}" aria-label="Excluir" title="Excluir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/></svg></button>
        </div>
      </div>
    `).join('');
  }

  // ── editor (criar / editar) ───────────────────────────────────────────────
  function openEditor(ann = null) {
    annEditingId = ann?.id || null;
    const dialog = document.getElementById('annDialog');
    if (!dialog) return;
    document.getElementById('annDialogTitle').textContent = ann ? 'Editar comunicado' : 'Novo comunicado';
    document.getElementById('annTitle').value = ann?.title || '';
    document.getElementById('annDesc').value = ann?.description || '';
    document.getElementById('annDate').value = ann?.date || today();
    document.getElementById('annType').value = ann?.type || 'event';
    document.getElementById('annColor').value = ann?.color || '#0b8f87';
    document.getElementById('annActive').checked = ann?.active !== false;
    const preview = document.getElementById('annImagePreview');
    if (preview) {
      preview.src = ann?.imageData || '';
      preview.style.display = ann?.imageData ? 'block' : 'none';
    }
    dialog.showModal();
  }

  // ── salva (criar ou editar) ───────────────────────────────────────────────
  async function saveAnnouncement(imageData) {
    const title = document.getElementById('annTitle').value.trim();
    if (!title) { alert('Título obrigatório.'); return; }
    const body = {
      title,
      description: document.getElementById('annDesc').value.trim(),
      date: document.getElementById('annDate').value,
      type: document.getElementById('annType').value,
      color: document.getElementById('annColor').value,
      active: document.getElementById('annActive').checked,
      imageData: imageData !== undefined ? imageData : (document.getElementById('annImagePreview').src || null),
    };
    if (!body.imageData || body.imageData === window.location.href) body.imageData = null;
    try {
      if (annEditingId) {
        const res = await fetch(`/api/announcements/${annEditingId}`, {
          method: 'PUT', headers: window.PortalAccess.authHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao salvar');
        const data = await res.json();
        announcements = announcements.map(a => a.id === annEditingId ? data.announcement : a);
      } else {
        const res = await fetch('/api/announcements', {
          method: 'POST', headers: window.PortalAccess.authHeaders(), body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Erro ao criar');
        const data = await res.json();
        announcements.push(data.announcement);
      }
      showToast(annEditingId ? 'Comunicado atualizado!' : 'Comunicado criado!');
      document.getElementById('annDialog').close();
      window.__portalAnnouncements = announcements;
      renderAdminList();
      window.PortalAccess?.renderAdminDashboard?.();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  async function deleteAnnouncement(id) {
    const ann = announcements.find(a => a.id === id);
    if (!confirm(`Excluir o comunicado "${ann?.title}"?`)) return;
    try {
      const res = await fetch(`/api/announcements/${id}`, {
        method: 'DELETE', headers: window.PortalAccess.authHeaders(),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Erro ao excluir');
      announcements = announcements.filter(a => a.id !== id);
      window.__portalAnnouncements = announcements;
      showToast('Comunicado excluído.');
      renderAdminList();
      window.PortalAccess?.renderAdminDashboard?.();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── publica / recolhe um comunicado ───────────────────────────────────────
  async function toggleAnnouncement(id) {
    const ann = announcements.find(a => a.id === id);
    if (!ann) return;
    const publish = !ann.active;
    if (publish && !confirm(`Publicar "${ann.title}" para todo o time agora?`)) return;
    try {
      const res = await fetch(`/api/announcements/${id}`, {
        method: 'PUT', headers: window.PortalAccess.authHeaders(),
        body: JSON.stringify({ active: publish, autoDraft: false }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Erro ao publicar');
      const data = await res.json();
      announcements = announcements.map(a => a.id === id ? data.announcement : a);
      window.__portalAnnouncements = announcements;
      showToast(publish ? 'Comunicado publicado para o time.' : 'Comunicado recolhido.');
      renderAdminList();
      window.PortalAccess?.renderAdminDashboard?.();
    } catch (e) {
      alert(e.message);
    }
  }

  // ── wiring de eventos ──────────────────────────────────────────────────────
  document.getElementById('annClose')?.addEventListener('click', closeAnnouncements);
  document.getElementById('annDismiss')?.addEventListener('click', closeAnnouncements);
  document.getElementById('annReopenBtn')?.addEventListener('click', () => openAnnouncements(true));
  document.addEventListener('keydown', e => {
    if (isImageViewerOpen()) {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') closeImageViewer();
      return;
    }
    const overlay = document.getElementById('announcementOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeAnnouncements();
    if (e.key === 'ArrowRight') goToSlide(annCurrent + 1);
    if (e.key === 'ArrowLeft') goToSlide(annCurrent - 1);
  });

  // imagem em tela cheia
  document.getElementById('annSlides')?.addEventListener('click', e => {
    const zoom = e.target.closest('[data-ann-zoom]');
    if (!zoom) return;
    const img = zoom.querySelector('img');
    if (img) openImageViewer(img.src, img.alt);
  });
  document.getElementById('annLightbox')?.addEventListener('click', closeImageViewer);
  document.getElementById('annLightboxClose')?.addEventListener('click', e => { e.stopPropagation(); closeImageViewer(); });
  document.getElementById('annPrev')?.addEventListener('click', () => goToSlide(annCurrent - 1));
  document.getElementById('annNext')?.addEventListener('click', () => goToSlide(annCurrent + 1));
  document.getElementById('annDots')?.addEventListener('click', e => {
    const dot = e.target.closest('[data-ann-dot]');
    if (dot) goToSlide(Number(dot.dataset.annDot));
  });

  // swipe no mobile
  let touchStartX = 0;
  document.getElementById('annSlides')?.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  document.getElementById('annSlides')?.addEventListener('touchend', e => {
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) goToSlide(annCurrent + (diff > 0 ? 1 : -1));
  });

  // fechar ao clicar fora
  document.getElementById('announcementOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('announcementOverlay')) closeAnnouncements();
  });

  // botão "Novo comunicado" no admin
  document.getElementById('newAnnouncementBtn')?.addEventListener('click', () => openEditor());
  document.getElementById('annCancelBtn')?.addEventListener('click', () => document.getElementById('annDialog')?.close());

  // lista admin — editar / excluir / preview
  document.getElementById('announcementsList')?.addEventListener('click', e => {
    const toggleBtn = e.target.closest('[data-ann-toggle]');
    const editBtn = e.target.closest('[data-ann-edit]');
    const delBtn = e.target.closest('[data-ann-delete]');
    const previewBtn = e.target.closest('[data-ann-preview]');
    if (toggleBtn) { toggleAnnouncement(toggleBtn.dataset.annToggle); return; }
    if (editBtn) { const ann = announcements.find(a => a.id === editBtn.dataset.annEdit); openEditor(ann); }
    if (delBtn) deleteAnnouncement(delBtn.dataset.annDelete);
    if (previewBtn) {
      const prev = announcements.filter(a => a.active);
      const idx = prev.findIndex(a => a.id === previewBtn.dataset.annPreview);
      openAnnouncements();
      if (idx >= 0) setTimeout(() => goToSlide(idx), 500);
    }
  });

  // form submit com imagem
  document.getElementById('annForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fileInput = document.getElementById('annImageFile');
    const file = fileInput?.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) { alert('Imagem maior que 2 MB. Use uma imagem menor.'); return; }
      const reader = new FileReader();
      reader.onload = async () => { await saveAnnouncement(reader.result); fileInput.value = ''; };
      reader.readAsDataURL(file);
    } else {
      const preview = document.getElementById('annImagePreview');
      await saveAnnouncement(preview?.src && preview.style.display !== 'none' ? preview.src : null);
    }
  });

  // preview imagem ao selecionar
  document.getElementById('annImageFile')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = document.getElementById('annImagePreview');
    const reader = new FileReader();
    reader.onload = () => { preview.src = reader.result; preview.style.display = 'block'; };
    reader.readAsDataURL(file);
  });

  // carrega após login
  const bootInterval = setInterval(() => {
    if (window.PortalAccess?.Access?.token) {
      clearInterval(bootInterval);
      setTimeout(loadAnnouncements, 800);
    }
  }, 600);
  setTimeout(() => clearInterval(bootInterval), 20000);

  // expõe para uso externo
  window.loadAnnouncements = loadAnnouncements;
  window.openAnnouncements = openAnnouncements;
})();

/* ══ CHAT INTERNO (equipe, setores e conversas individuais) ══ */
(() => {
  const portal = window.PortalAccess;
  if (!portal) return;
  const { api, Access } = portal;
  const state = {
    visible: false,
    active: null,
    activeKey: '',
    after: '',
    rendered: new Set(),
    channels: [],
    people: [],
    search: '',
    messagesTimer: null,
    listTimer: null,
    fetching: false,
    sending: false,
    pending: null,
    recording: null,
  };

  const esc = value => (window.escapeHtml ? window.escapeHtml(value) : String(value));
  const keyOf = (scope, scopeId) => `${scope}:${scopeId}`;
  const initial = name => String(name || '?').trim().charAt(0).toUpperCase();
  const API_BASE = window.PORTAL_API_BASE || '';
  const MEDIA_LIMITS = { image: 8_000_000, video: 40_000_000, audio: 20_000_000, file: 20_000_000 };
  const mediaUrl = path => path ? `${API_BASE}${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(Access.token || '')}` : '';

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function mediaHtml(message) {
    if (!message?.media) return '';
    const url = mediaUrl(message.media);
    if (message.kind === 'image') {
      return `<a class="chat-media chat-media-image" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(message.mediaName || 'Imagem')}"></a>`;
    }
    if (message.kind === 'video') {
      return `<video class="chat-media chat-media-video" controls preload="metadata" src="${esc(url)}"></video>`;
    }
    if (message.kind === 'audio') {
      return `<div class="chat-audio" data-audio data-duration="${Number(message.mediaDuration) || 0}">
        <button type="button" class="chat-audio-toggle" aria-label="Reproduzir áudio">▶</button>
        <div class="chat-audio-body"><div class="chat-audio-track"><i></i></div><span class="chat-audio-time">${formatDuration(message.mediaDuration)}</span></div>
        <audio preload="metadata" src="${esc(url)}"></audio>
      </div>`;
    }
    if (message.kind === 'file') {
      return `<a class="chat-file" href="${esc(url)}" download="${esc(message.mediaName || 'arquivo')}" target="_blank" rel="noopener">
        <span class="chat-file-icon">${esc(fileBadge(message.mediaName))}</span>
        <span class="chat-file-copy"><strong>${esc(message.mediaName || 'Arquivo')}</strong><small>${esc(formatBytes(message.mediaSize))}</small></span>
      </a>`;
    }
    return '';
  }

  function avatar(name, photo, className) {
    if (photo) return `<span class="${className} has-photo" style="background-image:url(${photo})"></span>`;
    return `<span class="${className}">${esc(initial(name))}</span>`;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatWhen(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return formatTime(value);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Ontem';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function directSubtitle(entry) {
    if (entry.status?.text) return `${entry.status.emoji ? `${entry.status.emoji} ` : ''}${entry.status.text}`;
    return `${entry.sector || (entry.role === 'admin' ? 'Administrador' : 'Equipe')} · Conversa individual`;
  }

  function activeSubtitle(entry) {
    if (entry.scope === 'team') return 'Canal de toda a equipe';
    if (entry.scope === 'sector') return 'Canal do setor';
    return directSubtitle(entry);
  }

  function previewBody(message) {
    if (!message) return '';
    const label = message.kind === 'image' ? '📷 Foto' : message.kind === 'video' ? '🎬 Vídeo' : message.kind === 'audio' ? '🎤 Áudio' : message.kind === 'file' ? '📎 Arquivo' : '';
    if (!label) return message.body || '';
    return message.body ? `${label} · ${message.body}` : label;
  }

  function previewText(entry) {
    if (entry.lastMessage) return `${entry.lastMessage.userName}: ${previewBody(entry.lastMessage)}`;
    if (entry.scope === 'direct') return `${entry.sector || (entry.role === 'admin' ? 'Administrador' : 'Equipe')} · Conversa individual`;
    return 'Nenhuma mensagem ainda';
  }

  function unreadTotal() {
    return [...state.channels, ...state.people].reduce((total, entry) => total + (entry.unread || 0), 0);
  }

  function updateBadge(total) {
    const badge = document.getElementById('chatNavBadge');
    if (!badge) return;
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '';
      badge.classList.add('hidden');
    }
  }

  function itemHtml(entry) {
    const active = state.activeKey === keyOf(entry.scope, entry.scopeId);
    const when = formatWhen(entry.lastAt);
    const count = entry.unread || 0;
    const status = entry.scope === 'direct' ? entry.status : null;
    const statusLine = status?.text
      ? `<small class="chat-item-status">${esc(status.emoji ? `${status.emoji} ` : '')}${esc(status.text)}</small>`
      : '';
    return `<button type="button" class="chat-item${active ? ' active' : ''}" data-scope="${esc(entry.scope)}" data-scope-id="${esc(entry.scopeId)}">
      ${avatar(entry.name, entry.photo, 'chat-item-avatar')}
      <span class="chat-item-copy"><strong>${esc(entry.name)}</strong>${statusLine}<small>${esc(previewText(entry))}</small></span>
      <span class="chat-item-side">${when ? `<span class="chat-item-time">${esc(when)}</span>` : ''}${count ? `<span class="chat-unread">${count > 99 ? '99+' : count}</span>` : ''}</span>
    </button>`;
  }

  function matches(entry) {
    if (!state.search) return true;
    return [entry.name, entry.subtitle, entry.sector, previewText(entry)].filter(Boolean).join(' ').toLowerCase().includes(state.search);
  }

  function renderList() {
    const list = document.getElementById('chatList');
    const scroll = list ? list.scrollTop : 0;
    const channels = state.channels.filter(matches);
    const people = state.people.filter(matches);
    const channelHost = document.getElementById('chatChannels');
    const peopleHost = document.getElementById('chatPeople');
    if (channelHost) channelHost.innerHTML = channels.map(itemHtml).join('') || '<p class="chat-empty-note">Nenhum canal encontrado.</p>';
    if (peopleHost) peopleHost.innerHTML = people.map(itemHtml).join('') || '<p class="chat-empty-note">Nenhuma outra pessoa encontrada.</p>';
    if (list) list.scrollTop = scroll;
    updateBadge(unreadTotal());
  }

  function findEntry(scope, scopeId) {
    return [...state.channels, ...state.people].find(entry => entry.scope === scope && entry.scopeId === scopeId) || null;
  }

  function updateHeader() {
    const active = state.active;
    const avatarEl = document.getElementById('chatHeadAvatar');
    const title = document.getElementById('chatHeadTitle');
    const subtitle = document.getElementById('chatHeadSubtitle');
    if (title) title.textContent = active ? active.title : 'Escolha uma conversa';
    if (subtitle) subtitle.textContent = active ? active.subtitle : 'Canais e pessoas aparecem à esquerda';
    if (avatarEl) {
      avatarEl.hidden = !active;
      avatarEl.classList.toggle('has-photo', Boolean(active?.photo));
      avatarEl.textContent = !active || active.photo ? '' : initial(active.title);
      avatarEl.style.backgroundImage = active?.photo ? `url("${active.photo}")` : '';
    }
    document.getElementById('chatEmpty')?.classList.toggle('hidden', Boolean(active));
    document.getElementById('chatForm')?.classList.toggle('hidden', !active);
    const info = document.getElementById('chatInfo');
    if (info) info.hidden = !active;
    const attach = document.getElementById('chatAttach');
    const mic = document.getElementById('chatMic');
    if (attach) attach.disabled = !active;
    if (mic) mic.disabled = !active;
  }

  function scrollToBottom() {
    const host = document.getElementById('chatMessages');
    if (host) host.scrollTop = host.scrollHeight;
  }

  function messageHtml(message) {
    const mine = message.userId === Access.user?.id;
    const media = mediaHtml(message);
    const caption = message.body ? `<p>${esc(message.body)}</p>` : '';
    return `<article class="chat-msg${mine ? ' is-mine' : ''}" data-message-id="${esc(message.id)}">
      ${avatar(message.userName, message.photo, 'chat-msg-avatar')}
      <div class="chat-bubble${media ? ' has-media' : ''}">
        <strong>${mine ? 'Você' : esc(message.userName)}</strong>
        ${media}${caption}
        <time datetime="${esc(message.createdAt)}">${formatTime(message.createdAt)}</time>
      </div>
    </article>`;
  }

  function hydrateAudio() {
    document.querySelectorAll('#chatMessages [data-audio]').forEach(box => {
      if (box.dataset.ready) return;
      box.dataset.ready = '1';
      const audio = box.querySelector('audio');
      const bar = box.querySelector('.chat-audio-track i');
      const time = box.querySelector('.chat-audio-time');
      const toggle = box.querySelector('.chat-audio-toggle');
      const fallback = Number(box.dataset.duration) || 0;
      if (!audio) return;
      audio.addEventListener('timeupdate', () => {
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallback;
        if (bar && duration) bar.style.width = `${Math.min(100, (audio.currentTime / duration) * 100)}%`;
        if (time) time.textContent = formatDuration(audio.currentTime);
      });
      audio.addEventListener('loadedmetadata', () => {
        if (time && Number.isFinite(audio.duration) && audio.duration > 0) time.textContent = formatDuration(audio.duration);
      });
      audio.addEventListener('play', () => { toggle.textContent = '⏸'; box.classList.add('playing'); });
      audio.addEventListener('pause', () => { toggle.textContent = '▶'; box.classList.remove('playing'); });
      audio.addEventListener('ended', () => {
        toggle.textContent = '▶';
        box.classList.remove('playing');
        if (bar) bar.style.width = '0%';
        if (time) time.textContent = formatDuration(Number.isFinite(audio.duration) ? audio.duration : fallback);
      });
    });
  }

  function renderMessages(messages, replace) {
    const host = document.getElementById('chatMessages');
    if (!host) return;
    if (replace) {
      state.rendered.clear();
      host.innerHTML = messages.map(messageHtml).join('');
      messages.forEach(message => state.rendered.add(message.id));
      if (!messages.length) host.innerHTML = '<p class="chat-empty-note">Nenhuma mensagem por aqui ainda. Envie a primeira.</p>';
    } else {
      const fresh = messages.filter(message => !state.rendered.has(message.id));
      if (!fresh.length) return;
      host.querySelector('.chat-empty-note')?.remove();
      fresh.forEach(message => {
        host.insertAdjacentHTML('beforeend', messageHtml(message));
        state.rendered.add(message.id);
      });
    }
    hydrateAudio();
    scrollToBottom();
  }

  async function fetchMessages(initialLoad) {
    if (!state.active || state.fetching) return;
    const active = state.active;
    const activeKey = state.activeKey;
    state.fetching = true;
    try {
      const query = new URLSearchParams({ scope: active.scope, scopeId: active.scopeId });
      if (!initialLoad && state.after) query.set('after', state.after);
      const data = await api(`/api/chat/messages?${query.toString()}`);
      if (state.activeKey !== activeKey) return;
      const messages = data.messages || [];
      renderMessages(messages, initialLoad);
      if (messages.length) state.after = messages[messages.length - 1].createdAt;
      const entry = findEntry(active.scope, active.scopeId);
      if (entry) entry.unread = 0;
      renderList();
      updateBadge(unreadTotal());
    } catch (error) {
      if (error.message !== 'auth') console.warn('Chat: falha ao carregar mensagens', error);
    } finally {
      state.fetching = false;
    }
  }

  function openConversation(entry) {
    state.active = {
      scope: entry.scope,
      scopeId: entry.scopeId,
      title: entry.name,
      subtitle: activeSubtitle(entry),
      photo: entry.photo || '',
    };
    state.activeKey = keyOf(entry.scope, entry.scopeId);
    state.after = '';
    state.fetching = false;
    clearPending();
    const host = document.getElementById('chatMessages');
    if (host) host.innerHTML = '';
    document.getElementById('chatShell')?.classList.add('chat-open');
    updateHeader();
    renderList();
    fetchMessages(true);
    document.getElementById('chatInput')?.focus();
  }

  async function refreshConversations() {
    try {
      const data = await api('/api/chat/conversations');
      state.channels = data.channels || [];
      state.people = data.people || [];
      if (state.active) {
        const entry = findEntry(state.active.scope, state.active.scopeId);
        if (entry) {
          state.active.title = entry.name;
          state.active.subtitle = activeSubtitle(entry);
          state.active.photo = entry.photo || '';
          entry.unread = 0;
        }
        updateHeader();
      }
      syncConversationNotifications();
      renderList();
    } catch (error) {
      if (error.message !== 'auth') console.warn('Chat: falha ao carregar conversas', error);
    }
  }

  function syncConversationNotifications() {
    window.PortalNotify?.syncChat?.([...state.channels, ...state.people], {
      activeKey: state.activeKey,
      visible: state.visible,
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    });
  }

  function toast(message, tone = 'success') {
    if (window.showToast) window.showToast(message, tone);
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
    if (value >= 1000) return `${Math.round(value / 1000)} KB`;
    return `${value} B`;
  }

  function fileBadge(name) {
    const text = String(name || '');
    const ext = text.includes('.') ? text.split('.').pop() : '';
    return ext && ext.length <= 4 ? ext.toUpperCase() : 'ARQ';
  }

  function clearPending() {
    if (state.pending?.previewUrl) URL.revokeObjectURL(state.pending.previewUrl);
    state.pending = null;
    renderPending();
  }

  function setPending(file, kind, duration) {
    clearPending();
    state.pending = {
      file,
      kind,
      duration: duration || 0,
      previewUrl: kind === 'image' ? URL.createObjectURL(file) : '',
    };
    renderPending();
  }

  function renderPending() {
    const host = document.getElementById('chatAttachPreview');
    if (!host) return;
    const pending = state.pending;
    if (!pending) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    const labels = { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', file: 'Arquivo' };
    const label = labels[pending.kind] || 'Anexo';
    const thumb = pending.previewUrl
      ? `<span class="chat-attach-thumb" style="background-image:url('${esc(pending.previewUrl)}')"></span>`
      : `<span class="chat-attach-thumb">${pending.kind === 'video' ? '🎬' : pending.kind === 'file' ? esc(fileBadge(pending.file.name)) : '🎤'}</span>`;
    host.innerHTML = `${thumb}
      <span class="chat-attach-copy"><strong>${esc(pending.file.name || label)}</strong><small>${label} · ${formatBytes(pending.file.size)}${pending.duration ? ` · ${formatDuration(pending.duration)}` : ''}</small></span>
      <button type="button" class="chat-attach-clear" id="chatAttachClear" title="Remover anexo">✕</button>`;
    host.classList.remove('hidden');
  }

  async function uploadAttachment(file, kind) {
    const limit = MEDIA_LIMITS[kind] || 0;
    if (limit && file.size > limit) throw new Error(`Arquivo maior que ${Math.floor(limit / 1_000_000)} MB para ${kind}.`);
    const mime = (file.type || '').split(';')[0].toLowerCase();
    const query = new URLSearchParams({ kind, mime, name: file.name || kind });
    return api(`/api/chat/upload?${query.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  }

  function trackSent(message) {
    if (!message) return;
    state.after = message.createdAt;
    renderMessages([message], false);
    const entry = findEntry(message.scope, message.scopeId);
    if (entry) {
      entry.unread = 0;
      entry.lastMessage = message;
      entry.lastAt = message.createdAt;
    }
    renderList();
  }

  async function sendMessage(event) {
    event?.preventDefault();
    if (!state.active || state.sending) return;
    const input = document.getElementById('chatInput');
    const body = input ? input.value.trim() : '';
    const pending = state.pending;
    if (!pending && !body) { input?.focus(); return; }
    state.sending = true;
    const button = document.getElementById('chatSend');
    if (button) { button.disabled = true; button.textContent = pending ? 'Enviando…' : 'Enviar'; }
    try {
      const payload = { scope: state.active.scope, scopeId: state.active.scopeId, body };
      if (pending) {
        const info = await uploadAttachment(pending.file, pending.kind);
        Object.assign(payload, {
          kind: pending.kind,
          mediaId: info.mediaId,
          mediaMime: info.mime,
          mediaName: info.name,
          mediaSize: info.size,
          mediaDuration: pending.duration || 0,
        });
      }
      const data = await api('/api/chat/messages', { method: 'POST', body: JSON.stringify(payload) });
      trackSent(data.message);
      clearPending();
      if (input) {
        input.value = '';
        input.style.height = '';
        input.focus();
      }
    } catch (error) {
      if (error.message !== 'auth') toast(error.message, 'warning');
    } finally {
      state.sending = false;
      if (button) { button.disabled = false; button.textContent = 'Enviar'; }
    }
  }

  async function sendRecordedAudio(file, duration) {
    if (!state.active || state.sending) return;
    state.sending = true;
    const button = document.getElementById('chatSend');
    if (button) { button.disabled = true; button.textContent = 'Enviando…'; }
    try {
      const info = await uploadAttachment(file, 'audio');
      const data = await api('/api/chat/messages', {
        method: 'POST',
        body: JSON.stringify({
          scope: state.active.scope,
          scopeId: state.active.scopeId,
          body: '',
          kind: 'audio',
          mediaId: info.mediaId,
          mediaMime: info.mime,
          mediaName: info.name,
          mediaSize: info.size,
          mediaDuration: duration,
        }),
      });
      trackSent(data.message);
    } catch (error) {
      if (error.message !== 'auth') toast(error.message, 'warning');
    } finally {
      state.sending = false;
      if (button) { button.disabled = false; button.textContent = 'Enviar'; }
    }
  }

  function recordingSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  async function startRecording() {
    if (state.recording || !state.active || state.sending) return;
    if (!recordingSupported()) {
      toast('Este navegador não permite gravar áudio.', 'warning');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Não foi possível acessar o microfone.', 'warning');
      return;
    }
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(item => window.MediaRecorder.isTypeSupported?.(item)) || '';
    let recorder;
    try {
      recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach(track => track.stop());
      toast('Não foi possível iniciar a gravação.', 'warning');
      return;
    }
    const chunks = [];
    const startedAt = Date.now();
    recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    const timer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const label = document.getElementById('chatRecTime');
      if (label) label.textContent = formatDuration(elapsed);
      if (elapsed >= 300) stopRecording(false);
    }, 250);
    state.recording = { recorder, stream, chunks, startedAt, timer, cancelled: false };
    document.getElementById('chatForm')?.classList.add('recording');
    document.getElementById('chatRecording')?.classList.remove('hidden');
    document.getElementById('chatMic')?.classList.add('recording');
    const label = document.getElementById('chatRecTime');
    if (label) label.textContent = '0:00';
    recorder.addEventListener('stop', () => {
      clearInterval(timer);
      stream.getTracks().forEach(track => track.stop());
      const duration = Math.min((Date.now() - startedAt) / 1000, 300);
      const cancelled = Boolean(state.recording?.cancelled);
      state.recording = null;
      document.getElementById('chatForm')?.classList.remove('recording');
      document.getElementById('chatRecording')?.classList.add('hidden');
      document.getElementById('chatMic')?.classList.remove('recording');
      if (cancelled || !chunks.length) return;
      const mime = (recorder.mimeType || 'audio/webm').split(';')[0];
      const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
      const blob = new Blob(chunks, { type: mime });
      const file = new File([blob], `audio-${Date.now()}.${ext}`, { type: mime });
      sendRecordedAudio(file, duration);
    });
    recorder.start();
  }

  function stopRecording(cancelled) {
    const recording = state.recording;
    if (!recording) return;
    if (cancelled) recording.cancelled = true;
    try { recording.recorder.stop(); } catch { /* já parado */ }
  }

  function stopTimers() {
    if (state.messagesTimer) clearInterval(state.messagesTimer);
    if (state.listTimer) clearInterval(state.listTimer);
    state.messagesTimer = null;
    state.listTimer = null;
  }

  function enterChatScreen() {
    state.visible = true;
    stopTimers();
    state.messagesTimer = setInterval(() => { if (state.active) fetchMessages(false); }, 3000);
    state.listTimer = setInterval(refreshConversations, 10000);
    refreshConversations();
    window.refreshDirectory?.();
    if (state.active) fetchMessages(true);
  }

  function leaveChatScreen() {
    state.visible = false;
    stopTimers();
    stopRecording(true);
    document.querySelectorAll('#chatMessages audio').forEach(audio => audio.pause());
  }

  function resetChat() {
    leaveChatScreen();
    clearPending();
    state.active = null;
    state.activeKey = '';
    state.after = '';
    state.rendered.clear();
    state.channels = [];
    state.people = [];
    state.search = '';
    state.fetching = false;
    state.sending = false;
    const search = document.getElementById('chatSearch');
    if (search) search.value = '';
    const host = document.getElementById('chatMessages');
    if (host) host.innerHTML = '';
    document.getElementById('chatShell')?.classList.remove('chat-open');
    updateHeader();
    updateBadge(0);
  }

  document.getElementById('chatList')?.addEventListener('click', event => {
    if (event.target.closest('[data-dir-action]')) return;
    if (event.target.closest('.chat-dir-item')) return;
    const button = event.target.closest('.chat-item');
    if (!button) return;
    const entry = findEntry(button.dataset.scope, button.dataset.scopeId);
    if (entry) openConversation(entry);
  });

  document.getElementById('chatSearch')?.addEventListener('input', event => {
    state.search = String(event.target.value || '').trim().toLowerCase();
    renderList();
  });

  document.getElementById('chatForm')?.addEventListener('submit', sendMessage);
  document.getElementById('chatInput')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(event);
    }
  });
  document.getElementById('chatInput')?.addEventListener('input', event => {
    const input = event.target;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });
  document.getElementById('chatBack')?.addEventListener('click', () => {
    document.getElementById('chatShell')?.classList.remove('chat-open');
  });

  document.getElementById('chatAttach')?.addEventListener('click', () => {
    document.getElementById('chatFile')?.click();
  });

  const CHAT_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods', 'odp', 'json', 'xml', 'zip', 'rar', '7z'];

  document.getElementById('chatFile')?.addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const type = (file.type || '').toLowerCase();
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'file';
    if (kind === 'file' && !CHAT_FILE_EXTENSIONS.includes(ext)) {
      toast('Esse tipo de arquivo não é aceito. Envie PDF, Word, Excel, PowerPoint, texto, planilha CSV ou ZIP.', 'warning');
      return;
    }
    if (file.size > MEDIA_LIMITS[kind]) {
      toast(`Arquivo maior que ${Math.floor(MEDIA_LIMITS[kind] / 1_000_000)} MB.`, 'warning');
      return;
    }
    setPending(file, kind);
    document.getElementById('chatInput')?.focus();
  });

  document.getElementById('chatAttachPreview')?.addEventListener('click', event => {
    if (event.target.closest('#chatAttachClear')) clearPending();
  });

  document.getElementById('chatMic')?.addEventListener('click', () => {
    if (state.recording) stopRecording(false);
    else startRecording();
  });

  document.getElementById('chatRecCancel')?.addEventListener('click', () => stopRecording(true));
  document.getElementById('chatRecSend')?.addEventListener('click', () => stopRecording(false));

  document.getElementById('chatMessages')?.addEventListener('click', event => {
    const box = event.target.closest('[data-audio]');
    if (!box) return;
    const audio = box.querySelector('audio');
    if (!audio) return;
    document.querySelectorAll('#chatMessages [data-audio] audio').forEach(other => {
      if (other !== audio) other.pause();
    });
    if (audio.paused) audio.play().catch(() => toast('Não foi possível reproduzir o áudio.', 'warning'));
    else audio.pause();
  });

  document.getElementById('chatInfo')?.addEventListener('click', () => {
    const active = state.active;
    if (!active) return;
    if (active.scope === 'direct') {
      const other = active.scopeId.split('|').find(id => id !== Access.user?.id) || '';
      window.openContactProfile?.(other);
    } else {
      window.openGroupProfile?.(active.scope, active.scopeId);
    }
  });

  function openChatTarget(target) {
    if (!target?.scope) return;
    openConversation({
      scope: target.scope,
      scopeId: target.scopeId || '',
      name: target.name || (target.scope === 'team' ? 'Equipe' : 'Conversa'),
      sector: target.sector || '',
      role: target.role || '',
      photo: target.photo || '',
      status: target.status || null,
      unread: 0,
    });
  }

  window.enterChatScreen = enterChatScreen;
  window.leaveChatScreen = leaveChatScreen;
  window.resetChat = resetChat;
  window.refreshChatConversations = refreshConversations;
  window.openChatTarget = openChatTarget;

  setInterval(async () => {
    if (!Access.token) {
      updateBadge(0);
      return;
    }
    if (state.visible) return;
    try {
      const data = await api('/api/chat/conversations');
      state.channels = data.channels || [];
      state.people = data.people || [];
      syncConversationNotifications();
      updateBadge(unreadTotal());
    } catch {}
  }, 15000);
})();

/* ══ CRM DA EQUIPE: pessoas e grupos dentro da tela de conversas ══ */
(() => {
  const portal = window.PortalAccess;
  if (!portal) return;
  const { api, Access } = portal;
  const state = { data: null, tab: 'conversations', search: '', loaded: false, loading: false, promise: null };

  const esc = value => (window.escapeHtml ? window.escapeHtml(value) : String(value ?? ''));
  const initial = name => String(name || '?').trim().charAt(0).toUpperCase() || '?';
  const toast = (message, tone = 'warning') => window.showToast?.(message, tone);
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const roleLabel = role => (role === 'admin' ? 'Administrador' : 'Equipe');
  const priorityLabel = value => ({ urgent: 'Urgente', high: 'Alta', medium: 'Média', low: 'Baixa' }[value] || 'Média');
  const todayIso = () => new Date().toISOString().slice(0, 10);

  function formatBirthday(value) {
    if (!value) return 'Não informado';
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
  }

  function birthdayShort(value) {
    if (!value) return '';
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function formatNextBirthday(value) {
    if (!value) return '—';
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function countdown(days) {
    if (days === null || days === undefined) return '';
    if (days === 0) return 'é hoje';
    if (days === 1) return 'amanhã';
    return `em ${days} dias`;
  }

  function formatDateShort(value) {
    if (!value) return 'sem prazo';
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function formatWhen(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function avatarHtml(name, photo, extra = '') {
    const classes = `chat-item-avatar${extra ? ` ${extra}` : ''}${photo ? ' has-photo' : ''}`;
    return photo
      ? `<span class="${classes}" style="background-image:url(${esc(photo)})"></span>`
      : `<span class="${classes}">${esc(initial(name))}</span>`;
  }

  function dialogAvatar(name, photo) {
    const classes = `contact-avatar${photo ? ' has-photo' : ''}`;
    return photo
      ? `<span class="${classes}" style="background-image:url(${esc(photo)})"></span>`
      : `<span class="${classes}">${esc(initial(name))}</span>`;
  }

  function memberAvatar(name, photo) {
    const classes = `directory-avatar${photo ? ' has-photo' : ''}`;
    return photo
      ? `<span class="${classes}" style="background-image:url(${esc(photo)})"></span>`
      : `<span class="${classes}">${esc(initial(name))}</span>`;
  }

  function groupKey(group) {
    return `${group.scope}:${group.scopeId || ''}`;
  }

  function findGroup(scope, scopeId) {
    return (state.data?.groups || []).find(group => group.scope === scope && (group.scopeId || '') === (scopeId || ''));
  }

  function matchesPerson(person, needle) {
    if (!needle) return true;
    return normalize([person.name, person.username, person.sector, roleLabel(person.role), person.birthday, person.status?.text].join(' ')).includes(needle);
  }

  function matchesGroup(group, needle) {
    if (!needle) return true;
    const members = (group.members || []).map(member => member.name).join(' ');
    return normalize([group.name, group.description, members].join(' ')).includes(needle);
  }

  function personRow(person) {
    const isMe = person.id === state.data?.me;
    const scopeId = isMe ? '' : [state.data.me, person.id].sort().join('|');
    const tasks = person.tasks || {};
    const tasksVisible = person.tasksVisible !== false;
    const bits = [person.sector || 'Sem setor'];
    if (tasksVisible) {
      bits.push(tasks.open ? `${tasks.open} aberta${tasks.open === 1 ? '' : 's'}` : 'sem demandas abertas');
      if (tasks.overdue) bits.push(`${tasks.overdue} atrasada${tasks.overdue === 1 ? '' : 's'}`);
    } else {
      bits.push('demandas restritas ao setor');
    }
    if (person.birthday) bits.push(`niver ${birthdayShort(person.birthday)}`);
    const tags = `${isMe ? '<span class="chat-dir-badge">você</span>' : ''}${person.role === 'admin' ? '<span class="chat-dir-badge">admin</span>' : ''}`;
    const statusLine = person.status?.text
      ? `<small class="chat-dir-status">${esc(person.status.emoji ? `${person.status.emoji} ` : '')}${esc(person.status.text)}</small>`
      : '';
    const scopeAttr = isMe ? `data-me-contact="${esc(person.id)}"` : `data-scope="direct" data-scope-id="${esc(scopeId)}"`;
    return `<div class="chat-item chat-dir-item${isMe ? ' is-me' : ''}" ${scopeAttr} data-dir-person="${esc(person.id)}" role="button" tabindex="0">
      ${avatarHtml(person.name, person.photo)}
      <span class="chat-item-copy"><strong>${esc(person.name)}${tags}</strong>${statusLine}<small>${esc(bits.join(' · '))}</small></span>
      <span class="chat-item-side">${tasksVisible && tasks.overdue ? `<span class="chat-dir-over" title="${tasks.overdue} demanda(s) em atraso">${tasks.overdue} atr.</span>` : ''}<button type="button" class="chat-item-info" data-dir-action data-contact="${esc(person.id)}" title="Ficha de ${esc(person.name)}" aria-label="Ficha de ${esc(person.name)}">i</button></span>
    </div>`;
  }

  function groupRow(group) {
    const tasks = group.tasks || {};
    const tasksVisible = group.tasksVisible !== false;
    const members = group.memberCount || (group.members || []).length;
    const bits = [`${members} pessoa${members === 1 ? '' : 's'}`];
    if (!tasksVisible) bits.push('demandas restritas');
    else {
      bits.push(tasks.open ? `${tasks.open} aberta${tasks.open === 1 ? '' : 's'}` : 'sem demandas abertas');
      if (tasks.overdue) bits.push(`${tasks.overdue} atrasada${tasks.overdue === 1 ? '' : 's'}`);
    }
    return `<div class="chat-item chat-dir-item" data-scope="${esc(group.scope)}" data-scope-id="${esc(group.scopeId || '')}" data-dir-group="${esc(groupKey(group))}" role="button" tabindex="0">
      ${avatarHtml(group.name, '', 'is-group')}
      <span class="chat-item-copy"><strong>${esc(group.name)} <span class="chat-dir-badge">${group.scope === 'team' ? 'canal geral' : 'setor'}</span></strong><small>${esc(bits.join(' · '))}</small></span>
      <span class="chat-item-side">${tasksVisible && tasks.overdue ? `<span class="chat-dir-over" title="${tasks.overdue} demanda(s) em atraso">${tasks.overdue} atr.</span>` : ''}<button type="button" class="chat-item-info" data-dir-action data-contact-group="${esc(groupKey(group))}" title="Ficha de ${esc(group.name)}" aria-label="Ficha de ${esc(group.name)}">i</button></span>
    </div>`;
  }

  function taskRow(task) {
    const late = task.due && task.due < todayIso();
    return `<div class="contact-task">
      <div class="contact-task-copy"><strong>${esc(task.title || 'Demanda')}</strong><small>${esc(task.sector || 'Sem setor')} · ${esc(priorityLabel(task.priority))}</small></div>
      <span class="contact-task-due${late ? ' is-late' : ''}">${esc(formatDateShort(task.due))}</span>
    </div>`;
  }

  function statsHtml(tasks) {
    return `<div class="contact-stats">
      <div class="contact-stat"><strong>${tasks.open || 0}</strong><span>abertas</span></div>
      <div class="contact-stat${tasks.overdue ? ' alert' : ''}"><strong>${tasks.overdue || 0}</strong><span>atrasadas</span></div>
      <div class="contact-stat"><strong>${tasks.today || 0}</strong><span>para hoje</span></div>
      <div class="contact-stat"><strong>${tasks.done || 0}</strong><span>concluídas</span></div>
    </div>`;
  }

  function recentTasksHtml(tasks) {
    const recent = tasks.recent || [];
    if (!recent.length) return '<p class="panel-help" style="font-size:12px">Nenhuma demanda em aberto.</p>';
    return `<div class="contact-tasks">${recent.map(taskRow).join('')}</div>`;
  }

  function renderDirectory() {
    if (state.tab === 'conversations') return;
    const peopleHost = document.getElementById('chatDirectoryPeople');
    const groupsHost = document.getElementById('chatDirectoryGroups');
    const host = state.tab === 'people' ? peopleHost : groupsHost;
    if (!host) return;
    if (!state.data) {
      host.innerHTML = '<p class="chat-empty-note">Carregando fichas da equipe...</p>';
      return;
    }
    const needle = normalize(state.search);
    const summaryData = state.data.summary || {};
    const scopeWord = summaryData.scope === 'sector' ? 'no seu setor' : 'no portal';
    if (state.tab === 'people') {
      const people = (state.data.people || []).filter(person => matchesPerson(person, needle));
      const month = new Date().getMonth() + 1;
      const birthdays = people.filter(person => person.birthdayMonth === month).length;
      const summary = `<div class="chat-dir-summary"><strong>${people.length}</strong> ${people.length === 1 ? 'pessoa' : 'pessoas'} · <strong>${summaryData.open || 0}</strong> demandas abertas ${scopeWord} · <strong>${summaryData.overdue || 0}</strong> atrasadas · <strong>${birthdays}</strong> aniversário${birthdays === 1 ? '' : 's'} no mês</div>`;
      host.innerHTML = summary + (people.length ? people.map(personRow).join('') : '<p class="chat-empty-note">Nenhuma pessoa encontrada.</p>');
      return;
    }
    const groups = (state.data.groups || []).filter(group => matchesGroup(group, needle));
    const summary = `<div class="chat-dir-summary"><strong>${groups.length}</strong> ${groups.length === 1 ? 'grupo' : 'grupos'} · <strong>${summaryData.open || 0}</strong> demandas abertas ${scopeWord} · <strong>${summaryData.overdue || 0}</strong> atrasadas</div>`;
    host.innerHTML = summary + (groups.length ? groups.map(groupRow).join('') : '<p class="chat-empty-note">Nenhum grupo encontrado.</p>');
  }

  async function load(force) {
    if (state.loading) return state.promise;
    if (state.loaded && !force) return state.data;
    state.loading = true;
    if (!state.data) renderDirectory();
    state.promise = (async () => {
      try {
        state.data = await api('/api/directory');
        state.loaded = true;
        renderDirectory();
        return state.data;
      } catch (error) {
        if (error.message !== 'auth') toast(error.message || 'Não foi possível carregar as fichas da equipe.');
        return null;
      } finally {
        state.loading = false;
        state.promise = null;
      }
    })();
    return state.promise;
  }

  function closeDialog() {
    const dialog = document.getElementById('contactDialog');
    if (!dialog) return;
    try { dialog.close(); } catch {}
  }

  async function openContact(id) {
    if (!state.data) await load(true);
    let person = (state.data?.people || []).find(item => item.id === id);
    if (!person && state.loaded) {
      await load(true);
      person = (state.data?.people || []).find(item => item.id === id);
    }
    if (!state.data) return;
    if (!person) { toast('Perfil não encontrado.'); return; }
    const dialog = document.getElementById('contactDialog');
    const body = document.getElementById('contactBody');
    if (!dialog || !body) return;
    const isMe = person.id === state.data.me;
    const tasks = person.tasks || {};
    const tasksVisible = person.tasksVisible !== false;
    const groupsOf = (state.data.groups || []).filter(group => (group.members || []).some(member => member.id === person.id));
    const birthdayLine = person.birthday
      ? `${formatBirthday(person.birthday)}${person.birthdayAge ? ` · ${person.birthdayAge} anos` : ''}`
      : 'Não informado';
    const nextLine = person.birthdayNext
      ? `${formatNextBirthday(person.birthdayNext)}${countdown(person.birthdayDays) ? ` · ${countdown(person.birthdayDays)}` : ''}`
      : '—';
    const status = person.status || {};
    const statusUntil = status.until
      ? ` · até ${new Date(`${status.until}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`
      : '';
    const statusChip = status.text
      ? `<span class="contact-status" title="Status até a data indicada"><span>${esc(status.emoji ? `${status.emoji} ` : '')}${esc(status.text)}${esc(statusUntil)}</span></span>`
      : '';
    body.innerHTML = `
      <div class="contact-head">
        ${dialogAvatar(person.name, person.photo)}
        <div class="contact-copy">
          <p class="eyebrow">FICHA DA EQUIPE</p>
          <h3>${esc(person.name)}${isMe ? ' (você)' : ''}</h3>
          <p class="panel-help">${esc(person.sector || 'Sem setor')} · ${esc(roleLabel(person.role))}</p>
          ${statusChip}
        </div>
        <button type="button" class="contact-close" data-close-contact aria-label="Fechar">×</button>
      </div>
      <div class="contact-facts">
        <div class="contact-fact"><span>Usuário</span><strong>@${esc(person.username || 'não informado')}</strong></div>
        <div class="contact-fact"><span>Setor</span><strong>${esc(person.sector || 'Não informado')}</strong></div>
        <div class="contact-fact"><span>Permissão</span><strong>${esc(roleLabel(person.role))}</strong></div>
        <div class="contact-fact"><span>Aniversário</span><strong>${esc(birthdayLine)}</strong></div>
        <div class="contact-fact"><span>Próximo aniversário</span><strong>${esc(nextLine)}</strong></div>
        <div class="contact-fact"><span>Última conversa</span><strong>${esc(person.lastAt ? formatWhen(person.lastAt) : 'Nenhuma mensagem')}${person.unread ? ` · ${person.unread} não lida${person.unread === 1 ? '' : 's'}` : ''}</strong></div>
      </div>
      ${tasksVisible
        ? `${statsHtml(tasks)}
      <p class="contact-section-title">Demandas em aberto</p>
      ${recentTasksHtml(tasks)}`
        : '<p class="contact-restricted">As demandas deste perfil ficam visíveis apenas para o setor e a gerência.</p>'}
      <div class="contact-actions">
        ${isMe
          ? '<button type="button" class="button button-secondary" disabled>Este perfil é você</button>'
          : `<button type="button" class="button button-primary" data-chat-person="${esc(person.id)}">Conversar no chat</button>`}
        ${tasksVisible ? `<button type="button" class="button button-secondary" data-tasks-owner="${esc(person.name)}">Ver demandas</button>` : ''}
      </div>
      <p class="contact-section-title">Grupos em que participa</p>
      ${groupsOf.length
        ? `<div class="contact-members">${groupsOf.map(group => `
            <div class="contact-member">
              ${memberAvatar(group.name, '')}
              <div class="contact-member-copy"><strong>${esc(group.name)}</strong><small>${(group.members || []).length} participantes · ${(group.tasks?.open || 0)} demandas abertas${group.tasksScope === 'sector' ? ' no seu setor' : ''}</small></div>
              <button type="button" class="button button-secondary" data-chat-group="${esc(groupKey(group))}">Abrir</button>
            </div>`).join('')}</div>`
        : '<p class="panel-help" style="font-size:12px">Ainda não participa de grupos.</p>'}
    `;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => { dialog.scrollTop = 0; });
  }

  async function openGroup(scope, scopeId) {
    if (!state.data) await load(true);
    let group = findGroup(scope, scopeId);
    if (!group && state.loaded) {
      await load(true);
      group = findGroup(scope, scopeId);
    }
    if (!state.data) return;
    if (!group) { toast('Grupo não encontrado.'); return; }
    const dialog = document.getElementById('contactDialog');
    const body = document.getElementById('contactBody');
    if (!dialog || !body) return;
    const members = group.members || [];
    const tasks = group.tasks || {};
    const tasksVisible = group.tasksVisible !== false;
    const tasksScoped = group.tasksScope === 'sector';
    const lastLine = group.lastAt ? formatWhen(group.lastAt) : 'Nenhuma mensagem';
    body.innerHTML = `
      <div class="contact-head">
        ${dialogAvatar(group.name, '')}
        <div class="contact-copy">
          <p class="eyebrow">${group.scope === 'team' ? 'CANAL GERAL' : 'GRUPO DO SETOR'}</p>
          <h3>${esc(group.name)}</h3>
          <p class="panel-help">${members.length} participante${members.length === 1 ? '' : 's'}</p>
        </div>
        <button type="button" class="contact-close" data-close-contact aria-label="Fechar">×</button>
      </div>
      ${group.description ? `<p class="panel-help" style="font-size:12px;margin:14px 0 0">${esc(group.description)}</p>` : ''}
      <div class="contact-facts">
        <div class="contact-fact"><span>Tipo</span><strong>${group.scope === 'team' ? 'Canal geral' : 'Setor'}</strong></div>
        <div class="contact-fact"><span>Participantes</span><strong>${members.length}</strong></div>
        <div class="contact-fact"><span>Última mensagem</span><strong>${esc(lastLine)}</strong></div>
        <div class="contact-fact"><span>Não lidas</span><strong>${group.unread ? `${group.unread} mensagem${group.unread === 1 ? '' : 's'}` : 'Nenhuma'}</strong></div>
      </div>
      ${tasksVisible ? statsHtml(tasks) : '<p class="contact-restricted">Demandas restritas ao setor e à gerência.</p>'}
      ${tasksScoped ? '<p class="contact-restricted">Números de demandas restritos ao seu setor.</p>' : ''}
      ${tasksVisible ? `<p class="contact-section-title">Demandas em aberto</p>${recentTasksHtml(tasks)}` : ''}
      <div class="contact-actions">
        <button type="button" class="button button-primary" data-chat-group="${esc(groupKey(group))}">Abrir conversa do grupo</button>
      </div>
      <p class="contact-section-title">Participantes</p>
      <div class="contact-members">
        ${members.map(member => `
          <div class="contact-member">
            ${memberAvatar(member.name, member.photo)}
            <div class="contact-member-copy"><strong>${esc(member.name)}</strong><small>${esc(roleLabel(member.role))}${member.status?.text ? ` · ${esc(member.status.emoji ? `${member.status.emoji} ` : '')}${esc(member.status.text)}` : ''}</small></div>
            ${member.id === state.data.me
              ? '<span class="chat-dir-badge">você</span>'
              : `<button type="button" class="button button-secondary" data-chat-person="${esc(member.id)}">Mensagem</button>`}
          </div>`).join('')}
      </div>
    `;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    requestAnimationFrame(() => { dialog.scrollTop = 0; });
  }

  function openChatWithPerson(id) {
    const person = (state.data?.people || []).find(item => item.id === id);
    if (!person) return;
    const me = Access.user?.id;
    if (!me) return;
    if (person.id === me) { toast('Este perfil é você.'); return; }
    const scopeId = [me, person.id].sort().join('|');
    closeDialog();
    portal.openScreen('chatScreen');
    window.openChatTarget?.({
      scope: 'direct',
      scopeId,
      name: person.name,
      sector: person.sector,
      role: person.role,
      photo: person.photo,
      status: person.status || null,
    });
  }

  function openChatWithGroup(scope, scopeId) {
    const group = findGroup(scope, scopeId);
    if (!group) { toast('Grupo não encontrado.'); return; }
    closeDialog();
    portal.openScreen('chatScreen');
    window.openChatTarget?.({
      scope: group.scope,
      scopeId: group.scopeId || '',
      name: group.name,
      sector: group.scope === 'sector' ? group.name : '',
    });
  }

  function openTasksFor(owner) {
    closeDialog();
    portal.openScreen('tasksScreen');
    const filter = document.getElementById('ownerFilter');
    if (!filter) return;
    let option = [...filter.options].find(item => item.value === owner);
    if (!option) {
      option = document.createElement('option');
      option.value = owner;
      option.textContent = owner;
      filter.appendChild(option);
    }
    filter.value = owner;
    filter.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setTab(tab) {
    const value = tab === 'people' || tab === 'groups' ? tab : 'conversations';
    state.tab = value;
    document.querySelectorAll('#chatTabs [data-chat-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.chatTab === value);
    });
    document.getElementById('chatConversations')?.classList.toggle('hidden', value !== 'conversations');
    document.getElementById('chatDirectoryPeople')?.classList.toggle('hidden', value !== 'people');
    document.getElementById('chatDirectoryGroups')?.classList.toggle('hidden', value !== 'groups');
    const search = document.getElementById('chatSearch');
    if (search) {
      search.placeholder = value === 'people' ? 'Buscar pessoa ou setor...'
        : value === 'groups' ? 'Buscar grupo ou setor...'
        : 'Buscar conversa...';
    }
    if (value !== 'conversations') {
      load();
      renderDirectory();
    }
  }

  function refreshDirectory() {
    if (state.loaded) load(true);
  }

  function resetDirectory() {
    closeDialog();
    state.data = null;
    state.loaded = false;
    state.loading = false;
    state.promise = null;
    state.search = '';
    const peopleHost = document.getElementById('chatDirectoryPeople');
    const groupsHost = document.getElementById('chatDirectoryGroups');
    if (peopleHost) peopleHost.innerHTML = '';
    if (groupsHost) groupsHost.innerHTML = '';
    setTab('conversations');
  }

  document.getElementById('chatTabs')?.addEventListener('click', event => {
    const tab = event.target.closest('[data-chat-tab]');
    if (tab) setTab(tab.dataset.chatTab);
  });

  document.getElementById('chatList')?.addEventListener('click', event => {
    const action = event.target.closest('[data-dir-action]');
    if (action) {
      if (action.dataset.contact) { openContact(action.dataset.contact); return; }
      if (action.dataset.contactGroup) {
        const [scope, scopeId] = action.dataset.contactGroup.split(':');
        openGroup(scope, scopeId || '');
        return;
      }
    }
    const meRow = event.target.closest('.chat-dir-item.is-me');
    if (meRow && meRow.dataset.meContact) { openContact(meRow.dataset.meContact); return; }
    const row = event.target.closest('.chat-dir-item[data-scope]');
    if (!row) return;
    const scope = row.dataset.scope;
    const scopeId = row.dataset.scopeId || '';
    if (scope === 'direct' && row.dataset.dirPerson) openChatWithPerson(row.dataset.dirPerson);
    else openChatWithGroup(scope, scopeId);
  });

  document.getElementById('contactBody')?.addEventListener('click', event => {
    if (event.target.closest('[data-close-contact]')) { closeDialog(); return; }
    const tasksOwner = event.target.closest('[data-tasks-owner]');
    if (tasksOwner) { openTasksFor(tasksOwner.dataset.tasksOwner); return; }
    const chatPerson = event.target.closest('[data-chat-person]');
    if (chatPerson) { openChatWithPerson(chatPerson.dataset.chatPerson); return; }
    const chatGroup = event.target.closest('[data-chat-group]');
    if (chatGroup) {
      const [scope, scopeId] = chatGroup.dataset.chatGroup.split(':');
      openChatWithGroup(scope, scopeId || '');
    }
  });

  document.getElementById('contactDialog')?.addEventListener('click', event => {
    if (event.target.id === 'contactDialog') closeDialog();
  });

  document.getElementById('chatSearch')?.addEventListener('input', event => {
    state.search = String(event.target.value || '').trim();
    renderDirectory();
  });

  window.refreshDirectory = refreshDirectory;
  window.resetDirectory = resetDirectory;
  window.openContactProfile = openContact;
  window.openGroupProfile = openGroup;
})();

window.$ = window.$ || ((selector) => document.querySelector(selector));
if (window.location.search && window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
const SESSION_KEY = 'portal-session-v1';
const SHARED_SCREENS = ['homeScreen', 'tasksScreen', 'birthdaysScreen', 'chatScreen', 'feedScreen', 'learningScreen'];
const DISABLED_SCREENS = ['managementScreen', 'mergeScreen', 'boardScreen'];
const PRIVATE_SCREENS = ['vendasScreen', 'movimentacoesScreen', 'emailCenterScreen'];
const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:5500' : '';
window.PORTAL_API_BASE = API_BASE;

const Access = {
  user: null,
  screens: [],
  sectors: [],
  token: localStorage.getItem(SESSION_KEY) || '',
};

function authHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (Access.token) headers.Authorization = `Bearer ${Access.token}`;
  return headers;
}

const PortalLoading = (() => {
  const active = new Set();
  const SILENT = [/^\/api\/chat/, /^\/api\/feed/, /^\/api\/me$/, /^\/api\/state$/, /^\/api\/tasks\/sync/, /^\/api\/system\/status/, /^\/api\/sabi$/, /^\/api\/contracts\/events/, /^\/api\/commissions\/events/, /^\/api\/notas\/job/, /^\/api\/recibos\/job/];
  let minUntil = 0;
  let fadeTimer = null;
  let waitTimer = null;
  let netActive = 0;
  let lastNetAt = 0;
  let apiSeq = 0;
  let screenSeq = 0;

  const node = () => document.getElementById('portalLoading');
  const titleNode = () => document.getElementById('portalLoadingTitle');
  const stepNode = () => document.getElementById('portalLoadingStep');

  function paint(title, step) {
    if (title && titleNode()) titleNode().textContent = title;
    if (step && stepNode()) stepNode().textContent = step;
  }

  function reveal() {
    const el = node();
    if (!el) return;
    clearTimeout(fadeTimer);
    fadeTimer = null;
    el.classList.remove('is-leaving');
    el.classList.add('is-visible');
    el.setAttribute('aria-busy', 'true');
  }

  function refresh() {
    const el = node();
    if (!el) return;
    clearTimeout(waitTimer);
    if (active.size) { reveal(); return; }
    const wait = minUntil - performance.now();
    if (wait > 0) { waitTimer = setTimeout(refresh, Math.ceil(wait)); return; }
    if (!el.classList.contains('is-visible')) { document.documentElement.classList.remove('portal-booting'); return; }
    el.classList.add('is-leaving');
    el.setAttribute('aria-busy', 'false');
    document.documentElement.classList.remove('portal-booting');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (active.size) { reveal(); return; }
      el.classList.remove('is-visible', 'is-leaving');
    }, 320);
  }

  function start(reason, options = {}) {
    if (!node()) return reason;
    active.add(reason);
    if (options.minMs) minUntil = Math.max(minUntil, performance.now() + options.minMs);
    paint(options.title, options.step);
    reveal();
    return reason;
  }

  function stop(reason) {
    active.delete(reason);
    refresh();
  }

  function isSilent(path) {
    const clean = path.split('?')[0];
    return SILENT.some(pattern => pattern.test(clean));
  }

  function netStart(path) {
    if (isSilent(path)) return false;
    netActive += 1;
    lastNetAt = performance.now();
    return true;
  }

  function netEnd() {
    netActive = Math.max(0, netActive - 1);
    lastNetAt = performance.now();
  }

  function autoLabel(path) {
    const clean = path.split('?')[0];
    const rules = [
      ['/api/cobranca', 'Consultando cobranças', 'Lendo os casos, empresas e envios no S4E…'],
      ['/api/vendas', 'Carregando vendas', 'Consultando vendas e cancelamentos no S4E…'],
      ['/api/notas', 'Conferindo notas', 'Comparando notas, lotes e vínculos oficiais…'],
      ['/api/recibos/previa', 'Consultando recibos', 'Lendo recibos e pagamentos das empresas…'],
      ['/api/recibos/run', 'Gerando recibos', 'Preparando os recibos do período…'],
      ['/api/recibos', 'Consultando recibos', 'Lendo recibos e pagamentos das empresas…'],
      ['/api/contracts', 'Carregando contratos', 'Buscando empresas, vidas e valores…'],
      ['/api/commissions', 'Carregando comissões', 'Buscando vendas, metas e comissões…'],
      ['/api/finance', 'Consultando rateios', 'Lendo os rateios do período…'],
      ['/api/movimentacoes', 'Carregando exclusões', 'Buscando os cancelamentos de vidas…'],
      ['/api/vidas', 'Carregando vidas', 'Preparando as vidas do contrato…'],
      ['/api/backup', 'Preparando o backup', 'Reunindo os dados do portal…'],
    ];
    const hit = rules.find(([prefix]) => clean.startsWith(prefix));
    return hit ? { title: hit[1], step: hit[2] } : null;
  }

  function trackRequest(path) {
    if (!node()) return { done() {} };
    const tracked = netStart(path);
    const label = tracked ? autoLabel(path) : null;
    let reason = null;
    const timer = label ? setTimeout(() => {
      reason = start('api:' + (++apiSeq), { title: label.title, step: label.step, minMs: 500 });
    }, 420) : null;
    return {
      done() {
        if (timer) clearTimeout(timer);
        if (reason) stop(reason);
        if (tracked) netEnd();
      },
    };
  }

  const SCREENS = {
    contractsScreen: ['Contratos e vidas', 'Buscando empresas, vidas e contratos…'],
    commissionsScreen: ['Comissões e vendas', 'Buscando vendas, metas e comissões…'],
    financeScreen: ['Rateios recebidos', 'Lendo os rateios do período…'],
    cobrancaScreen: ['Cobrança', 'Consultando os casos no S4E…'],
    retornosScreen: ['Retorno Instituição', 'Buscando erros e correções do período…'],
    vendasScreen: ['Acompanhamento de vendas', 'Consultando vendas e cancelamentos no S4E…'],
    vidasScreen: ['Vidas', 'Preparando a inclusão de vidas…'],
    apuracaoScreen: ['Apuração de empresas', 'Lendo o quadro do mês no S4E…'],
    notasScreen: ['Notas fiscais', 'Conferindo notas, lotes e vínculos…'],
    recibosScreen: ['Recibos', 'Lendo recibos e pagamentos das empresas…'],
    adesiScreen: ['Conferência de Adesões', 'Carregando dados de adesões…'],
  };

  function enterScreen(screenId) {
    const info = SCREENS[screenId];
    if (!info || !node()) return;
    const reason = 'screen:' + (++screenSeq);
    const begun = performance.now();
    start(reason, { title: info[0], step: info[1], minMs: 650 });
    const deadline = begun + 12000;
    const tick = () => {
      if (!active.has(reason)) return;
      const now = performance.now();
      const quiet = now - Math.max(lastNetAt, begun);
      if (now > deadline) { stop(reason); return; }
      if (netActive > 0 || quiet < 260 || now < minUntil) { setTimeout(tick, 110); return; }
      stop(reason);
    };
    setTimeout(tick, 90);
  }

  function step(text) { paint(null, text); }

  function endBoot() {
    document.documentElement.classList.remove('portal-booting');
    refresh();
  }

  if (document.documentElement.classList.contains('portal-booting')) {
    const el = node();
    if (el) {
      el.classList.add('is-visible');
      paint('Abrindo o portal', 'Restaurando sua sessão…');
    }
  }

  return { start, stop, step, enterScreen, trackRequest, endBoot, netStart, netEnd, isSilent };
})();
window.PortalLoading = PortalLoading;

async function api(path, options = {}) {
  if (Access.offline && !['/api/me', '/api/screens', '/api/sectors', '/api/state', '/api/tasks/sync', '/api/logout', '/api/login'].includes(path.split('?')[0])) {
    throw new Error('Esta função precisa de conexão. No modo offline, use apenas as demandas.');
  }
  const loading = PortalLoading.trackRequest(path);
  try {
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, { ...options, headers: authHeaders(options.headers || {}) });
    } catch {
      const error = new Error('Não foi possível conectar ao portal. Inicie o servidor e tente novamente.');
      error.code = 'network';
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearSession();
      showLogin(data.error || 'Faça login para continuar.');
      throw new Error('auth');
    }
    if (response.status === 423) {
      showSystemLock(data);
      throw new Error('locked');
    }
    if (!response.ok) {
      const error = new Error(data.error || 'Não foi possível concluir a ação.');
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    loading.done();
  }
}

function clearSession() {
  Access.offline = false;
  try { window.PortalOffline?.clearSession?.(Access.token); } catch {}
  window.PortalOffline?.end?.();
  window.resetContractNotifications?.();
  window.resetCommissionNotifications?.();
  Access.token = '';
  Access.user = null;
  localStorage.removeItem(SESSION_KEY);
  document.body.classList.add('locked');
  $('#sessionChip')?.classList.add('hidden');
  try { $('#profileDialog')?.close(); } catch {}
  try { $('#contactDialog')?.close(); } catch {}
  window.PortalNotify?.reset?.();
  window.resetChat?.();
  window.resetDirectory?.();
  window.leaveApuracaoScreen?.();
  window.leaveCobrancaScreen?.();
  window.resetRetornos?.();
  window.resetVendas?.();
  window.resetMovimentacoes?.();
  window.resetEmailCenter?.();
}

function showLogin(message = '') {
  document.body.classList.add('locked');
  const error = $('#loginError');
  if (!error) return;
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}

function showSystemLock(state = {}) {
  Access.offline = false;
  try { window.PortalOffline?.clearSession?.(Access.token); } catch {}
  window.PortalOffline?.end?.();
  window.resetContractNotifications?.();
  window.resetCommissionNotifications?.();
  Access.token = '';
  Access.user = null;
  localStorage.removeItem(SESSION_KEY);
  document.body.classList.add('locked', 'system-locked');
  const message = $('#lockMessage');
  if (message) message.textContent = state.message || 'O acesso ao portal está suspenso pela administração.';
  const since = $('#lockSince');
  if (since) {
    const at = state.since ? new Date(state.since) : null;
    since.textContent = at && !Number.isNaN(at.getTime()) ? `Bloqueado em ${at.toLocaleString('pt-BR')}.` : '';
    since.classList.toggle('hidden', !since.textContent);
  }
  try { $('#profileDialog')?.close(); } catch {}
  try { $('#contactDialog')?.close(); } catch {}
  window.PortalNotify?.reset?.();
  window.resetChat?.();
  window.resetDirectory?.();
  window.leaveApuracaoScreen?.();
  window.leaveCobrancaScreen?.();
  window.resetRetornos?.();
  window.resetVendas?.();
  window.resetMovimentacoes?.();
  window.resetEmailCenter?.();
}

async function checkSystemLock() {
  try {
    const response = await fetch(`${API_BASE}/api/system/status`, { headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) return false;
    const data = await response.json();
    if (data.locked) {
      showSystemLock(data);
      return true;
    }
  } catch {}
  return false;
}

function canSee(screenId) {
  if (!Access.user) return false;
  if (Access.offline) return screenId === 'tasksScreen';
  if (DISABLED_SCREENS.includes(screenId)) return false;
  if (screenId === 'emailCenterScreen') return false;
  if (screenId === 'vendasScreen') return Access.user.role === 'admin' && Access.screens.some(screen => screen.id === screenId);
  if (screenId === 'movimentacoesScreen') return Access.user.role === 'admin';
  if (Access.user.role === 'admin') return true;
  const allowedScreens = Access.user.allowedScreens || Access.user.screens || SHARED_SCREENS;
  if (allowedScreens.includes('*')) return true;
  // managementScreen só para quem tem flag management
  if (screenId === 'managementScreen') return !!Access.user.management;
  return allowedScreens.includes(screenId);
}

function isManager() {
  const user = Access.user;
  if (!user) return false;
  return user.role === 'admin' || (user.management || false);
}

// Responsáveis antigos/administrativos que não devem ser oferecidos nas demandas.
function isHiddenTaskOwner(name) {
  const value = String(name || '').trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower === 'eu' || lower === 'juliany') return true;
  return value === 'KAYNAN' || /^kaynan\s+admin$/i.test(value);
}
window.isHiddenTaskOwner = isHiddenTaskOwner;

function openScreen(screenId) {
  if (!canSee(screenId)) screenId = 'homeScreen';
  if (!canSee(screenId)) screenId = 'tasksScreen';
  PortalLoading.enterScreen(screenId);
  document.querySelectorAll('.nav-button').forEach(item => item.classList.toggle('active', item.dataset.screen === screenId));
  document.querySelectorAll('.screen').forEach(screen => screen.classList.toggle('hidden', screen.id !== screenId));
  const isTasks = screenId === 'tasksScreen';
  $('#newTaskButton')?.classList.toggle('hidden', !isTasks);
  $('#exportButton')?.classList.toggle('hidden', !isTasks);
  if (screenId === 'reportsScreen' && typeof renderReports === 'function') renderReports();
  if (screenId === 'mergeScreen') {
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof renderMergePreview === 'function') renderMergePreview();
  }
  if (screenId === 'learningScreen' && typeof renderLearning === 'function') renderLearning();
  if (screenId === 'weeklyScreen') window.enterWeeklyScreen?.();
  else window.leaveWeeklyScreen?.();
  if (screenId === 'adminScreen') {
    if (Access.user?.role === 'admin') renderAdmin();
    else screenId = 'tasksScreen';
  }
  if (screenId === 'contractsScreen') window.enterContractsScreen?.();
  if (screenId === 'commissionsScreen') window.enterCommissionsScreen?.();
  if (screenId === 'financeScreen') window.enterFinanceScreen?.();
  if (screenId === 'rateioScreen') window.enterRateioScreen?.();
  else window.leaveRateioScreen?.();
  if (screenId === 'odontoartScreen') window.Odontoart?.carregar();

  if (screenId === 'cobrancaScreen') window.enterCobrancaScreen?.();
  else window.leaveCobrancaScreen?.();
  if (screenId === 'retornosScreen') window.enterRetornosScreen?.();
  if (screenId === 'vendasScreen') window.enterVendasScreen?.();
  else window.leaveVendasScreen?.();
  if (screenId === 'vidasScreen') window.enterVidasScreen?.();
  else window.leaveVidasScreen?.();
  if (screenId === 'movimentacoesScreen') window.enterMovimentacoesScreen?.();
  else window.leaveMovimentacoesScreen?.();
  if (screenId === 'emailCenterScreen') window.enterEmailCenterScreen?.();
  else window.leaveEmailCenterScreen?.();
  if (screenId === 'apuracaoScreen') window.enterApuracaoScreen?.();
  else window.leaveApuracaoScreen?.();
  if (screenId === 'notasScreen') window.enterNotasScreen?.();
  else window.leaveNotasScreen?.();
  if (screenId === 'recibosScreen') window.enterRecibosScreen?.();
  else window.leaveRecibosScreen?.();
  if (screenId === 'adesiScreen') window.enterAdesiScreen?.();
  else window.leaveAdesiScreen?.();
  if (screenId === 'chatScreen') window.enterChatScreen?.();
  else window.leaveChatScreen?.();
  if (screenId === 'feedScreen') window.enterFeedScreen?.();
  else window.leaveFeedScreen?.();
  if (screenId === 'homeScreen') window.enterHomeScreen?.();
  else window.leaveHomeScreen?.();
}

function applyAccess() {
  document.querySelectorAll('.nav-button').forEach(button => {
    let allowed;
    if (Access.offline) allowed = canSee(button.dataset.screen);
    else if (['vendasScreen', 'emailCenterScreen'].includes(button.dataset.screen)) allowed = canSee(button.dataset.screen);
    else if (button.dataset.management) allowed = isManager();
    else if (button.dataset.adminOnly) allowed = Access.user?.role === 'admin';
    else allowed = canSee(button.dataset.screen);
    button.classList.toggle('hidden', !allowed);
  });
  document.querySelectorAll('#sidebarNav .nav-group').forEach(group => {
    group.classList.toggle('hidden', !group.querySelector('.nav-button:not(.hidden)'));
  });

  // reportButton: só admin e quem pode ver reportsScreen
  const reportBtn = $('#reportButton');
  if (reportBtn) reportBtn.classList.toggle('hidden', !canSee('reportsScreen'));

  const active = document.querySelector('.nav-button.active');
  if (!active || active.classList.contains('hidden')) openScreen('homeScreen');
  $('#sessionName').textContent = Access.user.displayName;
  applyAvatarPhoto($('#sessionAvatar'), Access.user.photo, Access.user.displayName);
  $('#sessionChip').classList.remove('hidden');
  if (typeof window.refreshOwnerFilter === 'function') window.refreshOwnerFilter();
  if (typeof window.syncManagerScopeTabs === 'function') window.syncManagerScopeTabs();
  if (typeof window.refreshTaskCategory === 'function') window.refreshTaskCategory();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function applyAvatarPhoto(element, photo, name) {
  if (!element) return;
  element.classList.toggle('has-photo', Boolean(photo));
  if (photo) {
    element.textContent = '';
    element.style.setProperty('background-image', `url("${photo}")`, 'important');
  } else {
    element.textContent = String(name || '?').charAt(0).toUpperCase();
    element.style.removeProperty('background-image');
  }
}

function avatarMarkup(user, className, fallback = '?') {
  const photo = user?.photo || '';
  if (photo) return `<span class="${className} has-photo" style="background-image:url(${photo})!important"></span>`;
  return `<span class="${className}">${escapeHtml((user?.displayName || fallback).charAt(0).toUpperCase())}</span>`;
}

function notify(message, tone = 'success') {
  if (typeof window.showToast === 'function') window.showToast(message, tone);
  else alert(message);
}

function renderProfile() {
  const user = Access.user;
  if (!user) return;
  applyAvatarPhoto($('#profileAvatar'), user.photo, user.displayName);
  $('#profileDisplayName').textContent = user.displayName;
  const role = user.role === 'admin' ? 'Administrador' : 'Equipe';
  const sector = user.sectorName || (user.sectors || []).map(item => item.name).join(', ');
  $('#profileMeta').textContent = [`@${user.username}`, role, sector].filter(Boolean).join(' · ');
  $('#profilePhotoRemove').hidden = !user.photo;
  renderStatusEditor();
  window.renderCompletionSoundPreference?.();
}

function openProfile() {
  if (!Access.user) return;
  renderProfile();
  const dialog = $('#profileDialog');
  if (!dialog || dialog.open) return;
  const input = $('#profilePhotoInput');
  if (input) input.value = '';
  dialog.showModal();
}

async function saveProfilePhoto(photo) {
  try {
    const data = await api('/api/me/photo', { method: 'PUT', body: JSON.stringify({ photo }) });
    Access.user = { ...Access.user, ...data.user };
    applyAccess();
    renderProfile();
    notify(photo ? 'Foto de perfil atualizada.' : 'Foto de perfil removida.');
  } catch (error) {
    if (error.message !== 'auth') notify(error.message, 'warning');
  }
}

function statusDuration(user) {
  const until = user?.status?.until || '';
  if (!until) return 'never';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return until === today ? 'today' : 'week';
}

function renderStatusPreview() {
  const preview = $('#profileStatusPreview');
  if (!preview) return;
  const emoji = $('#profileStatusEmoji')?.value || '';
  const text = ($('#profileStatusText')?.value || '').trim();
  const duration = $('#profileStatusDuration')?.value || 'never';
  if (!text) {
    preview.textContent = 'Seu status aparece aqui para o time.';
    preview.classList.add('is-empty');
    return;
  }
  const suffix = duration === 'today' ? 'some hoje' : duration === 'week' ? 'some no fim da semana' : '';
  preview.textContent = `${emoji ? `${emoji} ` : ''}${text}${suffix ? ` · ${suffix}` : ''}`;
  preview.classList.remove('is-empty');
}

function renderStatusEditor() {
  const emoji = $('#profileStatusEmoji');
  const text = $('#profileStatusText');
  const duration = $('#profileStatusDuration');
  if (!emoji || !text || !duration) return;
  const status = Access.user?.status || {};
  emoji.value = status.emoji || '';
  text.value = status.text || '';
  duration.value = statusDuration(Access.user);
  const clear = $('#profileStatusClear');
  if (clear) clear.hidden = !status.text;
  renderStatusPreview();
}

async function saveProfileStatus() {
  const text = ($('#profileStatusText')?.value || '').trim();
  try {
    const data = await api('/api/me/status', {
      method: 'PUT',
      body: JSON.stringify({
        emoji: $('#profileStatusEmoji')?.value || '',
        text,
        duration: $('#profileStatusDuration')?.value || 'never',
      }),
    });
    Access.user = { ...Access.user, ...data.user };
    applyAccess();
    renderProfile();
    window.refreshDirectory?.();
    window.refreshChatConversations?.();
    notify(text ? 'Status atualizado para o time.' : 'Status removido.');
  } catch (error) {
    if (error.message !== 'auth') notify(error.message, 'warning');
  }
}

function renderCustomScreens() {
  const host = $('#customScreens');
  const nav = $('#customNav');
  const sectorScreens = Access.screens.filter(screen => screen.kind === 'sector' && canSee(screen.id));
  nav.innerHTML = sectorScreens.map(screen => `<button class="nav-button" type="button" data-screen="${escapeHtml(screen.id)}" title="${escapeHtml(screen.name)}"><span class="nav-icon">◈</span><span class="nav-text">${escapeHtml(screen.name)}</span></button>`).join('');
  host.innerHTML = sectorScreens.map(screen => {
    const items = Array.isArray(screen.content?.items) ? screen.content.items : [];
    return `<div id="${escapeHtml(screen.id)}" class="screen hidden">
      <section class="learning-hero">
        <div>
          <p class="eyebrow">${escapeHtml(screen.sector || 'SETOR')}</p>
          <h2>${escapeHtml(screen.name)}</h2>
          <p class="panel-help">${escapeHtml(screen.description || 'Tela exclusiva deste setor.')}</p>
        </div>
      </section>
      <section class="mail-merge-panel">
        <h3>Anotações do setor</h3>
        <label>Recados, regras e combinados<textarea data-sector-notes="${escapeHtml(screen.id)}" rows="8">${escapeHtml(screen.content?.notes || '')}</textarea></label>
        <div class="form-actions"><button class="button button-primary" type="button" data-save-sector="${escapeHtml(screen.id)}">Salvar anotações</button></div>
      </section>
      <section class="history-panel">
        <div class="report-heading"><div><p class="eyebrow">CHECKLIST</p><h2>Pendências do setor</h2></div></div>
        <form class="quick-add sector-add" data-sector-form="${escapeHtml(screen.id)}">
          <label>Novo item<input required maxlength="160" placeholder="Ex.: conferir lote do dia"></label>
          <button class="button button-primary" type="submit">Adicionar</button>
        </form>
        <div class="sector-items">${items.map(item => `<div class="resource-item"><label class="check-label"><input type="checkbox" data-toggle-item="${escapeHtml(screen.id)}" data-item-id="${escapeHtml(item.id)}" ${item.done ? 'checked' : ''}><strong>${escapeHtml(item.text)}</strong></label><button class="icon-action" data-delete-item="${escapeHtml(screen.id)}" data-item-id="${escapeHtml(item.id)}">×</button></div>`).join('') || '<p class="empty-state">Nenhum item ainda.</p>'}</div>
      </section>
    </div>`;
  }).join('');
}

function findScreen(id) {
  return Access.screens.find(screen => screen.id === id);
}

async function saveSectorContent(screenId, content) {
  const data = await api(`/api/screens/${screenId}`, { method: 'PUT', body: JSON.stringify({ content }) });
  const index = Access.screens.findIndex(screen => screen.id === screenId);
  if (index >= 0) Access.screens[index] = data.screen;
  renderCustomScreens();
  applyAccess();
  openScreen(screenId);
}

function screenChecksHtml(selected = []) {
  const assignable = Access.screens.filter(s => !PRIVATE_SCREENS.includes(s.id) && !SHARED_SCREENS.includes(s.id) && !DISABLED_SCREENS.includes(s.id));
  const builtins = assignable.filter(s => s.kind === 'builtin');
  const sectors  = assignable.filter(s => s.kind !== 'builtin');
  const row = s => `<label class="check-label"><input type="checkbox" name="userScreen" value="${escapeHtml(s.id)}" ${selected.includes(s.id) ? 'checked' : ''}><span><strong>${escapeHtml(s.name)}</strong> · ${escapeHtml(s.sector || s.kind)}</span></label>`;
  const shared = SHARED_SCREENS.map(id => Access.screens.find(s => s.id === id)).filter(Boolean);
  const lockedRow = (s, note) => `<label class="check-label check-locked"><input type="checkbox" checked disabled><span><strong>${escapeHtml(s.name)}</strong> · ${escapeHtml(note)}</span></label>`;
  let html = '';
  if (shared.length) {
    html += `<p class="eyebrow" style="margin:10px 0 4px">TELAS DE TODO MUNDO</p>`
      + shared.map(s => lockedRow(s, 'liberada para todos')).join('');
  }
  if (builtins.length) html += `<p class="eyebrow" style="margin:10px 0 4px">TELAS NATIVAS</p>` + builtins.map(row).join('');
  if (sectors.length)  html += `<p class="eyebrow" style="margin:10px 0 4px">TELAS DE SETOR</p>`  + sectors.map(row).join('');
  if (!assignable.length) html += '<p class="panel-help">Nenhuma tela adicional disponível. Crie uma tela de setor ao lado.</p>';
  return html;
}

function fmtBirthday(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

function birthdayCountdown(item) {
  if (item.daysUntil === 0) return 'É hoje';
  if (item.daysUntil === 1) return 'Amanhã';
  return `Em ${item.daysUntil} dias`;
}

async function loadAdminLists() {
  if (Access.user?.role !== 'admin') return;
  const [usersData, screensData, sectorsData, birthdaysData] = await Promise.all([
    api('/api/users'),
    api('/api/screens'),
    api('/api/sectors'),
    api('/api/birthdays').catch(() => ({ birthdays: [] })),
  ]);
  Access.screens = screensData.screens || [];
  Access.sectors = sectorsData.sectors || [];
  window.__portalUsers = usersData.users || [];
  window.__portalBirthdays = birthdaysData.birthdays || [];
  renderSectorOptions();
  renderUserList(usersData.users || []);
  renderScreenCatalog();
  renderSectorCatalog();
  $('#taskSector').innerHTML = '<option value="">Selecione um setor</option>' + Access.sectors.map(sector => `<option value="${escapeHtml(sector.id)}">${escapeHtml(sector.name)}</option>`).join('');
  if (!$('#editUserId').value) $('#userScreenChecks').innerHTML = screenChecksHtml();
  renderAdminDashboard();
}

function renderAdminDashboard() {
  const users = window.__portalUsers || [];
  const birthdays = window.__portalBirthdays || [];
  const announcements = window.__portalAnnouncements || [];
  const activeAnn = announcements.filter(item => item.active);
  const month = new Date().getMonth() + 1;
  const monthBirthdays = birthdays.filter(item => item.month === month);

  // Ícones em SVG de traço — mesma família visual da tela de Início.
  const admSvg = corpo => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corpo}</svg>`;
  const kpis = [
    { label: 'Contas ativas', value: users.length, hint: `${users.filter(u => u.role === 'admin').length} administrador(es)`, icon: admSvg('<circle cx="9" cy="8" r="3.4"/><path d="M3 20c.9-3.7 3.2-5.6 6-5.6s5.1 1.9 6 5.6"/><path d="M16.5 6.2a3 3 0 0 1 0 5.6M17.5 14.6c2 .6 3.3 2.4 3.9 5.4"/>'), tone: 'teal' },
    { label: 'Setores', value: Access.sectors.length, hint: 'estrutura do portal', icon: admSvg('<rect x="3.5" y="4.5" width="7" height="6" rx="2"/><rect x="13.5" y="4.5" width="7" height="6" rx="2"/><rect x="8.5" y="14" width="7" height="6" rx="2"/><path d="M7 10.5v1.5a2 2 0 0 0 2 2h.5M17 10.5v1.5a2 2 0 0 1-2 2h-.5"/>'), tone: 'blue' },
    { label: 'Telas', value: Access.screens.length, hint: `${Access.screens.filter(s => s.kind === 'sector').length} de setor`, icon: admSvg('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/>'), tone: 'purple' },
    { label: 'Comunicados', value: activeAnn.length, hint: `${announcements.length} no total`, icon: admSvg('<path d="M4 11.5v-1a2 2 0 0 1 2-2h1.6l7-3.6v13.2l-7-3.6H6a2 2 0 0 1-2-2z"/><path d="M17.5 8.6a4.6 4.6 0 0 1 0 6.8"/>'), tone: 'amber' },
    { label: 'Aniversários no mês', value: monthBirthdays.length, hint: `${birthdays.length} cadastrados`, icon: admSvg('<path d="M4 20.5h16M5.5 20.5v-6a2.5 2.5 0 0 1 2.5-2.5h8a2.5 2.5 0 0 1 2.5 2.5v6"/><path d="M5.5 16.5c1.6 1.4 3.2 1.4 4.8 0s3.2-1.4 4.8 0 3.2 1.4 3.4 0"/><path d="M12 12V9.5M12 6.5v.01"/>'), tone: 'pink' },
  ];
  const kpiHost = document.getElementById('adminKpis');
  if (kpiHost) {
    kpiHost.innerHTML = kpis.map(kpi => `
      <article class="admin-kpi adm-tone-${kpi.tone}">
        <span class="admin-kpi-icon">${kpi.icon}</span>
        <span class="admin-kpi-body">
          <strong>${kpi.value}</strong>
          <span class="admin-kpi-label">${kpi.label}</span>
          <small>${kpi.hint}</small>
        </span>
      </article>`).join('');
  }

  const recentHost = document.getElementById('adminRecentUsers');
  if (recentHost) {
    const recent = [...users].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 5);
    recentHost.innerHTML = recent.map(user => `
      <div class="admin-person-row">
        ${avatarMarkup(user, 'admin-avatar')}
        <div class="admin-person-copy">
          <strong>${escapeHtml(user.displayName)}</strong>
          <small>${user.role === 'admin' ? 'Administrador' : 'Usuário'}${user.management ? ' · gestor(a)' : ''}</small>
        </div>
        <span class="admin-tag ${user.role === 'admin' ? 'admin-tag-strong' : ''}">${user.role === 'admin' ? 'admin' : 'equipe'}</span>
      </div>`).join('') || '<p class="empty-state">Nenhuma conta ainda.</p>';
  }

  const bdPreview = document.getElementById('adminBirthdayPreview');
  if (bdPreview) {
    bdPreview.innerHTML = birthdays.slice(0, 4).map(item => `
      <div class="admin-bd-row">
        <span class="admin-bd-day">${String(item.day).padStart(2, '0')}<small>/${String(item.month).padStart(2, '0')}</small></span>
        ${(item.photo || item.profilePhoto) ? `<span class="admin-bd-photo"><img src="${escapeHtml(item.photo || item.profilePhoto)}" alt=""></span>` : ''}
        <div class="admin-person-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.sector || 'Sem setor')}</small></div>
        <span class="admin-tag">${birthdayCountdown(item)}</span>
      </div>`).join('') || '<p class="empty-state">Nenhuma data cadastrada.</p>';
  }

  const structureHost = document.getElementById('adminStructurePreview');
  if (structureHost) {
    structureHost.innerHTML = `
      <p class="admin-chips-label">Setores</p>
      <div class="admin-chip-row">${Access.sectors.map(s => `<span class="admin-chip">${escapeHtml(s.name)}</span>`).join('') || '<span class="admin-missing">Nenhum setor</span>'}</div>
      <p class="admin-chips-label">Telas de setor</p>
      <div class="admin-chip-row">${Access.screens.filter(s => s.kind === 'sector').map(s => `<span class="admin-chip">${escapeHtml(s.name)}</span>`).join('') || '<span class="admin-missing">Nenhuma tela específica</span>'}</div>`;
  }

  const eventsHost = document.getElementById('adminEventsPreview');
  if (eventsHost) {
    eventsHost.innerHTML = announcements.slice(0, 3).map(item => `
      <div class="admin-person-row">
        <span class="admin-person-copy"><strong>${escapeHtml(item.title)}</strong><small>${item.active ? 'Ativo' : 'Inativo'}</small></span>
        <span class="admin-tag ${item.active ? '' : 'admin-tag-muted'}">${item.active ? 'no ar' : 'pausado'}</span>
      </div>`).join('') || '<p class="empty-state">Nenhum comunicado publicado.</p>';
  }

  renderAdminBirthdays();
}

function renderAdminBirthdays() {
  const users = window.__portalUsers || [];
  const birthdays = window.__portalBirthdays || [];
  fillBirthdaySelects();
  renderBirthdayUserOptions();
  const host = document.getElementById('adminBirthdays');
  if (host) {
    host.innerHTML = birthdays.map(item => {
      const legacy = String(item.id).startsWith('user-');
      const action = legacy
        ? `data-edit-user="${escapeHtml(item.userId || '')}"`
        : `data-edit-birthday="${escapeHtml(item.id)}"`;
      const kindTag = item.kind === 'partner' ? '<span class="admin-tag admin-tag-muted">parceiro</span>' : '<span class="admin-tag">time</span>';
      return `
        <article class="admin-item admin-bd-item">
          <span class="admin-bd-day">${String(item.day).padStart(2, '0')}<small>/${String(item.month).padStart(2, '0')}</small></span>
          ${(item.photo || item.profilePhoto) ? `<span class="admin-bd-photo"><img src="${escapeHtml(item.photo || item.profilePhoto)}" alt=""></span>` : ''}
          <div class="admin-person-copy">
            <strong>${escapeHtml(item.name)} ${kindTag}</strong>
            <small>${fmtBirthday(item.birthday)}${item.age ? ` · faz ${item.age} anos` : ''}${item.sector ? ` · ${escapeHtml(item.sector)}` : ''}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small>
            <small>${item.daysUntil === 0 ? 'Hoje é o dia!' : `Próximo: ${new Date(`${item.nextDate}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}`}</small>
          </div>
          <div class="admin-item-actions">
            <button type="button" class="button button-secondary" ${action}>Editar</button>
            ${legacy ? '' : `<button type="button" class="button button-secondary" data-delete-birthday="${escapeHtml(item.id)}">Excluir</button>`}
          </div>
        </article>`;
    }).join('') || '<p class="empty-state">Nenhuma data cadastrada ainda.</p>';
  }

  const missingHost = document.getElementById('adminBirthdaysMissing');
  if (missingHost) {
    const linked = new Set(birthdays.map(item => item.userId).filter(Boolean));
    const missing = users.filter(user => !user.birthday && !linked.has(user.id));
    missingHost.innerHTML = missing.map(user => `
      <article class="admin-item">
        <div class="admin-person-copy"><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)}</small></div>
        <div class="admin-item-actions"><button type="button" class="button button-secondary" data-prefill-birthday="${escapeHtml(user.id)}">Cadastrar data</button></div>
      </article>`).join('') || '<p class="empty-state">Todo mundo já tem data cadastrada.</p>';
  }
}

const BIRTHDAY_MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
let birthdayPhotoData = '';

function setBirthdayPhoto(data) {
  birthdayPhotoData = data || '';
  const preview = $('#birthdayPhotoPreview');
  const remove = $('#removeBirthdayPhoto');
  if (preview) {
    if (birthdayPhotoData) {
      preview.src = birthdayPhotoData;
      preview.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
    }
  }
  if (remove) remove.hidden = !birthdayPhotoData;
}

function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
      image.onload = () => {
        const max = 360;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function fillBirthdaySelects() {
  const day = $('#birthdayDay');
  if (day && day.options.length <= 1) {
    day.innerHTML = '<option value="">Dia</option>' + Array.from({ length: 31 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join('');
  }
  const month = $('#birthdayMonth');
  if (month && month.options.length <= 1) {
    month.innerHTML = '<option value="">Mês</option>' + BIRTHDAY_MONTHS.map((name, index) => `<option value="${index + 1}">${name}</option>`).join('');
  }
}

function renderBirthdayUserOptions() {
  const select = $('#birthdayUser');
  if (!select) return;
  const users = window.__portalUsers || [];
  const current = select.value;
  select.innerHTML = '<option value="">Sem conta vinculada</option>' + users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)} (${escapeHtml(user.username)})</option>`).join('');
  select.value = current;
}

function resetBirthdayForm() {
  const form = $('#birthdayForm');
  if (!form) return;
  form.reset();
  $('#birthdayId').value = '';
  $('#birthdayKind').value = 'team';
  $('#birthdayUser').value = '';
  $('#birthdayFormTitle').textContent = 'Novo aniversariante';
  $('#saveBirthdayButton').textContent = 'Salvar aniversariante';
  $('#cancelBirthdayEdit').hidden = true;
  setBirthdayPhoto('');
}

function editBirthday(birthdayId) {
  const item = (window.__portalBirthdays || []).find(entry => entry.id === birthdayId);
  if (!item) return;
  showAdminTab('birthdays');
  fillBirthdaySelects();
  renderBirthdayUserOptions();
  $('#birthdayId').value = item.id;
  $('#birthdayName').value = item.name || '';
  $('#birthdayDay').value = String(item.day || '');
  $('#birthdayMonth').value = String(item.month || '');
  $('#birthdayYear').value = item.year || '';
  $('#birthdayKind').value = item.kind === 'partner' ? 'partner' : 'team';
  $('#birthdayUser').value = item.userId || '';
  $('#birthdayNote').value = item.note || '';
  setBirthdayPhoto(item.photo || '');
  $('#birthdayFormTitle').textContent = 'Editando aniversariante';
  $('#saveBirthdayButton').textContent = 'Salvar alterações';
  $('#cancelBirthdayEdit').hidden = false;
  $('#birthdayForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function prefillBirthdayForUser(userId) {
  const user = (window.__portalUsers || []).find(entry => entry.id === userId);
  if (!user) return;
  showAdminTab('birthdays');
  resetBirthdayForm();
  fillBirthdaySelects();
  renderBirthdayUserOptions();
  $('#birthdayName').value = user.displayName || '';
  $('#birthdayUser').value = user.id;
  $('#birthdayDay').focus();
  $('#birthdayForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function showAdminTab(name) {
  document.querySelectorAll('[data-admin-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.adminTab === name));
  document.querySelectorAll('[data-admin-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.adminPanel === name));
}

function editUser(userId) {
  const users = window.__portalUsers || [];
  const user = users.find(item => item.id === userId);
  if (!user) return;
  showAdminTab('people');
  $('#editUserId').value = user.id;
  $('#userDisplayName').value = user.displayName;
  $('#userUsername').value = user.username;
  $('#userUsername').disabled = true;
  $('#userRole').value = user.role;
  $('#userManagement').checked = !!user.management;
  $('#userActive').checked = user.active !== false;
  $('#userWorksSaturday').checked = !!user.worksSaturday;
  $('#userWorksSunday').checked = !!user.worksSunday;
  if ($('#userSellerName')) $('#userSellerName').value = user.sellerName || '';
  const birthday = $('#userBirthday');
  if (birthday) {
    const registry = (window.__portalBirthdays || []).find(item => item.userId === user.id && item.year);
    birthday.value = user.birthday || (registry ? `${registry.year}-${String(registry.month).padStart(2, '0')}-${String(registry.day).padStart(2, '0')}` : '');
  }
  document.querySelectorAll('input[name="userSector"]').forEach(input => { input.checked = (user.sectorIds || [user.sectorId]).includes(input.value); });
  $('#userPassword').required = false;
  $('#userPassword').value = '';
  $('#userPassword').placeholder = 'deixe em branco para manter';
  $('#saveUserButton').textContent = 'Salvar alterações';
  $('#userScreenChecks').innerHTML = screenChecksHtml(user.screens || []);
  document.getElementById('userForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderAdmin() {
  try {
    await loadAdminLists();
  } catch (error) {
    if (error.message !== 'auth') alert(error.message);
  }
}

function renderSectorOptions() {
  const options = '<option value="">Selecione um setor</option>' + Access.sectors.map(sector => `<option value="${escapeHtml(sector.id)}">${escapeHtml(sector.name)}</option>`).join('');
  $('#screenSector').innerHTML = options;
  $('#userSectorsChecks').innerHTML = Access.sectors.map(sector => `<label class="check-label"><input type="checkbox" name="userSector" value="${escapeHtml(sector.id)}"><span>${escapeHtml(sector.name)}</span></label>`).join('');
}

function renderSectorCatalog() {
  const sectorIcon = '<span class="adm-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="7" height="6" rx="2"/><rect x="13.5" y="4.5" width="7" height="6" rx="2"/><rect x="8.5" y="14" width="7" height="6" rx="2"/><path d="M7 10.5v1.5a2 2 0 0 0 2 2h.5M17 10.5v1.5a2 2 0 0 1-2 2h-.5"/></svg></span>';
  $('#sectorsList').innerHTML = Access.sectors.map(sector => `
    <article class="admin-item adm-item">
      ${sectorIcon}
      <div class="adm-item-copy">
        <strong>${escapeHtml(sector.name)}</strong>
        <small>${escapeHtml(sector.description || 'Sem descrição')}</small>
      </div>
      ${sector.id === 'cadastro-faturamento'
        ? '<span class="adm-chip-sm is-muted">padrão</span>'
        : `<button type="button" class="adm-icon-btn is-danger" data-delete-sector="${escapeHtml(sector.id)}" aria-label="Excluir setor" title="Excluir setor"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/></svg></button>`}
    </article>`).join('') || '<p class="empty-state">Nenhum setor cadastrado.</p>';
}

function renderUserList(users) {
  const birthdays = window.__portalBirthdays || [];
  $('#usersList').innerHTML = users.map(user => {
    const registry = birthdays.find(item => item.userId === user.id);
    const registryIso = registry ? `${registry.year || 2026}-${String(registry.month).padStart(2, '0')}-${String(registry.day).padStart(2, '0')}` : '';
    const dateLabel = user.birthday ? fmtBirthday(user.birthday) : registry ? fmtBirthday(registryIso) : '<span class="admin-missing">não informado</span>';
    const dateNote = !user.birthday && registry && !registry.year ? ' · <span class="admin-missing">sem ano</span>' : '';
    const weekendDays = [user.worksSaturday ? 'sábado' : '', user.worksSunday ? 'domingo' : ''].filter(Boolean);
    const scheduleLabel = weekendDays.length ? `trabalha ${weekendDays.join(' e ')}` : 'só de segunda a sexta';
    const extraScreens = (user.screens || []).map(id => Access.screens.find(screen => screen.id === id)?.name || id);
    const isBlocked = user.active === false;
    return `
    <article class="admin-item admin-person-card${isBlocked ? ' is-blocked' : ''}">
      <span class="adm-person-lead">
        ${avatarMarkup(user, 'admin-avatar')}
        <span class="adm-person-state" title="${isBlocked ? 'Acesso bloqueado' : 'Acesso liberado'}"></span>
      </span>
      <div class="admin-person-copy">
        <div class="adm-person-title">
          <strong>${escapeHtml(user.displayName)}</strong>
          <span class="admin-tag ${user.role === 'admin' ? 'admin-tag-strong' : ''}">${user.role === 'admin' ? 'admin' : 'equipe'}</span>
          ${user.management ? '<span class="admin-tag admin-tag-strong">gestor</span>' : ''}
          ${isBlocked ? '<span class="admin-tag admin-tag-muted">bloqueado</span>' : ''}
        </div>
        <div class="adm-meta">
          <span class="adm-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.4"/><path d="M4 20c1.4-3.4 4.4-5.3 8-5.3s6.6 1.9 8 5.3"/></svg>@${escapeHtml(user.username)}</span>
          <span class="adm-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20.5h16M5.5 20.5v-6a2.5 2.5 0 0 1 2.5-2.5h8a2.5 2.5 0 0 1 2.5 2.5v6"/><path d="M12 12V9.5M12 6.5v.01"/></svg>${dateLabel}${dateNote}</span>
          <span class="adm-meta-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/></svg>${scheduleLabel}</span>
        </div>
        <div class="adm-screen-chips">
          ${extraScreens.length
            ? extraScreens.map(name => `<span class="adm-chip-sm">${escapeHtml(name)}</span>`).join('')
            : '<span class="adm-chip-sm is-muted">somente as telas comuns</span>'}
        </div>
      </div>
      <div class="admin-item-actions adm-actions">
        <button type="button" class="adm-btn" data-edit-user="${user.id}">Editar</button>
        ${user.id === Access.user?.id ? '' : `<button type="button" class="adm-btn${isBlocked ? '' : ' is-warn'}" data-toggle-user="${user.id}" data-active="${isBlocked ? '0' : '1'}">${isBlocked ? 'Liberar' : 'Bloquear'}</button>
        <button type="button" class="adm-icon-btn is-danger" data-delete-user="${user.id}" aria-label="Excluir conta" title="Excluir conta"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/></svg></button>`}
      </div>
    </article>`;
  }).join('') || '<p class="empty-state">Nenhuma conta ainda.</p>';
  window.__portalUsers = users;
}

function renderScreenCatalog() {
  const screenIcon = '<span class="adm-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17"/><circle cx="7" cy="7" r="1" fill="currentColor" stroke="none"/></svg></span>';
  const people = (window.__portalUsers || []).filter(user => user.role !== 'admin' && user.active !== false);
  const releasedTo = screenId => people.filter(user => (user.screens || []).includes(screenId)).length;
  $('#screensList').innerHTML = Access.screens.map(screen => {
    const count = releasedTo(screen.id);
    let actions = '';
    if (SHARED_SCREENS.includes(screen.id)) {
      actions = '<span class="adm-chip-sm is-muted">liberada para todos</span>';
    } else if (PRIVATE_SCREENS.includes(screen.id) || DISABLED_SCREENS.includes(screen.id)) {
      actions = '<span class="adm-chip-sm is-muted">somente administração</span>';
    } else {
      const label = count ? `Recolher da equipe (${count})` : 'Liberar para a equipe';
      actions = `<button type="button" class="adm-btn${count ? ' is-warn' : ''}" data-release-screen="${escapeHtml(screen.id)}" data-release="${count ? '0' : '1'}">${label}</button>`;
    }
    if (screen.kind === 'sector') {
      actions += `<button type="button" class="adm-icon-btn is-danger" data-delete-screen="${escapeHtml(screen.id)}" aria-label="Excluir tela" title="Excluir tela"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7"/></svg></button>`;
    }
    return `
    <article class="admin-item adm-item">
      ${screenIcon}
      <div class="adm-item-copy">
        <div class="adm-person-title">
          <strong>${escapeHtml(screen.name)}</strong>
          <span class="adm-chip-sm">${screen.kind === 'builtin' ? 'nativa' : 'de setor'}</span>
        </div>
        <small>${escapeHtml(screen.sector || 'Geral')}${screen.description ? ' · ' + escapeHtml(screen.description) : ''}</small>
      </div>
      <div class="adm-actions">${actions}</div>
    </article>`;
  }).join('') || '<p class="empty-state">Nenhuma tela cadastrada.</p>';
}

async function renderAdmin() {
  try {
    await loadAdminLists();
  } catch (error) {
    if (error.message !== 'auth') alert(error.message);
  }
}

async function renderAdmin() {
  try {
    await loadAdminLists();
  } catch (error) {
    if (error.message !== 'auth') alert(error.message);
  }
}

function resetUserForm() {
  $('#userForm').reset();
  $('#editUserId').value = '';
  $('#userUsername').disabled = false;
  $('#userPassword').required = true;
  $('#userPassword').placeholder = 'mínimo 4 caracteres';
  document.querySelectorAll('input[name="userSector"]').forEach(input => { input.checked = false; });
  $('#userManagement').checked = false;
  $('#userActive').checked = true;
  $('#userWorksSaturday').checked = false;
  $('#userWorksSunday').checked = false;
  if ($('#userSellerName')) $('#userSellerName').value = '';
  const birthday = $('#userBirthday');
  if (birthday) birthday.value = '';
  $('#saveUserButton').textContent = 'Criar conta';
  $('#userScreenChecks').innerHTML = screenChecksHtml();
}

async function startSession(user, screens) {
  Access.offline = false;
  Access.user = user;
  Access.screens = screens || [];
  if (user.role === 'admin') {
    const sectors = await api('/api/sectors');
    Access.sectors = sectors.sectors || [];
  }
  window.PortalOffline.begin(user, Access.token);
  document.body.classList.remove('locked');
  renderCustomScreens();
  applyAccess();
  openScreen('homeScreen');
  window.PortalNotify?.refresh?.();
  window.startRetornosPolling?.();
  window.startContractNotifications?.();
  window.startCommissionNotifications?.();
  setTimeout(() => window.loadAnnouncements?.(), 400);
  setTimeout(() => window.refreshChatConversations?.(), 700);
}

function enterOfflineSession() {
  if (!Access.token) return false;
  const cached = window.PortalOffline.readSession(Access.token);
  if (!cached) {
    Access.offline = true;
    Access.user = null;
    showLogin('Para trabalhar offline, entre online neste navegador primeiro. O acesso local vale por até 24 horas.');
    return false;
  }
  if (Access.offline && Access.user?.id === cached.user.id) return true;
  if (!Access.offline) {
    window.resetRetornos?.();
    window.resetContractNotifications?.();
    window.resetCommissionNotifications?.();
    window.resetChat?.();
  }
  Access.offline = true;
  Access.user = cached.user;
  Access.screens = cached.screens;
  Access.sectors = cached.sectors;
  if (window.PortalOffline.getStatus().userId !== String(cached.user.id)) window.PortalOffline.begin(cached.user, Access.token);
  document.body.classList.remove('locked');
  applyAccess();
  openScreen('tasksScreen');
  return true;
}

async function refreshSessionForSync() {
  const token = Access.token;
  if (!token) throw new Error('Sessão encerrada');
  const me = await api('/api/me');
  if (Access.token !== token) throw new Error('Sessão alterada');
  const recovering = Access.offline;
  if (recovering) {
    const screens = await api('/api/screens');
    const sectors = me.user.role === 'admin' ? await api('/api/sectors') : { sectors: [] };
    if (Access.token !== token) throw new Error('Sessão alterada');
    Access.screens = screens.screens;
    Access.sectors = sectors.sectors;
  }
  Access.user = me.user;
  Access.offline = false;
  window.PortalOffline.saveSession({ user: Access.user, screens: Access.screens, sectors: Access.sectors }, token);
  document.body.classList.remove('locked');
  applyAccess();
  if (recovering) {
    window.startRetornosPolling?.();
    window.startContractNotifications?.();
    window.startCommissionNotifications?.();
    window.PortalOffline.registerWorker().catch(() => {});
  }
}

function rejectOfflineAuth(status) {
  if (status === 423) showSystemLock();
  else { clearSession(); showLogin('Sua sessão foi recusada. Entre novamente para sincronizar suas alterações.'); }
}

async function restoreSession() {
  if (await checkSystemLock()) { PortalLoading.endBoot(); return false; }
  if (!Access.token) {
    PortalLoading.endBoot();
    showLogin();
    return false;
  }
  try {
    const me = await api('/api/me');
    const screens = await api('/api/screens');
    await startSession(me.user, screens.screens);
    return true;
  } catch (error) {
    if (error.message === 'locked') return false;
    clearSession();
    showLogin();
    PortalLoading.endBoot();
    return false;
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginError').classList.add('hidden');
  PortalLoading.start('login', { title: 'Entrando no portal', step: 'Validando seu usuário…', minMs: 700 });
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPassword').value }),
    });
    Access.token = data.token;
    localStorage.setItem(SESSION_KEY, data.token);
    PortalLoading.step('Carregando suas telas…');
    const screens = await api('/api/screens');
    PortalLoading.step('Preparando o painel…');
    await startSession(data.user, screens.screens);
    await window.bootstrapPortal?.();
  } catch (error) {
    PortalLoading.stop('login');
    if (error.message === 'locked') return;
    showLogin(error.message === 'auth' ? 'Usuário ou senha incorretos.' : error.message);
    return;
  }
  PortalLoading.stop('login');
});

$('#unlockForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#unlockError');
  error.classList.add('hidden');
  try {
    const response = await fetch(`${API_BASE}/api/system/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#unlockUser').value.trim(), password: $('#unlockPassword').value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Não foi possível desbloquear o portal.');
    window.location.reload();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
});

$('#systemLockForm').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#systemLockMessage').value.trim();
  if (!confirm('Bloquear o portal para todos agora? As sessões abertas serão encerradas e somente uma conta de administrador poderá desbloquear.')) return;
  try {
    await api('/api/system/lock', { method: 'POST', body: JSON.stringify({ message }) });
    showSystemLock({ message, since: new Date().toISOString() });
  } catch (err) {
    if (err.message !== 'locked') alert(err.message);
  }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  clearSession();
  showLogin();
});

$('#sessionAvatar')?.addEventListener('click', openProfile);
$('#sessionName')?.addEventListener('click', openProfile);
$('#profileClose')?.addEventListener('click', () => $('#profileDialog')?.close());
$('#profileDone')?.addEventListener('click', () => $('#profileDialog')?.close());
$('#profilePhotoRemove')?.addEventListener('click', () => saveProfilePhoto(null));
$('#profilePhotoInput')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    notify('Imagem maior que 6 MB. Use uma foto menor.', 'warning');
    return;
  }
  try {
    const photo = await resizePhoto(file);
    await saveProfilePhoto(photo);
  } catch (error) {
    notify(error.message, 'warning');
  }
});

$('#profileStatusEmoji')?.addEventListener('change', renderStatusPreview);
$('#profileStatusDuration')?.addEventListener('change', renderStatusPreview);
$('#profileStatusText')?.addEventListener('input', renderStatusPreview);
$('#profileStatusText')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveProfileStatus();
  }
});
$('#profileStatusSave')?.addEventListener('click', saveProfileStatus);
$('#profileStatusClear')?.addEventListener('click', () => {
  const text = $('#profileStatusText');
  if (text) text.value = '';
  saveProfileStatus();
});

document.querySelector('.sidebar-nav').addEventListener('click', event => {
  const button = event.target.closest('.nav-button');
  if (!button || button.classList.contains('hidden')) return;
  openScreen(button.dataset.screen);
});

$('#customScreens').addEventListener('click', async event => {
  const save = event.target.closest('[data-save-sector]');
  const toggle = event.target.closest('[data-toggle-item]');
  const remove = event.target.closest('[data-delete-item]');
  try {
    if (save) {
      const screen = findScreen(save.dataset.saveSector);
      const notes = document.querySelector(`[data-sector-notes="${screen.id}"]`)?.value || '';
      await saveSectorContent(screen.id, { notes, items: screen.content?.items || [] });
      return;
    }
    if (toggle) {
      const screen = findScreen(toggle.dataset.toggleItem);
      const items = (screen.content?.items || []).map(item => item.id === toggle.dataset.itemId ? { ...item, done: toggle.checked } : item);
      await saveSectorContent(screen.id, { notes: screen.content?.notes || '', items });
      return;
    }
    if (remove) {
      const screen = findScreen(remove.dataset.deleteItem);
      const items = (screen.content?.items || []).filter(item => item.id !== remove.dataset.itemId);
      await saveSectorContent(screen.id, { notes: screen.content?.notes || '', items });
    }
  } catch (error) {
    if (error.message !== 'auth') alert(error.message);
  }
});

$('#customScreens').addEventListener('submit', async event => {
  const form = event.target.closest('[data-sector-form]');
  if (!form) return;
  event.preventDefault();
  const screen = findScreen(form.dataset.sectorForm);
  const input = form.querySelector('input');
  const text = input.value.trim();
  if (!text) return;
  const items = [...(screen.content?.items || []), { id: window.newPortalId ? window.newPortalId() : `${Date.now()}-${Math.random()}`, text, done: false }];
  try {
    await saveSectorContent(screen.id, { notes: screen.content?.notes || '', items });
  } catch (error) {
    if (error.message !== 'auth') alert(error.message);
  }
});

$('#userForm').addEventListener('submit', async event => {
  event.preventDefault();
  const screens = [...document.querySelectorAll('input[name="userScreen"]:checked')].map(input => input.value);
  const editingId = $('#editUserId').value;
  const payload = {
    displayName: $('#userDisplayName').value.trim(),
    username: $('#userUsername').value.trim(),
    role: $('#userRole').value,
    management: $('#userManagement').checked,
    active: $('#userActive').checked,
    worksSaturday: $('#userWorksSaturday').checked,
    worksSunday: $('#userWorksSunday').checked,
    sellerName: $('#userSellerName')?.value.trim() || '',
    birthday: $('#userBirthday')?.value || null,
    sectorIds: [...document.querySelectorAll('input[name="userSector"]:checked')].map(input => input.value),
    screens,
  };
  if ($('#userPassword').value) payload.password = $('#userPassword').value;
  try {
    if (editingId) await api(`/api/users/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
    resetUserForm();
    await loadAdminLists();
    renderCustomScreens();
    applyAccess();
  } catch (error) {
    alert(error.message);
  }
});

$('#cancelUserEdit').addEventListener('click', resetUserForm);

$('#userManagement')?.addEventListener('change', event => {
  const mirror = document.getElementById('userManagementView');
  if (!mirror) return;
  mirror.checked = event.target.checked;
  const note = mirror.closest('label')?.querySelector('span strong')?.nextSibling;
  if (note) note.textContent = event.target.checked ? ' · liberada pelo campo "É gestor(a)"' : ' · marque "É gestor(a)" para liberar';
});

$('#usersList').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-user]');
  const toggle = event.target.closest('[data-toggle-user]');
  const remove = event.target.closest('[data-delete-user]');
  if (edit) {
    editUser(edit.dataset.editUser);
    return;
  }
  if (toggle) {
    const blocking = toggle.dataset.active === '1';
    const message = blocking
      ? 'Bloquear o acesso desta conta? As sessões abertas serão encerradas agora.'
      : 'Liberar o acesso desta conta?';
    if (!confirm(message)) return;
    try {
      await api(`/api/users/${toggle.dataset.toggleUser}`, { method: 'PUT', body: JSON.stringify({ active: !blocking }) });
      resetUserForm();
      await loadAdminLists();
    } catch (error) { alert(error.message); }
    return;
  }
  if (remove && confirm('Excluir esta conta?')) {
    try {
      await api(`/api/users/${remove.dataset.deleteUser}`, { method: 'DELETE' });
      resetUserForm();
      await loadAdminLists();
    } catch (error) {
      alert(error.message);
    }
  }
});

$('#adminBirthdays')?.addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-birthday]');
  if (edit) {
    editBirthday(edit.dataset.editBirthday);
    return;
  }
  const userEdit = event.target.closest('[data-edit-user]');
  if (userEdit) {
    editUser(userEdit.dataset.editUser);
    return;
  }
  const remove = event.target.closest('[data-delete-birthday]');
  if (remove && confirm('Remover este aniversariante?')) {
    try {
      await api(`/api/birthdays/${encodeURIComponent(remove.dataset.deleteBirthday)}`, { method: 'DELETE' });
      resetBirthdayForm();
      await loadAdminLists();
      window.loadBirthdays?.();
    } catch (error) {
      alert(error.message);
    }
  }
});

$('#adminBirthdaysMissing')?.addEventListener('click', event => {
  const prefill = event.target.closest('[data-prefill-birthday]');
  if (prefill) prefillBirthdayForUser(prefill.dataset.prefillBirthday);
});

$('#cancelBirthdayEdit')?.addEventListener('click', resetBirthdayForm);

$('#birthdayPhoto')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 6 * 1024 * 1024) {
    alert('Escolha uma imagem de até 6 MB.');
    event.target.value = '';
    return;
  }
  try {
    setBirthdayPhoto(await resizePhoto(file));
  } catch (error) {
    alert(error.message);
    event.target.value = '';
  }
});

$('#removeBirthdayPhoto')?.addEventListener('click', () => {
  setBirthdayPhoto('');
  const input = $('#birthdayPhoto');
  if (input) input.value = '';
});

$('#birthdayForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const editingId = $('#birthdayId').value;
  const payload = {
    name: $('#birthdayName').value.trim(),
    day: Number($('#birthdayDay').value),
    month: Number($('#birthdayMonth').value),
    year: $('#birthdayYear').value ? Number($('#birthdayYear').value) : null,
    kind: $('#birthdayKind').value,
    note: $('#birthdayNote').value.trim(),
    userId: $('#birthdayUser').value || null,
    photo: birthdayPhotoData || null,
  };
  try {
    if (editingId) await api(`/api/birthdays/${encodeURIComponent(editingId)}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/birthdays', { method: 'POST', body: JSON.stringify(payload) });
    resetBirthdayForm();
    await loadAdminLists();
    window.loadBirthdays?.();
  } catch (error) {
    alert(error.message);
  }
});

$('#adminTabs')?.addEventListener('click', event => {
  const tab = event.target.closest('[data-admin-tab]');
  if (tab) showAdminTab(tab.dataset.adminTab);
});

$('#adminScreen')?.addEventListener('click', event => {
  const goto = event.target.closest('[data-admin-goto]');
  if (goto) showAdminTab(goto.dataset.adminGoto);
});

$('#adminRefreshBtn')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await loadAdminLists();
  } finally {
    button.disabled = false;
  }
});

$('#downloadBackupBtn')?.addEventListener('click', async () => {
  try {
    const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/backup`, { headers: { Authorization: `Bearer ${Access.token}` } });
    if (!response.ok) throw new Error('Não foi possível baixar o backup.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portal-backup-${new Date().toISOString().slice(0, 10)}.db`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
});

const importDatabaseFile = $('#importDatabaseFile');
const importDatabaseBtn = $('#importDatabaseBtn');
const importDatabaseStatus = $('#importDatabaseStatus');

$('#selectImportDatabaseBtn')?.addEventListener('click', () => importDatabaseFile?.click());

importDatabaseFile?.addEventListener('change', () => {
  const file = importDatabaseFile.files?.[0];
  if (!file) {
    if (importDatabaseBtn) importDatabaseBtn.disabled = true;
    if (importDatabaseStatus) importDatabaseStatus.textContent = '';
    return;
  }
  if (importDatabaseBtn) importDatabaseBtn.disabled = false;
  if (importDatabaseStatus) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    importDatabaseStatus.textContent = `Arquivo selecionado: ${file.name} (${sizeMb} MB)`;
  }
});

importDatabaseBtn?.addEventListener('click', async () => {
  const file = importDatabaseFile?.files?.[0];
  if (!file) return;
  if (!window.confirm(`Importar "${file.name}" e substituir o banco atual?\n\nO portal criará uma cópia automática antes da substituição e todas as sessões abertas serão encerradas.`)) return;

  importDatabaseBtn.disabled = true;
  if (importDatabaseStatus) importDatabaseStatus.textContent = 'Validando e enviando o banco...';
  try {
    const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/admin/restore-database`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Access.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      if (!response.ok) {
        throw new Error(`O servidor não reconheceu a importação (HTTP ${response.status}). Atualize o código no notebook servidor e reinicie o portal.`);
      }
      throw new Error('O servidor respondeu em um formato inválido.');
    }
    if (!response.ok) throw new Error(data.error || 'Não foi possível importar o banco.');
    if (importDatabaseStatus) {
      importDatabaseStatus.textContent = `Banco importado. Cópia anterior: ${data.backup || 'não informada'}. Recarregando o portal...`;
    }
    setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    if (importDatabaseStatus) importDatabaseStatus.textContent = error.message;
    importDatabaseBtn.disabled = false;
  }
});

$('#screenForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/screens', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#screenName').value.trim(),
        sectorId: $('#screenSector').value,
        description: $('#screenDescription').value.trim(),
      }),
    });
    $('#screenForm').reset();
    await loadAdminLists();
    renderCustomScreens();
    applyAccess();
    $('#userScreenChecks').innerHTML = screenChecksHtml([...document.querySelectorAll('input[name="userScreen"]:checked')].map(input => input.value));
  } catch (error) {
    alert(error.message);
  }
});

$('#sectorForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/sectors', { method: 'POST', body: JSON.stringify({ name: $('#sectorName').value.trim(), description: $('#sectorDescription').value.trim() }) });
    $('#sectorForm').reset();
    await loadAdminLists();
  } catch (error) { alert(error.message); }
});

$('#sectorsList').addEventListener('click', async event => {
  const remove = event.target.closest('[data-delete-sector]');
  if (!remove || !confirm('Excluir este setor?')) return;
  try { await api(`/api/sectors/${remove.dataset.deleteSector}`, { method: 'DELETE' }); await loadAdminLists(); }
  catch (error) { alert(error.message); }
});

$('#taskSectorForm').addEventListener('submit', async event => {
  event.preventDefault();
  const scope = $('#taskSectorScope').value;
  const sectorName = $('#taskSector').selectedOptions[0]?.textContent || '';
  const scopeLabel = scope === 'all' ? 'todas as demandas' : 'as demandas sem setor';
  if (!confirm(`Atribuir ${scopeLabel} ao setor ${sectorName}?`)) return;
  try {
    const result = await api('/api/tasks/assign-sector', { method: 'POST', body: JSON.stringify({ sectorId: $('#taskSector').value, scope }) });
    alert(`${result.updated} demanda(s) atribuída(s) ao setor.`);
    $('#taskSector').value = '';
  } catch (error) { alert(error.message); }
});

$('#screensList').addEventListener('click', async event => {
  const release = event.target.closest('[data-release-screen]');
  if (release) {
    const screen = Access.screens.find(item => item.id === release.dataset.releaseScreen);
    const on = release.dataset.release === '1';
    const message = on
      ? `Liberar a tela "${screen?.name || 'selecionada'}" para toda a equipe agora?`
      : `Recolher a tela "${screen?.name || 'selecionada'}" de toda a equipe?`;
    if (!confirm(message)) return;
    try {
      const data = await api(`/api/screens/${release.dataset.releaseScreen}/liberar`, {
        method: 'POST', body: JSON.stringify({ release: on }),
      });
      window.__portalUsers = data.users || window.__portalUsers;
      renderUserList(window.__portalUsers);
      renderScreenCatalog();
      applyAccess();
      if (on) alert('Tela liberada para a equipe. Cada pessoa precisa atualizar a página para ver o novo menu.');
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const remove = event.target.closest('[data-delete-screen]');
  if (!remove || !confirm('Excluir esta tela de setor?')) return;
  try {
    await api(`/api/screens/${remove.dataset.deleteScreen}`, { method: 'DELETE' });
    await loadAdminLists();
    renderCustomScreens();
    applyAccess();
  } catch (error) {
    alert(error.message);
  }
});

window.PortalAccess = { Access, api, authHeaders, canSee, restoreSession, openScreen, renderAdminDashboard, enterOfflineSession, refreshSessionForSync, rejectOfflineAuth };
window.escapeHtml = escapeHtml;

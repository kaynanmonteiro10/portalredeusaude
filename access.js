window.$ = window.$ || ((selector) => document.querySelector(selector));
if (window.location.search && window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
const SESSION_KEY = 'portal-session-v1';
const SHARED_SCREENS = ['tasksScreen', 'learningScreen'];
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

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers: authHeaders(options.headers || {}) });
  } catch {
    throw new Error('Não foi possível conectar ao portal. Inicie o servidor e tente novamente.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearSession();
    showLogin(data.error || 'Faça login para continuar.');
    throw new Error('auth');
  }
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
  return data;
}

function clearSession() {
  Access.token = '';
  Access.user = null;
  localStorage.removeItem(SESSION_KEY);
  document.body.classList.add('locked');
  $('#sessionChip')?.classList.add('hidden');
}

function showLogin(message = '') {
  document.body.classList.add('locked');
  const error = $('#loginError');
  if (!error) return;
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}

function canSee(screenId) {
  if (!Access.user) return false;
  if (Access.user.role === 'admin' || (Access.user.allowedScreens || []).includes('*')) return true;
  return (Access.user.allowedScreens || SHARED_SCREENS).includes(screenId);
}

function openScreen(screenId) {
  if (!canSee(screenId)) screenId = 'tasksScreen';
  document.querySelectorAll('.nav-button').forEach(item => item.classList.toggle('active', item.dataset.screen === screenId));
  document.querySelectorAll('.screen').forEach(screen => screen.classList.toggle('hidden', screen.id !== screenId));
  const isTasks = screenId === 'tasksScreen';
  $('#newTaskButton')?.classList.toggle('hidden', !isTasks);
  $('#reportButton')?.classList.toggle('hidden', !isTasks);
  $('#exportButton')?.classList.toggle('hidden', !isTasks);
  if (screenId === 'mergeScreen') {
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof renderMergePreview === 'function') renderMergePreview();
  }
  if (screenId === 'learningScreen' && typeof renderLearning === 'function') renderLearning();
  if (screenId === 'weeklyScreen') {
    if (typeof weeklyOffset !== 'undefined') weeklyOffset = 0;
    if ($('#recordDate') && typeof today === 'function') $('#recordDate').value = today();
    if (typeof renderWeekly === 'function') renderWeekly();
  }
  if (screenId === 'adminScreen') renderAdmin();
}

function applyAccess() {
  document.querySelectorAll('.nav-button').forEach(button => {
    const allowed = button.dataset.adminOnly ? Access.user?.role === 'admin' : canSee(button.dataset.screen);
    button.classList.toggle('hidden', !allowed);
  });
  const active = document.querySelector('.nav-button.active');
  if (!active || active.classList.contains('hidden')) openScreen('tasksScreen');
  $('#sessionName').textContent = Access.user.displayName;
  $('#sessionChip').classList.remove('hidden');
  if (typeof window.refreshOwnerFilter === 'function') window.refreshOwnerFilter();
  if (typeof window.refreshTaskCategory === 'function') window.refreshTaskCategory();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function renderCustomScreens() {
  const host = $('#customScreens');
  const nav = $('#customNav');
  const sectorScreens = Access.screens.filter(screen => screen.kind === 'sector' && canSee(screen.id));
  nav.innerHTML = sectorScreens.map(screen => `<button class="nav-button" type="button" data-screen="${escapeHtml(screen.id)}">${escapeHtml(screen.name)}</button>`).join('');
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
  const extras = Access.screens.filter(screen => !SHARED_SCREENS.includes(screen.id));
  if (!extras.length) return '<p class="panel-help">Crie uma tela de setor ao lado para poder atribuí-la.</p>';
  return extras.map(screen => `<label class="check-label"><input type="checkbox" name="userScreen" value="${escapeHtml(screen.id)}" ${selected.includes(screen.id) ? 'checked' : ''}><span><strong>${escapeHtml(screen.name)}</strong> · ${escapeHtml(screen.sector || screen.kind)}</span></label>`).join('');
}

async function loadAdminLists() {
  if (Access.user?.role !== 'admin') return;
  const [usersData, screensData, sectorsData] = await Promise.all([api('/api/users'), api('/api/screens'), api('/api/sectors')]);
  Access.screens = screensData.screens || [];
  Access.sectors = sectorsData.sectors || [];
  window.__portalUsers = usersData.users || [];
  renderSectorOptions();
  renderUserList(usersData.users || []);
  renderScreenCatalog();
  renderSectorCatalog();
  $('#taskSector').innerHTML = '<option value="">Selecione um setor</option>' + Access.sectors.map(sector => `<option value="${escapeHtml(sector.id)}">${escapeHtml(sector.name)}</option>`).join('');
  if (!$('#editUserId').value) $('#userScreenChecks').innerHTML = screenChecksHtml();
}

function renderSectorOptions() {
  const options = '<option value="">Selecione um setor</option>' + Access.sectors.map(sector => `<option value="${escapeHtml(sector.id)}">${escapeHtml(sector.name)}</option>`).join('');
  $('#screenSector').innerHTML = options;
  $('#userSectorsChecks').innerHTML = Access.sectors.map(sector => `<label class="check-label"><input type="checkbox" name="userSector" value="${escapeHtml(sector.id)}"><span>${escapeHtml(sector.name)}</span></label>`).join('');
}

function renderSectorCatalog() {
  $('#sectorsList').innerHTML = Access.sectors.map(sector => `<article class="admin-item"><div><strong>${escapeHtml(sector.name)}</strong><small>${escapeHtml(sector.description || 'Sem descrição')}</small></div>${sector.id === 'cadastro-faturamento' ? '<span class="muted-tag">padrão</span>' : `<button type="button" class="delete" data-delete-sector="${escapeHtml(sector.id)}" aria-label="Excluir setor">×</button>`}</article>`).join('');
}

function renderUserList(users) {
  $('#usersList').innerHTML = users.map(user => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(user.displayName)}</strong>
        <small>${escapeHtml(user.username)} · ${user.role === 'admin' ? 'administrador' : 'usuário'}</small>
        <small>Telas extras: ${(user.screens || []).map(id => Access.screens.find(screen => screen.id === id)?.name || id).join(', ') || 'somente as comuns'}</small>
      </div>
      <div class="admin-item-actions">
        <button type="button" class="button button-secondary" data-edit-user="${user.id}">Editar</button>
        <button type="button" class="delete" data-delete-user="${user.id}" aria-label="Excluir conta">×</button>
      </div>
    </article>`).join('') || '<p class="empty-state">Nenhuma conta ainda.</p>';
  window.__portalUsers = users;
}

function renderScreenCatalog() {
  $('#screensList').innerHTML = Access.screens.map(screen => `
    <article class="admin-item">
      <div>
        <strong>${escapeHtml(screen.name)}</strong>
        <small>${screen.kind === 'builtin' ? 'Tela nativa' : 'Tela de setor'} · ${escapeHtml(screen.sector || 'Geral')}</small>
        <small>${escapeHtml(screen.description || '')}</small>
      </div>
      ${screen.kind === 'sector' ? `<button type="button" class="delete" data-delete-screen="${screen.id}" aria-label="Excluir tela">×</button>` : '<span class="muted-tag">nativa</span>'}
    </article>`).join('');
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
  $('#saveUserButton').textContent = 'Criar conta';
  $('#userScreenChecks').innerHTML = screenChecksHtml();
}

async function startSession(user, screens) {
  Access.user = user;
  Access.screens = screens || [];
  if (user.role === 'admin') {
    const sectors = await api('/api/sectors');
    Access.sectors = sectors.sectors || [];
  }
  document.body.classList.remove('locked');
  renderCustomScreens();
  applyAccess();
  openScreen('tasksScreen');
}

async function restoreSession() {
  if (!Access.token) {
    showLogin();
    return false;
  }
  try {
    const me = await api('/api/me');
    const screens = await api('/api/screens');
    await startSession(me.user, screens.screens);
    return true;
  } catch {
    clearSession();
    showLogin();
    return false;
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginError').classList.add('hidden');
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUser').value, password: $('#loginPassword').value }),
    });
    Access.token = data.token;
    localStorage.setItem(SESSION_KEY, data.token);
    const screens = await api('/api/screens');
    await startSession(data.user, screens.screens);
    window.bootstrapPortal?.();
  } catch (error) {
    showLogin(error.message === 'auth' ? 'Usuário ou senha incorretos.' : error.message);
  }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  clearSession();
  showLogin();
});

document.querySelector('.main-nav').addEventListener('click', event => {
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

$('#usersList').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit-user]');
  const remove = event.target.closest('[data-delete-user]');
  const users = window.__portalUsers || [];
  if (edit) {
    const user = users.find(item => item.id === edit.dataset.editUser);
    if (!user) return;
    $('#editUserId').value = user.id;
    $('#userDisplayName').value = user.displayName;
    $('#userUsername').value = user.username;
    $('#userUsername').disabled = true;
    $('#userRole').value = user.role;
    document.querySelectorAll('input[name="userSector"]').forEach(input => { input.checked = (user.sectorIds || [user.sectorId]).includes(input.value); });
    $('#userPassword').required = false;
    $('#userPassword').value = '';
    $('#userPassword').placeholder = 'deixe em branco para manter';
    $('#saveUserButton').textContent = 'Salvar alterações';
    $('#userScreenChecks').innerHTML = screenChecksHtml(user.screens || []);
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

window.PortalAccess = { Access, api, authHeaders, canSee, restoreSession, openScreen };
window.escapeHtml = escapeHtml;

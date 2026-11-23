(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('emailCenterScreen')) return;
  const statuses = { review: 'Novas / revisar', awaiting_me: 'Aguardando minha ação', awaiting_them: 'Aguardando retorno', done: 'Concluída' };
  const priorities = { urgent: 'Urgente', high: 'Alta', medium: 'Média', low: 'Baixa' };
  const mailboxes = ['administrativo@appredesaude.com.br', 'faturamento@appredesaude.com.br'];
  const state = { active: false, epoch: 0, token: '', data: null, controllers: new Set(), busy: new Set(), errors: new Map(), timer: null, poll: null, device: null, overview: null, queued: false, revision: 0, threadVersion: 0, thread: null, taskKey: null, taskBusy: false, uncertainTasks: new Set(), lastAutoSync: new Map() };
  const access = () => window.PortalAccess?.Access;
  const allowed = () => !!access()?.token && access()?.user?.role === 'admin' && !!window.PortalAccess?.canSee('emailCenterScreen') && !document.body.classList.contains('locked');
  const visible = () => !document.hidden && !$('emailCenterScreen').classList.contains('hidden');
  const usable = () => state.active && visible() && allowed() && state.token === access()?.token;
  const context = () => ({ epoch: state.epoch, token: access()?.token });
  const valid = ctx => usable() && ctx.epoch === state.epoch && ctx.token === access()?.token;
  const stale = () => Object.assign(new Error('Operação interrompida.'), { silent: true });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const overdue = c => !!c.due && c.due < today() && c.status !== 'done';
  const dateText = value => { if (!value) return '—'; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', /^\d{4}-\d{2}-\d{2}$/.test(value) ? { dateStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' }); };
  function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text ?? ''); if (cls) n.className = cls; return n; }
  function errorAt(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
  function button(text, fn, disabled = false, secondary = false) { const b = node('button', text, `ec-button${secondary ? ' ec-secondary' : ''}`); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', fn); return b; }
  function option(select, value, text) { const n = node('option', text); n.value = value; select.append(n); }
  function safeLink(value, microsoft = false) {
    try { const u = new URL(value); const hosts = microsoft ? ['login.microsoftonline.com', 'microsoft.com'] : ['outlook.office.com', 'outlook.office365.com']; return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && hosts.includes(u.hostname.toLowerCase()) ? u.href : ''; } catch { return ''; }
  }
  function outlookLink(value) { const href = safeLink(value); if (!href) return null; const a = node('a', 'Abrir no Outlook', 'ec-button ec-secondary'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function authFailure(status, data) {
    window.resetEmailCenter();
    const portal = window.PortalAccess;
    if (status === 401) {
      if (typeof portal?.clearSession === 'function') portal.clearSession(); else if (typeof clearSession === 'function') clearSession();
      if (typeof portal?.showLogin === 'function') portal.showLogin(data.error || 'Faça login para continuar.'); else if (typeof showLogin === 'function') showLogin(data.error || 'Faça login para continuar.');
    } else if (typeof portal?.showSystemLock === 'function') portal.showSystemLock(data); else if (typeof showSystemLock === 'function') showSystemLock(data);
  }
  async function request(path = '', body, ctx = context()) {
    if (!valid(ctx)) throw stale();
    const controller = new AbortController(); state.controllers.add(controller);
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/email-center${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!valid(ctx)) throw stale();
      const data = await response.json().catch(() => ({}));
      if (!valid(ctx)) throw stale();
      if (response.status === 401 || response.status === 423) { authFailure(response.status, data); throw stale(); }
      if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a ação.');
      return data;
    } catch (error) { if (!valid(ctx) || error.name === 'AbortError') throw stale(); throw error; }
    finally { state.controllers.delete(controller); }
  }
  // Cancelamento de sessão é uma limpeza, não pode reabrir UI nem depender da tela ativa.
  async function cancelSession(device) {
    if (!device?.sessionId || !allowed() || device.token !== access()?.token) return;
    const ctx = context(), controller = new AbortController(); state.controllers.add(controller);
    try {
      const response = await fetch(`${window.PORTAL_API_BASE || ''}/api/email-center/connect/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` }, credentials: 'same-origin', cache: 'no-store', keepalive: true, signal: controller.signal, body: JSON.stringify({ sessionId: device.sessionId }) });
      if (ctx.epoch !== state.epoch || ctx.token !== access()?.token || !allowed()) return;
      if (response.status === 401 || response.status === 423) { const data = await response.json(); if (ctx.epoch === state.epoch && ctx.token === access()?.token && allowed()) authFailure(response.status, data); }
    } catch { /* A sessão também expira no servidor; nenhum código é persistido. */ }
    finally { state.controllers.delete(controller); }
  }
  function stopTimers() { clearTimeout(state.timer); clearTimeout(state.poll); state.timer = null; state.poll = null; }
  function abortRequests() { state.controllers.forEach(c => c.abort()); state.controllers.clear(); }
  function clearDevice(cancel = true) {
    clearTimeout(state.poll); state.poll = null;
    const device = state.device; state.device = null;
    $('ecDeviceCode').textContent = ''; $('ecDeviceLink').removeAttribute('href'); $('ecDeviceLink').hidden = true;
    $('ecConnectMailbox').textContent = ''; $('ecConnectStatus').textContent = ''; errorAt('ecConnectError');
    if ($('ecConnectDialog').open) $('ecConnectDialog').close();
    if (cancel) void cancelSession(device);
  }
  function clearThread() {
    state.threadVersion++; state.thread = null; state.taskKey = null;
    if ($('ecTaskDialog').open) $('ecTaskDialog').close();
    if ($('ecThreadDialog').open) $('ecThreadDialog').close();
    $('ecMessages').replaceChildren(); $('ecThreadTitle').textContent = 'Detalhes da conversa'; $('ecThreadMeta').textContent = ''; $('ecSuggestion').textContent = ''; $('ecTaskState').textContent = '';
    $('ecTaskForm').reset(); $('ecFollowupForm').reset(); errorAt('ecThreadError'); errorAt('ecTaskError');
  }
  function scheduleOverview() {
    clearTimeout(state.timer); if (!usable()) return;
    state.timer = setTimeout(async () => { const ctx = context(); await loadOverview(); if (!valid(ctx)) return; autoSync(); scheduleOverview(); }, 20000);
  }
  async function loadOverview() {
    if (!usable()) return;
    if (state.overview) { state.queued = true; return; }
    const ctx = context(), revision = state.revision, ticket = {}; state.overview = ticket;
    $('ecRefresh').disabled = true;
    try {
      const data = await request('', undefined, ctx); if (!valid(ctx)) return;
      if (!data?.setup || !Array.isArray(data.mailboxes) || !Array.isArray(data.conversations) || !Array.isArray(data.options?.sectors) || !Array.isArray(data.options?.owners)) throw new Error('O servidor retornou um painel inválido.');
      if (revision !== state.revision) { state.queued = true; return; }
      state.data = data;
      state.uncertainTasks.clear();
      errorAt('ecError'); renderOverview();
    } catch (error) { if (valid(ctx) && !error.silent) errorAt('ecError', `${error.message} O último painel disponível foi mantido.`); }
    finally {
      if (valid(ctx) && state.overview === ticket) {
        state.overview = null; $('ecRefresh').disabled = false;
        if (state.queued) { state.queued = false; void loadOverview(); }
      }
    }
  }
  const conversations = () => state.data?.conversations || [];
  function renderOverview() {
    if (!usable()) return;
    const data = state.data; if (!data) return;
    const cs = conversations(); $('ecKpis').replaceChildren();
    [[cs.filter(c => c.status === 'review').length, 'Novas / revisar'], [cs.filter(c => c.status === 'awaiting_me').length, 'Minha ação'], [cs.filter(c => c.status === 'awaiting_them').length, 'Aguardando retorno'], [cs.filter(overdue).length, 'Prazo vencido']].forEach(([count, label]) => { const card = node('article', undefined, 'ec-kpi'); card.append(node('strong', count), node('span', label)); $('ecKpis').append(card); });
    const setup = data.setup || {}, connected = (data.mailboxes || []).some(m => m.connected);
    // Não sobrescrever configuração em edição a cada atualização automática.
    if (!$('ecSetupDetails').open && !state.busy.has('setup')) { $('ecClientId').value = setup.clientId || ''; $('ecTenant').value = setup.tenant || 'organizations'; }
    ['ecClientId', 'ecTenant', 'ecOwnApp', 'ecSetupSubmit'].forEach(id => { $(id).disabled = connected || state.busy.has('setup') || state.busy.has('connect') || !!state.device; });
    $('ecSetupState').textContent = connected ? 'Configuração bloqueada: desconecte todas as caixas primeiro.' : setup.configured ? 'Aplicativo configurado. A conexão solicita consentimento na Microsoft.' : 'Configure seu aplicativo próprio antes de conectar.';
    $('ecMailboxes').replaceChildren();
    mailboxes.forEach(address => {
      const m = (data.mailboxes || []).find(item => item.address === address) || { address, connected: false };
      const card = node('article', undefined, 'ec-mailbox'); card.append(node('h4', m.label || (address.startsWith('administrativo') ? 'Administrativo' : 'Faturamento')), node('p', address, 'ec-muted'));
      card.append(node('p', `${m.connected ? 'Conectada' : 'Não conectada'}${m.account ? ` · ${typeof m.account === 'string' ? m.account : m.account.username || m.account.address || ''}` : ''}`, 'ec-muted'));
      card.append(node('p', `Última sincronização: ${dateText(m.lastSync)}${m.running ? ' · Sincronização em andamento' : ''}`, 'ec-muted'));
      const err = state.errors.get(address) || m.error; if (err) card.append(node('p', err, 'ec-error'));
      const actions = node('div', undefined, 'ec-actions'), busy = state.busy.has(`mailbox:${address}`);
      if (m.connected) actions.append(button(m.running ? 'Sincronizando…' : 'Sincronizar', () => syncMailbox(address), busy || m.running), button('Desconectar', () => disconnect(address), busy, true));
      else actions.append(button('Conectar Microsoft 365', () => connect(address), busy || !setup.configured || !!state.device || state.busy.has('connect') || state.busy.has('setup')));
      card.append(actions); $('ecMailboxes').append(card);
    });
    const selected = $('ecMailboxFilter').value; $('ecMailboxFilter').replaceChildren(); option($('ecMailboxFilter'), '', 'Todas as caixas'); mailboxes.forEach(address => option($('ecMailboxFilter'), address, address)); $('ecMailboxFilter').value = selected;
    renderConversations(); updateTaskLink();
    if (state.thread) { const latest = cs.find(c => c.key === state.thread.conversation.key); if (latest) state.thread.conversation = latest; updateTaskLink(); }
  }
  function renderConversations() {
    if (!usable()) return;
    const term = $('ecSearch').value.trim().toLocaleLowerCase('pt-BR'), box = $('ecMailboxFilter').value, status = $('ecStatusFilter').value, priority = $('ecPriorityFilter').value;
    const rows = conversations().filter(c => (!box || c.mailbox === box) && (!priority || c.priority === priority) && (!status || (status === 'overdue' ? overdue(c) : c.status === status)) && (!term || `${c.subject || ''} ${typeof c.sender === 'object' ? `${c.sender?.name || ''} ${c.sender?.address || ''}` : c.sender || ''}`.toLocaleLowerCase('pt-BR').includes(term))).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
    $('ecConversations').replaceChildren(); $('ecCount').textContent = `${rows.length} de ${conversations().length} conversas`; $('ecEmpty').hidden = rows.length > 0;
    $('ecEmpty').textContent = conversations().length ? 'Nenhuma conversa corresponde aos filtros.' : 'Nenhuma conversa disponível. Configure, conecte e sincronize suas caixas.';
    rows.forEach(c => {
      const card = node('article', undefined, 'ec-conversation'), copy = node('div'); copy.append(node('h4', c.subject || '(Sem assunto)'));
      const sender = typeof c.sender === 'object' ? c.sender?.address || c.sender?.name : c.sender;
      copy.append(node('p', `${sender || 'Remetente não informado'} · ${c.mailbox} · ${dateText(c.lastAt)}`, 'ec-muted'));
      const badges = node('div', undefined, 'ec-badges'); badges.append(node('span', statuses[c.status] || statuses.review, 'ec-badge'), node('span', priorities[c.priority] || priorities.medium, 'ec-badge'));
      if (c.unread) badges.append(node('span', 'Não lida no Outlook', 'ec-badge'));
      if (c.due) badges.append(node('span', `${overdue(c) ? 'Prazo vencido' : 'Prazo'}: ${dateText(c.due)}`, `ec-badge${overdue(c) ? ' ec-overdue' : ''}`));
      if (c.task || c.taskDeleted) badges.append(node('span', c.taskDeleted ? 'Demanda vinculada excluída' : 'Demanda vinculada', 'ec-badge'));
      copy.append(badges); card.append(copy, button('Detalhes / revisar', () => openThread(c.key))); $('ecConversations').append(card);
    });
  }
  async function mailboxAction(address, fn) {
    const key = `mailbox:${address}`; if (!usable() || state.busy.has(key)) return;
    const ctx = context(); state.busy.add(key); renderOverview();
    try { await fn(ctx); if (!valid(ctx)) return; state.errors.delete(address); state.revision++; await loadOverview(); if (!valid(ctx)) return; }
    catch (error) { if (valid(ctx) && !error.silent) state.errors.set(address, error.message); }
    finally { if (valid(ctx)) { state.busy.delete(key); renderOverview(); } }
  }
  function syncMailbox(address) {
    if (!(state.data?.mailboxes || []).some(m => m.address === address && m.connected && !m.running)) return;
    return mailboxAction(address, async ctx => { const result = await request('/sync', { mailbox: address }, ctx); if (!valid(ctx)) return; state.lastAutoSync.set(address, Date.now()); $('ecNotice').textContent = result.started ? 'Sincronização iniciada. O painel acompanhará o resultado.' : 'A sincronização já está em andamento ou não foi iniciada.'; });
  }
  function autoSync() { if (!usable()) return; (state.data?.mailboxes || []).filter(m => mailboxes.includes(m.address) && m.connected && !m.running && Date.now() - (state.lastAutoSync.get(m.address) || 0) >= 300000).forEach(m => { state.lastAutoSync.set(m.address, Date.now()); void syncMailbox(m.address); }); }
  async function disconnect(address) {
    if (!usable() || !window.confirm(`Desconectar ${address}? A conexão e o cache local serão removidos. As demandas criadas serão mantidas.`) || !usable()) return;
    await mailboxAction(address, async ctx => { await request('/disconnect', { mailbox: address }, ctx); if (!valid(ctx)) return; if (state.thread?.conversation.mailbox === address) clearThread(); state.lastAutoSync.delete(address); $('ecNotice').textContent = 'Caixa desconectada. Demandas existentes preservadas.'; });
  }
  $('ecSetupDetails').addEventListener('toggle', () => { if ($('ecSetupDetails').open && usable() && !state.busy.has('setup')) { $('ecClientId').value = state.data?.setup?.clientId || ''; $('ecTenant').value = state.data?.setup?.tenant || 'organizations'; } });
  $('ecSetupForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!usable() || state.busy.has('setup') || state.busy.has('connect') || state.device || (state.data?.mailboxes || []).some(m => m.connected)) return;
    const clientId = $('ecClientId').value.trim(), tenant = $('ecTenant').value.trim(), guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const firstParty = new Set(['d3590ed6-52b3-4102-aeff-aad2292ab01c', '04b07795-8ddb-461a-bbee-02f9e1bf7b46', '1950a258-227b-4e31-a9cf-717495945fc2', '1b730954-1685-4b74-9bfd-dac224a7b894', '00000003-0000-0000-c000-000000000000', '00000002-0000-0000-c000-000000000000', '00000000-0000-0000-0000-000000000000']);
    if (!guid.test(clientId) || firstParty.has(clientId.toLowerCase()) || (!guid.test(tenant) && tenant !== 'organizations') || !$('ecOwnApp').checked) { errorAt('ecError', 'Confirme seu aplicativo próprio (não um aplicativo padrão Microsoft) e informe client ID GUID e tenant GUID ou organizations.'); return; }
    const ctx = context(); state.busy.add('setup'); renderOverview();
    try { await request('/setup', { clientId, tenant }, ctx); if (!valid(ctx)) return; state.revision++; $('ecNotice').textContent = 'Configuração salva. Conecte cada caixa com consentimento Microsoft.'; await loadOverview(); if (!valid(ctx)) return; }
    catch (error) { if (valid(ctx) && !error.silent) errorAt('ecError', error.message); }
    finally { if (valid(ctx)) { state.busy.delete('setup'); renderOverview(); } }
  });
  function intervalMs(value) { const seconds = Number(value); return Math.max(5, Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000; }
  async function connect(address) {
    if (!usable() || !state.data?.setup?.configured || state.device || state.busy.has('connect') || state.busy.has('setup')) return;
    const ctx = context(); state.busy.add('connect'); renderOverview();
    try {
      const data = await request('/connect', { mailbox: address }, ctx); if (!valid(ctx)) return;
      // Retenção somente em memória, por no máximo o tempo retornado pelo servidor.
      state.device = { sessionId: data.sessionId, token: ctx.token, expires: Date.now() + Number(data.expiresIn) * 1000, interval: intervalMs(data.interval), checking: false };
      const link = safeLink(data.verificationUri, true);
      if (!data.sessionId || !data.userCode || !link || !Number.isFinite(state.device.expires) || Number(data.expiresIn) <= 0) { clearDevice(); throw new Error('O servidor retornou uma autorização Microsoft inválida. Solicite suporte da TI.'); }
      $('ecConnectMailbox').textContent = address; $('ecDeviceCode').textContent = data.userCode;
      $('ecDeviceLink').href = link; $('ecDeviceLink').hidden = false; errorAt('ecConnectError');
      $('ecConnectStatus').textContent = `Aguardando autorização. Código válido até ${dateText(state.device.expires)}.`;
      if (valid(ctx)) { $('ecConnectDialog').showModal(); scheduleDevice(); }
    } catch (error) { if (valid(ctx) && !error.silent) { state.errors.set(address, error.message); clearDevice(); } }
    finally { if (valid(ctx)) { state.busy.delete('connect'); renderOverview(); } }
  }
  function scheduleDevice() {
    clearTimeout(state.poll); if (!usable() || !state.device || state.device.checking) return;
    const remaining = state.device.expires - Date.now();
    if (remaining <= 0) { clearDevice(); $('ecNotice').textContent = 'O código Microsoft expirou. Conecte novamente.'; renderOverview(); return; }
    state.poll = setTimeout(checkDevice, Math.min(state.device.interval, remaining));
  }
  async function checkDevice() {
    if (!usable() || !state.device || state.device.checking) return;
    if (Date.now() >= state.device.expires) { scheduleDevice(); return; }
    const ctx = context(), device = state.device; device.checking = true;
    try {
      const data = await request('/connect/check', { sessionId: device.sessionId }, ctx); if (!valid(ctx) || state.device !== device) return;
      if (data.interval) device.interval = Math.max(device.interval, intervalMs(data.interval));
      if (data.status === 'connected') { clearDevice(false); state.revision++; $('ecNotice').textContent = 'Caixa conectada. Sincronização somente de leitura.'; await loadOverview(); if (!valid(ctx)) return; autoSync(); }
      else if (data.status === 'expired') { clearDevice(false); $('ecNotice').textContent = 'Autorização expirada. Conecte novamente.'; renderOverview(); }
      else if (data.status !== 'pending') { clearDevice(); errorAt('ecError', 'Resposta de autorização inválida. Conecte novamente.'); renderOverview(); }
    } catch (error) { if (valid(ctx) && state.device === device && !error.silent) errorAt('ecConnectError', `${error.message} Tentaremos novamente respeitando o intervalo de autorização.`); }
    finally { if (valid(ctx) && state.device === device) { device.checking = false; scheduleDevice(); } }
  }
  $('ecConnectClose').addEventListener('click', () => { clearDevice(); if (usable()) renderOverview(); });
  $('ecConnectDialog').addEventListener('cancel', event => { event.preventDefault(); clearDevice(); if (usable()) renderOverview(); });
  $('ecConnectDialog').addEventListener('close', () => { if (state.device && !$('ecConnectDialog').open) { clearDevice(); if (usable()) renderOverview(); } });
  const threadValid = (ctx, version, key) => valid(ctx) && version === state.threadVersion && state.thread?.conversation.key === key && $('ecThreadDialog').open;
  async function openThread(key) {
    if (!usable() || state.taskBusy || state.busy.has('followup')) return;
    clearThread(); const version = state.threadVersion, ctx = context();
    errorAt('ecThreadError'); $('ecMessages').textContent = 'Carregando mensagens…';
    const c = conversations().find(item => item.key === key); if (!c) return;
    state.thread = { conversation: c, messages: [], loading: true }; renderThread(); $('ecThreadDialog').showModal();
    try {
      const data = await request(`/thread?key=${encodeURIComponent(key)}`, undefined, ctx); if (!threadValid(ctx, version, key)) return;
      if (data?.conversation?.key !== key || !Array.isArray(data.messages)) throw new Error('O servidor retornou uma conversa inválida.');
      state.thread = data; renderThread();
    } catch (error) { if (threadValid(ctx, version, key) && !error.silent) { state.thread.loading = false; $('ecFollowupSubmit').disabled = false; updateTaskLink(); $('ecMessages').replaceChildren(); errorAt('ecThreadError', error.message); } }
  }
  function updateTaskLink() {
    const c = state.thread?.conversation, snapshot = c && conversations().find(item => item.key === c.key);
    const linked = c?.task || snapshot?.task, deleted = c?.taskDeleted || snapshot?.taskDeleted;
    $('ecTaskStart').disabled = !usable() || !c || !!linked || !!deleted || state.taskBusy || state.uncertainTasks.has(c?.key);
    $('ecTaskOpen').hidden = !linked || deleted; $('ecTaskOpen').disabled = !usable() || state.taskBusy || typeof window.openEmailTask !== 'function';
    $('ecTaskState').textContent = deleted ? 'A demanda vinculada foi excluída. Não é permitido recriá-la por esta conversa.' : linked ? `Demanda: ${linked.title || linked.id} · ${linked.status || ''}${linked.due ? ` · Prazo: ${dateText(linked.due)}` : ''}` : state.uncertainTasks.has(c?.key) ? 'Verificando resultado da criação antes de permitir outra tentativa…' : 'Criação somente após sua revisão.';
    $('ecTaskSubmit').disabled = $('ecTaskStart').disabled;
  }
  function renderThread() {
    if (!usable() || !state.thread) return;
    const { conversation: c, messages = [], limited } = state.thread;
    $('ecThreadTitle').textContent = c.subject || '(Sem assunto)';
    $('ecThreadMeta').textContent = `${c.mailbox} · ${dateText(c.lastAt)} · ${c.incomingCount || 0} recebidas / ${c.outgoingCount || 0} enviadas`;
    $('ecSuggestion').textContent = `Sugestão, não uma solicitação confirmada: ${statuses[c.suggestion] || statuses.review}. Baseada somente na última mensagem ${c.latestDirection === 'outgoing' ? 'enviada' : 'recebida'}. Confirme abaixo se há uma ação ou apenas informação.`;
    $('ecFollowupStatus').value = statuses[c.status] ? c.status : 'review'; $('ecFollowupDue').value = c.due || ''; $('ecFollowupPriority').value = priorities[c.priority] ? c.priority : 'medium';
    $('ecThreadLimited').hidden = !limited; $('ecMessages').replaceChildren();
    messages.forEach(m => {
      const card = node('article', undefined, 'ec-message'); card.append(node('h4', m.subject || '(Sem assunto)'));
      const from = [m.from?.name, m.from?.address].filter(Boolean).join(' · '), to = (m.to || []).map(person => person.address || person.name).join(', ');
      card.append(node('p', `${m.direction === 'outgoing' ? 'Enviada' : 'Recebida'} · ${dateText(m.at)} · ${from || 'Remetente não informado'}`, 'ec-muted'), node('p', `Para: ${to || '—'}${m.hasAttachments ? ' · Possui anexos (consulte o Outlook)' : ''}${!m.isRead ? ' · Não lida no Outlook' : ''}`, 'ec-muted'));
      const text = node('div', m.preview || 'Sem prévia disponível.', 'ec-message-text'); card.append(text);
      const actions = node('div', undefined, 'ec-actions'), messageError = node('p', '', 'ec-error'); messageError.hidden = true;
      const read = button('Ler mensagem', async () => {
        if (!usable() || read.disabled) return;
        const ctx = context(), version = state.threadVersion; read.disabled = true;
        try { const result = await request(`/message?key=${encodeURIComponent(c.key)}&id=${encodeURIComponent(m.id)}`, undefined, ctx); if (!threadValid(ctx, version, c.key)) return; text.textContent = result.body || 'Mensagem sem corpo de texto.'; messageError.hidden = true; read.textContent = 'Mensagem carregada'; const link = outlookLink(result.webLink); actions.querySelector('a')?.remove(); if (link) actions.append(link); }
        catch (error) { if (threadValid(ctx, version, c.key) && !error.silent) { messageError.textContent = error.message; messageError.hidden = false; read.disabled = false; } }
      });
      actions.append(read); const link = outlookLink(m.webLink); if (link) actions.append(link); card.append(actions, messageError); $('ecMessages').append(card);
    });
    if (!messages.length) $('ecMessages').textContent = 'Nenhuma mensagem disponível nesta prévia.';
    updateTaskLink();
  }
  $('ecFollowupForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!usable() || !state.thread || state.busy.has('followup') || state.taskBusy) return;
    const ctx = context(), version = state.threadVersion, key = state.thread.conversation.key;
    const payload = { key, status: $('ecFollowupStatus').value, due: $('ecFollowupDue').value, priority: $('ecFollowupPriority').value };
    state.busy.add('followup'); $('ecFollowupSubmit').disabled = true;
    try { await request('/followup', payload, ctx); if (!threadValid(ctx, version, key)) return; Object.assign(state.thread.conversation, payload); state.revision++; errorAt('ecThreadError'); $('ecNotice').textContent = 'Acompanhamento local confirmado. Microsoft 365 não foi alterado.'; await loadOverview(); if (!threadValid(ctx, version, key)) return; }
    catch (error) { if (threadValid(ctx, version, key) && !error.silent) errorAt('ecThreadError', error.message); }
    finally { if (valid(ctx)) { state.busy.delete('followup'); $('ecFollowupSubmit').disabled = false; } }
  });
  function closeThread(event) { if (state.taskBusy || state.busy.has('followup')) { event?.preventDefault(); return; } clearThread(); }
  $('ecThreadClose').addEventListener('click', closeThread); $('ecThreadDialog').addEventListener('cancel', event => { event.preventDefault(); closeThread(event); });
  $('ecThreadDialog').addEventListener('close', () => { if (!$('ecThreadDialog').open && state.thread) clearThread(); });
  $('ecTaskStart').addEventListener('click', () => {
    updateTaskLink(); if ($('ecTaskStart').disabled || !state.thread) return;
    const c = state.thread.conversation; state.taskKey = c.key; $('ecTaskForm').reset(); errorAt('ecTaskError');
    $('ecTaskName').value = String(c.subject || 'Revisar conversa de e-mail').slice(0, 200); $('ecTaskPriority').value = priorities[c.priority] ? c.priority : 'medium'; $('ecTaskDue').value = c.due || ''; $('ecTaskNotes').value = '';
    $('ecTaskSector').replaceChildren(); option($('ecTaskSector'), '', 'Selecione o setor'); (state.data?.options?.sectors || []).forEach(s => option($('ecTaskSector'), s.id, s.name)); populateOwners();
    if (usable()) $('ecTaskDialog').showModal();
  });
  function populateOwners() {
    const sector = $('ecTaskSector').value; $('ecTaskOwner').replaceChildren(); option($('ecTaskOwner'), '', 'Selecione o responsável');
    (state.data?.options?.owners || []).filter(o => sector && (o.sectorIds || []).some(id => String(id) === sector)).forEach(o => option($('ecTaskOwner'), o.id, o.name));
    $('ecTaskOwner').disabled = !sector || state.taskBusy;
  }
  $('ecTaskSector').addEventListener('change', populateOwners);
  function closeTask(event) { if (state.taskBusy) { event?.preventDefault(); return; } state.taskKey = null; $('ecTaskForm').reset(); if ($('ecTaskDialog').open) $('ecTaskDialog').close(); }
  $('ecTaskClose').addEventListener('click', closeTask); $('ecTaskDialog').addEventListener('cancel', event => { event.preventDefault(); closeTask(event); });
  $('ecTaskDialog').addEventListener('close', () => { if (!$('ecTaskDialog').open && !state.taskBusy) { state.taskKey = null; $('ecTaskForm').reset(); } });
  $('ecTaskForm').addEventListener('submit', async event => {
    event.preventDefault(); updateTaskLink();
    if (!usable() || state.taskBusy || !state.taskKey || !$('ecTaskDialog').open || $('ecTaskSubmit').disabled || !state.thread || state.thread.conversation.key !== state.taskKey || !$('ecTaskForm').reportValidity()) return;
    const key = state.taskKey, ctx = context(), version = state.threadVersion, sectorId = $('ecTaskSector').value, ownerId = $('ecTaskOwner').value;
    const owner = (state.data?.options?.owners || []).find(o => String(o.id) === ownerId && (o.sectorIds || []).some(id => String(id) === sectorId));
    const title = $('ecTaskName').value.trim(); if (!owner || !title || !(state.data?.options?.sectors || []).some(s => String(s.id) === sectorId)) { errorAt('ecTaskError', 'Revise título, setor e responsável pertencente ao setor.'); return; }
    const payload = { key, title, sectorId, ownerId, priority: $('ecTaskPriority').value, due: $('ecTaskDue').value, notes: $('ecTaskNotes').value.trim() };
    state.taskBusy = true; state.uncertainTasks.add(key); $('ecTaskForm').querySelectorAll('input, select, textarea, button').forEach(n => { n.disabled = true; }); $('ecTaskClose').disabled = true; updateTaskLink();
    try {
      const result = await request('/task', payload, ctx); if (!threadValid(ctx, version, key) || state.taskKey !== key) return;
      if (!result.task?.id) throw new Error('Resposta de demanda inválida. Atualize o painel para verificar o vínculo antes de tentar novamente.');
      state.thread.conversation.task = result.task; const c = conversations().find(item => item.key === key); if (c) c.task = result.task;
      state.revision++; state.uncertainTasks.delete(key);
      let accepted = true;
      if (typeof window.acceptEmailTask === 'function') { try { await window.acceptEmailTask(result.task); if (!threadValid(ctx, version, key)) return; } catch { if (!threadValid(ctx, version, key)) return; accepted = false; } }
      if (!threadValid(ctx, version, key)) return;
      $('ecNotice').textContent = !accepted ? 'Demanda vinculada. Atualize o Plantão para exibi-la.' : result.created ? 'Demanda criada com as notas revisadas e o setor escolhido.' : 'Esta conversa já possui uma demanda; o vínculo existente foi mantido.';
      $('ecTaskDialog').close(); state.taskKey = null; $('ecTaskForm').reset(); updateTaskLink();
      await loadOverview(); if (!valid(ctx)) return;
    } catch (error) { if (threadValid(ctx, version, key) && !error.silent) { errorAt('ecTaskError', error.message); state.revision++; await loadOverview(); if (!valid(ctx)) return; } }
    finally { if (valid(ctx)) { state.taskBusy = false; $('ecTaskClose').disabled = false; $('ecTaskForm').querySelectorAll('input, select, textarea, button').forEach(n => { n.disabled = false; }); updateTaskLink(); } }
  });
  $('ecTaskOpen').addEventListener('click', () => { if (!usable() || state.taskBusy) return; const c = state.thread?.conversation; if (c?.task?.id && !c.taskDeleted && typeof window.openEmailTask === 'function') window.openEmailTask(c.task.id); });
  $('ecRefresh').addEventListener('click', () => { void loadOverview(); });
  ['ecSearch', 'ecMailboxFilter', 'ecStatusFilter', 'ecPriorityFilter'].forEach(id => $(id).addEventListener('input', renderConversations));
  function suspend() {
    stopTimers(); state.epoch++; abortRequests(); state.overview = null; state.queued = false; state.busy.clear(); state.taskBusy = false;
    if (state.device) state.device.checking = false;
    $('ecRefresh').disabled = false; $('ecFollowupSubmit').disabled = false; $('ecTaskClose').disabled = false;
    $('ecTaskForm').querySelectorAll('input, select, textarea, button').forEach(n => { n.disabled = false; });
  }
  window.enterEmailCenterScreen = () => {
    if (!allowed()) return;
    if (state.token && state.token !== access()?.token) window.resetEmailCenter();
    state.token = access().token; state.active = true;
    if (!visible()) return;
    renderOverview(); const ctx = context(); void loadOverview().then(() => { if (!valid(ctx)) return; autoSync(); scheduleOverview(); scheduleDevice(); });
  };
  window.leaveEmailCenterScreen = () => { state.active = false; suspend(); clearDevice(); clearThread(); };
  window.resetEmailCenter = () => {
    state.active = false; suspend(); clearDevice(); clearThread(); state.token = ''; state.data = null; state.errors.clear(); state.lastAutoSync.clear(); state.uncertainTasks.clear(); state.revision++;
    ['ecKpis', 'ecMailboxes', 'ecConversations'].forEach(id => $(id).replaceChildren());
    ['ecNotice', 'ecCount', 'ecSetupState'].forEach(id => { $(id).textContent = ''; });
    $('ecSetupForm').reset(); $('ecClientId').value = ''; $('ecTenant').value = ''; $('ecSetupDetails').open = false; $('ecSearch').value = ''; $('ecMailboxFilter').replaceChildren(); option($('ecMailboxFilter'), '', 'Todas as caixas'); $('ecStatusFilter').value = ''; $('ecPriorityFilter').value = ''; errorAt('ecError'); $('ecEmpty').hidden = false;
  };
  document.addEventListener('visibilitychange', () => {
    if (!state.active) return;
    if (document.hidden) { suspend(); clearThread(); return; }
    if (!allowed() || state.token !== access()?.token) { window.resetEmailCenter(); return; }
    if (visible()) window.enterEmailCenterScreen();
  });
  // Defesa adicional se a integração de navegação/logout ainda não disparou os hooks.
  new MutationObserver(() => {
    if (!state.active) return;
    if (!allowed() || state.token !== access()?.token) window.resetEmailCenter();
    else if ($('emailCenterScreen').classList.contains('hidden')) window.leaveEmailCenterScreen();
  }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
})();

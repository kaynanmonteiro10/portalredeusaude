(function (root) {
  'use strict';
  const VERSION = 1;
  const TTL = 24 * 60 * 60 * 1000;
  const copy = value => JSON.parse(JSON.stringify(value));
  const canonical = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  };
  const same = (a, b) => canonical(a) === canonical(b);
  const idOf = user => typeof user === 'object' && user ? String(user.id || '') : String(user || '');
  const uid = () => {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (root.crypto?.getRandomValues) root.crypto.getRandomValues(bytes);
    else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    return [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
  };
  const empty = () => ({ version: VERSION, snapshot: { tasks: [], deletedTaskIds: [] }, outbox: [], conflicts: [], session: null, rejectedToken: null });
  let options = { onState: null, onStatus: null, authHeaders: null, apiBase: '' };
  let active = null;
  let generation = 0;
  let lane = Promise.resolve();
  let timer = null;
  let phase = 'idle';
  let error = null;
  let busy = false;
  let authFailure = null;
  let storageError = null;
  const rejectedTokens = new Set();

  function prefix() {
    return `portal-offline-demands-v${VERSION}:${encodeURIComponent(root.location.origin)}:`;
  }
  function key(userId) { return prefix() + encodeURIComponent(userId); }
  function load(userId) {
    const text = root.localStorage.getItem(key(userId));
    if (!text) return empty();
    try {
      const value = JSON.parse(text);
      if (value.version !== VERSION || !Array.isArray(value.outbox) || !Array.isArray(value.conflicts)) throw new Error('Cache de demandas inválido');
      value.snapshot = sanitize(value.snapshot);
      return value;
    } catch (cause) {
      root.localStorage.removeItem(key(userId));
      root.console?.warn?.('Cache local de demandas descartado:', cause);
      return empty();
    }
  }
  function sanitize(value) {
    if (!value || !Array.isArray(value.tasks)) throw new Error('Snapshot de demandas inválido');
    const deleted = [...new Set((value.deletedTaskIds || []).map(String))];
    const seen = new Set();
    const tasks = value.tasks.map(task => {
      if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id || seen.has(task.id)) throw new Error('Identificador de demanda inválido');
      seen.add(task.id);
      return copy(task);
    }).filter(task => !deleted.includes(task.id));
    return { tasks, deletedTaskIds: deleted };
  }
  function acquireEditor(context) {
    context.writeAllowed = !root.document;
    context.ready = Promise.resolve();
    if (!root.document) return;
    context.ready = new Promise(resolve => { context.editorReady = resolve; });
    const lockKey = key(context.userId) + ':editor';
    if (root.navigator?.locks?.request) {
      root.navigator.locks.request(lockKey, { ifAvailable: true }, lock => {
        if (!alive(context)) { context.editorReady(); return; }
        context.writeAllowed = !!lock;
        context.editorReady();
        notify();
        if (lock) return new Promise(resolve => { context.releaseEditor = resolve; });
      }).catch(() => { context.editorReady(); notify(); });
      return;
    }
    context.leaseKey = lockKey;
    context.leaseOwner = uid();
    const claim = () => {
      if (!alive(context)) return;
      try {
        const lease = JSON.parse(root.localStorage.getItem(lockKey) || 'null');
        if (lease?.expires > Date.now() && lease.owner !== context.leaseOwner) {
          context.writeAllowed = false;
          context.editorReady();
          notify();
          return;
        }
        root.localStorage.setItem(lockKey, JSON.stringify({ owner: context.leaseOwner, expires: Date.now() + 60000 }));
        root.setTimeout(() => {
          if (!alive(context)) return;
          try {
            const owned = JSON.parse(root.localStorage.getItem(lockKey) || 'null')?.owner === context.leaseOwner;
            if (owned && !context.writeAllowed) context.data = load(context.userId);
            context.writeAllowed = owned;
          } catch { context.writeAllowed = false; }
          context.editorReady();
          notify(true);
        }, 50);
      } catch { context.writeAllowed = false; context.editorReady(); notify(); }
    };
    claim();
    context.editorTimer = root.setInterval(claim, 15000);
  }
  function ownsEditor() {
    if (!active || active.writeAllowed === false) return false;
    if (!active.leaseKey) return true;
    try {
      const lease = JSON.parse(root.localStorage.getItem(active.leaseKey) || 'null');
      return lease?.owner === active.leaseOwner && lease.expires > Date.now();
    } catch { return false; }
  }
  function commit(next) {
    if (!ownsEditor()) throw new Error('Demandas abertas em outra aba; use a aba principal para editar.');
    try { root.localStorage.setItem(key(active.userId), JSON.stringify(next)); }
    catch (cause) {
      storageError = 'Não foi possível salvar localmente; alteração não confirmada';
      notify();
      throw cause;
    }
    active.data = next;
    storageError = null;
  }
  function snapshot(data = active?.data) {
    // A rejected login is a lock, not an invitation to fall back to cached data.
    if (!data || authFailure) return { tasks: [], deletedTaskIds: [] };
    const tasks = new Map(data.snapshot.tasks.map(task => [task.id, copy(task)]));
    const deleted = new Set(data.snapshot.deletedTaskIds);
    for (const op of data.outbox) {
      if (op.task === null) { tasks.delete(op.taskId); deleted.add(op.taskId); }
      else { tasks.set(op.taskId, copy(op.task)); deleted.delete(op.taskId); }
    }
    return { tasks: [...tasks.values()], deletedTaskIds: [...deleted] };
  }
  function getStatus() {
    return copy({ phase, busy, pending: active?.data.outbox.length || 0,
      conflicts: active?.data.conflicts.length || 0, error, storageError, authFailure,
      userId: active?.userId || null, readOnly: !!active && !ownsEditor(), offline: root.navigator?.onLine === false });
  }
  function safeCall(fn, value) {
    try { if (typeof fn === 'function') fn(copy(value)); }
    catch (cause) { root.console?.error('PortalOffline callback:', cause); }
  }
  function notify(emitState = false) {
    if (emitState) safeCall(options.onState, snapshot());
    safeCall(options.onStatus, getStatus());
    render();
  }
  function configure(config = {}) {
    options = { ...options, ...config };
    options.apiBase = String(options.apiBase || '').replace(/\/$/, '');
    notify();
    return api;
  }
  function begin(user, token) {
    const userId = idOf(user);
    if (!userId || typeof token !== 'string' || !token) throw new Error('Usuário e token são obrigatórios');
    end();
    const data = load(userId);
    active = { userId, token, data, generation: ++generation };
    acquireEditor(active);
    authFailure = data.rejectedToken === token || rejectedTokens.has(token) ? 401 : null;
    phase = authFailure ? 'auth-rejected' : 'cached';
    error = null;
    storageError = null;
    timer = root.setInterval(() => { if (active && !authFailure) void flush(); }, 15000);
    notify(true);
    return snapshot();
  }
  function end() {
    if (active?.editorTimer) root.clearInterval(active.editorTimer);
    active?.releaseEditor?.();
    active?.editorReady?.();
    if (active?.leaseKey) {
      try {
        if (JSON.parse(root.localStorage.getItem(active.leaseKey) || 'null')?.owner === active.leaseOwner) root.localStorage.removeItem(active.leaseKey);
      } catch {}
    }
    if (timer !== null) root.clearInterval(timer);
    timer = null;
    ++generation;
    active = null;
    busy = false;
    authFailure = null;
    phase = 'idle';
    error = null;
    storageError = null;
    notify(true);
  }
  function restore() { notify(true); return snapshot(); }
  async function start() { await active?.ready; restore(); return flush(); }
  function capture(tasks, deletedIds = []) {
    if (!active || authFailure) throw new Error('Sessão de demandas indisponível');
    if (!ownsEditor()) throw new Error('Demandas abertas em outra aba; use a aba principal para editar.');
    const incoming = sanitize({ tasks, deletedTaskIds: [...deletedIds] });
    const desired = new Map(incoming.tasks.map(task => [task.id, task]));
    const visible = new Map(snapshot().tasks.map(task => [task.id, task]));
    const next = copy(active.data);
    const baseline = new Map(next.snapshot.tasks.map(task => [task.id, task]));
    const ids = new Set([...visible.keys(), ...desired.keys(), ...incoming.deletedTaskIds]);
    for (const taskId of ids) {
      const task = desired.get(taskId) || null;
      if (same(visible.get(taskId) || null, task)) continue;
      const draft = next.conflicts.find(item => item.taskId === taskId);
      if (draft) { draft.local = copy(task); continue; }
      const index = next.outbox.findIndex(item => item.taskId === taskId);
      const previous = next.outbox[index];
      const base = previous ? previous.base : (baseline.get(taskId) || null);
      // Never drop an undo while an older submitted operation needs an ack.
      if (!previous?.sent && same(base, task)) {
        if (index >= 0) next.outbox.splice(index, 1);
      } else {
        const op = { id: uid(), taskId, base: copy(base), task: copy(task) };
        if (previous?.sent) op.sent = previous.sent;
        if (index >= 0) next.outbox[index] = op;
        else next.outbox.push(op);
      }
    }
    commit(next); // synchronous durable save before any network scheduling
    notify();
    return getStatus();
  }
  function rejectAuth(status = 401) {
    if (!active) return;
    rejectedTokens.add(active.token);
    authFailure = status;
    phase = 'auth-rejected';
    error = `HTTP ${status}`;
    const next = copy(active.data);
    next.session = null;
    next.rejectedToken = active.token;
    try { commit(next); } catch { active.data = next; /* remain blocked even when storage fails */ }
    notify(true);
  }
  function alive(context) { return active === context && context.generation === generation; }
  async function request(context, path, init = {}) {
    const headers = options.authHeaders ? options.authHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json', Authorization: `Bearer ${context.token}` };
    const response = await root.fetch(options.apiBase + path, { ...init, headers, cache: 'no-store', credentials: 'omit' });
    if (!alive(context)) throw new Error('Sessão alterada');
    if (response.status === 401 || response.status === 423) { rejectAuth(response.status); throw new Error(`HTTP ${response.status}`); }
    if (!response.ok) {
      const cause = new Error(`HTTP ${response.status}`);
      cause.endpointUnavailable = path.endsWith('/sync') && [404, 405, 501].includes(response.status);
      throw cause;
    }
    return response.json();
  }
  function applySnapshot(next, state) {
    next.snapshot = sanitize(state); // drop financial / unrelated state entirely
    const tasks = new Map(next.snapshot.tasks.map(task => [task.id, task]));
    for (const draft of next.conflicts) draft.current = copy(tasks.get(draft.taskId) || null);
  }
  async function run(context, send) {
    if (!alive(context) || authFailure || !ownsEditor() || options.canSync?.() === false) return getStatus();
    busy = true;
    phase = 'syncing';
    error = null;
    notify();
    try {
      if (options.beforeSync) await options.beforeSync();
      if (!alive(context) || !ownsEditor() || options.canSync?.() === false) return getStatus();
      if (send && context.data.outbox.length) {
        const next = copy(context.data);
        for (const op of next.outbox.slice(0, 100)) {
          if (!op.sent) op.sent = { id: op.id, taskId: op.taskId, base: copy(op.base), task: copy(op.task) };
        }
        commit(next); // durable submitted journal survives timeout/restart
        const sent = copy(context.data.outbox.slice(0, 100).map(op => op.sent));
        const reply = await request(context, '/api/tasks/sync', { method: 'POST', body: JSON.stringify({ operations: sent }) });
        if (!alive(context) || options.canSync?.() === false) return getStatus();
        if (!Array.isArray(reply.results)) throw new Error('Resposta de sincronização inválida');
        const update = copy(context.data); // includes edits captured during await
        applySnapshot(update, reply.state);
        const seen = new Set();
        for (const result of reply.results) {
          const submitted = sent.find(op => op.id === result.id);
          if (!submitted || seen.has(result.id) || !['applied', 'conflict', 'forbidden'].includes(result.status)) continue;
          seen.add(result.id);
          const index = update.outbox.findIndex(op => op.sent?.id === result.id);
          if (index < 0) continue;
          const latest = update.outbox[index];
          if (result.status === 'applied') {
            if (latest.id === submitted.id) update.outbox.splice(index, 1);
            else {
              latest.base = copy(submitted.task);
              delete latest.sent;
            }
          } else {
            const current = result.deleted ? null : (result.current !== undefined ? result.current : update.snapshot.tasks.find(task => task.id === latest.taskId) || null);
            update.conflicts.push({ taskId: latest.taskId, status: result.status, deleted: !!result.deleted, local: copy(latest.task), base: copy(submitted.base), submitted: copy(submitted.task), current: copy(current) });
            update.outbox.splice(index, 1);
          }
        }
        commit(update);
        safeCall(options.onRemoteState, reply.state);
      } else {
        const state = await request(context, '/api/state');
        if (!alive(context) || options.canSync?.() === false) return getStatus();
        const next = copy(context.data);
        applySnapshot(next, state);
        commit(next);
        safeCall(options.onRemoteState, state);
      }
      phase = context.data.conflicts.length ? 'review' : context.data.outbox.length ? 'pending' : 'synced';
      notify(true);
    } catch (cause) {
      if (alive(context) && !authFailure) {
        phase = cause.endpointUnavailable ? 'endpoint-unavailable' : 'offline';
        error = cause.message;
        // Compatibility GET only. Never PUT the stale whole application state.
        if (cause.endpointUnavailable) {
          try {
            const state = await request(context, '/api/state');
            if (alive(context)) { const next = copy(context.data); applySnapshot(next, state); commit(next); notify(true); }
          } catch (failure) { if (alive(context) && !authFailure) error = failure.message; }
        }
        notify();
      }
    } finally {
      if (alive(context)) { busy = false; notify(); }
    }
    return getStatus();
  }
  function enqueue(send) {
    const context = active;
    if (!context || authFailure) return Promise.resolve(getStatus());
    const work = lane.then(() => run(context, send));
    lane = work.catch(() => {});
    return work;
  }
  function pull() { return enqueue(false); }
  function flush() { return enqueue(true); }
  function resolve(taskId, choice) {
    if (!active || authFailure) throw new Error('Sessão indisponível');
    const next = copy(active.data);
    const index = next.conflicts.findIndex(item => item.taskId === taskId);
    if (index < 0) throw new Error('Conflito não encontrado');
    const draft = next.conflicts[index];
    if (!['keep-local', 'accept-server'].includes(choice)) throw new Error('Resolução inválida');
    if (choice === 'keep-local' && (draft.status === 'forbidden' || draft.deleted)) throw new Error('Demanda excluída ou sem autorização não pode ser reenviada');
    if (choice === 'keep-local' && !same(draft.current, draft.local)) {
      next.outbox.push({ id: uid(), taskId, base: copy(draft.current), task: copy(draft.local) });
    }
    next.conflicts.splice(index, 1);
    commit(next);
    phase = next.outbox.length ? 'pending' : next.conflicts.length ? 'review' : 'synced';
    notify(true);
    return getStatus();
  }
  function saveSession(session, token = active?.token) {
    const userId = idOf(session?.user);
    if (!active || userId !== active.userId || token !== active.token || authFailure) throw new Error('Validação de sessão incompatível');
    const next = copy(active.data);
    // Save metadata only: no screen content, credentials, or financial records.
    const metadata = items => (items || []).map(item => {
      if (typeof item === 'string') return item;
      const result = {};
      for (const field of ['id', 'name', 'kind', 'description']) if (item[field] !== undefined) result[field] = copy(item[field]);
      return result;
    });
    const user = {};
    for (const field of ['id', 'displayName', 'role', 'management', 'sectorId', 'sectorIds', 'sectorName', 'allowedScreens', 'screens', 'worksSaturday', 'worksSunday']) {
      if (session.user[field] !== undefined) user[field] = copy(session.user[field]);
    }
    user.sectors = metadata(session.user.sectors);
    user.teammates = (session.user.teammates || []).map(person => {
      const teammate = {};
      for (const field of ['id', 'displayName', 'sectorId', 'sectorIds', 'worksSaturday', 'worksSunday']) if (person[field] !== undefined) teammate[field] = copy(person[field]);
      return teammate;
    });
    next.session = { user, screens: metadata(session.screens), sectors: metadata(session.sectors), token, validatedAt: Date.now(), offlineDemandsOnly: true };
    next.rejectedToken = null;
    commit(next);
    return copy(next.session);
  }
  function readSession(token, userId) {
    if (!token || rejectedTokens.has(token) || (active?.token === token && authFailure)) return null;
    const candidates = userId ? [key(idOf(userId))] : Array.from({ length: root.localStorage.length }, (_, i) => root.localStorage.key(i)).filter(name => name?.startsWith(prefix()));
    for (const name of candidates) {
      try {
        const data = JSON.parse(root.localStorage.getItem(name) || 'null');
        const session = data?.session;
        const age = Date.now() - session?.validatedAt;
        if (data?.version === VERSION && data.rejectedToken !== token && session?.token === token && Number.isFinite(age) && age >= 0 && age <= TTL && (!userId || idOf(session.user) === idOf(userId))) return copy(session);
      } catch { /* corrupt cache never grants a session */ }
    }
    return null;
  }
  function clearSession(token = active?.token) {
    if (!token) return;
    rejectedTokens.add(token);
    for (const name of Array.from({ length: root.localStorage.length }, (_, i) => root.localStorage.key(i)).filter(name => name?.startsWith(prefix()))) {
      const data = JSON.parse(root.localStorage.getItem(name) || 'null');
      if (data?.session?.token !== token) continue;
      data.session = null;
      data.rejectedToken = token;
      root.localStorage.setItem(name, JSON.stringify(data));
      if (active && name === key(active.userId)) active.data = data;
    }
  }
  function render() {
    const document = root.document;
    const anchor = document?.getElementById('lastSaved');
    if (!anchor) return;
    let host = document.getElementById('portalOfflineStatus');
    if (!host) {
      host = document.createElement('section');
      host.id = 'portalOfflineStatus';
      host.setAttribute('aria-label', 'Sincronização de demandas');
      anchor.insertAdjacentElement('afterend', host);
    }
    host.replaceChildren();
    if (!active) return;
    const text = document.createElement('span');
    text.setAttribute('role', 'status');
    text.textContent = !ownsEditor() ? 'Somente leitura: as demandas estão abertas em outra aba.' : storageError || (authFailure ? 'Sessão recusada; entre novamente.' : busy ? 'Sincronizando demandas…' : `${active.data.outbox.length} pendente(s) · ${active.data.conflicts.length} rascunho(s) para revisão${error ? ' · sem sincronização: ' + error : ''}`);
    host.appendChild(text);
    if (authFailure) return;
    for (const draft of active.data.conflicts) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${draft.status === 'forbidden' ? 'Sem autorização' : 'Conflito'}: ${draft.local?.title || draft.current?.title || draft.taskId}`;
      details.appendChild(summary);
      for (const [label, task] of [['Seu rascunho', draft.local], ['Servidor', draft.current]]) {
        const pre = document.createElement('pre');
        const fields = task ? [['Demanda', task.title], ['Responsável', task.owner], ['Prazo', task.due], ['Situação', { todo: 'Pendente', progress: 'Em andamento', done: 'Concluída' }[task.status]], ['Observações', task.notes], ['Checklist', (task.checklist || []).map(item => `${item.done ? 'Concluído' : 'Pendente'}: ${item.text}`).join('\n')]] : [];
        pre.textContent = `${label}\n${task === null ? 'Demanda excluída' : fields.filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`).join('\n')}`;
        details.appendChild(pre);
      }
      for (const [choice, label] of [['keep-local', 'Manter minha alteração'], ['accept-server', 'Usar servidor e descartar meu rascunho']]) {
        if (choice === 'keep-local' && (draft.status === 'forbidden' || draft.deleted)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-secondary';
        button.textContent = label;
        button.disabled = !!authFailure;
        button.addEventListener('click', () => { resolve(draft.taskId, choice); });
        details.appendChild(button);
      }
      host.appendChild(details);
    }
  }
  async function registerWorker() {
    if (!root.isSecureContext || !root.navigator?.serviceWorker) return null;
    return root.navigator.serviceWorker.register(new URL('portal-sw.js', root.location.href).href, { scope: './' });
  }
  const api = { configure, begin, start, restore, capture, pull, flush, end,
    saveSession, readSession, clearSession, rejectAuth, resolve, registerWorker,
    getSnapshot: () => snapshot(), getStatus,
    getConflicts: () => copy(active?.data.conflicts || []) };
  root.PortalOffline = api;
  root.addEventListener?.('online', () => { if (active && !authFailure) void flush(); });
  root.document?.addEventListener('DOMContentLoaded', () => render());
  root.addEventListener?.('pagehide', end);
})(typeof window !== 'undefined' ? window : globalThis);

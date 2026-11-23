const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function notificationContext(prefs = {}) {
  const sent = [], timers = [], storage = new Map();
  storage.set('portal-avisos-prefs-v1', JSON.stringify({ admin: { enabled: true, tasks: true, assigned: true, deadlines: true, ...prefs } }));
  class Notification {
    static permission = 'granted';
    constructor(title, options) { sent.push({ title, ...options }); }
  }
  const user = { id: 'admin', displayName: 'Pessoa de teste', role: 'admin' };
  const window = { Notification, isSecureContext: true, PortalAccess: { Access: { user, token: 'synthetic' } }, addEventListener() {} };
  const listeners = { addEventListener() {} };
  const context = vm.createContext({ window, Notification, console,
    document: { querySelectorAll: () => [], addEventListener() {} },
    $: selector => ['#reminderDone', '#reminderLater'].includes(selector) ? listeners : null,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    sessionStorage: { getItem: () => null, setItem() {} },
    scopedTasks: () => [{ id: 'due', owner: user.displayName, title: 'Demanda sintética', status: 'todo', due: '2000-01-01' }],
    today: () => '2026-11-12', showToast() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => { timers.push(true); return 1; }, clearInterval() {},
  });
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  vm.runInContext(app.slice(app.indexOf('const NOTIFY_LEGACY_KEY'), app.indexOf('async function bootstrap()')), context);
  return { context, sent, timers, api: window.PortalNotify };
}

test('demand and deadline pushes are enabled by default and honor category preference', () => {
  const { sent, api } = notificationContext();
  assert.equal(api.enabled(), true);
  for (const category of ['tasks', 'deadlines']) assert.equal(api.allows(category), true);
  for (const category of ['assigned', 'unknown']) assert.equal(api.allows(category), false);
  api.syncTasks([]);
  api.syncTasks([{ id: 'assigned', owner: 'Outra pessoa' }]);
  api.syncTasks([{ id: 'assigned', owner: 'Pessoa de teste' }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Demanda atribuída a você');
  assert.equal(notificationContext({ tasks: false }).api.allows('tasks'), false);
  assert.equal(notificationContext({ deadlines: false }).api.allows('deadlines'), false);
});

test('return pushes are enabled by default and honor category preference', () => {
  const enabled = notificationContext();
  assert.equal(enabled.api.allows('retornos'), true);
  enabled.api.push({ category: 'retornos', title: 'Erro no retorno financeiro' });
  assert.equal(enabled.sent.length, 1);
  const disabled = notificationContext({ retornos: false });
  assert.equal(disabled.api.allows('retornos'), false);
  disabled.api.push({ category: 'retornos', title: 'Retorno corrigido' });
  assert.equal(disabled.sent.length, 0);
});

test('globally disabled notifications also block financial return pushes', () => {
  const { api, sent } = notificationContext({ enabled: false });
  assert.equal(api.enabled(), false);
  api.push({ category: 'retornos', title: 'Erro' });
  assert.equal(sent.length, 0);
});

test('chat notifications remain available without demand pushes', () => {
  const { api, sent } = notificationContext();
  api.syncChat([]);
  api.syncChat([{ scope: 'sector', scopeId: 'test', name: 'Setor de teste', unread: 1,
    lastMessage: { id: 'message', userId: 'another', userName: 'Outra pessoa', body: 'Mensagem sintética' } }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Nova mensagem · Setor de teste');
});

test('return monitor pushes only new errors and confirmed corrections, without repeats', async () => {
  const elements = new Map(), sent = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: id === 'retornosStatus' ? 'all' : '', textContent: '',
      classList: { contains: () => false, add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {} });
    return elements.get(id);
  }
  let incidents = [{ id: 1, state: 'open', type: 'Instituição teste', message: 'Falha sintética' }];
  let allowed = true;
  const access = { Access: { user: { role: 'admin' }, token: 'synthetic' }, canSee: () => true,
    api: async () => ({ incidents, institutions: [], monitor: { running: false }, period: { checkedAt: '2026-11-12' } }) };
  const window = { PortalAccess: access, PortalNotify: { enabled: () => true, allows: category => allowed && category === 'retornos', push: item => sent.push(item) } };
  const context = vm.createContext({ window, document: { getElementById: element }, console, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'retornos.js'), 'utf8'), context);
  const refresh = async () => { window.enterRetornosScreen(); await new Promise(setImmediate); };
  await new Promise(setImmediate);
  assert.equal(sent.length, 0);
  incidents = [...incidents, { id: 2, state: 'open', type: 'Outra instituição', message: 'Outro erro' }];
  await refresh();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, 'retornos');
  assert.equal(sent[0].title, 'Erro no retorno financeiro');
  await refresh();
  assert.equal(sent.length, 1);
  incidents = incidents.map(item => ({ ...item, state: 'resolved' }));
  await refresh();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].title, 'Retorno corrigido');
  allowed = false;
  incidents = [...incidents, { id: 3, state: 'open', type: 'Teste', message: 'Sem push' }];
  await refresh();
  assert.equal(sent.length, 3);
});

test('return counts and navigation badge follow every visible filter', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'retornosStatus' ? 'all' : '', textContent: '',
      listeners: {}, hidden: false, classList: { contains: () => false, add() {}, remove() {},
        toggle(name, hidden) { element(id).hidden = hidden; } }, setAttribute() {},
      addEventListener(name, handler) { this.listeners[name] = handler; } });
    return elements.get(id);
  };
  let incidents = [{ id: 1, type: 'Banco A', state: 'open', message: 'Excluído' },
    { id: 2, type: 'Banco A', state: 'resolved', message: 'Pago' },
    { id: 3, type: 'Banco B', state: 'open', message: 'Falha' }];
  const window = { PortalAccess: { Access: { user: { role: 'user' }, token: 'test' }, canSee: () => true,
    api: async () => ({ incidents, institutions: ['Banco A', 'Banco B'], globalOpen: 900, monitor: {}, period: { checkedAt: '2026-11-12' } }) } };
  const context = vm.createContext({ window, document: { getElementById: element }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'retornos.js'), 'utf8'), context);
  await new Promise(setImmediate);
  const check = (open, resolved) => {
    assert.equal(element('retornosAlertCount').textContent, `${open} com erro · ${resolved} corrigidos`);
    assert.equal(element('retornosNavBadge').textContent, String(open));
    assert.equal(element('retornosNavBadge').hidden, !open);
  };
  const filter = (id, value) => { element(id).value = value; element(id).listeners.input(); };
  check(2, 1);
  filter('retornosInstitution', 'Banco A'); check(1, 1);
  filter('retornosStatus', 'resolved'); check(0, 1);
  filter('retornosSearch', 'inexistente'); check(0, 0);
  filter('retornosSearch', 'pago'); check(0, 1);
  filter('retornosStatus', 'open'); check(0, 0);
  filter('retornosSearch', 'excluido'); check(1, 0);
  incidents = [];
  window.enterRetornosScreen(); await new Promise(setImmediate); check(0, 0);
});

test('new contract category honors preferences independently from demands', () => {
  const { api, sent } = notificationContext();
  assert.equal(api.allows('contracts'), true);
  api.push({ category: 'contracts', title: 'Novo contrato disponível' });
  assert.equal(sent.length, 1);
  const disabled = notificationContext({ contracts: false });
  disabled.api.push({ category: 'contracts', title: 'Novo contrato disponível' });
  assert.equal(disabled.sent.length, 0);
  assert.equal(disabled.api.allows('tasks'), true);
});

test('return screen is individually assignable and not shared with unauthorized staff', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'access.js'), 'utf8');
  const Access = { user: { role: 'user', allowedScreens: ['tasksScreen'] }, screens: [
    { id: 'retornosScreen', name: 'Retorno Instituição', kind: 'builtin', sector: 'Financeiro' },
    { id: 'movimentacoesScreen', name: 'Movimentações', kind: 'builtin' }] };
  const context = vm.createContext({ Access, DISABLED_SCREENS: [], SHARED_SCREENS: ['tasksScreen'], escapeHtml: value => value });
  vm.runInContext(source.slice(source.indexOf('function canSee('), source.indexOf('function isManager(')), context);
  vm.runInContext(source.slice(source.indexOf('function screenChecksHtml('), source.indexOf('function fmtBirthday(')), context);
  assert.equal(vm.runInContext("canSee('retornosScreen')", context), false);
  Access.user.allowedScreens.push('retornosScreen');
  assert.equal(vm.runInContext("canSee('retornosScreen')", context), true);
  assert.equal(vm.runInContext("canSee('movimentacoesScreen')", context), false);
  const html = vm.runInContext('screenChecksHtml()', context);
  assert.match(html, /value="retornosScreen"/);
  assert.doesNotMatch(html, /value="movimentacoesScreen"/);
});

function loadingContext() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const classes = () => {
    const values = new Set();
    return { add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      contains: name => values.has(name) };
  };
  const elements = {
    portalLoading: { classList: classes(), setAttribute() {} },
    portalLoadingTitle: { textContent: '' },
    portalLoadingStep: { textContent: '' },
  };
  const window = {};
  const context = vm.createContext({ window, document: {
    getElementById: id => elements[id] || null, documentElement: { classList: classes() },
  }, performance: { now: () => now },
  setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
  clearTimeout: id => timers.delete(id),
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'access.js'), 'utf8');
  const start = source.indexOf('const PortalLoading = (() => {');
  const end = source.indexOf('window.PortalLoading = PortalLoading;', start) + 'window.PortalLoading = PortalLoading;'.length;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const advance = ms => {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = target;
  };
  return { api: window.PortalLoading, elements, advance };
}

test('silent notification and job polls never open the global loading overlay', () => {
  const { api, elements, advance } = loadingContext();
  const requests = ['/api/contracts/events?limit=100', '/api/commissions/events?after=1', '/api/notas/job', '/api/recibos/job']
    .map(url => api.trackRequest(url));
  advance(5000);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), false);
  requests.forEach(request => request.done());
  advance(1000);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), false);
});

test('user operations still show and dismiss loading; fast requests do not flash', () => {
  const { api, elements, advance } = loadingContext();
  const fast = api.trackRequest('/api/contracts');
  advance(200); fast.done(); advance(600);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), false);
  const slow = api.trackRequest('/api/contracts');
  advance(421);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), true);
  assert.equal(elements.portalLoadingTitle.textContent, 'Carregando contratos');
  const silent = api.trackRequest('/api/contracts/events');
  advance(300); slow.done(); advance(600);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), false);
  silent.done();
  api.start('login', { title: 'Entrando no portal' });
  assert.equal(elements.portalLoading.classList.contains('is-visible'), true);
  api.stop('login'); advance(320);
  assert.equal(elements.portalLoading.classList.contains('is-visible'), false);
});

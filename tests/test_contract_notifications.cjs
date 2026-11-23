const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'contract-notifications.js'), 'utf8');
const baseline = cursor => ({ events: [], cursor, hasMore: false, baseline: true });
const page = (ids, cursor = ids.at(-1) || 0, hasMore = false) => ({
  events: ids.map(id => ({ id, type: 'contract_created', createdAt: '2026-11-12T00:00:00Z' })),
  cursor, hasMore, baseline: false,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ storage = new Map(), userId = 'synthetic-user', fallback = false, prefs = {} } = {}) {
  const sent = [], requests = [], timers = new Map(), replies = [];
  let timerId = 0;
  const preferences = { enabled: true, contracts: true, permission: true, ...prefs };
  const access = { user: { id: userId, role: 'user' }, token: 'synthetic-session-token' };
  const portal = {
    Access: access, canSee: () => true, openScreen() {},
    api: async url => {
      requests.push(url);
      assert.ok(replies.length, `Unexpected request: ${url}`);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const window = {
    PortalAccess: portal,
    PortalNotify: {
      enabled: () => preferences.enabled && preferences.permission,
      allows: category => category === 'contracts' && preferences.enabled && preferences.contracts,
      push: item => sent.push(item),
    },
    navigator: fallback ? {} : { locks: { request: async (_key, _options, fn) => fn({}) } },
  };
  const context = vm.createContext({
    window, console,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: () => { throw new Error('Real network is forbidden'); },
  });
  vm.runInContext(source, context, { filename: 'contract-notifications.js' });
  const runTimer = async ms => {
    const next = [...timers].find(([, timer]) => ms === undefined || timer.ms === ms);
    assert.ok(next, `Missing timer (${ms})`);
    const [id, timer] = next;
    timers.delete(id);
    return timer.fn();
  };
  const start = async cursor => {
    replies.push(baseline(cursor));
    await window.startContractNotifications();
  };
  const poll = async reply => {
    replies.push(reply);
    await runTimer();
  };
  return { window, context, access, portal, preferences, sent, storage, timers, requests, replies, runTimer, start, poll };
}

const flush = () => new Promise(setImmediate);

test('quiet baseline ignores history; new contract polling is independent of the visible screen', async () => {
  const h = harness();
  h.window.visibleScreen = 'tasksScreen';
  await h.start(900);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests[0], '/api/contracts/events?limit=100');
  await h.poll(page([901]));
  assert.equal(h.requests[1], '/api/contracts/events?after=900&limit=100');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].category, 'contracts');
  assert.equal(h.sent[0].title, 'Novo contrato');
  assert.equal(h.sent[0].body, 'Um novo contrato foi cadastrado no portal.');
  assert.equal(h.sent[0].tag, 'portal-contract-created-901');
  assert.ok(!JSON.stringify(h.sent[0]).includes('company'));
  await h.poll(page([], 901));
  await h.poll(page([901])); // A stale/repeated response must never repeat a push.
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.size, 1);
});

test('start is idempotent and session reset starts with a new quiet baseline, not persisted cursor', async () => {
  const h = harness();
  await h.start(5);
  await h.window.startContractNotifications();
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 1);
  await h.poll(page([6]));
  h.window.resetContractNotifications();
  assert.equal(h.timers.size, 0);
  await h.start(1000);
  assert.equal(h.requests.at(-1), '/api/contracts/events?limit=100');
  assert.equal(h.sent.length, 1);
  await h.poll(page([1001]));
  assert.equal(h.sent.length, 2);
  assert.ok(![...h.storage.values()].some(value => value.includes(h.access.token)));
});

test('global, contracts category and browser permission settings all block pushes and enabling is quiet', async () => {
  for (const preference of ['enabled', 'contracts', 'permission']) {
    const h = harness({ prefs: { [preference]: false } });
    await h.start(10);
    await h.poll(page([11]));
    assert.equal(h.sent.length, 0, preference);
    h.preferences[preference] = true;
    await h.poll(baseline(500));
    assert.equal(h.requests.at(-1), '/api/contracts/events?limit=100');
    assert.equal(h.sent.length, 0);
    await h.poll(page([501]));
    assert.equal(h.sent.length, 1);
  }
});

test('preference changes during an in-flight response do not replay suppressed contracts', async () => {
  const h = harness();
  await h.start(0);
  const pending = deferred();
  h.replies.push(pending.promise);
  const work = h.runTimer();
  h.preferences.contracts = false;
  pending.resolve(page([1]));
  await work;
  assert.equal(h.sent.length, 0);
  const another = deferred();
  h.replies.push(another.promise);
  const work2 = h.runTimer();
  h.preferences.contracts = true;
  another.resolve(page([2]));
  await work2;
  assert.equal(h.sent.length, 0);
  await h.poll(baseline(2));
  assert.equal(h.requests.at(-1), '/api/contracts/events?limit=100');
  await h.poll(page([3]));
  assert.equal(h.sent.length, 1);
});

test('late event response from a reset or replaced session cannot notify or disturb the new poller', async () => {
  const h = harness();
  await h.start(0);
  const old = deferred();
  h.replies.push(old.promise);
  const previousPoll = h.runTimer();
  h.window.resetContractNotifications();
  h.access.token = 'replacement-synthetic-token';
  await h.start(100);
  old.resolve(page([1]));
  await previousPoll;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 1);
  await h.poll(page([101]));
  assert.equal(h.sent.length, 1);
  h.window.resetContractNotifications();
  let opened = false;
  h.portal.openScreen = () => { opened = true; };
  h.sent[0].onClick();
  assert.equal(opened, false, 'Old notification click cannot open another session');
});

test('late baseline response after logout has no state/timer side effects', async () => {
  const h = harness();
  const old = deferred();
  h.replies.push(old.promise);
  const work = h.window.startContractNotifications();
  h.access.user = null;
  h.access.token = '';
  old.resolve(baseline(100));
  await work;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
  await h.window.startContractNotifications();
  assert.equal(h.requests.length, 1);
});

test('switching user without a reset also discards the previous late response', async () => {
  const h = harness();
  await h.start(0);
  const old = deferred();
  h.replies.push(old.promise);
  const work = h.runTimer();
  h.access.user = { id: 'another-user', role: 'admin' };
  old.resolve(page([1]));
  await work;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
  await h.start(100);
  await h.poll(page([101]));
  assert.equal(h.sent.length, 1);
});

test('shared localStorage deduplicates notifications across tabs and is scoped by user', async () => {
  const storage = new Map();
  const a = harness({ storage }), b = harness({ storage });
  await a.start(0);
  await b.start(0);
  await a.poll(page([1]));
  await b.poll(page([1]));
  assert.equal(a.sent.length + b.sent.length, 1);
  await b.poll(page([2]));
  await a.poll(page([2]));
  assert.equal(a.sent.length + b.sent.length, 2);
  const other = harness({ storage, userId: 'different-user' });
  await other.start(1);
  await other.poll(page([2]));
  assert.equal(other.sent.length, 1);
});

test('fallback tab lease settles before delivery and shared high-water mark suppresses repeats', async () => {
  const storage = new Map();
  const a = harness({ storage, fallback: true }), b = harness({ storage, fallback: true });
  await a.start(0);
  await b.start(0);
  a.replies.push(page([1]));
  const first = a.runTimer(15000);
  await flush();
  await b.poll(page([1])); // Other tab sees the pending lease and retries later.
  assert.equal(a.sent.length + b.sent.length, 0);
  await a.runTimer(35);
  await first;
  assert.equal(a.sent.length + b.sent.length, 1);
  b.replies.push(page([1]));
  const second = b.runTimer(15000);
  await flush();
  await b.runTimer(35);
  await second;
  assert.equal(a.sent.length + b.sent.length, 1);
  assert.ok(![...storage.keys()].some(key => key.endsWith(':lease')));
});

test('reset during fallback lock settling prevents delivery', async () => {
  const h = harness({ fallback: true });
  await h.start(0);
  h.replies.push(page([1]));
  const work = h.runTimer(15000);
  await flush();
  h.window.resetContractNotifications();
  await h.runTimer(35);
  await work;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
});

test('enabling contracts while fallback lock settles forces another quiet baseline', async () => {
  const h = harness({ fallback: true, prefs: { contracts: false } });
  await h.start(0);
  h.replies.push(page([1]));
  const work = h.runTimer(15000);
  await flush();
  h.preferences.contracts = true;
  await h.runTimer(35);
  await work;
  assert.equal(h.sent.length, 0);
  await h.poll(baseline(1));
  assert.equal(h.requests.at(-1), '/api/contracts/events?limit=100');
});

test('paginated events advance by sequence and request at most 100 per page', async () => {
  const h = harness();
  await h.start(0);
  await h.poll(page(Array.from({ length: 100 }, (_, i) => i + 1), 100, true));
  assert.equal(h.sent.length, 100);
  assert.equal([...h.timers.values()][0].ms, 0);
  await h.poll(page([101, 102]));
  assert.equal(h.requests.at(-1), '/api/contracts/events?after=100&limit=100');
  assert.equal(h.sent.length, 102);
  assert.equal([...h.timers.values()][0].ms, 15000);
});

test('no access means no requests; loss of authorization invalidates an in-flight event', async () => {
  const h = harness();
  h.portal.canSee = () => false;
  await h.window.startContractNotifications();
  assert.equal(h.requests.length, 0);
  h.portal.canSee = () => true;
  await h.start(0);
  const pending = deferred();
  h.replies.push(pending.promise);
  const work = h.runTimer();
  h.portal.canSee = () => false;
  pending.resolve(page([1]));
  await work;
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 0);
});

test('network failure retries without overlapping requests or dropping the session cursor', async () => {
  const h = harness();
  await h.start(10);
  await h.poll(new Error('synthetic offline'));
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 1);
  await h.poll(page([11]));
  assert.equal(h.requests.at(-1), '/api/contracts/events?after=10&limit=100');
  assert.equal(h.sent.length, 1);
});

test('malformed and demand events never produce a notification', async () => {
  const h = harness();
  await h.start(0);
  await h.poll({ ...page([1]), events: [{ id: 1, type: 'demand_created' }] });
  await h.poll({ ...page([1]), cursor: '1' });
  await h.poll(page([2, 1]));
  assert.equal(h.sent.length, 0);
  await h.poll(page([1]));
  assert.equal(h.sent.length, 1);
});

test('unavailable localStorage fails closed instead of producing cross-tab duplicates', async () => {
  const h = harness();
  await h.start(0);
  vm.runInContext('localStorage.setItem = () => { throw new Error("synthetic storage failure"); };', h.context);
  await h.poll(page([1]));
  assert.equal(h.sent.length, 0);
  assert.equal(h.timers.size, 1);
});

'use strict';
// Run: node --test test_offline_demands.cjs
// VM-only fetch/storage/cache fixtures. Never contacts the running portal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engineSource = fs.readFileSync(path.join(__dirname, '..', 'offline-demands.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '..', 'portal-sw.js'), 'utf8');
const shellCache = /CACHE_VERSION = '([^']+)'/.exec(workerSource)[1];
const clone = value => JSON.parse(JSON.stringify(value));
const task = (id = 'a', title = 'Original') => ({ id, title, sectorId: 'sector-a', status: 'todo', updatedAt: '2099-01-01' });
const snap = (tasks = [], deletedTaskIds = []) => ({ tasks: clone(tasks), deletedTaskIds, billingHistory: ['DO NOT CACHE'], learningData: { confidential: true } });
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => clone(data) });
function storage() {
  const values = new Map();
  return {
    fail: false,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function engine(store = storage(), handler = async () => { throw new Error('offline'); }, extras = {}) {
  let now = 100000000;
  let serial = 0;
  const events = {};
  const intervals = new Map();
  const states = [], statuses = [], calls = [];
  const win = {
    localStorage: store, location: { origin: extras.origin || 'https://portal.test', href: (extras.origin || 'https://portal.test') + '/portal/index.html' },
    navigator: { onLine: true }, crypto: { randomUUID: require('node:crypto').randomUUID },
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { const id = ++serial; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(name, fn) { events[name] = fn; },
    console: { error() {} },
    fetch: async (url, init) => { calls.push({ url, ...clone(init) }); return handler(url, init); },
    ...extras,
  };
  vm.runInNewContext(engineSource, { window: win, URL, Date: win.Date });
  const api = win.PortalOffline;
  api.configure({ onState: value => states.push(value), onStatus: value => statuses.push(value), authHeaders: headers => ({ ...headers, Authorization: 'Bearer test-token' }) });
  return { api, win, calls, states, statuses, store, events, intervals, advance: ms => { now += ms; } };
}
async function seed(e, tasks = [task()]) {
  e.api.begin({ id: 'alice' }, 'token-a');
  e.win.fetch = async (url, init) => { e.calls.push({ url, ...clone(init) }); return response(snap(tasks)); };
  await e.api.pull();
  e.calls.length = 0;
}
function body(call) { return JSON.parse(call.body).operations; }
function journal(e) {
  return JSON.parse([...e.store.values.entries()].find(([key]) => key.endsWith(':alice'))[1]);
}

test('capture detects all mutations canonically, coalesces unsent changes and saves synchronously', async () => {
  const e = engine();
  await seed(e, [task(), task('b'), task('c')]);
  const original = task();
  const reordered = { status: original.status, sectorId: original.sectorId, updatedAt: original.updatedAt, title: original.title, id: original.id };
  e.api.capture([reordered, task('b'), task('c')]);
  assert.equal(e.api.getStatus().pending, 0);
  e.api.capture([task('a', 'Edited'), task('d', 'New')], ['b']);
  const data = journal(e);
  assert.equal(data.outbox.length, 4); // update, create, explicit + inferred delete
  assert.deepEqual(data.outbox.find(op => op.taskId === 'a').base, task());
  assert.equal(data.outbox.find(op => op.taskId === 'd').base, null);
  assert.equal(data.outbox.find(op => op.taskId === 'c').task, null);
  assert.equal(e.calls.length, 0);
  e.api.capture([task(), task('b'), task('c')]);
  assert.equal(e.api.getStatus().pending, 0);
  assert.equal(journal(e).outbox.length, 0);
});

test('restart preserves queue/base; fetched snapshots overlay pending before callback', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Local')]);
  const restarted = engine(e.store, async () => response(snap([task('a', 'Server changed'), task('b')])));
  restarted.api.begin({ id: 'alice' }, 'token-a');
  assert.equal(restarted.states.at(-1).tasks[0].title, 'Local');
  await restarted.api.pull();
  assert.equal(restarted.states.at(-1).tasks.find(t => t.id === 'a').title, 'Local');
  assert.equal(restarted.api.getSnapshot().tasks.length, 2);
  assert.deepEqual(journal(restarted).outbox[0].base, task());
  assert.equal('billingHistory' in journal(restarted).snapshot, false);
  assert.equal(JSON.stringify(journal(restarted)).includes('DO NOT CACHE'), false);
});

test('two users and origins are isolated; legacy global tasks never migrate', async () => {
  const e = engine();
  e.store.setItem('plantao-demandas-v1', JSON.stringify([task('secret')]));
  await seed(e);
  e.api.capture([task('a', 'Alice draft')]);
  e.api.saveSession({ user: { id: 'alice', displayName: 'Alice', password: 'secret' }, screens: [{ id: 'tasksScreen', content: 'financial secret' }], sectors: [{ id: 'sector-a', name: 'Sector' }] });
  e.api.begin({ id: 'bob' }, 'token-b');
  assert.deepEqual(clone(e.api.getSnapshot()), { tasks: [], deletedTaskIds: [] });
  assert.equal(e.api.readSession('token-b'), null);
  assert.equal(e.api.readSession('token-a', 'bob'), null);
  e.api.capture([task('b', 'Bob draft')]);
  e.api.begin({ id: 'alice' }, 'token-a');
  assert.equal(e.api.getSnapshot().tasks[0].title, 'Alice draft');
  const otherOrigin = engine(e.store, undefined, { origin: 'https://other.test' });
  otherOrigin.api.begin({ id: 'alice' }, 'token-a');
  assert.equal(otherOrigin.api.getSnapshot().tasks.length, 0);
  assert.equal(otherOrigin.api.readSession('token-a'), null);
  assert.equal(e.api.readSession('token-a').screens[0].content, undefined);
  assert.equal(e.api.readSession('token-a').user.password, undefined);
});

test('inflight edit retained with original base until ack then rebased onto submitted task', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Submitted')]);
  const entered = deferred(), release = deferred();
  e.win.fetch = async (url, init) => { const operations = JSON.parse(init.body).operations; entered.resolve(operations); return release.promise; };
  const work = e.api.flush();
  const sent = await entered.promise;
  e.api.capture([task('a', 'Newer local')]);
  assert.deepEqual(journal(e).outbox[0].base, task());
  const newId = journal(e).outbox[0].id;
  assert.notEqual(newId, sent[0].id);
  release.resolve(response({ results: [{ id: sent[0].id, status: 'applied' }], state: snap([sent[0].task]) }));
  await work;
  assert.equal(e.api.getStatus().pending, 1);
  assert.equal(journal(e).outbox[0].id, newId);
  assert.deepEqual(journal(e).outbox[0].base, sent[0].task);
  assert.equal(journal(e).outbox[0].sent, undefined);
  assert.equal(e.states.at(-1).tasks[0].title, 'Newer local');
  e.win.fetch = async (url, init) => { const [op] = JSON.parse(init.body).operations; assert.deepEqual(op.base, sent[0].task); return response({ results: [{ id: op.id, status: 'applied' }], state: snap([op.task]) }); };
  await e.api.flush();
  assert.equal(e.api.getStatus().pending, 0);
});

test('inflight undo, create/delete, and delete/recreate preserve explicit successor operations', async () => {
  for (const mode of ['undo', 'create-delete', 'delete-recreate']) {
    const e = engine();
    await seed(e, mode === 'create-delete' ? [] : [task()]);
    const submitted = mode === 'delete-recreate' ? [] : [task('a', 'Submitted')];
    e.api.capture(submitted);
    const entered = deferred(), release = deferred();
    e.win.fetch = async (url, init) => { entered.resolve(JSON.parse(init.body).operations[0]); return release.promise; };
    const work = e.api.flush();
    const op = await entered.promise;
    e.api.capture(mode === 'create-delete' ? [] : [task()]);
    release.resolve(response({ results: [{ id: op.id, status: 'applied' }], state: snap(op.task ? [op.task] : [], op.task ? [] : ['a']) }));
    await work;
    assert.equal(e.api.getStatus().pending, 1, mode);
    assert.deepEqual(journal(e).outbox[0].base, op.task, mode);
    assert.equal(journal(e).outbox[0].task === null, mode === 'create-delete');
  }
});

test('acks only IDs actually sent, leaving a task created inflight and partial results pending', async () => {
  const e = engine();
  await seed(e, []);
  e.api.capture([task('a'), task('b')]);
  const entered = deferred(), release = deferred();
  e.win.fetch = async (url, init) => { entered.resolve(JSON.parse(init.body).operations); return release.promise; };
  const work = e.api.flush();
  const sent = await entered.promise;
  e.api.capture([task('a'), task('b'), task('c')]);
  const unsentId = journal(e).outbox.find(op => op.taskId === 'c').id;
  release.resolve(response({ results: [{ id: sent[0].id, status: 'applied' }, { id: unsentId, status: 'applied' }, { id: sent[0].id, status: 'applied' }], state: snap([task('a')]) }));
  await work;
  assert.equal(e.api.getStatus().pending, 2);
  assert.deepEqual(journal(e).outbox.map(op => op.taskId).sort(), ['b', 'c']);
});

test('ambiguous network failure retains durable submitted ID across restart and inflight edits', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Submitted')]);
  const entered = deferred(), fail = deferred();
  e.win.fetch = async (url, init) => { entered.resolve(JSON.parse(init.body).operations[0]); return fail.promise; };
  const work = e.api.flush();
  const op = await entered.promise;
  e.api.capture([task('a', 'After timeout')]);
  fail.reject(new Error('network dropped after server commit'));
  await work;
  assert.equal(e.api.getStatus().phase, 'offline');
  const restarted = engine(e.store, async (url, init) => {
    const [retry] = JSON.parse(init.body).operations;
    assert.deepEqual(retry, op); // server must deduplicate operation IDs
    return response({ results: [{ id: retry.id, status: 'applied' }], state: snap([retry.task]) });
  });
  restarted.api.begin({ id: 'alice' }, 'token-a');
  await restarted.api.flush();
  assert.equal(journal(restarted).outbox[0].task.title, 'After timeout');
  assert.deepEqual(journal(restarted).outbox[0].base, op.task);
});

test('pull and flush serialize; changing users ignores late responses and stops prior timer', async () => {
  const entered = deferred(), release = deferred();
  let count = 0;
  const e = engine(undefined, async () => {
    if (++count === 1) { entered.resolve(); return release.promise; }
    return response(snap([task('b', 'Bob server')]));
  });
  e.api.begin({ id: 'alice' }, 'token-a');
  const work = e.api.pull();
  await entered.promise;
  const queued = e.api.flush();
  assert.equal(count, 1);
  e.api.begin({ id: 'bob' }, 'token-b');
  assert.equal(e.intervals.size, 1);
  const bob = e.api.pull();
  release.resolve(response(snap([task('a', 'Alice secret')])));
  await Promise.all([work, queued, bob]);
  assert.equal(count, 2); // stale queued Alice flush skipped
  assert.equal(e.api.getSnapshot().tasks[0].title, 'Bob server');
  assert.equal(e.states.some(state => state.tasks.some(t => t.title === 'Alice secret')), false);
  e.api.end();
  assert.equal(e.intervals.size, 0);
});

test('conflicts preserve latest local edits separately, remain durable, and require explicit resolution', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Submitted local')]);
  const entered = deferred(), release = deferred();
  e.win.fetch = async (url, init) => { entered.resolve(JSON.parse(init.body).operations[0]); return release.promise; };
  const work = e.api.flush();
  const op = await entered.promise;
  e.api.capture([task('a', 'Newest local')]);
  release.resolve(response({ results: [{ id: op.id, status: 'conflict', current: task('a', 'Remote') }], state: snap([task('a', 'Remote')]) }));
  await work;
  assert.equal(e.api.getSnapshot().tasks[0].title, 'Remote');
  assert.equal(e.api.getConflicts()[0].local.title, 'Newest local');
  assert.equal(e.api.getStatus().pending, 0);
  const restarted = engine(e.store, async () => response(snap([task('a', 'Even newer remote')])));
  restarted.api.begin({ id: 'alice' }, 'token-a');
  await restarted.api.flush(); // GET, no automatic draft POST
  assert.equal(restarted.calls[0].method, undefined);
  restarted.api.resolve('a', 'keep-local');
  const newOp = journal(restarted).outbox[0];
  assert.deepEqual(newOp.base, task('a', 'Even newer remote'));
  assert.equal(newOp.task.title, 'Newest local');
  assert.notEqual(newOp.id, op.id);
  assert.equal(restarted.api.getConflicts().length, 0);
});

test('accept-server discards only explicitly reviewed draft; forbidden edits cannot resubmit', async () => {
  for (const status of ['conflict', 'forbidden']) {
    const e = engine();
    await seed(e);
    e.api.capture([task('a', 'Local draft')]);
    e.win.fetch = async (url, init) => {
      if (!init.body) return response(snap([task('a', 'Server')]));
      const [op] = JSON.parse(init.body).operations;
      return response({ results: [{ id: op.id, status, current: task('a', 'Server') }], state: snap([task('a', 'Server')]) });
    };
    await e.api.flush();
    e.api.capture([task('a', 'Edited preserved draft')]);
    assert.equal(e.api.getStatus().pending, 0);
    assert.equal(e.api.getConflicts()[0].local.title, 'Edited preserved draft');
    if (status === 'forbidden') assert.throws(() => e.api.resolve('a', 'keep-local'), /autorização/);
    await e.api.flush();
    assert.equal(e.api.getConflicts().length, 1);
    e.api.resolve('a', 'accept-server');
    assert.equal(e.api.getConflicts().length, 0);
    assert.equal(e.api.getSnapshot().tasks[0].title, 'Server');
    assert.equal(e.api.getStatus().pending, 0);
  }
});

test('deletions overlay stale GET, survive restart and ack, and never resurrect automatically', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([], ['a']);
  await e.api.pull(); // stale server still contains a
  assert.equal(e.states.at(-1).tasks.length, 0);
  const restarted = engine(e.store, async (url, init) => {
    if (!init.body) return response(snap([task()], ['a'])); // inconsistent snapshot is normalized
    const [op] = JSON.parse(init.body).operations;
    return response({ results: [{ id: op.id, status: 'applied', deleted: true }], state: snap([], ['a']) });
  });
  restarted.api.begin({ id: 'alice' }, 'token-a');
  await restarted.api.flush();
  await restarted.api.pull();
  assert.deepEqual(clone(restarted.api.getSnapshot()), { tasks: [], deletedTaskIds: ['a'] });
  restarted.api.capture([], ['a']);
  assert.equal(restarted.api.getStatus().pending, 0);
  // Remote deletion vs local edit is a conflict, not a silent recreation.
  const edit = engine();
  await seed(edit);
  edit.api.capture([task('a', 'Local edit')]);
  edit.win.fetch = async (url, init) => {
    const [op] = JSON.parse(init.body).operations;
    return response({ results: [{ id: op.id, status: 'conflict', deleted: true }], state: snap([], ['a']) });
  };
  await edit.api.flush();
  assert.equal(edit.api.getSnapshot().tasks.length, 0);
  assert.equal(edit.api.getConflicts()[0].local.title, 'Local edit');
  edit.api.resolve('a', 'accept-server');
  assert.equal(edit.api.getSnapshot().tasks.length, 0);
});

test('401 and 423 invalidate cached auth, notify parent, stop retry and never permit stale fallback', async () => {
  for (const status of [401, 423]) {
    for (const method of ['pull', 'flush']) {
      const e = engine();
      await seed(e);
      e.api.saveSession({ user: { id: 'alice' }, screens: [], sectors: [] });
      assert.ok(e.api.readSession('token-a'));
      e.api.capture([task('a', 'Unsynced')]);
      let requests = 0;
      e.win.fetch = async () => { ++requests; return response({}, status); };
      await e.api[method]();
      assert.equal(e.api.getStatus().authFailure, status);
      assert.equal(e.api.readSession('token-a'), null);
      assert.equal(e.statuses.at(-1).authFailure, status);
      assert.equal(e.api.getStatus().pending, 1);
      assert.throws(() => e.api.capture([]), /Sessão/);
      await e.api.pull();
      await e.api.flush();
      assert.equal(requests, 1);
      const restarted = engine(e.store);
      restarted.api.begin({ id: 'alice' }, 'token-a');
      assert.ok(restarted.api.getStatus().authFailure);
      assert.equal(restarted.api.readSession('token-a'), null);
    }
  }
});

test('session metadata token match, finite TTL, no refresh via cached reads/pulls, explicit clear', async () => {
  const e = engine();
  await seed(e);
  e.api.saveSession({ user: { id: 'alice', sectorIds: ['sector-a'] }, screens: [{ id: 'tasksScreen' }], sectors: [{ id: 'sector-a' }] });
  assert.equal(e.api.readSession('wrong-token'), null);
  assert.equal(e.api.readSession('token-a').offlineDemandsOnly, true);
  e.advance(24 * 60 * 60 * 1000 + 1);
  await e.api.pull();
  assert.equal(e.api.readSession('token-a'), null);
  e.api.saveSession({ user: { id: 'alice' } });
  assert.ok(e.api.readSession('token-a'));
  e.api.clearSession();
  assert.equal(e.api.readSession('token-a'), null);
  assert.equal(e.api.getSnapshot().tasks.length, 1); // clearing login is not deleting work
});

test('unavailable sync endpoint keeps queue and permits GET only, never legacy PUT', async () => {
  for (const code of [404, 405, 501]) {
    const e = engine();
    await seed(e);
    e.api.capture([task('a', 'Local')]);
    e.win.fetch = async (url, init) => { e.calls.push({ url, ...clone(init) }); return response(url.endsWith('/sync') ? {} : snap([task('a', 'Remote')]), url.endsWith('/sync') ? code : 200); };
    await e.api.flush();
    assert.deepEqual(e.calls.map(call => call.method || 'GET'), ['POST', 'GET']);
    assert.equal(e.api.getStatus().phase, 'endpoint-unavailable');
    assert.equal(e.api.getStatus().pending, 1);
    assert.equal(e.states.at(-1).tasks[0].title, 'Local');
  }
});

test('auth rejection locks cached state even if session invalidation storage fails', async () => {
  const e = engine();
  await seed(e);
  e.api.saveSession({ user: { id: 'alice' }, screens: [], sectors: [] });
  e.api.capture([task('a', 'Protected draft')]);
  e.store.fail = true;
  e.api.rejectAuth(423);
  assert.equal(e.api.getSnapshot().tasks.length, 0);
  assert.equal(e.states.at(-1).tasks.length, 0);
  assert.equal(e.api.readSession('token-a'), null);
  assert.equal(e.api.getStatus().pending, 1);
  e.api.end();
  assert.equal(e.api.readSession('token-a'), null);
  e.api.begin({ id: 'alice' }, 'token-a');
  assert.ok(e.api.getStatus().authFailure);
  assert.equal(e.api.getSnapshot().tasks.length, 0);
});

test('malformed sync response never acks queue or overwrites the validated snapshot', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Durable local')]);
  e.win.fetch = async (url, init) => {
    const [op] = JSON.parse(init.body).operations;
    return response({ results: [{ id: op.id, status: 'applied' }], state: { billingHistory: ['not a demand snapshot'] } });
  };
  await e.api.flush();
  assert.equal(e.api.getStatus().pending, 1);
  assert.equal(e.api.getSnapshot().tasks[0].title, 'Durable local');
  assert.equal(journal(e).snapshot.tasks[0].title, 'Original');
  assert.ok(journal(e).outbox[0].sent);
});

test('storage failure cannot report successful save or send an undurable operation', async () => {
  const e = engine();
  await seed(e);
  e.store.fail = true;
  assert.throws(() => e.api.capture([task('a', 'Not durable')]), /Quota/);
  assert.equal(e.api.getStatus().pending, 0);
  assert.ok(e.api.getStatus().storageError);
  e.store.fail = false;
  e.api.capture([task('a', 'Durable')]);
  e.store.fail = true;
  e.win.fetch = async () => { throw new Error('should not send'); };
  await e.api.flush();
  assert.equal(e.calls.length, 0);
  assert.equal(e.api.getStatus().pending, 1);
});

test('online and interval retry use engine lane; start/restore and detached API values', async () => {
  const e = engine(undefined, async () => response(snap([task()])));
  e.api.begin({ id: 'alice' }, 'token-a');
  assert.deepEqual(clone(e.api.restore()), { tasks: [], deletedTaskIds: [] });
  await e.api.start();
  const detached = e.api.getSnapshot();
  detached.tasks[0].title = 'External mutation';
  assert.equal(e.api.getSnapshot().tasks[0].title, 'Original');
  e.events.online();
  await e.api.pull();
  [...e.intervals.values()][0]();
  await e.api.pull();
  assert.ok(e.calls.length >= 5);
  assert.ok(e.calls.every(call => call.cache === 'no-store' && call.credentials === 'omit'));
});

test('worker registration is opt-in and secure-context only', async () => {
  const e = engine();
  let registrations = 0;
  e.win.navigator.serviceWorker = { register: async (url, opts) => { ++registrations; assert.equal(url, 'https://portal.test/portal/portal-sw.js'); assert.equal(opts.scope, './'); return 'registered'; } };
  assert.equal(await e.api.registerWorker(), null);
  e.win.isSecureContext = true;
  assert.equal(await e.api.registerWorker(), 'registered');
  assert.equal(registrations, 1);
});

function documentFixture() {
  const nodes = new Map();
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; }
    set id(value) { this._id = value; nodes.set(value, this); }
    get id() { return this._id; }
    set innerHTML(_) { throw new Error('Unsafe HTML assignment'); }
    setAttribute() {}
    appendChild(node) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    insertAdjacentElement(_, node) { nodes.set(node.id, node); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const anchor = new Node('span'); anchor.id = 'lastSaved';
  return { nodes, getElementById: id => nodes.get(id), createElement: tag => new Node(tag), addEventListener() {} };
}

test('DOM status/conflict controls use safe textContent and explicit keep-local click', async () => {
  const document = documentFixture();
  const e = engine(undefined, undefined, { document, navigator: { onLine: true, locks: { request: async (name, options, callback) => callback({ name }) } } });
  await seed(e);
  e.api.capture([task('a', '<img onerror=alert(1)>')]);
  e.win.fetch = async (url, init) => {
    const [op] = JSON.parse(init.body).operations;
    return response({ results: [{ id: op.id, status: 'conflict', current: task() }], state: snap([task()]) });
  };
  await e.api.flush();
  const host = document.nodes.get('portalOfflineStatus');
  const details = host.children.find(node => node.tag === 'details');
  assert.ok(details.children[0].textContent.includes('<img onerror=alert(1)>'));
  const button = details.children.find(node => node.tag === 'button' && node.textContent.startsWith('Manter'));
  button.listeners.click();
  assert.equal(e.api.getStatus().pending, 1);
});

test('batches over 100 keep unsent operations durable and continue on the next flush', async () => {
  const e = engine();
  await seed(e, []);
  e.api.capture(Array.from({ length: 110 }, (_, i) => task('batch-' + i)));
  let serverTasks = [];
  e.win.fetch = async (url, init) => {
    const ops = JSON.parse(init.body).operations;
    assert.ok(ops.length <= 100);
    serverTasks.push(...ops.map(op => op.task));
    return response({ results: ops.map(op => ({ id: op.id, status: 'applied' })), state: snap(serverTasks) });
  };
  await e.api.flush();
  assert.equal(e.api.getStatus().pending, 10);
  assert.equal(e.api.getSnapshot().tasks.length, 110);
  await e.api.flush();
  assert.equal(e.api.getStatus().pending, 0);
  assert.equal(serverTasks.length, 110);
});

test('typing pauses both pull and flush; validation happens before sending operations', async () => {
  const e = engine();
  await seed(e);
  e.api.capture([task('a', 'Local edit')]);
  let editing = true, validations = 0;
  e.api.configure({ canSync: () => !editing, beforeSync: async () => { validations++; } });
  await e.api.flush(); await e.api.pull();
  assert.equal(e.calls.length, 0);
  assert.equal(validations, 0);
  editing = false;
  e.win.fetch = async (url, init) => {
    assert.equal(validations, 1);
    const [op] = JSON.parse(init.body).operations;
    return response({ results: [{ id: op.id, status: 'applied' }], state: snap([op.task]) });
  };
  await e.api.flush();
  assert.equal(e.api.getStatus().pending, 0);
});

test('secondary editing tab is read-only and cannot overwrite the primary outbox', async () => {
  const store = storage(), held = new Set();
  const locks = { request: async (name, options, callback) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); }
  } };
  const first = engine(store, undefined, { document: documentFixture(), navigator: { onLine: true, locks } });
  await seed(first);
  first.api.capture([task('a', 'Primary draft')]);
  const second = engine(store, undefined, { document: documentFixture(), navigator: { onLine: true, locks } });
  second.api.begin({ id: 'alice' }, 'token-a');
  await second.api.start();
  assert.equal(second.api.getStatus().readOnly, true);
  assert.throws(() => second.api.capture([]), /outra aba/);
  assert.equal(journal(first).outbox[0].task.title, 'Primary draft');
  assert.equal(second.calls.length, 0);
  second.api.end(); first.api.end();
});

test('corrupt or unreadable editor lease blocks writes without breaking status', async () => {
  const e = engine(undefined, undefined, { document: documentFixture(), setTimeout, clearTimeout });
  await seed(e);
  await e.api.start();
  e.api.capture([task('a', 'Preserved draft')]);
  const leaseKey = [...e.store.values.keys()].find(key => key.endsWith(':editor'));
  e.store.setItem(leaseKey, '{invalid');
  assert.equal(e.api.getStatus().readOnly, true);
  assert.throws(() => e.api.capture([]), /outra aba/);
  assert.equal(journal(e).outbox[0].task.title, 'Preserved draft');
  const read = e.store.getItem.bind(e.store);
  e.store.getItem = key => { if (key === leaseKey) throw new Error('Storage unavailable'); return read(key); };
  assert.equal(e.api.getStatus().readOnly, true);
  assert.throws(() => e.api.capture([]), /outra aba/);
  e.api.end();
});

test('nonsecure UUID fallback still produces valid operation IDs', async () => {
  const e = engine(undefined, undefined, { crypto: { getRandomValues: require('node:crypto').webcrypto.getRandomValues.bind(require('node:crypto').webcrypto) } });
  await seed(e, []);
  e.api.capture([task()]);
  assert.match(journal(e).outbox[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

function worker() {
  const listeners = {}, calls = [], stores = new Map();
  let handler = async request => {
    const url = request.url || request;
    const html = '<!doctype html><script src="access.js?v=1"></script><script src="extra-local.js?v=2"></script><script src="https://cdn.test/library.js"></script><link rel="stylesheet" href="extra.css?v=1"><img src="media/private.png">';
    const type = url.endsWith('.html') ? 'text/html' : url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : 'image/png';
    return new Response(url.endsWith('.html') ? html : 'public static asset', { headers: { 'Content-Type': type } });
  };
  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const values = stores.get(name);
    return {
      async put(url, res) { values.set(typeof url === 'string' ? url : url.url, res.clone()); },
      async match(url) { return values.get(typeof url === 'string' ? url : url.url)?.clone(); },
    };
  }
  const self = { location: { href: 'https://portal.test/portal/portal-sw.js' }, clients: { claim: async () => {} }, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const caches = { open: async name => cacheFor(name), keys: async () => [...stores.keys()], delete: async name => stores.delete(name) };
  vm.runInNewContext(workerSource, { self, caches, Request, Response, URL, fetch: async request => { calls.push(request); return handler(request); } });
  return {
    calls, stores, cacheFor,
    setHandler: fn => { handler = fn; },
    async lifecycle(name) { let work; listeners[name]({ waitUntil: promise => { work = promise; } }); await work; },
    dispatch(url, extras = {}) {
      let work;
      listeners.fetch({ request: { url, method: 'GET', mode: 'cors', headers: new Headers(), ...extras }, respondWith: promise => { work = promise; } });
      return work;
    },
  };
}

test('SW precaches only anonymous local shell including discovered local scripts; keeps unrelated caches', async () => {
  const w = worker();
  w.stores.set('unrelated-app', new Map());
  w.stores.set('portal-demands-shell-old', new Map());
  await w.lifecycle('install');
  await w.lifecycle('activate');
  assert.equal(w.stores.has('unrelated-app'), true);
  assert.equal(w.stores.has('portal-demands-shell-old'), false);
  assert.ok(w.calls.some(request => request.url.endsWith('/extra-local.js')));
  assert.ok(w.calls.some(request => request.url.endsWith('/offline-demands.js')));
  assert.ok(w.calls.every(request => request.credentials === 'omit' && request.cache === 'no-store' && request.redirect === 'error'));
  assert.ok(w.calls.every(request => new URL(request.url).origin === 'https://portal.test' && !request.url.includes('/api/') && !request.url.includes('/media/')));
});

test('SW bypasses API, credentials, CDN, uploads, personal responses and arbitrary documents', async () => {
  const w = worker();
  await w.lifecycle('install');
  for (const [url, extras] of [
    ['https://portal.test/portal/api/state', {}],
    ['https://portal.test/api/state', { mode: 'navigate' }],
    ['https://portal.test/portal/app.js?t=secret', {}],
    ['https://portal.test/portal/app.js', { headers: new Headers({ Authorization: 'Bearer secret' }) }],
    ['https://portal.test/portal/api/demands/upload', { method: 'POST' }],
    ['https://portal.test/portal/media/secret.png', {}],
    ['https://cdn.test/app.js', {}],
    ['https://portal.test/portal/dados.html', { mode: 'navigate' }],
    ['https://portal.test/other-app/', { mode: 'navigate' }],
    ['https://portal.test/portal/index.html?token=secret', { mode: 'navigate' }],
  ]) assert.equal(w.dispatch(url, extras), undefined, url);
  const cache = w.stores.get(shellCache);
  for (const headers of [{ 'Cache-Control': 'private' }, { 'Cache-Control': 'no-store' }, { Vary: 'Cookie' }, { Vary: 'Authorization' }, { 'Set-Cookie': 'session=secret' }]) {
    w.setHandler(async () => new Response('PERSONAL', { headers: { 'Content-Type': 'text/javascript', ...headers } }));
    await w.dispatch('https://portal.test/portal/app.js');
    assert.notEqual(await cache.get('https://portal.test/portal/app.js').clone().text(), 'PERSONAL');
  }
});

test('SW navigation fallback only on network error; never caches navigation/auth/error responses', async () => {
  const w = worker();
  await w.lifecycle('install');
  for (const status of [200, 401, 423, 500]) {
    w.setHandler(async () => new Response('network personal page', { status }));
    const res = await w.dispatch('https://portal.test/portal/', { mode: 'navigate' });
    assert.equal(res.status, status);
    assert.equal(await res.text(), 'network personal page');
  }
  w.setHandler(async () => { throw new Error('network down'); });
  const fallback = await w.dispatch('https://portal.test/portal/index.html', { mode: 'navigate' });
  assert.match(await fallback.text(), /<!doctype html>/);
  const staticFallback = await w.dispatch('https://portal.test/portal/app.js?v=new');
  assert.equal(await staticFallback.text(), 'public static asset');
});

test('SW static network-first and HTTP errors are not stale-cache fallback', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.setHandler(async () => new Response('fresh asset', { headers: { 'Content-Type': 'text/javascript' } }));
  assert.equal(await (await w.dispatch('https://portal.test/portal/app.js?v=3')).text(), 'fresh asset');
  const cached = w.stores.get(shellCache).get('https://portal.test/portal/app.js');
  assert.equal(await cached.clone().text(), 'fresh asset');
  w.setHandler(async () => new Response('not authenticated', { status: 401 }));
  assert.equal((await w.dispatch('https://portal.test/portal/app.js')).status, 401);
  assert.equal(await cached.clone().text(), 'fresh asset');
});

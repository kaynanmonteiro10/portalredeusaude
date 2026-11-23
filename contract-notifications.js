(() => {
  'use strict';

  const INTERVAL = 15000;
  const STORAGE_PREFIX = 'portal-contract-notifications-v1:';
  let generation = 0;
  let active = null;

  function session() {
    const portal = window.PortalAccess;
    const access = portal?.Access;
    if (!access?.user?.id || !access.token || access.offline || typeof portal.api !== 'function') return null;
    const user = access.user;
    const allowed = user.role === 'admin' || Boolean(user.management) || portal.canSee?.('contractsScreen');
    return allowed ? { userId: String(user.id), token: access.token, portal } : null;
  }

  function current(state) {
    const now = session();
    return active === state && state.generation === generation && now?.userId === state.userId && now.token === state.token;
  }

  function allows() {
    const notify = window.PortalNotify;
    return Boolean(notify?.enabled?.() && notify?.allows?.('contracts'));
  }

  function resetContractNotifications() {
    generation += 1;
    if (active?.timer != null) clearTimeout(active.timer);
    active = null;
  }

  function seenSequence(state) {
    const stored = Number(localStorage.getItem(state.key) || 0);
    return Math.max(state.seen, Number.isSafeInteger(stored) && stored >= 0 ? stored : 0);
  }

  async function withDedupLock(state, callback) {
    const locks = window.navigator?.locks;
    if (locks?.request) {
      return locks.request(state.key, { mode: 'exclusive', ifAvailable: true }, lock => lock ? callback() : false);
    }
    // Older browsers: a short settling period resolves simultaneous tab claims.
    // Fail closed when storage is unavailable; no uncoordinated duplicate pushes.
    const key = `${state.key}:lease`;
    const owner = `${Date.now()}:${Math.random()}`;
    let owned = false;
    try {
      const lease = JSON.parse(localStorage.getItem(key) || 'null');
      if (lease && lease.expires > Date.now()) return false;
      localStorage.setItem(key, JSON.stringify({ owner, expires: Date.now() + INTERVAL }));
      await new Promise(resolve => setTimeout(resolve, 35));
      owned = JSON.parse(localStorage.getItem(key) || 'null')?.owner === owner;
      if (!owned || !current(state)) return false;
      return callback();
    } catch {
      return false;
    } finally {
      if (owned) {
        try {
          if (JSON.parse(localStorage.getItem(key) || 'null')?.owner === owner) localStorage.removeItem(key);
        } catch { /* Lease expires without cleanup if storage is unavailable. */ }
      }
    }
  }

  function validPage(page, after) {
    if (!page || !Number.isSafeInteger(page.cursor) || page.cursor < 0 ||
        !Array.isArray(page.events) || page.events.length > 100 ||
        typeof page.hasMore !== 'boolean' || typeof page.baseline !== 'boolean') return false;
    if (page.baseline) return page.events.length === 0 && !page.hasMore;
    if (after == null) return false;
    let previous = after;
    for (const event of page.events) {
      if (!Number.isSafeInteger(event?.id) || event.id <= previous || event.id > page.cursor || event.type !== 'contract_created') return false;
      previous = event.id;
    }
    return page.cursor === previous && (!page.hasMore || page.events.length > 0);
  }

  function schedule(state, delay = INTERVAL) {
    if (current(state)) state.timer = setTimeout(() => poll(state), delay);
    else if (active === state) resetContractNotifications();
  }

  async function poll(state) {
    state.timer = null;
    if (!current(state)) {
      if (active === state) resetContractNotifications();
      return;
    }
    let delay = INTERVAL;
    try {
      const enabled = allows();
      // Enabling a preference/permission must not replay a disabled/offline backlog.
      if (enabled && !state.allowed) state.after = null;
      state.allowed = enabled;
      const after = state.after;
      const query = after == null ? '?limit=100' : `?after=${after}&limit=100`;
      const page = await state.portal.api(`/api/contracts/events${query}`);
      if (!current(state)) return;
      if (!validPage(page, after)) throw new Error('Invalid contract event page');
      const nowAllowed = allows();
      if (nowAllowed && !state.allowed) {
        state.allowed = true;
        state.after = null;
        delay = 0;
        return;
      }
      state.allowed = nowAllowed;
      if (after == null || page.baseline) {
        state.after = page.cursor;
        return; // Every session starts quietly; persistent storage is only dedup.
      }
      const processed = await withDedupLock(state, () => {
        if (!current(state)) return false;
        if (allows() && !state.allowed) {
          state.allowed = true;
          state.after = null;
          delay = 0;
          return false;
        }
        for (const event of page.events) {
          if (!current(state)) return false;
          const seen = seenSequence(state);
          if (event.id <= seen) continue;
          // Consume before delivery, including disabled preferences: never replay.
          localStorage.setItem(state.key, String(event.id));
          state.seen = event.id;
          if (!allows()) continue;
          window.PortalNotify.push({
            category: 'contracts',
            title: 'Novo contrato',
            body: 'Um novo contrato foi cadastrado no portal.',
            tag: `portal-contract-created-${event.id}`,
            onClick: () => {
              if (current(state)) state.portal.openScreen?.('contractsScreen');
            },
          });
        }
        return true;
      });
      if (!current(state)) return;
      if (processed) {
        state.after = page.cursor;
        if (page.hasMore) delay = 0;
      }
    } catch {
      // Retry the current session only. No logging of user/session/event data.
    } finally {
      schedule(state, delay);
    }
  }

  function startContractNotifications() {
    const now = session();
    if (!now) {
      resetContractNotifications();
      return Promise.resolve();
    }
    if (active && current(active)) return Promise.resolve();
    resetContractNotifications();
    const state = {
      ...now, generation, timer: null, after: null, seen: 0, allowed: allows(),
      key: `${STORAGE_PREFIX}${encodeURIComponent(now.userId)}`,
    };
    active = state;
    return poll(state);
  }

  window.startContractNotifications = startContractNotifications;
  window.resetContractNotifications = resetContractNotifications;
})();

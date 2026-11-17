'use strict';
const CACHE_VERSION = 'portal-demands-shell-v9';
const CACHE_PREFIX = 'portal-demands-shell-';
const BASE = new URL('./', self.location.href);
const INDEX = new URL('index.html', BASE).href;
// Local scripts/styles identified in index.html. External ExcelJS/fonts are not
// included. Version-query requests share the local asset's canonical cache key.
const SHELL = [
  'index.html', 'access.js', 'app.js', 'offline-demands.js',
  'retornos.js', 'vendas.js', 'email-center.js', 'movimentacoes.js',
  'finance.js', 'cobranca.js', 'apuracao.js', 'home.js',
  'demandas-preview.js', 'feed-react/feed-react.js', 'adesoes-conferencia.js',
  'styles.css', 'styles-weekly.css', 'demandas-preview.css', 'demandas-relogio.css', 'feed.css',
  'home.css', 'finance.css', 'cobranca.css', 'apuracao.css', 'retornos.css',
  'vendas.css', 'movimentacoes.css', 'email-center.css', 'adesoes-conferencia.css',
  'assets/rede-saude-icone.png', 'assets/rede-saude.png'
];
const allowed = new Set(SHELL.map(path => new URL(path, BASE).href));
function shellURL(value) {
  const url = new URL(value, BASE);
  if (url.origin !== BASE.origin || url.username || url.password || url.hash) return null;
  if (!url.pathname.startsWith(BASE.pathname)) return null;
  // Only known version query keys; token/search/export/upload URLs bypass Cache.
  if ([...url.searchParams.keys()].some(key => key !== 'v')) return null;
  url.search = '';
  return url;
}
function cacheable(response, url) {
  if (!response.ok || response.redirected || !['basic', 'default'].includes(response.type)) return false;
  if (response.url && response.url !== url) return false;
  const policy = response.headers.get('cache-control') || '';
  const vary = response.headers.get('vary') || '';
  if (/no-store|private/i.test(policy) || /cookie|authorization|\*/i.test(vary)) return false;
  if (response.headers.has('set-cookie')) return false;
  const type = response.headers.get('content-type') || '';
  if (url === INDEX) return /text\/html/i.test(type);
  if (/\.js$/.test(url)) return /(?:javascript|ecmascript)/i.test(type);
  if (/\.css$/.test(url)) return /text\/css/i.test(type);
  return /image\//i.test(type);
}
function anonymous(url) {
  return new Request(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
}
function discover(html) {
  // Service workers have no DOMParser. Extract only script src / stylesheet or
  // icon href attributes; no <img>, links to documents, API or upload paths.
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    if (match[1].toLowerCase() === 'link' && !/\brel\s*=\s*["'][^"']*(?:stylesheet|icon)[^"']*["']/i.test(tag)) continue;
    const source = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!source) continue;
    const url = shellURL(source.replace(/&amp;/g, '&'));
    if (!url) continue;
    const relative = url.pathname.slice(BASE.pathname.length);
    if (!/^(?:[\w.-]+\.(?:js|css|png|ico|svg)|feed-react\/[\w.-]+\.js|assets\/[\w.-]+\.(?:png|ico|svg))$/i.test(relative)) continue;
    allowed.add(url.href);
  }
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const response = await fetch(anonymous(INDEX));
    if (!cacheable(response, INDEX)) throw new Error('Public index shell unavailable');
    const html = await response.clone().text();
    if (!/<!doctype\s+html/i.test(html)) throw new Error('Not an application shell');
    discover(html);
    await cache.put(INDEX, response);
    const required = new Set(['access.js', 'app.js', 'offline-demands.js', 'styles.css'].map(path => new URL(path, BASE).href));
    await Promise.all([...allowed].filter(url => url !== INDEX).map(async url => {
      try {
        const asset = await fetch(anonymous(url));
        if (!cacheable(asset, url)) throw new Error('Non-public static response');
        await cache.put(url, asset);
      } catch (cause) { if (required.has(url)) throw cause; }
    }));
    // Normal SW lifecycle: do not force-take-over open tabs running old code.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_VERSION) await caches.delete(name);
    }
    // Recover discovered static allowlist after worker process restarts.
    const cache = await caches.open(CACHE_VERSION);
    const index = await cache.match(INDEX);
    if (index) discover(await index.text());
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('authorization')) return;
  const url = shellURL(request.url);
  if (!url) return;
  const relative = url.pathname.slice(BASE.pathname.length);
  if (/^(?:api|media|uploads|attachments|runtime)(?:\/|$)/i.test(relative)) return;
  if (request.mode === 'navigate') {
    // Restrict fallback to the app entry, not downloads, arbitrary documents,
    // API routes or other applications sharing the origin.
    if (url.href !== INDEX && url.href !== BASE.href) return;
    event.respondWith((async () => {
      try { return await fetch(request); } // 401/423/5xx are NOT offline fallback
      catch (cause) {
        const cached = await (await caches.open(CACHE_VERSION)).match(INDEX);
        if (cached) return cached;
        throw cause;
      }
    })());
    return;
  }
  if (url.href === INDEX || !allowed.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      // Do not cache a response obtained with cookies or credentials.
      const response = await fetch(anonymous(url.href));
      if (cacheable(response, url.href)) {
        // Storage failure must not turn a successful network request into an
        // offline response. Static assets contain no personal application data.
        try { await cache.put(url.href, response.clone()); } catch { /* network wins */ }
      }
      return response;
    } catch (cause) {
      const cached = await cache.match(url.href);
      if (cached) return cached;
      throw cause;
    }
  })());
});

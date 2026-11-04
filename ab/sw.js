const CACHE = 'sound-kit';
const FILES = ['./', 'index.html', 'kit.bin', 'kit-pdf.bin'];
const WAIT = 10000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all(FILES.map(file => cache.add(file).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  event.respondWith(url.pathname.includes('/m/') && url.pathname.endsWith('.bin') ? kept(event.request) : fresh(event.request));
});

self.addEventListener('message', event => {
  if (event.data === 'keep-manuals') event.waitUntil(keepManuals());
});

async function kept(request) {
  const cache = await caches.open(CACHE);
  const key = new URL(request.url).pathname;
  const copy = await cache.match(key);
  if (copy) return copy;
  const answer = await fetch(key);
  if (answer.ok) await cache.put(key, answer.clone());
  return answer;
}

async function keepManuals() {
  const cache = await caches.open(CACHE);
  const list = await fetch('m/list.txt', { cache: 'no-cache' }).then(answer => answer.ok ? answer.text() : '').catch(() => '');
  if (!list) return;
  const wanted = list.split(/\r?\n/).filter(Boolean).map(file => new URL(file, self.registration.scope).pathname);
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.includes('/m/') && path.endsWith('.bin') && !wanted.includes(path)) await cache.delete(request);
  }
  for (const path of wanted) {
    if (!(await cache.match(path))) await kept(new Request(path)).catch(() => null);
  }
}

async function fresh(request) {
  const cache = await caches.open(CACHE);
  const key = new URL(request.url).pathname;
  const fromInternet = fetch(request).then(answer => {
    if (answer.ok) cache.put(key, answer.clone());
    return answer;
  });
  const copy = await cache.match(key);
  if (!copy) return fromInternet;
  const tooSlow = new Promise(done => setTimeout(() => done(copy), WAIT));
  return Promise.race([fromInternet.catch(() => copy), tooSlow]);
}

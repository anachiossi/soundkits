// kit_site_sw.js — makes the kit WEBSITE work with no signal (Ana, 27 Oct: "working offline is fundamental").
// tools/kit_site.py copies it next to index.html as sw.js; the door page (kit_site_door.html) switches it on.
// It keeps a copy of the door page, the locked kit (kit.bin) and the locked PDF (kit-pdf.bin) on the phone.
// Every time: try the internet first (so an update arrives); no signal, or no answer in 10 s → the copy on the phone.
// The locked manuals (m/….bin, listed in m/list.txt) never change under the same name: once kept, always from the phone.
// The kit page asks for them ("keep-manuals") after it opens; they download in the background, once.
// The copies stay locked: without the password they are unreadable, like the files online.
const CACHE = 'sound-kit';
const FILES = ['./', 'index.html', 'kit.bin', 'kit-pdf.bin'];
const WAIT = 10000;   // ms: a weak signal gets this long before the phone's copy is used

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all(FILES.map(file => cache.add(file).catch(() => null))))   // kit-pdf.bin may not exist
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;   // manuals etc.: the browser as usual
  event.respondWith(url.pathname.includes('/m/') && url.pathname.endsWith('.bin') ? kept(event.request) : fresh(event.request));
});

self.addEventListener('message', event => {
  if (event.data === 'keep-manuals') event.waitUntil(keepManuals());
});

// a manual: the phone's copy, else download it once and keep it
async function kept(request) {
  const cache = await caches.open(CACHE);
  const key = new URL(request.url).pathname;
  const copy = await cache.match(key);
  if (copy) return copy;
  const answer = await fetch(key);
  if (answer.ok) await cache.put(key, answer.clone());
  return answer;
}

// every manual of m/list.txt kept on the phone; old ones (no longer listed) thrown away
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
    if (!(await cache.match(path))) await kept(new Request(path)).catch(() => null);   // no signal: next time
  }
}

async function fresh(request) {
  const cache = await caches.open(CACHE);
  const key = new URL(request.url).pathname;   // no "?…", so the copy is always found
  const fromInternet = fetch(request).then(answer => {
    if (answer.ok) cache.put(key, answer.clone());
    return answer;
  });
  const copy = await cache.match(key);
  if (!copy) return fromInternet;
  const tooSlow = new Promise(done => setTimeout(() => done(copy), WAIT));
  return Promise.race([fromInternet.catch(() => copy), tooSlow]);
}

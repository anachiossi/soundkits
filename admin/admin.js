// admin.js — the kit admin page (soundkits/admin, Ana 1 Nov): every request from every kit website, in one list,
// grouped by kit and by who sent it, with their photos; tidy, then Approve or Decline (approve.js writes).
// The admin types her own GitHub key once on each device (kept on that device only, never in the page) and the
// names of the two private repos (the data, the kit inbox). Reuses the soundcheck app's rules from the same site.
// Used by: index.html
import * as github from '/soundcheck/src/store/github.js';
import { loadKitRequests, inboxConnection, photoBytes } from '/soundcheck/src/kit-inbox.js';
import { draftOf, describe, placesFor, KINDS } from '/soundcheck/src/kit-requests.js';
import { readKit, approve, decline } from './approve.js';

const KEY = 'kit-admin';
const main = document.querySelector('main');
const esc = text => String(text ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// no emoji on the page (Ana, 1 Nov): the app's wording has a few (pencil, camera), taken out here
const noEmoji = text => String(text).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{FF0B}]/gu, '').trim();
const settings = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const repoOf = (text, token) => { const [owner, repo] = String(text).split('/'); return { owner, repo, branch: 'main', token }; };

// ---- first time on a device: the key and the two repos ------------------------------------------------------
function setup(message = '') {
  const now = settings() || {};
  main.innerHTML = `<form class="card setup"><h2>Set up this device</h2>${message ? `<p class="bad">${esc(message)}</p>` : ''}
    <label>Your GitHub key<input name="token" type="password" autocomplete="off" value="${esc(now.token || '')}" placeholder="github_pat_…"></label>
    <label>Data repo<input name="data" value="${esc(now.data || '')}" placeholder="owner/name"></label>
    <label>Kit inbox repo<input name="inbox" value="${esc(now.inbox || '')}" placeholder="owner/name"></label>
    <p class="muted">Kept on this device only. The key needs Contents read and write on both repos and on the kit photos repo.</p>
    <button class="go">Save</button></form>`;
  main.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    localStorage.setItem(KEY, JSON.stringify({ token: form.token.value.trim(), data: form.data.value.trim(), inbox: form.inbox.value.trim() }));
    load();
  });
}

// ---- the list ---------------------------------------------------------------------------------------------
async function load() {
  const set = settings();
  if (!set?.token || !set.data || !set.inbox) return setup();
  main.innerHTML = '<p class="muted">Reading the inbox…</p>';
  const data = repoOf(set.data, set.token);
  const fake = { settings: { kit_inbox: set.inbox } };   // the app's inbox reader wants a film that names its inbox
  const inbox = inboxConnection(fake, { token: set.token });
  let requests, kits, base;
  try {
    const found = await loadKitRequests(fake, { token: set.token });
    if (found.cantRead) return setup('This key cannot read the kit inbox repo.');
    requests = found.requests;
    base = await github.readTree(data);
    kits = await Promise.all(Object.keys(base.files).filter(path => /^kits\/[^/]+\/kit\.json$/.test(path)).map(async path =>
      ({ ...(await github.readJsonFile(data, base.files[path])), folder: path.replace('/kit.json', '') })));
  } catch (error) {
    return setup(`Could not read: ${error.message}`);
  }
  const withSite = kits.filter(kit => kit.site);
  const kitOf = request => kits.find(kit => kit.site && kit.site === request.kit) || (withSite.length === 1 ? withSite[0] : null);
  const projects = {};
  for (const kit of new Set(requests.map(kitOf).filter(Boolean))) projects[kit.folder] = await readKit(data, base, kit);
  main.innerHTML = `<p class="summary"><span><b>${requests.length}</b> ${requests.length === 1 ? 'request' : 'requests'} waiting</span>
    <button class="small" data-do="reload">Refresh</button></p>`;
  if (!requests.length) main.insertAdjacentHTML('beforeend', '<p class="empty">Nothing waiting from the kit websites.</p>');
  for (const kit of [...kits, null]) {
    const mine = requests.filter(request => kitOf(request) === kit);
    if (!mine.length) continue;
    main.insertAdjacentHTML('beforeend', `<h2 class="kit">${esc(kit ? `${kit.name} · ${kit.site}` : 'Kit not found')}</h2>`);
    const people = [...new Set(mine.map(request => request.who || 'Someone'))];
    for (const who of people) {
      main.insertAdjacentHTML('beforeend', `<h3 class="who">From ${esc(who)}</h3>`);
      for (const request of mine.filter(r => (r.who || 'Someone') === who)) main.appendChild(card({ data, inbox }, kit, kit && projects[kit.folder], request));
    }
  }
  main.querySelector('[data-do="reload"]').addEventListener('click', load);
}

// ---- one request: what they asked, their photos, the form to tidy, Decline / Approve ------------------------
function card(connections, kit, project, request) {
  const box = document.createElement('section');
  box.className = 'card';
  if (!project) {
    box.innerHTML = `<p>${esc(request.name || request.notes || request.mode)}</p><p class="bad">No kit has the site code "${esc(request.kit)}".</p>`;
    return box;
  }
  const draft = draftOf(project, request);
  const field = (label, html) => `<label>${label}${html}</label>`;
  const input = (name, value, extra = '') => `<input name="${name}" value="${esc(value)}" ${extra}>`;
  let form = '';
  if (draft.kind === 'battery') {
    form = field('Name', input('name', draft.name)) + (request.item ? '' : field('Battery', input('battery', draft.battery)))
      + field(request.mode === 'edit' ? 'How many in all' : 'New batteries', input('qty', draft.qty, 'type="number" min="0"'));
  } else if (draft.kind !== 'firmware') {
    const places = placesFor(project).filter(place => place.id !== request.item);
    form = (request.mode === 'edit' ? field('Still in the kit', `<select name="gone">${[['', 'Keep it'], ['film', 'Not on this film'], ['forever', 'Gone for good']]
      .map(([value, text]) => `<option value="${value}"${draft.gone === value ? ' selected' : ''}>${text}</option>`).join('')}</select>`) : '')
      + (request.mode === 'add' ? field('What is it', `<select name="kind">${Object.entries(KINDS).map(([key, kind]) => `<option value="${key}"${draft.kind === key ? ' selected' : ''}>${kind.label}</option>`).join('')}</select>`) : '')
      + field('Name', input('name', draft.name)) + field('How many', input('qty', draft.qty, 'type="number" min="1"'))
      + field('Where', `<select name="inside">${draft.inside === null ? '<option value="same">where it is now</option>' : ''}<option value=""${draft.inside === '' ? ' selected' : ''}>on the truck (its own volume)</option>`
        + places.map(place => `<option value="${place.id}"${draft.inside === place.id ? ' selected' : ''}>${esc(place.text)}</option>`).join('') + '</select>');
  }
  if (draft.kind !== 'firmware') form += field('Note (kept with it)', input('note', draft.note));
  box.innerHTML = `<div class="photos"></div><p class="what">${describe(project, request).map(line => esc(noEmoji(line))).join('<br>')}</p>
    <form>${form}</form><p class="result"></p>
    <div class="buttons"><button class="small" data-do="decline">Decline</button><button class="go" data-do="approve">${draft.kind === 'firmware' ? 'Done' : 'Approve'}</button></div>`;
  for (const sha of Object.values(request.photoShas || {})) {   // their photos, read from the inbox
    photoBytes(connections.inbox, sha).then(bytes => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      box.querySelector('.photos').insertAdjacentHTML('beforeend', `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt=""></a>`);
    }).catch(() => null);
  }
  const say = (text, bad) => { const result = box.querySelector('.result'); result.textContent = text; result.className = `result${bad ? ' bad' : ''}`; };
  const buttons = [...box.querySelectorAll('.buttons button')];
  const busy = on => buttons.forEach(button => { button.disabled = on; });
  box.querySelector('[data-do="decline"]').addEventListener('click', async () => {
    busy(true);
    try { await decline(connections, request); say('Declined: their phone goes back to the kit as it is.'); box.classList.add('done'); }
    catch (error) { say(`Not declined: ${error.message}`, true); busy(false); }
  });
  box.querySelector('[data-do="approve"]').addEventListener('click', async () => {
    const values = Object.fromEntries(new FormData(box.querySelector('form')));
    const tidy = { ...draft, ...values };
    if ('qty' in values) tidy.qty = Number(values.qty) || 0;
    if ('inside' in values) tidy.inside = values.inside === 'same' ? null : values.inside;
    busy(true);
    say('Saving…');
    try { say(await approve(connections, kit, request, tidy)); box.classList.add('done'); }
    catch (error) { say(`Not saved: ${error.message}. Nothing changed in the kit.`, true); busy(false); }
  });
  return box;
}

document.querySelector('[data-do="settings"]').addEventListener('click', () => setup());
load();

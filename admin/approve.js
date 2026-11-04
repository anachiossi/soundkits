// approve.js — the kit admin page's writing (soundkits/admin, Ana 1 Nov): what an approved request does to the kit,
// in the private data repo, the same way the soundcheck app does it (it reuses the app's own rules, from the same site:
// kit-requests.js = what a request means, kit-inbox.js = the inbox, store/github.js = reading and writing GitHub).
// The kit only grows: "not on this film" only takes it off the film's list, "gone for good" marks it, nothing is deleted.
//   approve: their photos → the kit photos repo (+ a small copy), then ONE commit in the data repo (items, history,
//            photos, batteries, the film's on-film list), then the request leaves the inbox with an "approved" note
//   decline: the request leaves the inbox with a "refused" note; nothing else changes
// Used by: admin.js
import * as github from '/soundcheck/src/store/github.js';
import { formatJson } from '/soundcheck/src/store/repo-files.js';
import { historyOf, kitItems } from '/soundcheck/src/gear-rules.js';
import { changeOf } from '/soundcheck/src/kit-requests.js';
import { photoBytes, base64Of, commitWithRetry, closeRequest } from '/soundcheck/src/kit-inbox.js';

const now = () => new Date().toISOString();

// a kit's files, as the request rules want them (like a film in the app)
export async function readKit(data, base, kit) {
  const read = async (path, empty) => (base.files[path] ? github.readJsonFile(data, base.files[path]) : empty);
  return {
    kit, gearItems: await read(`${kit.folder}/gear/items.json`, []), gearHistory: await read(`${kit.folder}/gear/history.json`, []),
    gearBatteries: await read(`${kit.folder}/gear/batteries.json`, {}), gearPhotos: await read(`${kit.folder}/gear/photos.json`, {}),
    gearOnFilm: (await read(`projects/${kit.film}/gear/on-film.json`, null)) || undefined,
  };
}

// a small copy of a photo for the lists (like the other kit photos' gear/thumbs/)
async function smallCopy(bytes, pixels = 320) {
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const scale = Math.min(1, pixels / Math.max(image.width, image.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(image.width * scale), height: Math.round(image.height * scale) });
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  return new Uint8Array(await blob.arrayBuffer());
}

// their photos, from the inbox to the kit photos repo → [{ file, label }] for gear/photos.json
async function movePhotos(project, inbox, request) {
  const names = Object.keys(request.photoShas || {});
  if (!names.length) return [];
  const [owner, repo] = String(project.gearPhotos.photos_repo || '').split('/');
  if (!owner || !repo) throw new Error('this kit has no photos repo (gear/photos.json → photos_repo)');
  const files = {};
  const added = [];
  for (const [n, name] of names.entries()) {
    const bytes = await photoBytes(inbox, request.photoShas[name]);
    const file = `gear/kit-${request.id}-${n + 1}.jpg`;
    files[file] = { base64: base64Of(bytes) };
    files[file.replace('gear/', 'gear/thumbs/')] = { base64: base64Of(await smallCopy(bytes)) };
    added.push({ file, label: `${request.who || 'Someone'}'s photo (kit website, ${String(request.at || '').slice(0, 10)})` });
  }
  await commitWithRetry({ ...inbox, owner, repo }, files, `Photos from ${request.who || 'someone'}'s kit request ${request.id}`);
  return added;
}

// new batteries numbered after the last one in their group, or a new type (the app's battery-editing.js growBatteries)
function growBatteries(file, { id, name, battery, add, note }) {
  let groupId = id;
  let groups = file.groups || [];
  if (groupId) groups = groups.map(g => (g.id !== groupId ? g : { ...g, name: name || g.name, ...(note ? { note: [g.note, note].filter(Boolean).join(' · ') } : {}) }));
  else {
    const used = new Set(groups.map(g => g.id));
    let n = groups.length + 1;
    while (used.has(`b${n}`)) n++;
    groupId = `b${n}`;
    groups = [...groups, { id: groupId, name, ...(battery ? { battery } : {}), ...(note ? { note } : {}) }];
  }
  const batteries = file.batteries || [];
  const ids = new Set(batteries.map(b => b.id));
  let label = Math.max(0, ...batteries.filter(b => b.group === groupId).map(b => Number(b.label) || 0));
  const extra = [];
  while (extra.length < (Number(add) || 0)) {
    label++;
    if (!ids.has(`${groupId}-${label}`)) extra.push({ id: `${groupId}-${label}`, group: groupId, label: String(label), state: 'full', since: now() });
  }
  return { file: { ...file, groups, batteries: [...batteries, ...extra] }, groupId };
}

// the kit's files after the change (only the ones that change), as text for the repo
function filesFor(project, change, photos) {
  const kit = project.kit.folder;
  const onFilmPath = `projects/${project.kit.film}/gear/on-film.json`;
  const files = {};
  let items = project.gearItems;
  let history = project.gearHistory;
  let photoTarget = null;
  if (change.save) {
    const before = items.find(item => item.id === change.save.id) || null;
    const object = { ...before, ...change.save, name: String(change.save.name || '').trim(), qty: Math.max(1, Number(change.save.qty) || 1), added: before?.added || now() };
    const event = historyOf(before, object);
    items = before ? items.map(item => (item.id === object.id ? object : item)) : [...items, object];
    if (event) history = [...history, { at: now(), item: object.id, name: object.name, ...event }];
    if (!before && Array.isArray(project.gearOnFilm?.items)) files[onFilmPath] = formatJson({ ...project.gearOnFilm, items: [...project.gearOnFilm.items, object.id] });
    photoTarget = object.id;
  } else if (change.offFilm) {
    const onFilm = Array.isArray(project.gearOnFilm?.items) ? project.gearOnFilm.items : kitItems(project).map(item => item.id);
    files[onFilmPath] = formatJson({ ...project.gearOnFilm, items: onFilm.filter(id => id !== change.offFilm) });
    photoTarget = change.offFilm;
  } else if (change.remove) {
    const { id, why, kind } = change.remove;
    const object = items.find(item => item.id === id);
    items = items.map(item => (item.id === id ? { ...item, removed: now(), removed_note: why || '', ...(kind ? { removed_kind: kind } : {}) }
      : item.inside === id ? { ...item, inside: '' } : item));   // what it held stays, loose
    history = [...history, { at: now(), item: id, name: object?.name || id, what: 'removed', note: why || '' }];
    photoTarget = id;
  } else if (change.battery) {
    const grown = growBatteries(project.gearBatteries, change.battery);
    files[`${kit}/gear/batteries.json`] = formatJson(grown.file);
    // the website robot ignores gear/batteries.json (the app's battery timers change it all day): this stamp tells it
    // to rebuild, so the new batteries reach the website
    files[`${kit}/site-update.json`] = formatJson({ about: 'Changed by the kit admin page so the kit website rebuilds (batteries).', at: now() });
    photoTarget = (grown.file.groups.find(g => g.id === grown.groupId) || {}).item || null;   // the group's own thing, if any
  }
  if (items !== project.gearItems) files[`${kit}/gear/items.json`] = formatJson(items);
  if (history !== project.gearHistory) files[`${kit}/gear/history.json`] = formatJson(history);
  if (photos.length && photoTarget) {
    const gearPhotos = project.gearPhotos;
    files[`${kit}/gear/photos.json`] = formatJson({ ...gearPhotos, items: { ...gearPhotos.items, [photoTarget]: [...(gearPhotos.items?.[photoTarget] || []), ...photos] } });
  }
  return files;
}

// → a short message for the card ("Saved in the kit"), or an Error with what went wrong (nothing half-done)
export async function approve({ data, inbox }, kit, request, draft) {
  let base = await github.readTree(data);
  let project = await readKit(data, base, kit);
  const first = changeOf(project, request, draft);
  if (first.problem) throw new Error(first.problem);
  const photos = first.firmware ? [] : await movePhotos(project, inbox, request);
  for (let attempt = 1; !first.firmware; attempt++) {   // someone saved in between: read again and redo, 3 times at most
    const files = filesFor(project, changeOf(project, request, draft), photos);
    if (!Object.keys(files).length) break;
    try {
      await github.commitFiles(data, base, files, `Kit request from ${request.who || 'someone'} (${request.kit || kit.site}) approved: ${request.name || request.mode}`);
      break;
    } catch (error) {
      if (attempt >= 3 || (error.status !== 422 && error.status !== 409)) throw error;
      base = await github.readTree(data);
      project = await readKit(data, base, kit);
    }
  }
  await closeRequest(inbox, request, 'approved');
  return first.firmware ? 'Done.' : 'Saved in the kit. The website updates in a few minutes.';
}

export const decline = ({ inbox }, request) => closeRequest(inbox, request, 'declined');

// Muster — loads the compiled Wahapedia data published alongside the app (./data/)
import * as store from './store.js';

const BASE = './data/';

async function getJson(path) {
  const r = await fetch(BASE + path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`Couldn't load data (${r.status}). Check your connection.`);
  return r.json();
}

// The index lists factions and when the data was built
export async function fetchIndex() {
  const idx = await getJson('index.json');
  await store.set('kv', 'dataIndex', idx);
  return idx;
}

export async function cachedIndex() {
  return store.get('kv', 'dataIndex');
}

export function prepFaction(f) {
  // Some datasheets only carry Character/Epic Hero on a model, not the unit: use the role as well
  for (const u of f.units) {
    const r = (u.role || '').toLowerCase();
    if (r.includes('epic hero')) u.epic = u.character = true;
    if (r.includes('character')) u.character = true;
  }
  f.unitById = new Map(f.units.map((u) => [u.id, u]));
  f.enhById = new Map(f.enhancements.map((e) => [e.id, e]));
  f.detById = new Map(f.detachments.map((d) => [d.id, d]));
  return f;
}

export async function cachedFaction(id) {
  const f = await store.get('factions', id);
  return f ? prepFaction(f) : null;
}

export async function downloadFaction(id, built) {
  const f = await getJson(`f/${encodeURIComponent(id)}.json`);
  f.built = built || '';
  f.fetchedAt = new Date().toISOString();
  await store.set('factions', id, f);
  return prepFaction(f);
}

export async function cachedCore() {
  return store.get('kv', 'core');
}

export async function downloadCore() {
  const c = await getJson('core.json');
  await store.set('kv', 'core', c);
  return c;
}

export async function removeFaction(id) {
  await store.del('factions', id);
}

export async function cachedFactionIds() {
  return store.keys('factions');
}

// Points differences between two versions of a faction
export function diffPoints(oldF, newF) {
  if (!oldF) return [];
  const out = [];
  const om = new Map(oldF.units.map((u) => [u.id, u]));
  for (const u of newF.units) {
    const o = om.get(u.id);
    const b = u.c.map((c) => c.pts).join('/');
    if (!o) {
      out.push({ name: u.n, kind: 'new', to: b });
      continue;
    }
    const a = o.c.map((c) => c.pts).join('/');
    if (a !== b) out.push({ name: u.n, kind: 'pts', from: a, to: b });
  }
  const oe = new Map(oldF.enhancements.map((e) => [e.id, e]));
  for (const e of newF.enhancements) {
    const o = oe.get(e.id);
    if (o && o.pts !== e.pts) out.push({ name: `${e.n} (enhancement)`, kind: 'pts', from: String(o.pts), to: String(e.pts) });
  }
  const od = new Map(oldF.detachments.map((d) => [d.id, d]));
  for (const d of newF.detachments) {
    const o = od.get(d.id);
    if (o && o.dp !== d.dp) out.push({ name: `${d.n} (detachment)`, kind: 'pts', from: `${o.dp} DP`, to: `${d.dp} DP` });
  }
  return out;
}

// Chapter Approved mission deck (compiled from Wahapedia's mission deck page)
export async function cachedMissions() {
  return store.get('kv', 'missions');
}
export async function downloadMissions() {
  const m = await getJson('missions.json');
  await store.set('kv', 'missions', m);
  return m;
}

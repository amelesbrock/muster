// Muster — army list builder & battle tracker
import * as store from './store.js';
import { DEFAULT_SOURCE, listFactions, buildFaction, latestCommit, factionLabel, clearRawCache } from './data.js';

// ---------------------------------------------------------------- state
const S = {
  tab: 'lists',
  openListId: null,
  lists: [],
  games: [],
  activeGameId: null,
  settings: {
    source: { ...DEFAULT_SOURCE },
    caps: { primary: 50, secondary: 40, battleReady: 10, total: 100 },
    hideLegends: true,
  },
  factionIndex: null, // {sha, date, files:[{file,name,group}], checkedAt}
  downloaded: [], // [{file, name, revision, builtAt, commitDate, units}]
  showIssues: true,
};
const factionCache = new Map();
let deferredInstall = null;

// ---------------------------------------------------------------- utils
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function fmtRule(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\^\^(.+?)\^\^/g, '<span class="kwd">$1</span>')
    .replace(/\n/g, '<br>');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
    return true;
  } catch {
    showSheet(() => `<div class="sheet-head"><h2>Copy this</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-body"><textarea class="copybox" readonly>${esc(text)}</textarea></div>`);
    return false;
  }
}

async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  copyText(text);
}

// ---------------------------------------------------------------- persistence
async function save(what) {
  if (!what || what === 'lists') await store.set('kv', 'lists', S.lists);
  if (!what || what === 'games') await store.set('kv', 'games', S.games);
  if (!what || what === 'settings') await store.set('kv', 'settings', { ...S.settings, activeGameId: S.activeGameId });
}

async function refreshDownloaded() {
  const files = await store.keys('factions');
  const out = [];
  for (const file of files) {
    const f = await getFaction(file);
    if (f) out.push({ file, name: f.name, revision: f.revision, builtAt: f.builtAt, commitDate: f.commitDate, units: f.units.length, source: f.source });
  }
  S.downloaded = out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getFaction(file) {
  if (!file) return null;
  if (factionCache.has(file)) return factionCache.get(file);
  const f = await store.get('factions', file);
  if (!f) return null;
  prepFaction(f);
  factionCache.set(file, f);
  return f;
}

function prepFaction(f) {
  f.unitById = new Map(f.units.map((u) => [u.id, u]));
  f.enhById = new Map(f.enhancements.map((e) => [e.id, e]));
  f.detById = new Map(f.detachments.map((d) => [d.id, d]));
}

// Download with a progress overlay
async function ensureFaction(file, { force = false } = {}) {
  if (!force) {
    const f = await getFaction(file);
    if (f) return { faction: f, changes: [] };
  }
  showBusy(`Getting ${factionLabel(file)}…`);
  try {
    const res = await buildFaction(S.settings.source, file, { onProgress: (m) => showBusy(m) });
    prepFaction(res.faction);
    factionCache.set(file, res.faction);
    await refreshDownloaded();
    return res;
  } finally {
    hideBusy();
  }
}

function showBusy(msg) {
  const b = $('#busy');
  b.querySelector('.busy-msg').textContent = msg;
  b.classList.add('show');
}
function hideBusy() {
  $('#busy').classList.remove('show');
}

// ---------------------------------------------------------------- list maths
const ROLE_ORDER = ['Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted', 'Beast', 'Swarm', 'Monster', 'Vehicle', 'Dedicated Transport', 'Fortification', 'Allied Units', 'Other'];
const roleRank = (r) => {
  const i = ROLE_ORDER.indexOf(r);
  return i < 0 ? ROLE_ORDER.length - 1 : i;
};

function sizeFor(unit, models) {
  if (!unit || !unit.sizes.length) return { models, pts: 0 };
  return unit.sizes.find((s) => s.models === models) || unit.sizes.reduce((a, b) => (Math.abs(b.models - models) < Math.abs(a.models - models) ? b : a));
}

function entryPts(e, f) {
  if (e.ptsOverride != null && e.ptsOverride !== '') return +e.ptsOverride || 0;
  const u = f && f.unitById.get(e.unitId);
  if (!u) return e.lastPts || 0;
  let p = sizeFor(u, e.models).pts;
  const enh = e.enhancementId && f.enhById.get(e.enhancementId);
  if (enh) p += enh.pts;
  return p;
}

function listPts(list, f) {
  return list.units.reduce((t, e) => t + entryPts(e, f), 0);
}

function validate(list, f) {
  const out = [];
  if (!f) return [{ level: 'warn', msg: 'Faction data not downloaded on this device.' }];
  const pts = listPts(list, f);
  if (pts > list.limit) out.push({ level: 'error', msg: `Over the points limit by ${pts - list.limit} pts.` });
  if (f.detachments.length && !list.detachmentId) out.push({ level: 'warn', msg: 'No detachment chosen.' });
  const counts = new Map();
  for (const e of list.units) counts.set(e.unitId, (counts.get(e.unitId) || 0) + 1);
  for (const [id, n] of counts) {
    const u = f.unitById.get(id);
    if (!u) continue;
    const max = u.epic ? 1 : u.battleline || u.dedicatedTransport ? 6 : 3;
    if (n > max) out.push({ level: 'error', msg: `${u.name}: ${n} taken, max ${max}${u.epic ? ' (Epic Hero)' : ''}.` });
  }
  const enh = list.units.filter((e) => e.enhancementId);
  if (enh.length > 3) out.push({ level: 'error', msg: `${enh.length} enhancements — max 3.` });
  const seenEnh = new Set();
  for (const e of enh) {
    const en = f.enhById.get(e.enhancementId);
    const u = f.unitById.get(e.unitId);
    if (!en) continue;
    if (seenEnh.has(en.id)) out.push({ level: 'error', msg: `${en.name} taken more than once.` });
    seenEnh.add(en.id);
    if (u && (!u.character || u.epic)) out.push({ level: 'error', msg: `${u.name} can't take an enhancement.` });
    if (list.detachmentId && en.detachments.length && !en.detachments.includes(list.detachmentId)) {
      out.push({ level: 'warn', msg: `${en.name} isn't from your chosen detachment.` });
    }
  }
  const warlords = list.units.filter((e) => e.warlord);
  if (list.units.length && !warlords.length) out.push({ level: 'warn', msg: 'No Warlord chosen.' });
  if (warlords.length > 1) out.push({ level: 'error', msg: 'More than one Warlord.' });
  for (const e of list.units) {
    if (!f.unitById.get(e.unitId)) out.push({ level: 'warn', msg: `${e.name} is no longer in the data (kept at ${e.lastPts || 0} pts).` });
  }
  return out;
}

function listAsText(list, f) {
  const pts = listPts(list, f);
  const det = f && list.detachmentId && f.detById.get(list.detachmentId);
  const lines = [`${list.name} — ${pts}/${list.limit} pts`, `${list.factionName}${det ? ' — ' + det.name : ''}`, ''];
  const groups = groupEntries(list, f);
  for (const [role, entries] of groups) {
    lines.push(role.toUpperCase());
    for (const e of entries) {
      const u = f && f.unitById.get(e.unitId);
      const en = e.enhancementId && f && f.enhById.get(e.enhancementId);
      const bits = [];
      if (u && u.models.max > 1) bits.push(`${e.models} models`);
      if (e.warlord) bits.push('Warlord');
      if (en) bits.push(`${en.name} (+${en.pts})`);
      lines.push(`• ${e.name}${bits.length ? ' [' + bits.join(', ') + ']' : ''} — ${entryPts(e, f)} pts`);
      if (e.ptsOverride != null && e.ptsOverride !== '') lines.push('   (points set manually)');
      if (e.notes) lines.push(`   ${e.notes.replace(/\n/g, '; ')}`);
    }
    lines.push('');
  }
  lines.push('Made with Muster');
  return lines.join('\n');
}

function groupEntries(list, f) {
  const map = new Map();
  for (const e of list.units) {
    const u = f && f.unitById.get(e.unitId);
    const role = (u && u.role) || 'Other';
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(e);
  }
  return [...map.entries()].sort((a, b) => roleRank(a[0]) - roleRank(b[0]));
}

// Compact share code
function encodeList(list) {
  const data = { v: 1, n: list.name, f: list.factionFile, l: list.limit, d: list.detachmentId || '', u: list.units.map((e) => [e.unitId, e.models, e.enhancementId || '', e.warlord ? 1 : 0, e.notes || '', e.name, e.ptsOverride ?? null]) };
  const json = JSON.stringify(data);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return 'MUSTER1:' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeList(code) {
  const raw = String(code || '').trim().replace(/^MUSTER1:/, '').replace(/\s+/g, '');
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const json = decodeURIComponent(escape(atob(b64)));
  const d = JSON.parse(json);
  if (d.v !== 1 || !d.f) throw new Error('Not a Muster list code');
  return d;
}

// ---------------------------------------------------------------- sheets (modal stack)
const sheets = [];
function showSheet(render, opts = {}) {
  sheets.push({ render, opts });
  renderSheets();
}
function closeSheet() {
  const s = sheets.pop();
  renderSheets();
  if (s && s.opts.onClose) s.opts.onClose();
}
function closeAllSheets() {
  sheets.length = 0;
  renderSheets();
}
function renderSheets() {
  const root = $('#sheets');
  root.innerHTML = sheets
    .map((s, i) => `<div class="scrim ${i === sheets.length - 1 ? 'top' : ''}" data-act="${i === sheets.length - 1 ? 'scrim' : ''}"></div>
      <div class="sheet ${s.opts.tall ? 'tall' : ''}" data-sheet="${i}">${s.render()}</div>`)
    .join('');
  document.body.classList.toggle('sheet-open', sheets.length > 0);
}
function rerenderTopSheet() {
  const i = sheets.length - 1;
  if (i < 0) return;
  const el = document.querySelector(`[data-sheet="${i}"]`);
  if (!el) return renderSheets();
  const body = el.querySelector('.sheet-body');
  const scroll = body ? body.scrollTop : 0;
  el.innerHTML = sheets[i].render();
  const nb = el.querySelector('.sheet-body');
  if (nb) nb.scrollTop = scroll;
}

function confirmBox(msg, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    showSheet(
      () => `<div class="sheet-body pad-top"><p class="confirm-msg">${esc(msg)}</p>
        <div class="row gap"><button class="btn ghost grow" data-act="confirmNo">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'} grow" data-act="confirmYes">${esc(okLabel)}</button></div></div>`,
      { onClose: () => resolve(false) }
    );
    confirmResolve = (v) => {
      sheets.pop();
      renderSheets();
      resolve(v);
    };
  });
}
let confirmResolve = null;

function promptBox(title, value = '', { placeholder = '', multiline = false, okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    showSheet(
      () => `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-body">
        ${multiline ? `<textarea id="promptInput" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="promptInput" value="${esc(value)}" placeholder="${esc(placeholder)}">`}
        <button class="btn primary block" data-act="promptOk">${esc(okLabel)}</button></div>`,
      { onClose: () => resolve(null) }
    );
    promptResolve = (v) => {
      sheets.pop();
      renderSheets();
      resolve(v);
    };
    setTimeout(() => {
      const i = $('#promptInput');
      if (i) i.focus();
    }, 50);
  });
}
let promptResolve = null;

// ---------------------------------------------------------------- views
function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const v = $('#view');
  const y = window.scrollY;
  if (S.tab === 'lists') v.innerHTML = S.openListId ? viewList() : viewLists();
  else if (S.tab === 'battle') v.innerHTML = viewBattle();
  else v.innerHTML = viewData();
  window.scrollTo(0, renderKeepScroll ? y : 0);
  renderKeepScroll = false;
  if (S.openListId && S.tab === 'lists') hydrateList();
}
let renderKeepScroll = false;
const rerender = () => {
  renderKeepScroll = true;
  render();
};

function installBanner() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (deferredInstall) return `<div class="banner"><span>Install Muster on this device</span><button class="btn small primary" data-act="install">Install</button></div>`;
  if (ios) return `<div class="banner"><span>To install: tap <b>Share</b> <span class="ios-share">⬆︎</span> then <b>Add to Home Screen</b>.</span></div>`;
  return '';
}

// ----- Lists home
function viewLists() {
  const cards = S.lists
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .map((l) => {
      const f = factionCache.get(l.factionFile);
      const pts = f ? listPts(l, f) : '—';
      const det = f && l.detachmentId && f.detById.get(l.detachmentId);
      const issues = f ? validate(l, f).filter((x) => x.level === 'error').length : 0;
      const over = f && pts > l.limit;
      return `<button class="card list-card" data-act="openList" data-id="${l.id}">
        <div class="lc-main"><div class="lc-name">${esc(l.name)}</div>
        <div class="lc-sub">${esc(l.factionName)}${det ? ' · ' + esc(det.name) : ''}</div>
        <div class="lc-sub">${plural(l.units.length, 'unit')}${issues ? ` · <span class="err">${plural(issues, 'issue')}</span>` : ''}</div></div>
        <div class="lc-pts ${over ? 'err' : ''}"><b>${pts}</b><span>/ ${l.limit}</span></div></button>`;
    })
    .join('');
  return `<header class="top"><div class="brand"><span class="logo">◈</span> Muster</div></header>
  <main class="pad">
    ${installBanner()}
    <div class="row gap"><button class="btn primary grow" data-act="newList">＋ New army list</button>
    <button class="btn ghost" data-act="importList">Import</button></div>
    ${cards ? `<div class="stack">${cards}</div>` : `<div class="empty"><div class="empty-ico">⚔</div><p>No lists yet.</p><p class="muted">Create one to start mustering your army. Unit data is downloaded from the community BattleScribe repository the first time you pick a faction.</p></div>`}
  </main>`;
}

// ----- New list
async function newListFlow() {
  let factions = S.factionIndex?.files;
  if (!factions || !factions.length) {
    showBusy('Fetching faction list…');
    try {
      let sha = S.settings.source.branch;
      let date = '';
      try {
        const c = await latestCommit(S.settings.source);
        sha = c.sha;
        date = c.date;
      } catch { /* offline or rate limited */ }
      factions = await listFactions(S.settings.source, sha);
      S.factionIndex = { sha, date, files: factions, checkedAt: Date.now() };
      await store.set('kv', 'factionIndex', S.factionIndex);
    } finally {
      hideBusy();
    }
  }
  const draft = { name: '', file: '', limit: 2000 };
  showSheet(
    () => {
      const groups = {};
      for (const f of factions) (groups[f.group] ||= []).push(f);
      const have = new Set(S.downloaded.map((d) => d.file));
      return `<div class="sheet-head"><h2>New army list</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-body">
        <label class="lbl">List name</label>
        <input id="nlName" placeholder="e.g. Votann 2k – Oathband" value="${esc(draft.name)}">
        <label class="lbl">Points limit</label>
        <div class="chips">${[1000, 2000, 3000].map((p) => `<button class="chip ${draft.limit === p ? 'on' : ''}" data-act="nlLimit" data-v="${p}">${p}</button>`).join('')}
          <input id="nlLimitCustom" class="mini" inputmode="numeric" placeholder="Other" value="${[1000, 2000, 3000].includes(draft.limit) ? '' : draft.limit}"></div>
        <label class="lbl">Faction</label>
        ${Object.entries(groups)
          .map(([g, fs]) => `<div class="fgroup"><div class="fgroup-h">${esc(g)}</div>${fs
            .map((f) => `<button class="frow ${draft.file === f.file ? 'on' : ''}" data-act="nlFaction" data-file="${esc(f.file)}"><span>${esc(f.name)}</span>${have.has(f.file) ? '<span class="tag">saved</span>' : ''}</button>`)
            .join('')}</div>`)
          .join('')}
      </div>
      <div class="sheet-foot"><button class="btn primary block" data-act="nlCreate" ${draft.file ? '' : 'disabled'}>Create list</button></div>`;
    },
    { tall: true }
  );
  newListDraft = draft;
}
let newListDraft = null;

async function createListFromDraft() {
  const d = newListDraft;
  const nameInput = $('#nlName');
  if (nameInput) d.name = nameInput.value.trim();
  const custom = $('#nlLimitCustom');
  if (custom && custom.value.trim()) d.limit = Math.max(1, parseInt(custom.value, 10) || d.limit);
  if (!d.file) return;
  try {
    await ensureFaction(d.file);
  } catch (e) {
    toast(e.message || 'Download failed');
    return;
  }
  const f = await getFaction(d.file);
  const list = {
    id: uid(),
    name: d.name || `${f.name} ${d.limit}`,
    factionFile: d.file,
    factionName: f.name,
    limit: d.limit,
    detachmentId: f.detachments.length === 1 ? f.detachments[0].id : '',
    units: [],
    created: Date.now(),
    updated: Date.now(),
  };
  S.lists.push(list);
  await save('lists');
  closeAllSheets();
  S.openListId = list.id;
  render();
}

// ----- List builder
const curList = () => S.lists.find((l) => l.id === S.openListId);

function viewList() {
  const l = curList();
  if (!l) {
    S.openListId = null;
    return viewLists();
  }
  const f = factionCache.get(l.factionFile);
  return `<header class="top"><button class="icon back" data-act="backToLists">‹</button>
    <div class="top-title" data-act="renameList"><div class="tt-name">${esc(l.name)}</div><div class="tt-sub">${esc(l.factionName)}</div></div>
    <button class="icon" data-act="listMenu">⋯</button></header>
  <main class="pad" id="listBody">${f ? listBodyHtml(l, f) : '<div class="loading">Loading…</div>'}</main>`;
}

async function hydrateList() {
  const l = curList();
  if (!l || factionCache.has(l.factionFile)) return;
  const f = await getFaction(l.factionFile);
  const body = $('#listBody');
  if (!body) return;
  if (!f) {
    body.innerHTML = `<div class="empty"><p>The data for <b>${esc(l.factionName)}</b> isn't on this device yet.</p>
      <button class="btn primary" data-act="downloadForList">Download ${esc(l.factionName)}</button></div>`;
    return;
  }
  body.innerHTML = listBodyHtml(l, f);
}

function listBodyHtml(l, f) {
  const pts = listPts(l, f);
  const pct = Math.min(100, (pts / l.limit) * 100);
  const det = l.detachmentId && f.detById.get(l.detachmentId);
  const issues = validate(l, f);
  const errs = issues.filter((i) => i.level === 'error').length;
  const groups = groupEntries(l, f);
  return `
  <div class="ptsbar ${pts > l.limit ? 'over' : ''}">
    <div class="ptsnums"><b>${pts}</b> / ${l.limit} pts <span class="muted">· ${l.limit - pts >= 0 ? l.limit - pts + ' left' : pts - l.limit + ' over'}</span></div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div>
  </div>
  <div class="row gap">
    <button class="card det grow" data-act="pickDetachment"><div class="muted small">Detachment</div><div>${det ? esc(det.name) : f.detachments.length ? '<span class="warn">Choose…</span>' : '—'}</div></button>
    ${f.armyRules.length ? `<button class="card det" data-act="armyRules"><div class="muted small">Army rule</div><div>${esc(f.armyRules[0].name)}</div></button>` : ''}
  </div>
  ${issues.length ? `<div class="issues ${errs ? 'has-err' : ''}"><button class="issues-h" data-act="toggleIssues">${errs ? `⚠ ${plural(errs, 'problem')}` : '✓ Legal'}${issues.length - errs ? ` · ${plural(issues.length - errs, 'note')}` : ''}<span>${S.showIssues ? '▾' : '▸'}</span></button>
    ${S.showIssues ? `<ul>${issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>` : ''}</div>` : l.units.length ? `<div class="issues ok"><div class="issues-h">✓ Legal list</div></div>` : ''}
  ${groups
    .map(
      ([role, entries]) => `<section><h3 class="sec">${esc(role)} <span class="muted">${entries.reduce((t, e) => t + entryPts(e, f), 0)}</span></h3>
      ${entries
        .map((e) => {
          const u = f.unitById.get(e.unitId);
          const en = e.enhancementId && f.enhById.get(e.enhancementId);
          const sub = [];
          if (u && u.models.max > 1) sub.push(`${e.models} models`);
          if (en) sub.push(`✦ ${esc(en.name)}`);
          if (e.notes) sub.push(esc(e.notes.split('\n')[0]));
          return `<button class="entry" data-act="editEntry" data-uid="${e.uid}">
            <div class="en-main"><div class="en-name">${e.warlord ? '<span class="crown">♛</span>' : ''}${esc(e.name)}${u ? '' : ' <span class="warn">(missing)</span>'}</div>
            ${sub.length ? `<div class="en-sub">${sub.join(' · ')}</div>` : ''}</div>
            <div class="en-pts">${entryPts(e, f)}</div></button>`;
        })
        .join('')}</section>`
    )
    .join('')}
  ${l.units.length ? '' : `<div class="empty small"><p class="muted">No units yet. Tap “Add unit” to start.</p></div>`}
  <div class="spacer"></div>
  <button class="fab" data-act="addUnit">＋ Add unit</button>`;
}

function touch(l) {
  l.updated = Date.now();
  save('lists');
}

// ----- Detachment picker
async function pickDetachment() {
  const l = curList();
  const f = await getFaction(l.factionFile);
  if (!f.detachments.length) return toast('No detachments found in the data');
  let expanded = l.detachmentId || '';
  showSheet(
    () => `<div class="sheet-head"><h2>Detachment</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body">${f.detachments
      .map((d) => {
        const enh = f.enhancements.filter((e) => e.detachments.includes(d.id));
        const open = expanded === d.id;
        return `<div class="det-opt ${l.detachmentId === d.id ? 'on' : ''}">
          <div class="row"><button class="grow det-name" data-act="detExpand" data-id="${d.id}">${l.detachmentId === d.id ? '● ' : '○ '}${esc(d.name)}<span class="muted"> ${open ? '▾' : '▸'}</span></button>
          <button class="btn small ${l.detachmentId === d.id ? 'ghost' : 'primary'}" data-act="detChoose" data-id="${d.id}">${l.detachmentId === d.id ? 'Chosen' : 'Choose'}</button></div>
          ${open ? `<div class="det-rules">${d.rules.map((r) => `<div class="rule"><b>${esc(r.name)}</b><div>${fmtRule(r.text)}</div></div>`).join('') || '<p class="muted">No rule text in the data.</p>'}
          ${enh.length ? `<div class="muted small">Enhancements</div>${enh.map((e) => `<div class="rule"><b>${esc(e.name)}</b> <span class="pts">${e.pts} pts</span><div>${fmtRule(e.text)}</div></div>`).join('')}` : ''}</div>` : ''}
        </div>`;
      })
      .join('')}</div>`,
    { tall: true }
  );
  detExpandHandler = (id) => {
    expanded = expanded === id ? '' : id;
    rerenderTopSheet();
  };
}
let detExpandHandler = null;

// ----- Unit picker
const picker = { q: '', role: '' };
async function addUnitSheet() {
  const l = curList();
  const f = await getFaction(l.factionFile);
  picker.q = '';
  picker.role = '';
  showSheet(
    () => {
      const roles = [...new Set(f.units.map((u) => u.role))].sort((a, b) => roleRank(a) - roleRank(b));
      return `<div class="sheet-head"><h2>Add unit</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-sub"><input id="pickQ" type="search" placeholder="Search ${f.units.length} datasheets…" value="${esc(picker.q)}" autocomplete="off">
      <div class="chips scroll"><button class="chip ${picker.role ? '' : 'on'}" data-act="pickRole" data-v="">All</button>${roles.map((r) => `<button class="chip ${picker.role === r ? 'on' : ''}" data-act="pickRole" data-v="${esc(r)}">${esc(r)}</button>`).join('')}
      <button class="chip ${S.settings.hideLegends ? '' : 'on'}" data-act="toggleLegends">Legends</button></div></div>
      <div class="sheet-body" id="pickResults">${pickerResults(f, l)}</div>`;
    },
    { tall: true }
  );
}

function pickerResults(f, l) {
  const q = picker.q.toLowerCase();
  const counts = new Map();
  for (const e of l.units) counts.set(e.unitId, (counts.get(e.unitId) || 0) + 1);
  const units = f.units.filter(
    (u) => (!picker.role || u.role === picker.role) && (!q || u.name.toLowerCase().includes(q) || u.keywords.some((k) => k.toLowerCase().includes(q))) && (!S.settings.hideLegends || !u.legends)
  );
  if (!units.length) return `<p class="muted center">No matching units.</p>`;
  return units
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name))
    .map((u) => {
      const pts = u.sizes.length ? (u.sizes.length > 1 ? `${u.sizes[0].pts}–${u.sizes[u.sizes.length - 1].pts}` : u.sizes[0].pts) : '?';
      const n = counts.get(u.id) || 0;
      return `<div class="pick-row"><button class="pick-info" data-act="viewUnit" data-add="1" data-id="${u.id}">
        <div class="pn">${esc(u.name)}${n ? ` <span class="tag">×${n}</span>` : ''}</div>
        <div class="ps muted">${esc(u.role)}${u.models.max > 1 ? ` · ${u.models.min}${u.models.max !== u.models.min ? '–' + u.models.max : ''} models` : ''}</div></button>
        <div class="pp">${pts}</div><button class="addbtn" data-act="pickAdd" data-id="${u.id}" aria-label="Add">＋</button></div>`;
    })
    .join('');
}

function addUnitToList(unitId) {
  const l = curList();
  const f = factionCache.get(l.factionFile);
  const u = f.unitById.get(unitId);
  if (!u) return;
  const size = u.sizes[0] || { models: u.models.min, pts: 0 };
  l.units.push({ uid: uid(), unitId: u.id, name: u.name, models: size.models, enhancementId: '', warlord: false, notes: '', lastPts: size.pts });
  touch(l);
  toast(`Added ${u.name}`);
  rerender();
}

// ----- Entry editor
function editEntrySheet(entryUid) {
  const l = curList();
  const f = factionCache.get(l.factionFile);
  let showAllEnh = false;
  showSheet(
    () => {
      const e = l.units.find((x) => x.uid === entryUid);
      if (!e) return '';
      const u = f.unitById.get(e.unitId);
      const canEnh = u && u.character && !u.epic;
      let enhs = f.enhancements;
      const filtered = l.detachmentId && enhs.some((x) => x.detachments.length);
      if (filtered && !showAllEnh) enhs = enhs.filter((x) => !x.detachments.length || x.detachments.includes(l.detachmentId) || x.id === e.enhancementId);
      const takenElsewhere = new Set(l.units.filter((x) => x.uid !== e.uid && x.enhancementId).map((x) => x.enhancementId));
      return `<div class="sheet-head"><h2>${esc(e.name)}</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-body">
        <div class="big-pts">${entryPts(e, f)} <span>pts</span></div>
        ${u && u.sizes.length > 1 ? `<label class="lbl">Unit size</label><div class="chips">${u.sizes.map((s) => `<button class="chip ${s.models === e.models ? 'on' : ''}" data-act="setSize" data-uid="${e.uid}" data-v="${s.models}">${s.models} models · ${s.pts}</button>`).join('')}</div>` : ''}
        ${u && u.conditionalCost ? `<p class="muted small">Some points changes in the data depend on other choices; check the total against your codex/app.</p>` : ''}
        ${u && u.character ? `<label class="toggle"><input type="checkbox" data-act="setWarlord" data-uid="${e.uid}" ${e.warlord ? 'checked' : ''}><span>Warlord</span></label>` : ''}
        ${canEnh && f.enhancements.length ? `<label class="lbl">Enhancement</label>
          <div class="enh-list"><button class="enh ${e.enhancementId ? '' : 'on'}" data-act="setEnh" data-uid="${e.uid}" data-v="">None</button>
          ${enhs.map((x) => `<button class="enh ${e.enhancementId === x.id ? 'on' : ''} ${takenElsewhere.has(x.id) ? 'taken' : ''}" data-act="setEnh" data-uid="${e.uid}" data-v="${x.id}"><span>${esc(x.name)}${takenElsewhere.has(x.id) ? ' <span class="muted">(taken)</span>' : ''}</span><span class="pts">+${x.pts}</span></button>`).join('')}</div>
          ${filtered ? `<button class="link" data-act="toggleAllEnh">${showAllEnh ? 'Only my detachment' : 'Show all detachments'}</button>` : ''}` : ''}
        <details class="adv"${e.ptsOverride != null && e.ptsOverride !== '' ? ' open' : ''}><summary>Points look wrong? Set them manually</summary>
          <div class="row gap"><input inputmode="numeric" data-bind="ptsOverride" data-uid="${e.uid}" placeholder="Auto (${(() => { const c = { ...e, ptsOverride: null }; return entryPts(c, f); })()})" value="${e.ptsOverride ?? ''}"></div>
          <p class="muted small">Overrides this unit's total (including enhancement) until cleared.</p></details>
        <label class="lbl">Wargear / notes</label>
        <textarea data-bind="entryNotes" data-uid="${e.uid}" rows="3" placeholder="e.g. 2× ion blaster, Theyn with plasma">${esc(e.notes)}</textarea>
        <div class="row gap wrap">
          <button class="btn ghost grow" data-act="viewUnit" data-id="${e.unitId}">Datasheet</button>
          <button class="btn ghost grow" data-act="dupEntry" data-uid="${e.uid}">Duplicate</button>
          <button class="btn danger grow" data-act="removeEntry" data-uid="${e.uid}">Remove</button>
        </div>
      </div>`;
    },
    { onClose: () => rerender() }
  );
  toggleAllEnhHandler = () => {
    showAllEnh = !showAllEnh;
    rerenderTopSheet();
  };
}
let toggleAllEnhHandler = null;

// ----- Datasheet
function datasheetHtml(u, f) {
  const P = u.profiles;
  const statRow = (p) => `<tr><td class="mname">${P.unit.length > 1 ? esc(p.name) : ''}</td>${['M', 'T', 'SV', 'W', 'LD', 'OC'].map((k) => `<td>${esc(p[k] ?? '-')}</td>`).join('')}</tr>`;
  const wTable = (ws, kind) =>
    ws.length
      ? `<h3 class="ds-h">${kind === 'ranged' ? '⌖ Ranged weapons' : '⚔ Melee weapons'}</h3>
      <table class="wtab"><thead><tr><th class="wn"></th><th>Range</th><th>A</th><th>${kind === 'ranged' ? 'BS' : 'WS'}</th><th>S</th><th>AP</th><th>D</th></tr></thead><tbody>
      ${ws.map((w) => `<tr><td class="wn">${esc(w.name)}${w.kw ? `<div class="wkw">${esc(w.kw)}</div>` : ''}</td><td>${esc(w.range)}</td><td>${esc(w.A)}</td><td>${esc(w.skill)}</td><td>${esc(w.S)}</td><td>${esc(w.AP)}</td><td>${esc(w.D)}</td></tr>`).join('')}
      </tbody></table>`
      : '';
  const abilities = P.abilities.filter((a) => !/^invulnerable save$/i.test(a.name));
  return `
  <div class="ds-kw">${u.keywords.map((k) => `<span class="kwchip">${esc(k)}</span>`).join('')}</div>
  <table class="stats"><thead><tr><th></th><th>M</th><th>T</th><th>SV</th><th>W</th><th>LD</th><th>OC</th></tr></thead><tbody>${P.unit.map(statRow).join('')}</tbody></table>
  ${u.invuln ? `<div class="inv">🛡 Invulnerable save <b>${esc(u.invuln)}</b></div>` : ''}
  ${wTable(P.ranged, 'ranged')}
  ${wTable(P.melee, 'melee')}
  ${u.rules.length ? `<h3 class="ds-h">Core & faction rules</h3><div class="rulechips">${u.rules.map((r, i) => `<details class="rc"><summary>${esc(r.name)}</summary><div>${fmtRule(r.text) || '<span class="muted">—</span>'}</div></details>`).join('')}</div>` : ''}
  ${abilities.length ? `<h3 class="ds-h">Abilities</h3>${abilities.map((a) => `<div class="rule"><b>${esc(a.name)}</b><div>${fmtRule(a.text)}</div></div>`).join('')}` : ''}
  ${P.other.length ? P.other.map((o) => `<div class="rule"><b>${esc(o.type)}${o.name && o.name !== o.type ? ': ' + esc(o.name) : ''}</b><div>${Object.entries(o.chars).map(([k, v]) => `${esc(k)}: ${fmtRule(v)}`).join('<br>')}</div></div>`).join('') : ''}
  <h3 class="ds-h">Unit composition & points</h3>
  ${u.models.list.length ? `<ul class="comp">${u.models.list.map((m) => `<li>${m.min === m.max ? m.min : `${m.min}–${m.max}`} × ${esc(m.name)}</li>`).join('')}</ul>` : ''}
  <div class="chips">${u.sizes.map((s) => `<span class="chip static">${s.models} model${s.models === 1 ? '' : 's'} · <b>${s.pts}</b> pts</span>`).join('')}</div>
  ${u.factionKeywords.length ? `<p class="muted small">Faction: ${esc(u.factionKeywords.join(', '))}</p>` : ''}`;
}

function viewUnitSheet(unitId, canAdd) {
  const l = curList();
  const f = l && factionCache.get(l.factionFile);
  const u = f && f.unitById.get(unitId);
  if (!u) return;
  showSheet(
    () => `<div class="sheet-head"><h2>${esc(u.name)}</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body ds">${datasheetHtml(u, f)}</div>
    ${canAdd ? `<div class="sheet-foot"><button class="btn primary block" data-act="pickAdd" data-id="${u.id}" data-close="1">＋ Add to list</button></div>` : ''}`,
    { tall: true }
  );
}

// ----- list menu
function listMenu() {
  const l = curList();
  showSheet(
    () => `<div class="sheet-head"><h2>${esc(l.name)}</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body menu">
      <button data-act="shareText">📋 Share as text</button>
      <button data-act="shareCode">🔗 Share code (for friends' Muster)</button>
      <button data-act="renameList">✎ Rename</button>
      <button data-act="setLimit">◎ Points limit (${l.limit})</button>
      <button data-act="dupList">⧉ Duplicate list</button>
      <button data-act="refreshListData">↻ Re-download ${esc(l.factionName)} data</button>
      <button class="danger-text" data-act="deleteList">🗑 Delete list</button>
    </div>`
  );
}

// ---------------------------------------------------------------- Battle tracker
const activeGame = () => S.games.find((g) => g.id === S.activeGameId && !g.finished);

function playerTotals(p, caps) {
  const pri = Math.min(caps.primary, p.primary.reduce((a, b) => a + (+b || 0), 0));
  const sec = Math.min(caps.secondary, p.secondary.reduce((a, b) => a + (+b || 0), 0));
  const br = p.battleReady ? caps.battleReady : 0;
  return { pri, sec, br, total: Math.min(caps.total, pri + sec + br) };
}

function viewBattle() {
  const g = activeGame();
  if (!g) return viewBattleHome();
  const caps = g.caps;
  const r = g.round;
  const T = g.players.map((p) => playerTotals(p, caps));
  const lead = T[0].total === T[1].total ? -1 : T[0].total > T[1].total ? 0 : 1;
  return `<header class="top"><div class="top-title"><div class="tt-name">${esc(g.mission || 'Battle')}</div><div class="tt-sub">Battle round ${r} of 5</div></div>
    <button class="icon" data-act="gameMenu">⋯</button></header>
  <main class="pad battle">
    <div class="rounds">${[1, 2, 3, 4, 5].map((n) => `<button class="rnd ${n === r ? 'on' : ''} ${n < r ? 'done' : ''}" data-act="setRound" data-v="${n}">${n}</button>`).join('')}</div>
    <div class="players">
    ${g.players
      .map((p, i) => {
        const t = T[i];
        return `<div class="pcard ${lead === i ? 'lead' : ''}">
        <div class="pc-head"><button class="pc-name" data-act="renamePlayer" data-i="${i}">${esc(p.name)}</button><div class="pc-fac muted">${esc(p.faction || '')}</div></div>
        <div class="pc-total"><b>${t.total}</b><span>VP</span></div>
        <div class="pc-split muted">P ${t.pri} · S ${t.sec}${p.battleReady ? ` · BR ${t.br}` : ''}</div>
        ${stepper('CP', p.cp, `cp:${i}`)}
        ${stepper(`Primary R${r}`, p.primary[r - 1], `pri:${i}`)}
        ${stepper(`Secondary R${r}`, p.secondary[r - 1], `sec:${i}`)}
        <input class="secnote" data-bind="secNote" data-i="${i}" placeholder="Secondaries (e.g. Assassination, Engage)" value="${esc(p.secNames || '')}">
        <label class="toggle small"><input type="checkbox" data-act="toggleBR" data-i="${i}" ${p.battleReady ? 'checked' : ''}><span>Battle ready (+${caps.battleReady})</span></label>
        ${p.listId ? `<button class="link" data-act="openPlayerList" data-i="${i}">View army list</button>` : ''}
      </div>`;
      })
      .join('')}
    </div>
    <div class="row gap"><button class="btn ghost grow" data-act="cpBoth">+1 CP each</button>
    ${r < 5 ? `<button class="btn primary grow" data-act="nextRound">Next round ›</button>` : `<button class="btn primary grow" data-act="endGame">Finish game</button>`}</div>
    <h3 class="sec">Scoreboard</h3>
    <table class="score"><thead><tr><th>Rnd</th><th colspan="2">${esc(g.players[0].name)}</th><th colspan="2">${esc(g.players[1].name)}</th></tr>
      <tr class="sub"><th></th><th>Pri</th><th>Sec</th><th>Pri</th><th>Sec</th></tr></thead><tbody>
      ${[0, 1, 2, 3, 4].map((k) => `<tr class="${k === r - 1 ? 'cur' : ''}"><td>${k + 1}</td><td>${g.players[0].primary[k] || 0}</td><td>${g.players[0].secondary[k] || 0}</td><td>${g.players[1].primary[k] || 0}</td><td>${g.players[1].secondary[k] || 0}</td></tr>`).join('')}
      <tr class="tot"><td>Σ</td><td>${T[0].pri}</td><td>${T[0].sec}</td><td>${T[1].pri}</td><td>${T[1].sec}</td></tr>
    </tbody></table>
    <p class="muted small center">Caps: primary ${caps.primary}, secondary ${caps.secondary}, total ${caps.total}. Change them in Data → Scoring.</p>
  </main>`;
}

function stepper(label, value, key) {
  return `<div class="stepper"><span class="st-l">${esc(label)}</span>
    <button class="st-b" data-act="step" data-k="${key}" data-d="-1">−</button>
    <input class="st-v" inputmode="numeric" data-bind="stepVal" data-k="${key}" value="${+value || 0}">
    <button class="st-b" data-act="step" data-k="${key}" data-d="1">+</button></div>`;
}

function viewBattleHome() {
  const past = S.games.filter((g) => g.finished).sort((a, b) => b.created - a.created);
  return `<header class="top"><div class="brand"><span class="logo">⚔</span> Battle</div></header>
  <main class="pad">
    <button class="btn primary block" data-act="newGame">＋ Start a new game</button>
    ${past.length ? `<h3 class="sec">Past games</h3><div class="stack">${past
      .map((g) => {
        const t = g.players.map((p) => playerTotals(p, g.caps).total);
        const res = t[0] === t[1] ? 'Draw' : `${esc(g.players[t[0] > t[1] ? 0 : 1].name)} won`;
        return `<button class="card list-card" data-act="viewGame" data-id="${g.id}"><div class="lc-main"><div class="lc-name">${esc(g.players[0].name)} vs ${esc(g.players[1].name)}</div>
          <div class="lc-sub">${esc(g.mission || 'Battle')} · ${fmtDate(new Date(g.created).toISOString())}</div><div class="lc-sub">${res}</div></div>
          <div class="lc-pts"><b>${t[0]}–${t[1]}</b></div></button>`;
      })
      .join('')}</div>` : `<div class="empty"><div class="empty-ico">🎲</div><p class="muted">Track VP, CP and secondaries round by round.</p></div>`}
  </main>`;
}

function newGameSheet() {
  const draft = { p: [{ name: 'Me', listId: '' }, { name: 'Opponent', listId: '' }], mission: '' };
  showSheet(
    () => `<div class="sheet-head"><h2>New game</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body">
      <label class="lbl">Mission</label><input id="ngMission" placeholder="e.g. Take and Hold" value="${esc(draft.mission)}">
      ${draft.p
        .map(
          (p, i) => `<label class="lbl">Player ${i + 1}</label><input id="ngName${i}" value="${esc(p.name)}">
        <select id="ngList${i}"><option value="">No list / opponent's own</option>${S.lists.map((l) => `<option value="${l.id}" ${p.listId === l.id ? 'selected' : ''}>${esc(l.name)} (${esc(l.factionName)})</option>`).join('')}</select>`
        )
        .join('')}
    </div>
    <div class="sheet-foot"><button class="btn primary block" data-act="ngStart">Start game</button></div>`,
    { tall: true }
  );
}

function startGame() {
  const g = {
    id: uid(),
    created: Date.now(),
    mission: $('#ngMission').value.trim(),
    round: 1,
    finished: false,
    caps: { ...S.settings.caps },
    players: [0, 1].map((i) => {
      const listId = $('#ngList' + i).value;
      const l = S.lists.find((x) => x.id === listId);
      return { name: $('#ngName' + i).value.trim() || `Player ${i + 1}`, listId, faction: l ? l.factionName : '', cp: 0, battleReady: false, primary: [0, 0, 0, 0, 0], secondary: [0, 0, 0, 0, 0], secNames: '' };
    }),
  };
  S.games.push(g);
  S.activeGameId = g.id;
  save();
  closeAllSheets();
  render();
}

function gameMenu() {
  showSheet(
    () => `<div class="sheet-head"><h2>Game</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body menu">
      <button data-act="renameMission">✎ Mission name</button>
      <button data-act="shareGame">📋 Share result</button>
      <button data-act="endGame">🏁 Finish game</button>
      <button class="danger-text" data-act="abandonGame">🗑 Discard game</button>
    </div>`
  );
}

function gameSummary(g) {
  const t = g.players.map((p) => playerTotals(p, g.caps));
  return [
    `${g.mission || 'Battle'} — ${fmtDate(new Date(g.created).toISOString())}`,
    ...g.players.map((p, i) => `${p.name}${p.faction ? ' (' + p.faction + ')' : ''}: ${t[i].total} VP (Primary ${t[i].pri}, Secondary ${t[i].sec}${p.battleReady ? ', Battle ready ' + t[i].br : ''})`),
    '',
    'Round by round (Pri/Sec):',
    ...[0, 1, 2, 3, 4].map((k) => `R${k + 1}: ${g.players.map((p) => `${p.primary[k] || 0}/${p.secondary[k] || 0}`).join('  vs  ')}`),
  ].join('\n');
}

function viewGameSheet(id) {
  const g = S.games.find((x) => x.id === id);
  if (!g) return;
  showSheet(
    () => `<div class="sheet-head"><h2>${esc(g.players[0].name)} vs ${esc(g.players[1].name)}</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body"><pre class="summary">${esc(gameSummary(g))}</pre>
    <div class="row gap"><button class="btn ghost grow" data-act="reopenGame" data-id="${g.id}">Reopen</button>
    <button class="btn ghost grow" data-act="copyGame" data-id="${g.id}">Copy</button>
    <button class="btn danger grow" data-act="deleteGame" data-id="${g.id}">Delete</button></div></div>`
  );
}

// ---------------------------------------------------------------- Data / settings
function viewData() {
  const src = S.settings.source;
  const c = S.settings.caps;
  const idx = S.factionIndex;
  return `<header class="top"><div class="brand"><span class="logo">⛁</span> Data & settings</div></header>
  <main class="pad">
    <section class="card pad-in">
      <h3 class="sec flush">Unit data</h3>
      <p class="muted small">Datasheets and points come from the community BattleScribe data (<b>${esc(src.owner)}/${esc(src.repo)}</b>). Update after a points change to refresh every list.</p>
      ${idx && idx.date ? `<p class="small">Latest data seen: <b>${fmtDate(idx.date)}</b></p>` : ''}
      <div class="row gap"><button class="btn primary grow" data-act="updateAll">↻ Update downloaded factions</button></div>
      <div class="stack tight">${S.downloaded.length
        ? S.downloaded
            .map((d) => `<div class="dl-row"><div><div>${esc(d.name)}</div><div class="muted small">${d.units} datasheets · ${d.commitDate ? 'data from ' + fmtDate(d.commitDate) : 'rev ' + esc(d.revision)} · fetched ${fmtDate(d.builtAt)}</div></div>
            <button class="icon small" data-act="removeFaction" data-file="${esc(d.file)}" aria-label="Remove">✕</button></div>`)
            .join('')
        : '<p class="muted small">Nothing downloaded yet. Factions download when you create a list.</p>'}</div>
      <button class="btn ghost block" data-act="downloadFaction">＋ Download another faction</button>
      <details class="adv"><summary>Data source (advanced)</summary>
        <label class="lbl">GitHub owner / repo / branch</label>
        <div class="row gap"><input id="srcOwner" value="${esc(src.owner)}"><input id="srcRepo" value="${esc(src.repo)}"><input id="srcBranch" class="mini" value="${esc(src.branch)}"></div>
        <button class="btn ghost block" data-act="saveSource">Save source</button>
        <p class="muted small">Use this when the community moves to a new edition repo.</p>
      </details>
    </section>
    <section class="card pad-in">
      <h3 class="sec flush">Scoring</h3>
      <div class="grid2">
        <label>Primary cap<input inputmode="numeric" data-bind="cap" data-k="primary" value="${c.primary}"></label>
        <label>Secondary cap<input inputmode="numeric" data-bind="cap" data-k="secondary" value="${c.secondary}"></label>
        <label>Battle ready<input inputmode="numeric" data-bind="cap" data-k="battleReady" value="${c.battleReady}"></label>
        <label>Total cap<input inputmode="numeric" data-bind="cap" data-k="total" value="${c.total}"></label>
      </div>
    </section>
    <section class="card pad-in">
      <h3 class="sec flush">Backup</h3>
      <p class="muted small">Lists and games live on this device only. Export a backup now and then, or to move to a new phone.</p>
      <div class="row gap"><button class="btn ghost grow" data-act="exportBackup">Export backup</button>
      <label class="btn ghost grow filebtn">Import backup<input type="file" accept=".json,application/json" data-bind="importBackup" hidden></label></div>
    </section>
    <p class="muted small center about">Muster is an unofficial fan tool, not affiliated with or endorsed by Games Workshop. Data is maintained by the BSData community; always check your official rules.</p>
  </main>`;
}

async function updateAll() {
  if (!S.downloaded.length) return toast('Nothing downloaded yet');
  const all = [];
  try {
    let ref;
    try {
      const c = await latestCommit(S.settings.source);
      ref = c.sha;
      S.factionIndex = { ...(S.factionIndex || {}), sha: c.sha, date: c.date, checkedAt: Date.now() };
      await store.set('kv', 'factionIndex', S.factionIndex);
    } catch { /* use branch */ }
    for (const d of S.downloaded.slice()) {
      showBusy(`Updating ${d.name}…`);
      const res = await buildFaction(S.settings.source, d.file, { ref, onProgress: (m) => showBusy(`${d.name}: ${m}`) });
      prepFaction(res.faction);
      factionCache.set(d.file, res.faction);
      all.push({ name: d.name, changes: res.changes });
    }
  } catch (e) {
    toast(e.message || 'Update failed');
  } finally {
    hideBusy();
  }
  await refreshDownloaded();
  rerender();
  const total = all.reduce((t, x) => t + x.changes.length, 0);
  showSheet(
    () => `<div class="sheet-head"><h2>Data updated</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body">${total ? all
      .filter((x) => x.changes.length)
      .map((x) => `<h3 class="sec">${esc(x.name)}</h3><ul class="changes">${x.changes.map((c) => `<li>${esc(c.name)}: ${c.kind === 'new' ? `<span class="tag">new</span> ${esc(c.to)}` : `${esc(c.from)} → <b>${esc(c.to)}</b>`}</li>`).join('')}</ul>`)
      .join('') : '<p>Everything is up to date — no points changes.</p>'}
      <p class="muted small">Your lists now use the new points automatically.</p></div>`,
    { tall: total > 6 }
  );
}

async function downloadFactionSheet() {
  newListDraft = null;
  let factions = S.factionIndex?.files;
  if (!factions || !factions.length) {
    showBusy('Fetching faction list…');
    try {
      factions = await listFactions(S.settings.source, S.settings.source.branch);
      S.factionIndex = { ...(S.factionIndex || {}), files: factions, checkedAt: Date.now() };
      await store.set('kv', 'factionIndex', S.factionIndex);
    } finally {
      hideBusy();
    }
  }
  const have = new Set(S.downloaded.map((d) => d.file));
  showSheet(
    () => `<div class="sheet-head"><h2>Download faction</h2><button class="icon" data-act="closeSheet">✕</button></div>
    <div class="sheet-body">${factions.map((f) => `<button class="frow" data-act="dlFaction" data-file="${esc(f.file)}"><span>${esc(f.name)}</span><span class="muted small">${have.has(f.file) ? 'saved' : esc(f.group)}</span></button>`).join('')}</div>`,
    { tall: true }
  );
}

async function exportBackup() {
  const data = { app: 'muster', v: 1, exported: new Date().toISOString(), lists: S.lists, games: S.games, settings: S.settings };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const name = `muster-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Muster backup' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'muster') throw new Error();
    const ok = await confirmBox(`Import ${plural(d.lists?.length || 0, 'list')} and ${plural(d.games?.length || 0, 'game')}? Items with the same ID are replaced; others are kept.`, 'Import');
    if (!ok) return;
    const merge = (cur, inc) => {
      const m = new Map(cur.map((x) => [x.id, x]));
      for (const x of inc || []) m.set(x.id, x);
      return [...m.values()];
    };
    S.lists = merge(S.lists, d.lists);
    S.games = merge(S.games, d.games);
    await save();
    toast('Backup imported');
    rerender();
  } catch {
    toast("That file isn't a Muster backup");
  }
}

// ---------------------------------------------------------------- actions
const A = {
  closeSheet: () => closeSheet(),
  scrim: () => closeSheet(),
  confirmYes: () => confirmResolve && confirmResolve(true),
  confirmNo: () => confirmResolve && confirmResolve(false),
  promptOk: () => promptResolve && promptResolve($('#promptInput').value),
  install: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    rerender();
  },
  // lists
  newList: () => newListFlow().catch((e) => toast(e.message)),
  nlLimit: (el) => {
    keepNewListName();
    newListDraft.limit = +el.dataset.v;
    rerenderTopSheet();
  },
  nlFaction: (el) => {
    keepNewListName();
    newListDraft.file = el.dataset.file;
    rerenderTopSheet();
  },
  nlCreate: () => createListFromDraft(),
  openList: (el) => {
    S.openListId = el.dataset.id;
    render();
  },
  backToLists: () => {
    S.openListId = null;
    render();
  },
  downloadForList: async () => {
    const l = curList();
    try {
      await ensureFaction(l.factionFile);
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
  importList: async () => {
    const code = await promptBox('Import list code', '', { placeholder: 'Paste a MUSTER1:… code', multiline: true, okLabel: 'Import' });
    if (!code) return;
    let d;
    try {
      d = decodeList(code);
    } catch {
      return toast("That doesn't look like a Muster code");
    }
    try {
      await ensureFaction(d.f);
    } catch (e) {
      return toast(e.message);
    }
    const f = await getFaction(d.f);
    const list = {
      id: uid(),
      name: d.n || 'Imported list',
      factionFile: d.f,
      factionName: f.name,
      limit: d.l || 2000,
      detachmentId: d.d || '',
      units: d.u.map(([unitId, models, enh, wl, notes, name, po]) => ({ uid: uid(), unitId, models, enhancementId: enh, warlord: !!wl, notes, ptsOverride: po ?? null, name: f.unitById.get(unitId)?.name || name || 'Unknown unit', lastPts: 0 })),
      created: Date.now(),
      updated: Date.now(),
    };
    S.lists.push(list);
    await save('lists');
    S.tab = 'lists';
    S.openListId = list.id;
    render();
    toast('List imported');
  },
  listMenu: () => listMenu(),
  renameList: async () => {
    const l = curList();
    closeAllSheets();
    const v = await promptBox('List name', l.name);
    if (v && v.trim()) {
      l.name = v.trim();
      touch(l);
      rerender();
    }
  },
  setLimit: async () => {
    const l = curList();
    closeAllSheets();
    const v = await promptBox('Points limit', String(l.limit));
    const n = parseInt(v, 10);
    if (n > 0) {
      l.limit = n;
      touch(l);
      rerender();
    }
  },
  dupList: () => {
    const l = curList();
    const copy = JSON.parse(JSON.stringify(l));
    copy.id = uid();
    copy.name = l.name + ' (copy)';
    copy.created = copy.updated = Date.now();
    copy.units.forEach((e) => (e.uid = uid()));
    S.lists.push(copy);
    save('lists');
    closeAllSheets();
    S.openListId = copy.id;
    render();
    toast('List duplicated');
  },
  deleteList: async () => {
    const l = curList();
    closeAllSheets();
    if (await confirmBox(`Delete “${l.name}”? This can't be undone.`, 'Delete', true)) {
      S.lists = S.lists.filter((x) => x.id !== l.id);
      await save('lists');
      S.openListId = null;
      render();
    }
  },
  refreshListData: async () => {
    const l = curList();
    closeAllSheets();
    try {
      const { changes } = await ensureFaction(l.factionFile, { force: true });
      toast(changes.length ? `${plural(changes.length, 'points change')} applied` : 'Data refreshed — no points changes');
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
  shareText: () => {
    const l = curList();
    shareText(l.name, listAsText(l, factionCache.get(l.factionFile)));
  },
  shareCode: () => {
    const l = curList();
    shareText(l.name, encodeList(l));
  },
  toggleIssues: () => {
    S.showIssues = !S.showIssues;
    rerender();
  },
  pickDetachment: () => pickDetachment(),
  detExpand: (el) => detExpandHandler && detExpandHandler(el.dataset.id),
  detChoose: (el) => {
    const l = curList();
    l.detachmentId = el.dataset.id;
    touch(l);
    closeSheet();
    rerender();
  },
  armyRules: async () => {
    const l = curList();
    const f = await getFaction(l.factionFile);
    showSheet(() => `<div class="sheet-head"><h2>Army rules</h2><button class="icon" data-act="closeSheet">✕</button></div>
      <div class="sheet-body">${f.armyRules.map((r) => `<div class="rule"><b>${esc(r.name)}</b><div>${fmtRule(r.text)}</div></div>`).join('')}</div>`, { tall: true });
  },
  addUnit: () => addUnitSheet(),
  pickRole: (el) => {
    picker.role = el.dataset.v;
    rerenderTopSheet();
  },
  toggleLegends: () => {
    S.settings.hideLegends = !S.settings.hideLegends;
    save('settings');
    rerenderTopSheet();
  },
  pickAdd: (el) => {
    addUnitToList(el.dataset.id);
    if (el.dataset.close) closeSheet();
    // refresh counts in picker if it is open beneath
    const r = $('#pickResults');
    if (r) {
      const l = curList();
      r.innerHTML = pickerResults(factionCache.get(l.factionFile), l);
    }
  },
  viewUnit: (el) => viewUnitSheet(el.dataset.id, !!el.dataset.add),
  editEntry: (el) => editEntrySheet(el.dataset.uid),
  setSize: (el) => {
    const l = curList();
    const e = l.units.find((x) => x.uid === el.dataset.uid);
    e.models = +el.dataset.v;
    e.lastPts = entryPts(e, factionCache.get(l.factionFile));
    touch(l);
    rerenderTopSheet();
  },
  setWarlord: (el) => {
    const l = curList();
    for (const x of l.units) x.warlord = x.uid === el.dataset.uid ? el.checked : false;
    touch(l);
    rerenderTopSheet();
  },
  setEnh: (el) => {
    const l = curList();
    const e = l.units.find((x) => x.uid === el.dataset.uid);
    e.enhancementId = el.dataset.v;
    e.lastPts = entryPts(e, factionCache.get(l.factionFile));
    touch(l);
    rerenderTopSheet();
  },
  toggleAllEnh: () => toggleAllEnhHandler && toggleAllEnhHandler(),
  dupEntry: (el) => {
    const l = curList();
    const e = l.units.find((x) => x.uid === el.dataset.uid);
    l.units.splice(l.units.indexOf(e) + 1, 0, { ...e, uid: uid(), warlord: false, enhancementId: '' });
    touch(l);
    closeSheet();
    toast(`Duplicated ${e.name}`);
  },
  removeEntry: (el) => {
    const l = curList();
    l.units = l.units.filter((x) => x.uid !== el.dataset.uid);
    touch(l);
    closeSheet();
  },
  // battle
  newGame: () => newGameSheet(),
  ngStart: () => startGame(),
  setRound: (el) => {
    activeGame().round = +el.dataset.v;
    save('games');
    rerender();
  },
  nextRound: () => {
    const g = activeGame();
    g.round = Math.min(5, g.round + 1);
    save('games');
    render();
  },
  step: (el) => {
    const g = activeGame();
    const [k, i] = el.dataset.k.split(':');
    const p = g.players[+i];
    const d = +el.dataset.d;
    if (k === 'cp') p.cp = Math.max(0, p.cp + d);
    else {
      const arr = k === 'pri' ? p.primary : p.secondary;
      arr[g.round - 1] = Math.max(0, (+arr[g.round - 1] || 0) + d);
    }
    save('games');
    rerender();
  },
  cpBoth: () => {
    activeGame().players.forEach((p) => (p.cp += 1));
    save('games');
    rerender();
    toast('+1 CP to both players');
  },
  toggleBR: (el) => {
    activeGame().players[+el.dataset.i].battleReady = el.checked;
    save('games');
    rerender();
  },
  renamePlayer: async (el) => {
    const g = activeGame();
    const p = g.players[+el.dataset.i];
    const v = await promptBox('Player name', p.name);
    if (v && v.trim()) {
      p.name = v.trim();
      save('games');
      rerender();
    }
  },
  openPlayerList: (el) => {
    const g = activeGame();
    const id = g.players[+el.dataset.i].listId;
    if (!S.lists.find((l) => l.id === id)) return toast('That list was deleted');
    S.tab = 'lists';
    S.openListId = id;
    render();
  },
  gameMenu: () => gameMenu(),
  renameMission: async () => {
    const g = activeGame();
    closeAllSheets();
    const v = await promptBox('Mission', g.mission);
    if (v != null) {
      g.mission = v.trim();
      save('games');
      rerender();
    }
  },
  shareGame: () => shareText('Game result', gameSummary(activeGame())),
  endGame: async () => {
    closeAllSheets();
    const g = activeGame();
    if (!(await confirmBox('Finish this game and save the result?', 'Finish'))) return;
    g.finished = true;
    S.activeGameId = null;
    await save();
    render();
    viewGameSheet(g.id);
  },
  abandonGame: async () => {
    closeAllSheets();
    if (!(await confirmBox('Discard this game? Scores will be lost.', 'Discard', true))) return;
    S.games = S.games.filter((x) => x.id !== S.activeGameId);
    S.activeGameId = null;
    await save();
    render();
  },
  viewGame: (el) => viewGameSheet(el.dataset.id),
  reopenGame: (el) => {
    const g = S.games.find((x) => x.id === el.dataset.id);
    if (activeGame()) return toast('Finish your current game first');
    g.finished = false;
    S.activeGameId = g.id;
    save();
    closeAllSheets();
    render();
  },
  copyGame: (el) => copyText(gameSummary(S.games.find((x) => x.id === el.dataset.id))),
  deleteGame: async (el) => {
    const id = el.dataset.id;
    closeAllSheets();
    if (!(await confirmBox('Delete this game record?', 'Delete', true))) return;
    S.games = S.games.filter((x) => x.id !== id);
    await save('games');
    render();
  },
  // data
  updateAll: () => updateAll(),
  downloadFaction: () => downloadFactionSheet().catch((e) => toast(e.message)),
  dlFaction: async (el) => {
    closeAllSheets();
    try {
      const { changes } = await ensureFaction(el.dataset.file, { force: true });
      toast(changes.length ? `${plural(changes.length, 'points change')}` : 'Downloaded');
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
  removeFaction: async (el) => {
    const file = el.dataset.file;
    const used = S.lists.filter((l) => l.factionFile === file).length;
    if (!(await confirmBox(`Remove ${factionLabel(file)} data from this device?${used ? ` ${plural(used, 'list')} use it and will need it re-downloaded.` : ''}`, 'Remove', true))) return;
    await store.del('factions', file);
    factionCache.delete(file);
    await refreshDownloaded();
    rerender();
  },
  saveSource: async () => {
    const s = { owner: $('#srcOwner').value.trim(), repo: $('#srcRepo').value.trim(), branch: $('#srcBranch').value.trim() || 'main' };
    if (!s.owner || !s.repo) return toast('Owner and repo are needed');
    S.settings.source = s;
    S.factionIndex = null;
    await store.del('kv', 'factionIndex');
    await clearRawCache();
    await save('settings');
    toast('Source saved');
    rerender();
  },
  exportBackup: () => exportBackup(),
  tab: (el) => {
    S.tab = el.dataset.tab;
    closeAllSheets();
    render();
  },
};

function keepNewListName() {
  const n = $('#nlName');
  if (n && newListDraft) newListDraft.name = n.value;
  const c = $('#nlLimitCustom');
  if (c && c.value.trim() && newListDraft) newListDraft.limit = parseInt(c.value, 10) || newListDraft.limit;
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !el.dataset.act) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // handled on change
  const fn = A[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) {
    const fn = A[el.dataset.act];
    if (fn) fn(el, e);
    return;
  }
  const b = el.dataset && el.dataset.bind;
  if (b === 'importBackup' && el.files[0]) importBackup(el.files[0]);
  if (b === 'stepVal') {
    const g = activeGame();
    const [k, i] = el.dataset.k.split(':');
    const p = g.players[+i];
    const v = Math.max(0, parseInt(el.value, 10) || 0);
    if (k === 'cp') p.cp = v;
    else (k === 'pri' ? p.primary : p.secondary)[g.round - 1] = v;
    save('games');
    rerender();
  }
  if (b === 'ptsOverride') {
    const l = curList();
    const en = l.units.find((x) => x.uid === el.dataset.uid);
    en.ptsOverride = el.value.trim() === '' ? null : Math.max(0, parseInt(el.value, 10) || 0);
    touch(l);
    rerenderTopSheet();
  }
  if (b === 'cap') {
    S.settings.caps[el.dataset.k] = Math.max(0, parseInt(el.value, 10) || 0);
    save('settings');
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'pickQ') {
    picker.q = el.value;
    const l = curList();
    $('#pickResults').innerHTML = pickerResults(factionCache.get(l.factionFile), l);
    return;
  }
  const b = el.dataset && el.dataset.bind;
  if (b === 'entryNotes') {
    const l = curList();
    const en = l.units.find((x) => x.uid === el.dataset.uid);
    en.notes = el.value;
    touch(l);
  }
  if (b === 'secNote') {
    activeGame().players[+el.dataset.i].secNames = el.value;
    save('games');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'promptInput' && e.target.tagName === 'INPUT') A.promptOk();
  if (e.key === 'Escape' && sheets.length) closeSheet();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (S.tab === 'lists' && !S.openListId) rerender();
});

// ---------------------------------------------------------------- boot
async function boot() {
  const [lists, games, settings, idx] = await Promise.all([store.get('kv', 'lists'), store.get('kv', 'games'), store.get('kv', 'settings'), store.get('kv', 'factionIndex')]);
  S.lists = lists || [];
  S.games = games || [];
  if (settings) {
    S.activeGameId = settings.activeGameId || null;
    delete settings.activeGameId;
    S.settings = { ...S.settings, ...settings, caps: { ...S.settings.caps, ...(settings.caps || {}) }, source: { ...DEFAULT_SOURCE, ...(settings.source || {}) } };
  }
  S.factionIndex = idx || null;
  await refreshDownloaded();
  // preload factions used by lists so the home screen can show points
  for (const l of S.lists) await getFaction(l.factionFile);
  if (activeGame()) S.tab = 'battle';
  render();
  store.requestPersistence();
}

boot().catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<div class="pad"><p>Something went wrong starting Muster: ${esc(e.message)}</p></div>`;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// exposed for tests
window.__muster = { S, factionCache, validate, listPts, encodeList, decodeList };

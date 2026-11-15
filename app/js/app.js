// Muster — 11th edition army builder, battle tracker and stratagem reference.
// Data: Wahapedia export, compiled at build time into ./data (see scripts/compile.py).
import * as store from './store.js';
import * as data from './data.js';
import { weaponCounts, wargearPts, optionMax, starMax } from './wargear.js';

// ================================================================= state
const SIZES = {
  incursion: { label: 'Incursion', pts: 1000, dp: 2, enh: 2, unit: 2 },
  strike: { label: 'Strike Force', pts: 2000, dp: 3, enh: 4, unit: 3 },
};
const PHASES = [
  { k: 'command', label: 'Command' },
  { k: 'movement', label: 'Movement' },
  { k: 'shooting', label: 'Shooting' },
  { k: 'charge', label: 'Charge' },
  { k: 'fight', label: 'Fight' },
];

const S = {
  tab: 'army',
  openListId: null,
  lists: [],
  games: [],
  activeGameId: null,
  index: null,
  core: null,
  cached: [], // faction ids on this device
  settings: {
    caps: { primary: 50, secondary: 40, battleReady: 10, total: 100 },
    showLegends: false,
  },
  strat: { side: 'mine', listId: '', oppFaction: '', oppDets: [], allDets: false, core: true, phase: '', turn: '', q: '', open: {} },
  showIssues: true,
};
const factions = new Map();
let deferredInstall = null;

// ================================================================= utils
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

// Wahapedia descriptions are HTML: keep simple formatting, drop links, scripts and attributes
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'BR', 'P', 'UL', 'OL', 'LI', 'SPAN', 'DIV', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SUP', 'SUB']);
const sanCache = new Map();
function rich(html) {
  if (!html) return '';
  if (sanCache.has(html)) return sanCache.get(html);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (n) => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 1) {
        if (!ALLOWED.has(c.tagName)) {
          if (['SCRIPT', 'STYLE', 'IMG', 'IFRAME', 'OBJECT'].includes(c.tagName)) c.remove();
          else {
            walk(c);
            c.replaceWith(...c.childNodes);
          }
          continue;
        }
        const cls = c.getAttribute('class') || '';
        for (const a of [...c.attributes]) c.removeAttribute(a.name);
        if (/kwb/.test(cls)) c.setAttribute('class', 'kwd');
        if (/ShowFluff|legend/.test(cls)) c.setAttribute('class', 'fluff');
        walk(c);
      } else if (c.nodeType !== 3) c.remove();
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  const out = root.innerHTML;
  if (sanCache.size > 3000) sanCache.clear();
  sanCache.set(html, out);
  return out;
}
const plain = (html) => {
  const d = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  return d.body.textContent || '';
};

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
    toast('Copied');
  } catch {
    showSheet(() => `${head('Copy this')}<div class="sheet-body"><textarea class="copybox" readonly>${esc(text)}</textarea></div>`);
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

function showBusy(msg) {
  $('#busy .busy-msg').textContent = msg;
  $('#busy').classList.add('show');
}
const hideBusy = () => $('#busy').classList.remove('show');

// ================================================================= persistence
async function save(what) {
  if (!what || what === 'lists') await store.set('kv', 'lists', S.lists);
  if (!what || what === 'games') await store.set('kv', 'games', S.games);
  if (!what || what === 'settings') await store.set('kv', 'settings', { ...S.settings, activeGameId: S.activeGameId, strat: { ...S.strat, open: {}, q: '' } });
}

async function getFaction(id) {
  if (!id) return null;
  if (factions.has(id)) return factions.get(id);
  const f = await data.cachedFaction(id);
  if (f) factions.set(id, f);
  return f;
}

async function ensureIndex() {
  if (S.index) return S.index;
  showBusy('Getting faction list…');
  try {
    S.index = await data.fetchIndex();
  } finally {
    hideBusy();
  }
  return S.index;
}

async function ensureFaction(id) {
  const f = await getFaction(id);
  if (f) return f;
  const idx = await ensureIndex();
  const name = idx.factions.find((x) => x.id === id)?.n || id;
  showBusy(`Downloading ${name}…`);
  try {
    const nf = await data.downloadFaction(id, idx.built);
    factions.set(id, nf);
    S.cached = await data.cachedFactionIds();
    if (!S.core) S.core = await data.downloadCore().catch(() => null);
    return nf;
  } finally {
    hideBusy();
  }
}

// ================================================================= list maths
const ROLE_ORDER = ['Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted', 'Beast', 'Swarm', 'Monster', 'Walker', 'Vehicle', 'Transport', 'Dedicated Transports', 'Aircraft', 'Artillery', 'Titanic', 'Fortifications', 'Other'];
function roleGroup(u) {
  if (!u) return 'Other';
  if (u.epic) return 'Epic Hero';
  if (u.character) return 'Character';
  if (u.battleline) return 'Battleline';
  if (u.dt) return 'Dedicated Transports';
  return u.role.replace(/ (Character|Epic Hero)$/, '') || 'Other';
}
const roleRank = (r) => {
  const i = ROLE_ORDER.indexOf(r);
  return i < 0 ? ROLE_ORDER.length - 2 : i;
};

const limitsOf = (l) => l.limits || SIZES.strike;
const sizeKey = (l) => (SIZES[l.size] ? l.size : 'strike');

// Which copy of this datasheet is the entry (1st, 2nd, 3rd…) — stepped costs depend on it
function copyNo(e, l) {
  if (!l) return 1;
  let n = 0;
  for (const x of l.units) {
    if (x.unitId === e.unitId) n++;
    if (x.uid === e.uid) return n;
  }
  return 1;
}
function costOpt(u, e, l) {
  if (!u || !u.c.length) return { pts: 0, d: '' };
  const base = u.c[Math.min(e.cost || 0, u.c.length - 1)];
  const n = copyNo(e, l);
  const step = (u.cs || []).filter((s) => s.from <= n).sort((a, b) => b.from - a.from)[0];
  if (!step) return base;
  const row = step.rows.find((r) => r.models != null && r.models === base.models) || step.rows[Math.min(e.cost || 0, step.rows.length - 1)];
  return row ? { ...row, step: step.label } : base;
}
function entryPts(e, f, l) {
  if (e.ptsOverride != null && e.ptsOverride !== '') return +e.ptsOverride || 0;
  const u = f && f.unitById.get(e.unitId);
  if (!u) return e.lastPts || 0;
  let p = costOpt(u, e, l).pts;
  p += entryWargear(e, u, l).pts;
  for (const k of e.ex || []) {
    const [b, r] = k.split(':').map(Number);
    p += u.cx?.[b]?.rows?.[r]?.pts || 0;
  }
  const en = e.enh && f.enhById.get(e.enh);
  if (en) p += en.pts;
  return p;
}
// Model count of an entry (from the chosen size, else the smallest composition)
function entryModels(e, u, l) {
  const c = costOpt(u, e, l);
  if (c.models) return c.models;
  const m = /(\d+)\s+models?/.exec(c.d || '');
  return m ? +m[1] : 1;
}
function entryWargear(e, u, l) {
  const wc = weaponCounts(u, entryModels(e, u, l), e.wg || {});
  const wp = wargearPts(u, wc.counts);
  return { ...wc, pts: wp.pts, lines: wp.lines };
}
const isUnlocked = (u, l) => !u.xg || !(u.xu || []).length || (l.detachments || []).some((d) => u.xu.includes(d));
const listPts = (l, f) => l.units.reduce((t, e) => t + entryPts(e, f, l), 0);
const listDp = (l, f) => (l.detachments || []).reduce((t, id) => t + (f.detById.get(id)?.dp || 0), 0);

function validate(l, f) {
  const out = [];
  if (!f) return [{ level: 'warn', msg: 'Faction data not on this device yet.' }];
  const L = limitsOf(l);
  const pts = listPts(l, f);
  if (pts > L.pts) out.push({ level: 'error', msg: `Over the points limit by ${pts - L.pts}.` });
  const dp = listDp(l, f);
  if (!l.detachments.length) out.push({ level: 'warn', msg: 'No detachment chosen.' });
  if (dp > L.dp) out.push({ level: 'error', msg: `Detachments cost ${dp} DP — limit is ${L.dp}.` });
  const disp = dispositionsOf(l, f);
  if (l.detachments.length && !l.disposition) out.push({ level: 'warn', msg: 'No Force Disposition chosen.' });
  else if (l.disposition && !disp.includes(l.disposition)) out.push({ level: 'warn', msg: `${l.disposition} isn't granted by your detachments.` });
  const counts = new Map();
  for (const e of l.units) counts.set(e.unitId, (counts.get(e.unitId) || 0) + 1);
  for (const [id, n] of counts) {
    const u = f.unitById.get(id);
    if (!u) continue;
    const max = u.epic ? 1 : u.battleline ? L.unit * 2 : L.unit;
    if (n > max) out.push({ level: 'error', msg: `${u.n}: ${n} taken, max ${max}${u.epic ? ' (Epic Hero)' : ''}.` });
  }
  const withEnh = l.units.filter((e) => e.enh);
  if (withEnh.length > L.enh) out.push({ level: 'error', msg: `${withEnh.length} enhancements — limit is ${L.enh}.` });
  const seen = new Set();
  for (const e of withEnh) {
    const en = f.enhById.get(e.enh);
    const u = f.unitById.get(e.unitId);
    if (!en) continue;
    if (seen.has(en.id)) out.push({ level: 'error', msg: `${en.n} taken more than once.` });
    seen.add(en.id);
    if (en.det && !l.detachments.includes(en.det)) out.push({ level: 'error', msg: `${en.n} needs the ${en.dn} detachment.` });
    if (u && u.enh.length && !u.enh.includes(en.id)) out.push({ level: 'warn', msg: `${u.n} isn't listed as able to take ${en.n}.` });
    if (u && u.epic) out.push({ level: 'error', msg: `${u.n} is an Epic Hero and can't take enhancements.` });
  }
  const wl = l.units.filter((e) => e.warlord);
  if (l.units.length && !wl.length) out.push({ level: 'warn', msg: 'No Warlord chosen.' });
  if (wl.length > 1) out.push({ level: 'error', msg: 'More than one Warlord.' });
  for (const e of wl) {
    const u = f.unitById.get(e.unitId);
    if (u && !u.character) out.push({ level: 'error', msg: `${u.n} isn't a Character, so can't be Warlord.` });
  }
  const onHost = new Map();
  for (const e of l.units) {
    if (!e.attachTo) continue;
    const host = l.units.find((x) => x.uid === e.attachTo);
    const u = f.unitById.get(e.unitId);
    if (!host) continue;
    if (u && !u.leads.includes(host.unitId)) out.push({ level: 'error', msg: `${u.n} can't be attached to ${host.name}.` });
    if (!onHost.has(host.uid)) onHost.set(host.uid, { host, leaders: [], support: [] });
    onHost.get(host.uid)[u && u.sup ? 'support' : 'leaders'].push(e.name);
  }
  for (const { host, leaders, support } of onHost.values()) {
    if (leaders.length > 1) out.push({ level: 'error', msg: `${host.name} can only have one Leader (has ${leaders.join(', ')}).` });
    if (support.length > 1) out.push({ level: 'error', msg: `${host.name} can only have one Support character (has ${support.join(', ')}).` });
  }
  for (const e of l.units) {
    const u = f.unitById.get(e.unitId);
    if (u && !isUnlocked(u, l)) out.push({ level: 'error', msg: `${u.n} (${u.xg}) needs the ${u.xu.map((id) => f.detById.get(id)?.n).filter(Boolean).join(' or ')} detachment.` });
    if (u && u.legends) out.push({ level: 'warn', msg: `${u.n} is a Legends unit — not usable in matched play.` });
  }
  for (const e of l.units) if (!f.unitById.get(e.unitId)) out.push({ level: 'warn', msg: `${e.name} is no longer in the data (kept at ${e.lastPts || 0} pts).` });
  return out;
}

function dispositionsOf(l, f) {
  const s = new Set();
  for (const id of l.detachments || []) for (const d of f.detById.get(id)?.fd || []) s.add(d);
  return [...s];
}

// Entries ordered by role, with attached characters directly after their bodyguard
function groupEntries(l, f) {
  const attached = new Map();
  for (const e of l.units) if (e.attachTo && l.units.some((x) => x.uid === e.attachTo)) {
    if (!attached.has(e.attachTo)) attached.set(e.attachTo, []);
    attached.get(e.attachTo).push(e);
  }
  const groups = new Map();
  for (const e of l.units) {
    if (e.attachTo && l.units.some((x) => x.uid === e.attachTo)) continue;
    const role = roleGroup(f && f.unitById.get(e.unitId));
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(e, ...(attached.get(e.uid) || []));
  }
  return [...groups.entries()].sort((a, b) => roleRank(a[0]) - roleRank(b[0]));
}

// "2× Heavy stubber, 1× Flamer" from the chosen wargear options
function wargearSummary(e, u, l) {
  if (!e.wg) return '';
  const wc = entryWargear(e, u, l);
  const out = [];
  for (const o of wc.opts) {
    for (const [ci, n] of Object.entries(e.wg[o.i] || {})) if (n && o.choices[+ci]) out.push(`${n}× ${o.choices[+ci].label.replace(/^1\s+/, '')}`);
  }
  return out.join(', ');
}
function listAsText(l, f) {
  const L = limitsOf(l);
  const dets = l.detachments.map((id) => f.detById.get(id)).filter(Boolean);
  const lines = [
    `${l.name} — ${listPts(l, f)}/${L.pts} pts`,
    `${l.factionName} · ${dets.map((d) => `${d.n} (${d.dp} DP)`).join(' + ') || 'no detachment'}`,
    l.disposition ? `Force Disposition: ${l.disposition}` : '',
    '',
  ].filter((x, i) => x || i === 3);
  for (const [role, entries] of groupEntries(l, f)) {
    lines.push(role.toUpperCase());
    for (const e of entries) {
      const u = f.unitById.get(e.unitId);
      const en = e.enh && f.enhById.get(e.enh);
      const bits = [];
      if (u && u.c.length > 1) bits.push(costOpt(u, e, l).d);
      if (e.warlord) bits.push('Warlord');
      if (en) bits.push(`${en.n} +${en.pts}`);
      const host = e.attachTo && l.units.find((x) => x.uid === e.attachTo);
      lines.push(`${host ? '   ↳ ' : '• '}${e.name}${bits.length ? ' [' + bits.join(', ') + ']' : ''} — ${entryPts(e, f, l)} pts${host ? ` (with ${host.name})` : ''}`);
      const ws = u ? wargearSummary(e, u, l) : '';
      if (ws) lines.push(`     ${ws}`);
      if (e.notes) lines.push(`     ${e.notes.replace(/\n/g, '; ')}`);
    }
    lines.push('');
  }
  lines.push('Made with Muster · data powered by Wahapedia');
  return lines.join('\n');
}

function encodeList(l) {
  const d = { v: 2, n: l.name, f: l.factionId, s: l.size, L: l.limits, d: l.detachments, fd: l.disposition || '', u: l.units.map((e) => [e.unitId, e.cost || 0, e.enh || '', e.warlord ? 1 : 0, e.notes || '', e.name, e.ptsOverride ?? null, e.uid, e.attachTo || '', e.ex || [], e.wg || {}]) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(d))));
  return 'MUSTER2:' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeList(code) {
  const raw = String(code || '').trim().replace(/^MUSTER2:/, '').replace(/\s+/g, '');
  const d = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))));
  if (d.v !== 2 || !d.f) throw new Error('bad');
  return d;
}

// ================================================================= sheets
const sheets = [];
let confirmResolve = null;
let promptResolve = null;
const head = (title, extra = '') => `<div class="sheet-head"><h2>${esc(title)}</h2>${extra}<button class="icon" data-act="closeSheet" aria-label="Close">✕</button></div>`;
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
  $('#sheets').innerHTML = sheets
    .map((s, i) => `<div class="scrim" data-act="${i === sheets.length - 1 ? 'closeSheet' : ''}"></div><div class="sheet ${s.opts.tall ? 'tall' : ''}" data-sheet="${i}">${s.render()}</div>`)
    .join('');
  document.body.classList.toggle('sheet-open', sheets.length > 0);
}
function rerenderTopSheet() {
  const i = sheets.length - 1;
  const el = document.querySelector(`[data-sheet="${i}"]`);
  if (!el) return renderSheets();
  const sc = el.querySelector('.sheet-body')?.scrollTop || 0;
  el.innerHTML = sheets[i].render();
  const b = el.querySelector('.sheet-body');
  if (b) b.scrollTop = sc;
}
function confirmBox(msg, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    showSheet(() => `<div class="sheet-body pad-top"><p class="confirm-msg">${esc(msg)}</p><div class="row gap"><button class="btn ghost grow" data-act="confirmNo">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'} grow" data-act="confirmYes">${esc(ok)}</button></div></div>`, { onClose: () => resolve(false) });
    confirmResolve = (v) => {
      sheets.pop();
      renderSheets();
      resolve(v);
    };
  });
}
function promptBox(title, value = '', { placeholder = '', multiline = false, ok = 'Save', numeric = false } = {}) {
  return new Promise((resolve) => {
    showSheet(
      () => `${head(title)}<div class="sheet-body">${multiline ? `<textarea id="promptInput" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="promptInput" ${numeric ? 'inputmode="numeric"' : ''} value="${esc(value)}" placeholder="${esc(placeholder)}">`}<button class="btn primary block" data-act="promptOk">${esc(ok)}</button></div>`,
      { onClose: () => resolve(null) }
    );
    promptResolve = (v) => {
      sheets.pop();
      renderSheets();
      resolve(v);
    };
    setTimeout(() => $('#promptInput')?.focus(), 60);
  });
}

// ================================================================= render
let keepScroll = false;
function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  const y = window.scrollY;
  const v = $('#view');
  if (S.tab === 'army') v.innerHTML = S.openListId ? viewList() : viewLists();
  else if (S.tab === 'battle') v.innerHTML = viewBattle();
  else v.innerHTML = viewStrats();
  window.scrollTo(0, keepScroll ? y : 0);
  keepScroll = false;
  if (S.tab === 'army' && S.openListId) hydrateList();
  if (S.tab === 'strats') hydrateStrats();
}
const rerender = () => {
  keepScroll = true;
  render();
};
const gear = `<button class="icon" data-act="settings" aria-label="Settings">⚙</button>`;

function installBanner() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  if (deferredInstall) return `<div class="banner"><span>Install Muster on this device</span><button class="btn small primary" data-act="install">Install</button></div>`;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return `<div class="banner"><span>To install: tap <b>Share</b> then <b>Add to Home Screen</b>.</span></div>`;
  return '';
}

// ---------------------------------------------------------------- Army: lists
function viewLists() {
  const cards = S.lists
    .slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .map((l) => {
      const f = factions.get(l.factionId);
      const L = limitsOf(l);
      const pts = f ? listPts(l, f) : '—';
      const dets = f ? l.detachments.map((id) => f.detById.get(id)?.n).filter(Boolean).join(' + ') : '';
      const errs = f ? validate(l, f).filter((x) => x.level === 'error').length : 0;
      return `<button class="card list-card" data-act="openList" data-id="${l.id}"><div class="lc-main"><div class="lc-name">${esc(l.name)}</div>
        <div class="lc-sub">${esc(l.factionName)}${dets ? ' · ' + esc(dets) : ''}</div>
        <div class="lc-sub">${plural(l.units.length, 'unit')}${errs ? ` · <span class="err">${plural(errs, 'issue')}</span>` : ''}</div></div>
        <div class="lc-pts ${f && pts > L.pts ? 'err' : ''}"><b>${pts}</b><span>/ ${L.pts}</span></div></button>`;
    })
    .join('');
  return `<header class="top"><div class="brand"><span class="logo">◈</span> Muster</div><div class="grow"></div>${gear}</header>
  <main class="pad">${installBanner()}
    <div class="row gap"><button class="btn primary grow" data-act="newList">＋ New army list</button><button class="btn ghost" data-act="importList">Import</button></div>
    ${cards ? `<div class="stack">${cards}</div>` : `<div class="empty"><div class="empty-ico">⚔</div><p>No army lists yet.</p><p class="muted">Pick a faction to start. Its datasheets, points, detachments and stratagems download to this phone so they work offline.</p></div>`}
  </main>`;
}

async function newListFlow() {
  const idx = await ensureIndex();
  const draft = { name: '', faction: '', size: 'strike', pts: null };
  newDraft = draft;
  showSheet(
    () => `${head('New army list')}<div class="sheet-body">
      <label class="lbl">List name</label><input id="nlName" placeholder="e.g. Votann – Hearthband" value="${esc(draft.name)}">
      <label class="lbl">Battle size (sets the rules)</label>
      <div class="chips">${Object.entries(SIZES).map(([k, s]) => `<button class="chip ${draft.size === k ? 'on' : ''}" data-act="nlSize" data-v="${k}">${s.label}</button>`).join('')}</div>
      <p class="muted small">${SIZES[draft.size].dp} DP · ${SIZES[draft.size].enh} enhancements · ${SIZES[draft.size].unit} of each unit (Battleline ×2)</p>
      <label class="lbl">Points limit</label>
      <div class="row gap"><input id="nlPts" inputmode="numeric" value="${draft.pts ?? SIZES[draft.size].pts}"><span class="muted small nowrap">e.g. 1250 with Strike Force rules</span></div>
      <label class="lbl">Faction</label>
      ${idx.factions.map((f) => `<button class="frow ${draft.faction === f.id ? 'on' : ''}" data-act="nlFaction" data-id="${f.id}"><span>${esc(f.n)}</span><span class="muted small">${S.cached.includes(f.id) ? 'saved' : f.units + ' units'}</span></button>`).join('')}
    </div><div class="sheet-foot"><button class="btn primary block" data-act="nlCreate" ${draft.faction ? '' : 'disabled'}>Create list</button></div>`,
    { tall: true }
  );
}
let newDraft = null;
function keepDraftName() {
  const n = $('#nlName');
  if (n && newDraft) newDraft.name = n.value;
  const p = $('#nlPts');
  if (p && newDraft) newDraft.pts = parseInt(p.value, 10) || null;
}
async function createList() {
  keepDraftName();
  const d = newDraft;
  if (!d.faction) return;
  let f;
  try {
    f = await ensureFaction(d.faction);
  } catch (e) {
    return toast(e.message);
  }
  const pts = d.pts || SIZES[d.size].pts;
  const l = { id: uid(), name: d.name.trim() || `${f.n} ${pts}`, factionId: f.id, factionName: f.n, size: d.size, limits: { ...SIZES[d.size], pts }, detachments: [], disposition: '', units: [], created: Date.now(), updated: Date.now() };
  delete l.limits.label;
  S.lists.push(l);
  await save('lists');
  closeAllSheets();
  S.openListId = l.id;
  render();
}

// ---------------------------------------------------------------- Army: builder
const curList = () => S.lists.find((l) => l.id === S.openListId);
function touch(l) {
  l.updated = Date.now();
  save('lists');
}

function viewList() {
  const l = curList();
  if (!l) {
    S.openListId = null;
    return viewLists();
  }
  const f = factions.get(l.factionId);
  return `<header class="top"><button class="icon back" data-act="backToLists" aria-label="Back">‹</button>
    <div class="top-title" data-act="renameList"><div class="tt-name">${esc(l.name)}</div><div class="tt-sub">${esc(l.factionName)}</div></div>
    <button class="icon" data-act="listMenu" aria-label="List options">⋯</button></header>
  <main class="pad" id="listBody">${f ? listBody(l, f) : '<div class="loading">Loading…</div>'}</main>`;
}
async function hydrateList() {
  const l = curList();
  if (!l || factions.has(l.factionId)) return;
  const f = await getFaction(l.factionId);
  const b = $('#listBody');
  if (!b) return;
  b.innerHTML = f ? listBody(l, f) : `<div class="empty"><p>${esc(l.factionName)} data isn't on this device yet.</p><button class="btn primary" data-act="downloadForList">Download ${esc(l.factionName)}</button></div>`;
}

function meter(label, used, max) {
  const over = used > max;
  return `<div class="meter ${over ? 'over' : ''}"><div class="m-top"><span>${label}</span><b>${used}<span>/${max}</span></b></div><div class="track"><div class="fill" style="width:${Math.min(100, max ? (used / max) * 100 : 0)}%"></div></div></div>`;
}

function listBody(l, f) {
  const L = limitsOf(l);
  const pts = listPts(l, f);
  const dp = listDp(l, f);
  const enhN = l.units.filter((e) => e.enh).length;
  const issues = validate(l, f);
  const errs = issues.filter((i) => i.level === 'error').length;
  const dets = l.detachments.map((id) => f.detById.get(id)).filter(Boolean);
  const disp = dispositionsOf(l, f);
  return `
  <div class="meters" data-act="editLimits">${meter('Points', pts, L.pts)}${meter('DP', dp, L.dp)}${meter('Enhancements', enhN, L.enh)}</div>
  <button class="card dets" data-act="pickDetachments">
    <div class="muted small">Detachments</div>
    ${dets.length ? dets.map((d) => `<div class="det-line"><span>${esc(d.n)}</span><span class="tag">${d.dp} DP</span></div>`).join('') : '<div class="warn">Choose detachments…</div>'}
  </button>
  <div class="row gap">
    <button class="card det grow" data-act="pickDisposition"><div class="muted small">Force Disposition</div><div>${l.disposition ? esc(l.disposition) : disp.length ? '<span class="warn">Choose…</span>' : '<span class="muted">—</span>'}</div></button>
    ${f.armyRules.length ? `<button class="card det grow" data-act="armyRules"><div class="muted small">Army rule</div><div>${esc(f.armyRules.map((r) => r.n).join(', '))}</div></button>` : ''}
  </div>
  ${issues.length ? `<div class="issues ${errs ? 'has-err' : ''}"><button class="issues-h" data-act="toggleIssues">${errs ? `⚠ ${plural(errs, 'problem')}` : '✓ Legal'}${issues.length - errs ? ` · ${plural(issues.length - errs, 'note')}` : ''}<span>${S.showIssues ? '▾' : '▸'}</span></button>
    ${S.showIssues ? `<ul>${issues.map((i) => `<li class="${i.level}">${esc(i.msg)}</li>`).join('')}</ul>` : ''}</div>` : l.units.length ? `<div class="issues ok"><div class="issues-h">✓ Legal list</div></div>` : ''}
  ${groupEntries(l, f)
    .map(([role, entries]) => {
      const shut = S.foldList && S.foldList[role];
      return `<section><button class="sec sec-btn" data-act="listFold" data-k="${esc(role)}"><span>${shut ? '▸' : '▾'} ${esc(role)} <span class="muted">(${entries.length})</span></span><span class="muted">${entries.reduce((t, e) => t + entryPts(e, f, l), 0)}</span></button>
      ${shut ? '' : entries.map((e) => entryRow(e, l, f)).join('')}</section>`;
    })
    .join('')}
  ${l.units.length ? '' : `<div class="empty small"><p class="muted">No units yet — tap “Add unit”.</p></div>`}
  <div class="spacer"></div>
  <button class="fab" data-act="addUnit">＋ Add unit</button>`;
}

function entryRow(e, l, f) {
  const u = f.unitById.get(e.unitId);
  const en = e.enh && f.enhById.get(e.enh);
  const host = e.attachTo && l.units.find((x) => x.uid === e.attachTo);
  const sub = [];
  if (u && u.c.length > 1) sub.push(esc(costOpt(u, e, l).d));
  const co = u && costOpt(u, e, l);
  if (co && co.step) sub.push(`<span class="warn">${esc(co.step)}</span>`);
  if (en) sub.push(`✦ ${esc(en.n)}`);
  const ws = u ? wargearSummary(e, u, l) : '';
  if (ws) sub.push(esc(ws));
  if (e.notes) sub.push(esc(e.notes.split('\n')[0]));
  return `<button class="entry ${host ? 'attached' : ''}" data-act="editEntry" data-uid="${e.uid}">
    <div class="en-main"><div class="en-name">${host ? '<span class="muted">↳ </span>' : ''}${e.warlord ? '<span class="crown">♛</span>' : ''}${esc(e.name)}${u ? '' : ' <span class="warn">(missing)</span>'}</div>
    ${sub.length ? `<div class="en-sub">${sub.join(' · ')}</div>` : ''}</div><div class="en-pts">${entryPts(e, f, l)}</div></button>`;
}

function pickDetachments() {
  const l = curList();
  const f = factions.get(l.factionId);
  let open = '';
  showSheet(
    () => {
      const L = limitsOf(l);
      const dp = listDp(l, f);
      return `${head('Detachments', `<span class="tag big">${dp}/${L.dp} DP</span>`)}<div class="sheet-body">
      <p class="muted small">Spend up to ${L.dp} Detachment Points. Tap a name to read its rules.</p>
      ${f.detachments
        .map((d) => {
          const on = l.detachments.includes(d.id);
          const enh = f.enhancements.filter((e) => e.det === d.id);
          const nStr = f.stratagems.filter((s) => s.det === d.id).length;
          const isOpen = open === d.id;
          return `<div class="det-opt ${on ? 'on' : ''}"><div class="row gap">
            <button class="grow det-name" data-act="detOpen" data-id="${d.id}"><div>${esc(d.n)} <span class="muted">${isOpen ? '▾' : '▸'}</span></div><div class="muted small">${esc(d.fd.join(' · ') || '—')} · ${plural(nStr, 'stratagem')}</div></button>
            <span class="tag">${d.dp} DP</span>
            <button class="btn small ${on ? 'primary' : 'ghost'}" data-act="detToggle" data-id="${d.id}">${on ? '✓ In' : 'Add'}</button></div>
            ${isOpen ? `<div class="det-rules">${d.rules.map((r) => `<div class="rule"><b>${esc(r.n)}</b><div>${rich(r.d)}</div></div>`).join('') || '<p class="muted small">No rule text.</p>'}
              ${enh.length ? `<div class="muted small">Enhancements</div>${enh.map((e) => `<div class="rule"><b>${esc(e.n)}</b> <span class="pts">${e.pts} pts</span>${e.up ? ' <span class="tag">upgrade</span>' : ''}<div>${rich(e.d)}</div></div>`).join('')}` : ''}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`;
    },
    { tall: true, onClose: () => rerender() }
  );
  detOpenHandler = (id) => {
    open = open === id ? '' : id;
    rerenderTopSheet();
  };
}
let detOpenHandler = null;

function pickDisposition() {
  const l = curList();
  const f = factions.get(l.factionId);
  const disp = dispositionsOf(l, f);
  if (!disp.length) return toast('Choose a detachment first');
  showSheet(() => `${head('Force Disposition')}<div class="sheet-body"><p class="muted small">Granted by your detachments — pick one for the battle.</p>
    ${disp.map((d) => `<button class="frow ${l.disposition === d ? 'on' : ''}" data-act="setDisposition" data-v="${esc(d)}"><span>${esc(d)}</span><span class="muted small">${esc(l.detachments.map((id) => f.detById.get(id)).filter((x) => x && x.fd.includes(d)).map((x) => x.n).join(', '))}</span></button>`).join('')}</div>`);
}

// unit picker — War Organ style: folding sections by role, borrowed units and Legends last
const picker = { q: '', open: {} };
function pickerSections(f, l) {
  const q = picker.q.toLowerCase();
  const match = (u) => !q || u.n.toLowerCase().includes(q) || u.kw.some((k) => k.toLowerCase().includes(q));
  const roles = new Map();
  const cross = new Map();
  const legends = [];
  const locked = new Map();
  for (const u of f.units) {
    if (!match(u)) continue;
    if (u.legends) {
      if (S.settings.showLegends) legends.push(u);
      continue;
    }
    if (u.xg) {
      if (!isUnlocked(u, l)) {
        locked.set(u.xg, u.xu);
        continue;
      }
      if (!cross.has(u.xg)) cross.set(u.xg, []);
      cross.get(u.xg).push(u);
      continue;
    }
    const r = roleGroup(u);
    if (!roles.has(r)) roles.set(r, []);
    roles.get(r).push(u);
  }
  const secs = [...roles.entries()].sort((a, b) => roleRank(a[0]) - roleRank(b[0])).map(([k, us]) => ({ key: k, title: k, units: us }));
  for (const [k, us] of cross) secs.push({ key: 'x:' + k, title: k, sub: 'Allied units', units: us.sort((a, b) => roleRank(roleGroup(a)) - roleRank(roleGroup(b)) || a.n.localeCompare(b.n)) });
  if (legends.length) secs.push({ key: 'legends', title: 'Legends', sub: 'Not for matched play', units: legends });
  return { secs, locked };
}
function addUnitSheet() {
  picker.q = '';
  showSheet(
    () => {
      const l = curList();
      const f = factions.get(l.factionId);
      return `${head('Add unit')}<div class="sheet-sub"><input id="pickQ" type="search" placeholder="Search datasheets…" value="${esc(picker.q)}" autocomplete="off">
        <label class="toggle small"><input type="checkbox" data-act="toggleLegends" ${S.settings.showLegends ? 'checked' : ''}><span>Show Legends units</span></label></div>
        <div class="sheet-body" id="pickResults">${pickerResults(f, l)}</div>`;
    },
    { tall: true }
  );
}
function pickerResults(f, l) {
  const { secs, locked } = pickerSections(f, l);
  const counts = new Map();
  for (const e of l.units) counts.set(e.unitId, (counts.get(e.unitId) || 0) + 1);
  const searching = !!picker.q;
  const row = (u) => {
    const pts = u.c.length ? (u.c.length > 1 ? `${u.c[0].pts}–${u.c[u.c.length - 1].pts}` : u.c[0].pts) : '?';
    const n = counts.get(u.id) || 0;
    return `<div class="pick-row"><button class="pick-info" data-act="viewUnit" data-add="1" data-id="${u.id}"><div class="pn">${esc(u.n)}${n ? ` <span class="tag">×${n}</span>` : ''}</div>
      <div class="ps muted">${u.c.length > 1 ? esc(u.c.map((c) => c.d).join(' / ')) : esc(u.c[0]?.d || '')}</div></button>
      <div class="pp">${pts}</div><button class="addbtn" data-act="pickAdd" data-id="${u.id}" aria-label="Add ${esc(u.n)}">＋</button></div>`;
  };
  let html = secs
    .map((sec) => {
      const open = searching || picker.open[sec.key];
      return `<div class="fold ${open ? 'open' : ''}"><button class="fold-h" data-act="pickFold" data-k="${esc(sec.key)}"><span>${esc(sec.title)}${sec.sub ? ` <span class="muted small">· ${esc(sec.sub)}</span>` : ''}</span><span class="muted">${sec.units.length} ${open ? '▾' : '▸'}</span></button>
        ${open ? `<div class="fold-b">${sec.units.sort((a, b) => a.n.localeCompare(b.n)).map(row).join('')}</div>` : ''}</div>`;
    })
    .join('');
  if (!secs.length) html = '<p class="muted center">No matching units.</p>';
  for (const [grp, ids] of locked) {
    html += `<p class="muted small lock">🔒 ${esc(grp)} units unlock with the ${esc(ids.map((id) => f.detById.get(id)?.n).filter(Boolean).join(' or '))} detachment.</p>`;
  }
  return html;
}
function addUnit(id) {
  const l = curList();
  const f = factions.get(l.factionId);
  const u = f.unitById.get(id);
  if (!u) return;
  l.units.push({ uid: uid(), unitId: u.id, name: u.n, cost: 0, enh: '', warlord: false, notes: '', attachTo: '', wg: {}, lastPts: u.c[0]?.pts || 0 });
  touch(l);
  toast(`Added ${u.n}`);
  rerender();
  const r = $('#pickResults');
  if (r) r.innerHTML = pickerResults(f, l);
}

// entry editor — the unit screen: options, wargear and the full datasheet
function eligibleEnh(u, l, f) {
  if (!u || u.epic) return [];
  return f.enhancements.filter((x) => l.detachments.includes(x.det) && (u.enh.length ? u.enh.includes(x.id) : u.character && !x.up));
}
function editEntry(entryUid) {
  const l = curList();
  const f = factions.get(l.factionId);
  showSheet(
    () => {
      const e = l.units.find((x) => x.uid === entryUid);
      if (!e) return '';
      const u = f.unitById.get(e.unitId);
      if (!u) return `${head(e.name)}<div class="sheet-body"><p>This unit is no longer in the data.</p><button class="btn danger block" data-act="removeEntry" data-uid="${e.uid}">Remove</button></div>`;
      const taken = new Set(l.units.filter((x) => x.uid !== e.uid && x.enh).map((x) => x.enh));
      const enhs = eligibleEnh(u, l, f);
      if (e.enh && !enhs.some((x) => x.id === e.enh)) {
        const cur = f.enhById.get(e.enh);
        if (cur) enhs.unshift(cur);
      }
      const hosts = l.units.filter((x) => x.uid !== e.uid && u.leads.includes(x.unitId));
      const auto = entryPts({ ...e, ptsOverride: null }, f, l);
      const co = costOpt(u, e, l);
      const models = entryModels(e, u, l);
      const wg = entryWargear(e, u, l);
      const hostInfo = (h) => {
        const others = l.units.filter((x) => x.attachTo === h.uid && x.uid !== e.uid);
        const lead = others.find((x) => !f.unitById.get(x.unitId)?.sup);
        const sup = others.find((x) => f.unitById.get(x.unitId)?.sup);
        if (!u.sup && lead) return `<span class="warn small">has ${esc(lead.name)}</span>`;
        if (u.sup && sup) return `<span class="warn small">has ${esc(sup.name)}</span>`;
        return `<span class="muted small">${entryPts(h, f, l)} pts</span>`;
      };
      return `${head(e.name)}<div class="sheet-body">
        <div class="row"><div class="big-pts grow">${entryPts(e, f, l)} <span>pts</span></div>${e.warlord ? '<span class="tag big">♛ Warlord</span>' : ''}</div>
        ${co.step ? `<p class="warn small">${esc(co.step)} — this is copy ${copyNo(e, l)} of this datasheet.</p>` : ''}
        ${wg.pts ? `<p class="muted small">Includes wargear: ${wg.lines.map((x) => `${x.n}× ${esc(x.name)} (+${x.each * x.n})`).join(', ')}</p>` : ''}
        ${u.c.length > 1 ? `<label class="lbl">Unit size</label><div class="chips">${u.c.map((c, i) => `<button class="chip ${(e.cost || 0) === i ? 'on' : ''}" data-act="setCost" data-uid="${e.uid}" data-v="${i}">${esc(c.d)} · ${c.pts}</button>`).join('')}</div>` : ''}
        ${u.cx && u.cx.some((b) => !/wargear/i.test(b.label)) ? u.cx.map((b, bi) => (/wargear/i.test(b.label) ? '' : `<label class="lbl">${esc(b.label || 'Options')}</label><div class="chips">${b.rows.map((r, ri) => `<button class="chip ${(e.ex || []).includes(bi + ':' + ri) ? 'on' : ''}" data-act="toggleEx" data-uid="${e.uid}" data-v="${bi}:${ri}">${esc(r.d)} · +${r.pts}</button>`).join('')}</div>`)).join('') : ''}
        ${u.character ? `<label class="toggle"><input type="checkbox" data-act="setWarlord" data-uid="${e.uid}" ${e.warlord ? 'checked' : ''}><span>Warlord</span></label>` : ''}
        ${u.leads.length ? `<label class="lbl">${u.sup ? 'Support — joins a unit even if it has a Leader' : 'Leading'}</label>
          ${hosts.length ? `<div class="enh-list"><button class="enh ${e.attachTo ? '' : 'on'}" data-act="setAttach" data-uid="${e.uid}" data-v="">Not attached</button>${hosts.map((h) => `<button class="enh ${e.attachTo === h.uid ? 'on' : ''}" data-act="setAttach" data-uid="${e.uid}" data-v="${h.uid}"><span>${esc(h.name)}</span>${hostInfo(h)}</button>`).join('')}</div>` : `<p class="muted small">Can join: ${esc(u.leads.map((id) => f.unitById.get(id)?.n).filter(Boolean).join(', ') || '—')}.</p>`}` : ''}
        ${enhs.length || e.enh ? `<label class="lbl">Enhancement</label><div class="enh-list"><button class="enh ${e.enh ? '' : 'on'}" data-act="setEnh" data-uid="${e.uid}" data-v="">None</button>
          ${enhs.map((x) => `<button class="enh ${e.enh === x.id ? 'on' : ''} ${taken.has(x.id) ? 'taken' : ''}" data-act="setEnh" data-uid="${e.uid}" data-v="${x.id}"><span>${esc(x.n)}<span class="muted small"> · ${esc(x.dn)}${taken.has(x.id) ? ' · taken' : ''}</span></span><span class="pts">+${x.pts}</span></button>`).join('')}</div>`
          : u.character && !u.epic && !l.detachments.length ? '<p class="muted small">Choose a detachment to see enhancements.</p>' : ''}
        ${wargearHtml(e, u, wg, models)}
        <details class="adv" ${e.ptsOverride != null && e.ptsOverride !== '' ? 'open' : ''}><summary>Points look wrong? Set them manually</summary>
          <input inputmode="numeric" data-bind="ptsOverride" data-uid="${e.uid}" placeholder="Auto (${auto})" value="${e.ptsOverride ?? ''}"><p class="muted small">Overrides this unit's total until cleared.</p></details>
        <label class="lbl">Notes</label>
        <textarea data-bind="entryNotes" data-uid="${e.uid}" rows="2" placeholder="Anything else to remember">${esc(e.notes)}</textarea>
        <div class="row gap wrap mt"><button class="btn ghost grow" data-act="dupEntry" data-uid="${e.uid}">Duplicate</button><button class="btn danger grow" data-act="removeEntry" data-uid="${e.uid}">Remove</button></div>
        <div class="ds-inline">${datasheet(u, f, wg.parsed ? wg.counts : null)}</div>
      </div>`;
    },
    { tall: true, onClose: () => rerender() }
  );
}

function wargearHtml(e, u, wg, models) {
  if (!wg.opts.length) return '';
  const sel = e.wg || {};
  return `<label class="lbl">Wargear options <span class="muted">· ${models} models</span></label>
  ${wg.opts
    .map((o) => {
      const max = optionMax(o, models);
      const chosen = sel[o.i] || {};
      const used = Object.values(chosen).reduce((a, b) => a + (+b || 0), 0);
      const sMax = starMax(o, models);
      const single = max <= 1 && o.choices.length >= 1;
      return `<div class="wopt"><div class="wopt-t">${rich(o.text)}</div>
        ${o.choices.length ? `<div class="wopt-c">${o.choices
          .map((c, ci) => {
            const n = +chosen[ci] || 0;
            const cap = Math.min(max - used + n, c.star ? sMax : Infinity); // * limits apply to each weapon
            if (single) return `<button class="chip ${n ? 'on' : ''}" data-act="wgPick" data-uid="${e.uid}" data-o="${o.i}" data-c="${ci}">${esc(c.label)}</button>`;
            return `<div class="wrow"><span class="grow">${esc(c.label)}${c.star ? ' <span class="muted small">*</span>' : ''}</span>
              <button class="st-b sm" data-act="wgStep" data-uid="${e.uid}" data-o="${o.i}" data-c="${ci}" data-d="-1" ${n ? '' : 'disabled'}>−</button><b class="wn-n">${n}</b>
              <button class="st-b sm" data-act="wgStep" data-uid="${e.uid}" data-o="${o.i}" data-c="${ci}" data-d="1" ${cap > n ? '' : 'disabled'}>+</button></div>`;
          })
          .join('')}${single ? '' : `<div class="muted small">${used}/${max} used${Number.isFinite(sMax) && o.choices.some((c) => c.star) ? ` · * max ${sMax} of each` : ''}</div>`}</div>` : ''}
      </div>`;
    })
    .join('')}`;
}

// datasheet (counts: Map of weapon name -> number carried, or null to list every profile)
function datasheet(u, f, counts) {
  const ab = (t) => u.ab.filter((a) => a.t === t);
  const named = (a) => {
    const r = a.ref ? f.abilities[a.ref] : a;
    return { n: (r?.n || a.n || '') + (a.p ? ` ${a.p}` : ''), d: r?.d || a.d || '' };
  };
  const chipList = (list) => list.map((a) => named(a)).map((a) => `<details class="rc"><summary>${esc(a.n)}</summary><div>${rich(a.d) || '<span class="muted">—</span>'}</div></details>`).join('');
  const wrow = (w) => `<tr class="${counts && !counts.get(w.n) ? 'dim' : ''}"><td class="wn">${counts && counts.get(w.n) ? `<span class="wcount">${counts.get(w.n)}×</span> ` : ''}${esc(w.n)}${w.k ? `<div class="wkw">${esc(plain(w.k))}</div>` : ''}</td><td>${esc(w.r)}</td><td>${esc(w.A)}</td><td>${esc(w.s)}</td><td>${esc(w.S)}</td><td>${esc(w.AP)}</td><td>${esc(w.D)}</td></tr>`;
  const wt = (kind) => {
    const ws = u.w.filter((w) => w.t === kind);
    if (!ws.length) return '';
    const carried = counts ? ws.filter((w) => counts.get(w.n)) : ws;
    const other = counts ? ws.filter((w) => !counts.get(w.n)) : [];
    const thead = `<thead><tr><th class="wn"></th><th>Range</th><th>A</th><th>${kind === 'ranged' ? 'BS' : 'WS'}</th><th>S</th><th>AP</th><th>D</th></tr></thead>`;
    return `<h3 class="ds-h">${kind === 'ranged' ? '⌖ Ranged weapons' : '⚔ Melee weapons'}</h3>
      ${carried.length ? `<table class="wtab">${thead}<tbody>${carried.map(wrow).join('')}</tbody></table>` : ''}
      ${other.length ? `<details class="others"><summary class="muted small">${other.length} other profile${other.length > 1 ? 's' : ''} (options)</summary><table class="wtab">${thead}<tbody>${other.map(wrow).join('')}</tbody></table></details>` : ''}`;
  };
  const other = u.ab.filter((a) => !['Core', 'Faction', 'Datasheet', 'Wargear'].includes(a.t));
  const leadNames = u.leads.map((id) => f.unitById.get(id)?.n).filter(Boolean);
  const ledBy = u.ledBy.map((id) => f.unitById.get(id)?.n).filter(Boolean);
  return `<div class="ds-kw">${u.kw.map((k) => `<span class="kwchip">${esc(k)}</span>`).join('')}</div>
  <table class="stats"><thead><tr><th></th><th>M</th><th>T</th><th>SV</th><th>W</th><th>LD</th><th>OC</th></tr></thead><tbody>
  ${u.m.map((m) => `<tr><td class="mname">${u.m.length > 1 ? esc(m.n) : ''}</td>${['M', 'T', 'Sv', 'W', 'Ld', 'OC'].map((k) => `<td>${esc(m[k] || '-')}</td>`).join('')}</tr>`).join('')}</tbody></table>
  ${u.m.filter((m) => m.inv).map((m) => `<div class="inv">🛡 Invulnerable save <b>${esc(m.inv)}</b>${u.m.length > 1 ? ` (${esc(m.n)})` : ''}${m.invd ? ` — ${rich(m.invd)}` : ''}</div>`).join('')}
  ${wt('ranged')}${wt('melee')}
  ${ab('Core').length ? `<h3 class="ds-h">Core</h3><div class="rulechips">${chipList(ab('Core'))}</div>` : ''}
  ${ab('Faction').length ? `<h3 class="ds-h">Faction</h3><div class="rulechips">${chipList(ab('Faction'))}</div>` : ''}
  ${ab('Datasheet').length ? `<h3 class="ds-h">Abilities</h3>${ab('Datasheet').map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('')}` : ''}
  ${ab('Wargear').length ? `<h3 class="ds-h">Wargear abilities</h3>${ab('Wargear').map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('')}` : ''}
  ${other.length ? other.map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('') : ''}
  ${u.dmg ? `<div class="rule"><b>Damaged: ${esc(u.dmg.w)} wounds remaining</b><div>${rich(u.dmg.d)}</div></div>` : ''}
  ${leadNames.length || u.lh ? `<h3 class="ds-h">${u.sup ? 'Support' : 'Leader'}</h3><div class="rule">${u.lh ? `<div>${rich(u.lh)}</div>` : ''}${leadNames.length ? `<div>${leadNames.map((n) => `■ ${esc(n)}`).join('<br>')}</div>` : ''}${u.lf ? `<div class="muted small">${rich(u.lf)}</div>` : ''}</div>` : ''}
  ${ledBy.length ? `<p class="small muted">Can be led by: ${esc(ledBy.join(', '))}</p>` : ''}
  ${u.tr ? `<h3 class="ds-h">Transport</h3><div class="rule">${rich(u.tr)}</div>` : ''}
  <h3 class="ds-h">Composition</h3>
  ${u.comp.length ? `<div class="rule">${u.comp.map(rich).join('<br>')}</div>` : ''}
  ${u.load ? `<div class="rule">${rich(u.load)}</div>` : ''}
  ${!counts && u.opt.length ? `<div class="rule"><b>Wargear options</b><ul class="opts">${u.opt.map((o) => `<li>${rich(o)}</li>`).join('')}</ul></div>` : ''}
  <h3 class="ds-h">Points</h3><div class="chips">${u.c.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('') || '<span class="muted">—</span>'}</div>
  ${(u.cx || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>+${c.pts}</b></span>`).join('')}</div>`).join('')}
  ${(u.cs || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('')}</div>`).join('')}
  ${u.mkw.length ? `<p class="muted small">${esc(u.mkw.join(' · '))}</p>` : ''}
  <p class="muted small">Faction keywords: ${esc(u.fkw.join(', '))}${u.src ? ` · Source: ${esc(u.src)}` : ''}</p>
  ${u.link ? `<p class="small"><a href="${esc(u.link)}" target="_blank" rel="noopener">View on Wahapedia ↗</a></p>` : ''}`;
}
function viewUnit(id, canAdd, factionId) {
  const l = curList();
  const f = factions.get(factionId || l?.factionId);
  const u = f && f.unitById.get(id);
  if (!u) return;
  showSheet(() => `${head(u.n)}<div class="sheet-body ds">${datasheet(u, f)}</div>${canAdd && l ? `<div class="sheet-foot"><button class="btn primary block" data-act="pickAdd" data-id="${u.id}" data-close="1">＋ Add to list</button></div>` : ''}`, { tall: true });
}

function listMenu() {
  const l = curList();
  showSheet(() => `${head(l.name)}<div class="sheet-body menu">
    <button data-act="shareText">📋 Share as text</button>
    <button data-act="shareCode">🔗 Share code (for a friend's Muster)</button>
    <button data-act="stratsForList">📜 Stratagems for this list</button>
    <button data-act="renameList">✎ Rename</button>
    <button data-act="editLimits">◎ Battle size & limits</button>
    <button data-act="dupList">⧉ Duplicate list</button>
    <button class="danger-text" data-act="deleteList">🗑 Delete list</button></div>`);
}

function editLimitsSheet() {
  const l = curList();
  showSheet(() => {
    const L = limitsOf(l);
    return `${head('Battle size & limits')}<div class="sheet-body">
      <label class="lbl">Rules from</label>
      <div class="chips">${Object.entries(SIZES).map(([k, s]) => `<button class="chip ${sizeKey(l) === k ? 'on' : ''}" data-act="setSize" data-v="${k}">${s.label}</button>`).join('')}</div>
      <label class="lbl">Points limit</label>
      <input inputmode="numeric" data-bind="limit" data-k="pts" value="${L.pts}">
      <p class="muted small">Any number works — e.g. 1250 using Strike Force rules.</p>
      <details class="adv" ${L.dp !== SIZES[sizeKey(l)].dp || L.enh !== SIZES[sizeKey(l)].enh || L.unit !== SIZES[sizeKey(l)].unit ? 'open' : ''}><summary>Change other limits</summary>
      <div class="grid2 mt">
        <label>Detachment pts<input inputmode="numeric" data-bind="limit" data-k="dp" value="${L.dp}"></label>
        <label>Enhancements<input inputmode="numeric" data-bind="limit" data-k="enh" value="${L.enh}"></label>
        <label>Max per unit<input inputmode="numeric" data-bind="limit" data-k="unit" value="${L.unit}"></label>
      </div></details><p class="muted small">Battleline units can be taken twice the max. Epic Heroes once.</p></div>`;
  }, { onClose: () => rerender() });
}

// ---------------------------------------------------------------- Stratagems
function phaseKeys(ph) {
  const p = (ph || '').toLowerCase();
  if (p.includes('any phase')) return PHASES.map((x) => x.k);
  const out = [];
  if (p.includes('command')) out.push('command');
  if (p.includes('movement') || p.includes('"move"')) out.push('movement');
  if (p.includes('shoot')) out.push('shooting');
  if (p.includes('charge')) out.push('charge');
  if (p.includes('fight')) out.push('fight');
  return out.length ? out : PHASES.map((x) => x.k);
}
function turnKey(t) {
  const s = (t || '').toLowerCase();
  if (s.startsWith('your')) return 'yours';
  if (s.startsWith('opponent')) return 'theirs';
  return 'either';
}

function stratContext() {
  const st = S.strat;
  if (st.side === 'core') return { title: 'Core stratagems', factionId: '', dets: [], core: true };
  if (st.side === 'mine') {
    const l = S.lists.find((x) => x.id === st.listId) || S.lists[0];
    if (!l) return { title: 'My army', none: 'Make an army list first, or switch to Opponent to browse any faction.' };
    st.listId = l.id;
    return { title: l.name, factionId: l.factionId, dets: l.detachments, list: l };
  }
  return { title: 'Opponent', factionId: st.oppFaction, dets: st.oppDets, opp: true };
}

function viewStrats() {
  const st = S.strat;
  const ctx = stratContext();
  const g = activeGame();
  return `<header class="top"><div class="brand"><span class="logo">📜</span> Stratagems</div><div class="grow"></div>${gear}</header>
  <main class="pad">
    <div class="seg">${[['mine', 'Mine'], ['opp', 'Opponent'], ['core', 'Core only']].map(([k, n]) => `<button class="${st.side === k ? 'on' : ''}" data-act="stSide" data-v="${k}">${n}</button>`).join('')}</div>
    <div id="stCtx">${stratCtxHtml(ctx)}</div>
    <input id="stQ" type="search" placeholder="Search stratagems…" value="${esc(st.q)}" autocomplete="off">
    <div class="chips scroll mt"><button class="chip ${st.phase ? '' : 'on'}" data-act="stPhase" data-v="">All phases</button>${PHASES.map((p) => `<button class="chip ${st.phase === p.k ? 'on' : ''}" data-act="stPhase" data-v="${p.k}">${p.label}</button>`).join('')}</div>
    <div class="chips scroll mt"><button class="chip ${st.turn ? '' : 'on'}" data-act="stTurn" data-v="">Any turn</button><button class="chip ${st.turn === 'yours' ? 'on' : ''}" data-act="stTurn" data-v="yours">Your turn</button><button class="chip ${st.turn === 'theirs' ? 'on' : ''}" data-act="stTurn" data-v="theirs">Opponent's turn</button>
      ${st.side !== 'core' ? `<button class="chip ${st.core ? 'on' : ''}" data-act="stCore">+ Core</button><button class="chip ${st.allDets ? 'on' : ''}" data-act="stAll">All detachments</button>` : ''}</div>
    ${g ? `<p class="muted small mt">Game in progress — “Use” spends CP from ${esc(g.players[st.side === 'opp' ? 1 : 0].name)} (${g.players[st.side === 'opp' ? 1 : 0].cp} CP).</p>` : ''}
    <div id="stList" class="mt"><div class="loading">Loading…</div></div>
  </main>`;
}

function stratCtxHtml(ctx) {
  const st = S.strat;
  if (ctx.none) return `<p class="muted">${esc(ctx.none)}</p>`;
  if (st.side === 'mine') {
    return `<select data-bind="stList">${S.lists.map((l) => `<option value="${l.id}" ${l.id === st.listId ? 'selected' : ''}>${esc(l.name)} — ${esc(l.factionName)}</option>`).join('')}</select>`;
  }
  if (st.side === 'opp') {
    const f = factions.get(st.oppFaction);
    return `<button class="card det block-btn" data-act="stOppPick"><div class="muted small">Opponent's army</div><div>${f ? esc(f.n) : '<span class="warn">Choose faction…</span>'}${f && st.oppDets.length ? ' · ' + esc(st.oppDets.map((id) => f.detById.get(id)?.n).filter(Boolean).join(' + ')) : ''}</div></button>`;
  }
  return '';
}

async function hydrateStrats() {
  const el = $('#stList');
  if (!el) return;
  const st = S.strat;
  const ctx = stratContext();
  if (ctx.none) {
    el.innerHTML = '';
    return;
  }
  if (!S.core) S.core = (await data.cachedCore()) || (await data.downloadCore().catch(() => null));
  let f = null;
  if (ctx.factionId) f = await getFaction(ctx.factionId);
  if (ctx.factionId && !f) {
    el.innerHTML = `<div class="empty small"><button class="btn primary" data-act="stDownload" data-id="${ctx.factionId}">Download faction data</button></div>`;
    return;
  }
  if (st.side === 'opp' && !st.oppFaction) {
    el.innerHTML = '<p class="muted center">Choose your opponent’s faction to see their stratagems.</p>';
    return;
  }
  const list = [];
  if (f) {
    for (const s of f.stratagems) {
      if (st.allDets || !s.det || ctx.dets.includes(s.det)) list.push(s);
    }
  }
  if ((st.side === 'core' || st.core) && S.core) list.push(...S.core.stratagems.map((s) => ({ ...s, isCore: true })));
  const q = st.q.toLowerCase();
  const filtered = list.filter((s) => {
    if (st.phase && !phaseKeys(s.ph).includes(st.phase)) return false;
    if (st.turn) {
      const t = turnKey(s.turn);
      if (t !== 'either' && t !== st.turn) return false;
    }
    if (q && !(s.n.toLowerCase().includes(q) || plain(s.d).toLowerCase().includes(q))) return false;
    return true;
  });
  if (!filtered.length) {
    el.innerHTML = `<p class="muted center">${!ctx.dets.length && st.side !== 'core' && !st.allDets ? 'No detachments chosen — tap “All detachments” or pick some.' : 'No stratagems match.'}</p>`;
    return;
  }
  // group by first phase
  const order = (s) => {
    const k = phaseKeys(s.ph);
    return k.length > 1 && k.length === PHASES.length ? 5 : PHASES.findIndex((p) => p.k === k[0]);
  };
  filtered.sort((a, b) => order(a) - order(b) || (a.isCore ? 1 : 0) - (b.isCore ? 1 : 0) || a.n.localeCompare(b.n));
  const g = activeGame();
  let lastGroup = null;
  el.innerHTML = filtered
    .map((s) => {
      const grp = order(s) === 5 ? 'Any phase' : PHASES[order(s)]?.label + ' phase';
      const hdr = grp !== lastGroup ? `<h3 class="sec">${esc(grp)}</h3>` : '';
      lastGroup = grp;
      const open = st.open[s.id];
      const tk = turnKey(s.turn);
      return `${hdr}<div class="strat ${s.isCore ? 'core' : ''} ${open ? 'open' : ''}">
        <button class="st-head" data-act="stToggle" data-id="${esc(s.id)}">
          <div class="st-main"><div class="st-name">${esc(s.n)}</div><div class="st-type">${esc(s.isCore ? s.type || 'Core' : s.dn || s.type)}</div>
          <div class="st-when"><span class="turn ${tk}">${esc(s.turn || '—')}</span> · ${esc(s.ph || '')}</div></div>
          <div class="cp">${esc(s.cp || '–')}<span>CP</span></div></button>
        ${open ? `<div class="st-body">${rich(s.d)}${g && s.cp !== '' ? `<button class="btn small primary mt" data-act="stUse" data-cp="${esc(s.cp)}" data-n="${esc(s.n)}">Use (−${esc(s.cp)} CP)</button>` : ''}</div>` : ''}
      </div>`;
    })
    .join('');
}

async function oppPickSheet() {
  const idx = await ensureIndex();
  const st = S.strat;
  showSheet(
    () => {
      const f = factions.get(st.oppFaction);
      return `${head("Opponent's army")}<div class="sheet-body">
        <label class="lbl">Faction</label>
        <select data-bind="oppFaction"><option value="">Choose…</option>${idx.factions.map((x) => `<option value="${x.id}" ${x.id === st.oppFaction ? 'selected' : ''}>${esc(x.n)}</option>`).join('')}</select>
        ${f ? `<label class="lbl">Their detachments</label>${f.detachments.map((d) => `<button class="frow ${st.oppDets.includes(d.id) ? 'on' : ''}" data-act="oppDet" data-id="${d.id}"><span>${st.oppDets.includes(d.id) ? '✓ ' : ''}${esc(d.n)}</span><span class="muted small">${d.dp} DP</span></button>`).join('')}` : st.oppFaction ? '<p class="muted">Loading…</p>' : ''}
      </div><div class="sheet-foot"><button class="btn primary block" data-act="closeSheet">Done</button></div>`;
    },
    { tall: true, onClose: () => rerender() }
  );
}

// ---------------------------------------------------------------- Battle
const activeGame = () => S.games.find((g) => g.id === S.activeGameId && !g.finished);
function totals(p, caps) {
  const pri = Math.min(caps.primary, p.primary.reduce((a, b) => a + (+b || 0), 0));
  const sec = Math.min(caps.secondary, p.secondary.reduce((a, b) => a + (+b || 0), 0));
  const br = p.battleReady ? caps.battleReady : 0;
  return { pri, sec, br, total: Math.min(caps.total, pri + sec + br) };
}
function stepper(label, value, key) {
  return `<div class="stepper"><span class="st-l">${esc(label)}</span><button class="st-b" data-act="step" data-k="${key}" data-d="-1">−</button><input class="st-v" inputmode="numeric" data-bind="stepVal" data-k="${key}" value="${+value || 0}"><button class="st-b" data-act="step" data-k="${key}" data-d="1">+</button></div>`;
}
function viewBattle() {
  const g = activeGame();
  if (!g) return viewBattleHome();
  const r = g.round;
  const T = g.players.map((p) => totals(p, g.caps));
  const lead = T[0].total === T[1].total ? -1 : T[0].total > T[1].total ? 0 : 1;
  return `<header class="top"><div class="top-title"><div class="tt-name">${esc(g.mission || 'Battle')}</div><div class="tt-sub">Battle round ${r} of 5</div></div><button class="icon" data-act="gameMenu" aria-label="Game options">⋯</button></header>
  <main class="pad battle">
    <div class="rounds">${[1, 2, 3, 4, 5].map((n) => `<button class="rnd ${n === r ? 'on' : ''} ${n < r ? 'done' : ''}" data-act="setRound" data-v="${n}">${n}</button>`).join('')}</div>
    <div class="players">${g.players
      .map((p, i) => `<div class="pcard ${lead === i ? 'lead' : ''}">
        <button class="pc-name" data-act="renamePlayer" data-i="${i}">${esc(p.name)}</button><div class="pc-fac muted">${esc(p.faction || '')}</div>
        <div class="pc-total"><b>${T[i].total}</b><span>VP</span></div><div class="pc-split muted">P ${T[i].pri} · S ${T[i].sec}${p.battleReady ? ` · BR ${T[i].br}` : ''}</div>
        ${stepper('CP', p.cp, `cp:${i}`)}${stepper(`Primary R${r}`, p.primary[r - 1], `pri:${i}`)}${stepper(`Secondary R${r}`, p.secondary[r - 1], `sec:${i}`)}
        <input class="secnote" data-bind="secNote" data-i="${i}" placeholder="Secondaries" value="${esc(p.secNames || '')}">
        <label class="toggle small"><input type="checkbox" data-act="toggleBR" data-i="${i}" ${p.battleReady ? 'checked' : ''}><span>Battle ready (+${g.caps.battleReady})</span></label>
        <div class="pc-links">${p.listId ? `<button class="link" data-act="openPlayerList" data-i="${i}">Army</button>` : ''}<button class="link" data-act="playerStrats" data-i="${i}">Stratagems</button></div>
      </div>`)
      .join('')}</div>
    <div class="row gap"><button class="btn ghost grow" data-act="cpBoth">+1 CP each</button>${r < 5 ? `<button class="btn primary grow" data-act="nextRound">Next round ›</button>` : `<button class="btn primary grow" data-act="endGame">Finish game</button>`}</div>
    ${g.log && g.log.length ? `<h3 class="sec">CP spent</h3><ul class="cplog">${g.log.slice(-8).reverse().map((x) => `<li><span class="muted">R${x.r}</span> ${esc(g.players[x.p].name)}: ${esc(x.n)} <b>−${x.cp}</b></li>`).join('')}</ul>` : ''}
    <h3 class="sec">Scoreboard</h3>
    <table class="score"><thead><tr><th>Rnd</th><th colspan="2">${esc(g.players[0].name)}</th><th colspan="2">${esc(g.players[1].name)}</th></tr><tr class="sub"><th></th><th>Pri</th><th>Sec</th><th>Pri</th><th>Sec</th></tr></thead><tbody>
    ${[0, 1, 2, 3, 4].map((k) => `<tr class="${k === r - 1 ? 'cur' : ''}"><td>${k + 1}</td><td>${g.players[0].primary[k] || 0}</td><td>${g.players[0].secondary[k] || 0}</td><td>${g.players[1].primary[k] || 0}</td><td>${g.players[1].secondary[k] || 0}</td></tr>`).join('')}
    <tr class="tot"><td>Σ</td><td>${T[0].pri}</td><td>${T[0].sec}</td><td>${T[1].pri}</td><td>${T[1].sec}</td></tr></tbody></table>
    <p class="muted small center">Caps: primary ${g.caps.primary}, secondary ${g.caps.secondary}, total ${g.caps.total} — change in ⚙ Settings.</p>
  </main>`;
}
function viewBattleHome() {
  const past = S.games.filter((g) => g.finished).sort((a, b) => b.created - a.created);
  return `<header class="top"><div class="brand"><span class="logo">⚔</span> Battle</div><div class="grow"></div>${gear}</header><main class="pad">
    <button class="btn primary block" data-act="newGame">＋ Start a new game</button>
    ${past.length ? `<h3 class="sec">Past games</h3><div class="stack">${past.map((g) => {
      const t = g.players.map((p) => totals(p, g.caps).total);
      return `<button class="card list-card" data-act="viewGame" data-id="${g.id}"><div class="lc-main"><div class="lc-name">${esc(g.players[0].name)} vs ${esc(g.players[1].name)}</div><div class="lc-sub">${esc(g.mission || 'Battle')} · ${fmtDate(new Date(g.created).toISOString())}</div><div class="lc-sub">${t[0] === t[1] ? 'Draw' : esc(g.players[t[0] > t[1] ? 0 : 1].name) + ' won'}</div></div><div class="lc-pts"><b>${t[0]}–${t[1]}</b></div></button>`;
    }).join('')}</div>` : `<div class="empty"><div class="empty-ico">🎲</div><p class="muted">Track VP, CP and secondaries round by round. Stratagems you use from the Stratagems tab deduct CP here.</p></div>`}
  </main>`;
}
async function newGameSheet() {
  const idx = await ensureIndex().catch(() => null);
  showSheet(
    () => `${head('New game')}<div class="sheet-body">
      <label class="lbl">Mission</label><input id="ngMission" placeholder="e.g. Take and Hold">
      <label class="lbl">You</label><input id="ngName0" value="Me">
      <select id="ngList0"><option value="">No list</option>${S.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${esc(l.factionName)})</option>`).join('')}</select>
      <label class="lbl">Opponent</label><input id="ngName1" value="Opponent">
      <select id="ngList1"><option value="">Their list isn't on this phone</option>${S.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${esc(l.factionName)})</option>`).join('')}</select>
      ${idx ? `<select id="ngFac1"><option value="">Opponent faction (for stratagems)…</option>${idx.factions.map((x) => `<option value="${x.id}">${esc(x.n)}</option>`).join('')}</select>` : ''}
    </div><div class="sheet-foot"><button class="btn primary block" data-act="ngStart">Start game</button></div>`,
    { tall: true }
  );
}
function startGame() {
  const g = { id: uid(), created: Date.now(), mission: $('#ngMission').value.trim(), round: 1, finished: false, caps: { ...S.settings.caps }, log: [], players: [] };
  for (const i of [0, 1]) {
    const listId = $('#ngList' + i).value;
    const l = S.lists.find((x) => x.id === listId);
    const fac = i === 1 && !l ? $('#ngFac1')?.value || '' : l?.factionId || '';
    const facName = l ? l.factionName : S.index?.factions.find((x) => x.id === fac)?.n || '';
    g.players.push({ name: $('#ngName' + i).value.trim() || `Player ${i + 1}`, listId, factionId: fac, faction: facName, cp: 0, battleReady: false, primary: [0, 0, 0, 0, 0], secondary: [0, 0, 0, 0, 0], secNames: '' });
  }
  S.games.push(g);
  S.activeGameId = g.id;
  // point the stratagem tab at this game
  if (g.players[0].listId) S.strat.listId = g.players[0].listId;
  const oppList = S.lists.find((x) => x.id === g.players[1].listId);
  if (oppList) {
    S.strat.oppFaction = oppList.factionId;
    S.strat.oppDets = [...oppList.detachments];
  } else if (g.players[1].factionId) {
    S.strat.oppFaction = g.players[1].factionId;
    S.strat.oppDets = [];
  }
  save();
  closeAllSheets();
  render();
}
function gameSummary(g) {
  const t = g.players.map((p) => totals(p, g.caps));
  return [`${g.mission || 'Battle'} — ${fmtDate(new Date(g.created).toISOString())}`, ...g.players.map((p, i) => `${p.name}${p.faction ? ' (' + p.faction + ')' : ''}: ${t[i].total} VP (Primary ${t[i].pri}, Secondary ${t[i].sec}${p.battleReady ? ', Battle ready ' + t[i].br : ''})`), '', 'Round by round (Pri/Sec):', ...[0, 1, 2, 3, 4].map((k) => `R${k + 1}: ${g.players.map((p) => `${p.primary[k] || 0}/${p.secondary[k] || 0}`).join('  vs  ')}`)].join('\n');
}

// ---------------------------------------------------------------- Settings
function settingsSheet() {
  showSheet(
    () => {
      const c = S.settings.caps;
      const idx = S.index;
      const names = (id) => idx?.factions.find((x) => x.id === id)?.n || id;
      return `${head('Settings')}<div class="sheet-body">
      <h3 class="sec flush">Game data</h3>
      <p class="small">${idx ? `Data built <b>${fmtDate(idx.built)}</b>${idx.wahapediaUpdate ? ` (Wahapedia updated ${esc(idx.wahapediaUpdate)})` : ''}.` : 'No data downloaded yet.'} The site refreshes it every night.</p>
      <button class="btn primary block" data-act="updateData">↻ Update data on this phone</button>
      <div class="stack tight">${S.cached.map((id) => `<div class="dl-row"><span>${esc(names(id))}</span><button class="icon small" data-act="removeFaction" data-id="${id}" aria-label="Remove">✕</button></div>`).join('') || '<p class="muted small">No factions saved yet.</p>'}</div>
      <h3 class="sec">Scoring caps</h3>
      <div class="grid2"><label>Primary<input inputmode="numeric" data-bind="cap" data-k="primary" value="${c.primary}"></label><label>Secondary<input inputmode="numeric" data-bind="cap" data-k="secondary" value="${c.secondary}"></label>
      <label>Battle ready<input inputmode="numeric" data-bind="cap" data-k="battleReady" value="${c.battleReady}"></label><label>Total<input inputmode="numeric" data-bind="cap" data-k="total" value="${c.total}"></label></div>
      <h3 class="sec">Backup</h3><p class="muted small">Lists and games live only on this phone.</p>
      <div class="row gap"><button class="btn ghost grow" data-act="exportBackup">Export</button><label class="btn ghost grow filebtn">Import<input type="file" accept=".json,application/json" data-bind="importBackup" hidden></label></div>
      <p class="muted small center about">Data powered by <a href="https://wahapedia.ru" target="_blank" rel="noopener">Wahapedia</a>. Muster is an unofficial fan tool for personal use, not affiliated with Games Workshop. Check important rules against your official sources.</p>
    </div>`;
    },
    { tall: true }
  );
}

async function updateData() {
  const results = [];
  try {
    showBusy('Checking for new data…');
    S.index = await data.fetchIndex();
    S.core = await data.downloadCore().catch(() => S.core);
    for (const id of S.cached) {
      showBusy(`Updating ${S.index.factions.find((x) => x.id === id)?.n || id}…`);
      const old = await getFaction(id);
      const nf = await data.downloadFaction(id, S.index.built);
      factions.set(id, nf);
      results.push({ name: nf.n, changes: data.diffPoints(old, nf) });
    }
  } catch (e) {
    toast(e.message);
  } finally {
    hideBusy();
  }
  closeAllSheets();
  rerender();
  const n = results.reduce((t, r) => t + r.changes.length, 0);
  showSheet(() => `${head('Data updated')}<div class="sheet-body">${n ? results.filter((r) => r.changes.length).map((r) => `<h3 class="sec">${esc(r.name)}</h3><ul class="changes">${r.changes.map((c) => `<li>${esc(c.name)}: ${c.kind === 'new' ? `<span class="tag">new</span> ${esc(c.to)}` : `${esc(c.from)} → <b>${esc(c.to)}</b>`}</li>`).join('')}</ul>`).join('') : '<p>No points changes since your last update.</p>'}<p class="muted small">Your lists use the new values automatically.</p></div>`, { tall: n > 8 });
}

async function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'muster', v: 2, exported: new Date().toISOString(), lists: S.lists, games: S.games, settings: S.settings }, null, 1)], { type: 'application/json' });
  const name = `muster-backup-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) return await navigator.share({ files: [file], title: 'Muster backup' });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}
async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'muster') throw new Error();
    if (!(await confirmBox(`Import ${plural(d.lists?.length || 0, 'list')} and ${plural(d.games?.length || 0, 'game')}?`, 'Import'))) return;
    const merge = (cur, inc) => {
      const m = new Map(cur.map((x) => [x.id, x]));
      for (const x of inc || []) if (x.factionId || !x.factionFile) m.set(x.id, x);
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

// ================================================================= actions
const entryOf = (el) => curList().units.find((x) => x.uid === el.dataset.uid);
const A = {
  closeSheet: () => closeSheet(),
  confirmYes: () => confirmResolve?.(true),
  confirmNo: () => confirmResolve?.(false),
  promptOk: () => promptResolve?.($('#promptInput').value),
  tab: (el) => {
    S.tab = el.dataset.tab;
    closeAllSheets();
    render();
  },
  settings: () => settingsSheet(),
  install: async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    rerender();
  },
  // lists
  newList: () => newListFlow().catch((e) => toast(e.message)),
  nlSize: (el) => {
    keepDraftName();
    if (newDraft.pts === SIZES[newDraft.size].pts) newDraft.pts = null;
    newDraft.size = el.dataset.v;
    rerenderTopSheet();
  },
  nlFaction: (el) => {
    keepDraftName();
    newDraft.faction = el.dataset.id;
    rerenderTopSheet();
  },
  nlCreate: () => createList(),
  openList: (el) => {
    S.openListId = el.dataset.id;
    render();
  },
  backToLists: () => {
    S.openListId = null;
    render();
  },
  downloadForList: async () => {
    try {
      await ensureFaction(curList().factionId);
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
  importList: async () => {
    const code = await promptBox('Import list code', '', { placeholder: 'Paste a MUSTER2:… code', multiline: true, ok: 'Import' });
    if (!code) return;
    let d;
    try {
      d = decodeList(code);
    } catch {
      return toast("That isn't a Muster list code");
    }
    let f;
    try {
      f = await ensureFaction(d.f);
    } catch (e) {
      return toast(e.message);
    }
    const map = new Map();
    const units = d.u.map(([unitId, cost, enh, wl, notes, name, po, oldUid, attachTo, ex, wg]) => {
      const nu = uid();
      map.set(oldUid, nu);
      return { uid: nu, unitId, cost, enh, warlord: !!wl, notes, ptsOverride: po ?? null, attachTo, ex: ex || [], wg: wg || {}, name: f.unitById.get(unitId)?.n || name, lastPts: 0 };
    });
    units.forEach((e) => (e.attachTo = map.get(e.attachTo) || ''));
    const l = { id: uid(), name: d.n || 'Imported list', factionId: d.f, factionName: f.n, size: d.s || 'strike', limits: d.L || { ...SIZES.strike }, detachments: d.d || [], disposition: d.fd || '', units, created: Date.now(), updated: Date.now() };
    S.lists.push(l);
    await save('lists');
    S.tab = 'army';
    S.openListId = l.id;
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
  editLimits: () => {
    closeAllSheets();
    editLimitsSheet();
  },
  setSize: (el) => {
    const l = curList();
    l.size = el.dataset.v;
    const pts = limitsOf(l).pts;
    l.limits = { ...SIZES[l.size], pts };
    delete l.limits.label;
    touch(l);
    rerenderTopSheet();
  },
  dupList: () => {
    const l = curList();
    const c = JSON.parse(JSON.stringify(l));
    const map = new Map();
    c.id = uid();
    c.name = l.name + ' (copy)';
    c.created = c.updated = Date.now();
    c.units.forEach((e) => {
      const n = uid();
      map.set(e.uid, n);
      e.uid = n;
    });
    c.units.forEach((e) => (e.attachTo = map.get(e.attachTo) || ''));
    S.lists.push(c);
    save('lists');
    closeAllSheets();
    S.openListId = c.id;
    render();
  },
  deleteList: async () => {
    const l = curList();
    closeAllSheets();
    if (!(await confirmBox(`Delete “${l.name}”?`, 'Delete', true))) return;
    S.lists = S.lists.filter((x) => x.id !== l.id);
    await save('lists');
    S.openListId = null;
    render();
  },
  shareText: () => {
    const l = curList();
    shareText(l.name, listAsText(l, factions.get(l.factionId)));
  },
  shareCode: () => {
    const l = curList();
    shareText(l.name, encodeList(l));
  },
  stratsForList: () => {
    S.strat.side = 'mine';
    S.strat.listId = curList().id;
    S.tab = 'strats';
    closeAllSheets();
    render();
  },
  toggleIssues: () => {
    S.showIssues = !S.showIssues;
    rerender();
  },
  pickDetachments: () => pickDetachments(),
  detOpen: (el) => detOpenHandler?.(el.dataset.id),
  detToggle: (el) => {
    const l = curList();
    const id = el.dataset.id;
    l.detachments = l.detachments.includes(id) ? l.detachments.filter((x) => x !== id) : [...l.detachments, id];
    const f = factions.get(l.factionId);
    const disp = dispositionsOf(l, f);
    if (l.disposition && !disp.includes(l.disposition)) l.disposition = '';
    if (!l.disposition && disp.length === 1) l.disposition = disp[0];
    touch(l);
    rerenderTopSheet();
  },
  pickDisposition: () => pickDisposition(),
  setDisposition: (el) => {
    const l = curList();
    l.disposition = el.dataset.v;
    touch(l);
    closeSheet();
    rerender();
  },
  armyRules: () => {
    const f = factions.get(curList().factionId);
    showSheet(() => `${head('Army rule')}<div class="sheet-body">${f.armyRules.map((r) => `<div class="rule"><b>${esc(r.n)}</b><div>${rich(r.d)}</div></div>`).join('')}</div>`, { tall: true });
  },
  addUnit: () => addUnitSheet(),
  pickFold: (el) => {
    picker.open[el.dataset.k] = !picker.open[el.dataset.k];
    const l = curList();
    $('#pickResults').innerHTML = pickerResults(factions.get(l.factionId), l);
  },
  toggleLegends: (el) => {
    S.settings.showLegends = el.checked;
    save('settings');
    const l = curList();
    $('#pickResults').innerHTML = pickerResults(factions.get(l.factionId), l);
  },
  listFold: (el) => {
    S.foldList = S.foldList || {};
    S.foldList[el.dataset.k] = !S.foldList[el.dataset.k];
    rerender();
  },
  wgStep: (el) => {
    const e = entryOf(el);
    const o = el.dataset.o;
    const c = el.dataset.c;
    e.wg = e.wg || {};
    e.wg[o] = e.wg[o] || {};
    e.wg[o][c] = Math.max(0, (+e.wg[o][c] || 0) + +el.dataset.d);
    touch(curList());
    rerenderTopSheet();
  },
  wgPick: (el) => {
    const e = entryOf(el);
    const o = el.dataset.o;
    const c = el.dataset.c;
    e.wg = e.wg || {};
    const was = e.wg[o]?.[c];
    e.wg[o] = was ? {} : { [c]: 1 };
    touch(curList());
    rerenderTopSheet();
  },
  pickAdd: (el) => {
    addUnit(el.dataset.id);
    if (el.dataset.close) closeSheet();
  },
  viewUnit: (el) => viewUnit(el.dataset.id, !!el.dataset.add),
  editEntry: (el) => editEntry(el.dataset.uid),
  setCost: (el) => {
    const e = entryOf(el);
    e.cost = +el.dataset.v;
    e.lastPts = entryPts(e, factions.get(curList().factionId), curList());
    touch(curList());
    rerenderTopSheet();
  },
  setWarlord: (el) => {
    const l = curList();
    for (const x of l.units) x.warlord = x.uid === el.dataset.uid ? el.checked : false;
    touch(l);
    rerenderTopSheet();
  },
  setEnh: (el) => {
    const e = entryOf(el);
    e.enh = el.dataset.v;
    e.lastPts = entryPts(e, factions.get(curList().factionId), curList());
    touch(curList());
    rerenderTopSheet();
  },
  setAttach: (el) => {
    const e = entryOf(el);
    e.attachTo = el.dataset.v;
    touch(curList());
    rerenderTopSheet();
  },
  toggleEx: (el) => {
    const e = entryOf(el);
    const v = el.dataset.v;
    e.ex = (e.ex || []).includes(v) ? e.ex.filter((x) => x !== v) : [...(e.ex || []), v];
    touch(curList());
    rerenderTopSheet();
  },
  dupEntry: (el) => {
    const l = curList();
    const e = entryOf(el);
    l.units.splice(l.units.indexOf(e) + 1, 0, { ...e, uid: uid(), warlord: false, enh: '', attachTo: '' });
    touch(l);
    closeSheet();
  },
  removeEntry: (el) => {
    const l = curList();
    const id = el.dataset.uid;
    l.units = l.units.filter((x) => x.uid !== id);
    l.units.forEach((x) => x.attachTo === id && (x.attachTo = ''));
    touch(l);
    closeSheet();
  },
  // stratagems
  stSide: (el) => {
    S.strat.side = el.dataset.v;
    save('settings');
    render();
  },
  stPhase: (el) => {
    S.strat.phase = el.dataset.v;
    rerender();
  },
  stTurn: (el) => {
    S.strat.turn = el.dataset.v;
    rerender();
  },
  stCore: () => {
    S.strat.core = !S.strat.core;
    save('settings');
    rerender();
  },
  stAll: () => {
    S.strat.allDets = !S.strat.allDets;
    rerender();
  },
  stToggle: (el) => {
    S.strat.open[el.dataset.id] = !S.strat.open[el.dataset.id];
    keepScroll = true;
    hydrateStrats();
  },
  stOppPick: () => oppPickSheet(),
  oppDet: (el) => {
    const st = S.strat;
    const id = el.dataset.id;
    st.oppDets = st.oppDets.includes(id) ? st.oppDets.filter((x) => x !== id) : [...st.oppDets, id];
    save('settings');
    rerenderTopSheet();
  },
  stDownload: async (el) => {
    try {
      await ensureFaction(el.dataset.id);
    } catch (e) {
      toast(e.message);
    }
    rerender();
  },
  stUse: (el) => {
    const g = activeGame();
    if (!g) return;
    const p = S.strat.side === 'opp' ? 1 : 0;
    const cp = parseInt(el.dataset.cp, 10) || 0;
    if (g.players[p].cp < cp) return toast(`${g.players[p].name} only has ${g.players[p].cp} CP`);
    g.players[p].cp -= cp;
    (g.log ||= []).push({ r: g.round, p, n: el.dataset.n, cp });
    save('games');
    toast(`${el.dataset.n}: −${cp} CP (${g.players[p].cp} left)`);
    rerender();
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
  },
  toggleBR: (el) => {
    activeGame().players[+el.dataset.i].battleReady = el.checked;
    save('games');
    rerender();
  },
  renamePlayer: async (el) => {
    const p = activeGame().players[+el.dataset.i];
    const v = await promptBox('Player name', p.name);
    if (v && v.trim()) {
      p.name = v.trim();
      save('games');
      rerender();
    }
  },
  openPlayerList: (el) => {
    const id = activeGame().players[+el.dataset.i].listId;
    if (!S.lists.some((l) => l.id === id)) return toast('That list was deleted');
    S.tab = 'army';
    S.openListId = id;
    render();
  },
  playerStrats: (el) => {
    const i = +el.dataset.i;
    const p = activeGame().players[i];
    if (i === 0) {
      S.strat.side = 'mine';
      if (p.listId) S.strat.listId = p.listId;
    } else {
      S.strat.side = 'opp';
      const l = S.lists.find((x) => x.id === p.listId);
      if (l) {
        S.strat.oppFaction = l.factionId;
        S.strat.oppDets = [...l.detachments];
      } else if (p.factionId) S.strat.oppFaction = p.factionId;
    }
    S.tab = 'strats';
    render();
  },
  gameMenu: () => showSheet(() => `${head('Game')}<div class="sheet-body menu"><button data-act="renameMission">✎ Mission name</button><button data-act="shareGame">📋 Share result</button><button data-act="endGame">🏁 Finish game</button><button class="danger-text" data-act="abandonGame">🗑 Discard game</button></div>`),
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
    A.viewGame({ dataset: { id: g.id } });
  },
  abandonGame: async () => {
    closeAllSheets();
    if (!(await confirmBox('Discard this game?', 'Discard', true))) return;
    S.games = S.games.filter((x) => x.id !== S.activeGameId);
    S.activeGameId = null;
    await save();
    render();
  },
  viewGame: (el) => {
    const g = S.games.find((x) => x.id === el.dataset.id);
    if (!g) return;
    showSheet(() => `${head(`${g.players[0].name} vs ${g.players[1].name}`)}<div class="sheet-body"><pre class="summary">${esc(gameSummary(g))}</pre><div class="row gap"><button class="btn ghost grow" data-act="reopenGame" data-id="${g.id}">Reopen</button><button class="btn ghost grow" data-act="copyGame" data-id="${g.id}">Copy</button><button class="btn danger grow" data-act="deleteGame" data-id="${g.id}">Delete</button></div></div>`);
  },
  reopenGame: (el) => {
    if (activeGame()) return toast('Finish your current game first');
    const g = S.games.find((x) => x.id === el.dataset.id);
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
  // settings
  updateData: () => updateData(),
  removeFaction: async (el) => {
    const id = el.dataset.id;
    const used = S.lists.filter((l) => l.factionId === id).length;
    if (!(await confirmBox(`Remove this faction's data from the phone?${used ? ` ${plural(used, 'list')} will need it re-downloaded.` : ''}`, 'Remove', true))) return;
    await data.removeFaction(id);
    factions.delete(id);
    S.cached = await data.cachedFactionIds();
    rerenderTopSheet();
  },
  exportBackup: () => exportBackup(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !el.dataset.act) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return;
  const fn = A[el.dataset.act];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.matches('input[type=checkbox][data-act]')) return A[el.dataset.act]?.(el, e);
  const b = el.dataset?.bind;
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
  if (b === 'cap') {
    S.settings.caps[el.dataset.k] = Math.max(0, parseInt(el.value, 10) || 0);
    save('settings');
  }
  if (b === 'limit') {
    const l = curList();
    l.limits = { ...limitsOf(l), [el.dataset.k]: Math.max(0, parseInt(el.value, 10) || 0) };
    touch(l);
    rerenderTopSheet();
  }
  if (b === 'ptsOverride') {
    const ent = entryOf(el);
    ent.ptsOverride = el.value.trim() === '' ? null : Math.max(0, parseInt(el.value, 10) || 0);
    touch(curList());
    rerenderTopSheet();
  }
  if (b === 'stList') {
    S.strat.listId = el.value;
    save('settings');
    rerender();
  }
  if (b === 'oppFaction') {
    S.strat.oppFaction = el.value;
    S.strat.oppDets = [];
    save('settings');
    rerenderTopSheet();
    if (el.value) {
      try {
        await ensureFaction(el.value);
      } catch (err) {
        toast(err.message);
      }
      rerenderTopSheet();
    }
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'pickQ') {
    picker.q = el.value;
    const l = curList();
    $('#pickResults').innerHTML = pickerResults(factions.get(l.factionId), l);
    return;
  }
  if (el.id === 'stQ') {
    S.strat.q = el.value;
    hydrateStrats();
    return;
  }
  const b = el.dataset?.bind;
  if (b === 'entryNotes') {
    entryOf(el).notes = el.value;
    touch(curList());
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
  if (S.tab === 'army' && !S.openListId) rerender();
});

// ================================================================= boot
async function boot() {
  const [lists, games, settings, idx, core] = await Promise.all([store.get('kv', 'lists'), store.get('kv', 'games'), store.get('kv', 'settings'), data.cachedIndex(), data.cachedCore()]);
  // lists from the old 10th edition version can't be read by this one
  S.lists = (lists || []).filter((l) => l.factionId);
  S.games = games || [];
  if (settings) {
    S.activeGameId = settings.activeGameId || null;
    S.settings = { ...S.settings, showLegends: !!settings.showLegends, caps: { ...S.settings.caps, ...(settings.caps || {}) } };
    if (settings.strat) S.strat = { ...S.strat, ...settings.strat, open: {}, q: '' };
  }
  S.index = idx || null;
  S.core = core || null;
  S.cached = await data.cachedFactionIds();
  for (const l of S.lists) await getFaction(l.factionId);
  if (S.strat.oppFaction) await getFaction(S.strat.oppFaction);
  if (activeGame()) S.tab = 'battle';
  render();
  store.requestPersistence();
  // refresh the faction index quietly in the background
  // when the site has newer data than this phone (monthly), refresh saved factions quietly
  data
    .fetchIndex()
    .then(async (i) => {
      S.index = i;
      let changed = false;
      for (const id of S.cached) {
        const f = await getFaction(id);
        if (f && f.built !== i.built) {
          const nf = await data.downloadFaction(id, i.built);
          factions.set(id, nf);
          changed = true;
        }
      }
      if (changed) {
        S.core = await data.downloadCore().catch(() => S.core);
        toast('Game data updated');
        rerender();
      }
    })
    .catch(() => {});
}
boot().catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<div class="pad"><p>Muster couldn't start: ${esc(e.message)}</p></div>`;
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});

window.__muster = { S, factions, validate, listPts, listDp, encodeList, decodeList };

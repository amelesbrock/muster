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
    caps: { primary: 50, secondary: 45, secondaryRound: 15, battleReady: 10, total: 100 },
    showLegends: false,
  },
  strat: { side: 'mine', listId: '', oppFaction: '', oppDets: [], allDets: false, core: true, phase: '', turn: '', q: '', open: {} },
  showIssues: true,
  collection: {}, // { [datasheet name key]: { n: models owned, note } }
  collView: null, // { factionId, q, open: {} } while the collection screen is open
  pickOwned: false,
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
        if (/hi_custom/.test(cls)) c.setAttribute('class', 'subh');
        if (/redExample|blackComment/.test(cls)) c.setAttribute('class', 'callout');
        const keep = cls.split(/\s+/).filter((x) => /^caPm\w+$/.test(x));
        if (keep.length) c.setAttribute('class', keep.join(' '));
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
  if (!what || what === 'collection') await store.set('kv', 'collection', S.collection);
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
    if (!S.missions) S.missions = await data.downloadMissions().catch(() => null);
    return nf;
  } finally {
    hideBusy();
  }
}

// ================================================================= list maths
const ROLE_ORDER = ['Attached units', 'Epic Hero', 'Character', 'Battleline', 'Infantry', 'Mounted', 'Monster', 'Vehicle', 'Dedicated Transport', 'Fortification', 'Other'];
// Slimmed-down sections: characters first, then by battlefield role.
// Vehicles with a transport capacity stay Vehicles; only true Dedicated Transports get their own section.
function roleGroup(u) {
  if (!u) return 'Other';
  const r = (u.role || '').toLowerCase();
  const kw = u.kw.map((k) => k.toLowerCase());
  if (u.epic || r.includes('epic hero')) return 'Epic Hero';
  if (u.character || r.includes('character')) return 'Character';
  if (u.battleline || r === 'battleline') return 'Battleline';
  if (u.dt || r.startsWith('dedicated')) return 'Dedicated Transport';
  if (r.startsWith('fortification') || kw.includes('fortification')) return 'Fortification';
  if (kw.includes('monster') || r.startsWith('monster')) return 'Monster';
  if (/vehicle|walker|transport|aircraft|titanic|artillery/.test(r) || kw.includes('vehicle')) return 'Vehicle';
  if (/mounted|beast|cavalry/.test(r) || kw.includes('mounted')) return 'Mounted';
  if (/infantry|swarm/.test(r) || kw.includes('infantry')) return 'Infantry';
  return 'Other';
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
  for (const w of collectionShortfalls(l, f)) out.push({ level: 'warn', msg: w });
  for (const e of l.units) if (!f.unitById.get(e.unitId)) out.push({ level: 'warn', msg: `${e.name} is no longer in the data (kept at ${e.lastPts || 0} pts).` });
  return out;
}

function dispositionsOf(l, f) {
  const s = new Set();
  for (const id of l.detachments || []) for (const d of f.detById.get(id)?.fd || []) s.add(d);
  return [...s];
}

// Entries ordered by role, with attached characters directly after their bodyguard
// Sections of the list. Each item is either one entry, or a linked group:
// a bodyguard unit with the Leader/Support characters attached to it, shown side by side.
function groupEntries(l, f) {
  const linked = new Map();
  for (const e of l.units) {
    if (e.attachTo && l.units.some((x) => x.uid === e.attachTo)) {
      if (!linked.has(e.attachTo)) linked.set(e.attachTo, []);
      linked.get(e.attachTo).push(e);
    }
  }
  const groups = new Map();
  const put = (role, item) => {
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(item);
  };
  for (const e of l.units) {
    if (e.attachTo && l.units.some((x) => x.uid === e.attachTo)) continue;
    if (linked.has(e.uid)) put('Attached units', { members: [...linked.get(e.uid), e] });
    else put(roleGroup(f && f.unitById.get(e.unitId)), { members: [e] });
  }
  return [...groups.entries()].sort((a, b) => roleRank(a[0]) - roleRank(b[0]));
}
const itemPts = (it, f, l) => it.members.reduce((t, e) => t + entryPts(e, f, l), 0);

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
  for (const [role, items] of groupEntries(l, f)) {
    lines.push(role.toUpperCase());
    for (const it of items) {
      if (it.members.length > 1) lines.push(`🔗 ${it.members.map((e) => e.name).join(' + ')} — ${itemPts(it, f, l)} pts`);
      for (const e of it.members) {
        const u = f.unitById.get(e.unitId);
        const en = e.enh && f.enhById.get(e.enh);
        const bits = [];
        if (u && u.c.length > 1) bits.push(costOpt(u, e, l).d);
        if (e.warlord) bits.push('Warlord');
        if (en) bits.push(`${en.n} +${en.pts}`);
        lines.push(`${it.members.length > 1 ? '   • ' : '• '}${e.name}${bits.length ? ' [' + bits.join(', ') + ']' : ''} — ${entryPts(e, f, l)} pts`);
        const ws = u ? wargearSummary(e, u, l) : '';
        if (ws) lines.push(`     ${ws}`);
        if (e.notes) lines.push(`     ${e.notes.replace(/\n/g, '; ')}`);
      }
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
// ---- collection: boxes owned per datasheet, each box being the datasheet's smallest unit size
// (keyed by name, so a unit counts in every army it appears in). Boxes combine into bigger units:
// two boxes of 5 Acolytes make one unit of 10.
const ckey = (name) => String(name || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
function blockSize(u) {
  const sizes = u.c.map((x) => x.models).filter(Boolean);
  return sizes.length ? Math.min(...sizes) : 1;
}
function blocksOwned(u) {
  const c = S.collection[ckey(u.n)];
  if (!c) return 0;
  if (c.b == null && c.n) c.b = Math.ceil(c.n / blockSize(u)); // older saves counted models
  return c.b || 0;
}
const owned = (u) => blocksOwned(u) * blockSize(u);
const hasCollection = () => Object.values(S.collection).some((x) => (x.b ?? x.n) > 0);
const blocksFor = (u, models) => Math.ceil(models / blockSize(u));
// boxes still available for this entry (owned minus those used by other entries)
function freeBlocks(u, e, l, f) {
  let usedElsewhere = 0;
  for (const x of l.units) {
    if (x.uid === e.uid) continue;
    const ux = f.unitById.get(x.unitId);
    if (ux && ckey(ux.n) === ckey(u.n)) usedElsewhere += blocksFor(ux, entryModels(x, ux, l));
  }
  return Math.max(0, blocksOwned(u) - usedElsewhere);
}
// boxes each datasheet uses in a list
function blocksUsed(l, f) {
  const used = new Map();
  for (const e of l.units) {
    const u = f.unitById.get(e.unitId);
    if (!u) continue;
    used.set(ckey(u.n), (used.get(ckey(u.n)) || 0) + blocksFor(u, entryModels(e, u, l)));
  }
  return used;
}
function collectionShortfalls(l, f) {
  if (!hasCollection()) return [];
  const out = [];
  for (const [k, n] of blocksUsed(l, f)) {
    const e = l.units.find((x) => ckey(f.unitById.get(x.unitId)?.n) === k);
    const u = e && f.unitById.get(e.unitId);
    if (!u) continue;
    const have = blocksOwned(u);
    const bs = blockSize(u);
    if (n > have) out.push(have ? `${u.n}: list needs ${n}×${bs}, you own ${have}×${bs}.` : `${u.n}: not in your collection.`);
  }
  return out;
}

// ---- phone Back button: mirror the app's screens in browser history ----
// depth = open sheets + an open list + being on a tab other than Army
let histDepth = 0;
let ignorePops = 0;
const navDepth = () => sheets.length + (S.tab === 'army' && (S.openListId || S.collView) ? 1 : 0) + (S.tab !== 'army' ? 1 : 0);
function syncHistory() {
  const d = navDepth();
  if (d > histDepth) {
    for (let i = histDepth; i < d; i++) history.pushState({ muster: i + 1 }, '');
    histDepth = d;
  } else if (d < histDepth) {
    ignorePops++;
    history.go(d - histDepth);
    histDepth = d;
  }
}
window.addEventListener('popstate', () => {
  if (ignorePops > 0) {
    ignorePops--;
    return;
  }
  histDepth = Math.max(0, histDepth - 1);
  if (sheets.length) {
    const top = sheets[sheets.length - 1];
    if (top.opts.onBack) top.opts.onBack();
    else closeSheet();
  } else if (S.tab === 'army' && S.collView) {
    S.collView = null;
    render();
  } else if (S.tab === 'army' && S.openListId) {
    S.openListId = null;
    S.reorder = false;
    render();
  } else if (S.tab !== 'army') {
    S.tab = 'army';
    render();
  }
  syncHistory();
});

function renderSheets() {
  setTimeout(syncHistory, 0);
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
  if (S.tab === 'army') v.innerHTML = S.collView ? viewCollection() : S.openListId ? viewList() : viewLists();
  else if (S.tab === 'battle') v.innerHTML = viewBattle();
  else v.innerHTML = viewStrats();
  window.scrollTo(0, keepScroll ? y : 0);
  keepScroll = false;
  if (S.tab === 'army' && S.openListId) hydrateList();
  if (S.tab === 'strats') hydrateStrats();
  setTimeout(syncHistory, 0);
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
    <button class="card coll-card" data-act="openCollection"><span class="coll-ico">📦</span><span class="grow"><b>My collection</b><br><span class="muted small">${hasCollection() ? `${Object.values(S.collection).reduce((t, x) => t + ((x.b ?? x.n) || 0), 0)} units across ${Object.values(S.collection).filter((x) => (x.b ?? x.n) > 0).length} datasheets` : 'Note the models you own, then build lists from them'}</span></span><span class="muted">›</span></button>
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

// ---------------------------------------------------------------- Army: collection
function viewCollection() {
  const cv = S.collView;
  const f = factions.get(cv.factionId);
  const idx = S.index;
  let body = '';
  if (!cv.factionId) body = '<p class="muted center">Choose a faction to record your models.</p>';
  else if (!f) body = '<div class="loading">Loading…</div>';
  else {
    const q = (cv.q || '').toLowerCase();
    const groups = new Map();
    for (const u of f.units) {
      if (u.legends && !S.settings.showLegends) continue;
      if (q && !u.n.toLowerCase().includes(q)) continue;
      const g = u.legends ? 'Legends' : u.xg ? u.xg : roleGroup(u);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(u);
    }
    const order = [...groups.keys()].sort((a, b) => (a === 'Legends') - (b === 'Legends') || (!!f.units.find((u) => u.xg === a)) - (!!f.units.find((u) => u.xg === b)) || roleRank(a) - roleRank(b));
    const tot = f.units.reduce((t, u) => t + blocksOwned(u), 0);
    body = `<p class="muted small">${tot} unit${tot === 1 ? '' : 's'} recorded for ${esc(f.n)}. Count each unit in its smallest size — bigger units are built by combining them. Units in several armies (e.g. Astra Militarum in Genestealer Cults) share one count.</p>
      ${order
        .map((g) => {
          const us = groups.get(g).sort((a, b) => a.n.localeCompare(b.n));
          const have = us.reduce((t, u) => t + blocksOwned(u), 0);
          const open = q || cv.open[g];
          return `<div class="fold ${open ? 'open' : ''}"><button class="fold-h" data-act="collFold" data-k="${esc(g)}"><span>${esc(g)}</span><span class="muted">${have ? `<span class="own">${have} unit${have === 1 ? '' : 's'}</span> · ` : ''}${us.length} ${open ? '▾' : '▸'}</span></button>
          ${open ? `<div class="fold-b">${us
            .map((u) => {
              const c = S.collection[ckey(u.n)] || {};
              const bs = blockSize(u);
              const b = blocksOwned(u);
              return `<div class="coll-row"><div class="grow"><div class="pn">${esc(u.n)}</div><div class="ps muted">${b ? `<span class="own">${b} × ${bs} = ${b * bs} model${b * bs === 1 ? '' : 's'}</span>` : `unit of ${bs}`}${c.note ? ` · <span class="note">${esc(c.note)}</span>` : ''}</div></div>
                <button class="icon small" data-act="collNote" data-k="${esc(u.n)}" aria-label="Note">✎</button>
                <button class="st-b sm" data-act="collStep" data-k="${esc(u.n)}" data-d="-1" ${b ? '' : 'disabled'}>−</button>
                <input class="st-v coll-n" inputmode="numeric" data-bind="collN" data-k="${esc(u.n)}" value="${b}">
                <button class="st-b sm" data-act="collStep" data-k="${esc(u.n)}" data-d="1">+</button></div>`;
            })
            .join('')}</div>` : ''}</div>`;
        })
        .join('')}`;
  }
  return `<header class="top"><button class="icon back" data-act="closeCollection" aria-label="Back">‹</button><div class="top-title"><div class="tt-name">My collection</div><div class="tt-sub">Units you own, in their smallest size</div></div></header>
  <main class="pad">
    <select data-bind="collFaction"><option value="">Choose faction…</option>${(idx?.factions || []).map((x) => `<option value="${x.id}" ${x.id === cv.factionId ? 'selected' : ''}>${esc(x.n)}</option>`).join('')}</select>
    ${f ? `<input id="collQ" type="search" placeholder="Search datasheets…" value="${esc(cv.q || '')}" autocomplete="off"><label class="toggle small"><input type="checkbox" data-act="toggleLegends" ${S.settings.showLegends ? 'checked' : ''}><span>Show Legends units</span></label>` : ''}
    <div id="collBody" class="mt">${body}</div>
  </main>`;
}
async function openCollection() {
  await ensureIndex().catch(() => null);
  const guess = S.lists[0]?.factionId || S.cached[0] || '';
  S.collView = { factionId: guess, q: '', open: {} };
  if (guess) await ensureFaction(guess).catch(() => null);
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
    .map(([role, items]) => {
      const shut = S.foldList && S.foldList[role];
      return `<section><button class="sec sec-btn" data-act="listFold" data-k="${esc(role)}"><span>${shut ? '▸' : '▾'} ${esc(role)} <span class="muted">(${items.length})</span></span><span class="muted">${items.reduce((t, it) => t + itemPts(it, f, l), 0)}</span></button>
      ${shut ? '' : items.map((it, idx) => itemHtml(it, idx, items.length, role, l, f)).join('')}</section>`;
    })
    .join('')}
  ${l.units.length > 1 ? `<button class="btn ghost block reorder-btn ${S.reorder ? 'on' : ''}" data-act="toggleReorder">${S.reorder ? '✓ Done reordering' : '⇅ Reorder units'}</button>` : ''}
  ${l.units.length ? '' : `<div class="empty small"><p class="muted">No units yet — tap “Add unit”.</p></div>`}
  <div class="spacer"></div>
  <button class="fab" data-act="addUnit">＋ Add unit</button>`;
}

// One list item: a single unit or a linked Leader + bodyguard group; with ▲▼ in reorder mode
function itemHtml(it, idx, n, role, l, f) {
  const arrows = S.reorder
    ? `<div class="ro"><button class="ro-b" data-act="moveItem" data-uid="${it.members[it.members.length - 1].uid}" data-d="-1" ${idx ? '' : 'disabled'} aria-label="Move up">▲</button><button class="ro-b" data-act="moveItem" data-uid="${it.members[it.members.length - 1].uid}" data-d="1" ${idx < n - 1 ? '' : 'disabled'} aria-label="Move down">▼</button></div>`
    : '';
  const body =
    it.members.length > 1
      ? `<div class="linked grow"><div class="linked-h"><span>🔗 ${esc(it.members.map((e) => e.name).join(' + '))}</span><b>${itemPts(it, f, l)}</b></div>${it.members.map((e) => entryRow(e, l, f)).join('')}</div>`
      : entryRow(it.members[0], l, f);
  return arrows ? `<div class="ro-row">${arrows}<div class="grow">${body}</div></div>` : body;
}

// Move a unit (or linked group) up/down within its section, then rebuild the list order
function moveItem(uidKey, d) {
  const l = curList();
  const f = factions.get(l.factionId);
  const secs = groupEntries(l, f);
  for (const [, items] of secs) {
    const i = items.findIndex((it) => it.members.some((e) => e.uid === uidKey));
    if (i < 0) continue;
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
  }
  // bodyguard first, then its characters, so the group stays together
  l.units = secs.flatMap(([, items]) => items.flatMap((it) => [it.members[it.members.length - 1], ...it.members.slice(0, -1)]));
  touch(l);
  rerender();
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
  const u2 = u;
  const tag = host ? `<span class="tag">${u2 && u2.sup ? 'Support' : 'Leader'}</span> ` : l.units.some((x) => x.attachTo === e.uid) ? '<span class="tag">Bodyguard</span> ' : '';
  return `<button class="entry" data-act="editEntry" data-uid="${e.uid}">
    <div class="en-main"><div class="en-name">${tag}${e.warlord ? '<span class="crown">♛</span>' : ''}${esc(e.name)}${u ? '' : ' <span class="warn">(missing)</span>'}</div>
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
    if (S.pickOwned && !owned(u)) continue;
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
        <div class="row gap wrap"><label class="toggle small"><input type="checkbox" data-act="toggleLegends" ${S.settings.showLegends ? 'checked' : ''}><span>Show Legends</span></label>
        ${hasCollection() ? `<label class="toggle small"><input type="checkbox" data-act="togglePickOwned" ${S.pickOwned ? 'checked' : ''}><span>Only my collection</span></label>` : ''}</div></div>
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
  const used = blocksUsed(l, f);
  const row = (u) => {
    const pts = u.c.length ? (u.c.length > 1 ? `${u.c[0].pts}–${u.c[u.c.length - 1].pts}` : u.c[0].pts) : '?';
    const n = counts.get(u.id) || 0;
    const have = blocksOwned(u);
    const usedB = used.get(ckey(u.n)) || 0;
    const bs = blockSize(u);
    const ownTag = hasCollection() && have ? ` <span class="tag ${usedB >= have ? 'used' : 'own'}">${usedB ? `${usedB}/${have}` : have}×${bs} owned</span>` : '';
    return `<div class="pick-row ${hasCollection() && have && usedB >= have ? 'spent' : ''}"><button class="pick-info" data-act="viewUnit" data-add="1" data-id="${u.id}"><div class="pn">${esc(u.n)}${n ? ` <span class="tag">×${n}</span>` : ''}${ownTag}</div>
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
let entryTab = 'sheet';
function editEntry(entryUid) {
  entryTab = 'sheet';
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
      const optionsPart = `        ${u.c.length > 1 ? `<label class="lbl">Unit size</label><div class="chips">${u.c.map((c, i) => {
          const need = c.models ? blocksFor(u, c.models) : 0;
          const tight = hasCollection() && need && need > freeBlocks(u, e, l, f) ? 'short' : '';
          return `<button class="chip ${(e.cost || 0) === i ? 'on' : ''} ${tight}" data-act="setCost" data-uid="${e.uid}" data-v="${i}">${esc(c.d)} · ${c.pts}${hasCollection() && need > 1 ? ` <span class="small">(${need}×${blockSize(u)})</span>` : ''}</button>`;
        }).join('')}</div>${hasCollection() ? `<p class="muted small">You own ${blocksOwned(u)} × ${blockSize(u)}; ${freeBlocks(u, e, l, f)} free for this unit.</p>` : ''}<div></div>` : ''}
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
        <div class="ds-inline">${datasheet(u, f, wg.parsed ? wg.counts : null, { build: true })}</div>`;
      const ws = wargearSummary(e, u, l);
      const en = e.enh && f.enhById.get(e.enh);
      const sheetPart = `${ws ? `<p class="small loadout">Loadout: <b>${esc(ws)}</b></p>` : ''}${en ? `<div class="rule enh-rule"><b>✦ Enhancement: ${esc(en.n)}</b><div>${rich(en.d)}</div></div>` : ''}<div class="ds-inline">${datasheet(u, f, wg.parsed ? wg.counts : null, { play: true, attached: l.units.filter((x) => x.attachTo === e.uid).map((x) => f.unitById.get(x.unitId)).filter(Boolean) })}</div>`;
      return `${head(e.name)}<div class="sheet-body">
        <div class="row"><div class="big-pts grow">${entryPts(e, f, l)} <span>pts</span></div>${e.warlord ? '<span class="tag big">♛ Warlord</span>' : ''}</div>
        ${co.step ? `<p class="warn small">${esc(co.step)} — this is copy ${copyNo(e, l)} of this datasheet.</p>` : ''}
        ${wg.pts ? `<p class="muted small">Includes wargear: ${wg.lines.map((x) => `${x.n}× ${esc(x.name)} (+${x.each * x.n})`).join(', ')}</p>` : ''}
        <div class="seg tabs">${[['sheet', 'Datasheet'], ['opts', 'Unit options']].map(([k, n]) => `<button class="${entryTab === k ? 'on' : ''}" data-act="entryTab" data-v="${k}">${n}</button>`).join('')}</div>
        ${entryTab === 'sheet' ? sheetPart : optionsPart}
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

// Invulnerable saves: the unit's own (solid shield) and ones that depend on something —
// wargear, an ability's condition, or an attached character (dashed shield with ★)
const INV_RE = /(?:(\d)\+\s*invulnerable save|invulnerable save of (\d)\+)/i;
function abilityInvs(u, f, from) {
  const out = [];
  for (const a of u.ab) {
    if (a.t === 'Core') continue;
    const r = a.ref ? f.abilities[a.ref] : a;
    const txt = plain(r?.d || a.d || '');
    const m = INV_RE.exec(txt);
    if (!m) continue;
    // a leader's ability only matters for the unit if it talks about the unit it leads
    if (from && !/leading|that unit|this unit|bearer.?s unit|models in/i.test(txt)) continue;
    out.push({ v: (m[1] || m[2]) + '+', cond: true, src: from ? `${from} (${r?.n || a.n})` : r?.n || a.n, note: txt });
  }
  return out;
}
function invStrip(u, f, attached) {
  const list = [];
  for (const m of u.m) {
    if (!m.inv) continue;
    const cond = !!plain(m.invd).trim();
    list.push({ v: m.inv, cond, src: u.m.length > 1 ? m.n : '', note: plain(m.invd) });
  }
  for (const x of abilityInvs(u, f)) if (!list.some((y) => y.v === x.v && !y.cond)) list.push(x);
  for (const lu of attached) for (const x of abilityInvs(lu, f, lu.n)) list.push(x);
  if (!list.length) return '';
  const seen = new Set();
  const uniq = list.filter((x) => {
    const k = x.v + '|' + x.src;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return `<div class="inv-strip">${uniq
    .map((x) => `<div class="invb ${x.cond ? 'cond' : ''}"><span class="inv-sh">${esc(x.v)}${x.cond ? '<sup>★</sup>' : ''}</span><span class="inv-l">Invulnerable save${x.src ? `<br><span class="muted">${x.cond ? 'from ' : ''}${esc(x.src)}</span>` : ''}</span></div>`)
    .join('')}</div>
  ${uniq.some((x) => x.cond) ? `<details class="inv-notes"><summary class="muted small">★ Conditional — tap for details</summary>${uniq.filter((x) => x.cond).map((x) => `<p class="small"><b>${esc(x.v)} ${esc(x.src || '')}:</b> ${esc(x.note)}</p>`).join('')}</details>` : ''}`;
}

// Weapon keyword → rule text (from the core rules, compiled into core.json)
function weaponAbilityKey(t) {
  return t
    .replace(/[\[\]]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+(X|D?\d+\+?|\d+")$/, '')
    .replace(/\s+/g, ' ');
}
async function showWeaponKeyword(t) {
  if (!S.core || !S.core.weaponAbilities || !S.core.actions) S.core = (await data.downloadCore().catch(() => null)) || S.core;
  const all = S.core?.weaponAbilities || {};
  const k = weaponAbilityKey(t);
  let hit = all[k];
  if (!hit && /^ANTI-/.test(k)) hit = Object.entries(all).find(([key]) => key.startsWith('ANTI'))?.[1];
  if (!hit) hit = Object.entries(all).find(([key]) => k.startsWith(key + ' ') || key === k.split(' ')[0])?.[1];
  // e.g. [PISTOL] says it is identical to [CLOSE-QUARTERS]: show that rule's text too
  const extra = [];
  if (hit && /identical|same as|treated as/i.test(plain(hit.d))) {
    const own = weaponAbilityKey(hit.n);
    for (const m of plain(hit.d).matchAll(/\[([A-Z][A-Z -]+?)\]/g)) {
      const k2 = weaponAbilityKey(m[1]);
      if (k2 !== own && all[k2] && !extra.includes(k2)) extra.push(k2);
    }
  }
  // actions the rule points to, e.g. [INDIRECT FIRE] → "indirect shooting", [ASSAULT] → "assault shooting"
  const acts = S.core?.actions || {};
  const txt = hit ? plain([hit.d, ...extra.map((k2) => all[k2].d)].join(' ')).toLowerCase() : '';
  const actHits = Object.keys(acts).filter((a) => a.length > 4 && txt.includes(a.toLowerCase()));
  showSheet(() => `${head(t.toUpperCase())}<div class="sheet-body">${hit ? `<div class="rule">${rich(hit.d)}</div>${extra.map((k2) => `<h3 class="ds-h abil">${esc(all[k2].n)} — applies to this weapon</h3><div class="rule">${rich(all[k2].d)}</div>`).join('')}${actHits.map((a) => `<h3 class="ds-h ranged">${esc(a)}</h3><div class="rule">${rich(acts[a])}</div>`).join('')}` : '<p class="muted">No rule text found for this keyword. It may be a faction or datasheet rule — check the unit’s abilities.</p>'}</div>`);
}

// Composition, loadout and points — shown on the Unit options tab
function buildInfo(u) {
  return `<h3 class="ds-h comp">Composition</h3>
  ${u.comp.length ? `<div class="rule">${u.comp.map(rich).join('<br>')}</div>` : ''}
  ${u.load ? `<div class="rule">${rich(u.load)}</div>` : ''}
  <h3 class="ds-h pts">Points</h3><div class="chips">${u.c.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('') || '<span class="muted">—</span>'}</div>
  ${(u.cx || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>+${c.pts}</b></span>`).join('')}</div>`).join('')}
  ${(u.cs || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('')}</div>`).join('')}`;
}

// datasheet (counts: Map of weapon name -> number carried, or null to list every profile)
function datasheet(u, f, counts, opts = {}) {
  if (opts.build) return buildInfo(u);
  const ab = (t) => u.ab.filter((a) => a.t === t);
  const named = (a) => {
    const r = a.ref ? f.abilities[a.ref] : a;
    return { n: (r?.n || a.n || '') + (a.p ? ` ${a.p}` : ''), d: r?.d || a.d || '' };
  };
  const chipList = (list) => list.map((a) => named(a)).map((a) => `<details class="rc"><summary>${esc(a.n)}</summary><div>${rich(a.d) || '<span class="muted">—</span>'}</div></details>`).join('');
  const wrow = (w) => `<tr class="${counts && !counts.get(w.n) ? 'dim' : ''}"><td class="wn">${counts && counts.get(w.n) ? `<span class="wcount">${counts.get(w.n)}×</span> ` : ''}${esc(w.n)}${w.k ? `<div class="wkw">${plain(w.k).split(/,\s*/).filter(Boolean).map((t) => `<button class="wkw-b" data-act="wkw" data-k="${esc(t.trim())}">${esc(t.trim())}</button>`).join('')}</div>` : ''}</td><td>${esc(w.r)}</td><td>${esc(w.A)}</td><td>${esc(w.s)}</td><td>${esc(w.S)}</td><td>${esc(w.AP)}</td><td>${esc(w.D)}</td></tr>`;
  const wt = (kind) => {
    const ws = u.w.filter((w) => w.t === kind);
    if (!ws.length) return '';
    const carried = counts ? ws.filter((w) => counts.get(w.n)) : ws;
    const other = counts ? ws.filter((w) => !counts.get(w.n)) : [];
    const thead = `<thead><tr><th class="wn"></th><th>Range</th><th>A</th><th>${kind === 'ranged' ? 'BS' : 'WS'}</th><th>S</th><th>AP</th><th>D</th></tr></thead>`;
    return `<h3 class="ds-h ${kind}">${kind === 'ranged' ? '⌖ Ranged weapons' : '⚔ Melee weapons'}</h3>
      ${carried.length ? `<table class="wtab">${thead}<tbody>${carried.map(wrow).join('')}</tbody></table>` : ''}
      ${other.length ? `<details class="others"><summary class="muted small">${other.length} other profile${other.length > 1 ? 's' : ''} (options)</summary><table class="wtab">${thead}<tbody>${other.map(wrow).join('')}</tbody></table></details>` : ''}`;
  };
  const other = u.ab.filter((a) => !['Core', 'Faction', 'Datasheet', 'Wargear'].includes(a.t));
  const leadNames = u.leads.map((id) => f.unitById.get(id)?.n).filter(Boolean);
  const ledBy = u.ledBy.map((id) => f.unitById.get(id)?.n).filter(Boolean);
  return `<div class="ds-kw">${u.kw.map((k) => `<span class="kwchip">${esc(k)}</span>`).join('')}</div>
  <table class="stats"><thead><tr><th></th><th>M</th><th>T</th><th>SV</th><th>W</th><th>LD</th><th>OC</th></tr></thead><tbody>
  ${u.m.map((m) => `<tr><td class="mname">${u.m.length > 1 ? esc(m.n) : ''}</td>${['M', 'T', 'Sv', 'W', 'Ld', 'OC'].map((k) => `<td>${esc(m[k] || '-')}</td>`).join('')}</tr>`).join('')}</tbody></table>
  ${invStrip(u, f, opts.attached || [])}
  ${wt('ranged')}${wt('melee')}
  ${ab('Core').length ? `<h3 class="ds-h core">Core</h3><div class="rulechips">${chipList(ab('Core'))}</div>` : ''}
  ${ab('Faction').length ? `<h3 class="ds-h fac">Faction</h3><div class="rulechips">${chipList(ab('Faction'))}</div>` : ''}
  ${ab('Datasheet').length ? `<h3 class="ds-h abil">Abilities</h3>${ab('Datasheet').map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('')}` : ''}
  ${ab('Wargear').length ? `<h3 class="ds-h abil">Wargear abilities</h3>${ab('Wargear').map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('')}` : ''}
  ${other.length ? other.map(named).map((a) => `<div class="rule"><b>${esc(a.n)}</b><div>${rich(a.d)}</div></div>`).join('') : ''}
  ${u.dmg ? `<div class="rule"><b>Damaged: ${esc(u.dmg.w)} wounds remaining</b><div>${rich(u.dmg.d)}</div></div>` : ''}
  ${leadNames.length || u.lh ? `<h3 class="ds-h lead">${u.sup ? 'Support' : 'Leader'}</h3><div class="rule">${u.lh ? `<div>${rich(u.lh)}</div>` : ''}${leadNames.length ? `<div>${leadNames.map((n) => `■ ${esc(n)}`).join('<br>')}</div>` : ''}${u.lf ? `<div class="muted small">${rich(u.lf)}</div>` : ''}</div>` : ''}
  ${ledBy.length ? `<p class="small muted">Can be led by: ${esc(ledBy.join(', '))}</p>` : ''}
  ${u.tr ? `<h3 class="ds-h comp">Transport</h3><div class="rule">${rich(u.tr)}</div>` : ''}
  ${opts.play ? '' : `<h3 class="ds-h comp">Composition</h3>
  ${u.comp.length ? `<div class="rule">${u.comp.map(rich).join('<br>')}</div>` : ''}
  ${u.load ? `<div class="rule">${rich(u.load)}</div>` : ''}
  ${!counts && u.opt.length ? `<div class="rule"><b>Wargear options</b><ul class="opts">${u.opt.map((o) => `<li>${rich(o)}</li>`).join('')}</ul></div>` : ''}`}
  ${opts.play ? '' : `  <h3 class="ds-h pts">Points</h3><div class="chips">${u.c.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('') || '<span class="muted">—</span>'}</div>
  ${(u.cx || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>+${c.pts}</b></span>`).join('')}</div>`).join('')}
  ${(u.cs || []).map((st) => `<div class="muted small mt">${esc(st.label)}</div><div class="chips">${st.rows.map((c) => `<span class="chip static">${esc(c.d)} · <b>${c.pts}</b></span>`).join('')}</div>`).join('')}`}
  <h3 class="ds-h kwh">Keywords</h3>
  <div class="kwbox"><div><span class="kwl">Keywords</span> ${esc(u.kw.join(', ') || '—')}</div>
    ${u.mkw.length ? `<div class="small">${u.mkw.map((m) => esc(m)).join('<br>')}</div>` : ''}
    <div><span class="kwl">Faction</span> ${esc(u.fkw.join(', ') || '—')}</div></div>
  ${u.src ? `<p class="muted small">Source: ${esc(u.src)}</p>` : ''}
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
  const rc = caps.secondaryRound || Infinity;
  const sec = Math.min(caps.secondary, p.secondary.reduce((a, b) => a + Math.min(rc, +b || 0), 0));
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
    ${missionPanel(g)}
    <div class="players">${g.players
      .map((p, i) => `<div class="pcard ${lead === i ? 'lead' : ''}">
        <button class="pc-name" data-act="renamePlayer" data-i="${i}">${esc(p.name)}</button><div class="pc-fac muted">${esc(p.faction || '')}</div>
        <div class="pc-total"><b>${T[i].total}</b><span>VP</span></div><div class="pc-split muted">P ${T[i].pri} · S ${T[i].sec}${p.battleReady ? ` · BR ${T[i].br}` : ''}</div>
        ${stepper('CP', p.cp, `cp:${i}`)}${stepper(`Primary R${r}`, p.primary[r - 1], `pri:${i}`)}${stepper(`Secondary R${r}`, p.secondary[r - 1], `sec:${i}`)}
        <button class="secbtn" data-act="secSheet" data-i="${i}"><span class="muted small">${p.sec?.mode === 'fixed' ? 'Fixed' : 'Tactical'} secondaries</span>${secActive(p).map((n) => `<div class="secname">${esc(n)}</div>`).join('') || '<div class="muted small">Tap to choose / draw</div>'}</button>
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
    <p class="muted small center">Caps: primary ${g.caps.primary}, secondary ${g.caps.secondary}${g.caps.secondaryRound ? ` (${g.caps.secondaryRound} per round)` : ''}, total ${g.caps.total} — change in ⚙ Settings.</p>
  </main>`;
}
function viewBattleHome() {
  const past = S.games.filter((g) => g.finished).sort((a, b) => b.created - a.created);
  return `<header class="top"><div class="brand"><span class="logo">⚔</span> Battle</div><div class="grow"></div>${gear}</header><main class="pad">
    <button class="btn primary block" data-act="newGame">＋ Start a new game</button>
    <button class="btn ghost block" data-act="missionsBrowser">📖 Missions & cards</button>
    ${past.length ? `<h3 class="sec">Past games</h3><div class="stack">${past.map((g) => {
      const t = g.players.map((p) => totals(p, g.caps).total);
      return `<button class="card list-card" data-act="viewGame" data-id="${g.id}"><div class="lc-main"><div class="lc-name">${esc(g.players[0].name)} vs ${esc(g.players[1].name)}</div><div class="lc-sub">${esc(g.mission || 'Battle')} · ${fmtDate(new Date(g.created).toISOString())}</div><div class="lc-sub">${t[0] === t[1] ? 'Draw' : esc(g.players[t[0] > t[1] ? 0 : 1].name) + ' won'}</div></div><div class="lc-pts"><b>${t[0]}–${t[1]}</b></div></button>`;
    }).join('')}</div>` : `<div class="empty"><div class="empty-ico">🎲</div><p class="muted">Track VP, CP and secondaries round by round. Stratagems you use from the Stratagems tab deduct CP here.</p></div>`}
  </main>`;
}
async function ensureMissions() {
  if (S.missions) return S.missions;
  try {
    S.missions = await data.downloadMissions();
  } catch {
    S.missions = null;
  }
  return S.missions;
}
const FD_NAMES = ['Take and Hold', 'Purge the Foe', 'Disruption', 'Reconnaissance', 'Priority Assets'];
const fdList = () => (S.missions?.fds?.length ? S.missions.fds.map((x) => x.n) : FD_NAMES);
function primaryFor(mine, theirs) {
  return S.missions?.matrix?.[mine]?.[theirs] || '';
}
const cardByName = (list, n) => (list || []).find((c) => c.n.toLowerCase() === String(n || '').toLowerCase());

async function newGameSheet() {
  const idx = await ensureIndex().catch(() => null);
  await ensureMissions();
  const draft = { fd0: '', fd1: '' };
  const fdOpts = (sel) => `<option value="">Choose…</option>${fdList().map((x) => `<option ${sel === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}`;
  showSheet(
    () => `${head('New game')}<div class="sheet-body">
      <label class="lbl">You</label><input id="ngName0" value="Me">
      <select id="ngList0" data-bind="ngList0"><option value="">No list</option>${S.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${esc(l.factionName)})</option>`).join('')}</select>
      <div class="grid2"><label class="small muted">Force Disposition<select id="ngFd0">${fdOpts(draft.fd0)}</select></label>
      <label class="small muted">Secondaries<select id="ngSec0"><option value="tactical">Tactical</option><option value="fixed">Fixed</option></select></label></div>
      <label class="lbl">Opponent</label><input id="ngName1" value="Opponent">
      <select id="ngList1"><option value="">Their list isn't on this phone</option>${S.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${esc(l.factionName)})</option>`).join('')}</select>
      ${idx ? `<select id="ngFac1"><option value="">Opponent faction (for stratagems)…</option>${idx.factions.map((x) => `<option value="${x.id}">${esc(x.n)}</option>`).join('')}</select>` : ''}
      <div class="grid2"><label class="small muted">Force Disposition<select id="ngFd1">${fdOpts(draft.fd1)}</select></label>
      <label class="small muted">Secondaries<select id="ngSec1"><option value="tactical">Tactical</option><option value="fixed">Fixed</option></select></label></div>
      ${S.missions ? `<label class="lbl">Battlefield</label><div class="grid2">
        <label class="small muted">Deployment<select id="ngDep"><option value="">Choose later</option><option value="?">🎲 Random</option>${S.missions.deployments.map((d) => `<option>${esc(d.n)}</option>`).join('')}</select></label>
        <label class="small muted">Twist<select id="ngTw"><option value="">None</option><option value="?">🎲 Random</option>${S.missions.twists.map((d) => `<option>${esc(d.n)}</option>`).join('')}</select></label></div>` : '<p class="muted small">Mission cards will appear once the data has downloaded.</p>'}
      <label class="lbl">Game name (optional)</label><input id="ngMission" placeholder="e.g. Friday night grudge match">
    </div><div class="sheet-foot"><button class="btn primary block" data-act="ngStart">Start game</button></div>`,
    { tall: true }
  );
}
function startGame() {
  const pick = (list, v) => (v === '?' ? list[Math.floor(Math.random() * list.length)]?.n || '' : v);
  const g = { id: uid(), created: Date.now(), mission: $('#ngMission').value.trim(), round: 1, finished: false, caps: { ...S.settings.caps }, log: [], players: [] };
  if (S.missions) {
    g.deployment = pick(S.missions.deployments, $('#ngDep')?.value || '');
    g.twist = pick(S.missions.twists, $('#ngTw')?.value || '');
  }
  for (const i of [0, 1]) {
    const listId = $('#ngList' + i).value;
    const l = S.lists.find((x) => x.id === listId);
    const fac = i === 1 && !l ? $('#ngFac1')?.value || '' : l?.factionId || '';
    const facName = l ? l.factionName : S.index?.factions.find((x) => x.id === fac)?.n || '';
    g.players.push({ name: $('#ngName' + i).value.trim() || `Player ${i + 1}`, listId, factionId: fac, faction: facName, cp: 0, battleReady: false, primary: [0, 0, 0, 0, 0], secondary: [0, 0, 0, 0, 0], secNames: '',
      fd: $('#ngFd' + i)?.value || (l && l.disposition) || '', sec: { mode: $('#ngSec' + i)?.value || 'tactical', fixed: [], active: [], discard: [], swapUsed: false } });
  }
  for (const [i, p] of g.players.entries()) p.pm = primaryFor(p.fd, g.players[1 - i].fd);
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
  return [`${g.mission || 'Battle'} — ${fmtDate(new Date(g.created).toISOString())}`, g.deployment ? `Deployment: ${g.deployment}${g.twist ? ' · Twist: ' + g.twist : ''}` : '', ...g.players.map((p, i) => `${p.name}${p.faction ? ' (' + p.faction + ')' : ''}${p.pm ? ' [' + p.pm + ']' : ''}: ${t[i].total} VP (Primary ${t[i].pri}, Secondary ${t[i].sec}${p.battleReady ? ', Battle ready ' + t[i].br : ''})`), '', 'Round by round (Pri/Sec):', ...[0, 1, 2, 3, 4].map((k) => `R${k + 1}: ${g.players.map((p) => `${p.primary[k] || 0}/${p.secondary[k] || 0}`).join('  vs  ')}`)].join('\n');
}

// ---------------------------------------------------------------- Missions
function missionPanel(g) {
  if (!g.players.some((p) => p.fd || p.pm) && !g.deployment) {
    return `<button class="card mission-card" data-act="gameMission"><span class="muted small">Mission</span><div class="warn">Set Force Dispositions…</div></button>`;
  }
  return `<button class="card mission-card" data-act="gameMission">
    <div class="mc-grid">${g.players.map((p) => `<div><div class="muted small">${esc(p.name)} · ${esc(p.fd || '—')}</div><div class="mc-pm">${esc(p.pm || 'No primary')}</div></div>`).join('')}</div>
    ${g.deployment || g.twist ? `<div class="muted small mt">${g.deployment ? '🗺 ' + esc(g.deployment) : ''}${g.twist ? ' · ⚡ ' + esc(g.twist) : ''}</div>` : ''}</button>`;
}

function cardHtml(c, kind) {
  if (!c) return '<p class="muted">Card text not available.</p>';
  return `<div class="mcard ${kind || ''}"><div class="mcard-h"><b>${esc(c.n)}</b>${c.fixed ? ' <span class="tag">Fixed values</span>' : ''}</div>
    ${c.fluff ? `<p class="muted small fl">${esc(c.fluff)}</p>` : ''}${c.img ? `<img class="map" src="./data/${esc(c.img)}" alt="${esc(c.n)} deployment map">` : ''}<div class="mcard-b">${rich(c.d || '')}</div></div>`;
}

function gameMissionSheet() {
  const g = activeGame();
  const M = S.missions;
  const sel = (id, list, cur, blank) => `<select data-bind="${id}"><option value="">${blank}</option>${list.map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
  showSheet(
    () => `${head('Mission')}<div class="sheet-body">
      ${g.players
        .map((p, i) => `<label class="lbl">${esc(p.name)}</label><div class="grid2">
          <label class="small muted">Force Disposition${sel('gFd' + i, fdList(), p.fd, 'Choose…')}</label>
          <label class="small muted">Primary mission${sel('gPm' + i, (M?.primary || []).map((x) => x.n), p.pm, '—')}</label></div>`)
        .join('')}
      ${M ? `<div class="grid2"><label class="small muted">Deployment${sel('gDep', M.deployments.map((x) => x.n), g.deployment, '—')}</label><label class="small muted">Twist${sel('gTw', M.twists.map((x) => x.n), g.twist, 'None')}</label></div>
        <div class="row gap"><button class="btn ghost small grow" data-act="gSwapPm">⇄ Swap primaries</button><button class="btn ghost small grow" data-act="gRollDep">🎲 Deployment</button></div>` : ''}
      ${M ? g.players.map((p) => (p.pm ? `<h3 class="sec">Primary — ${esc(p.name)}</h3>${cardHtml(cardByName(M.primary, p.pm), 'pm')}` : '')).join('') : '<p class="muted">Mission cards haven’t downloaded yet.</p>'}
      ${M && g.deployment ? `<h3 class="sec">Deployment</h3>${cardHtml(cardByName(M.deployments, g.deployment), 'dp')}` : ''}
      ${M && g.twist ? `<h3 class="sec">Twist</h3>${cardHtml(cardByName(M.twists, g.twist), 'tw')}` : ''}
    </div>`,
    { tall: true, onClose: () => rerender() }
  );
}

// Secondaries: Tactical (draw two each Command phase) or Fixed (two chosen cards)
function secActive(p) {
  if (!p.sec) return p.secNames ? [p.secNames] : [];
  return p.sec.mode === 'fixed' ? p.sec.fixed : p.sec.active;
}
function secSheet(i) {
  const g = activeGame();
  const p = g.players[i];
  p.sec = p.sec || { mode: 'tactical', fixed: [], active: [], discard: [], swapUsed: false };
  const M = S.missions;
  showSheet(
    () => {
      const sc = p.sec;
      const all = M?.secondary || [];
      const deck = all.filter((c) => !sc.active.includes(c.n) && !sc.discard.includes(c.n));
      return `${head(`${p.name} — secondaries`)}<div class="sheet-body">
        <div class="seg">${['tactical', 'fixed'].map((m) => `<button class="${sc.mode === m ? 'on' : ''}" data-act="secMode" data-i="${i}" data-v="${m}">${m === 'tactical' ? 'Tactical' : 'Fixed'}</button>`).join('')}</div>
        ${!M ? '<p class="muted">Secondary cards haven’t downloaded yet.</p>' : sc.mode === 'fixed'
          ? `<p class="muted small">Choose two cards to score all game.</p>${all.map((c) => `<button class="frow ${sc.fixed.includes(c.n) ? 'on' : ''}" data-act="secFix" data-i="${i}" data-n="${esc(c.n)}"><span>${sc.fixed.includes(c.n) ? '✓ ' : ''}${esc(c.n)}</span>${c.fixed ? '<span class="tag">Fixed values</span>' : ''}</button>`).join('')}
             ${sc.fixed.map((n) => cardHtml(cardByName(all, n))).join('')}`
          : `<div class="row gap"><button class="btn primary grow" data-act="secDraw" data-i="${i}" ${sc.active.length >= 2 || !deck.length ? 'disabled' : ''}>Draw to 2 (${deck.length} left)</button>
             <button class="btn ghost" data-act="secReset" data-i="${i}">Reshuffle</button></div>
             <p class="muted small">Draw at the start of your Command phase. Once per battle you can spend 1CP to discard one and draw a new one${sc.swapUsed ? ' — <b>used</b>' : ''}.</p>
             ${sc.active.map((n) => `${cardHtml(cardByName(all, n))}<div class="row gap mb"><button class="btn small primary grow" data-act="secDone" data-i="${i}" data-n="${esc(n)}">✓ Achieved</button><button class="btn small ghost grow" data-act="secDiscard" data-i="${i}" data-n="${esc(n)}">Discard</button>${sc.swapUsed ? '' : `<button class="btn small ghost grow" data-act="secSwap" data-i="${i}" data-n="${esc(n)}">New card (1CP)</button>`}</div>`).join('')}
             ${sc.discard.length ? `<p class="muted small">Discarded / achieved: ${esc(sc.discard.join(', '))}</p>` : ''}`}
      </div>`;
    },
    { tall: true, onClose: () => rerender() }
  );
}

const MB = { tab: 'match', fd0: 'Take and Hold', fd1: 'Purge the Foe' };
async function missionsBrowser() {
  const M = await ensureMissions();
  if (!M) return toast('Mission cards are not available yet');
  showSheet(
    () => {
      const tabs = [['match', 'Matchups'], ['pm', 'Primary'], ['sm', 'Secondary'], ['dp', 'Maps'], ['tw', 'Twists']];
      let body = '';
      if (MB.tab === 'match') {
        const fds = fdList();
        body = `<label class="lbl">Your Force Disposition</label><div class="chips">${fds.map((f) => `<button class="chip ${MB.fd0 === f ? 'on' : ''}" data-act="mbFd" data-w="0" data-v="${esc(f)}">${esc(f)}</button>`).join('')}</div>
          <label class="lbl">Opponent's</label><div class="chips">${fds.map((f) => `<button class="chip ${MB.fd1 === f ? 'on' : ''}" data-act="mbFd" data-w="1" data-v="${esc(f)}">${esc(f)}</button>`).join('')}</div>
          <h3 class="sec">Your primary: ${esc(primaryFor(MB.fd0, MB.fd1) || '—')}</h3>${cardHtml(cardByName(M.primary, primaryFor(MB.fd0, MB.fd1)), 'pm')}
          <h3 class="sec">Their primary: ${esc(primaryFor(MB.fd1, MB.fd0) || '—')}</h3>${cardHtml(cardByName(M.primary, primaryFor(MB.fd1, MB.fd0)), 'pm')}
          <h3 class="sec">All matchups</h3><div class="mgrid-wrap"><table class="mgrid"><thead><tr><th>You ↓ / Opp →</th>${fds.map((f) => `<th>${esc(f)}</th>`).join('')}</tr></thead><tbody>
          ${fds.map((a) => `<tr><th>${esc(a)}</th>${fds.map((b) => `<td>${esc(primaryFor(a, b))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } else {
        const list = { pm: M.primary, sm: M.secondary, dp: M.deployments, tw: M.twists }[MB.tab];
        body = list.map((c) => `<details class="mdet"><summary>${esc(c.n)}${c.fixed ? ' <span class="tag">Fixed values</span>' : ''}</summary>${cardHtml(c, MB.tab)}</details>`).join('');
      }
      return `${head('Missions & cards')}<div class="sheet-sub"><div class="chips scroll">${tabs.map(([k, n]) => `<button class="chip ${MB.tab === k ? 'on' : ''}" data-act="mbTab" data-v="${k}">${n}</button>`).join('')}</div></div><div class="sheet-body">${body}</div>`;
    },
    { tall: true }
  );
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
      <label>Secondary per round<input inputmode="numeric" data-bind="cap" data-k="secondaryRound" value="${c.secondaryRound ?? ''}"></label><label>Battle ready<input inputmode="numeric" data-bind="cap" data-k="battleReady" value="${c.battleReady}"></label><label>Total<input inputmode="numeric" data-bind="cap" data-k="total" value="${c.total}"></label></div>
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
    S.missions = await data.downloadMissions().catch(() => S.missions);
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
  const blob = new Blob([JSON.stringify({ app: 'muster', v: 2, exported: new Date().toISOString(), lists: S.lists, games: S.games, settings: S.settings, collection: S.collection }, null, 1)], { type: 'application/json' });
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
    if (d.collection) S.collection = { ...S.collection, ...d.collection };
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
    S.reorder = false;
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
    if (S.collView && !sheets.length) return rerender();
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
  editEntry: (el) => {
    if (S.reorder) return;
    editEntry(el.dataset.uid);
  },
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
  wkw: (el) => showWeaponKeyword(el.dataset.k),
  openCollection: () => openCollection(),
  closeCollection: () => {
    S.collView = null;
    render();
  },
  collFold: (el) => {
    S.collView.open[el.dataset.k] = !S.collView.open[el.dataset.k];
    rerender();
  },
  collStep: (el) => {
    const k = ckey(el.dataset.k);
    const c = (S.collection[k] ||= { b: 0, note: '' });
    c.b = Math.max(0, (c.b ?? 0) + +el.dataset.d);
    delete c.n;
    save('collection');
    rerender();
  },
  collNote: async (el) => {
    const k = ckey(el.dataset.k);
    const c = (S.collection[k] ||= { b: 0, note: '' });
    const v = await promptBox(`${el.dataset.k} — note`, c.note || '', { placeholder: 'e.g. magnetised: lascannon / multi-melta', ok: 'Save' });
    if (v != null) {
      c.note = v.trim();
      save('collection');
      rerender();
    }
  },
  togglePickOwned: (el) => {
    S.pickOwned = el.checked;
    const l = curList();
    $('#pickResults').innerHTML = pickerResults(factions.get(l.factionId), l);
  },
  toggleReorder: () => {
    S.reorder = !S.reorder;
    rerender();
  },
  moveItem: (el) => moveItem(el.dataset.uid, +el.dataset.d),
  entryTab: (el) => {
    entryTab = el.dataset.v;
    rerenderTopSheet();
    const b = document.querySelector('.sheet:last-of-type .sheet-body');
    if (b) b.scrollTop = 0;
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
  // missions
  missionsBrowser: () => missionsBrowser(),
  mbTab: (el) => {
    MB.tab = el.dataset.v;
    rerenderTopSheet();
  },
  mbFd: (el) => {
    MB['fd' + el.dataset.w] = el.dataset.v;
    rerenderTopSheet();
  },
  gameMission: async () => {
    await ensureMissions();
    gameMissionSheet();
  },
  gSwapPm: () => {
    const g = activeGame();
    [g.players[0].pm, g.players[1].pm] = [g.players[1].pm, g.players[0].pm];
    save('games');
    rerenderTopSheet();
  },
  gRollDep: () => {
    const g = activeGame();
    const d = S.missions.deployments;
    g.deployment = d[Math.floor(Math.random() * d.length)].n;
    save('games');
    rerenderTopSheet();
  },
  secSheet: async (el) => {
    await ensureMissions();
    secSheet(+el.dataset.i);
  },
  secMode: (el) => {
    activeGame().players[+el.dataset.i].sec.mode = el.dataset.v;
    save('games');
    rerenderTopSheet();
  },
  secFix: (el) => {
    const sc = activeGame().players[+el.dataset.i].sec;
    const n = el.dataset.n;
    sc.fixed = sc.fixed.includes(n) ? sc.fixed.filter((x) => x !== n) : [...sc.fixed, n].slice(-2);
    save('games');
    rerenderTopSheet();
  },
  secDraw: (el) => {
    const sc = activeGame().players[+el.dataset.i].sec;
    const deck = S.missions.secondary.map((c) => c.n).filter((n) => !sc.active.includes(n) && !sc.discard.includes(n));
    while (sc.active.length < 2 && deck.length) sc.active.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]);
    save('games');
    rerenderTopSheet();
  },
  secDone: (el) => {
    const sc = activeGame().players[+el.dataset.i].sec;
    sc.active = sc.active.filter((x) => x !== el.dataset.n);
    sc.discard.push(el.dataset.n);
    save('games');
    toast('Add the VP to this round’s Secondary score');
    rerenderTopSheet();
  },
  secDiscard: (el) => {
    const sc = activeGame().players[+el.dataset.i].sec;
    sc.active = sc.active.filter((x) => x !== el.dataset.n);
    sc.discard.push(el.dataset.n);
    save('games');
    rerenderTopSheet();
  },
  secSwap: (el) => {
    const g = activeGame();
    const p = g.players[+el.dataset.i];
    const sc = p.sec;
    if (p.cp < 1) return toast(`${p.name} has no CP`);
    p.cp -= 1;
    (g.log ||= []).push({ r: g.round, p: +el.dataset.i, n: `New secondary (${el.dataset.n})`, cp: 1 });
    sc.swapUsed = true;
    sc.active = sc.active.filter((x) => x !== el.dataset.n);
    sc.discard.push(el.dataset.n);
    A.secDraw(el);
  },
  secReset: (el) => {
    const sc = activeGame().players[+el.dataset.i].sec;
    sc.active = [];
    sc.discard = [];
    sc.swapUsed = false;
    save('games');
    rerenderTopSheet();
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
  if (/^gFd[01]$/.test(b || '')) {
    const g = activeGame();
    const i = +b.slice(-1);
    g.players[i].fd = el.value;
    for (const [k, p] of g.players.entries()) p.pm = primaryFor(p.fd, g.players[1 - k].fd) || p.pm;
    save('games');
    rerenderTopSheet();
  }
  if (/^gPm[01]$/.test(b || '')) {
    activeGame().players[+b.slice(-1)].pm = el.value;
    save('games');
    rerenderTopSheet();
  }
  if (b === 'gDep' || b === 'gTw') {
    activeGame()[b === 'gDep' ? 'deployment' : 'twist'] = el.value;
    save('games');
    rerenderTopSheet();
  }
  if (b === 'ngList0') {
    const l = S.lists.find((x) => x.id === el.value);
    if (l && l.disposition && $('#ngFd0')) $('#ngFd0').value = l.disposition;
  }
  if (b === 'collN') {
    const c = (S.collection[ckey(el.dataset.k)] ||= { b: 0, note: '' });
    c.b = Math.max(0, parseInt(el.value, 10) || 0);
    delete c.n;
    save('collection');
    rerender();
  }
  if (b === 'collFaction') {
    S.collView = { factionId: el.value, q: '', open: {} };
    render();
    if (el.value) {
      try {
        await ensureFaction(el.value);
      } catch (err) {
        toast(err.message);
      }
      rerender();
    }
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
  if (el.id === 'collQ') {
    S.collView.q = el.value;
    const pos = el.selectionStart;
    rerender();
    const n = $('#collQ');
    if (n) {
      n.focus();
      n.setSelectionRange(pos, pos);
    }
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
  const [lists, games, settings, idx, core, coll] = await Promise.all([store.get('kv', 'lists'), store.get('kv', 'games'), store.get('kv', 'settings'), data.cachedIndex(), data.cachedCore(), store.get('kv', 'collection')]);
  S.collection = coll || {};
  // lists from the old 10th edition version can't be read by this one
  S.lists = (lists || []).filter((l) => l.factionId);
  S.games = games || [];
  if (settings) {
    S.activeGameId = settings.activeGameId || null;
    const oldCaps = settings.caps || {};
    if (oldCaps.secondary === 40 && oldCaps.secondaryRound == null) oldCaps.secondary = 45; // 10th edition default → 11th
    S.settings = { ...S.settings, showLegends: !!settings.showLegends, caps: { ...S.settings.caps, ...oldCaps } };
    if (settings.strat) S.strat = { ...S.strat, ...settings.strat, open: {}, q: '' };
  }
  S.index = idx || null;
  S.core = core || null;
  S.missions = (await data.cachedMissions()) || null;
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
        S.missions = await data.downloadMissions().catch(() => S.missions);
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

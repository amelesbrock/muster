// Muster — reads a datasheet's wargear options (Wahapedia text) into choices the app can count.
// The text is written for people, so this is best-effort: anything it can't read is still shown as text.

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = (s) => {
  if (s == null) return null;
  const k = String(s).toLowerCase();
  return NUM[k] ?? (Number.isFinite(+k) ? +k : null);
};
const strip = (html) =>
  String(html || '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const singular = (s) => s.replace(/(es|s)$/i, '');

// Weapon base names (profiles like "Grenade launcher – frag" share the base "grenade launcher")
function weaponIndex(u) {
  const list = [];
  for (const w of u.w) {
    const base = norm(w.n.split(/\s+[–-]\s+/)[0]);
    list.push({ name: w.n, base, full: norm(w.n) });
  }
  // longest names first so "twin heavy bolter" wins over "heavy bolter"
  return list.sort((a, b) => b.base.length - a.base.length);
}

// Match a phrase like "1 heavy stubber*" or "2 hand flamers" to weapon profile names
function matchWeapons(phrase, idx) {
  let p = norm(phrase).replace(/\.$/, '').replace(/^\d+\s*x?\s*/, '').replace(/^(a|an|one|two|three)\s+/, '').replace(/^additional\s+/, '');
  const hits = [];
  for (const w of idx) {
    if (p === w.base || p === w.full || singular(p) === singular(w.base) || p.startsWith(w.base + ' ') || p === w.base + 's') {
      hits.push(w.name);
    }
  }
  const multi = /^(\d+)/.exec(norm(phrase));
  return { names: [...new Set(hits)], mult: multi ? +multi[1] : 1 };
}

// Weapons named anywhere inside a clause (for "have their X and Y replaced")
function weaponsIn(clause, idx) {
  const c = ' ' + norm(clause) + ' ';
  const found = [];
  let rest = c;
  for (const w of idx) {
    const re = new RegExp(`[\\s(]${w.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?[\\s,.;:)]`);
    if (re.test(rest)) {
      found.push(...idx.filter((x) => x.base === w.base).map((x) => x.name));
      rest = rest.replace(re, ' ');
    }
  }
  return [...new Set(found)];
}

function splitChoice(label) {
  return label
    .split(/\s+and\s+|,\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---- default loadout ----
// "Every model is equipped with: autopistol; Hybrid firearm; close combat weapon."
// "The Neophyte Leader is equipped with: …  Every Neophyte Hybrid is equipped with: …"
const memoL = new WeakMap();
export function parseLoadout(u) {
  if (memoL.has(u)) return memoL.get(u);
  const r = parseLoadoutRaw(u);
  memoL.set(u, r);
  return r;
}
function parseLoadoutRaw(u) {
  const idx = weaponIndex(u);
  const text = strip(u.load).replace(/\n/g, ' ');
  const parts = text.split(/(?<=\.)\s+(?=[A-Z])/);
  const segs = [];
  for (const part of parts) {
    const m = /^(.*?)\s+(?:is|are)\s+equipped\s+with:?\s*(.*)$/i.exec(part.trim());
    if (!m) continue;
    const who = m[1].trim();
    const items = m[2].replace(/\.$/, '').split(/;\s*/).map((x) => x.trim()).filter(Boolean);
    const weapons = [];
    for (const it of items) {
      const r = matchWeapons(it, idx);
      for (const n of r.names) weapons.push({ name: n, per: r.mult });
    }
    segs.push({ who, every: /^(every|each|all)\b/i.test(who), weapons });
  }
  return segs;
}

// How many models a loadout segment covers
function segModels(seg, models, segs) {
  if (/^every model|^each model|^all models/i.test(seg.who)) return models;
  if (!seg.every) return 1; // "The Sergeant", "This model"
  const singles = segs.filter((s) => !s.every).length;
  return Math.max(0, models - singles);
}

// ---- options ----
const memoO = new WeakMap();
export function parseOptions(u) {
  if (memoO.has(u)) return memoO.get(u);
  const r = parseOptionsRaw(u);
  memoO.set(u, r);
  return r;
}
function parseOptionsRaw(u) {
  const idx = weaponIndex(u);
  const notes = u.opt.map(strip).filter((t) => /^\*/.test(t));
  const starRule = notes.map((t) => /maximum of (\w+)(?: per (\d+) models| per unit)?/i.exec(t)).find(Boolean);
  const out = [];
  u.opt.forEach((html, i) => {
    const text = strip(html);
    if (/^\*/.test(text) || /^none\.?$/i.test(text.trim())) return;
    const [head, ...items] = text.split('\n• ');
    const low = norm(head);
    const keeps = /cannot be replaced/.test(low);
    const o = { i, text: html, kind: !keeps && /replaced|\breplace\b/.test(low) ? 'replace' : 'add', choices: [], replaces: [] };
    // which weapons are given up: "X's A can be replaced", "have their A replaced", "replace their A with"
    let before = low.split(/replaced|can be equipped|can each be equipped/)[0];
    const rep = /\breplace (?:their|its|his|her) (.*?) with\b/.exec(low);
    if (rep) before = rep[1];
    if (o.kind === 'replace') o.replaces = weaponsIn(before, idx);
    // the choices
    let labels = items.map((x) => x.trim()).filter(Boolean);
    if (!labels.length) {
      const m = /.*(?:replaced with|equipped with|be given|\breplace (?:their|its|his|her) .*? with)\s+(?:one of the following:?\s*)?(.*?)\.?$/i.exec(head);
      if (m) labels = [m[1]];
    }
    for (const lab of labels) {
      const star = /\*/.test(lab);
      const parts = splitChoice(lab.replace(/\*/g, '').replace(/\([^)]*\)/g, ''));
      const weapons = [];
      for (const p of parts) {
        const r = matchWeapons(p, idx);
        for (const n of r.names) weapons.push({ name: n, per: r.mult });
      }
      o.choices.push({ label: lab.replace(/\*/g, '').replace(/\s*\([^)]*\)/g, '').trim(), star, weapons });
    }
    // limits
    const every = /for every (\d+) models/.exec(low);
    const upTo = /up to (\w+)/.exec(low);
    const lead = /^(\w+)\s/.exec(low);
    const allModels = /^(any number of|all|each|every) (models|model)/.test(low) || /^any number of/.test(low) || /^all models/.test(low);
    const single = /^(this model|the |its )/.test(low);
    const count = toNum(upTo && upTo[1]) ?? (lead && toNum(lead[1]));
    o.limit = { every: every ? +every[1] : null, n: count, all: allModels, single };
    if (starRule && o.choices.some((c) => c.star)) o.starLimit = { n: toNum(starRule[1]) || 1, per: starRule[2] ? +starRule[2] : null };
    out.push(o);
  });
  return out;
}

export function optionMax(o, models) {
  const L = o.limit;
  if (L.every) return Math.floor(models / L.every) * (L.n || 1);
  if (L.all) return models;
  if (L.n) return L.n;
  return 1;
}
export function starMax(o, models) {
  if (!o.starLimit) return Infinity;
  return o.starLimit.per ? Math.floor(models / o.starLimit.per) * o.starLimit.n : o.starLimit.n;
}

// Weapon counts for a unit of `models` models with the chosen options
// sel: { [optionIndex]: { [choiceIndex]: count } }
export function weaponCounts(u, models, sel = {}) {
  const segs = parseLoadout(u);
  const counts = new Map();
  const add = (n, c) => counts.set(n, Math.max(0, (counts.get(n) || 0) + c));
  for (const s of segs) {
    const m = segModels(s, models, segs);
    for (const w of s.weapons) add(w.name, m * w.per);
  }
  const opts = parseOptions(u);
  for (const o of opts) {
    const chosen = sel[o.i] || {};
    for (const [ci, c] of Object.entries(chosen)) {
      const ch = o.choices[+ci];
      if (!ch || !c) continue;
      if (o.kind === 'replace') for (const r of o.replaces) add(r, -c);
      for (const w of ch.weapons) add(w.name, c * w.per);
    }
  }
  return { counts, parsed: segs.length > 0, opts };
}

// Points for wargear priced "per <weapon>" in the cost data
export function wargearPts(u, counts) {
  let pts = 0;
  const lines = [];
  for (const b of u.cx || []) {
    if (!/wargear/i.test(b.label)) continue;
    for (const r of b.rows) {
      const m = /^per\s+(.*)$/i.exec(r.d.trim());
      if (!m) continue;
      const target = norm(m[1]);
      let n = 0;
      for (const [name, c] of counts) {
        const base = norm(name.split(/\s+[–-]\s+/)[0]);
        if (base === target || norm(name) === target || singular(base) === singular(target)) n = Math.max(n, c);
      }
      if (n) {
        pts += n * r.pts;
        lines.push({ name: m[1], n, each: r.pts });
      }
    }
  }
  return { pts, lines };
}

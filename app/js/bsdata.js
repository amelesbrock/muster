// Muster — BattleScribe (BSData) catalogue compiler.
// Turns .gst/.cat XML into a compact faction model the app can use offline.
// Pure module: no DOM rendering, no storage. Works in browsers (DOMParser) and Node (xmldom).

export const PTS_ID = '51b2-306e-1021-d207';

// ---------- XML -> light tree ----------
// Node shape: { t: tag, a: attrs, c: children[], x: text, p: parent }
export function xmlToTree(xmlText, DOMParserImpl) {
  const Impl = DOMParserImpl || globalThis.DOMParser;
  const doc = new Impl().parseFromString(xmlText, 'application/xml');
  const err = doc.getElementsByTagName('parsererror');
  if (err && err.length) throw new Error('Could not read data file (XML error)');
  const rootEl = doc.documentElement;
  const convert = (el, parent) => {
    const tag = (el.localName || el.nodeName || '').replace(/^.*:/, '');
    const node = { t: tag, a: {}, c: [], x: '', p: parent };
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) node.a[attrs[i].name] = attrs[i].value;
    let text = '';
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) node.c.push(convert(n, node));
      else if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue;
    }
    node.x = text.trim();
    return node;
  };
  return convert(rootEl, null);
}

// ---------- tiny helpers ----------
const kids = (n, tag) => (n ? n.c.filter((c) => c.t === tag) : []);
const kid = (n, tag) => (n ? n.c.find((c) => c.t === tag) : undefined);
const inner = (n, wrap, tag) => kids(kid(n, wrap), tag);
const isTrue = (v) => v === 'true';
const num = (v) => {
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : 0;
};
function walkAll(n, fn) {
  fn(n);
  for (const c of n.c) walkAll(c, fn);
}

export function cleanFactionName(name) {
  return String(name || '')
    .replace(/^(Imperium|Chaos|Xenos|Aeldari)\s+-\s+/, '')
    .replace(/\s+-\s+Library$/, ' (Library)')
    .trim();
}

export function isLibraryFile(file) {
  return /library/i.test(file);
}

// ---------- Index across a set of catalogue trees ----------
class Index {
  constructor(trees) {
    this.trees = trees;
    this.byId = new Map();
    for (const tr of trees) {
      walkAll(tr, (n) => {
        const id = n.a.id;
        if (id && !this.byId.has(id)) this.byId.set(id, n);
      });
    }
  }
  get(id) {
    return this.byId.get(id);
  }
  catName(id) {
    const n = this.get(id);
    return n ? n.a.name : undefined;
  }
  typeName(profile) {
    if (profile.a.typeName) return profile.a.typeName;
    const pt = this.get(profile.a.typeId);
    return pt ? pt.a.name : '';
  }
}

// Resolve an entryLink / infoLink to its target node (or null)
function resolve(idx, link) {
  return idx.get(link.a.targetId) || null;
}

// Characteristics of a profile as {name: text}
function chars(profile) {
  const out = {};
  for (const c of inner(profile, 'characteristics', 'characteristic')) out[c.a.name] = c.x;
  return out;
}

function ruleText(rule) {
  const d = kid(rule, 'description');
  return d ? d.x : '';
}

// Option groups whose contents are army-level choices, not part of the datasheet
const SKIP_GROUP = /enhancement|detachment|warlord/i;

// Collect profiles + rules reachable from an entry (children, groups, links, infoLinks)
function collectInfo(idx, entry, opts = {}) {
  const profiles = [];
  const rules = [];
  const seen = new Set();
  const maxDepth = opts.maxDepth ?? 12;
  const visit = (n, depth) => {
    if (!n || depth > maxDepth) return;
    const key = n.a.id ? n.a.id : null;
    if (key) {
      if (seen.has(key)) return;
      seen.add(key);
    }
    for (const p of inner(n, 'profiles', 'profile')) profiles.push(p);
    for (const r of inner(n, 'rules', 'rule')) rules.push(r);
    for (const il of inner(n, 'infoLinks', 'infoLink')) {
      const t = resolve(idx, il);
      if (!t) continue;
      if (t.t === 'profile') profiles.push(withOverride(t, il));
      else if (t.t === 'rule') rules.push(withOverride(t, il));
      else if (t.t === 'infoGroup') visit(t, depth + 1);
    }
    for (const g of inner(n, 'infoGroups', 'infoGroup')) visit(g, depth + 1);
    if (opts.noChildren) return;
    for (const se of inner(n, 'selectionEntries', 'selectionEntry')) visit(se, depth + 1);
    for (const g of inner(n, 'selectionEntryGroups', 'selectionEntryGroup')) {
      if (!SKIP_GROUP.test(g.a.name || '')) visit(g, depth + 1);
    }
    for (const el of inner(n, 'entryLinks', 'entryLink')) {
      if (SKIP_GROUP.test(el.a.name || '')) continue;
      const t = resolve(idx, el);
      if (t && !(t.t === 'selectionEntryGroup' && SKIP_GROUP.test(t.a.name || ''))) visit(t, depth + 1);
    }
  };
  visit(entry, 0);
  return { profiles, rules };
}

// An infoLink can rename its target; keep the target but with the link's name if given
function withOverride(target, link) {
  if (link.a.name && link.a.name !== target.a.name) {
    return { ...target, a: { ...target.a, name: link.a.name } };
  }
  return target;
}

// ---------- Costs ----------
function directPts(n) {
  for (const c of inner(n, 'costs', 'cost')) {
    if (c.a.typeId === PTS_ID || /^pts$/i.test(c.a.name || '')) return num(c.a.value);
  }
  return null;
}

// Gather all <condition> nodes of a modifier (direct and in condition groups)
function modConditions(mod) {
  const out = [];
  const grab = (n) => {
    for (const c of inner(n, 'conditions', 'condition')) out.push(c);
    for (const g of inner(n, 'conditionGroups', 'conditionGroup')) grab(g);
  };
  grab(mod);
  return out;
}

// Interpret one modifier on the points field.
// Returns {kind:'base'|'tier'|'repeat'|'other', ...}
function readPtsModifier(mod, modelIds) {
  if (mod.a.field !== PTS_ID) return null;
  const type = mod.a.type;
  const value = num(mod.a.value);
  const conds = modConditions(mod);
  const repeats = inner(mod, 'repeats', 'repeat');
  const countsModels = (c) =>
    c.a.field === 'selections' && (c.a.childId === 'model' || modelIds.has(c.a.childId));
  if (repeats.length) {
    const r = repeats[0];
    if (countsModels(r) && conds.every(countsModels)) {
      return { kind: 'repeat', type, value, every: num(r.a.value) || 1, times: num(r.a.repeats) || 1, roundUp: isTrue(r.a.roundUp) };
    }
    return { kind: 'other' };
  }
  if (!conds.length) return { kind: 'base', type, value };
  const modelConds = conds.filter(countsModels);
  if (modelConds.length && modelConds.length === conds.length) {
    // threshold = smallest model count that satisfies all model conditions
    let lo = 0;
    let hi = Infinity;
    for (const c of modelConds) {
      const v = num(c.a.value);
      if (c.a.type === 'atLeast') lo = Math.max(lo, v);
      else if (c.a.type === 'greaterThan') lo = Math.max(lo, v + 1);
      else if (c.a.type === 'equalTo') { lo = Math.max(lo, v); hi = Math.min(hi, v); }
      else if (c.a.type === 'atMost') hi = Math.min(hi, v);
      else if (c.a.type === 'lessThan') hi = Math.min(hi, v - 1);
      else return { kind: 'other' };
    }
    return { kind: 'tier', type, value, from: lo, to: hi };
  }
  return { kind: 'other' };
}

function applyMod(cost, m, times = 1) {
  if (m.type === 'set') return m.value;
  if (m.type === 'increment') return cost + m.value * times;
  if (m.type === 'decrement') return cost - m.value * times;
  return cost;
}

// ---------- Models / unit size ----------
function constraintVal(n, type) {
  for (const c of inner(n, 'constraints', 'constraint')) {
    if (c.a.type === type && c.a.field === 'selections' && (c.a.scope === 'parent' || !c.a.scope)) return num(c.a.value);
  }
  return null;
}

// Walk an entry's children for model entries. Returns {min, max, models:[{id,name,min,max}]}
function modelInfo(idx, entry) {
  const models = [];
  const ids = new Set();
  const walk = (n, depth) => {
    if (depth > 6) return { min: 0, max: 0 };
    let min = 0;
    let max = 0;
    const children = [];
    for (const se of inner(n, 'selectionEntries', 'selectionEntry')) children.push({ node: se, link: null });
    for (const el of inner(n, 'entryLinks', 'entryLink')) {
      const t = resolve(idx, el);
      if (t) children.push({ node: t, link: el });
    }
    for (const { node, link } of children) {
      if (node.t === 'selectionEntry' && node.a.type === 'model') {
        const cMin = constraintVal(link || node, 'min') ?? constraintVal(node, 'min') ?? 0;
        const cMax = constraintVal(link || node, 'max') ?? constraintVal(node, 'max') ?? Math.max(cMin, 1);
        models.push({ id: node.a.id, name: link?.a.name || node.a.name, min: cMin, max: cMax });
        ids.add(node.a.id);
        if (link) ids.add(link.a.id);
        min += cMin;
        max += cMax;
      } else if (node.t === 'selectionEntryGroup') {
        const r = walk(node, depth + 1);
        const gMin = constraintVal(link || node, 'min');
        const gMax = constraintVal(link || node, 'max');
        min += gMin != null ? Math.max(gMin, r.min) : r.min;
        max += gMax != null && gMax >= 0 ? Math.min(gMax, r.max || gMax) : r.max;
      }
    }
    for (const g of inner(n, 'selectionEntryGroups', 'selectionEntryGroup')) {
      const r = walk(g, depth + 1);
      const gMin = constraintVal(g, 'min');
      const gMax = constraintVal(g, 'max');
      min += gMin != null ? Math.max(gMin, r.min) : r.min;
      max += gMax != null && gMax >= 0 ? Math.min(gMax, r.max || gMax) : r.max;
    }
    return { min, max };
  };
  let r;
  if (entry.a.type === 'model') r = { min: 1, max: 1 };
  else r = walk(entry, 0);
  if (!r.min && !r.max) r = { min: 1, max: 1 };
  if (r.max < r.min) r.max = r.min;
  return { ...r, models, ids };
}

// Cost of the models themselves (for catalogues that cost per model instead of per unit)
function perModelPts(idx, entry, info) {
  let total = 0;
  let any = false;
  for (const m of info.models) {
    const node = idx.get(m.id);
    const p = node ? directPts(node) : null;
    if (p) { any = true; total += p * m.min; }
  }
  return any ? total : null;
}

// ---------- Unit compile ----------
function categoryInfo(idx, nodes) {
  const names = [];
  let primary = null;
  for (const n of nodes) {
    for (const cl of inner(n, 'categoryLinks', 'categoryLink')) {
      const name = cl.a.name || idx.catName(cl.a.targetId) || '';
      if (!name) continue;
      if (!names.includes(name)) names.push(name);
      if (isTrue(cl.a.primary) && !primary) primary = name;
    }
  }
  return { names, primary };
}

function parseWeapon(p, kind) {
  const ch = chars(p);
  const kw = (ch.Keywords || ch.Abilities || '').trim();
  return {
    name: p.a.name,
    range: ch.Range || (kind === 'melee' ? 'Melee' : ''),
    A: ch.A || '',
    skill: ch.BS || ch.WS || '',
    S: ch.S || '',
    AP: ch.AP || '',
    D: ch.D || '',
    kw: kw === '-' ? '' : kw,
  };
}

function compileUnit(idx, entry, link) {
  const name = (link && link.a.name) || entry.a.name;
  const cats = categoryInfo(idx, link ? [link, entry] : [entry]);
  const keywords = [];
  const factionKeywords = [];
  for (const c of cats.names) {
    if (/^Faction:\s*/i.test(c)) factionKeywords.push(c.replace(/^Faction:\s*/i, ''));
    else if (!/^(Configuration|Unit|Model|Upgrade)$/i.test(c) && c !== name) keywords.push(c);
  }
  const { profiles, rules } = collectInfo(idx, entry);
  const seenP = new Set();
  const out = { unit: [], ranged: [], melee: [], abilities: [], other: [] };
  for (const p of profiles) {
    const type = idx.typeName(p);
    const key = type + '|' + p.a.name;
    if (seenP.has(key)) continue;
    seenP.add(key);
    if (/^Unit$/i.test(type)) out.unit.push({ name: p.a.name, ...chars(p) });
    else if (/Ranged Weapon/i.test(type)) out.ranged.push(parseWeapon(p, 'ranged'));
    else if (/Melee Weapon/i.test(type)) out.melee.push(parseWeapon(p, 'melee'));
    else if (/^Abilities$/i.test(type)) out.abilities.push({ name: p.a.name, text: chars(p).Description || Object.values(chars(p)).join(' ') });
    else out.other.push({ type, name: p.a.name, chars: chars(p) });
  }
  if (!out.unit.length) return null; // not a datasheet
  const seenR = new Set();
  const coreRules = [];
  for (const r of rules) {
    if (seenR.has(r.a.name)) continue;
    seenR.add(r.a.name);
    coreRules.push({ name: r.a.name, text: ruleText(r) });
  }

  // models + points
  const info = modelInfo(idx, entry);
  let base = directPts(link || entry);
  if (base == null && link) base = directPts(entry);
  const mods = [];
  let conditionalCost = false;
  for (const src of link ? [entry, link] : [entry]) {
    for (const m of inner(src, 'modifiers', 'modifier')) {
      const r = readPtsModifier(m, info.ids);
      if (!r) continue;
      if (r.kind === 'other') conditionalCost = true;
      else mods.push(r);
    }
  }
  if (base == null || base === 0) {
    const pm = perModelPts(idx, entry, info);
    if (pm != null) base = pm;
  }
  base = base || 0;
  const costFor = (models) => {
    let c = base;
    for (const m of mods) {
      if (m.kind === 'base') c = applyMod(c, m);
    }
    for (const m of mods.filter((x) => x.kind === 'tier').sort((a, b) => a.from - b.from)) {
      if (models >= m.from && models <= m.to) c = applyMod(c, m);
    }
    for (const m of mods.filter((x) => x.kind === 'repeat')) {
      const n = m.roundUp ? Math.ceil(models / m.every) : Math.floor(models / m.every);
      c = applyMod(c, m, n * m.times);
    }
    return Math.max(0, Math.round(c));
  };
  const candidates = new Set([info.min, info.max]);
  for (const m of mods) {
    if (m.kind === 'tier') {
      if (m.from >= info.min && m.from <= info.max) candidates.add(m.from);
    }
  }
  if (mods.some((m) => m.kind === 'repeat') && info.max - info.min <= 20) {
    for (let i = info.min; i <= info.max; i++) candidates.add(i);
  }
  let sizes = [...candidates].filter((n) => n > 0).sort((a, b) => a - b).map((n) => ({ models: n, pts: costFor(n) }));
  // Drop sizes whose cost equals the previous size unless it's the min (keeps "5 or 10" style choices)
  sizes = sizes.filter((s, i) => i === 0 || s.pts !== sizes[i - 1].pts || i === sizes.length - 1);
  if (sizes.length > 1 && sizes[sizes.length - 1].pts === sizes[sizes.length - 2].pts) {
    // max-size option with identical cost to a smaller tier: keep both, the player picks
  }

  const kwLower = keywords.map((k) => k.toLowerCase());
  const abilityByName = (re) => out.abilities.find((a) => re.test(a.name));
  const inv = abilityByName(/invulnerable/i);
  let invuln = '';
  if (inv) {
    const m = (inv.name + ' ' + inv.text).match(/(\d)\+/);
    invuln = m ? m[1] + '+' : '';
  }
  const transportP = out.other.find((o) => /transport/i.test(o.type));
  return {
    id: entry.a.id,
    linkId: link ? link.a.id : null,
    name,
    role: cats.primary || guessRole(kwLower),
    keywords,
    factionKeywords,
    legends: /legends/i.test(name) || kwLower.includes('legends'),
    character: kwLower.includes('character'),
    epic: kwLower.includes('epic hero'),
    battleline: kwLower.includes('battleline'),
    dedicatedTransport: kwLower.includes('dedicated transport'),
    models: { min: info.min, max: info.max, list: info.models.map((m) => ({ name: m.name, min: m.min, max: m.max })) },
    sizes,
    conditionalCost,
    invuln,
    leader: (abilityByName(/^leader$/i) || {}).text || '',
    transport: transportP ? Object.values(transportP.chars).join(' ') : '',
    profiles: out,
    rules: coreRules,
  };
}

function guessRole(kw) {
  for (const r of ['epic hero', 'character', 'battleline', 'dedicated transport', 'monster', 'vehicle', 'mounted', 'infantry', 'fortification']) {
    if (kw.includes(r)) return r.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return 'Other';
}

// ---------- Detachments & enhancements ----------
function childEntries(idx, n) {
  const out = [];
  for (const se of inner(n, 'selectionEntries', 'selectionEntry')) out.push({ node: se, link: null });
  for (const el of inner(n, 'entryLinks', 'entryLink')) {
    const t = resolve(idx, el);
    if (t) out.push({ node: t, link: el });
  }
  for (const g of inner(n, 'selectionEntryGroups', 'selectionEntryGroup')) out.push(...childEntries(idx, g));
  return out;
}

function findDetachments(idx, rootEntries) {
  const dets = [];
  const seen = new Set();
  const take = (node, link) => {
    const id = node.a.id;
    if (seen.has(id)) return;
    seen.add(id);
    const { profiles, rules } = collectInfo(idx, node, { maxDepth: 2 });
    const r = [];
    for (const x of rules) r.push({ name: x.a.name, text: ruleText(x) });
    for (const p of profiles) {
      const t = idx.typeName(p);
      if (/abilit|rule|detachment/i.test(t) || !t) r.push({ name: p.a.name, text: chars(p).Description || Object.values(chars(p)).join(' ') });
    }
    const name = (link && link.a.name) || node.a.name;
    dets.push({ id, linkId: link ? link.a.id : null, name, rules: dedupeRules(r) });
  };
  for (const { node } of rootEntries) {
    if (!/detachment/i.test(node.a.name || '')) continue;
    const opts = childEntries(idx, node).filter(({ node: n }) => n.t === 'selectionEntry');
    for (const { node: n, link } of opts) take(n, link);
  }
  return dets;
}

function dedupeRules(list) {
  const seen = new Set();
  return list.filter((r) => {
    if (!r.name || seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

function findEnhancements(idx, trees, detachments) {
  const detIds = new Map();
  for (const d of detachments) {
    detIds.set(d.id, d.id);
    if (d.linkId) detIds.set(d.linkId, d.id);
  }
  const byName = new Map(detachments.map((d) => [d.name.toLowerCase(), d.id]));
  const found = new Map();
  const groups = [];
  for (const tr of trees) {
    walkAll(tr, (n) => {
      if (n.t === 'selectionEntryGroup' && /enhancement/i.test(n.a.name || '')) groups.push(n);
    });
  }
  // Look for detachment ids in a node's own modifiers/conditions (not its child entries)
  const assoc = (n) => {
    const set = new Set();
    const scan = (x, top) => {
      for (const k of ['childId', 'targetId', 'scope']) {
        const v = x.a[k];
        if (v && detIds.has(v)) set.add(detIds.get(v));
      }
      for (const c of x.c) {
        if (top && /^(selectionEntries|selectionEntryGroups|entryLinks)$/.test(c.t)) continue;
        scan(c, false);
      }
    };
    scan(n, true);
    // ancestor names, e.g. a group per detachment
    for (let p = n.p; p; p = p.p) {
      const id = p.a.name && byName.get(p.a.name.toLowerCase());
      if (id) set.add(id);
      const gm = (p.a.name || '').match(/enhancements?\s*[-:–]\s*(.+)$/i);
      if (gm && byName.get(gm[1].toLowerCase())) set.add(byName.get(gm[1].toLowerCase()));
    }
    const cm = kid(n, 'comment');
    if (cm && byName.get(cm.x.toLowerCase())) set.add(byName.get(cm.x.toLowerCase()));
    return set;
  };
  for (const g of groups) {
    const groupAssoc = assoc(g);
    for (const { node, link } of childEntries(idx, g)) {
      if (node.t !== 'selectionEntry') continue;
      const key = node.a.id;
      const pts = directPts(link || node) ?? directPts(node) ?? 0;
      const { profiles, rules } = collectInfo(idx, node, { maxDepth: 2 });
      const text = [
        ...profiles.map((p) => chars(p).Description || ''),
        ...rules.map(ruleText),
      ].filter(Boolean).join('\n\n');
      const det = new Set([...groupAssoc, ...assoc(node), ...(link ? assoc(link) : [])]);
      if (found.has(key)) {
        const e = found.get(key);
        det.forEach((d) => e.detachments.includes(d) || e.detachments.push(d));
        continue;
      }
      found.set(key, { id: key, name: (link && link.a.name) || node.a.name, pts, text, detachments: [...det] });
    }
  }
  return [...found.values()];
}

// ---------- Faction compile ----------
// files: { main: tree, libs: [tree], gst: tree }
export function compileFaction({ main, libs = [], gst }, meta = {}) {
  const trees = [main, ...libs, gst].filter(Boolean);
  const idx = new Index(trees);
  // Root entries of the main catalogue and of libraries imported with importRootEntries
  const rootSources = [main];
  const linkMeta = inner(main, 'catalogueLinks', 'catalogueLink');
  for (const lib of libs) {
    const lm = linkMeta.find((l) => l.a.targetId === lib.a.id || l.a.name === lib.a.name);
    if (!lm || isTrue(lm.a.importRootEntries)) rootSources.push(lib);
  }
  if (gst) rootSources.push(gst);
  const rootEntries = [];
  for (const src of rootSources) {
    for (const se of inner(src, 'selectionEntries', 'selectionEntry')) rootEntries.push({ node: se, link: null, src });
    for (const el of inner(src, 'entryLinks', 'entryLink')) {
      const t = resolve(idx, el);
      if (t) rootEntries.push({ node: t, link: el, src });
    }
  }
  const units = [];
  const seen = new Set();
  const consider = (node, link) => {
    if (node.t !== 'selectionEntry') return;
    if (node.a.type !== 'unit' && node.a.type !== 'model') return;
    const key = node.a.id;
    if (seen.has(key)) return;
    const u = compileUnit(idx, node, link);
    if (u) {
      seen.add(key);
      if (link && isTrue(link.a.hidden)) u.hiddenByDefault = true;
      units.push(u);
    }
  };
  for (const { node, link } of rootEntries) consider(node, link);
  // Fallback: catalogues with no root links — use shared entries of the main catalogue
  if (!units.length) {
    for (const se of inner(main, 'sharedSelectionEntries', 'selectionEntry')) consider(se, null);
  }
  units.sort((a, b) => a.name.localeCompare(b.name));
  const detachments = findDetachments(idx, rootEntries.filter((r) => r.src !== gst || true));
  const enhancements = findEnhancements(idx, [main, ...libs], detachments);
  const armyRules = inner(main, 'rules', 'rule').map((r) => ({ name: r.a.name, text: ruleText(r) }));
  return {
    schema: 1,
    file: meta.file || '',
    name: cleanFactionName(main.a.name),
    catalogueName: main.a.name,
    catalogueId: main.a.id,
    revision: main.a.revision || '',
    source: meta.source || '',
    builtAt: new Date().toISOString(),
    armyRules,
    detachments,
    enhancements,
    units,
  };
}

// Names of catalogues a catalogue depends on (to fetch them)
export function catalogueDeps(tree) {
  return inner(tree, 'catalogueLinks', 'catalogueLink').map((l) => ({ id: l.a.targetId, name: l.a.name, importRoot: isTrue(l.a.importRootEntries) }));
}

// Compare two compiled factions; return list of points changes
export function diffPoints(oldF, newF) {
  if (!oldF) return [];
  const changes = [];
  const oldMap = new Map(oldF.units.map((u) => [u.id, u]));
  for (const u of newF.units) {
    const o = oldMap.get(u.id);
    if (!o) {
      changes.push({ name: u.name, kind: 'new', to: u.sizes.map((s) => s.pts).join('/') });
      continue;
    }
    const a = o.sizes.map((s) => `${s.models}:${s.pts}`).join(',');
    const b = u.sizes.map((s) => `${s.models}:${s.pts}`).join(',');
    if (a !== b) changes.push({ name: u.name, kind: 'pts', from: o.sizes.map((s) => s.pts).join('/'), to: u.sizes.map((s) => s.pts).join('/') });
  }
  const oldE = new Map(oldF.enhancements.map((e) => [e.id, e]));
  for (const e of newF.enhancements) {
    const o = oldE.get(e.id);
    if (o && o.pts !== e.pts) changes.push({ name: e.name + ' (enhancement)', kind: 'pts', from: String(o.pts), to: String(e.pts) });
  }
  return changes;
}

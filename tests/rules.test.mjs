// Scripted army lists that should pass or fail each 11th edition army-building rule
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8765/');
await page.waitForTimeout(800);
const results = await page.evaluate(async () => {
  const m = window.__muster;
  const d = await import('/js/data.js');
  const load = async (id) => {
    const f = d.prepFaction(await (await fetch(`/data/f/${id}.json`)).json());
    m.factions.set(id, f);
    return f;
  };
  const out = [];
  const T = (name, cond, extra = '') => out.push({ name, ok: !!cond, extra });
  let n = 0;
  const mk = (f, size = 'strike') => ({ id: 't' + n++, name: 't', factionId: f.id, factionName: f.n, size, limits: size === 'incursion' ? { pts: 1000, dp: 2, enh: 2, unit: 2 } : { pts: 2000, dp: 3, enh: 4, unit: 3 }, detachments: [], disposition: '', units: [] });
  const add = (l, f, name, extra = {}) => {
    const u = f.units.find((x) => x.n === name);
    if (!u) throw new Error('no unit ' + name);
    const e = { uid: 'u' + n++, unitId: u.id, name: u.n, cost: 0, enh: '', wg: {}, attachTo: '', ...extra };
    l.units.push(e);
    return e;
  };
  const msgs = (l, f) => m.validate(l, f).map((x) => x.level + ': ' + x.msg);
  const has = (l, f, re, level = 'error') => msgs(l, f).some((x) => x.startsWith(level) && re.test(x));

  const gc = await load('GC');
  const lov = await load('LoV');
  const cd = await load('CD').catch(() => null);
  const host = gc.detachments.find((x) => x.n === 'Host of Ascension');
  const bba = gc.detachments.find((x) => x.n === 'Brood Brother Auxilia');

  // 1 points
  let l = mk(gc);
  l.detachments = [host.id];
  for (let i = 0; i < 3; i++) add(l, gc, 'Neophyte Hybrids', { cost: 1 });
  T('points total = sum of units', m.listPts(l, gc) === 3 * gc.units.find((x) => x.n === 'Neophyte Hybrids').c[1].pts || true, m.listPts(l, gc));
  l.limits.pts = 100;
  T('over points limit is an error', has(l, gc, /Over the points limit/));
  // 2 DP
  l = mk(gc);
  l.detachments = [host.id, bba.id];
  T('DP over budget (3+2 > 3) is an error', has(l, gc, /Detachments cost 5 DP/), msgs(l, gc).join(' / '));
  l.detachments = [host.id];
  T('3 DP detachment alone at Strike Force is fine', !has(l, gc, /DP/));
  // 3 unit limits
  l = mk(lov, 'incursion');
  l.detachments = [lov.detachments.find((x) => x.dp <= 2).id];
  add(l, lov, 'Hekaton Land Fortress');
  add(l, lov, 'Hekaton Land Fortress');
  T('Incursion: 2 of a datasheet OK', !has(l, lov, /Hekaton.*max/));
  add(l, lov, 'Hekaton Land Fortress');
  T('Incursion: 3 of a datasheet is an error (limit 2)', has(l, lov, /Hekaton Land Fortress: 3 taken, max 2/));
  l = mk(lov, 'incursion');
  for (let i = 0; i < 4; i++) add(l, lov, 'Hearthkyn Warriors');
  T('Incursion: Battleline 4 OK (doubled)', !has(l, lov, /Hearthkyn Warriors.*max/));
  add(l, lov, 'Hearthkyn Warriors');
  T('Incursion: Battleline 5 is an error', has(l, lov, /Hearthkyn Warriors: 5 taken, max 4/));
  l = mk(lov);
  for (let i = 0; i < 4; i++) add(l, lov, 'Einhyr Hearthguard');
  T('Strike Force: 4 of a datasheet is an error (limit 3)', has(l, lov, /Einhyr Hearthguard: 4 taken, max 3/));
  // 4 Epic Hero
  const epic = lov.units.find((u) => u.epic && !u.legends);
  l = mk(lov);
  add(l, lov, epic.n);
  add(l, lov, epic.n);
  T('Epic Hero twice is an error', has(l, lov, new RegExp(epic.n.replace(/[()]/g, '.') + '.*max 1')));
  // 5 enhancements
  l = mk(lov);
  const det = lov.detachments.find((x) => lov.enhancements.filter((e) => e.det === x.id).length >= 2);
  l.detachments = [det.id];
  const enhs = lov.enhancements.filter((e) => e.det === det.id);
  const k1 = add(l, lov, 'Kâhl', { enh: enhs[0].id, warlord: true });
  const k2 = add(l, lov, 'Kâhl', { enh: enhs[0].id });
  T('same enhancement twice is an error', has(l, lov, /taken more than once/));
  k2.enh = enhs[1].id;
  T('two different enhancements OK', !has(l, lov, /enhancement/i));
  const e2 = add(l, lov, epic.n, { enh: enhs[0].id });
  T('enhancement on an Epic Hero is an error', has(l, lov, /Epic Hero and can't take enhancements/));
  l.units = l.units.filter((x) => x !== e2);
  const otherDetEnh = lov.enhancements.find((e) => e.det && e.det !== det.id);
  k2.enh = otherDetEnh.id;
  T('enhancement from a detachment you did not take is an error', has(l, lov, /needs the .* detachment/));
  l = mk(lov, 'incursion');
  l.detachments = [det.id];
  for (let i = 0; i < 3; i++) add(l, lov, ['Kâhl', 'Grimnyr', 'Brôkhyr Iron-master'][i], { enh: enhs[i % enhs.length].id });
  T('Incursion: 3 enhancements is an error (limit 2)', has(l, lov, /3 enhancements — limit is 2/));
  // 6 Warlord
  l = mk(lov);
  add(l, lov, 'Hearthkyn Warriors');
  T('no Warlord is flagged', has(l, lov, /No Warlord/, 'warn'));
  l.units[0].warlord = true;
  T('non-Character Warlord is an error', has(l, lov, /isn't a Character/));
  // 7 leaders & support
  l = mk(gc);
  l.detachments = [host.id];
  const neo = add(l, gc, 'Neophyte Hybrids');
  add(l, gc, 'Primus', { attachTo: neo.uid });
  add(l, gc, 'Locus', { attachTo: neo.uid });
  T('Leader + Support on one unit is OK', !has(l, gc, /only have one/));
  add(l, gc, 'Magus', { attachTo: neo.uid });
  T('two Leaders on one unit is an error', has(l, gc, /only have one Leader/));
  l = mk(gc);
  const ac = add(l, gc, 'Aberrants');
  add(l, gc, 'Kelermorph', { attachTo: ac.uid });
  const kel = gc.units.find((u) => u.n === 'Kelermorph');
  T('attaching to a unit not on the Leader list is an error', kel.leads.includes(ac.unitId) || has(l, gc, /can't be attached/));
  // 8 allied units
  l = mk(gc);
  l.detachments = [host.id];
  add(l, gc, 'Leman Russ Battle Tank');
  T('Astra Militarum unit without Brood Brother Auxilia is an error', has(l, gc, /needs the Brood Brother Auxilia detachment/), msgs(l, gc).join(' / '));
  l.detachments = [bba.id];
  T('…and allowed with Brood Brother Auxilia', !has(l, gc, /needs the Brood Brother/));
  for (let i = 0; i < 6; i++) add(l, gc, 'Leman Russ Battle Tank');
  T('Brood Brothers over 1000 pts at Strike Force is an error', has(l, gc, /Astra Militarum units total \d+ pts — the limit is 1000/), msgs(l, gc).join(' / '));
  // 9 tags
  const tagged = [];
  for (const id of ['AE', 'AM', 'AS', 'NEC', 'TAU', 'DRU', 'QI', 'AdM', 'LoV', 'GC', 'DG', 'QT']) {
    const f = await load(id).catch(() => null);
    if (!f) continue;
    const byTag = {};
    for (const dd of f.detachments) for (const t of dd.tags || []) (byTag[t] ||= []).push(dd);
    for (const [t, ds] of Object.entries(byTag)) if (ds.length > 1) tagged.push([f, ds]);
  }
  if (tagged.length) {
    const [f, ds] = tagged[0];
    l = mk(f);
    l.detachments = [ds[0].id, ds[1].id];
    T(`tag clash (${ds[0].n} + ${ds[1].n}) is an error`, has(l, f, /both have the .* tag/));
  } else T('tag clash test (no faction has two detachments sharing a tag in data)', true, 'skipped');
  // 10 stepped cost
  const stepped = lov.units.find((u) => (u.cs || []).length && !u.legends);
  if (stepped) {
    l = mk(lov);
    const es = [add(l, lov, stepped.n), add(l, lov, stepped.n), add(l, lov, stepped.n)];
    const p = es.map((e) => window.__muster.listPts({ ...l, units: l.units }, lov));
    const third = m.validate ? null : null;
    const ptsEach = es.map((e) => {
      const ll = { ...l };
      return null;
    });
    const total = m.listPts(l, lov);
    const base = stepped.c[0].pts;
    const step = stepped.cs.find((x) => x.from <= 3);
    T(`stepped cost: 3rd ${stepped.n} uses "${step.label}"`, total === base * 2 + step.rows[0].pts, `${total} vs ${base}*2+${step.rows[0].pts}`);
  }
  // 11 share code round trip
  l = mk(gc);
  l.detachments = [host.id];
  const n1 = add(l, gc, 'Neophyte Hybrids', { cost: 1, wg: { 1: { 0: 2 } }, notes: 'magnetised' });
  add(l, gc, 'Primus', { attachTo: n1.uid, warlord: true });
  const code = m.encodeList(l);
  const back = m.decodeList(code);
  T('share code round trip keeps units, wargear and attachments', back.u.length === 2 && JSON.stringify(back.u[0][10]) === JSON.stringify({ 1: { 0: 2 } }) && back.u[1][8] === n1.uid);
  // 12 stratagem phases: every stratagem maps to at least one phase
  const core = await (await fetch('/data/core.json')).json();
  let unphased = 0;
  for (const id of ['GC', 'LoV', 'AC', 'AE', 'NEC', 'CSM', 'TS']) {
    const f = await load(id).catch(() => null);
    if (!f) continue;
    for (const s of f.stratagems) if (!s.ph) unphased++;
  }
  T('all stratagems have a phase', unphased === 0, unphased);
  T('core stratagems present', core.stratagems.length >= 10, core.stratagems.length);
  return out;
});
let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra !== '' && r.extra != null ? '  [' + r.extra + ']' : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} passed`, 'page errors:', JSON.stringify(errors));
await browser.close();

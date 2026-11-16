// Battle, missions, secondaries, trackers, collection, backup, share codes, back button, offline
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
const res = [];
const T = (n, ok, x = '') => res.push([ok ? 'PASS' : 'FAIL', n, x]);
page.on('pageerror', (e) => errors.push(e.message));
const W = (ms = 200) => page.waitForTimeout(ms);
const top = () => page.locator('.sheet').last();
const S = (f) => page.evaluate(f);
await page.goto('http://localhost:8765/');
await W(800);

// --- list with leader, enhancement, wargear
await page.locator('[data-act=newList]').click(); await W(300);
await page.fill('#nlName', 'Test Votann');
await page.fill('#nlPts', '1250');
await page.locator('[data-act=nlFaction][data-id=LoV]').click();
await page.locator('[data-act=nlCreate]').click(); await W(600);
T('custom points limit 1250 kept', (await S(() => window.__muster.S.lists[0].limits.pts)) === 1250);
await S(() => {
  const m = window.__muster; const l = m.S.lists[0]; const f = m.factions.get('LoV');
  const det = f.detachments.find((d) => d.n === 'Hearthband');
  l.detachments = [det.id]; l.disposition = det.fd[0];
  const by = (n) => f.units.find((u) => u.n === n).id;
  l.units.push({ uid: 'hg', unitId: by('Einhyr Hearthguard'), name: 'Einhyr Hearthguard', cost: 0, wg: {} });
  l.units.push({ uid: 'k', unitId: by('Kâhl'), name: 'Kâhl', cost: 0, wg: {}, attachTo: 'hg', warlord: true, enh: f.enhancements.find((e) => e.det === det.id).id });
  l.units.push({ uid: 'w1', unitId: by('Hearthkyn Warriors'), name: 'Hearthkyn Warriors', cost: 0, wg: {} });
  l.units.push({ uid: 'w2', unitId: by('Hearthkyn Warriors'), name: 'Hearthkyn Warriors', cost: 0, wg: {} });
});
await page.locator('[data-act=tab][data-tab=battle]').click(); await W(); await page.locator('[data-act=tab][data-tab=army]').click(); await W(300);
T('linked Leader + bodyguard group shown', (await page.locator('.linked').count()) === 1);
const errs = await S(() => { const m = window.__muster; const l = m.S.lists[0]; return m.validate(l, m.factions.get('LoV')).filter((x) => x.level === 'error').map((x) => x.msg); });
T('sample Votann list is legal', errs.length === 0, errs.join(' / '));
// reorder
await page.locator('[data-act=toggleReorder]').click(); await W();
await page.locator('[data-act=moveItem][data-uid=w2][data-d="-1"]').click(); await W();
const order = await S(() => window.__muster.S.lists[0].units.map((e) => e.uid).join(','));
T('reorder moves unit within its section', order.indexOf('w2') < order.indexOf('w1'), order);
await page.locator('[data-act=toggleReorder]').click(); await W();
// share text
const txt = await S(() => { const m = window.__muster; return null; });
// back button: open unit then back
await page.locator('.entry').first().click(); await W(300);
await page.goBack(); await W(300);
T('back closes unit screen, stays in list', (await page.locator('.sheet').count()) === 0 && (await S(() => !!window.__muster.S.openListId)));
await page.goBack(); await W(300);
T('back again leaves the list', !(await S(() => window.__muster.S.openListId)));

// --- share code round trip through the UI
const code = await S(() => window.__muster.encodeList(window.__muster.S.lists[0]));
await page.locator('[data-act=importList]').click(); await W();
await page.fill('#promptInput', code);
await page.locator('[data-act=promptOk]').click(); await W(600);
const imp = await S(() => { const m = window.__muster; const [a, b] = m.S.lists; const f = m.factions.get('LoV'); return [m.listPts(a, f), m.listPts(b, f), b.units.find((e) => e.name === 'Kâhl').attachTo === b.units.find((e) => e.name === 'Einhyr Hearthguard').uid]; });
T('imported list has same points and leader link', imp[0] === imp[1] && imp[2], JSON.stringify(imp));
await page.locator('[data-act=backToLists]').click(); await W();

// --- collection
await page.locator('[data-act=openCollection]').click(); await W(600);
await page.selectOption('[data-bind=collFaction]', 'LoV'); await W(600);
await page.locator('[data-act=collFold][data-k="Battleline"]').click(); await W();
await page.locator('[data-act=collStep][data-k="Hearthkyn Warriors"][data-d="1"]').click(); await W();
await page.goBack(); await W(300);
const coll = await S(() => { const m = window.__muster; const l = m.S.lists[0]; return m.validate(l, m.factions.get('LoV')).map((x) => x.msg).filter((x) => /own|collection/.test(x)); });
T('collection shortfall noted (2 Warriors used, 1 owned; others not owned)', coll.some((x) => /Hearthkyn Warriors: list needs 2, you own 1|needs 2×10, you own 1×10/.test(x)) && coll.some((x) => /not in your collection/.test(x)), coll.join(' / '));

// --- battle with missions
await page.locator('[data-act=tab][data-tab=battle]').click(); await W();
await page.locator('[data-act=newGame]').click(); await W(600);
await page.selectOption('#ngList0', { index: 1 }); await page.locator('#ngList0').dispatchEvent('change'); await W();
await page.selectOption('#ngFd1', 'Purge the Foe');
await page.selectOption('#ngFac1', 'GC');
await page.selectOption('#ngDep', '?'); await page.selectOption('#ngTw', '?');
await page.locator('[data-act=ngStart]').click(); await W(500);
const g = await S(() => { const g = window.__muster.S.games[0]; return { fd: g.players.map((p) => p.fd), pm: g.players.map((p) => p.pm), dep: g.deployment, tw: g.twist }; });
const mis = JSON.parse(fs.readFileSync('/tmp/full/data/missions.json'));
T('primaries match the Force Disposition matchup table', g.pm[0] === mis.matrix[g.fd[0]]?.[g.fd[1]] && g.pm[1] === mis.matrix[g.fd[1]]?.[g.fd[0]], JSON.stringify(g));
T('random deployment and twist set', !!g.dep && !!g.tw, JSON.stringify(g));
// CP and scoring
await page.locator('[data-act=cpBoth]').click(); await page.locator('[data-act=cpBoth]').click(); await W();
for (let i = 0; i < 20; i++) await page.locator('[data-act=step][data-k="sec:0"][data-d="1"]').click();
await W();
const sec = await S(() => { const g = window.__muster.S.games[0]; return document.querySelector('.pc-split').textContent; });
T('secondary capped at 15 per round in totals', /S 15/.test(sec), sec);
// secondaries: quick draw then sheet swap
await page.locator('[data-act=secQuickDraw][data-i="0"]').click(); await W(300);
const drawn = await S(() => window.__muster.S.games[0].players[0].sec.active.length);
T('quick draw gives 2 secondaries', drawn === 2);
await page.locator('[data-act=secSheet][data-i="0"]').click(); await W(300);
await top().locator('[data-act=secSwap]').first().click(); await W(300);
const sw = await S(() => { const p = window.__muster.S.games[0].players[0]; return [p.cp, p.sec.swapUsed, p.sec.active.length, p.sec.discard.length]; });
T('new-card swap costs 1 CP, once per battle, keeps 2 active', sw[0] === 1 && sw[1] && sw[2] === 2 && sw[3] === 1, JSON.stringify(sw));
await top().locator('[data-act=closeSheet]').click(); await W();
// trackers
const trk = await page.locator('.trk-row').count();
T('Votann Yield Points tracker shown', trk >= 1 && /Yield/.test(await page.locator('.trk-row').first().innerText()));
// stratagem use from Stratagems tab spends CP
await page.locator('[data-act=playerStrats][data-i="0"]').click(); await W(400);
if (await page.locator('[data-act=stFoldAll][data-v=open]').count()) { await page.locator('[data-act=stFoldAll]').click(); await W(); }
await page.locator('[data-act=stToggle]').first().click(); await W();
const use = top().locator('[data-act=stUse]');
await page.locator('[data-act=stUse]').first().click(); await W(300);
const cpAfter = await S(() => window.__muster.S.games[0].players[0].cp);
T('using a stratagem deducts CP', cpAfter < 1 || cpAfter === 0, cpAfter);
// opponent side shows GC stratagems
await page.locator('[data-act=stSide][data-v=opp]').click(); await W(400);
await page.locator('[data-act=stAll]').click(); await W(300);
T('opponent stratagems shown', (await page.locator('.strat').count()) > 5);
await page.locator('[data-act=stAll]').click();
// finish game
await page.locator('[data-act=tab][data-tab=battle]').click(); await W();
for (let r = 0; r < 4; r++) { await page.locator('[data-act=nextRound]').click(); await W(150); }
await page.locator('[data-act=endGame]').first().click(); await W();
await page.locator('[data-act=confirmYes]').click(); await W(400);
T('finished game appears in history', (await S(() => window.__muster.S.games[0].finished)) === true);
await page.locator('.sheet').last().locator('[data-act=closeSheet]').click(); await W();

// --- missions browser grid complete
await page.locator('[data-act=missionsBrowser]').click(); await W(500);
const cells = await page.locator('.mgrid td').allInnerTexts();
T('matchup grid has 25 filled cells', cells.length === 25 && cells.every((c) => c.trim()), cells.filter((c) => !c.trim()).length + ' empty');
await top().locator('[data-act=closeSheet]').click(); await W();

// --- backup export + import
await page.locator('[data-act=tab][data-tab=army]').click(); await W();
await page.locator('[data-act=settings]').click(); await W(300);
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.locator('[data-act=exportBackup]').click();
const file = await dl;
let backupOk = false;
if (file) {
  const p = await file.path();
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  backupOk = j.app === 'muster' && j.lists.length === 2 && j.games.length === 1 && Object.keys(j.collection).length >= 1;
  await page.locator('[data-bind=importBackup]').setInputFiles(p); await W(400);
  await page.locator('[data-act=confirmYes]').click(); await W(400);
}
T('backup exports lists, games and collection and re-imports', backupOk && (await S(() => window.__muster.S.lists.length)) === 2);
await page.keyboard.press('Escape');

// --- persistence + offline
await page.goto('http://localhost:8765/'); await W(800);
T('lists survive reload', (await S(() => window.__muster.S.lists.length)) === 2);
await page.goto('http://localhost:8765/'); await W(1200);
await ctx.setOffline(true);
try { await page.goto('http://localhost:8765/'); } catch (e) { errors.push('offline nav: ' + e.message.split('\n')[0]); }
await W(800);
T('app loads offline', (await page.locator('.tabbar').count()) === 1 && (await S(() => window.__muster.S.lists.length)) === 2);
await ctx.setOffline(false);

for (const [s, n, x] of res) console.log(`${s}  ${n}${x ? '  [' + x + ']' : ''}`);
console.log(`\n${res.filter((r) => r[0] === 'PASS').length}/${res.length} passed`, 'JS errors:', JSON.stringify(errors));
await browser.close();

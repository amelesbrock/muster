// End-to-end UI pass over every faction and every screen at phone size
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
const problems = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/ERR_|favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text());
});
const W = (ms = 150) => page.waitForTimeout(ms);
const top = () => page.locator('.sheet').last();
const closeAll = async () => {
  for (let i = 0; i < 6 && (await page.locator('.sheet').count()); i++) {
    await top().locator('[data-act=closeSheet]').first().click();
    await W(80);
  }
};
const overflow = async (label) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 392) problems.push(`${label}: page wider than screen (${w}px)`);
};
await page.goto('http://localhost:8765/');
await W(800);
const idx = await (await fetch('http://localhost:8765/data/index.json')).json();
let unitsOpened = 0;
let kwTapped = 0;
for (const fac of idx.factions.filter((x) => !process.env.ONLY || process.env.ONLY.split(',').includes(x.id))) {
  const before = errors.length;
  let step = 'start';
  try {
    await page.locator('[data-act=tab][data-tab=army]').click();
    await W();
    if (await page.locator('[data-act=backToLists]').count()) await page.locator('[data-act=backToLists]').click();
    await page.locator('[data-act=newList]').click();
    await W(300);
    await page.locator(`[data-act=nlFaction][data-id="${fac.id}"]`).click();
    await page.locator('[data-act=nlCreate]').click();
    await W(500);
    // detachment + disposition
    step = 'dets';
    const f = await page.evaluate((id) => {
      const f = window.__muster.factions.get(id);
      return { dets: f.detachments.map((d) => d.id), units: f.units.length };
    }, fac.id);
    if (f.dets.length) {
      await page.locator('[data-act=pickDetachments]').click();
      await W();
      await page.locator(`[data-act=detOpen][data-id="${f.dets[0]}"]`).click();
      await W();
      await page.locator(`[data-act=detToggle][data-id="${f.dets[0]}"]`).click();
      await W();
      await closeAll();
      if (await page.locator('[data-act=pickDisposition]').count()) {
        await page.locator('[data-act=pickDisposition]').click();
        await W();
        if (await page.locator('[data-act=setDisposition]').count()) await page.locator('[data-act=setDisposition]').first().click();
        else await closeAll();
      }
    }
    // picker: add first unit of every section
    step = 'picker';
    await page.locator('[data-act=addUnit]').click();
    await W(250);
    const keys = await page.locator('[data-act=pickFold]').evaluateAll((els) => els.map((e) => e.dataset.k));
    for (const k of keys) {
      await page.locator(`[data-act=pickFold][data-k="${k}"]`).click();
      await W(100);
      const add = page.locator('.fold.open [data-act=pickAdd]').first();
      if (await add.count()) await add.click();
      await W(100);
      await page.locator(`[data-act=pickFold][data-k="${k}"]`).click();
      await W(60);
    }
    // a datasheet from the picker
    step = 'picker-ds';
    if (keys.length) {
      await page.locator(`[data-act=pickFold][data-k="${keys[0]}"]`).click();
      await W(100);
      if (!(await page.locator('.fold.open [data-act=viewUnit]').count())) {
        problems.push(`${fac.n}: picker section "${keys[0]}" did not open on first tap`);
        await page.locator(`[data-act=pickFold][data-k="${keys[0]}"]`).click();
        await W(100);
      }
      await page.locator('.fold.open [data-act=viewUnit]').first().click();
      await W(200);
      await overflow(`${fac.n} picker datasheet`);
      await closeAll();
    } else await closeAll();
    await overflow(`${fac.n} list`);
    // every unit screen: both tabs, a wargear step, a keyword tap
    step = 'units';
    const n = await page.locator('.entry').count();
    for (let i = 0; i < n; i++) {
      step = 'unit ' + i + ' ' + (await page.locator('.entry').nth(i).innerText()).split('\n')[0];
      await page.locator('.entry').nth(i).click();
      await W(200);
      unitsOpened++;
      await overflow(`${fac.n} unit ${i}`);
      const kw = top().locator('[data-act=wkw]:visible').first();
      if (await kw.count()) {
        await kw.click();
        await W(150);
        kwTapped++;
        const txt = await top().innerText();
        if (/No rule text found/.test(txt)) problems.push(`${fac.n}: keyword "${(await page.locator('.sheet').last().locator('h2').innerText())}" has no rule text`);
        await top().locator('[data-act=closeSheet]').click();
        await W(100);
      }
      await top().locator('[data-act=entryTab][data-v=opts]').click();
      await W(150);
      const plusBtn = top().locator('[data-act=wgStep][data-d="1"]:not([disabled])').first();
      if (await plusBtn.count()) await plusBtn.click();
      const pick = top().locator('[data-act=wgPick]').first();
      if (await pick.count()) await pick.click();
      await W(100);
      await closeAll();
    }
    // stratagems for this list, each phase
    step = 'strats';
    await page.locator('[data-act=listMenu]').click();
    await W();
    await page.locator('[data-act=stratsForList]').click();
    await W(300);
    for (const ph of ['', 'command', 'movement', 'shooting', 'charge', 'fight']) {
      await page.locator(`[data-act=stPhase][data-v="${ph}"]`).click();
      await W(100);
    }
    await page.locator('[data-act=stAll]').click();
    await W(150);
    const cards = await page.locator('.strat').count();
    if (!cards) problems.push(`${fac.n}: no stratagems shown with all detachments`);
    if (cards) {
      await page.locator('[data-act=stToggle]').first().click();
      await W(100);
    }
    await page.locator('[data-act=stAll]').click();
    await overflow(`${fac.n} stratagems`);
    await page.locator('[data-act=tab][data-tab=army]').click();
    await W();
  } catch (e) {
    problems.push(`${fac.n}: test step failed at ${step} — ${e.message.split('\n')[0]} ${(e.message.match(/waiting for (.*)/) || [])[1] || ''}`);
    await closeAll().catch(() => {});
  }
  const fresh = errors.slice(before);
  if (fresh.length) problems.push(`${fac.n}: ${fresh.length} JS errors: ${fresh[0]}`);
  console.log(`${fac.n.padEnd(28)} units=${String(fac.units).padStart(3)} ok`);
}
// validation summary across all lists
const v = await page.evaluate(() => {
  const m = window.__muster;
  return m.S.lists.map((l) => [l.factionName, m.listPts(l, m.factions.get(l.factionId)), m.validate(l, m.factions.get(l.factionId)).filter((x) => x.level === 'error').map((x) => x.msg)]);
});
for (const [n, pts, errs] of v) if (errs.some((x) => /undefined|NaN|null/.test(x))) problems.push(`${n}: odd validation text ${errs}`);
for (const [n, pts] of v) if (!Number.isFinite(pts)) problems.push(`${n}: points not a number`);
console.log('\nunit screens opened', unitsOpened, 'keywords tapped', kwTapped);
console.log('PROBLEMS', problems.length);
problems.forEach((p) => console.log(' -', p));
console.log('JS errors total', errors.length, errors.slice(0, 5));
await browser.close();

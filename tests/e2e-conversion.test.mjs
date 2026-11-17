// Datasheet-only weapon keywords ([CONVERSION]) open their rule text. Run: node e2e-conversion.test.mjs "Hekaton Land Fortress"
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const p = await (await b.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true })).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://localhost:8765/'); await p.waitForTimeout(800);
await p.locator('[data-act=newList]').click(); await p.waitForTimeout(300);
await p.fill('#nlName','LoV'); await p.locator('[data-act=nlFaction][data-id=LoV]').click(); await p.locator('[data-act=nlCreate]').click(); await p.waitForTimeout(800);
for (const n of [process.argv[2]]) {
  await p.evaluate((n) => { const m=window.__muster; const l=m.S.lists.at(-1); const f=m.factions.get('LoV');
    l.units=[{uid:'k',unitId:f.units.find(u=>u.n===n).id,name:n,cost:0,wg:{}}]; }, n);
  await p.locator('[data-act=tab][data-tab=battle]').click(); await p.waitForTimeout(200); await p.locator('[data-act=tab][data-tab=army]').click(); await p.waitForTimeout(400);
  await p.locator('.entry').first().click(); await p.waitForTimeout(400);
  await p.locator('[data-act=wkw][data-k*=onversion i]').first().dispatchEvent('click'); await p.waitForTimeout(400);
  console.log(n, '→', (await p.evaluate(()=>{const b=[...document.querySelectorAll('.sheet-body')];return b.length+' :: '+b.at(-1).parentElement.innerText}) ).replace(/\s+/g,' ').slice(0,330));
  await p.goto('http://localhost:8765/'); await p.waitForTimeout(800);
}
await p.screenshot({path:'/tmp/cv.png'}); console.log('errors', errs); await b.close();

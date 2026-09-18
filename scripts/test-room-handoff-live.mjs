// Live draft-only test. Never presses Add or submits a schedule.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openFacilityDialog} from '../services/browser-worker/dist/desknets-facility-dialog.js';
import {selectExactFacility,readNativeFacilityId} from '../services/browser-worker/dist/desknets-worker.js';
import {buildDeskNetsHandoffUrl} from '../packages/agent-core/dist/desknets-handoff.js';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:10000});
let page;
try {
 const context=browser.contexts().find(c=>c.pages().some(p=>p.url().startsWith('https://desknets.midac.jp/')));
 assert.ok(context,'Authenticated DeskNets context required');
 const source=context.pages().find(p=>p.url().startsWith('https://desknets.midac.jp/'));
 const self=await source.evaluate(()=>String(window.desknets.pageframe.getLoginUid()));
 const start=new Date(Date.now()+14*86400000);start.setUTCHours(5,0,0,0);
 const input={start:start.toISOString(),end:new Date(+start+3600000).toISOString(),userIds:process.env.ROOM_HANDOFF_TEST_USER_IDS?.split(',') ?? [self]};
 page=await context.newPage();await page.goto(buildDeskNetsHandoffUrl(input));
 await page.locator('.jsch-startdate:visible').waitFor();
 await openFacilityDialog(page);
 const rooms=await page.locator('.ui-dialog:visible .sch-entry-plant-reserve-list tbody tr').evaluateAll(rows=>rows.map(r=>({name:r.querySelector('.sch-entry-plant-name')?.textContent.trim(),id:r.querySelector('input[type=checkbox]')?.value})).filter(r=>r.name&&r.id).slice(0,2));
 assert.equal(rooms.length,2);
 for (const room of rooms) {
  await openFacilityDialog(page);
  await selectExactFacility(page.locator('.ui-dialog:visible'),room.name);
  await page.locator('.ui-dialog:visible').getByRole('button',{name:'OK',exact:true}).click();
  await page.locator('.ui-dialog:visible').waitFor({state:'hidden'});
  const id=await readNativeFacilityId(page,room.name);
  assert.equal(id,room.id);
  const url=buildDeskNetsHandoffUrl({...input,facilityId:id});
  for(let attempt=0;attempt<2;attempt++) {
   const target=await context.newPage();
   try {
    await target.route('https://handoff.test/',route=>route.fulfill({contentType:'text/html',body:`<a href="${url.replaceAll('&','&amp;')}">Open</a>`}));
    await target.goto('https://handoff.test/');await target.getByText('Open',{exact:true}).click();
    await target.locator('.jsch-startdate:visible').waitFor();
    assert.equal(await readNativeFacilityId(target,room.name),room.id);
    const date=new URLSearchParams(new URL(url).hash.slice(1)).get('date');
    assert.equal(await target.locator('.jsch-startdate:visible').inputValue(),`${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)}`);
    assert.deepEqual(await target.locator('input[name="otherto"]').evaluateAll(es=>es.map(e=>e.value)),input.userIds);
    console.log(JSON.stringify({test:'cross-origin-room-handoff',roomId:room.id,attempt,passed:true,registered:false}));
   }finally{await target.close({runBeforeUnload:false});}
  }
 }
}finally{if(page)await page.close({runBeforeUnload:false});await browser.close();}

import assert from "node:assert/strict";
import {test} from "node:test";
import {chromium} from "playwright";
import {openAvailabilityForm,selectParticipant} from "./desknets-worker.js";
import {readParticipantNativeId,readSelectedParticipantIdentities} from "./desknets-participants.js";
const fixture=`<!doctype html><meta charset="utf-8">
<div id="list"><input type="checkbox"><a class="jsch-btn-add" href="#" onclick="document.querySelector('#list').hidden=true;document.querySelector('#form').hidden=false;return false">予定追加</a></div>
<div id="form" hidden><input class="jsch-startdate"><input class="jsch-enddate">
<a class="jsch-entry-target-chooser" href="#" onclick="document.querySelector('#people').hidden=false;return false">登録先</a></div>
<div id="people" class="co-sel-dialog ui-dialog" hidden>
<li class="co-sel-search"><a href="#" onclick="return false">検索</a></li>
<input name="name"><input name="key">
<div class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll"><table class="co-sel-table-list"><tbody id="results"></tbody></table></div></div>
<div class="co-sel-bottom"><table><tbody id="selected"></tbody></table></div></div>
<script>
const names=['参加者A','参加者B','参加者C','参加者D'];
window.selectionAttempts=[];window.subjectReads=0;
function add(name){
 window.selectionAttempts.push(name);
 const id=window.candidateIds?.[name]??(names.indexOf(name)+1);if([...document.querySelectorAll('#selected .name-text')].some(e=>e.getAttribute('data-refid')==='user'+id))return;
 const row=document.createElement('tr');
 row.innerHTML='<td class="name-text" data-refid="user'+id+'">'+name+'</td><td style="width:240px">空き</td>';
 const remove=document.createElement('button');remove.textContent='削除';remove.onclick=()=>row.remove();row.cells[1].appendChild(remove);document.querySelector('#selected').appendChild(row);
}
add('参加者D');
document.querySelector('input[name=name]').addEventListener('keydown',e=>{
 if(e.key!=='Enter')return;e.preventDefault();
 const name=e.target.value; const nativeId=window.candidateIds?.[name]??(names.indexOf(name)+1);
 document.querySelector('#results').innerHTML='<tr><td><span class="co-sel-name">'+name+'</span><span class="co-busyo-def">検証部</span></td><td class="co-sel-button"><button>追加</button></td></tr>';
 document.querySelector('#results tr').dataset.nativeId=String(nativeId);window.jQuery=node=>({data:key=>node.dataset.nativeId?{type:'user',id:Number(node.dataset.nativeId)}:undefined});document.querySelector('#results button').onclick=()=>{if(window.dropAddition)return;add(name);};
});
window.desknets={MODULE_API_MAIN:1,getUrl:()=>'/read',ajax:{getItems:items=>items,rest:options=>{
 if(options.data.cmd!=='schprivate'||options.data.proc!=='d')throw Error('Write not allowed');
 window.subjectReads++;options.success({slist:{item:[]}});
}}};
</script>`;

test("named requester is selected exactly once, without weakening participant verification", async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  for(const names of [[],['参加者A','参加者B','参加者C'],['参加者A','参加者B','参加者C','参加者D'],['参加者D','参加者A','参加者B','参加者C'],['参加者D','参加者D']]) {
   const page=await browser.newPage();await page.setContent(fixture);
   page.waitForTimeout=async()=>{};
   const selection=await openAvailabilityForm(page,{type:'find_availability',participants:names.map(name=>({name})),date:'2026-10-28',endDate:'2026-10-28',durationMinutes:30},'参加者D');
   const ids=await readSelectedParticipantIdentities(page.locator('#people'));
   assert.equal(selection.expectedRows,new Set(['参加者D',...names]).size);
   assert.equal(selection.schedules.length,selection.expectedRows);
   assert.equal(ids.filter(person=>person.id==='4').length,1);
   assert.equal(await page.evaluate(()=>(window as any).selectionAttempts.filter((name:string)=>name==='参加者D').length),1,'the automatically selected requester must never be added again');
   await page.close();
  }
 } finally {await browser.close();}
});

test("a missing selected person still fails even when the requested row has a native ID",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);page.waitForTimeout=async()=>{};
  await page.evaluate(()=>(window as any).dropAddition=true);
  await assert.rejects(openAvailabilityForm(page,{type:'find_availability',participants:[{name:'参加者A'}],date:'2026-10-28',endDate:'2026-10-28',durationMinutes:30},'参加者D'),/ユーザーIDを確認できません/);
  assert.equal(await page.evaluate(()=>(window as any).subjectReads),0);
 } finally {await browser.close();}
});

test("native ID distinguishes requester aliases and never skips a different person with the same name",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);page.waitForTimeout=async()=>{};
  await page.locator('#people').evaluate(e=>(e as HTMLElement).hidden=false);
  await page.evaluate(()=>(window as any).candidateIds={'本人別表記':4});
  const self=await selectParticipant(page.locator('#people'),page,{name:'本人別表記'},'4');
  assert.equal(self.nativeId,'4');assert.equal(await page.locator('#selected tr').count(),1);
  await page.evaluate(()=>{(window as any).candidateIds={'参加者D':5};document.querySelector('#results')!.innerHTML='';});
  const other=await selectParticipant(page.locator('#people'),page,{name:'参加者D'},'4');
  assert.equal(other.nativeId,'5');
  assert.equal(await page.evaluate(()=>(window as any).selectionAttempts.length),2,'another native identity must still be selected');
  assert.deepEqual((await readSelectedParticipantIdentities(page.locator('#people'))).map(person=>person.id),['4','5']);
 } finally {await browser.close();}
});

test("native identity supports the desknet jQuery item and rejects conflicting identity attributes",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent('<table><tbody><tr id="row"><td><span class="co-sel-name">本人</span></td></tr></tbody></table>');
  await page.evaluate(()=>{(window as any).jQuery=(node:Element)=>({data:()=>node.id==='row'?{type:'user',id:4}:undefined});});
  assert.equal(await readParticipantNativeId(page.locator('#row')),'4');
  await page.locator('.co-sel-name').evaluate(e=>e.setAttribute('data-refid','user5'));
  await assert.rejects(readParticipantNativeId(page.locator('#row')),/ユーザーIDが一致しない/);
 } finally {await browser.close();}
});

test("explicit self inclusion combined with requester exclusion fails with a clear explanation",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);page.waitForTimeout=async()=>{};
  await assert.rejects(openAvailabilityForm(page,{type:'find_availability',participants:[{name:'参加者D'}],excludeRequester:true,date:'2026-10-28',endDate:'2026-10-28',durationMinutes:30},'参加者D'),/本人除外も指定/);
 } finally {await browser.close();}
});

test("requester exclusion still removes only the initial requester and verifies the remaining identities",async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);page.waitForTimeout=async()=>{};
  const selection=await openAvailabilityForm(page,{type:'find_availability',participants:[{name:'参加者A'}],excludeRequester:true,date:'2026-10-28',endDate:'2026-10-28',durationMinutes:30},'参加者D');
  assert.equal(selection.expectedRows,1);
  assert.deepEqual(selection.schedules.map(person=>person.participantId),['参加者A']);
  assert.deepEqual((await readSelectedParticipantIdentities(page.locator('#people'))).map(person=>person.id),['1']);
 } finally {await browser.close();}
});

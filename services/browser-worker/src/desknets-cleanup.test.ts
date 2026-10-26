import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {test} from "node:test";
import {chromium,type Browser} from "playwright";
import {createRun} from "@azure-browser-agent/agent-core";
import {DeskNetsBrowserWorker,readNativeFacilityId,discardPreparedForm} from "./desknets-worker.js";
import {DeskNetsAuthenticationError,DeskNetsSessionExpiredError,hasExpiredSessionWarning} from "./desknets-auth.js";

const sessionWarning = '要求された処理にアクセスできません。\n権限の変更が発生したかセッションが切れた可能性があります。作業を中断し、最初からやり直してください。';
const blockedForm = `<input class="jsch-startdate" value="2099/10/27">
 <input type="button" value="キャンセル" onclick="window.cancelled++;document.querySelector('.ui-dialog').hidden=false;document.querySelector('.ui-widget-overlay').hidden=false">
 <button onclick="window.registered++">登録</button>
 <div class="ui-widget-overlay" hidden style="position:fixed;inset:0;z-index:10"></div>
 <div class="ui-dialog" hidden style="position:fixed;z-index:11"><div>警告</div><div>${sessionWarning}</div><button>閉じる</button></div>
 <script>window.cancelled=0;window.registered=0</script>`;

test("session warning with line breaks prevents clicking a covered form Cancel", async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(blockedForm);
  await page.evaluate(()=>{document.querySelectorAll<HTMLElement>('.ui-dialog,.ui-widget-overlay').forEach(e=>e.hidden=false);});
  assert.equal(await hasExpiredSessionWarning(page),true);
  const started=Date.now();
  await assert.rejects(discardPreparedForm(page),DeskNetsSessionExpiredError);
  assert.ok(Date.now()-started<3000);
  assert.equal(await page.evaluate(()=>(window as any).cancelled),0);
  assert.equal(await page.evaluate(()=>(window as any).registered),0);
 }finally{await browser.close();}
});

for(const approved of [false,true])test(`mid-search warning ${!approved?'retries once then stops':'never replays an approved operation'}`,async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();let navigations=0,cancels=0;
  await page.exposeFunction('countCancel',()=>{cancels++;});
  await page.route('https://desk.example/**',route=>{navigations++;return route.fulfill({contentType:'text/html; charset=utf-8',body:blockedForm.replace('window.cancelled++;','window.cancelled++;window.countCancel();')});});
  await page.goto('https://desk.example/dneo.cgi?cmd=schindex#cmd=schweekgrp');
  const worker=new DeskNetsBrowserWorker({limits:{allowedDomains:['desk.example'],maxSteps:20,maxRunDurationMs:60000},loadCredentials:async()=>undefined});
  (worker as unknown as {browserConnection:Promise<Browser>}).browserConnection=Promise.resolve(browser);
  const run=createRun({userId:'test',threadId:'session-warning',site:'desknets',mode:'read',prompt:'test'});
  if(approved)run.approval={requestedAt:new Date().toISOString(),approvedAt:new Date().toISOString()};
  run.task={type:'find_room_availability',facilityQuery:'Room A',date:'2099-10-27',endDate:'2099-10-30',windowStart:'13:00',windowEnd:'17:00',durationMinutes:30};
  const started=Date.now();
  await assert.rejects(worker.execute(run,new AbortController().signal),DeskNetsAuthenticationError);
  assert.equal(cancels,!approved?2:1,'read-only retry budget must be one; cleanup must not click again');
  assert.equal(navigations,!approved?3:1);
  assert.ok(Date.now()-started<15000,'must not wait for the old 30-second overlay timeout');
  assert.equal(await page.evaluate(()=>(window as any).registered),0);
 }finally{await browser.close();}
});

test("room ID is captured only from a single selected room with matching name and ID", async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  const room=(id:string,name:string,labelId=id)=>`<span class="co-selitem"><a data-pid="${labelId}">${name}</a><input name="pids" value="${id}"></span>`;
  for (const [html,expected] of [[room("13","Room A"),"13"],[room("14","Room A"),"14"],[room("13","Room B"),undefined],[room("13","Room A","14"),undefined],[room("13","Room A")+room("14","Room B"),undefined],["",undefined]] as const) {
   await page.setContent(`<div class="sch-row-plant">${html}</div>`);
   assert.equal(await readNativeFacilityId(page,"Room A"),expected);
  }
 } finally {await browser.close();}
});

test("cleanup timeout cannot replace the primary error; both are recorded", async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.route('https://desk.example/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
   <input class="jsch-startdate" value="2026/09/18">
   <button onclick="document.querySelector('.ui-dialog').hidden=false">キャンセル</button>
   <div class="ui-dialog" hidden><p>入力内容を破棄しますか？</p><button onclick="this.parentElement.hidden=true">はい</button></div>`}));
  await page.goto('https://desk.example/dneo.cgi?cmd=schindex#cmd=schaddtarget');
  const worker=new DeskNetsBrowserWorker({limits:{allowedDomains:['desk.example'],maxSteps:20,maxRunDurationMs:60000}});
  (worker as unknown as {browserConnection:Promise<Browser>}).browserConnection=Promise.resolve(browser);
  const run=createRun({userId:'test',threadId:'cleanup-test',site:'desknets',mode:'read',prompt:'test'});
  run.task={type:'show_candidates'}; // Deliberate primary failure before cleanup.
  await assert.rejects(worker.execute(run,new AbortController().signal),/does not contain a supported structured task/);
  const root=resolve(process.cwd(),'screenshots',run.id);
  const primary=JSON.parse(await readFile(resolve(root,'failure-primary.json'),'utf8'));
  const cleanup=JSON.parse(await readFile(resolve(root,'failure-cleanup.json'),'utf8'));
  assert.match(primary.message,/supported structured task/);
  assert.match(cleanup.message,/Timeout/);
  assert.equal(primary.state.dates[0].visible,true);
  assert.equal(cleanup.state.dates[0].visible,true);
 }finally{await browser.close();}
});

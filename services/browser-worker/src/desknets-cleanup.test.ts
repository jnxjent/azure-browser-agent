import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {test} from "node:test";
import {chromium,type Browser} from "playwright";
import {createRun} from "@azure-browser-agent/agent-core";
import {DeskNetsBrowserWorker} from "./desknets-worker.js";

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

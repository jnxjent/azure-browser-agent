import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createRun } from "@azure-browser-agent/agent-core";
import { DeskNetsBrowserWorker } from "./desknets-worker.js";

// A local DeskNet's-shaped page: final registration is counted, never performed.
const fixture = `<!doctype html><meta charset="utf-8">
<div id="list"><span>氏名/組織名</span><input type="checkbox"><a class="jsch-btn-add" href="#"
 onclick="document.getElementById('list').hidden=true;document.getElementById('form').hidden=false;return false">予定追加</a></div>
<div id="form" hidden>
 <span>本人</span><input class="jsch-startdate"><input class="jsch-enddate"><input name="detail">
 ${[0, 1].map(() => `<select class="co-timepicker-hour">${Array.from({length:24},(_,i)=>`<option>${i}時</option>`).join("")}</select>
 <select class="co-timepicker-minute"><option>0分</option><option>30分</option></select>`).join("")}
 <a href="#" class="jsch-entry-target-chooser" onclick="document.getElementById('people').hidden=false;return false">登録先</a>
 <a href="#" class="jsch-entry-target-chooser" onclick="document.getElementById('rooms').hidden=false;return false">利用設備</a>
 <span id="chosen"></span>
 <label><input type="checkbox" id="email" checked>メール</label>
 <label><input type="checkbox" id="suppress" checked>自分には通知しない</label>
 <button onclick="window.registrations++">追加</button>
 <button onclick="document.getElementById('form').hidden=true;document.getElementById('list').hidden=false">キャンセル</button>
</div>
<div id="people" class="ui-dialog co-sel-dialog" hidden>
 <div class="co-sel-bottom"><table><tbody><tr><td class="name-text">本人</td><td style="width:240px">空き</td></tr></tbody></table></div>
 <button onclick="document.getElementById('people').hidden=true">OK</button>
</div>
<div id="rooms" class="ui-dialog" hidden>
 <div class="sch-entry-plant-tab"><a href="#sch-entry-plant-tab-reserve" onclick="return false">予約状況</a></div>
 <div class="sch-entry-plant-reserve-list"><table><tbody><tr>
 <td><span class="sch-entry-plant-name">会議室A</span><input type="checkbox"></td><td style="width:240px">空き</td>
 </tr></tbody></table></div>
 <button onclick="document.getElementById('chosen').textContent='会議室A';document.getElementById('rooms').hidden=true">OK</button>
 <button onclick="document.getElementById('rooms').hidden=true">キャンセル</button>
</div><script>window.registrations=0</script>`;

test("orange-button handoff recreates a closed tab and restores all booking fields", async () => {
  const browser = await chromium.launch({headless:true});
  const context = await browser.newContext();
  await context.route("https://desk.example/**", route => route.fulfill({contentType:"text/html; charset=utf-8", body:fixture}));
  const worker = new DeskNetsBrowserWorker({limits:{allowedDomains:["desk.example"],maxSteps:20,maxRunDurationMs:60_000}});
  // Use an isolated browser instead of the user's authenticated Edge.
  (worker as unknown as {browserConnection:Promise<Browser>}).browserConnection = Promise.resolve(browser);
  try {
    const page = await context.newPage();
    await page.goto("https://desk.example/dneo.cgi?cmd=schindex#cmd=schweekgrp");
    const run = createRun({userId:"test",threadId:"reopen",site:"desknets",mode:"write",prompt:"予定追加画面を表示"});
    const slot = {start:"2099-09-18T01:30:00.000Z",end:"2099-09-18T02:00:00.000Z",durationMinutes:30,
      participantIds:["本人"],availableFacilityIds:["会議室A"]};
    run.task = {type:"book_meeting",title:"復元テスト",facilityQuery:"会議室A",selectedStart:slot.start,selectedEnd:slot.end,sendEmail:false};
    run.context = {date:"2099-09-18",durationMinutes:30,participants:[],participantIds:["本人"],availability:[slot]};
    let prepared = await worker.execute(run, new AbortController().signal);
    assert.equal(prepared.status,"awaiting_approval");
    // Both the first approval after closing and a subsequent re-display recover.
    for (let attempt=0;attempt<2;attempt++) {
      await context.pages()[0]!.close();
      prepared = await worker.execute({...prepared,approval:{requestedAt:new Date().toISOString(),approvedAt:new Date().toISOString()}},new AbortController().signal);
      assert.equal(prepared.status,"awaiting_user_input");
      assert.equal(context.pages().length,1);
      const restored = context.pages()[0]!;
      assert.equal(await restored.locator('input[name="detail"]').inputValue(),"復元テスト");
      assert.equal(await restored.locator('.jsch-startdate').inputValue(),"2099/09/18");
      assert.deepEqual(await restored.locator('select option:checked').allTextContents(),["10時","30分","11時","0分"]);
      assert.equal(await restored.locator('#chosen').innerText(),"会議室A");
      assert.equal(await restored.locator('#email').isChecked(),false);
      assert.equal(await restored.locator('#suppress').isChecked(),false);
      assert.equal(await restored.evaluate(()=> (window as unknown as {registrations:number}).registrations),0);
    }
  } finally { await browser.close(); }
});

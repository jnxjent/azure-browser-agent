import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { ensureScheduleList } from "./desknets-worker.js";

test("returns from equipment/personal views to the group schedule instead of waiting for an absent header", async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route("https://desknets.test/**",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:
      new URL(route.request().url()).searchParams.get("cmd")==="schindex"
        ? '<div>氏名/組織名</div>' : '<div>設備予約</div>'}));
    for (const command of ["plantweekgrp","schmonth","portal"]) {
      await page.goto(`https://desknets.test/dneo/dneo.cgi?cmd=${command}`);
      await ensureScheduleList(page);
      assert.equal(new URL(page.url()).hash,"#cmd=schweekgrp");
      assert.equal(await page.getByText("氏名/組織名",{exact:true}).count(),1);
    }
    const before = page.url();
    await ensureScheduleList(page);
    assert.equal(page.url(),before);
    await page.setContent('<input type="password"><button>ログイン</button>');
    await assert.rejects(()=>ensureScheduleList(page),/未ログイン/);
  } finally {await browser.close();}
});

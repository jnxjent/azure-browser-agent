import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { participantResultsBaseline, participantResultsTable, searchParticipantResults } from "./desknets-participant-results.js";
import { retainCandidateWindows, selectParticipant, buildRoomAvailabilityResult, cardParticipants, verifyExcludedRegistrationParticipants } from "./desknets-worker.js";

test("participant refinement retains only the previously displayed time windows", () => {
  const slots = [
    { start: "2026-10-07T04:00:00.000Z", end: "2026-10-07T05:00:00.000Z", room: "品川" },
    { start: "2026-10-07T05:00:00.000Z", end: "2026-10-07T06:00:00.000Z", room: "品川" },
  ];
  assert.deepEqual(retainCandidateWindows(slots, [slots[1]!]), [slots[1]]);
  assert.equal(retainCandidateWindows(slots, undefined), slots);
});


test("participant search ignores hidden duplicate listings and handles first/repeated search", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="co-sel-dialog">
      <section class="co-sel-groups co-sel-chooser-items" hidden><div class="co-sel-list-scroll"><table class="co-sel-table-list"><tbody><tr><td>Wrong person</td></tr></tbody></table></div></section>
      <section id="search" class="co-sel-search co-sel-chooser-items" hidden><div class="co-sel-list-scroll"><table class="co-sel-table-list"><tbody><tr><td>Search person</td></tr></tbody></table></div></section>
    </div>`);
    const dialog = page.locator('.co-sel-dialog:visible');
    const table = participantResultsTable(dialog);
    assert.equal(await participantResultsBaseline(table), "");
    await page.locator('#search').evaluate(element => { (element as HTMLElement).hidden = false; });
    assert.equal(await dialog.locator('.co-sel-list-scroll table.co-sel-table-list').count(), 2);
    await table.waitFor({state:'visible', timeout:1000});
    assert.equal(await table.locator('td').innerText(), 'Search person');
    const previous = await participantResultsBaseline(table);
    await table.locator('td').evaluate(element => { element.textContent = 'Next person'; });
    assert.notEqual(await participantResultsBaseline(table), previous);
    assert.equal(await table.locator('td').innerText(), 'Next person');
    // DOM order does not decide which table is selected.
    await dialog.evaluate(element => { element.append(element.firstElementChild!); });
    assert.equal(await table.locator('td').innerText(), 'Next person');
    // Even when the group list is visible, it must not be treated as search results.
    await page.locator('section').evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).hidden = false; }));
    assert.equal(await table.locator('td').innerText(), 'Next person');
    // Two visible search lists must fail safely instead of selecting arbitrarily.
    await page.locator('#search').evaluate(element => { element.append(element.firstElementChild!.cloneNode(true)); });
    await assert.rejects(participantResultsBaseline(table), /Multiple visible/);
    await assert.rejects(table.waitFor({state:'visible',timeout:1000}), /strict mode violation/);
  } finally { await browser.close(); }
});


test("participant search maps 高田 to 髙田 and retries when zero results hide the table", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of [
      { requested: "高田", found: "髙田", searches: ["髙田"] },
      { requested: "髙田", found: "高田", searches: ["髙田", "高田"] },
    ]) {
      const page = await browser.newPage();
      await page.setContent(`<div class="co-sel-dialog">
      <ul><li class="co-sel-search"><a href="#">検索</a></li></ul>
      <input name="name"><input name="key">
      <section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll">
        <table class="co-sel-table-list"><tbody></tbody></table>
      </div></section>
    </div>`);
      await page.evaluate((foundName) => {
      const nameField = document.querySelector<HTMLInputElement>('input[name="name"]')!;
      const body = document.querySelector<HTMLTableSectionElement>('tbody')!;
      const table = body.closest("table")!;
      const empty=document.createElement("p");empty.hidden=true;empty.textContent="該当するユーザーはいません";table.parentElement!.append(empty);
      (window as typeof window & { searches: string[] }).searches = [];
      nameField.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        const query = nameField.value;
        (window as typeof window & { searches: string[] }).searches.push(query);
        table.hidden = query !== foundName;
        empty.hidden = query === foundName;
        body.innerHTML = query === foundName
          ? `<tr><td><span class="co-sel-name">${foundName}廣明</span><span class="co-busyo-def">経営企画部</span></td><td class="co-sel-button"><button type="button" onclick="this.dataset.selected = 'true'">追加</button></td></tr>`
          : "";
      });
      }, scenario.found);
      await selectParticipant(page.locator(".co-sel-dialog"), page, { name: scenario.requested });
      assert.deepEqual(await page.evaluate(() => (window as typeof window & { searches: string[] }).searches), scenario.searches);
      assert.equal(await page.locator("button[data-selected='true']").count(), 1);
      await page.close();
    }
  } finally { await browser.close(); }
});


test("a unique exact full name wins over an approximate department and prefix matches", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="co-sel-dialog">
      <ul><li class="co-sel-search"><a href="#">検索</a></li></ul>
      <input name="name"><input name="key">
      <section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll">
        <table class="co-sel-table-list"><tbody></tbody></table>
      </div></section>
    </div>`);
    await page.evaluate(() => {
      const nameField = document.querySelector<HTMLInputElement>('input[name="name"]')!;
      const body = document.querySelector<HTMLTableSectionElement>('tbody')!;
      nameField.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        body.innerHTML = `
          <tr><td><span class="co-sel-name">鈴木清彦</span><span class="co-busyo-def">経営企画部</span></td><td class="co-sel-button"><button type="button" onclick="this.dataset.selected='true'">追加</button></td></tr>
          <tr><td><span class="co-sel-name">鈴木清彦太郎</span><span class="co-busyo-def">事業部</span></td><td class="co-sel-button"><button type="button" onclick="this.dataset.selected='true'">追加</button></td></tr>`;
      });
    });
    await selectParticipant(page.locator(".co-sel-dialog"), page, { name: "鈴木清彦", organization: "事業部" });
    assert.equal(await page.locator("button[data-selected='true']").count(), 1);
    assert.equal(await page.locator("button[data-selected='true']").locator("../..").locator(".co-sel-name").innerText(), "鈴木清彦");
  } finally { await browser.close(); }
});


test("duplicate exact full names still require disambiguation", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="co-sel-dialog">
      <ul><li class="co-sel-search"><a href="#">検索</a></li></ul>
      <input name="name"><input name="key">
      <section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll">
        <table class="co-sel-table-list"><tbody></tbody></table>
      </div></section>
    </div>`);
    await page.evaluate(() => {
      const nameField = document.querySelector<HTMLInputElement>('input[name="name"]')!;
      const body = document.querySelector<HTMLTableSectionElement>('tbody')!;
      nameField.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        body.innerHTML = `
          <tr><td><span class="co-sel-name">鈴木清彦</span><span class="co-busyo-def">事業部</span></td><td class="co-sel-button"><button type="button" onclick="this.dataset.selected='true'">追加</button></td></tr>
          <tr><td><span class="co-sel-name">鈴木清彦</span><span class="co-busyo-def">経営企画部</span></td><td class="co-sel-button"><button type="button" onclick="this.dataset.selected='true'">追加</button></td></tr>`;
      });
    });
    await assert.rejects(
      selectParticipant(page.locator(".co-sel-dialog"), page, { name: "鈴木清彦", organization: "事業部" }),
      /ambiguous/,
    );
    assert.equal(await page.locator("button[data-selected='true']").count(), 0);
  } finally { await browser.close(); }
});


test("a surname with an unmatched department offers the actual people instead of failing", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="co-sel-dialog">
      <ul><li class="co-sel-search"><a href="#">検索</a></li></ul>
      <input name="name"><input name="key">
      <section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll">
        <table class="co-sel-table-list"><tbody></tbody></table>
      </div></section>
    </div>`);
    await page.evaluate(() => {
      const nameField = document.querySelector<HTMLInputElement>('input[name="name"]')!;
      const body = document.querySelector<HTMLTableSectionElement>('tbody')!;
      nameField.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        body.innerHTML = `
          <tr><td><span class="co-sel-name">鈴木太郎</span><span class="co-busyo-def">ミダックライナー総務部</span></td><td class="co-sel-button"><button>追加</button></td></tr>
          <tr><td><span class="co-sel-name">鈴木次郎</span><span class="co-busyo-def">ミダックライナー営業部</span></td><td class="co-sel-button"><button>追加</button></td></tr>`;
      });
    });
    await assert.rejects(
      selectParticipant(page.locator(".co-sel-dialog"), page,
        { name: "鈴木", organization: "ミダックライナー管理G" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AmbiguousParticipantError");
        assert.deepEqual((error as Error & { candidates: unknown }).candidates, [
          { name: "鈴木太郎", organization: "ミダックライナー総務部" },
          { name: "鈴木次郎", organization: "ミダックライナー営業部" },
        ]);
        return true;
      },
    );
    assert.equal(await page.locator("button").count(), 2);
  } finally { await browser.close(); }
});

import { participantNameMatches, participantNameSearchVariants } from "./desknets-participants.js";

test("full names accept ordinary separators without changing surname characters or selecting longer names", () => {
  for (const requested of ["鴉 なぎさ", "鴉　なぎさ"]) {
    assert.deepEqual(participantNameSearchVariants(requested), ["鴉なぎさ", "鴉 なぎさ", "鴉　なぎさ"]);
    for (const candidate of ["鴉なぎさ", "鴉 なぎさ", "鴉　なぎさ"]) {
      assert.equal(participantNameMatches(candidate, requested, "鴉なぎさ"), true);
    }
    assert.equal(participantNameMatches("烏なぎさ", requested, "鴉なぎさ"), false);
    assert.equal(participantNameMatches("鴉なぎさ子", requested, "鴉なぎさ"), false);
  }
});

test("participant selection searches a compact full name and accepts the spaced registered name", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="co-sel-dialog">
      <li class="co-sel-search"><a href="#">検索</a></li>
      <input name="name"><input name="key">
      <section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll">
        <table class="co-sel-table-list"><tbody></tbody></table>
      </div></section></div>`);
    await page.evaluate(() => {
      document.querySelector('input[name="name"]')!.addEventListener("keydown", event => {
        if ((event as KeyboardEvent).key !== "Enter") return;
        const query = document.querySelector<HTMLInputElement>('input[name="name"]')!.value;
        if (query !== "鴉なぎさ") throw new Error("Unexpected query");
        document.querySelector("tbody")!.innerHTML = `<tr><td><span class="co-sel-name">鴉　なぎさ</span><span class="co-busyo-def">営業部</span></td><td class="co-sel-button"><button onclick="this.dataset.selected='true'">追加</button></td></tr>
        <tr><td><span class="co-sel-name">鴉なぎさ子</span><span class="co-busyo-def">営業部</span></td></tr>`;
      });
    });
    await selectParticipant(page.locator(".co-sel-dialog"), page, { name: "鴉 なぎさ" });
    assert.equal(await page.locator("button[data-selected='true']").count(), 1);
  } finally { await browser.close(); }
});

test("excluded-participant verification waits for the dialog and asynchronously loaded rows", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const fixture = async (names: string[]) => {
      await page.setContent(`<a href="#" id="open" class="jsch-entry-target-chooser">登録先</a>
        <div class="ui-dialog co-sel-dialog" hidden><div class="co-sel-bottom"><table><tbody></tbody></table></div><button onclick="this.parentElement.hidden=true">OK</button></div>`);
      await page.evaluate(values => {
        document.querySelector('#open')!.addEventListener('click', event => {
          event.preventDefault();
          setTimeout(() => { (document.querySelector('.co-sel-dialog') as HTMLElement).hidden = false; }, 150);
          setTimeout(() => {
            for (const name of values) {
              const row = document.createElement('tr'); const cell = document.createElement('td');
              cell.className = 'name-text'; cell.textContent = name; row.append(cell); document.querySelector('tbody')!.append(row);
            }
          }, 1100);
        });
      }, names);
    };
    await fixture(["加藤恵子"]);
    await verifyExcludedRegistrationParticipants(page, ["加藤恵子"]);
    assert.equal(await page.locator('.co-sel-dialog:visible').count(), 0);
    await fixture(["野元潤一", "加藤恵子"]);
    await assert.rejects(verifyExcludedRegistrationParticipants(page, ["加藤恵子"]), /一致しません/);
    await fixture(["鈴木", "加藤恵子"]);
    await verifyExcludedRegistrationParticipants(page, ["加藤恵子", "鈴木"]);
  } finally { await browser.close(); }
});


test("room-only results number every candidate and retain the selected room and registration target", () => {
  const task = { type: "find_room_availability" as const, facilityQuery: "アクト応接室",
    date: "2099-09-16", endDate: "2099-09-17", durationMinutes: 60, windowStart: "09:00", windowEnd: "17:00" };
  const slots = ["2099-09-16T00:00:00Z", "2099-09-17T00:00:00Z"].map(start => ({ start,
    end: new Date(Date.parse(start) + 3600000).toISOString(), durationMinutes: 60,
    participantIds: [], availableFacilityIds: ["アクト応接室"] }));
  const result = buildRoomAvailabilityResult(task, slots, ["本人"], []);
  assert.match(result.assistantMessage!, /1\. 9\/16\(水\) 09:00〜10:00/);
  assert.match(result.assistantMessage!, /2\. 9\/17\(木\) 09:00〜10:00/);
  assert.deepEqual(result.pendingBooking?.availability, slots);
  assert.deepEqual(result.pendingBooking?.participantIds, ["本人"]);
  assert.deepEqual(result.pendingBooking?.participants, []);
  assert.equal(result.pendingBooking?.facilityQuery, "アクト応接室");
  assert.match(buildRoomAvailabilityResult(task, [], [], []).assistantMessage!, /確認できませんでした/);
});


test("proxy booking omits only the requester from card participants and handoff IDs", () => {
  const base = { date: "2099-09-21", durationMinutes: 30, availability: [], participantIds: ["秘書", "田中", "鈴木"] };
  assert.deepEqual(
    cardParticipants({ ...base, excludeRequester: true, excludedRequesterId: "秘書" }, ["101", "201", "301"]),
    { participantIds: ["田中", "鈴木"], nativeUserIds: ["201", "301"] },
  );
  // Default: the requester stays on the card.
  assert.deepEqual(cardParticipants(base, ["101", "201", "301"]), { participantIds: ["秘書", "田中", "鈴木"], nativeUserIds: ["101", "201", "301"] });
  // Missing native IDs stay missing.
  assert.deepEqual(cardParticipants({ ...base, excludedRequesterId: "秘書" }), { participantIds: ["田中", "鈴木"] });
});

test("search completion distinguishes empty, stale, repeated and failed responses without a 30-second locator wait", async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route('https://desk.example/**',route=>route.fulfill({contentType:'text/html',body:'<div class="co-sel-dialog"><input name="name"><section class="co-sel-search co-sel-chooser-items"><div class="co-sel-list-scroll"><table class="co-sel-table-list"><tbody><tr><td><span class="co-sel-name">田中</span></td></tr></tbody></table></div></section></div>'}));
    const prepare=async(mode:string)=>{
      await page.goto('https://desk.example/');
      await page.evaluate(mode=>{
        document.querySelector('input')!.addEventListener('keydown',async event=>{
          if((event as KeyboardEvent).key!=='Enter')return;
          const table=document.querySelector('table')!,body=document.querySelector('tbody')!;
          if(mode==='stale')return;
          if(mode==='same'){body.innerHTML=body.innerHTML;return;}
          if(mode==='hidden'){table.hidden=true;return;}
          try {
            const response=await fetch('/search?name='+encodeURIComponent((document.querySelector('input') as HTMLInputElement).value));
            if(!response.ok)return;
            body.innerHTML='';table.hidden=true;
          }catch{/* Failure must not be rendered as an empty result. */}
        });
      },mode);
      await page.locator('input').fill('田中');
    };
    const dialog=page.locator('.co-sel-dialog');
    await prepare('same');assert.equal(await searchParticipantResults(dialog,page,'田中',1000),'results');
    for(const mode of ['stale','hidden']) {
      await prepare(mode);const start=Date.now();
      await assert.rejects(searchParticipantResults(dialog,page,'田中',500),/田中さんの検索結果を確認できません/);
      assert.ok(Date.now()-start<2000,'the inner read cannot wait for the default 30 seconds');
    }
    await page.route('https://desk.example/search?**',route=>route.fulfill({contentType:'application/json',body:'{"items":[]}'}));
    await prepare('empty');assert.equal(await searchParticipantResults(dialog,page,'田中',1500),'empty');
    await page.unroute('https://desk.example/search?**');
    await page.route('https://desk.example/search?**',route=>route.abort());
    await prepare('failure');await assert.rejects(searchParticipantResults(dialog,page,'田中',1000),/田中さんの検索結果を確認できません/);
  }finally{await browser.close();}
});

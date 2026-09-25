import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { participantResultsBaseline, participantResultsTable } from "./desknets-participant-results.js";
import { selectParticipant } from "./desknets-worker.js";

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
      (window as typeof window & { searches: string[] }).searches = [];
      nameField.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        const query = nameField.value;
        (window as typeof window & { searches: string[] }).searches.push(query);
        table.hidden = query !== foundName;
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

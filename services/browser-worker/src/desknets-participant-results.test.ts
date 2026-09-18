import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { participantResultsBaseline, participantResultsTable } from "./desknets-participant-results.js";

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

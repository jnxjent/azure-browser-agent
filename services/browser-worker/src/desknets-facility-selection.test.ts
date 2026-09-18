import assert from "node:assert/strict";
import { it } from "node:test";
import { chromium } from "playwright";
import { selectExactFacility } from "./desknets-worker.js";

it("replaces all previous rooms, preserves unrelated controls, and is idempotent", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="dialog">
      <input id="unrelated" type="checkbox" checked>
      <div class="sch-entry-plant-reserve-list"><table><tbody>
        <tr><td><input type="checkbox" checked><span class="sch-entry-plant-name">アクトミーティングルームC</span></td></tr>
        <tr><td><input type="checkbox" checked><span class="sch-entry-plant-name">旧会議室</span></td></tr>
        <tr><td><input type="checkbox"><span class="sch-entry-plant-name">アクト大会議室</span></td></tr>
      </tbody></table></div></div>`);
    await page.evaluate(() => {
      document.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
        input.dataset.changed = 'true';
      }));
    });
    const dialog = page.locator('#dialog');
    for (let attempt = 0; attempt < 2; attempt++) {
      await selectExactFacility(dialog, 'アクト大会議室');
      assert.deepEqual(await dialog.locator('tbody input').evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).checked)), [false, false, true]);
      assert.equal(await page.locator('#unrelated').isChecked(), true);
    }
    assert.deepEqual(await dialog.locator('tbody input').evaluateAll((inputs) => inputs.map((input) => (input as HTMLElement).dataset.changed)), ['true', 'true', 'true']);
    await assert.rejects(selectExactFacility(dialog, '存在しない会議室'), /Facility row was not found/);
    assert.equal(await dialog.locator('tbody input:checked').count(), 1);
  } finally {
    await browser.close();
  }
});

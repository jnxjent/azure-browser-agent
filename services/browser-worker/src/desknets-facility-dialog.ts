import type { Page } from "playwright";

/** Open the timeline explicitly; DeskNet's may remember the free-search tab. */
export async function openFacilityDialog(page: Page): Promise<void> {
  const dialog = page.locator(".ui-dialog:visible").filter({
    has: page.locator(".sch-entry-plant-tab"),
  });
  let stage = "利用設備の画面";
  try {
    if (await dialog.count() === 0) {
      const chooser = page.locator("a.jsch-entry-target-chooser:visible")
        .filter({ hasText: "利用設備" });
      await chooser.click({ timeout: 10_000 });
    }
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
    stage = "予約状況のタブ";
    await dialog.locator('a[href="#sch-entry-plant-tab-reserve"]').click({ timeout: 10_000 });
    stage = "会議室・設備の予約状況一覧";
    await dialog.locator(".sch-entry-plant-reserve-list table tbody tr").first()
      .waitFor({ state: "visible", timeout: 20_000 });
  } catch (cause) {
    throw new Error(`${stage}を表示できませんでした。専用Edgeの画面を確認して再実行してください。`, { cause });
  }
}

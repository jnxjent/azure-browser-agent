import type { Browser, BrowserContext, Page } from "playwright";

/** Keep one schedule tab in the dedicated CDP browser, preserving its draft. */
export async function ensureSingleDeskNetsTab(
  browser: Browser,
  allowedDomains: readonly string[],
  selectedContext?: BrowserContext,
): Promise<Page | undefined> {
  const contexts = selectedContext === undefined ? browser.contexts() : [selectedContext];
  const pages = contexts.flatMap((context) => context.pages()).filter((page) => {
    const url = new URL(page.url());
    return allowedDomains.some((domain) => {
      const host = domain.toLowerCase();
      return url.hostname === host || url.hostname.endsWith(`.${host}`);
    });
  });
  if (pages.length <= 1) return pages[0];

  // Only consolidate the same application and browser context. Never guess
  // between accounts, environments, or unrelated pages on an allowed host.
  const first = pages[0]!;
  const target = new URL(first.url());
  if (pages.some((page) => {
    const url = new URL(page.url());
    return page.context() !== first.context() || url.origin !== target.origin || url.pathname !== target.pathname;
  })) throw new Error("異なるDeskNet's画面が開いています。専用ブラウザで使用する画面を1つにしてください。");

  const states = await Promise.all(pages.map(async (page) => {
    const url = new URL(page.url());
    const command = new URLSearchParams(url.hash.slice(1)).get("cmd") ?? url.searchParams.get("cmd") ?? "";
    const draft = /^sch(?:add|edit)/.test(command) || await page.locator(".jsch-startdate:visible").count() > 0;
    const list = /^sch(?:week|month|day|index|list)/.test(command);
    return { page, draft, list };
  }));
  const drafts = states.filter((state) => state.draft);
  if (drafts.length > 1 || states.some((state) => !state.draft && !state.list)) {
    throw new Error("DeskNet'sに複数の編集中画面、または用途を判別できない画面があります。入力内容を確認し、不要な画面を閉じてください。");
  }
  const retained = drafts[0]?.page ?? first;
  for (const { page } of states) {
    if (page !== retained) await page.close({ runBeforeUnload: false });
  }
  await retained.bringToFront();
  return retained;
}

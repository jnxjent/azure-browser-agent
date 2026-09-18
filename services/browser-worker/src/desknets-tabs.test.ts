import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser } from "playwright";
import { ensureSingleDeskNetsTab } from "./desknets-tabs.js";

function fixture(routes: string[]) {
  const context: { pages: () => unknown[] } = { pages: () => pages.filter((page) => !page.closed) };
  const pages = routes.map((route) => ({
    closed: false,
    url: () => `https://desk.example/dneo.cgi#cmd=${route}`,
    context: () => context,
    locator: () => ({ count: async () => 0 }),
    close: async function () { this.closed = true; },
    bringToFront: async () => {},
  }));
  const browser = { contexts: () => [context] } as unknown as Browser;
  return { browser, pages };
}

test("keeps the draft, removes duplicate lists, and is idempotent", async () => {
  const { browser, pages } = fixture(["schweekgrp", "schaddtarget", "schmonth"]);
  assert.equal(await ensureSingleDeskNetsTab(browser, ["desk.example"]), pages[1]);
  assert.deepEqual(pages.map((page) => page.closed), [true, false, true]);
  assert.equal(await ensureSingleDeskNetsTab(browser, ["desk.example"]), pages[1]);
});

test("retains one list when no draft exists", async () => {
  const { browser, pages } = fixture(["schweekgrp", "schweekgrp"]);
  assert.equal(await ensureSingleDeskNetsTab(browser, ["desk.example"]), pages[0]);
  assert.equal(pages[1]!.closed, true);
});

test("does not discard multiple drafts or unknown pages", async () => {
  for (const routes of [["schadd", "schaddtarget"], ["schweekgrp", "mailadd"]]) {
    const { browser, pages } = fixture(routes);
    await assert.rejects(ensureSingleDeskNetsTab(browser, ["desk.example"]));
    assert.equal(pages.some((page) => page.closed), false);
  }
});

test("does not touch unrelated domains or different application paths", async () => {
  const { browser, pages } = fixture(["schweekgrp", "schweekgrp"]);
  assert.equal(await ensureSingleDeskNetsTab(browser, ["other.example"]), undefined);
  assert.equal(pages.some((page) => page.closed), false);
  pages[1]!.url = () => "https://desk.example/other.cgi#cmd=schweekgrp";
  await assert.rejects(ensureSingleDeskNetsTab(browser, ["desk.example"]));
  assert.equal(pages.some((page) => page.closed), false);
});

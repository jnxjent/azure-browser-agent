import type { Page } from "playwright";

export function companyHolidayDates(entries: Array<{ date: string; label: string }>): Set<string> {
  return new Set(entries.filter(entry => entry.label.includes("会社休日") && /^\d{8}$/.test(entry.date))
    .map(entry => `${entry.date.slice(0, 4)}-${entry.date.slice(4, 6)}-${entry.date.slice(6, 8)}`));
}

/** Read official calendar metadata, not weekend guesses or appointment titles. */
export async function readCompanyHolidays(source: Page, dates: string[]): Promise<Set<string>> {
  const page = await source.context().newPage();
  const holidays = new Set<string>();
  try {
    for (const month of new Set(dates.map(date => date.slice(0, 7)))) {
      const url = new URL(source.url());
      // Change the query too: hash-only navigation could read the previous
      // month's DOM before DeskNet's asynchronous route update finishes.
      url.search = `?cmd=schindex&date=${month.replaceAll("-", "")}01`;
      url.hash = `cmd=schmonth&date=${month.replaceAll("-", "")}01`;
      await page.goto(url.href, { waitUntil: "load" });
      await page.locator(".cal-item-box").first().waitFor({ state: "attached", timeout: 10000 });
      const entries = await page.locator('[data-type="holiday"][data-date]').evaluateAll(elements => elements.map(e => ({
        date: e.getAttribute("data-date") ?? "",
        label: e.getAttribute("title") ?? e.textContent ?? "",
      })));
      for (const date of companyHolidayDates(entries)) holidays.add(date);
    }
    return holidays;
  } finally { await page.close(); }
}

import type { Locator } from "playwright";

/** Hidden listings for other tabs must never participate in participant lookup. */
export function participantResultsTable(dialog: Locator): Locator {
  // Keep strict matching: if two visible tables remain, do not guess with first().
  return dialog.locator(".co-sel-search.co-sel-chooser-items .co-sel-list-scroll table.co-sel-table-list:visible");
}

export async function participantResultsBaseline(table: Locator): Promise<string> {
  // Before the first search the results may not be visible yet. Read immediately
  // rather than waiting for a table that only appears after submitting the form.
  return table.evaluateAll((tables) => {
    if (tables.length > 1) throw new Error("Multiple visible participant result tables.");
    return tables[0]?.innerHTML ?? "";
  });
}

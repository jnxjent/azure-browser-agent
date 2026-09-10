import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ParticipantAliasStore } from "./participant-alias-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createStore(): Promise<{ store: ParticipantAliasStore; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "participant-aliases-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "aliases.json");
  return { store: new ParticipantAliasStore(filePath), filePath };
}

describe("ParticipantAliasStore", () => {
  it("registers, updates, persists, and removes an alias", async () => {
    const { store, filePath } = await createStore();
    await store.upsert("こうさん", "黄子超");
    await store.upsert("こうさん", "黄子超正式");
    assert.deepEqual(await store.list(), [{ alias: "こうさん", formalName: "黄子超正式" }]);
    assert.match(await readFile(filePath, "utf8"), /黄子超正式/);
    assert.equal(await store.remove("こうさん"), true);
    assert.deepEqual(await store.list(), []);
  });

  it("replaces registered calls without changing unrelated substrings", async () => {
    const { store } = await createStore();
    await store.upsert("こうちゃん", "黄子超");
    await store.upsert("たっくん", "田倉祐亮");
    assert.equal(
      await store.replaceAliases("私とこうちゃん、たっくんさんで今週金曜日の候補を出して"),
      "私と黄子超、田倉祐亮さんで今週金曜日の候補を出して",
    );
    assert.equal(await store.replaceAliases("こうちゃんぽん"), "こうちゃんぽん");
  });

  it("prefers the longest registered call name", async () => {
    const { store } = await createStore();
    await store.upsert("部長", "髙田廣明");
    await store.upsert("髙田部長", "髙田廣明");
    assert.equal(await store.replaceAliases("髙田部長と私で明日"), "髙田廣明と私で明日");
  });

  it("replaces a title alias before a relative-date phrase", async () => {
    const { store } = await createStore();
    await store.upsert("社長", "加藤恵子");
    assert.equal(
      await store.replaceAliases("私と社長の来週月曜日の打ち合わせ可能な候補を教えて"),
      "私と加藤恵子の来週月曜日の打ち合わせ可能な候補を教えて",
    );
  });
});

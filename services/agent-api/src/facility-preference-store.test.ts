import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  FacilityPreferenceStore,
  parseFacilityPreferenceRegistration,
} from "./facility-preference-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseFacilityPreferenceRegistration", () => {
  it("reads an ordered Japanese room preference registration", () => {
    assert.deepEqual(
      parseFacilityPreferenceRegistration(
        "会議室の優先順位を、アクトミーティングルームC、アクトの順で登録してください",
      ),
      ["アクトミーティングルームC", "アクト"],
    );
  });

  it("does not consume an ordinary meeting request", () => {
    assert.equal(parseFacilityPreferenceRegistration("髙田部長との会議室を探して"), undefined);
  });
});

describe("FacilityPreferenceStore", () => {
  it("persists preferences by AzureChat user id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "facility-preferences-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "preferences.json");
    const store = new FacilityPreferenceStore(file);

    await store.upsert("user-1", ["ミーティングルームC", "アクト"]);
    assert.deepEqual((await store.get("user-1"))?.facilities, ["ミーティングルームC", "アクト"]);
    assert.match(await readFile(file, "utf8"), /user-1/);
    assert.equal(await store.remove("user-1"), true);
    assert.equal(await store.get("user-1"), undefined);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { readRequiredFacilityLocations } from "./multi-location-request.js";

test("recognizes two rooms required at the same time in separate locations", () => {
  assert.deepEqual(readRequiredFacilityLocations(
    "10月5日以降に事業部鈴木清彦部長、私でWEBミーティングを開催したいです。時間は1時間。鈴木部長は有玉本社、私はアクト事務所で参加しますのでそれぞれ1か所の会議室を確保できる候補日を教えてください。",
  ), ["アクト", "有玉"]);
});

test("does not turn an alternate location into a simultaneous requirement", () => {
  assert.equal(readRequiredFacilityLocations("アクトか有玉の会議室が空いている日を教えて"), undefined);
});

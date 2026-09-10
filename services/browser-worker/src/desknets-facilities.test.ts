import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMeetingRoomFacilityName,
  keepMeetingRoomFacilities,
} from "./desknets-facilities.js";

describe("DeskNet's meeting-room facility filter", () => {
  it("keeps meeting rooms, reception rooms, and business-defined CC rooms", () => {
    for (const facilityId of [
      "アクト大会議室",
      "品川オフィス応接室",
      "アクトミーティングルームC",
      "遠州CC",
      "浜名湖CC",
      "奥山の杜CC",
    ]) {
      assert.equal(isMeetingRoomFacilityName(facilityId), true, facilityId);
    }
  });

  it("removes non-room resources from dropdown candidates", () => {
    const facilities = [
      { facilityId: "アクト大会議室" },
      { facilityId: "アクト役員室" },
      { facilityId: "アクトロビー" },
      { facilityId: "アクト食堂" },
      { facilityId: "7180プリウス（アクト総務）" },
      { facilityId: "プロジェクター①" },
      { facilityId: "都田 商談室" },
      { facilityId: "奥山会議室(2階)" },
    ];

    assert.deepEqual(keepMeetingRoomFacilities(facilities), [
      { facilityId: "アクト大会議室" },
      { facilityId: "奥山会議室(2階)" },
    ]);
  });
});

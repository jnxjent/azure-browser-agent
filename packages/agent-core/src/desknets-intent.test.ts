import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeskNetsTask } from "./desknets-intent.js";

describe("parseDeskNetsTask", () => {
  it("parses a Japanese availability request", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "髙田さん、山本さんと私で8月6日で打ち合わせ可能な時間を教えて",
        new Date("2026-08-06T00:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participantNames: ["髙田", "山本"],
        date: "2026-08-06",
        endDate: "2026-08-06",
        durationMinutes: 60,
      },
    );
  });

  it("resolves relative Japanese date ranges in Asia/Tokyo", () => {
    const now = new Date("2026-08-06T16:00:00+09:00");
    assert.deepEqual(parseDeskNetsTask("髙田さんと今日空いている時間", now), {
      type: "find_availability",
      participantNames: ["髙田"],
      date: "2026-08-06",
      endDate: "2026-08-06",
      durationMinutes: 60,
    });
    assert.deepEqual(parseDeskNetsTask("髙田さんと1週間以内で空いている時間", now), {
      type: "find_availability",
      participantNames: ["髙田"],
      date: "2026-08-06",
      endDate: "2026-08-12",
      durationMinutes: 60,
    });
    assert.deepEqual(parseDeskNetsTask("髙田さんと今月中で空いている時間", now), {
      type: "find_availability",
      participantNames: ["髙田"],
      date: "2026-08-06",
      endDate: "2026-08-31",
      durationMinutes: 60,
    });
  });

  it("parses an explicit mixed-width date range and meeting duration", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "来週(8月24日から８月28日)、山本さんと髙田さんと、私（野元）で打ち合わせ可能な日程を挙げて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participantNames: ["山本", "髙田"],
        date: "2026-08-24",
        endDate: "2026-08-28",
        durationMinutes: 60,
      },
    );
    assert.deepEqual(parseDeskNetsTask("打ち合わせ時間は30分でいい"), {
      type: "change_availability_duration",
      durationMinutes: 30,
    });
    assert.deepEqual(
      parseDeskNetsTask(
        "山本さんと8月24日に会議。議題＝「テスト配信（AIAgent）」",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participantNames: ["山本"],
        date: "2026-08-24",
        endDate: "2026-08-24",
        durationMinutes: 60,
        title: "テスト配信（AIAgent）",
      },
    );
  });

  it("parses a direct dated booking with facility and email", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "それでは8/24の9:30-10:00、会議室Cで設定して。メール発信して",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "book_meeting",
        facilityQuery: "ルームC",
        title: "",
        sendEmail: true,
        selectedStart: "2026-08-24T00:30:00.000Z",
        selectedEnd: "2026-08-24T01:00:00.000Z",
      },
    );
    assert.deepEqual(
      parseDeskNetsTask(
        "それでは8/24の9:30〜10:00、設備「アクトミーティングルームC」で打ち合わせを設定して。議題＝「テスト配信（AIAgent）」。メール送信しないで",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "book_meeting",
        facilityQuery: "アクトミーティングルームC",
        title: "テスト配信（AIAgent）",
        sendEmail: false,
        selectedStart: "2026-08-24T00:30:00.000Z",
        selectedEnd: "2026-08-24T01:00:00.000Z",
      },
    );
  });

  it("parses an explicitly authorized room booking request", () => {
    assert.deepEqual(
      parseDeskNetsTask("ルームCが空いているところで会議をセットしておいてください"),
      {
        type: "book_meeting",
        facilityQuery: "ルームC",
        title: "",
        sendEmail: false,
      },
    );
  });

  it("parses a facility availability follow-up", () => {
    assert.deepEqual(parseDeskNetsTask("ルームCが空いている時間帯は？"), {
      type: "find_facility_availability",
      facilityQuery: "ルームC",
    });
  });

  it("parses a numbered candidate selection", () => {
    assert.deepEqual(parseDeskNetsTask("では1で確定して"), {
      type: "select_booking_candidate",
      candidateNumber: 1,
    });
  });

  it("does not confuse a date ending in で with a candidate number", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "私と甲斐さんとで、8/24から8/26で打ち合わせしたいのですが、候補日教えて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participantNames: ["甲斐"],
        date: "2026-08-24",
        endDate: "2026-08-26",
        durationMinutes: 60,
      },
    );
  });

  it("parses the email notification answer", () => {
    assert.deepEqual(parseDeskNetsTask("はい"), {
      type: "set_email_notification",
      sendEmail: true,
    });
    assert.deepEqual(parseDeskNetsTask("いいえ"), {
      type: "set_email_notification",
      sendEmail: false,
    });
  });

  it("rejects incomplete availability and booking prompts", () => {
    assert.throws(() => parseDeskNetsTask("空き時間を教えて"), /少なくとも1名/);
    assert.throws(() => parseDeskNetsTask("会議をセットしてください"), /設備名/);
  });
});

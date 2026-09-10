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
        participants: [{ name: "髙田" }, { name: "山本" }],
        date: "2026-08-06",
        endDate: "2026-08-06",
        durationMinutes: 60,
      },
    );
  });

  it("accepts participant names without requiring the さん honorific", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "髙田と山本と私で9月17日に打ち合わせ可能な時間を教えて",
        new Date("2026-09-09T12:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }, { name: "山本" }],
        date: "2026-09-17",
        endDate: "2026-09-17",
        durationMinutes: 60,
      },
    );

    assert.deepEqual(
      parseDeskNetsTask(
        "髙田さん、山本と9月17日の空き時間を教えて",
        new Date("2026-09-09T12:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }, { name: "山本" }],
        date: "2026-09-17",
        endDate: "2026-09-17",
        durationMinutes: 60,
      },
    );
  });

  it("accepts a participant immediately before a relative-date phrase", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "私と加藤恵子の来週月曜日の打ち合わせ可能な候補を教えて",
        new Date("2026-09-10T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "加藤恵子" }],
        date: "2026-09-14",
        endDate: "2026-09-14",
        durationMinutes: 60,
      },
    );
  });

  it("removes job titles following participant names", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "髙田部長と山本次長と私で9月17日に打ち合わせ可能な時間を教えて",
        new Date("2026-09-09T12:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }, { name: "山本" }],
        date: "2026-09-17",
        endDate: "2026-09-17",
        durationMinutes: 60,
      },
    );

    assert.deepEqual(
      parseDeskNetsTask(
        "営業統括部の髙田本部長、山本さんと9月17日の空き時間を教えて",
        new Date("2026-09-09T12:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [
          { name: "髙田", organization: "営業統括部" },
          { name: "山本" },
        ],
        date: "2026-09-17",
        endDate: "2026-09-17",
        durationMinutes: 60,
      },
    );
  });

  it("keeps an initial facility filter on an availability request", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "髙田さんと9月17日の空き時間を教えて。会議室はアクトで",
        new Date("2026-09-09T12:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }],
        date: "2026-09-17",
        endDate: "2026-09-17",
        durationMinutes: 60,
        facilityQuery: "アクト",
      },
    );
  });

  it("does not treat a natural-language meeting-room condition as a participant", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "DeskNet'sで、加藤恵子、熊谷裕之、鈴木清彦、私の来週月曜日の空き時間を調べて。1時間の打ち合わせで、会議室はアクトにしてください。",
        new Date("2026-09-10T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [
          { name: "加藤恵子" },
          { name: "熊谷裕之" },
          { name: "鈴木清彦" },
        ],
        date: "2026-09-14",
        endDate: "2026-09-14",
        durationMinutes: 60,
        facilityQuery: "アクト",
      },
    );
  });

  it("recognizes every supported meeting-room location filter", () => {
    const locations = [
      "アクト",
      "有玉",
      "品川",
      "御殿山",
      "富士宮",
      "名古屋",
      "ミダックこなん",
      "遠州CC",
      "浜名湖CC",
      "奥山の杜CC",
      "奥山",
      "都田",
    ];

    for (const facilityQuery of locations) {
      assert.deepEqual(
        parseDeskNetsTask(
          `髙田部長と9月17日の空き時間を教えて。会議室は${facilityQuery}で`,
          new Date("2026-09-09T12:00:00+09:00"),
        ),
        {
          type: "find_availability",
          participants: [{ name: "髙田" }],
          date: "2026-09-17",
          endDate: "2026-09-17",
          durationMinutes: 60,
          facilityQuery,
        },
      );
    }
  });

  it("resolves relative Japanese date ranges in Asia/Tokyo", () => {
    const now = new Date("2026-08-06T16:00:00+09:00");
    assert.deepEqual(parseDeskNetsTask("髙田さんと今日空いている時間", now), {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-08-06",
      endDate: "2026-08-06",
      durationMinutes: 60,
    });
    assert.deepEqual(parseDeskNetsTask("髙田さんと1週間以内で空いている時間", now), {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-08-06",
      endDate: "2026-08-12",
      durationMinutes: 60,
    });
    assert.deepEqual(parseDeskNetsTask("髙田さんと今月中で空いている時間", now), {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-08-06",
      endDate: "2026-08-31",
      durationMinutes: 60,
    });
  });

  it("resolves a weekday in next week to one specific date", () => {
    const now = new Date("2026-09-09T12:00:00+09:00");
    for (const prompt of [
      "黄さん、田倉さん、津藤さん、私で来週月曜日の空いた候補を出して",
      "黄、田倉、津藤と私で来週の月曜の空き時間を教えて",
    ]) {
      assert.deepEqual(parseDeskNetsTask(prompt, now), {
        type: "find_availability",
        participants: [{ name: "黄" }, { name: "田倉" }, { name: "津藤" }],
        date: "2026-09-14",
        endDate: "2026-09-14",
        durationMinutes: 60,
      });
    }
  });

  it("resolves a named weekday in this week to one specific date", () => {
    const now = new Date("2026-09-09T12:00:00+09:00");
    for (const prompt of [
      "黄さん、田倉さん、津藤さん、私で今週金曜日の空いた候補を出して",
      "黄、田倉、津藤と私で今週の金曜の空き時間を教えて",
      "黄さん、田倉さん、津藤さん、私で、今週金曜日の空いた候補を出して",
    ]) {
      assert.deepEqual(parseDeskNetsTask(prompt, now), {
        type: "find_availability",
        participants: [{ name: "黄" }, { name: "田倉" }, { name: "津藤" }],
        date: "2026-09-11",
        endDate: "2026-09-11",
        durationMinutes: 60,
      });
    }
  });

  it("resolves 今週 to today through this week's Friday, excluding the weekend, without an explicit date", () => {
    // 2026-08-19 is a Wednesday: Friday is two days later, and Sat/Sun (08-22, 08-23) must not appear.
    assert.deepEqual(
      parseDeskNetsTask("髙田さんと今週空いている時間", new Date("2026-08-19T11:00:00+09:00")),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }],
        date: "2026-08-19",
        endDate: "2026-08-21",
        durationMinutes: 60,
      },
    );
    // 2026-08-21 is a Friday: 今週 should resolve to just today (already the last weekday).
    assert.deepEqual(
      parseDeskNetsTask("髙田さんと今週中に空いている時間", new Date("2026-08-21T11:00:00+09:00")),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }],
        date: "2026-08-21",
        endDate: "2026-08-21",
        durationMinutes: 60,
      },
    );
    // 2026-08-23 is a Sunday: no weekday is left this week, so 今週 falls back to just today.
    assert.deepEqual(
      parseDeskNetsTask("髙田さんと今週中に空いている時間", new Date("2026-08-23T11:00:00+09:00")),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }],
        date: "2026-08-23",
        endDate: "2026-08-23",
        durationMinutes: 60,
      },
    );
    // 2026-08-22 is a Saturday: same fallback.
    assert.deepEqual(
      parseDeskNetsTask("髙田さんと今週中に空いている時間", new Date("2026-08-22T11:00:00+09:00")),
      {
        type: "find_availability",
        participants: [{ name: "髙田" }],
        date: "2026-08-22",
        endDate: "2026-08-22",
        durationMinutes: 60,
      },
    );
  });

  it("parses an explicit mixed-width date range and meeting duration", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "来週(8月24日から８月28日)、山本さんと髙田さんと、私（野元）で打ち合わせ可能な日程を挙げて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "山本" }, { name: "髙田" }],
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
        participants: [{ name: "山本" }],
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
        participants: [{ name: "甲斐" }],
        date: "2026-08-24",
        endDate: "2026-08-26",
        durationMinutes: 60,
      },
    );
  });

  it("parses a request to go back to the previous candidates", () => {
    assert.deepEqual(parseDeskNetsTask("候補に戻して"), { type: "show_candidates" });
    assert.deepEqual(parseDeskNetsTask("やっぱりやめて、候補に戻して"), {
      type: "show_candidates",
    });
    assert.deepEqual(parseDeskNetsTask("候補を見せて"), { type: "show_candidates" });
    assert.deepEqual(parseDeskNetsTask("候補一覧を教えて"), { type: "show_candidates" });
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

  it("rejects incomplete availability prompts", () => {
    assert.throws(() => parseDeskNetsTask("空き時間を教えて"), /少なくとも1名/);
  });

  it("omits facilityQuery from a booking request that does not name a room, for later preference resolution", () => {
    assert.deepEqual(parseDeskNetsTask("会議をセットしてください"), {
      type: "book_meeting",
      title: "",
      sendEmail: false,
    });
  });

  it("captures an organization named before a participant", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "総務部の山本さんと明日打ち合わせ可能な時間を教えて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "山本", organization: "総務部" }],
        date: "2026-08-20",
        endDate: "2026-08-20",
        durationMinutes: 60,
      },
    );
  });

  it("captures self-department expressions for worker-side resolution", () => {
    for (const organization of ["当部", "自部署", "同じ部"]) {
      const task = parseDeskNetsTask(
        `${organization}の甲斐さんと私で来週月曜日の空き時間を教えて`,
        new Date("2026-09-10T11:00:00+09:00"),
      );
      assert.equal(task.type, "find_availability");
      if (task.type === "find_availability") {
        assert.deepEqual(task.participants, [{ name: "甲斐", organization }]);
      }
    }
  });

  it("keeps a hiragana-containing organization name intact instead of truncating it", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "ものづくり推進部の山本さんと明日打ち合わせ可能な時間を教えて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [{ name: "山本", organization: "ものづくり推進部" }],
        date: "2026-08-20",
        endDate: "2026-08-20",
        durationMinutes: 60,
      },
    );
  });

  it("treats the same name in different organizations as distinct participants", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "総務部の山本さんと営業統括部の山本さんと明日打ち合わせ可能な時間を教えて",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "find_availability",
        participants: [
          { name: "山本", organization: "総務部" },
          { name: "山本", organization: "営業統括部" },
        ],
        date: "2026-08-20",
        endDate: "2026-08-20",
        durationMinutes: 60,
      },
    );
  });

  it("recognizes a bare facility name with no letter suffix as an explicit facilityQuery", () => {
    assert.deepEqual(parseDeskNetsTask("有玉で会議を設定して"), {
      type: "book_meeting",
      facilityQuery: "有玉",
      title: "",
      sendEmail: false,
    });
    assert.deepEqual(parseDeskNetsTask("品川の会議室で予約して"), {
      type: "book_meeting",
      facilityQuery: "品川",
      title: "",
      sendEmail: false,
    });
  });

  it("does not let a preceding date/time expression bleed into a bare facility name", () => {
    assert.deepEqual(
      parseDeskNetsTask(
        "8月26日の10時から11時に有玉で会議を設定して",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "book_meeting",
        facilityQuery: "有玉",
        title: "",
        sendEmail: false,
        selectedStart: "2026-08-26T01:00:00.000Z",
        selectedEnd: "2026-08-26T02:00:00.000Z",
      },
    );
    assert.deepEqual(
      parseDeskNetsTask(
        "8月26日の10時から11時に品川の会議室で予約して",
        new Date("2026-08-19T11:00:00+09:00"),
      ),
      {
        type: "book_meeting",
        facilityQuery: "品川",
        title: "",
        sendEmail: false,
        selectedStart: "2026-08-26T01:00:00.000Z",
        selectedEnd: "2026-08-26T02:00:00.000Z",
      },
    );
  });

  it("rejects the exact same name and organization mentioned twice", () => {
    assert.throws(
      () => parseDeskNetsTask("総務部の山本さんと総務部の山本さんと明日空いている時間"),
      /参加者名が重複しています/,
    );
  });
});

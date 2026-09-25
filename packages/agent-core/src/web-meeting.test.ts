import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_MEETING_BLOCK_END,
  WEB_MEETING_BLOCK_START,
  buildWebMeetingBlock,
  describeWebMeetingCompleteness,
  detectWebMeetingRequest,
  removeWebMeetingBlock,
  upsertWebMeetingBlock,
  type WebMeetingDetails,
} from "./web-meeting.js";

const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example";
const MEETING_ID = "123 456 789";
const ready: WebMeetingDetails = {
  joinUrl: JOIN_URL,
  meetingId: MEETING_ID,
  passcode: "abc123",
  passcodeAvailability: "required",
};

test("the block carries only retrieved values and rejects untrusted join URLs", () => {
  const block = buildWebMeetingBlock(ready);
  assert.ok(block.startsWith(WEB_MEETING_BLOCK_START));
  assert.ok(block.endsWith(WEB_MEETING_BLOCK_END));
  assert.ok(block.includes("会議ID: 123 456 789"));
  assert.ok(block.includes("パスコード: abc123"));

  const withoutPasscode = buildWebMeetingBlock({
    joinUrl: JOIN_URL,
    meetingId: MEETING_ID,
    passcodeAvailability: "not_required",
  });
  assert.ok(!withoutPasscode.includes("パスコード"));
  const withoutMeetingId = buildWebMeetingBlock({
    joinUrl: JOIN_URL,
    passcodeAvailability: "unavailable",
  });
  assert.ok(!withoutMeetingId.includes("会議ID"));

  for (const joinUrl of [
    "http://teams.microsoft.com/x",
    "https://teams.microsoft.com.evil.test/x",
    "https://user:pw@teams.microsoft.com/x",
  ]) {
    assert.throws(() => buildWebMeetingBlock({ ...ready, joinUrl }));
  }
  assert.throws(() => buildWebMeetingBlock({ ...ready, passcode: "a\nb" }));
});

test("a passcode is never implied by, nor missing from, its availability", () => {
  assert.throws(() =>
    buildWebMeetingBlock({
      joinUrl: JOIN_URL,
      meetingId: MEETING_ID,
      passcodeAvailability: "required",
    }),
  );
  assert.throws(() =>
    buildWebMeetingBlock({ ...ready, passcodeAvailability: "not_required" }),
  );
  assert.throws(() =>
    buildWebMeetingBlock({ ...ready, passcodeAvailability: "unavailable" }),
  );
});

test("upsert replaces a changed block, collapses duplicates, and is idempotent", () => {
  const body = upsertWebMeetingBlock("既存の議題\n資料を確認", ready);
  assert.ok(body.startsWith("既存の議題\n資料を確認\n\n"));
  assert.equal(upsertWebMeetingBlock(body, ready), body);

  const rescheduled: WebMeetingDetails = { ...ready, joinUrl: `${JOIN_URL}-2` };
  const updated = upsertWebMeetingBlock(body, rescheduled);
  assert.ok(updated.includes("example-2"));
  assert.equal(updated.split(WEB_MEETING_BLOCK_START).length - 1, 1);
  assert.ok(updated.startsWith("既存の議題\n資料を確認"));

  const duplicated = `${body}\n\n${buildWebMeetingBlock(ready)}`;
  assert.equal(
    upsertWebMeetingBlock(duplicated, ready).split(WEB_MEETING_BLOCK_START).length - 1,
    1,
  );
  assert.equal(removeWebMeetingBlock(duplicated), "既存の議題\n資料を確認");
});

test("text around the block is never reformatted", () => {
  const body = `  前書き\n\n\n\n箇条書き\n\n${buildWebMeetingBlock(ready)}\n\n後書き  `;
  const updated = upsertWebMeetingBlock(body, { ...ready, joinUrl: `${JOIN_URL}-2` });
  assert.ok(updated.startsWith("  前書き\n\n\n\n箇条書き\n\n"));
  assert.ok(updated.endsWith("\n\n後書き  "));
});

test("an unterminated marker is left untouched rather than guessed at", () => {
  const broken = `メモ\n${WEB_MEETING_BLOCK_START}\n参加URL: 途中で消された`;
  const updated = upsertWebMeetingBlock(broken, ready);
  assert.ok(updated.startsWith(broken));
  assert.ok(updated.endsWith(WEB_MEETING_BLOCK_END));
});

test("a missing passcode is reported differently from one that is not required", () => {
  assert.deepEqual(describeWebMeetingCompleteness(ready), { complete: true, notes: [] });

  const notRequired = describeWebMeetingCompleteness({
    joinUrl: JOIN_URL,
    meetingId: MEETING_ID,
    passcodeAvailability: "not_required",
  });
  assert.equal(notRequired.complete, true);
  assert.ok(notRequired.notes.some((note) => note.includes("不要")));

  const unavailable = describeWebMeetingCompleteness({
    joinUrl: JOIN_URL,
    meetingId: MEETING_ID,
    passcodeAvailability: "unavailable",
  });
  assert.equal(unavailable.complete, false);
  assert.ok(unavailable.notes.some((note) => note.includes("取得できませんでした")));
  assert.notDeepEqual(notRequired.notes, unavailable.notes);

  const noMeetingId = describeWebMeetingCompleteness({
    joinUrl: JOIN_URL,
    passcodeAvailability: "not_required",
  });
  assert.equal(noMeetingId.complete, false);
});

test("a declined web meeting is never read as a request for one", () => {
  for (const prompt of ["WEBで", "web会議でお願いします", "Teamsでお願い", "オンライン会議にして", "では上記１で。WEB会議も設定して"]) {
    assert.equal(detectWebMeetingRequest(prompt), "requested", prompt);
  }
  for (const prompt of [
    "WEB会議は不要です",
    "web会議なしで",
    "WEBではない",
    "Teams会議はいらない",
    "オンラインは使わない",
    // 否定語はキーワードの直後に来るとは限らない。
    "WEBではなく会議室で",
    "WEB会議にしないでください",
    "オンラインでの打ち合わせは不要です",
    "Teamsにはしないで",
    "リモートではなく対面でお願いします",
  ]) {
    assert.equal(detectWebMeetingRequest(prompt), "declined", prompt);
  }
  // 別の文の否定を巻き込まない。
  assert.equal(detectWebMeetingRequest("WEBで。会議室は不要です"), "requested");
  assert.equal(detectWebMeetingRequest("明日の14時で会議室を押さえて"), undefined);
});

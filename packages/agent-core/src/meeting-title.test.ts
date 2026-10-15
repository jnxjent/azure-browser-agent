import assert from "node:assert/strict";
import { test } from "node:test";
import { readMeetingTitleInstruction } from "./meeting-title.js";

test("explicit agenda preserves user text and separates standalone changes", () => {
  assert.deepEqual(readMeetingTitleInstruction("議題は予算確認"), {title:"予算確認",onlyTitle:true});
  assert.deepEqual(readMeetingTitleInstruction("件名は予算確認"), {title:"予算確認",onlyTitle:true});
  assert.deepEqual(readMeetingTitleInstruction("議題は「Ａ＆Ｂ、来期計画」に変更してください。"), {title:"Ａ＆Ｂ、来期計画",onlyTitle:true});
  assert.deepEqual(readMeetingTitleInstruction("候補1で。議題は予算確認"), {title:"予算確認",onlyTitle:false});
  assert.deepEqual(readMeetingTitleInstruction("議題は予算確認です。"), {title:"予算確認",onlyTitle:true});
  assert.equal(readMeetingTitleInstruction("内容に追記して"), undefined);
  assert.throws(() => readMeetingTitleInstruction('議題は「」'), /1〜100/);
  assert.throws(() => readMeetingTitleInstruction(`議題は「${"あ".repeat(101)}」`), /1〜100/);
  assert.throws(() => readMeetingTitleInstruction('議題は「改行\n件名」'), /1〜100/);
});

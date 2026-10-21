import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractParticipantSchedules, extractFacilitySchedules, participantBusyIntervals, mergeParticipantScheduleObservations } from "./desknets-dom.js";
import { findCommonAvailability, findBookableAvailability } from "@azure-browser-agent/agent-core";
import { chromium } from "playwright";

describe("mergeParticipantScheduleObservations", () => {
  it("does not erase an earlier participant's busy blocks when DeskNet's later paints an empty row", () => {
    const busy = [{
      start: "2026-09-14T02:00:00.000Z",
      end: "2026-09-14T03:00:00.000Z",
    }];
    const first = mergeParticipantScheduleObservations([], [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy },
    ]);
    const second = mergeParticipantScheduleObservations(first, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy: [] },
      { participantId: "田倉祐亮", busy },
    ]);
    const final = mergeParticipantScheduleObservations(second, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy: [] },
      { participantId: "田倉祐亮", busy: [] },
      { participantId: "津藤俊介", busy },
    ]);

    assert.deepEqual(final, [
      { participantId: "野元潤一", busy: [] },
      { participantId: "黄子超", busy },
      { participantId: "田倉祐亮", busy },
      { participantId: "津藤俊介", busy },
    ]);
  });
});

describe("leave days are excluded from schedule candidates", () => {
  const dayStart="2026-10-22T00:00:00+09:00";
  const row={timelineWidthPx:1440,blocks:[{leftPx:540,widthPx:60}],appointmentLabels:[] as string[]};
  const window={start:"2026-10-22T13:00:00+09:00",end:"2026-10-22T15:00:00+09:00"};
  for (const title of ["有休","有給休暇","休み","午後有休","午前休み","【有給休暇】", "有 給 休 暇"]) {
    it(`excludes the full day for ${title}, including time outside the leave block`,()=>{
      const busy=participantBusyIntervals({...row,appointmentLabels:[title]},dayStart);
      const schedules=[{participantId:"本人",busy:[]},{participantId:"参加者",busy}];
      assert.deepEqual(findCommonAvailability({window,durationMinutes:60,schedules}),[]);
      assert.deepEqual(findBookableAvailability({window,durationMinutes:60,schedules,facilities:[{facilityId:"会議室",busy:[]}]}),[]);
      assert.equal(busy[0]!.end,"2026-10-22T15:00:00.000Z","next midnight JST");
    });
  }
  it("retains normal free hours and the following date",()=>{
    const schedules=[{participantId:"本人",busy:participantBusyIntervals({...row,appointmentLabels:["通常の会議"]},dayStart)}];
    assert.equal(findCommonAvailability({window,durationMinutes:60,schedules}).length,2);
    schedules[0]!.busy=participantBusyIntervals({...row,appointmentLabels:["休み"]},dayStart);
    assert.equal(findCommonAvailability({window:{start:"2026-10-23T13:00:00+09:00",end:"2026-10-23T14:00:00+09:00"},durationMinutes:60,schedules}).length,1);
  });
  for (const [title,from,to] of [["午前半休",9,13],["午後半休",14,18],["午前半休（有給休暇）",9,13],["午後半休・休み",14,18]] as const) {
    it(`${title} blocks only the configured hours even if rendered all day`,()=>{
      const busy=participantBusyIntervals({...row,blocks:[{leftPx:0,widthPx:1440}],appointmentLabels:[title]},dayStart);
      assert.deepEqual(busy,[{start:new Date(Date.parse(dayStart)+from*3_600_000).toISOString(),end:new Date(Date.parse(dayStart)+to*3_600_000).toISOString()}]);
      const candidates=findCommonAvailability({window:{start:dayStart,end:"2026-10-23T00:00:00+09:00"},durationMinutes:60,schedules:[{participantId:"本人",busy}]});
      assert.equal(candidates.length,20);
      assert.ok(candidates.some(slot=>Date.parse(slot.end)===Date.parse(busy[0]!.start)),"meeting may end exactly when leave starts");
      assert.ok(candidates.some(slot=>Date.parse(slot.start)===Date.parse(busy[0]!.end)),"meeting may start exactly when leave ends");
      assert.ok(candidates.every(slot=>Date.parse(slot.end)<=Date.parse(busy[0]!.start)||Date.parse(slot.start)>=Date.parse(busy[0]!.end)));
    });
  }
  it("retains other appointments and excludes overlapping boundary meetings",()=>{
    const busy=participantBusyIntervals({...row,blocks:[{leftPx:0,widthPx:1440},{leftPx:780,widthPx:60}],appointmentLabels:["午前半休","会議"]},dayStart);
    const schedules=[{participantId:"本人",busy}];
    assert.deepEqual(findCommonAvailability({window,durationMinutes:60,schedules}).map(slot=>slot.start),["2026-10-22T05:00:00.000Z"]);
    assert.equal(findCommonAvailability({window:{start:"2026-10-22T12:30:00+09:00",end:"2026-10-22T13:30:00+09:00"},durationMinutes:60,schedules}).length,0);
  });
  it("combines morning and afternoon leave, leaving 13:00–14:00 free",()=>{
    const busy=participantBusyIntervals({...row,blocks:[{leftPx:0,widthPx:1440},{leftPx:0,widthPx:1440}],appointmentLabels:["午前半休","午後半休"]},dayStart);
    assert.deepEqual(findBookableAvailability({window,durationMinutes:60,schedules:[{participantId:"本人",busy}],facilities:[{facilityId:"会議室",busy:[]}]}).map(slot=>slot.start),["2026-10-22T04:00:00.000Z"]);
  });
  it("does not let a half-day qualifier cancel a separate full-day leave",()=>{
    const busy=participantBusyIntervals({...row,appointmentLabels:["午前半休","有休"]},dayStart);
    assert.equal(Date.parse(busy[0]!.end)-Date.parse(busy[0]!.start),86_400_000);
  });
  it("does not lose observed leave when a later render shows other appointments",()=>{
    const busy=participantBusyIntervals({...row,appointmentLabels:["有休"]},dayStart);
    const merged=mergeParticipantScheduleObservations([{participantId:"本人",busy}],[{participantId:"本人",busy:participantBusyIntervals({...row,appointmentLabels:["会議"]},dayStart)}]);
    assert.deepEqual(findCommonAvailability({window,durationMinutes:60,schedules:merged}),[]);
  });
  it("reads truncated appointment titles from actual DOM, without applying leave names to rooms",async()=>{
    const browser=await chromium.launch({headless:true});
    try {
      const page=await browser.newPage();
      await page.setContent(`<div class="co-sel-dialog"><div class="co-sel-bottom"><table><tbody><tr><td class="name-text">本人</td><td style="width:1440px"><div class="sch-item" style="width:60px"><a title="有給休暇">…</a></div></td></tr></tbody></table></div></div><div class="ui-dialog"><div class="sch-entry-plant-reserve-list"><table><tbody><tr><td class="sch-entry-plant-name">会議室</td><td style="width:1440px"><div class="sch-item" title="休み" style="width:60px">通常予約</div></td></tr></tbody></table></div></div>`);
      const participants=await extractParticipantSchedules(page.locator("body"),dayStart);
      assert.equal(Date.parse(participants[0]!.busy[0]!.end)-Date.parse(participants[0]!.busy[0]!.start),86_400_000);
      const facilities=await extractFacilitySchedules(page.locator("body"),dayStart);
      assert.ok(Date.parse(facilities[0]!.busy[0]!.end)-Date.parse(facilities[0]!.busy[0]!.start)<86_400_000);
      await page.locator(".co-sel-dialog .sch-item a").evaluate(element=>element.setAttribute("title","午前半休（有給休暇）"));
      assert.deepEqual((await extractParticipantSchedules(page.locator("body"),dayStart))[0]!.busy,[{start:"2026-10-22T00:00:00.000Z",end:"2026-10-22T04:00:00.000Z"}]);
    } finally {await browser.close();}
  });
});

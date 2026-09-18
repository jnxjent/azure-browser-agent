import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeskNetsHandoffUrl } from "./desknets-handoff.js";
import { appendTeamsInformation, draftFromDeskNetsApproval, nativeFormPrepared, validateDraftForHandoff } from "./schedule-handoff.js";

const now = new Date("2026-09-18T00:00:00Z");
test("Phase1 URL preserves three native IDs and JST dates without text or credentials",()=>{
  const input={start:"2026-10-06T14:30:00Z",end:"2026-10-06T15:30:00Z",userIds:["101","102","103"]};
  const url=new URL(buildDeskNetsHandoffUrl(input,now));
  assert.equal(url.origin,"https://desknets.midac.jp");
  const hash=new URLSearchParams(url.hash.slice(1));
  assert.equal(hash.get("cmd"),"schaddtarget");
  assert.equal(hash.get("date"),"20261006");
  assert.equal(hash.get("enddate"),"20261007");
  assert.equal(hash.get("starttime"),"2330");
  assert.equal(hash.get("endtime"),"0030");
  assert.deepEqual(hash.getAll("id"),input.userIds);
  for(const userIds of [[],["same name"],["1","1"],["1&cmd=delete"]]) assert.throws(()=>buildDeskNetsHandoffUrl({...input,userIds},now));
  assert.throws(()=>buildDeskNetsHandoffUrl({...input,start:"2020-01-01T00:00:00Z"},now));
});
test("room handoff uses a validated native equipment ID, never a display name", () => {
  const input={start:"2026-10-06T05:00:00Z",end:"2026-10-06T06:00:00Z",userIds:["101","102","103"]};
  for (const facilityId of ["13","14"]) {
    const hash=new URLSearchParams(new URL(buildDeskNetsHandoffUrl({...input,facilityId},now)).hash.slice(1));
    assert.deepEqual(hash.getAll("pid"),[facilityId]);
    assert.deepEqual(hash.getAll("id"),input.userIds);
  }
  for(const facilityId of ["", "会議室A", "13&cmd=delete", "13,14", "1".repeat(21)]) {
    assert.throws(()=>buildDeskNetsHandoffUrl({...input,facilityId},now));
  }
});
function fixture() {
  return draftFromDeskNetsApproval({title:"打ち合わせ",start:"2026-09-19T01:00:00Z",end:"2026-09-19T02:00:00Z",
    participantIds:["本人"],facilityId:"会議室A",emailNotificationWillBeSent:false},
    {id:"draft-1",ownerId:"owner",threadId:"thread",connectionId:"test",expiresAt:"2026-09-18T00:15:00Z"});
}
const request = {ownerId:"owner",threadId:"thread",revision:1,target:{provider:"desknets" as const,connectionId:"test"}};
function resolved() {
  const d=fixture();
  d.attendees[0]!.resolution={status:"resolved",providerId:"user-1"};
  d.resources[0]!.resolution={status:"resolved",providerId:"room-1"};
  return d;
}
test("legacy display names are never silently treated as provider IDs",()=>{
  assert.throws(()=>validateDraftForHandoff(fixture(),request,now),/Unresolved/);
  assert.doesNotThrow(()=>validateDraftForHandoff(resolved(),request,now));
});
test("handoff checks ownership, connection, revision, expiry and interval",()=>{
  for(const change of [{ownerId:"other"},{threadId:"other"},{revision:2},{target:{provider:"desknets" as const,connectionId:"production"}}]) {
    assert.throws(()=>validateDraftForHandoff(resolved(),{...request,...change},now));
  }
  for(const change of [{expiresAt:now.toISOString()},{start:"2026-09-17T01:00:00Z"},{end:"2026-09-19T00:00:00Z"},{start:"2026-09-19T01:00:00"},{timeZone:"invalid"}]) {
    assert.throws(()=>validateDraftForHandoff({...resolved(),...change},request,now));
  }
  const d=resolved();d.attendees.push(d.attendees[0]!);
  assert.throws(()=>validateDraftForHandoff(d,request,now),/Duplicate/);
});
test("prepared native form is not a completed booking",()=>{
  const result=nativeFormPrepared(resolved());
  assert.equal(result.registered,false);
  assert.equal(result.status,"awaiting_native_confirmation");
});
test("Teams text preserves the body, does not invent missing fields, and retries idempotently",()=>{
  const meeting={joinUrl:"https://teams.microsoft.com/l/meetup-join/example",meetingId:"123",passcode:"abc"};
  const body=appendTeamsInformation("既存の議題\n資料を確認",meeting);
  assert.ok(body.startsWith("既存の議題\n資料を確認\n\n"));
  assert.ok(body.includes("会議ID: 123"));
  assert.equal(appendTeamsInformation(body,meeting),body);
  assert.ok(!appendTeamsInformation("",{joinUrl:meeting.joinUrl}).includes("パスコード"));
  for(const joinUrl of ["http://teams.microsoft.com/x","https://teams.microsoft.com.evil.test/x","https://user:pw@teams.microsoft.com/x"]) {
    assert.throws(()=>appendTeamsInformation("",{joinUrl}));
  }
  assert.throws(()=>appendTeamsInformation("",{...meeting,passcode:"a\nb"}));
});

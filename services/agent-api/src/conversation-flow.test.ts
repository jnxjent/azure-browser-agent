import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeskNetsBrowserWorker, buildRoomAvailabilityResult } from "@azure-browser-agent/browser-worker";
import type { BrowserRun } from "@azure-browser-agent/agent-core";

test("Japanese thread: availability → start only → duration only → final approval card", async () => {
  const meetingDirectory = await mkdtemp(join(tmpdir(), "web-meeting-flow-"));
  const originalMeetingEnv = {
    path: process.env.DESKNETS_WEB_MEETINGS_PATH,
    enabled: process.env.DESKNETS_WEB_MEETING_ENABLED,
  };
  process.env.DESKNETS_WEB_MEETINGS_PATH = join(meetingDirectory, "meetings.json");
  process.env.DESKNETS_WEB_MEETING_ENABLED = "true";
  const { server } = await import("./server.js");
  const original = DeskNetsBrowserWorker.prototype.execute;
  const originalFetch = globalThis.fetch;
  const originalEnv = { endpoint: process.env.AZURE_OPENAI_ENDPOINT, key: process.env.AZURE_OPENAI_API_KEY, deployment: process.env.AZURE_OPENAI_DEPLOYMENT };
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let writes = 0;
  let roomCBecameBusy = false;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    if (run.task?.type === "find_availability") {
      const availability = [{
        start: "2099-09-16T07:00:00.000Z", end: "2099-09-16T08:00:00.000Z",
        durationMinutes: 60, participantIds: ["本人", "髙田廣明"],
        availableFacilityIds: ["アクトミーティングルームC", "アクト大会議室"],
      }];
      return { ...run, status: "completed", result: {
        summary: "availability", evidence: [], availability,
        pendingBooking: { ...run.task, participantIds: ["本人", "髙田廣明"], availability,
          allFacilityAvailability: availability, userOrganization: "経営企画部" },
      } };
    }
    assert.equal(run.task?.type, "book_meeting");
    if (run.task?.type !== "book_meeting") throw new Error("Unexpected task");
    // Preparation only. A chat reply must never approve or register a booking.
    assert.equal(run.approval?.approvedAt, undefined);
    if (run.task.facilityOnlyChange) {
      const task = run.task;
      const facilityId = ["アクトミーティングルームC", "アクト大会議室"].find(name =>
        name.includes(task.facilityQuery!) &&
        !(roomCBecameBusy && name === "アクトミーティングルームC") &&
        !(task.excludePreviousFacility && name === task.previousFacilityId));
      assert.ok(facilityId);
      return {...run,status:"awaiting_user_input",result:{summary:"room changed",evidence:[],manualActionRequest:{
        title:run.task.title,start:run.task.selectedStart!,end:run.task.selectedEnd!,facilityId,
        participantIds:run.context!.participantIds,emailNotificationWillBeSent:run.task.sendEmail,selfNotificationSuppressed:false,
      }}};
    }
    if (roomCBecameBusy && run.task.facilityQuery === "アクトミーティングルームC") {
      throw new Error("指定した会議室「アクトミーティングルームC」は指定した日時には埋まっています。");
    }
    writes += 1;
    return { ...run, status: "awaiting_approval", result: {
      summary: "prepared", evidence: [], approvalRequest: {
        title: run.task.title, start: run.task.selectedStart!, end: run.task.selectedEnd!,
        facilityId: run.task.facilityQuery!, participantIds: run.context!.participantIds,
        emailNotificationWillBeSent: run.task.sendEmail,
      },
    } };
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  const send = async (prompt: string): Promise<BrowserRun> => {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "flow-test", threadId: "flow-test", site: "desknets", mode: "read", prompt, conversationHistory: history }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    history.push({ role: "user", content: prompt }, { role: "assistant", content: run.result?.assistantMessage ?? run.status });
    return run;
  };
  try {
    await send("2099年9月16日に私と髙田部長で打ち合わせ可能な日程を教えて");
    const numbered = await send("では上記１で。");
    assert.equal(numbered.status, "awaiting_approval", JSON.stringify(numbered));
    assert.equal(numbered.result?.approvalRequest?.facilityId, "アクトミーティングルームC");
    const added = await send("WEB会議も追加して");
    assert.equal(added.id, numbered.id, "WEB追加は元のカードをそのまま使う");
    assert.equal((added as BrowserRun & { webMeetingAdded?: boolean }).webMeetingAdded, true);
    const webMeetingResponse = await fetch(`${base}/${numbered.id}/web-meeting`);
    assert.equal(webMeetingResponse.status, 200);
    const webMeetingView = await webMeetingResponse.json() as { requested: boolean; joinUrl?: string };
    assert.equal(webMeetingView.requested, true);
    assert.equal(webMeetingView.joinUrl, undefined, "WEB希望だけではGraph会議を発行しない");
    assert.equal(numbered.result?.approvalRequest?.title, "", "unspecified title stays blank");
    assert.equal(numbered.result?.approvalRequest?.start, "2099-09-16T07:00:00.000Z");
    const selected = await send("では９/１６, １６時開始で");
    assert.equal(selected.status, "awaiting_approval", JSON.stringify(selected));
    assert.equal(selected.result?.approvalRequest?.end, "2099-09-16T08:00:00.000Z");
    assert.equal(selected.result?.approvalRequest?.facilityId, "アクトミーティングルームC");
    assert.equal(selected.result?.approvalRequest?.emailNotificationWillBeSent, true);
    const sixty = await send("60分");
    assert.equal(sixty.status, "awaiting_approval");
    assert.equal(sixty.result?.approvalRequest?.start, "2099-09-16T07:00:00.000Z");
    assert.equal(sixty.result?.approvalRequest?.end, "2099-09-16T08:00:00.000Z");
    const changed = await send("30分で");
    assert.equal(changed.status, "awaiting_approval");
    assert.equal(changed.result?.approvalRequest?.end, "2099-09-16T07:30:00.000Z");
    assert.deepEqual(changed.result?.approvalRequest?.participantIds, ["本人", "髙田廣明"]);
    assert.equal(writes, 4);
    const titled = await send("件名は「来期予算の確認」にしてください。");
    assert.equal(titled.status, "awaiting_approval", JSON.stringify(titled));
    assert.equal(titled.result?.approvalRequest?.title, "来期予算の確認");
    assert.equal(titled.result?.approvalRequest?.start, changed.result?.approvalRequest?.start);
    assert.equal(titled.result?.approvalRequest?.end, changed.result?.approvalRequest?.end);
    assert.deepEqual(titled.result?.approvalRequest?.participantIds, changed.result?.approvalRequest?.participantIds);
    assert.equal(titled.result?.approvalRequest?.facilityId, changed.result?.approvalRequest?.facilityId);
    roomCBecameBusy = true;
    const blocked = await send("30分");
    assert.equal(blocked.status, "failed");
    const alternative = await send("では、アクトの別会議室で  ");
    assert.equal(alternative.status, "awaiting_user_input", JSON.stringify(alternative));
    assert.equal(alternative.result?.manualActionRequest?.facilityId, "アクト大会議室");
    assert.equal(alternative.result?.manualActionRequest?.start, "2099-09-16T07:00:00.000Z");
    assert.equal(alternative.result?.manualActionRequest?.end, "2099-09-16T07:30:00.000Z");
    assert.deepEqual(alternative.result?.manualActionRequest?.participantIds, ["本人", "髙田廣明"]);
    await send("2099年9月16日に私と髙田部長で打ち合わせ可能な日程を教えて");
    const unavailable = await send("では9/16 16時開始で。会議室はアクト応接室で");
    assert.equal(unavailable.status, "awaiting_user_input", JSON.stringify(unavailable));
    roomCBecameBusy = false;
    const replacement = await send("では、アクトの別会議室で  ");
    assert.equal(replacement.status, "awaiting_user_input", JSON.stringify(replacement));
    assert.equal(replacement.result?.manualActionRequest?.facilityId, "アクトミーティングルームC");
    for (const prompt of ["アクトの会議室", "アクトの会議室で", "アクトの会議室にして"]) {
      const repeated = await send(prompt);
      assert.equal(repeated.status,"awaiting_user_input",JSON.stringify(repeated));
      assert.equal(repeated.result?.manualActionRequest?.start,replacement.result?.manualActionRequest?.start);
      assert.equal(repeated.result?.manualActionRequest?.end,replacement.result?.manualActionRequest?.end);
      assert.deepEqual(repeated.result?.manualActionRequest?.participantIds,["本人","髙田廣明"]);
    }
    process.env.AZURE_OPENAI_ENDPOINT = "https://semantic-test.example";
    process.env.AZURE_OPENAI_API_KEY = "test";
    process.env.AZURE_OPENAI_DEPLOYMENT = "test";
    let clarify = false;
    let interpretations = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://semantic-test.example")) return originalFetch(input, init);
      interpretations++;
      const body = JSON.parse(String(init?.body));
      assert.ok(body.messages.some((m: {content: string}) => m.content.includes("髙田部長")), "full thread reaches the interpreter");
      const latest = JSON.parse(body.messages.at(-1).content);
      assert.ok(latest.savedSchedulingState.conversation, "saved state reaches the interpreter");
      const proposal = latest.savedSchedulingState.currentProposal;
      assert.equal(proposal.start, "2099-09-16T07:00:00.000Z");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: clarify ? "clarify" : "book_meeting", question: clarify ? "件名は何にしますか？" : null,
        participants: [], dateStart: null, dateEnd: null, durationMinutes: 60,
        facilityQuery: "アクト", excludePreviousFacility: true, candidateNumber: null,
        sendEmail: true, title: "相談", selectedStart: proposal.start, selectedEnd: proposal.end,
      }) } }] }));
    };
    // No date, time, or conventional room-change keyword in this utterance.
    const semantic = await send("そこは避けて、同じ建物のほかのところをお願い");
    assert.equal(semantic.status, "awaiting_approval", JSON.stringify(semantic));
    assert.equal(semantic.result?.approvalRequest?.facilityId, "アクト大会議室");
    assert.deepEqual(semantic.result?.approvalRequest?.participantIds, ["本人", "髙田廣明"]);
    clarify = true;
    const question = await send("例のやつにして");
    assert.equal(question.status, "awaiting_user_input");
    assert.equal(question.result?.assistantMessage, "件名は何にしますか？");
    clarify = false;
    const continued = await send("相談でお願いします");
    assert.equal(continued.status, "awaiting_approval", JSON.stringify(continued));
    assert.equal(interpretations, 3);
    let failedAttempts = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://semantic-test.example")) return originalFetch(input, init);
      failedAttempts++;
      return new Response("Unavailable", { status: 503 });
    };
    const recovered = await send("アクトの別会議室で");
    assert.equal(recovered.status, "awaiting_user_input", JSON.stringify(recovered));
    assert.notEqual(recovered.result?.manualActionRequest?.facilityId, continued.result?.approvalRequest?.facilityId);
    assert.equal(recovered.result?.manualActionRequest?.start, continued.result?.approvalRequest?.start);
    assert.equal(failedAttempts, 2, "configured membership interpretation must run before room shortcuts");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ AZURE_OPENAI_ENDPOINT: originalEnv.endpoint, AZURE_OPENAI_API_KEY: originalEnv.key, AZURE_OPENAI_DEPLOYMENT: originalEnv.deployment })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    DeskNetsBrowserWorker.prototype.execute = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalMeetingEnv.path === undefined) delete process.env.DESKNETS_WEB_MEETINGS_PATH;
    else process.env.DESKNETS_WEB_MEETINGS_PATH = originalMeetingEnv.path;
    if (originalMeetingEnv.enabled === undefined) delete process.env.DESKNETS_WEB_MEETING_ENABLED;
    else process.env.DESKNETS_WEB_MEETING_ENABLED = originalMeetingEnv.enabled;
    await rm(meetingDirectory, { recursive: true, force: true });
  }
});



test("an organization reply resumes an open-ended search before intent analysis", async () => {
  const { server } = await import("./server.js");
  const originalExecute = DeskNetsBrowserWorker.prototype.execute;
  const originalFetch = globalThis.fetch;
  const savedEnvironment = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiKey: process.env.AGENT_API_KEY,
    multiUser: process.env.DESKNETS_MULTI_USER_ENABLED,
  };
  process.env.AZURE_OPENAI_ENDPOINT = "https://participant-choice-test.example";
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "test-model";
  delete process.env.AGENT_API_KEY;
  delete process.env.DESKNETS_MULTI_USER_ENABLED;

  let modelCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://participant-choice-test.example")) return originalFetch(input, init);
    modelCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      intent: "find_availability", participants: [{ name: "鈴木", organization: null }],
      dateStart: "2099-10-05", dateEnd: "2099-10-05", durationMinutes: 120,
      facilityQuery: "有玉の応接室", candidateNumber: null, sendEmail: null, title: null,
      selectedStart: null, selectedEnd: null,
    }) } }] }), { status: 200 });
  };
  let workerCalls = 0;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    if (run.task?.type === "book_meeting") {
      return { ...run, status: "awaiting_approval", result: {
        summary: "Prepared", evidence: [], approvalRequest: {
          title: run.task.title, start: run.task.selectedStart!, end: run.task.selectedEnd!,
          facilityId: run.task.facilityQuery!, participantIds: ["鈴木"], emailNotificationWillBeSent: true,
        },
      } };
    }
    assert.equal(run.task?.type, "find_availability");
    if (run.task?.type !== "find_availability") throw new Error("Unexpected task");
    workerCalls += 1;
    if (workerCalls === 1) {
      assert.equal(run.task.autoExtendSearch, true);
      return { ...run, status: "awaiting_user_input", result: {
        summary: "Ambiguous participant", evidence: [],
        participantChoice: { task: run.task, participantIndex: 0, ambiguousName: "鈴木",
          organizations: ["営業部", "総務部"], candidates: [
            { name: "鈴木太郎", organization: "営業部" },
            { name: "鈴木次郎", organization: "総務部" },
          ] },
      } };
    }
    const availability = [{ start: "2099-10-05T01:00:00.000Z", end: "2099-10-05T03:00:00.000Z",
      durationMinutes: 120, participantIds: ["鈴木"], availableFacilityIds: ["有玉本社応接室"] }];
    return { ...run, status: "completed", result: { summary: "Search resumed", evidence: [], availability,
      pendingBooking: { ...run.task, participantIds: ["鈴木"], availability, userOrganization: "経営企画部",
        allFacilityAvailability: availability.map(slot => ({ ...slot,
          availableFacilityIds: ["アクトミーティングルームC", "有玉大会議室", "有玉本社応接室"] })),
      },
    } };
  };

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  const send = async (prompt: string): Promise<BrowserRun> => {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "open-ended-choice", threadId: "open-ended-choice", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  };
  try {
    const ambiguous = await send("2099年10月5日以降で鈴木さんとの120分の打ち合わせ候補を出して");
    assert.equal(ambiguous.status, "awaiting_user_input");
    const resumed = await send("候補1で");
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed.task?.type, "find_availability");
    if (resumed.task?.type !== "find_availability") throw new Error("Unexpected resumed task");
    assert.equal(resumed.task.autoExtendSearch, true);
    assert.equal(resumed.task.participants[0]?.organization, "営業部");
    assert.equal(resumed.task.participants[0]?.name, "鈴木太郎");
    assert.equal(resumed.task.facilityQuery, "有玉");
    assert.equal(resumed.task.facilityType, "reception_room");
    const card = await send("では1で");
    assert.equal(card.status, "awaiting_approval", JSON.stringify(card));
    assert.equal(card.result?.approvalRequest?.facilityId, "有玉本社応接室",
      "the explicit reception room overrides the department's Act preference and other Aritama rooms");
    assert.equal(workerCalls, 2);
    assert.equal(modelCalls, 1, "organization replies must not be reinterpreted by the model");
  } finally {
    DeskNetsBrowserWorker.prototype.execute = originalExecute;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      AZURE_OPENAI_ENDPOINT: savedEnvironment.endpoint,
      AZURE_OPENAI_API_KEY: savedEnvironment.key,
      AZURE_OPENAI_DEPLOYMENT: savedEnvironment.deployment,
      AGENT_API_KEY: savedEnvironment.apiKey,
      DESKNETS_MULTI_USER_ENABLED: savedEnvironment.multiUser,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("one room search intersects the requester and candidate one opens their card", async () => {
  const { server } = await import("./server.js");
  const originalExecute = DeskNetsBrowserWorker.prototype.execute;
  const savedApiKey = process.env.AGENT_API_KEY;
  const savedMultiUser = process.env.DESKNETS_MULTI_USER_ENABLED;
  delete process.env.AGENT_API_KEY;
  delete process.env.DESKNETS_MULTI_USER_ENABLED;
  const slot = {
    start: "2099-10-06T04:00:00.000Z", end: "2099-10-06T05:00:00.000Z",
    durationMinutes: 60, participantIds: ["本人"],
    availableFacilityIds: ["アクト中会議室"],
  };
  let workerCalls = 0;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    workerCalls += 1;
    if (run.task?.type === "find_availability") {
      assert.deepEqual(run.task.participants, [], "the worker adds the signed-in requester");
      assert.equal(run.task.facilityQuery, "アクト中会議室");
      assert.equal(run.task.durationMinutes, 60);
      return { ...run, status: "completed", result: {
        summary: "Requester and room both free", evidence: [], availability: [slot],
        assistantMessage: "1. 10/6 13:00〜14:00 アクト中会議室",
        pendingBooking: { ...run.task, participantIds: ["本人"], availability: [slot] },
      } };
    }
    assert.equal(run.task?.type, "book_meeting");
    if (run.task?.type !== "book_meeting") throw new Error("Unexpected task");
    assert.equal(run.task.facilityQuery, "アクト中会議室");
    assert.equal(run.task.selectedStart, slot.start);
    assert.equal(run.task.selectedEnd, slot.end);
    assert.deepEqual(run.context?.participantIds, ["本人"]);
    return { ...run, status: "awaiting_approval", result: {
      summary: "One room prepared for manual confirmation", evidence: [],
      approvalRequest: { title: "", start: slot.start, end: slot.end,
        participantIds: ["本人"], facilityId: "アクト中会議室",
        emailNotificationWillBeSent: true },
    } };
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  const send = async (prompt: string): Promise<BrowserRun> => {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "self-room", threadId: "self-room", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  };
  try {
    const search = await send("2099年10月5日以降、アクト中会議室が1時間空いている候補を教えて");
    assert.equal(search.status, "completed", JSON.stringify(search));
    const chosen = await send("では候補の中の1で。");
    assert.equal(chosen.status, "awaiting_approval", JSON.stringify(chosen));
    assert.deepEqual(chosen.result?.approvalRequest?.participantIds, ["本人"]);
    assert.equal(chosen.result?.approvalRequest?.facilityId, "アクト中会議室");
    assert.equal(workerCalls, 2);
  } finally {
    DeskNetsBrowserWorker.prototype.execute = originalExecute;
    if (savedApiKey === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = savedApiKey;
    if (savedMultiUser === undefined) delete process.env.DESKNETS_MULTI_USER_ENABLED; else process.env.DESKNETS_MULTI_USER_ENABLED = savedMultiUser;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("two-location candidates open one card with two rooms for manual registration", async () => {
  const { server } = await import("./server.js");
  const originalExecute = DeskNetsBrowserWorker.prototype.execute;
  const originalFetch = globalThis.fetch;
  const savedEnvironment = {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    key: process.env.AZURE_OPENAI_API_KEY,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiKey: process.env.AGENT_API_KEY,
    multiUser: process.env.DESKNETS_MULTI_USER_ENABLED,
  };
  process.env.AZURE_OPENAI_ENDPOINT = "https://multi-location-choice-test.example";
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "test-model";
  delete process.env.AGENT_API_KEY;
  delete process.env.DESKNETS_MULTI_USER_ENABLED;
  let modelCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://multi-location-choice-test.example")) return originalFetch(input, init);
    modelCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      intent: "find_availability", participants: [{ name: "鈴木清彦", organization: "事業部" }, { name: "私", organization: null }],
      dateStart: "2099-10-05", dateEnd: "2099-10-16", durationMinutes: 60,
      facilityQuery: null, candidateNumber: null, sendEmail: null, title: null,
      selectedStart: null, selectedEnd: null,
    }) } }] }), { status: 200 });
  };
  let workerCalls = 0;
  const line = "1. 10/15 09:30〜10:30　アクト: アクト大会議室／有玉: 有玉大会議室 ＡＥＲ～アリア～";
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    workerCalls += 1;
    if (run.task?.type === "book_meeting") {
      assert.deepEqual(run.task.facilityQueries, ["アクト大会議室", "有玉大会議室 ＡＥＲ～アリア～"]);
      assert.equal(run.task.selectedStart, "2099-10-15T00:30:00.000Z");
      return { ...run, status: "awaiting_approval", result: {
        summary: "Two rooms prepared", evidence: [], approvalRequest: {
          title: "", start: run.task.selectedStart!, end: run.task.selectedEnd!,
          participantIds: ["鈴木清彦", "本人"], nativeUserIds: ["101", "102"],
          facilityId: "アクト大会議室", nativeFacilityId: "13",
          facilityIds: run.task.facilityQueries, nativeFacilityIds: ["13", "14"],
          emailNotificationWillBeSent: true,
        },
      } };
    }
    assert.equal(run.task?.type, "find_availability");
    if (run.task?.type !== "find_availability") throw new Error("Unexpected task");
    assert.deepEqual(run.task.requiredFacilityLocations, ["アクト", "有玉"]);
    const availability = [{ start: "2099-10-15T00:30:00.000Z", end: "2099-10-15T01:30:00.000Z",
      durationMinutes: 60, participantIds: ["1", "2"],
      availableFacilityIds: ["アクト大会議室", "有玉大会議室 ＡＥＲ～アリア～"],
      facilitiesByLocation: { アクト: ["アクト大会議室"], 有玉: ["有玉大会議室 ＡＥＲ～アリア～"] } }];
    return { ...run, status: "completed", result: { summary: "Two-location availability", evidence: [],
      assistantMessage: `${line}\n番号を選択してください。`, availability, multiLocationCandidateLines: [line],
      pendingBooking: { ...run.task, participantIds: ["鈴木清彦", "本人"], availability } } };
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  const send = async (prompt: string): Promise<BrowserRun> => {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "multi-choice", threadId: "multi-choice", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  };
  try {
    const search = await send("2099年10月5日以降に事業部鈴木清彦部長、私でWEBミーティングを開催したいです。時間は1時間。鈴木部長は有玉本社、私はアクト事務所で参加しますのでそれぞれ1か所の会議室を確保できる候補日を教えてください。");
    assert.equal(search.status, "completed", JSON.stringify(search));
    const pasted = await send(line.replace(/^1\. /, ""));
    assert.equal(pasted.status, "awaiting_approval", JSON.stringify(pasted));
    assert.deepEqual(pasted.result?.approvalRequest?.facilityIds, ["アクト大会議室", "有玉大会議室 ＡＥＲ～アリア～"]);
    const handoffResponse = await fetch(`${base}/${pasted.id}/handoff`, { headers: {
      "x-user-id": "multi-choice", "x-chat-thread-id": "multi-choice",
    } });
    assert.equal(handoffResponse.status, 200);
    const handoff = await handoffResponse.json() as { handoffUrl: string };
    assert.deepEqual(new URLSearchParams(new URL(handoff.handoffUrl).hash.slice(1)).getAll("pid"), ["13", "14"]);
    const numbered = await send("では、1で");
    assert.deepEqual(numbered.result?.approvalRequest?.facilityIds, ["アクト大会議室", "有玉大会議室 ＡＥＲ～アリア～"]);
    assert.equal(workerCalls, 3);
    assert.equal(modelCalls, 1, "candidate selection must be deterministic");
  } finally {
    DeskNetsBrowserWorker.prototype.execute = originalExecute;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      AZURE_OPENAI_ENDPOINT: savedEnvironment.endpoint,
      AZURE_OPENAI_API_KEY: savedEnvironment.key,
      AZURE_OPENAI_DEPLOYMENT: savedEnvironment.deployment,
      AGENT_API_KEY: savedEnvironment.apiKey,
      DESKNETS_MULTI_USER_ENABLED: savedEnvironment.multiUser,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("after a card, excluding oneself preserves the search and produces a new card without oneself", async () => {
  const aliasDirectory = await mkdtemp(join(tmpdir(), "president-alias-flow-"));
  const envKeys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "DESKNETS_WEB_MEETING_ENABLED", "DESKNETS_PARTICIPANT_ALIASES_PATH"];
  const originalEnv = envKeys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const originalWorker = DeskNetsBrowserWorker.prototype.execute;
  process.env.AZURE_OPENAI_ENDPOINT = "https://membership-card.example";
  process.env.AZURE_OPENAI_API_KEY = "mock-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "mock-intent";
  process.env.DESKNETS_WEB_MEETING_ENABLED = "false";
  process.env.DESKNETS_PARTICIPANT_ALIASES_PATH = join(aliasDirectory, "aliases.json");
  let modelCalls = 0;
  let invalidConditions = false;
  let modeledMembership: "include" | "exclude" | "unchanged" | "unclear" = "unchanged";
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://membership-card.example")) return originalFetch(input, init);
    if (++modelCalls > 1) {
      const latest = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
      if (["はい", "いいえ"].includes(latest.latestUserMessage)) assert.equal(latest.savedSchedulingState.conversation.requesterMembershipQuestion, true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: invalidConditions || /候補を出し直して|応接室の空きを/.test(latest.latestUserMessage) ? "find_availability" : latest.latestUserMessage.startsWith("候補1で") ? "select_booking_candidate" : "show_candidates",
        candidateNumber: 1,
        participants: invalidConditions ? [] : [{name:"加藤恵子", organization:null}], dateStart:invalidConditions ? null : "2099-09-16",dateEnd:"2099-09-22",
        durationMinutes:60,facilityQuery:"アクト応接室",title:"相談",
        requesterMembership: modeledMembership,
        requesterMembershipEvidence: modeledMembership === "unchanged" ? null : JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).latestUserMessage,
      }) } }] }), { status: 200 });
    }
    assert.match(String(init?.body), /加藤恵子/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "find_availability",
      participants: [{ name: "加藤恵子", organization: null }], dateStart: "2099-09-16", dateEnd: "2099-09-22",
      durationMinutes: 60, facilityQuery: "アクト応接室", title: "相談", excludeRequester: false }) } }] }), { status: 200 });
  };
  let searches = 0;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    if (run.task?.type === "find_availability") {
      searches++;
      assert.deepEqual(run.task.participants, [{ name: "加藤恵子" }]);
      assert.equal(run.task.date, "2099-09-16"); assert.equal(run.task.endDate, "2099-09-22");
      assert.equal(run.task.durationMinutes, 60); assert.equal(run.task.facilityQuery, "アクト応接室");
      assert.equal(run.task.title, "相談");
      assert.equal(run.task.candidateWindows, undefined, "rescan the original period, not only the old candidates");
      const participantIds = run.task.excludeRequester ? ["加藤恵子"] : ["本人", "加藤恵子"];
      const hours = run.task.excludeRequester ? [0, 1] : [1];
      const availability = hours.map(hour => ({ start: `2099-09-16T0${hour}:00:00.000Z`, end: `2099-09-16T0${hour + 1}:00:00.000Z`,
        durationMinutes: 60, participantIds, availableFacilityIds: ["アクト応接室"] }));
      return { ...run, status: "completed", result: { summary: "searched", assistantMessage: "1. 9/16 09:00〜10:00", evidence: [], availability,
        pendingBooking: { ...run.task, participantIds, availability, allFacilityAvailability: availability,
          ...(run.task.excludeRequester ? { excludedRequesterId: "本人" } : {}) } } };
    }
    assert.equal(run.task?.type, "book_meeting");
    if (run.task?.type !== "book_meeting") throw new Error("Unexpected task");
    assert.equal(run.approval?.approvedAt, undefined);
    return { ...run, status: "awaiting_user_input", result: { summary: "prepared only", evidence: [], manualActionRequest: {
      title: run.task.title, start: run.task.selectedStart!, end: run.task.selectedEnd!, facilityId: "アクト応接室",
      participantIds: run.context!.participantIds, emailNotificationWillBeSent: run.task.sendEmail, selfNotificationSuppressed: false } } };
  };
  const { server } = await import("./server.js");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  async function send(prompt: string): Promise<BrowserRun> {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "membership-card", threadId: "membership-card", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun; assert.equal(response.status, 202, JSON.stringify(run));
    for (let i = 0; ["queued", "running"].includes(run.status) && i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  }
  try {
    const aliasResponse = await fetch(`http://127.0.0.1:${address.port}/browser-agent/participant-aliases`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: "加藤社長", formalName: "加藤恵子" }),
    });
    assert.ok(aliasResponse.ok);
    await send("今週、加藤社長の空いている日程を教えて。時間は１時間。場所は、アクト応接室");
    const firstCard = await send("1で");
    assert.deepEqual(firstCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledMembership = "include";
    const unchangedCard = await send("候補1で。私も参加します");
    assert.equal(searches, 1, "already-included requester must keep the selected candidate");
    assert.deepEqual(unchangedCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledMembership = "exclude";
    const refreshed = await send("私は会議に参加しないので、除外してください。再び候補をください。");
    assert.equal(refreshed.status, "completed", JSON.stringify(refreshed));
    assert.match(refreshed.result?.assistantMessage ?? "", /あなたを除外/);
    assert.equal(refreshed.result?.availability?.length, 2, "removing the requester can introduce new slots");
    assert.equal((await (await fetch(`${base}/${firstCard.id}`)).json() as BrowserRun).status, "cancelled");
    const secondCard = await send("1で");
    assert.equal(secondCard.status, "awaiting_user_input", JSON.stringify(secondCard));
    assert.deepEqual(secondCard.result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    assert.ok(Date.parse(secondCard.result!.manualActionRequest!.start) < Date.parse(firstCard.result!.manualActionRequest!.start));
    const unable = await send("私は参加できないので、候補を出し直して");
    assert.equal(searches, 3, "even an already excluded requester gets a fresh search for a definite exclusion");
    assert.deepEqual(unable.result?.availability?.[0]?.participantIds, ["加藤恵子"]);
    modeledMembership = "unclear";
    const unclear = await send("私は参加できないかもしれない。候補を見せて");
    assert.equal(unclear.status, "awaiting_user_input");
    assert.equal(unclear.result?.assistantMessage, "ご自身を参加者から外しますか？");
    modeledMembership = "exclude";
    await send("はい");
    assert.equal(searches, 4);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "unchanged";
    await send("鈴木さんは参加できないので外して。候補を見せて");
    assert.equal(searches, 4);
    await send("私も参加します");
    assert.equal(searches, 4, "regex inclusion must not override unchanged from the LLM");
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "include";
    await send("私も参加します");
    const thirdCard = await send("1で");
    assert.deepEqual(thirdCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    assert.equal(searches, 5);
    modeledMembership = "exclude";
    invalidConditions = true;
    const semanticExclusion = await send("私は今回は同席を見送ります。候補を見せて");
    invalidConditions = false;
    assert.equal(semanticExclusion.intentSource, "azure_openai", "invalid task fields must not replace LLM membership with regex");
    assert.equal((await (await fetch(`${base}/${thirdCard.id}`)).json() as BrowserRun).status, "cancelled");
    assert.equal(searches, 6, "show_candidates plus semantic exclusion must become a fresh search");
    assert.deepEqual(semanticExclusion.result?.availability?.[0]?.participantIds, ["加藤恵子"]);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "include";
    await send("私も入れて");
    assert.equal(searches, 7);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledMembership = "unclear";
    await send("参加できないかもしれない");
    assert.equal(searches, 7);
    modeledMembership = "exclude";
    await send("はい");
    assert.equal(searches, 8);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    await send("私は不参加です。アクト応接室の空きを調べて");
    assert.equal(searches, 9, "room-only shortcuts must not swallow a membership correction");
    assert.equal(modelCalls, 14, "the preliminary room interpretation is reused, not requested twice");
  } finally {
    globalThis.fetch = originalFetch; DeskNetsBrowserWorker.prototype.execute = originalWorker;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    envKeys.forEach((key, index) => { if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index]; });
    await rm(aliasDirectory, { recursive: true, force: true });
  }
});


test("room-only search → candidate number or pasted time → confirmation card", async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "DESKNETS_WEB_MEETING_ENABLED"];
  const originalEnv = envKeys.map(key => process.env[key]);
  envKeys.forEach(key => delete process.env[key]);
  process.env.DESKNETS_WEB_MEETING_ENABLED = "false";
  const original = DeskNetsBrowserWorker.prototype.execute;
  let preparations = 0;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    if (run.task?.type === "find_availability") {
      const slots = ["2099-09-16T00:00:00Z", "2099-09-16T01:00:00Z"].map(start => ({ start: new Date(start).toISOString(),
        end: new Date(Date.parse(start) + 3600000).toISOString(), durationMinutes: 60,
        participantIds: [], availableFacilityIds: ["アクト応接室"] }));
      return { ...run, status: "completed", result: buildRoomAvailabilityResult({ ...run.task, type: "find_room_availability", facilityQuery: run.task.facilityQuery!, windowStart: run.task.windowStart ?? "09:00", windowEnd: run.task.windowEnd ?? "17:00" }, slots, ["本人"], []) };
    }
    assert.equal(run.task?.type, "book_meeting");
    if (run.task?.type !== "book_meeting") throw new Error("Expected booking preparation");
    assert.equal(run.task.facilityQuery, "アクト応接室");
    assert.equal(run.approval?.approvedAt, undefined);
    assert.deepEqual(run.context?.participantIds, ["本人"]);
    preparations++;
    return { ...run, status: "awaiting_approval", result: { summary: "prepared only", evidence: [], approvalRequest: {
      title: run.task.title, start: run.task.selectedStart!, end: run.task.selectedEnd!, facilityId: "アクト応接室",
      participantIds: ["本人"], emailNotificationWillBeSent: run.task.sendEmail, selfNotificationSuppressed: false } } };
  };
  const { server } = await import("./server.js");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  async function send(prompt: string): Promise<BrowserRun> {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "room-flow-test", threadId: "room-flow-test", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  }
  try {
    const found = await send("2099年9月16日にアクト応接室を60分利用できる空き時間を教えて");
    assert.match(found.result?.assistantMessage ?? "", /1\. 9\/16\(水\) 09:00/);
    assert.match(found.result?.assistantMessage ?? "", /2\. 9\/16\(水\) 10:00/);
    const numbered = await send("候補1で");
    assert.equal(numbered.status, "awaiting_approval", JSON.stringify(numbered));
    assert.equal(Date.parse(numbered.result!.approvalRequest!.start), Date.parse("2099-09-16T00:00:00Z"));
    const pasted = await send("では、以下で。9/16 10:00〜11:00");
    assert.equal(pasted.status, "awaiting_approval", JSON.stringify(pasted));
    assert.equal(Date.parse(pasted.result!.approvalRequest!.start), Date.parse("2099-09-16T01:00:00Z"));
    assert.equal(preparations, 2);
    process.env.AZURE_OPENAI_ENDPOINT = "https://room-review.example";
    process.env.AZURE_OPENAI_API_KEY = "mock-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "mock-intent";
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://room-review.example")) return originalFetch(input, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "book_meeting", facilityQuery: null, title: null, sendEmail: false,
        selectedStart: "2099-09-16T00:00:00Z", selectedEnd: "2099-09-16T01:00:00Z",
      }) } }] }), { status: 200 });
    };
    const modelSelected = await send("では、以下で。9/16 09:00〜10:00");
    assert.equal(modelSelected.status, "awaiting_approval", JSON.stringify(modelSelected));
    assert.equal(modelSelected.result?.approvalRequest?.facilityId, "アクト応接室");
    assert.equal(preparations, 3);
  } finally {
    globalThis.fetch = originalFetch;
    DeskNetsBrowserWorker.prototype.execute = original;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    envKeys.forEach((key, index) => { if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index]; });
  }
});


test("candidate selection with requester exclusion or inclusion always searches again", async () => {
  const originalFetch = globalThis.fetch;
  const envKeys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "DESKNETS_WEB_MEETING_ENABLED"];
  const originalEnv = envKeys.map(key => process.env[key]);
  for (const key of envKeys) delete process.env[key];
  process.env.DESKNETS_WEB_MEETING_ENABLED = "false";
  const original = DeskNetsBrowserWorker.prototype.execute;
  const tasks: BrowserRun["task"][] = [];
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    tasks.push(run.task);
    assert.equal(run.task?.type, "find_availability", "membership change must never prepare an old candidate");
    if (run.task?.type !== "find_availability") throw new Error("Expected fresh search");
    const participantIds = run.task.excludeRequester ? ["髙田廣明"] : ["本人", "髙田廣明"];
    const availability = [{ start: "2099-09-16T07:00:00.000Z", end: "2099-09-16T08:00:00.000Z",
      durationMinutes: 60, participantIds, availableFacilityIds: ["アクトミーティングルームC"] }];
    return { ...run, status: "completed", result: { summary: "mock search", evidence: [], availability,
      pendingBooking: { ...run.task, participantIds, availability, allFacilityAvailability: availability,
        ...(run.task.excludeRequester ? { excludedRequesterId: "本人" } : {}) } } };
  };
  const { server } = await import("./server.js");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  async function send(prompt: string): Promise<BrowserRun> {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "requester-change-test", threadId: "requester-change-test", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun;
    assert.equal(response.status, 202, JSON.stringify(run));
    for (let attempt = 0; ["queued", "running"].includes(run.status) && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    assert.equal(run.status, "completed", JSON.stringify(run));
    return run;
  }
  try {
    await send("2099年9月16日に私と髙田部長で打ち合わせ可能な日程を教えて");
    const excluded = await send("候補1で。私は参加しない");
    assert.deepEqual(excluded.result?.availability?.[0]?.participantIds, ["髙田廣明"]);
    const included = await send("候補1で。私も参加します");
    assert.deepEqual(included.result?.availability?.[0]?.participantIds, ["本人", "髙田廣明"]);
    assert.equal(tasks.length, 3);
    assert.equal(tasks[1]?.type === "find_availability" && tasks[1].excludeRequester, true);
    assert.equal(tasks[2]?.type === "find_availability" && tasks[2].excludeRequester, false);
    // TestSite uses LLM intent analysis. Even a candidate-selection response
    // from the model must not skip an explicit membership change.
    process.env.AZURE_OPENAI_ENDPOINT = "https://requester-review.example";
    process.env.AZURE_OPENAI_API_KEY = "mock-key";
    process.env.AZURE_OPENAI_DEPLOYMENT = "mock-intent";
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://requester-review.example")) return originalFetch(input, init);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "select_booking_candidate", candidateNumber: 1,
        requesterMembership: JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).latestUserMessage.includes("私も参加します") ? "include" : "exclude",
        requesterMembershipEvidence: JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).latestUserMessage.includes("私も参加します") ? "私も参加します" : "私は参加しません",
      }) } }] }), { status: 200 });
    };
    const modelExcluded = await send("候補1で。私は参加しません");
    assert.deepEqual(modelExcluded.result?.availability?.[0]?.participantIds, ["髙田廣明"]);
    const modelIncluded = await send("候補1で。私も参加します");
    assert.deepEqual(modelIncluded.result?.availability?.[0]?.participantIds, ["本人", "髙田廣明"]);
    assert.equal(tasks.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
    DeskNetsBrowserWorker.prototype.execute = original;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    envKeys.forEach((key, index) => { if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index]; });
  }
});


test("membership confirmation resumes a new request even without prior state or over an older search", async () => {
  const keys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT"];
  const savedEnv = keys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const originalWorker = DeskNetsBrowserWorker.prototype.execute;
  process.env.AZURE_OPENAI_ENDPOINT = "https://new-membership.example";
  process.env.AZURE_OPENAI_API_KEY = "mock";
  process.env.AZURE_OPENAI_DEPLOYMENT = "mock";
  let searches = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://new-membership.example")) return originalFetch(input, init);
    const latest = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
    const answer = latest.latestUserMessage;
    if (answer === "はい") {
      assert.equal(latest.savedSchedulingState.requesterMembershipQuestion, true);
      assert.match(latest.savedSchedulingState.pendingRequesterMembership.originalPrompt, /鈴木/);
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:"show_candidates",requesterMembership:"exclude",requesterMembershipEvidence:"はい"})}}]}));
    }
    const uncertain = answer.includes("かもしれない");
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      intent: uncertain ? "clarify" : "find_availability", question: uncertain ? "参加しますか？" : null,
      requesterMembership: uncertain ? "unclear" : "unchanged", requesterMembershipEvidence: uncertain ? "私は参加できないかもしれない" : null,
      participants:[{name: uncertain ? "鈴木" : "田中",organization:null}],
      dateStart: uncertain ? "2099-10-02" : "2099-09-16", dateEnd: uncertain ? "2099-10-03" : "2099-09-16",
      durationMinutes: uncertain ? 90 : 30, facilityQuery: uncertain ? "新会議室" : "旧会議室", title:null,
    })}}]}));
  };
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    assert.equal(run.task?.type,"find_availability");
    if (run.task?.type !== "find_availability") throw new Error("unexpected task");
    searches++;
    const participantIds = run.task.excludeRequester ? ["鈴木"] : ["本人", "田中"];
    const availability = [{start:`${run.task.date}T01:00:00Z`,end:`${run.task.date}T02:30:00Z`,durationMinutes:run.task.durationMinutes,
      participantIds,availableFacilityIds:[run.task.facilityQuery!]}];
    return {...run,status:"completed",result:{summary:"searched",evidence:[],availability,
      pendingBooking:{...run.task,participantIds,availability,allFacilityAvailability:availability}}};
  };
  const {server} = await import("./server.js");
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address(); assert.ok(address && typeof address !== "string");
  const base=`http://127.0.0.1:${address.port}/browser-agent/runs`;
  async function send(threadId:string,prompt:string):Promise<BrowserRun> {
    const response=await fetch(base,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userId:"pending-new",threadId,site:"desknets",mode:"read",prompt})});
    let run=await response.json() as BrowserRun; assert.equal(response.status,202,JSON.stringify(run));
    for(let i=0;["queued","running"].includes(run.status) && i<100;i++) {
      await new Promise(resolve=>setTimeout(resolve,5));run=await(await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  }
  try {
    for(const withPrevious of [false,true]) {
      const threadId=`new-membership-${withPrevious}`;
      if(withPrevious) await send(threadId,"田中さんと9月16日の空き時間");
      const before=searches;
      const question=await send(threadId,"鈴木さんと来週、私は参加できないかもしれない");
      assert.equal(question.result?.assistantMessage,"ご自身を参加者から外しますか？");
      assert.equal(searches,before,"unclear must not perform a search");
      const answer=await send(threadId,"はい");
      assert.equal(answer.status,"completed",JSON.stringify(answer));
      assert.equal(searches,before+1);
      assert.deepEqual(answer.task?.type === "find_availability" && answer.task.participants,[{name:"鈴木"}]);
      assert.equal(answer.task?.type === "find_availability" && answer.task.date,"2099-10-02");
      assert.equal(answer.task?.type === "find_availability" && answer.task.durationMinutes,90);
      assert.equal(answer.task?.type === "find_availability" && answer.task.facilityQuery,"新会議室");
      assert.deepEqual(answer.result?.availability?.[0]?.participantIds,["鈴木"]);
    }
  } finally {
    globalThis.fetch=originalFetch; DeskNetsBrowserWorker.prototype.execute=originalWorker;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    keys.forEach((key,index)=>{if(savedEnv[index]===undefined)delete process.env[key];else process.env[key]=savedEnv[index];});
  }
});

test("buffer correction refreshes candidates and invalidates old cards", async () => {
  const aliasDirectory = await mkdtemp(join(tmpdir(), "president-alias-flow-"));
  const envKeys = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT", "DESKNETS_WEB_MEETING_ENABLED", "DESKNETS_PARTICIPANT_ALIASES_PATH"];
  const originalEnv = envKeys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const originalWorker = DeskNetsBrowserWorker.prototype.execute;
  process.env.AZURE_OPENAI_ENDPOINT = "https://buffer-card.example";
  process.env.AZURE_OPENAI_API_KEY = "mock-key";
  process.env.AZURE_OPENAI_DEPLOYMENT = "mock-intent";
  process.env.DESKNETS_WEB_MEETING_ENABLED = "false";
  process.env.DESKNETS_PARTICIPANT_ALIASES_PATH = join(aliasDirectory, "aliases.json");
  let modelCalls = 0;
  let invalidConditions = false;
  let newSearch = false;
  let modeledBuffer: number | null = null;
  let modeledMembership: "include" | "exclude" | "unchanged" | "unclear" = "unchanged";
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://buffer-card.example")) return originalFetch(input, init);
    if (++modelCalls > 1) {
      const latest = JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content);
      if (["はい", "いいえ"].includes(latest.latestUserMessage)) assert.equal(latest.savedSchedulingState.conversation.requesterMembershipQuestion, true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: newSearch || invalidConditions || /候補を出し直して|応接室の空きを/.test(latest.latestUserMessage) ? "find_availability" : latest.latestUserMessage.startsWith("候補1で") ? "select_booking_candidate" : "show_candidates",
        bufferBeforeMinutes: modeledBuffer, bufferAfterMinutes: null,
        candidateNumber: 1,
        participants: newSearch ? [{name:"New Participant",organization:null}] : invalidConditions ? [] : [{name:"加藤恵子", organization:null}], dateStart:newSearch ? "2099-10-01" : invalidConditions ? null : "2099-09-16",dateEnd:newSearch ? "2099-10-03" : "2099-09-22",
        durationMinutes:newSearch ? 90 : 60,facilityQuery:newSearch ? "New Room" :"アクト応接室",title:"相談",
        requesterMembership: modeledMembership,
        requesterMembershipEvidence: modeledMembership === "unchanged" ? null : JSON.parse(JSON.parse(String(init?.body)).messages.at(-1).content).latestUserMessage,
      }) } }] }), { status: 200 });
    }
    assert.match(String(init?.body), /加藤恵子/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "find_availability",
      participants: [{ name: "加藤恵子", organization: null }], dateStart: "2099-09-16", dateEnd: "2099-09-22",
      durationMinutes: 60, facilityQuery: "アクト応接室", title: "相談", excludeRequester: false }) } }] }), { status: 200 });
  };
  let searches = 0;
  DeskNetsBrowserWorker.prototype.execute = async (run: BrowserRun) => {
    if (run.task?.type === "find_availability") {
      searches++;
      if (newSearch) {
        assert.deepEqual(run.task.participants, [{name:"New Participant"}]);
        assert.equal(run.task.date,"2099-10-01");
        assert.equal(run.task.endDate,"2099-10-03");
        assert.equal(run.task.durationMinutes,90);
        assert.equal(run.task.facilityQuery,"New Room");
        assert.equal(run.task.bufferBeforeMinutes,30);
        assert.equal(run.task.bufferAfterMinutes ?? 0,0);
        return {...run,status:"completed",result:{summary:"new search",evidence:[]}};
      }
      assert.deepEqual(run.task.participants, [{ name: "加藤恵子" }]);
      assert.equal(run.task.date, "2099-09-16"); assert.equal(run.task.endDate, "2099-09-22");
      assert.equal(run.task.durationMinutes, 60); assert.equal(run.task.facilityQuery, "アクト応接室");
      assert.equal(run.task.title, "相談");
      if (modeledBuffer !== null) assert.equal(run.task.bufferBeforeMinutes, modeledBuffer);
      assert.equal(run.task.candidateWindows, undefined, "rescan the original period, not only the old candidates");
      const participantIds = run.task.excludeRequester ? ["加藤恵子"] : ["本人", "加藤恵子"];
      const hours = run.task.excludeRequester ? [0, 1] : [1];
      const availability = hours.map(hour => ({ start: `2099-09-16T0${hour}:00:00.000Z`, end: `2099-09-16T0${hour + 1}:00:00.000Z`,
        durationMinutes: 60, participantIds, availableFacilityIds: ["アクト応接室"] }));
      return { ...run, status: "completed", result: { summary: "searched", assistantMessage: "1. 9/16 09:00〜10:00", evidence: [], availability,
        pendingBooking: { ...run.task, participantIds, availability, allFacilityAvailability: availability,
          ...(run.task.excludeRequester ? { excludedRequesterId: "本人" } : {}) } } };
    }
    assert.equal(run.task?.type, "book_meeting");
    if (run.task?.type !== "book_meeting") throw new Error("Unexpected task");
    assert.equal(run.approval?.approvedAt, undefined);
    return { ...run, status: "awaiting_user_input", result: { summary: "prepared only", evidence: [], manualActionRequest: {
      title: run.task.title, start: run.task.selectedStart!, end: run.task.selectedEnd!, facilityId: "アクト応接室",
      participantIds: run.context!.participantIds, emailNotificationWillBeSent: run.task.sendEmail, selfNotificationSuppressed: false } } };
  };
  const { server } = await import("./server.js");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/browser-agent/runs`;
  async function send(prompt: string): Promise<BrowserRun> {
    const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "buffer-card", threadId: "buffer-card", site: "desknets", mode: "read", prompt }) });
    let run = await response.json() as BrowserRun; assert.equal(response.status, 202, JSON.stringify(run));
    for (let i = 0; ["queued", "running"].includes(run.status) && i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 5)); run = await (await fetch(`${base}/${run.id}`)).json() as BrowserRun;
    }
    return run;
  }
  try {
    const aliasResponse = await fetch(`http://127.0.0.1:${address.port}/browser-agent/participant-aliases`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: "加藤社長", formalName: "加藤恵子" }),
    });
    assert.ok(aliasResponse.ok);
    await send("今週、加藤社長の空いている日程を教えて。時間は１時間。場所は、アクト応接室");
    const firstCard = await send("1で");
    assert.deepEqual(firstCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledMembership = "include";
    const unchangedCard = await send("候補1で。私も参加します");
    assert.equal(searches, 1, "already-included requester must keep the selected candidate");
    assert.deepEqual(unchangedCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledMembership = "exclude";
    const refreshed = await send("私は会議に参加しないので、除外してください。再び候補をください。");
    assert.equal(refreshed.status, "completed", JSON.stringify(refreshed));
    assert.match(refreshed.result?.assistantMessage ?? "", /あなたを除外/);
    assert.equal(refreshed.result?.availability?.length, 2, "removing the requester can introduce new slots");
    assert.equal((await (await fetch(`${base}/${firstCard.id}`)).json() as BrowserRun).status, "cancelled");
    const secondCard = await send("1で");
    assert.equal(secondCard.status, "awaiting_user_input", JSON.stringify(secondCard));
    assert.deepEqual(secondCard.result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    assert.ok(Date.parse(secondCard.result!.manualActionRequest!.start) < Date.parse(firstCard.result!.manualActionRequest!.start));
    const unable = await send("私は参加できないので、候補を出し直して");
    assert.equal(searches, 3, "even an already excluded requester gets a fresh search for a definite exclusion");
    assert.deepEqual(unable.result?.availability?.[0]?.participantIds, ["加藤恵子"]);
    modeledMembership = "unclear";
    const unclear = await send("私は参加できないかもしれない。候補を見せて");
    assert.equal(unclear.status, "awaiting_user_input");
    assert.equal(unclear.result?.assistantMessage, "ご自身を参加者から外しますか？");
    modeledMembership = "exclude";
    await send("はい");
    assert.equal(searches, 4);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "unchanged";
    await send("鈴木さんは参加できないので外して。候補を見せて");
    assert.equal(searches, 4);
    await send("私も参加します");
    assert.equal(searches, 4, "regex inclusion must not override unchanged from the LLM");
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "include";
    await send("私も参加します");
    const thirdCard = await send("1で");
    assert.deepEqual(thirdCard.result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    assert.equal(searches, 5);
    modeledMembership = "exclude";
    invalidConditions = true;
    const semanticExclusion = await send("私は今回は同席を見送ります。候補を見せて");
    invalidConditions = false;
    assert.equal(semanticExclusion.intentSource, "azure_openai", "invalid task fields must not replace LLM membership with regex");
    assert.equal((await (await fetch(`${base}/${thirdCard.id}`)).json() as BrowserRun).status, "cancelled");
    assert.equal(searches, 6, "show_candidates plus semantic exclusion must become a fresh search");
    assert.deepEqual(semanticExclusion.result?.availability?.[0]?.participantIds, ["加藤恵子"]);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    modeledMembership = "include";
    await send("私も入れて");
    assert.equal(searches, 7);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["本人", "加藤恵子"]);
    modeledBuffer = 30;
    const oldCard = await send("1で");
    const buffered = await send("やはり前の打ち合わせの終了時間から30分余裕をもたせて");
    assert.equal(buffered.task?.type, "find_availability");
    assert.equal(searches, 8);
    assert.equal((await (await fetch(`${base}/${oldCard.id}`)).json() as BrowserRun).status,"cancelled");
    assert.ok((await send("1で")).result?.manualActionRequest);
    modeledBuffer = 15;
    await send("候補1で。ただ会議前の準備を15分空けて");
    assert.equal(searches, 9, "buffer correction supersedes candidate selection");
    assert.ok((await send("1で")).result?.manualActionRequest);
    modeledBuffer = null;
    modeledMembership = "unclear";
    await send("参加できないかもしれない");
    assert.equal(searches, 9);
    modeledMembership = "exclude";
    await send("はい");
    assert.equal(searches, 10);
    assert.deepEqual((await send("1で")).result?.manualActionRequest?.participantIds, ["加藤恵子"]);
    await send("私は不参加です。アクト応接室の空きを調べて");
    assert.equal(searches, 11, "room-only shortcuts must not swallow a membership correction");
    assert.equal(modelCalls, 16, "the preliminary room interpretation is reused, not requested twice");
    invalidConditions = true;
    modeledBuffer = 20;
    await send("Leave 20 minutes before the meeting");
    invalidConditions = false;
    newSearch = true;
    modeledBuffer = 30;
    const fresh = await send("Find New Participant in October for 90 minutes in New Room, leave 30 minutes before");
    assert.equal(fresh.status,"completed",JSON.stringify(fresh));
    assert.equal(searches,13);

  } finally {
    globalThis.fetch = originalFetch; DeskNetsBrowserWorker.prototype.execute = originalWorker;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    envKeys.forEach((key, index) => { if (originalEnv[index] === undefined) delete process.env[key]; else process.env[key] = originalEnv[index]; });
    await rm(aliasDirectory, { recursive: true, force: true });
  }
});

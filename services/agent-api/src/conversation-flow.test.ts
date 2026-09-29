import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeskNetsBrowserWorker } from "@azure-browser-agent/browser-worker";
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
    assert.equal(failedAttempts, 0);
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
          organizations: ["営業部", "総務部"] },
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
    const resumed = await send("営業部です");
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed.task?.type, "find_availability");
    if (resumed.task?.type !== "find_availability") throw new Error("Unexpected resumed task");
    assert.equal(resumed.task.autoExtendSearch, true);
    assert.equal(resumed.task.participants[0]?.organization, "営業部");
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

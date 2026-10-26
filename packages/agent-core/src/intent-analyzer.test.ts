import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeDeskNetsIntent } from "./intent-analyzer.js";

const config = { endpoint: "https://example.openai.azure.com", apiKey: "test-key", deployment: "intent-model" };

describe("analyzeDeskNetsIntent", () => {
  it("retains explicit business half-days when the model output omits time restrictions", async () => {
    for (const [period, start, end] of [["午前", "09:00", "12:00"], ["午後", "13:00", "18:00"]]) {
      const result = await analyzeDeskNetsIntent(`鈴木強真さんと2人で打ち合わせしたい。10/27～30の${period}で30分設定したいので日程候補教えて`, new Date("2026-10-26T09:00:00+09:00"), {
        config, requireLlm: true,
        fetchImplementation: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          intent: "find_availability", participants: [{ name: "鈴木強真", organization: null }],
          dateStart: "2026-10-27", dateEnd: "2026-10-30", durationMinutes: 30,
          facilityQuery: null, candidateNumber: null, sendEmail: null, title: null,
          selectedStart: null, selectedEnd: null,
        }) } }] }), { status: 200 }),
      });
      assert.equal(result.source, "azure_openai");
      assert.equal(result.task.type, "find_availability");
      if (result.task.type !== "find_availability") throw new Error("Expected availability search");
      assert.equal(result.task.windowStart, start);
      assert.equal(result.task.windowEnd, end);
      assert.equal(result.task.endDate, "2026-10-30");
    }
  });
  it("preserves dialogue and asks for clarification instead of silently reparsing after an LLM failure", async () => {
    const result = await analyzeDeskNetsIntent("さっきの続きで", new Date(), {
      config, requireLlm: true,
      conversationHistory: [{ role: "user", content: "明日16時から30分で" }],
      conversationState: { selectedStart: "2026-09-17T07:00:00Z" },
      fetchImplementation: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.ok(body.messages.some((m: {content: string}) => m.content === "明日16時から30分で"));
        assert.equal(JSON.parse(body.messages.at(-1).content).savedSchedulingState.selectedStart, "2026-09-17T07:00:00Z");
        return new Response("Unavailable", { status: 503 });
      },
    });
    assert.equal(result.task.type, "clarify");
  });
  it("uses Azure OpenAI structured output for a relative date range", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [{ name: "私", organization: null }, { name: "安全太郎", organization: null }],
        dateStart: "2026-08-06",
        dateEnd: "2026-08-12",
        durationMinutes: 60,
        facilityQuery: null,
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await analyzeDeskNetsIntent("安全太郎さんと1週間以内で空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.equal(result.source, "azure_openai");
    assert.deepEqual(result.task, {
      type: "find_availability",
      participants: [{ name: "安全太郎" }],
      date: "2026-08-06",
      endDate: "2026-08-12",
      durationMinutes: 60,
    });
    assert.equal((requestBody?.response_format as { type?: string }).type, "json_schema");
  });

  it("searches seven days from an open-ended start when the model omits dateEnd", async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [{ name: "山田", organization: null }],
        dateStart: "2026-10-05",
        dateEnd: null,
        durationMinutes: 120,
        facilityQuery: "有玉の応接室",
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200 });
    const result = await analyzeDeskNetsIntent(
      "10月5日以降で山田さんとの120分の打ち合わせ。会場は有玉の応接室。候補日を出してください。",
      new Date("2026-09-28T12:00:00+09:00"),
      { config, requireLlm: true, fetchImplementation },
    );
    assert.equal(result.failureKind, undefined);
    assert.deepEqual(result.task, {
      type: "find_availability",
      participants: [{ name: "山田" }],
      date: "2026-10-05",
      endDate: "2026-10-11",
      durationMinutes: 120,
      facilityQuery: "有玉の応接室",
    });
  });

  it("carries a structured participant organization through to the task", async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [{ name: "山本", organization: "総務部" }],
        dateStart: "2026-08-06",
        dateEnd: "2026-08-06",
        durationMinutes: 60,
        facilityQuery: null,
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const result = await analyzeDeskNetsIntent("総務部の山本さんと今日空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.deepEqual(result.task, {
      type: "find_availability",
      participants: [{ name: "山本", organization: "総務部" }],
      date: "2026-08-06",
      endDate: "2026-08-06",
      durationMinutes: 60,
    });
  });

  it("carries a facility filter through a structured availability intent", async () => {
    const responseBody = {
      choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [{ name: "髙田", organization: null }],
        dateStart: "2026-09-17",
        dateEnd: "2026-09-17",
        durationMinutes: 60,
        facilityQuery: "アクト",
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }],
    };
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify(responseBody), { status: 200 });

    const result = await analyzeDeskNetsIntent(
      "髙田と9月17日の空き時間を教えて。会議室はアクトで",
      new Date("2026-09-09T12:00:00+09:00"),
      { config, fetchImplementation },
    );

    assert.equal(result.source, "azure_openai");
    assert.deepEqual(result.task, {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-09-17",
      endDate: "2026-09-17",
      durationMinutes: 60,
      facilityQuery: "アクト",
    });
  });

  it("removes a job title returned as part of a structured participant name", async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [{ name: "髙田部長", organization: null }],
        dateStart: "2026-09-17",
        dateEnd: "2026-09-17",
        durationMinutes: 60,
        facilityQuery: null,
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200 });

    const result = await analyzeDeskNetsIntent(
      "髙田部長と9月17日の空き時間を教えて",
      new Date("2026-09-09T12:00:00+09:00"),
      { config, fetchImplementation },
    );

    assert.deepEqual(result.task, {
      type: "find_availability",
      participants: [{ name: "髙田" }],
      date: "2026-09-17",
      endDate: "2026-09-17",
      durationMinutes: 60,
    });
  });

  it("asks for valid scheduling conditions without switching to regex when participants are duplicated", async () => {
    const fetchImplementation: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        intent: "find_availability",
        participants: [
          { name: "山本", organization: null },
          { name: "山本", organization: null },
        ],
        dateStart: "2026-08-06",
        dateEnd: "2026-08-06",
        durationMinutes: 60,
        facilityQuery: null,
        candidateNumber: null,
        sendEmail: null,
        title: null,
        selectedStart: null,
        selectedEnd: null,
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const result = await analyzeDeskNetsIntent("山本さんと今日空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.equal(result.source, "azure_openai");
    assert.equal(result.task.type, "clarify");
    assert.equal(result.taskValidationFailed, true);
  });

  it("falls back deterministically when Azure OpenAI is unavailable", async () => {
    const fetchImplementation: typeof fetch = async () => { throw new Error("offline"); };
    const result = await analyzeDeskNetsIntent("髙田さんと今月中で空いている時間", new Date("2026-08-06T16:00:00+09:00"), { config, fetchImplementation });
    assert.equal(result.source, "deterministic");
    assert.equal(result.task.type, "find_availability");
    if (result.task.type === "find_availability") {
      assert.equal(result.task.date, "2026-08-06");
      assert.equal(result.task.endDate, "2026-08-31");
    }
  });
});

describe("LLM-primary requester membership", () => {
  const now = new Date("2026-10-15T01:00:00Z");
  const respond = (membership: string, evidence: string | null, intent = "show_candidates"): typeof fetch => async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const schema = body.response_format.json_schema.schema;
    assert.ok(schema.required.includes("requesterMembershipEvidence"));
    assert.ok(!("excludeRequester" in schema.properties));
    assert.ok(schema.properties.requesterMembership.enum.includes("unclear"));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      intent, requesterMembership: membership, requesterMembershipEvidence: evidence,
      participants: [{name: "田中", organization: null}], dateStart: "2026-10-15", dateEnd: "2026-10-16",
      durationMinutes: 60, facilityQuery: null, candidateNumber: null, sendEmail: null, title: null,
      selectedStart: null, selectedEnd: null, question: null, excludePreviousFacility: false, selectionMode: null,
    }) } }] }), {status: 200});
  };
  it("keeps grounded exclusion even when classified as candidate redisplay", async () => {
    const result = await analyzeDeskNetsIntent("私は会議に参加しないので、候補をください", now, {
      config, fetchImplementation: respond("exclude", "私は会議に参加しない"),
    });
    assert.equal(result.requesterMembership, "exclude");
    assert.equal(result.task.type, "show_candidates");
    assert.equal(result.requesterMembershipEvidenceValid, true);
  });
  it("rejects missing, empty, whitespace-only, invented and history-only evidence", async () => {
    for (const membership of ["include", "exclude"]) for (const evidence of [null, "", "  ", "私は参加します"]) {
      const result = await analyzeDeskNetsIntent("候補を見せて", now, {
        config, conversationHistory: [{role: "user", content: "私は参加します"}],
        fetchImplementation: respond(membership, evidence),
      });
      assert.equal(result.requesterMembership, "unchanged");
      assert.equal(result.requesterMembershipEvidenceValid, false);
    }
  });
  it("accepts affirmative inclusion and normalizes width and whitespace in evidence", async () => {
    const result = await analyzeDeskNetsIntent("私も 参加します。候補１で", now, {
      config, fetchImplementation: respond("include", "私も参加します。候補1で"),
    });
    assert.equal(result.requesterMembership, "include");
  });
  it("never overrides a valid LLM decision with regex interpretation", async () => {
    for (const prompt of ["私は参加しません", "私は参加できないかもしれない", "鈴木さんは参加できないので外して"]) {
      const result = await analyzeDeskNetsIntent(prompt, now, {config, fetchImplementation: respond("unchanged", null)});
      assert.equal(result.requesterMembership, "unchanged");
    }
    const semantic = await analyzeDeskNetsIntent("今回は同席を見送ります", now, {
      config, fetchImplementation: respond("exclude", "同席を見送ります"),
    });
    assert.equal(semantic.requesterMembership, "exclude");
    const include = await analyzeDeskNetsIntent("代理で調整します。私も同席するつもりです", now, {
      config, fetchImplementation: respond("include", "私も同席するつもりです"),
    });
    assert.equal(include.requesterMembership, "include");
  });
  it("preserves unclear without choosing attendance", async () => {
    const result = await analyzeDeskNetsIntent("参加できないかもしれない", now, {
      config, fetchImplementation: respond("unclear", "参加できないかもしれない"),
    });
    assert.equal(result.requesterMembership, "unclear");
  });
  it("falls back to regex on an LLM outage, including membership-only followups", async () => {
    const result = await analyzeDeskNetsIntent("私は参加できないので、候補を出し直して", now, {
      config, requireLlm: true, fetchImplementation: async () => { throw new Error("offline"); },
    });
    assert.equal(result.source, "deterministic");
    assert.equal(result.requesterMembership, "exclude");
  });
  it("permits requester-only attendance without putting self in participants", async () => {
    const result = await analyzeDeskNetsIntent("田中さんの代わりに私が参加する", now, {
      config, fetchImplementation: async () => new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({
        intent: "find_availability", participants: [], dateStart: "2026-10-15", dateEnd: "2026-10-16",
        durationMinutes: 60, facilityQuery: null, title: null,
        requesterMembership: "include", requesterMembershipEvidence: "私が参加する",
      })}}]})),
    });
    assert.equal(result.source, "azure_openai");
    assert.equal(result.requesterMembership, "include");
    assert.deepEqual(result.task.type === "find_availability" && result.task.participants, []);
  });
  it("keeps grounded membership when unrelated scheduling fields are invalid", async () => {
    const result = await analyzeDeskNetsIntent("今回は同席を見送ります", now, {
      config, fetchImplementation: async () => new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({
        intent: "find_availability", participants: [], dateStart: null,
        requesterMembership: "exclude", requesterMembershipEvidence: "今回は同席を見送ります",
      })}}]})),
    });
    assert.equal(result.source, "azure_openai");
    assert.equal(result.requesterMembership, "exclude");
    assert.equal(result.taskValidationFailed, true);
  });
  it("rejects short generic evidence and yes/no outside a membership confirmation", async () => {
    for (const evidence of ["私", "私は", "参加", "はい", "いいえ", "はい、お願いします"]) {
      const result = await analyzeDeskNetsIntent("私も参加。はい、お願いします。いいえ", now, {
        config, fetchImplementation: respond("exclude", evidence),
      });
      assert.equal(result.requesterMembership, "unchanged", evidence);
    }
    const confirmed = await analyzeDeskNetsIntent("はい", now, {
      config, conversationState: { requesterMembershipQuestion: true }, fetchImplementation: respond("exclude", "はい"),
    });
    assert.equal(confirmed.requesterMembership, "exclude");
  });
  it("accepts the meaningful three-character quote 私抜き", async () => {
    const result = await analyzeDeskNetsIntent("私抜きで候補を探して", now, {
      config, fetchImplementation: respond("exclude", "私抜き"),
    });
    assert.equal(result.requesterMembership, "exclude");
    assert.equal(result.requesterMembershipEvidenceValid, true);
  });
  it("does not emit participant names in membership audit logs", async () => {
    const logs: unknown[][] = [];
    const original = console.info;
    console.info = (...values: unknown[]) => { logs.push(values); };
    try {
      await analyzeDeskNetsIntent("田中社長のスケジュールのみ勘案して", now, {
        config, fetchImplementation: respond("exclude", "田中社長のスケジュールのみ勘案して"),
      });
      const log = JSON.stringify(logs);
      assert.ok(!log.includes("田中"));
      for (const field of ["llmValue", "evidence", "evidenceValid", "regexValue", "final", "source"]) assert.ok(log.includes(field));
    } finally { console.info = original; }
  });
});

it("keeps LLM buffer corrections independently of candidate classification", async () => {
 for (const minutes of [0,15,30,45]) {
  const result = await analyzeDeskNetsIntent("やはり前の予定から余裕をもたせて",new Date(),{config,
   fetchImplementation:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    intent:"show_candidates",requesterMembership:"unchanged",bufferBeforeMinutes:minutes,bufferAfterMinutes:null
   })}}]}))});
  assert.equal(result.source,"azure_openai");
  assert.deepEqual(result.schedulingBuffer,{beforeMinutes:minutes,afterMinutes:null});
 }
});

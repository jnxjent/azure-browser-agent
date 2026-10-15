// Manual only; does not operate the browser or register meetings.
// npm run build
// node --env-file=.env.local scripts/eval-requester-membership.mjs
// An alternate env file is supported. AzureChat-style API_* names are accepted.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeDeskNetsIntent, readRequesterMembership } from '../packages/agent-core/dist/index.js';

const config = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
};
if (!config.endpoint || !config.apiKey || !config.deployment) throw new Error('Azure OpenAI configuration is missing. Supply a configured --env-file.');
const cases = [
  ['私は会議に参加しないので、除外してください。再び候補をください。', 'exclude'],
  ['私は参加できないので、候補を出し直して', 'exclude'],
  ['私は参加できません', 'exclude'],
  ['私は参加できず、対象者だけでお願いします', 'exclude'],
  ['私は今回は参加しないので候補をもう一度', 'exclude'],
  ['私は明日の会議には参加しない', 'exclude'],
  ['私は欠席するので除外して', 'exclude'],
  ['私は欠席なので再検索して', 'exclude'],
  ['私は行かないので外して', 'exclude'],
  ['私は出なくていいので候補をください', 'exclude'],
  ['対象者のみ考慮して', 'exclude'],
  ['対象者のみ勘案して', 'exclude'],
  ['対象者のみのスケジュールにして', 'exclude'],
  ['私の予定は考慮しないで', 'exclude'],
  ['私は参加しません', 'exclude'],
  ['私は今回の打ち合わせには出席しません', 'exclude'],
  ['明日の会議には私は出ません', 'exclude'],
  ['私抜きで候補を探して', 'exclude'],
  ['今回は同席を見送ります。候補を見せて', 'exclude'],
  ['田中社長のスケジュールのみ勘案して来週の空き', 'exclude'],
  ['候補1で。私は参加しない', 'exclude'],
  ['私も参加します。候補をください', 'include'],
  ['私も参加で', 'include'],
  ['私も参加。', 'include'],
  ['私も入れて', 'include'],
  ['私も会議に参加します。候補をください', 'include'],
  ['田中さんの代わりに私が参加する', 'include'],
  ['私は除かないで', 'include'],
  ['田中社長のみ。ただし私も参加します', 'include'],
  ['候補1で。私も参加します', 'include'],
  ['鈴木さんは参加できないので外して', 'unchanged'],
  ['部長だけでなく課長も参加します', 'unchanged'],
  ['田中社長のみならず鈴木部長も', 'unchanged'],
  ['候補を見せて', 'unchanged'],
  ['田中社長と来週の空き時間を教えて', 'unchanged'],
  ['参加できないかもしれない', 'unclear'],
  ['私は参加できないかもしれない', 'unclear'],
  ['私は参加するか未定です', 'unclear'],
  ['はい', 'exclude', true],
  ['いいえ', 'include', true],
];
const results = [];
const now = new Date('2026-10-15T01:00:00Z');
for (const [prompt, expected, confirmation] of cases) {
  const analysis = await analyzeDeskNetsIntent(prompt, now, {
    config, requireLlm: true,
    conversationState: { conversation: {
      ...(confirmation ? { requesterMembershipQuestion: true } : {}),
      context: { participants: [{ name: '田中' }], date: '2026-10-15', endDate: '2026-10-21',
        durationMinutes: 60, facilityQuery: 'アクト応接室', excludeRequester: false },
      candidates: [{ start: '2026-10-16T00:00:00Z', end: '2026-10-16T01:00:00Z', availableFacilityIds: ['アクト応接室'] }],
    } },
    conversationHistory: confirmation ? [{ role: 'assistant', content: 'ご自身を参加者から外しますか？' }] : [],
  });
  const result = { number: results.length + 1, prompt, expected,
    llm: analysis.requesterMembership ?? 'unchanged', regex: readRequesterMembership(prompt),
    source: analysis.source, evidence: analysis.requesterMembershipEvidence ?? null,
    evidenceValid: analysis.requesterMembershipEvidenceValid ?? false,
    task: analysis.task.type, failureKind: analysis.failureKind ?? null };
  results.push(result);
  console.log(JSON.stringify(result));
}
const llmCorrect = results.filter(r => r.source === 'azure_openai' && r.llm === r.expected).length;
const regexCorrect = results.filter(r => r.regex === r.expected).length;
const summary = { timestamp: new Date().toISOString(), deployment: config.deployment, total: results.length,
  llmCorrect, llmAccuracy: llmCorrect / results.length, regexCorrect, regexAccuracy: regexCorrect / results.length,
  fallbackCount: results.filter(r => r.source !== 'azure_openai').length };
const output = resolve(process.env.MEMBERSHIP_EVAL_OUTPUT || 'artifacts/requester-membership-eval.json');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify({ summary, results }, null, 2) + '\n');
await writeFile(output.replace(/\.json$/, '.csv'), '\uFEFF' + [
  ['number', 'prompt', 'expected', 'LLM', 'regex', 'source', 'evidence', 'evidenceValid'],
  ...results.map(r => [r.number, r.prompt, r.expected, r.llm, r.regex, r.source, r.evidence ?? '', r.evidenceValid]),
].map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\n') + '\n');
console.log(JSON.stringify({ summary, output }));
if (summary.fallbackCount) process.exitCode = 1; // Never count a regex fallback as an LLM success.

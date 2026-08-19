# Azure Browser Agent

Webページを視覚的・意味的に理解し、自然言語の指示に応じて安全にブラウザを操作するAgenticアプリのPoCです。

## Initial scope

最初の対象はDeskNet'sのスケジュール機能です。

- ログイン済み画面からスケジュールを開く
- 複数人の予定を読み取る
- 共通の空き時間を計算する
- 候補をWeb Consoleに表示する

現在のPoCは、空き時間確認、設備による候補絞り込み、番号選択、メール通知確認の会話に対応します。AgentはDeskNet'sの予約フォームまで準備しますが、最終登録とメール送信を開始する「追加」は押しません。内容を確認したユーザーがDeskNet's上で直接押します。

## Planned structure

- `apps/web-console`: PoC操作画面
- `services/agent-api`: Agent実行API
- `services/browser-worker`: Playwright実行プロセス
- `packages/agent-core`: 計画・Policy・検証
- `runbooks/desknets`: DeskNet's操作知識
- `docs`: 設計資料

## Requirements

- Node.js 20
- npm 10

## Status

The first runnable milestone is available:

- asynchronous in-memory Run API
- typed browser action and observation contracts
- domain, mode, step-count, and duration policy boundaries
- Playwright/Chromium `screenshot -> decision -> one action -> screenshot` loop against an isolated mock page
- Web Console showing status, action, observations, verification, and before/after screenshots
- deterministic common-availability calculation from structured participant schedules
- deterministic filtering for slots with at least one available meeting facility
- manual two-stage login in a dedicated Edge profile
- loopback-only CDP connection to an authenticated DeskNet's tab
- structured extraction of participant and company-wide facility busy intervals
- Japanese multi-turn conversation parsing for availability, facility filtering, numbered selection, email choice, and booking
- explicit mixed-width date ranges such as `8月24日から８月28日`
- same-thread duration refinements such as `打ち合わせ時間は30分でいい`
- direct candidate booking with an exact date/time, facility, and email instruction
- optional Azure OpenAI Structured Outputs intent analysis with deterministic fallback
- Asia/Tokyo relative ranges such as `今日`, `明日`, `1週間以内`, and `今月中` (maximum 31 days)
- a single-execution DeskNet's queue so runs cannot operate the dedicated Edge concurrently
- automatic participant selection from the schedule list
- room/date/time/optional-title entry, participant email configuration, and manual handoff to the DeskNet's Add screen

The DeskNet's flow starts from the schedule list. The first prompt selects the
named participants, reads participant and company-wide facility availability,
and preserves the unsaved form. The Web Console groups availability by date in
collapsed sections so a multi-day search remains scannable. Each candidate row
includes an available-facility selector, email send/no-send radios, and a select
button that prepares the exact booking. Meeting Room C and email sending are the
UI defaults when that room is available. A duration-only
follow-up reruns the same participant and date-range search with the new meeting
length. A facility follow-up returns only the requested-duration
intersection of participant availability and that facility's availability, in
ascending time order as clickable cards. Selecting a card shows the date/time,
participants, and room together and asks whether email should be sent. The email
answer prepares exactly that slot, leaves `自分には通知しない` unchecked, brings
the dedicated DeskNet's tab forward, and waits for the user to review the form.
If a prompt contains `議題＝「...」`, that title is copied; otherwise the title
remains editable and blank. The Agent never clicks **追加**. The pending context
is consumed before preparation so it cannot be replayed automatically.

After availability is loaded, an exact instruction such as
`それでは8/24の9:30-10:00、会議室Cで設定して。メール発信して` may select a
matching current candidate directly. The API rejects any date/time/facility
combination not present in the current conversation context. It prepares the
form and hands the final **追加** action to the user in DeskNet's.

Past dates are rejected before browser execution. For the current date, slots
whose start time has already passed are omitted. The selected slot is checked
again when it is selected and when the email choice is made so a stale candidate
cannot be prepared.

When `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and
`AZURE_OPENAI_DEPLOYMENT` are all present, the API sends the prompt and current
Asia/Tokyo instant to Azure OpenAI and requests a strict JSON Schema intent. The
model only extracts structured intent; date-range limits, past-time filtering,
conversation state, and final-write approval remain deterministic application
policy. If configuration or inference is unavailable, the parser falls back to
deterministic handling and exposes the active source in Web Console.

Set those values in the process environment before starting the API; never put
the key in a prompt or commit it to the repository. `.env.example` documents the
names, but the service does not automatically load secrets from that file.

Relative range semantics are inclusive: `1週間以内` means today through six
days later, and `今月中` means today through the last calendar day of the month.
Multi-day searches reuse the selected participants and inspect each date in the
range. Facility results are sorted chronologically and capped at the first 50
clickable candidates.

## Run locally

Build all workspaces:

```bash
npm run build
```

Start the Agent API in one terminal:

```bash
ALLOWED_DOMAINS=your-desknets.example npm run dev:api
```

Start the Web Console in another terminal:

```bash
npm run dev:web
```

Then open `http://127.0.0.1:3000`.

Create or refresh the local DeskNet's Microsoft Edge session with a manual login:

```bash
npm run auth:desknets -- https://your-desknets.example/path
```

The helper starts normal Edge with a loopback-only DevTools port; Playwright
connects after Edge is running instead of launching it with a debugging pipe.
The dedicated browser profile is retained under the Git-ignored `.auth/`
directory. Never pass an ID or password on the command line or store credentials
in the project. When Edge shows its native **サインイン** prompt for the
DeskNet's site, the trusted session helper clicks that exact button once within
the dedicated Edge process. It never reads or enters credentials; any additional
login or MFA step remains manual.

For a DeskNet's run, keep exactly one approved DeskNet's schedule-list tab open.
Select `DeskNet's` in the Web Console and enter a prompt such as
`髙田さん、山本さんと私で8月6日に打ち合わせ可能な時間を教えて`.
After the availability response, ask `ルームCが空いている時間帯は？`, select
one of the clickable slots (or type `では1で確定して`), then answer the email
question with `はい` or `いいえ`. Review the displayed title, time, participants,
facility, and email warning. The dedicated Edge then shows the prepared DeskNet's
reservation form. Enter an agenda if it was not supplied, review every field, and
press **追加** in DeskNet's yourself. The Agent never presses that button.
Additional login or MFA remains manual.

See `HANDOFF.md` for the broader design and implementation plan.

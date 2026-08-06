# Azure Browser Agent

Webページを視覚的・意味的に理解し、自然言語の指示に応じて安全にブラウザを操作するAgenticアプリのPoCです。

## Initial scope

最初の対象はDeskNet'sのスケジュール機能です。

- ログイン済み画面からスケジュールを開く
- 複数人の予定を読み取る
- 共通の空き時間を計算する
- 候補をWeb Consoleに表示する

初期PoCは読み取り専用とし、登録などの副作用がある操作は後から承認フロー付きで追加します。

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

The DeskNet's milestone is deliberately semi-automated: the user opens an
unsaved schedule form and selects participants, then the Worker reads participant
and company-wide facility availability, calculates one-hour candidates, and
discards the form. It never selects the final Add control.

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
in the project.

For a DeskNet's run, keep exactly one approved DeskNet's tab open. Open an
unsaved schedule form, open `登録先`, select at least two participants so they
appear in the lower availability grid, and leave that dialog open. Select
`DeskNet's（準備済みフォーム）` in the Web Console and start the read-only run.
The Worker checks all company-wide facilities, captures evidence, and cancels
the unsaved form even when the run fails.

See `HANDOFF.md` for the broader design and implementation plan.

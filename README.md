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

The worker does not connect to DeskNet's yet. It only permits the local mock scenario.

## Run locally

Build all workspaces:

```bash
npm run build
```

Start the Agent API in one terminal:

```bash
npm run dev:api
```

Start the Web Console in another terminal:

```bash
npm run dev:web
```

Then open `http://127.0.0.1:3000`.

See `HANDOFF.md` for the broader design and implementation plan.

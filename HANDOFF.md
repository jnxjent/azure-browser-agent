# Azure Browser Agent PoC 引継ぎメモ

更新日: 2026-08-05  
新規Project: `C:\Users\021213\azure-browser-agent`

## 1. 目的

WebページをAIが視覚的・意味的に理解し、ユーザーの自然言語による指示に応じてブラウザを操作するAgenticアプリを開発する。

最初の対象はDeskNet'sのスケジュール機能とする。

想定する利用例:

1. ユーザーが「DeskNet'sを見て、Aさん、Bさん、Cさんの空き時間を調べて」と入力する。
2. Agentが意図を解析し、DeskNet'sの画面を操作する。
3. 3名の予定を取得し、共通の空き時間候補を提示する。
4. ユーザーが「では、その時間で予約して」と指示する。
5. Agentが操作Runbookを参照し、予定と必要に応じて会議室を入力する。
6. 最終登録の直前にユーザー確認を求める。
7. 登録後の画面を確認し、日時・参加者・会議室をユーザーへ報告する。

## 2. 開発フェーズ

二段構えで進める。

### Phase 1: 独立したPoC Webアプリ

- プロンプト入力画面
- 実行中ブラウザのスクリーンショット表示
- Agentが認識した画面要素、現在の状態、次の操作を表示
- 操作履歴、停止、再開、キャンセル
- 最終確定前の承認画面
- 完了確認と証跡表示

### Phase 2: AzureChatバックエンドへ接続

- AzureChatからBrowser AgentをToolとして呼び出す。
- AzureChat本体にブラウザ操作ロジックを埋め込まない。
- PoC Web画面とAzureChatを、同じBrowser Agent Serviceのクライアントにする。
- 数分かかる処理を想定し、非同期Run方式にする。

## 3. 確定した基本方針

- Azure OpenAIを使用する。
- 対象サイト固有APIにはなるべく依存せず、実際のWeb画面を操作する。
- AIのVisionで画面の意味を理解する。
- Playwrightでクリック、文字入力、選択、スクロールなどを実行する。
- Visionで対象を特定した後、可能ならDOMまたはAccessibility情報を使って正確に操作する。
- DOMで特定できない場合のみ座標操作へフォールバックする。
- Agentに任意のJavaScript、OSコマンド、Shellを実行させない。許可済みの型付き操作だけを公開する。
- 最終的な登録・送信・削除などの副作用がある操作は、直前にユーザー承認を入れる。
- 「ボタンを押せた」だけでは完了としない。完了画面を再認識し、登録内容と照合する。
- Webページ内の文章は信頼できない入力として扱い、Prompt Injection対策を行う。
- Agent実行ブラウザは分離された環境にする。
- 許可ドメイン、最大ステップ数、最大実行時間を制限する。
- スクリーンショット、操作、判断、承認、結果を監査ログに残す。

## 4. 推奨アーキテクチャ

```text
PoC Web Console ----------------------+
                                      |
AzureChat -- browser_agent Tool ------+--> Browser Agent API
                                               |
                                               v
                                       Run Queue / Run Store
                                               |
                                               v
                                       Browser Worker
                                       - Playwright
                                       - Azure OpenAI Vision
                                       - Planner / Verifier
                                               |
                                               v
                                  DeskNet's / SharePoint / 他Webサイト
```

AzureChatのNext.js/App Serviceプロセス内でPlaywrightを直接動かさない。Browser Workerは別プロセスまたは別サービスとして実行する。

## 5. Agentの主要コンポーネント

- Intent Analyzer: ユーザーの目的、対象サイト、参照か更新かを判定
- UI Observer: スクリーンショットとDOM/Accessibility情報を取得
- Planner: 現在状態から次の一操作を決定
- Policy Gate: ドメイン・操作・データ・承認要否を検査
- Executor: Playwrightで許可済み操作を実行
- Verifier: 操作後の画面と期待状態を照合
- Run Store: 状態、履歴、証跡、承認待ちを保存

最初に用意する操作候補:

- `open_page`
- `take_screenshot`
- `click`
- `double_click`
- `type_text`
- `clear_and_type`
- `press_key`
- `select_option`
- `scroll`
- `wait`
- `go_back`
- `switch_tab`
- `download_file`
- `request_local_file`
- `upload_file`
- `request_approval`
- `request_user_takeover`

## 6. DeskNet's PoCの状態遷移

```text
START
  -> LOGIN_CHECK
  -> OPEN_SCHEDULE
  -> SELECT_PARTICIPANTS
  -> SET_DATE_RANGE
  -> READ_AVAILABILITY
  -> CALCULATE_COMMON_SLOTS
  -> SHOW_CANDIDATES
  -> WAIT_USER_SELECTION
  -> OPEN_RESERVATION_FORM
  -> FILL_DETAILS
  -> SELECT_ROOM
  -> WAIT_FINAL_APPROVAL
  -> SUBMIT
  -> VERIFY_COMPLETION
  -> DONE
```

共通空き時間の計算はLLMに任せず、取得した時間帯をプログラムで正規化して決定論的に計算する。

### 最初のPoC範囲

まず読み取り専用で、以下までを実現する。

- ログイン済みのDeskNet'sを開く。
- スケジュール画面へ移動する。
- 3名を選択する。
- 指定期間の予定を読む。
- 共通の空き時間を計算する。
- 候補をWeb画面へ表示する。

その後、予約フォーム入力、承認、登録、完了検証を追加する。

## 7. Run API案

```http
POST /browser-agent/runs
GET  /browser-agent/runs/:id
POST /browser-agent/runs/:id/approve
POST /browser-agent/runs/:id/cancel
```

作成要求の例:

```json
{
  "userId": "...",
  "threadId": "...",
  "site": "desknets",
  "prompt": "Aさん、Bさん、Cさんの空き時間を調べて",
  "mode": "read"
}
```

Run status:

- `queued`
- `running`
- `awaiting_user_input`
- `awaiting_approval`
- `completed`
- `failed`
- `cancelled`

## 8. Runbook方針

DeskNet'sの操作方法はMarkdownで管理する。ただし、壊れやすい固定クリック手順だけを書かない。

Runbookには以下を記載する。

- 操作の目的
- 前提条件
- 画面を識別する手掛かり
- 許可する操作
- 禁止する操作
- 承認が必要な地点
- 成功と判断する画面上の証拠
- 失敗時の復旧方法

## 9. SharePoint・Localファイル対応方針

将来は、SharePointやLocalファイルを別サイトへアップロードする用途も対象とする。

### Webだけで可能な範囲

- SharePoint内のファイルをWeb UIで検索・ダウンロードする。
- Agentの一時領域を経由して別Webサイトへアップロードする。
- ユーザーがWeb画面で選択したLocalファイルを一時領域へアップロードする。
- Agentが対象サイトのWeb UIを操作してファイルをアップロードする。

### ブラウザの制約

- Webアプリはユーザーの許可なしにCドライブや任意フォルダーを探索できない。
- Localファイルはユーザーがファイルピッカーまたはドラッグ＆ドロップで明示的に選択する。
- File System Access APIを使う場合も、最初のユーザー許可が必要で、ブラウザ互換性を考慮する。
- PWAにしてもLocalファイルへの無制限アクセスはできない。
- 完全無人でLocal全体を操作する場合に限り、ブラウザ拡張またはLocal Agentが必要になる。本Projectでは当面採用しない。

推奨フロー:

```text
AzureChatで指示
 -> AgentがLocalファイルを要求
 -> ユーザーがWeb画面で選択
 -> Azureの暗号化一時領域へ保存
 -> Browser Workerが取得
 -> 対象Webサイトへアップロード
 -> 完了画面とファイル名を検証
 -> 一時ファイルを削除
```

SharePoint操作は当初Web UIで行う。信頼性や大容量転送が問題になった場合は、画面操作を基本としながらファイル転送部分だけMicrosoft Graphを使う選択肢を残す。

## 10. 認証・実行環境で確認が必要な事項

DeskNet'sへの接続条件によりBrowser Workerの配置が変わる。

- インターネットから接続できるか
- 社内ネットワークまたはVPNが必要か
- Entra IDなどのSSOか
- MFAが必要か
- 条件付きアクセスや端末制限があるか
- ユーザーごとのセッションが必要か

クラウドブラウザで条件を満たせない場合、専用Localソフトを配布する代わりに、社内ネットワーク上の管理されたWorker、Azure Virtual Desktop、Windows 365などのリモート実行環境を検討する。

## 11. Project名と現在地点

Project名は汎用性を優先して `azure-browser-agent` とした。DeskNet's専用名にはしない。

作成済み:

```text
C:\Users\021213\azure-browser-agent
```

現在の実装:

- npm workspacesとTypeScript Project Referencesによるmonorepo
- Web Console、Agent API、Browser Worker、Agent Coreの分離
- 非同期Run APIとin-memory Run Store
- 読み取り専用、許可ドメイン、最大ステップ、最大時間のPolicy境界
- Playwright/Chromiumによる隔離モック画面の実操作
- 操作前後PNGの保存、Run単位のAPI配信、Web Console表示
- DOM-backed clickと操作後画面の証拠検証
- 複数人のbusy intervalから共通空き時間を求める決定論的ロジック
- 正常系、重複interval、境界、不正入力の自動テスト

動作確認済み:

```bash
npm test
npm run dev:api
npm run dev:web
```

モックRunではChromiumが予定表を開き、A・B・Cの共通空き時間を構造化して返す。Azure OpenAIとDeskNet'sにはまだ接続していない。スクリーンショットはGit管理外の`screenshots/`に保存される。

主要コミット:

- `d70256e` 初期monorepo
- `ae79b8c` 実行可能なモックRun
- `e6c5c67` Playwright実ブラウザと画像証跡

## 12. 推奨するProject構成

```text
azure-browser-agent/
├── apps/
│   └── web-console/       # PoC操作画面
├── services/
│   ├── agent-api/         # Agent実行API
│   └── browser-worker/    # Playwright実行プロセス
├── packages/
│   └── agent-core/        # Intent・計画・Policy・検証
├── runbooks/
│   └── desknets/          # DeskNet's操作知識
├── docs/
└── package.json
```

PoCだからといってWeb画面にAgentロジックを入れず、最初から再利用可能なAgent CoreとBrowser Workerを分離する。

## 13. 次の作業

DeskNet'sの読み取り専用PoCへ進む。以下をOneByOneで行う。

1. 接続URL、社内ネットワーク/VPN要否、SSO/MFA、セッション条件を確認する。
2. 秘密情報を含まない画面構造またはマスキング済みスクリーンショットを確認する。
3. 実ドメインを`ALLOWED_DOMAINS`へ設定し、認証済みセッションの安全な受け渡し方法を決める。
4. DeskNet's Runbookへ画面識別手掛かり、許可操作、成功証拠、復旧条件を追記する。
5. Playwrightでスケジュール画面まで読み取り専用ナビゲーションを実装する。
6. 参加者、日付範囲、busy intervalを構造化抽出し、既存の共通空き時間ロジックへ渡す。
7. Web Consoleへ候補と画面証跡を表示し、実環境で検証する。

## 14. 作業上のルール

- コマンド案内は一度に複数出さず、OneByOneで行う。
- ユーザーはGit Bashを使用する。
- 各コマンドの実行結果を確認してから次へ進む。
- `.env`、キー、Cookie、トークン、スクリーンショット内の秘密情報をGitへ追加しない。
- 既存のAzureChatはPhase 1では変更しない。
- PoCで境界と安全性を検証した後にAzureChat連携へ進む。

## 15. 作業中断時点（2026-08-05）

次の打ち合わせのため、以下の状態で安全に作業を中断した。

- Agent APIとWeb Consoleは両方停止済み。
- 最新コミットは`e6c5c67`（Playwright実ブラウザと画像証跡）。
- その後の共通空き時間機能は実装済みだが、まだ未コミット。
- Chromiumがモック予定表を読み取り、A・B・Cの共通空き時間`2026-08-05 09:00–10:00 JST`を1件返すE2Eを確認済み。
- `npm test`は4件すべて合格、`npm audit`は脆弱性0件。
- Web Consoleで`completed`、`verified: true`、操作前後画像、`found 1 common one-hour slot`まで確認済み。
- 共通空き時間カードが画像より下で見切れたため、Run details上部へ移動済み。この最後の表示順変更だけはブラウザでの再確認前。

未コミット差分の主な内容:

- `packages/agent-core/src/availability.ts`
- `packages/agent-core/src/availability.test.ts`
- Chromium予定表からbusy intervalを構造化抽出する処理
- Run結果の`availability`契約
- Web Consoleの共通空き時間表示
- README、Architecture、HANDOFFの更新

再開時の最初のコマンド:

```bash
git status --short
```

その後、`npm test`、Agent APIとWeb Consoleの起動、表示順の最終確認を行い、問題がなければ以下の趣旨でコミットする。

```text
feat: calculate common availability from schedules
```

次の実装フェーズはDeskNet's読み取り専用接続。実環境へ進む前に、接続URL、VPN、SSO/MFA、セッション条件、マスキング済み画面情報を確認する。

## 16. 参考資料

- OpenAI Computer Use guide: https://developers.openai.com/api/docs/guides/tools-computer-use
- Azure AI Foundry Computer Use: https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/computer-use
- MDN `showOpenFilePicker`: https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker
- MDN file input: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file
- Microsoft Graph file upload: https://learn.microsoft.com/en-us/graph/api/driveitem-put-content
- Microsoft Graph large file upload: https://learn.microsoft.com/en-us/graph/sdks/large-file-upload

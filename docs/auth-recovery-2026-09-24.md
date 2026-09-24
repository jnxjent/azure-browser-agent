# TestSite認証復旧 — 2026-09-24

## 実装

- 既存専用Edge/CDP接続を維持し、PlaywrightのCDPセッションでHTTP BASIC challengeに応答する。httpCredentials付きの新規ブラウザーへ切り替えず、現在のプロファイル・手動入力中の画面を保持する。
- 資格情報に登録されたHTTPS originと、HTTP認証challengeおよびリクエストのoriginが一致する場合だけ送信する。Proxy認証、別origin、別方式へは送信しない。
- DeskNet'sアプリは、単一のID入力・パスワード・ログインボタンを持つ同一originのPOSTフォームに限り入力する。MFA、パスワード変更、氏名選択、判別できない画面は手動認証を案内する。
- ログイン後は組織週間スケジュールの表示を確認する。認証切れによる失敗から業務操作を再実行するのは1回まで。予定の最終追加は引き続き手動。
- Workerへの同時リクエストを直列化して認証とブラウザー操作の衝突を防ぐ。
- 認証を送る前に停止フラグを保存し、成功確認後に解除する。誤った資格情報、認証中の異常終了などで停止した場合、次回API起動後も繰り返し送信しない。資格情報の再登録で解除する。
- 認証失敗のPlaywrightログや画面を診断画像へ保存しない。資格情報はAPIやモデルへ渡さない。
- TestSiteは通信タイムアウト・API接続失敗を日本語で案内する。POSTの自動再送はしない。

## 初回登録・更新

VM `vm-abagent-t01` に `abaops` としてログインし、VM内PowerShellで実行する。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\BrowserAgent\shared\set-desknets-credentials.ps1
```

BASIC認証とDeskNet's本体のID・パスワードを順に登録する。パスワードは非表示入力し、DPAPI LocalMachineで暗号化する。保存先ディレクトリのACLはabaops・SYSTEM・Administratorsだけに限定する。ID/パスワードをチャット、コマンドライン引数、Git、URLへ渡さない。

`DESKNETS_CREDENTIAL_FILE=C:/BrowserAgent/shared/credentials/desknets.bin` がVM APIの設定。ファイルが未登録なら既存の手動ログイン運用を継続する。登録後は次回リクエストから読み込むため、登録のみではAPI再起動不要。

登録するIDは現在の専用ブラウザーと同じ運用アカウントを使う。これは全社員の権限分離を実装する変更ではない。

## 検証

- 模擬HTTPサーバーでBASIC認証、アプリ再ログイン、Cookie消去後の2回目の復旧、誤資格情報の試行停止、別originへの資格情報非送信、MFA・キャンセルを確認する。
- Windows DPAPIで暗号化・復号、停止フラグの再読込、資格情報更新による解除、破損データ時の秘匿エラーを確認する。
- 既存の予定引き渡しテストで、認証切れ後の同時2リクエストが1回の再認証で復旧し、予定追加が0回であることを確認する。
- VM実認証テストは `scripts/test-desknets-auth-live.ps1`。利用者のタブとは別の隔離コンテキストで認証し、スケジュール表示だけ確認する。Cookieを消去する対象もこの隔離コンテキストのみ。実行には資格情報登録が必要。

## 制限

- VM/Windows再起動後にInteractiveタスクを始めるためのWindowsログインは引き続き必要。APIサービス化は今回に含めない。
- 入口の認証情報が変更された状態でブラウザーが古いHTTP認証をキャッシュしている場合、正しい情報の再登録に加え、保守時間中に専用Edgeを閉じて再起動する必要があり得る。
- 認証中断時も停止フラグを残すため、ネットワーク障害で失敗した場合に再登録が必要になることがある。無制限の自動再試行はしない。
- 実サイトのフォーム・認証ポリシーが対象条件と異なる場合は手動認証へ移行する。

## デプロイ境界

BrowserAgentは `jnxjent/azure-browser-agent` の `testsite/desknets-agent-20260910` から専用VMのみへ反映。TestSiteは `jnxjent/azurechat-gpt5-test` の `testsite/fix-toggle-selfscope-20260323` と `azure-dev-validate.yml` を使用する。本番AzureChatのorigin、ブランチ、Azureリソースへは書き込まない。

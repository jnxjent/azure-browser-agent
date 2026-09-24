# 認証復旧デプロイ記録 — 2026-09-24

## 対象とコード

- BrowserAgent: `14e06bdc68beec287b709f8d729af8c5429d4322`、`jnxjent/azure-browser-agent` / `testsite/desknets-agent-20260910`。
- VM: `vm-abagent-t01` / `rg-azurechat-browser-agent-test`。同コミットの配置・ビルド・health成功。
- TestSite: `c6e211e855e8823f748aaead518716a333dfed53`、`jnxjent/azurechat-gpt5-test` / `testsite/fix-toggle-selfscope-20260323`。
- TestSite作業領域: `C:\Users\021213\testsite-auth-recovery-20260924`。作成時のリモート先端 `335f4ca` から今回の4ファイルのみを変更。既存のSalesforce等の修正を保持。
- [GitHub Actions](https://github.com/jnxjent/azurechat-gpt5-test/actions/runs/35963955619)。対象head SHA一致、build/deployとも成功。TestSiteリポジトリ・ブランチ・WebAppガードとTest用Search index確認も成功。
- 本番AzureChatのoriginへのpush、本番Azureリソースの変更は行っていない。

## 検証結果

- BrowserAgent: `npm test` 成功。Core 63 / Worker 36 / API 87、計186件。
- TestSite: 関連テスト23件と `npm run build` 成功。
- VM稼働コミット一致、APIプロセス1件、APIタスクRunningを確認。
- VM loopback/private API health成功、専用Edge CDP接続成功。
- TestSite SCMからprivate API healthがHTTP 200、status ok。
- Webデプロイ完了後、公開TestSite HTTPSがHTTP 200。TestSite SCMからprivate API healthを再確認し、HTTP 200、status ok。
- 資格情報登録状態: 未登録。実サイトの隔離コンテキストによる認証復旧試験は `pending`。自動テストの成功と実サイトでの再認証成功を混同しない。

## 残作業

VMで `C:\BrowserAgent\shared\set-desknets-credentials.ps1` をabaopsとして実行し、BASIC/DeskNet'sの資格情報を登録する。登録後、`scripts/test-desknets-auth-live.ps1` で実サイトのログインフォームとの適合と2回の復旧を確認する。実予約・通知は行わない。

認証復旧の仕様と制限は [実装・運用メモ](auth-recovery-2026-09-24.md) を参照。Windowsログイン依存のAPI起動方式は今回変更していない。

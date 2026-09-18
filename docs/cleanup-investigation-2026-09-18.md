# DeskNet's cleanup investigation — 2026-09-18

## Scope and safety

- Test VM: `vm-abagent-t01`, resource group `rg-azurechat-browser-agent-test`.
- Test web application: `azurechat-gpt5-test`. Production AzureChat is excluded.
- Tests read schedules and prepare/discard drafts. Never click DeskNet's final Add button.

## Confirmed findings

- The worker's unguarded `finally` cleanup could replace an earlier exception with the cancellation timeout. Fixed in `39cadcbe9eeb75f9a770b983418d9987f605acd9`.
- The worker now preserves the primary exception and records best-effort, bounded diagnostics for both primary and cleanup errors in its existing run artifact directory. Diagnostic JSON contains the command, visible date controls, and visible dialog text; no authentication configuration is read. Screenshots may contain business data and must remain private.
- Code inspection shows that tab consolidation selects allowed DeskNet's hosts, not Edge welcome/new-tab pages. Their presence alone does not prove the reported failure's cause.
- An empty artifact directory does not identify the failing operation: the first normal observation is only recorded after several navigation and participant-selection steps.
- The local alias dictionary is located under the API workspace's `.data` directory; the deployed API uses its configured shared path. Equal code does not imply equal configuration/data.

## Completed checks

- `npm test`: passed, including a real headless-browser regression deliberately producing both a primary failure and a cleanup timeout, checking that both diagnostics survive.
- Local and VM live cancellation probes: both list-launched and direct-link drafts were filled, cancelled successfully, and returned to `schweekgrp` with zero visible start-date controls. Probe tabs were closed. No final registration.
- TestSite intent/card rendering tests: 21 passed.
- Actual TestSite button component in an isolated harness, using the company-PC authenticated DeskNet's browser: opened and reopened native drafts; date, time, and all three participant IDs matched. The handoff endpoint was stubbed in this component test; this is not a full authenticated TestSite chat E2E test.
- TestSite-to-VM private health request: HTTP 200.
- Test VM deployed commit: `39cadcbe9eeb75f9a770b983418d9987f605acd9`; build and deployment health check passed.

## Live sequence

VM search → selection → handoff twice → room change → refreshed search: **passed** against the deployed worker and live DeskNet's session.

- Confirmed remote alias file missing and API dictionary empty (0 entries); imported the 7 local entries through the authenticated alias API, with conflict detection and no overwrites. No dictionary content or API key was committed.
- Initial search `f387aaa2-1f2e-4f45-8e70-103783b2879e`: completed, 5 candidates.
- Selection `40dbff3b-0012-4c28-a06e-e59e1314b6ad`: awaiting approval. Handoff fetched twice, `registered: false` each time.
- Room change `c03ad411-97eb-4ef6-bdbd-4974ae7ad78f`: awaiting approval; assertions verified unchanged time and a different facility, then a valid handoff response.
- Refresh `ef7832b1-2aab-42c3-afa0-d46918f0d922`: completed, 5 candidates.
- Durable VM test log: `C:\BrowserAgent\shared\investigation-live-test.log` (business data; keep private).

The historical timeout did not recur during these checks. Its initiating cause remains unproven; neither dictionary repair nor successful retesting alone establishes that cause. Full authenticated TestSite chat E2E remains a separate user acceptance check. Production AzureChat was not modified.

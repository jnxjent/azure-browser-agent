# TestSite scheduling corrections and verification

## Deployed application versions

- BrowserAgent VM `vm-abagent-t01`: `2013fe4c25f71747192c2d7f4d50dd80a87bff25`.
- AzureChat TestSite: `4c02ea3ae722b5dd48ac8d2dc3ed1f18fe7975bf`.
- Successful Actions run: https://github.com/jnxjent/azurechat-gpt5-test/actions/runs/35314448948
- Only `azurechat-gpt5-test` was deployed/restarted. Production AzureChat was not modified.

## Findings and corrections

- Local and deployed BrowserAgent both already supported five earliest choices. A live Local search over September 18–24 returned zero after the remaining September 18 time passed. The short default horizon, not a one-item rendering limit, prevented later choices.
- Unbounded earliest requests now search ahead up to 31 days, skip official company holidays, and stop when five real choices are found. Explicit periods are not automatically expanded.
- A request to search again re-reads live schedules with the saved participants and duration instead of only replaying stored candidates. Past start times remain excluded.
- Client handoff is non-consuming and accepts reopenable manual proposals. Removed the arbitrary 15-minute reopening limit; ownership, supersession and future-start checks remain enforced.
- Manual/room-change proposals retain native participant IDs and are rendered by TestSite as confirmation cards.
- Removed title-copy, VM-Edge controls and routine explanatory text in the marked red regions. The main button reads `desknet'sを開く`; errors still appear if opening fails.

## Verification performed

- BrowserAgent full test suite passed (including 27 browser-worker and 87 API tests); TestSite 21 routing/rendering tests passed; Actions build passed.
- Actual browser interaction regression rendered the real approval-card source: opened a new tab, closed it and opened another tab. Removed controls were absent.
- The same component test used the authenticated company-PC DeskNets session and the live handoff URL. Both openings showed September 25, 14:00–15:00 and native participant IDs 186, 5, 6. Native Add was never clicked.
- Remote live API test used a separate `schedule-smoke` identity/thread, not the user's chat. Initial search asserted at least four real candidates; candidate 1 selection reached awaiting approval; two handoff GETs succeeded; room change succeeded; re-search returned five future candidates.
- A second Remote audit compared proposals before invalidation: start/end, participant names and IDs unchanged, room changed from アクトミーティングルームC to アクト中会議室. Re-search was deterministic, had exactly one ＜最短＞ marker, and all five starts were in the future.
- Remote candidates: September 25 14:00–15:00, October 1 13:00–14:00 and 16:00–17:00, October 2 13:00–14:00, October 5 11:30–12:30 (JST).
- Public deployed JS returned HTTP 200 with the new label and without the removed controls. Site HTTPS and TestSite-to-VM health both returned 200.

## Scope and remaining Phase 1 limitation

The tests combine Remote API execution, actual component interaction, and the real native DeskNets page. They did not automate an authenticated full AzureChat chat session. The Phase 1 native URL transfers dates/times and participants only; subject, content, room and notification settings still require manual entry/checking in native DeskNets. All tests prepared unsaved drafts only: no meeting registration, email notification or Teams meeting creation occurred. The VM remains running for user testing.

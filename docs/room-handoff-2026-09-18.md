# Native room handoff — 2026-09-18

- Deployed worker/API commit: `3257ca4661a397bc6261f3d80a15dc31bc86aee4` on `vm-abagent-t01` only. Production AzureChat untouched; no TestSite frontend deployment needed.
- Extract `nativeFacilityId` from the verified prepared form's `.sch-row-plant input[name=pids]`. Require exactly one ID, numeric format, matching visible facility label, and matching `data-pid`.
- Preserve the ID in approval and manual-action responses, including room changes. The client handoff URL uses `pid=<native equipment ID>`, not the facility display name or `pids` parameter.
- A proposal with a facility but no verified native ID is rejected at handoff with a reselection instruction rather than silently omitting the room. Older in-memory proposals do not survive the API deployment restart; start a fresh search.
- Native DeskNet's final Add remains manual. No extension, native UI modification, or automatic registration.

## Verification

- `npm test` passed, including ID validation and extraction tests.
- Real local DeskNet's: two distinct equipment selections, each opened and reopened from a different-origin sender; dates and all three participant IDs retained. Native participant display order can change, so membership is compared as a set (test-only follow-up `b4ace46`).
- Actual TestSite card component harness: equipment-ID-bearing URL opened and reopened; date/time/three participants verified. This is a component harness, not full authenticated TestSite chat E2E.
- Real VM DeskNet's: two equipment selections, each opened and reopened, passed.
- Deployed VM API: fixed-date availability search, candidate selection, and two handoff requests passed. Run `52390236-e3de-4ae1-978c-30f5158eb282`, selected equipment ID `14`; URL `pid` matched the approval's native facility ID and participant IDs; `registered:false` both times.

Title/body/notification settings are not added by this change. The separately diagnosed chat-history routing issue is not changed here.

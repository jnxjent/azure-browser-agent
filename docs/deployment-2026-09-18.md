# TestSite / Browser Agent deployment — 2026-09-18

## Targets and Git

- Production AzureChat is out of scope. Do not push to its origin or modify its Azure resources.
- Browser Agent: `jnxjent/azure-browser-agent`, branch `testsite/desknets-agent-20260910`.
- Application commit: `111719a`; versioned VM deployment script: `595915c`.
- AzureChat TestSite: `jnxjent/azurechat-gpt5-test`, branch `testsite/fix-toggle-selfscope-20260323`.
- TestSite commit: `8c0419d5022c9bc34b9838aeadb5cd16848be516` (six DeskNet's files).
- TestSite Workflow: `azure-dev-validate.yml`, run `35297985874`.
- Result: **build and deploy succeeded**. The workflow ran against the exact
  TestSite commit above; its target guard passed and deployed to
  `azurechat-gpt5-test`. Post-deployment HTTPS check returned HTTP 200.
- Run: https://github.com/jnxjent/azurechat-gpt5-test/actions/runs/35297985874
- TestSite UI code and the VM runtime are deployed. End-to-end use still requires
  manual DeskNet's login in the dedicated VM Edge profile and a TestSite smoke test.
- TestSite local checks: 17 DeskNet's routing tests and Next.js production build passed.
- Browser Agent build and application tests passed before push.

## Latest successful deployment (after MFA and interactive login)

### Participant search correction

- Deployed `64a881fd6bf80aa42eb715054b1377ae4444f48d` after a participant
  search failed with a strict locator violation.
- Read-only VM DOM inspection confirmed two matching tables: one under
  `.co-sel-search.co-sel-chooser-items`, the other under
  `.co-sel-groups.co-sel-chooser-items`. The dialog was closed at inspection time.
- The worker now selects only visible search-results tables. It does not choose
  the first match when multiple search tables exist. Initial empty/hidden results
  are read without waiting before submitting the search.
- Added browser regression coverage for first/repeated searches, hidden group
  listings, reversed DOM order, visible group listings and ambiguous search tables.
  Full `npm test` passed; VM dependency installation, build and health passed.
- TestSite SCM-to-VM health probe returned HTTP 200 after deployment.
  Actual participant search must be retried from TestSite; no booking was submitted.
- This correction changes only the VM Browser Agent, not TestSite UI or production.

- The user completed Azure CLI MFA. The existing VM subnet now has
  `defaultOutboundAccess=true`; no NAT Gateway or public IP was added.
- VM outbound checks succeeded for Node.js, GitHub and npm. DeskNet's returned
  HTTP 401; the user subsequently confirmed successful login and schedule display
  in the VM's ordinary Edge profile via Bastion Developer.
- Deployed Browser Agent commit `cd6cfb497927ce47434fc0fb5e5b219f195b4157` to
  `C:\BrowserAgent\releases\cd6cfb497927ce47434fc0fb5e5b219f195b4157`.
  Node.js checksum verification, `npm ci`, TypeScript build and API health passed.
- Preserved the existing shared environment and API key. The key was transferred
  encrypted to an ephemeral local RSA key and synchronized to TestSite without
  printing plaintext credentials.
- `BrowserAgent-API` is running as the interactive VM user. The
  `BrowserAgent-DeskNets` launcher exited successfully, and dedicated Edge is
  reachable through CDP on **127.0.0.1:9222 only**.
- The API listens on 127.0.0.1:3001 with a private proxy on 10.251.1.4:3001.
  The Windows firewall rule limits incoming API traffic to 10.251.2.0/26.
- TestSite VNet integration now targets `snet-appservice-integration`.
  TestSite-only settings enable the agent and use `http://10.251.1.4:3001`.
- A probe from TestSite's SCM command environment to the VM health endpoint
  returned HTTP 200 with `{"status":"ok"}`. This verifies network connectivity,
  not yet the full authenticated application workflow.
- Next: user manually logs in through the **dedicated** Edge profile, then verify
  TestSite scheduling and orange-button reopening without submitting a booking.
- AzureChat production was not modified. VM remains running for the user's
  interactive login/test; do not deallocate until that session is finished.

## Earlier attempt: historical state (resolved as noted above)

The existing `vm-abagent-t01` in `rg-azurechat-browser-agent-test` was provisioned,
but had no Node.js/Git installation, Browser Agent tasks, application listener,
or non-system Windows user profile. VM provisioning was complete; application
deployment and browser authentication were not complete.

The VM has private address `10.251.1.4`, no public IP, and runs in
`vnet-azurechat-browser-agent-test-westus/snet-browser-agent-vm` (`10.251.1.0/24`).
The VM subnet has `defaultOutboundAccess=false`, no NAT Gateway and no route
table. Downloading Node.js failed because the VM could not reach the Internet.
An approved outbound route is needed before installing dependencies or accessing
DeskNet's. Do not add paid network resources without agreement on the cost.

Initial deployment created `C:\BrowserAgent\shared` with restricted ACLs and
a VM-specific `.env.local`. No release has yet been built or activated. No
Browser Agent scheduled task or private API proxy has yet been installed.
The generated VM API key was not applied to TestSite because deployment failed.
On retry, securely reconcile this existing VM key with TestSite settings; do not
generate a different key on each retry or expose the existing key in logs.

The proposed release script is `scripts/deploy-vm-release.ps1`. It installs
Node.js 22 with SHA256 verification, downloads a specified Git commit, builds it,
retains previous release directories, shares browser state, and registers tasks
for the existing `abaops` user's interactive logon. VM login and DeskNet's
authentication must be performed by the user; no credentials are automated.

## Earlier TestSite connection prerequisite (now resolved)

TestSite Web App: `azurechat-gpt5-test`, resource group `general51`.
Search index was verified as `dl_index_phase15_test`.
Before this attempt there was no DeskNet's Agent configuration and no VNet
integration. The intended integration subnet is `snet-appservice-integration`
(`10.251.2.0/26`), already delegated to `Microsoft.Web/serverFarms`.

Adding TestSite VNet integration was rejected with `RequestDisallowedByAzure`:
the Azure CLI user must reauthenticate through MFA. No attempt was made to bypass
this restriction. Complete MFA and agree on outbound connectivity before resuming
VM deployment and TestSite-to-VM connection configuration.

## Cost control

The VM was returned to `VM deallocated` after the earlier blocked deployment.
It has since been started and is currently running for interactive authentication
and testing. Deallocate after the user finishes testing to avoid compute charges.

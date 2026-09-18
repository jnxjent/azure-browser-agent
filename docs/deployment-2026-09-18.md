# TestSite / Browser Agent deployment — 2026-09-18

## Targets and Git

- Production AzureChat is out of scope. Do not push to its origin or modify its Azure resources.
- Browser Agent: `jnxjent/azure-browser-agent`, branch `testsite/desknets-agent-20260910`.
- Application commit: `111719a`; versioned VM deployment script: `595915c`.
- AzureChat TestSite: `jnxjent/azurechat-gpt5-test`, branch `testsite/fix-toggle-selfscope-20260323`.
- TestSite commit: `8c0419d5022c9bc34b9838aeadb5cd16848be516` (six DeskNet's files).
- TestSite Workflow: `azure-dev-validate.yml`, run `35297985874`.
- TestSite local checks: 17 DeskNet's routing tests and Next.js production build passed.
- Browser Agent build and application tests passed before push.

## Existing VM: confirmed actual state

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

## TestSite connection prerequisite

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

The VM was started only for inspection/deployment and returned to
`VM deallocated` after the blocked deployment. The final status was verified.

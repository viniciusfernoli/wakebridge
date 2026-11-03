# Validation record — 2026-11-03

Historical first checkpoint. For current Android/WoL/discovery/orchestration and browser evidence, see [phase2-validation.md](phase2-validation.md).

Scope: first approved checkpoint (foundation, agent protocol and native Windows inventory). This is not a declaration that the complete Wake-on-LAN MVP is finished.

| Area                                  | Evidence                                                                                                                                                                           | Result                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| TypeScript protocol                   | `npm test`: three tests for inventory/MAC validation, prohibited operations/fields, protocol version and invalid addresses/sequence input                                          | Passed                                                                     |
| Real API/database                     | Isolated PostgreSQL database, real migration, compiled NestJS server, real WebSockets; 12 integration groups                                                                       | Passed                                                                     |
| Authorization                         | Unauthenticated requests, exact Origin protection, cross-workspace isolation, VIEWER cannot approve/revoke                                                                         | Passed                                                                     |
| Pairing                               | Wrong secret, pending approval, expiry, concurrent claims, single consumption                                                                                                      | Passed                                                                     |
| Connection lifecycle                  | Heartbeat ack, replay refusal, session replacement/fencing, stale interface persistence, disconnect and timeout without deleting inventory                                         | Passed                                                                     |
| Credential lifecycle                  | Hashed storage, atomic rotation, old token rejected, active revocation, preserved inventory, audit                                                                                 | Passed                                                                     |
| Native Windows                        | Actual Go executable pairs with the API, reports actual machine hardware, persists encrypted DPAPI credentials, goes offline on process termination, reconnects as the same device | Passed in three additional integration groups                              |
| Go                                    | Five Windows tests (transport origins, user DPAPI, hardware, broadcast calculation, stable adapter identity), build and `go vet`                                                   | Passed                                                                     |
| Frontend                              | Production Next build, TypeScript, lint; source detector returned no findings                                                                                                      | Passed mechanically; visual/interactivity review pending                   |
| Next proxy                            | `node scripts/web-smoke.mjs`: actual HTTP/auth cookie flow, logout, WebSocket upgrade, manifest/icons and native download through Next                                             | Passed                                                                     |
| Dependencies                          | `npm audit`, including development dependencies                                                                                                                                    | Zero vulnerabilities reported at verification time                         |
| Windows service                       | SCM install/remove, LocalService configuration, recovery and DPAPI enrollment transfer implemented; elevated PowerShell installer supplied                                         | Compiled; service installation, identity transfer and reboot not exercised |
| Browser UI                            | Computer-use runtime stopped because it could not reliably determine the current Chrome URL for its policy checks                                                                  | Blocked; no screenshot, visual, touch or keyboard QA claimed               |
| Public HTTPS                          | Caddy production configuration and VPS instructions provided                                                                                                                       | Public DNS/ACME issuance not exercised                                     |
| Android, LAN discovery, WoL, failover | Outside this checkpoint                                                                                                                                                            | Not implemented or claimed                                                 |

The root workspace was migrated from the original pnpm plan to **npm workspaces + Turborepo** after the user's authorization. Only `package-lock.json` is authoritative. Portable Go remains local in `.tools`; the user's NVS/Node setup was not changed.

All automated agent data is isolated from real accounts. The native integration test collects real hardware only in its disposable test workspace/database. No example inventory is inserted into the dashboard's regular database. Local Windows executable is about 7 MB, with a roughly 3 MB zip; no CPU/RAM benchmark or Authenticode signing claim is made.

## Linux image and Caddy verification

Both Dockerfile targets built successfully, including cross-compilation of the Windows executable. `compose.review.yml` started an independent PostgreSQL/API/Next/Caddy stack on loopback port 3200; migrations applied and health checks passed. The API runs as uid 1000 (`node`). The HTTP/auth/session/logout/WebSocket/PWA/download smoke also passed through Caddy inside this isolated network. This local review deliberately uses HTTP; public TLS/DNS issuance remains untested.

## Owner review

1. Open the local dashboard, create your own account and add a Windows device.
2. Run the built console agent, enter its code in the dashboard, inspect the name and approve.
3. Check actual CPU, memory, MAC/IP and interface details.
4. Stop the agent; confirm offline with the inventory retained. Start again; confirm the same device returns online.
5. Inspect light/dark, mobile layout, keyboard focus, error/empty states and revocation confirmation. These UI checks are pending due to the browser tooling interruption.
6. On an elevated test machine, extract the zip and install the service. Verify `Get-Service WakeBridge`, account `NT AUTHORITY\LocalService`, startup after reboot, recovery after temporary network loss and uninstall. Inspect that `enrollment.dpapi` is consumed and only `agent.dpapi` remains in ProgramData. Do not treat successful console DPAPI tests as proof of service-user DPAPI behavior.

Stop at this review boundary before implementing Android or remote power commands. Physical Wake-on-LAN acceptance still requires both relay types and the real BTV B13 in a later phase.

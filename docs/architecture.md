# Architecture and delivery boundaries

First checkpoint delivered; the owner authorized continuing on 2026-11-03. Current scope: Android, real UDP WoL, authenticated discovery and durable relay orchestration. Next stop: review this integrated flow before full interface/distribution polish. MIT licensed. No Redis.

## Second checkpoint decisions

- Protocol v2 adds an explicit command allowlist, expiry, connection-bound results and monotonic sequence numbers. Version 1 remains inventory-only. Local LAN participation is opt-in on each agent; server-side owner approval is separate.
- Discovery is bounded pairwise UDP broadcast on port 34780, with 30s, pair-specific secrets distributed through authenticated WSS. Both agents report the same authenticated nonce transcript independently. Matching IP ranges only select probes; no link is inferred from them. No address sweep.
- Connectivity evidence binds exact interface/address snapshots and a runtime network epoch. A changed network or restarted relay invalidates old evidence; manual owner-authorized associations are labeled manual and bound to the current epoch. This deliberately favors an explained unavailable relay over broadcasting on an unverified network.
- Wake operations and attempts live in PostgreSQL. One active wake per target, workspace-scoped idempotency keys, max three relay attempts, bounded ack/boot deadlines and reconnection-based confirmation. A successful UDP send becomes waiting, never online. Restart recovery reads persisted work; ambiguous attempts are not blindly redelivered.
- Windows emits WoL with a UDP socket bound to the selected local IPv4; Android uses the selected network/interface. Broadcast/MAC are validated on both server and agent. No shell commands are introduced. Power shutdown/restart remains a separate sensitive capability and is not inferred from WoL consent.
- Android targets API 37 with explicit ACCESS_LOCAL_NETWORK permission, min API 26, connectedDevice Foreground Service, visible stop control, Android Keystore AES-GCM and native touch/TV controls. No wake lock or OEM-standby workaround is assumed. SDK/Gradle tools are project-local.

## Components

`apps/web` (Next App Router) → same-origin `/api` → `apps/api` (NestJS) → PostgreSQL. Agents initiate `/api/agent` WebSockets; dashboard uses `/api/events` for invalidations. Caddy terminates TLS and routes HTTP upgrades. `packages/shared` owns versioned TypeScript schemas, not artificial Go/Kotlin sharing. `docs/protocol.md` is the cross-language contract.

The user authorized switching the package manager after the initial plan: the repository uses npm workspaces/Turborepo and package-lock.json. No pnpm configuration is needed.

## Security

Argon2id passwords; random opaque sessions and agent credentials stored only as SHA-256 hashes on the server. HttpOnly, SameSite=Strict cookies, Secure in production; origin checks on mutations and browser WebSockets. Login/register rate limits apply to the peer IP; Caddy is the only trusted proxy in production. All workspace reads/mutations authorize membership. Pairing requires the agent's secret, a one-use short human code, logged-in owner approval, expiry and atomic consumption. Tokens never appear in URLs or logs.

The Windows agent uses current-user DPAPI and a restricted directory. A Windows service runs as LocalService; enrollment performed by an administrator is transferred to that service identity through a one-time machine-DPAPI envelope with an ACL restricted to administrators and LocalService, then re-protected under service-user DPAPI. No shell or power commands in protocol v1 at this checkpoint.

## Connection state

One active session per device; the most recent authenticated connection replaces the old one. Database writes are fenced by session id. Heartbeat expiry means offline, never proof of shutdown. Inventory survives disconnect, process restart and credential revocation. Revocation closes active connections. Rotation requires the old credential and returns a new token once; old sessions close. The browser receives invalidation events and refetches authorized data; periodic refetch recovers missed events.

## Deployment constraints

This checkpoint supports ONE API replica. A PostgreSQL advisory lock enforces ownership until workers and sockets have stopped; services wait for database ownership before touching durable work. Active socket ownership is in memory; startup resets observed connection state. Operations and immutable attempt payloads are persisted before dispatch. Restart fences old-session results and retains ambiguous attempts for bounded recovery rather than blindly redelivering the same id. Registration can be disabled after the first account.

## Later phases

Remaining: safe self-shutdown/restart, full member/profile/permission management, distribution/signing polish and physical acceptance using BTV and Windows relays. Android, UDP WoL, authenticated discovery and orchestration are now implemented; see protocol-v2.md and phase2-validation.md. Public IP and matching CIDRs alone are never proof of connectivity. No cross-workspace shared discovery key.

## Validation

Dedicated local containers use 3100/4100/55432; Linux image review has its own database/Caddy stack on 3200. API integration tests use real PostgreSQL/WebSockets. Native tests include an exact Magic Packet captured from the Windows agent's real UDP broadcast, followed by a simulated target reconnection. Android packet/UDP tests and APK builds passed on Windows/Linux; no physical Android was connected. Browser access is working in the second session: actual registration, pairing, native inventory, offline/reconnect, relay controls and mobile/theme behavior are reviewed. Service installation/reboot still needs elevation; Android runtime/standby and real S5 wake remain physical acceptance items. Public DNS/ACME issuance is not claimed.

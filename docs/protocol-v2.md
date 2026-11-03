# Agent protocol v2

Version 1 remains accepted for inventory/heartbeats only; existing credentials continue working. Native agents now use version 2. `/api/health` lists `[1,2]`. Transport, credential isolation, message size, sequence/session fencing and TLS requirements remain as described in [v1](protocol.md).

## Inventory and consent

`lanEnabled` is an agent-local opt-in and a report of available UDP access, not a dashboard permission. `capabilities` may include `inventory`, `wol`, `discovery`. `networkEpoch` is a 64-character lowercase SHA-256 value derived from a runtime salt and actual network observations. Windows includes stable adapter GUIDs, addresses, configured gateways and cached gateway MACs; Android includes network handles and local interfaces. No MAC is invented when Android withholds it. Restarting an agent changes its epoch; interface/network changes invalidate previous evidence. Heartbeat reconnection within the same process retains identity and revalidates snapshots.

The workspace owner separately enables `relayApproved`. No LAN command is selected without both local participation and server authorization. Wake endpoints require OWNER or explicit `canWake`; viewing does not imply that permission.

## Commands

Server envelopes contain `type=command`, `version=2`, a UUID `commandId`, the current `sessionId`, an absolute UTC millisecond `expiresAt`, an `action` and typed `payload`. Wake commands also include `operationId`. Actions are exclusively `wake`, `probe.listen`, `probe.send`; unknown operations never launch programs, shell commands or scripts.

For `wake`, payload contains `localInterfaceId` (the agent's native adapter id), `localAddress`, `networkEpoch`, `targetAddress`, `prefixLength`, `broadcast`, `mac`. Both sides validate a private directly connected IPv4 subnet (prefix 1–30), exact directed broadcast, current interface and unicast nonzero six-byte MAC. UDP destination port is fixed to 9. The packet is six FF bytes followed by the MAC repeated 16 times. It is sent once by that attempt, from the specified interface. No routed broadcast or VLAN traversal is assumed.

Before emission, each agent persists command-id consumption locally. Expired or repeated ids cannot trigger the same attempt again after a reconnect/restart. Transport expiry is at most 30 seconds; default ack deadline is 8 seconds. A result is a sequenced client message with `type=command.result`, `commandId`, `status=packet_sent|failed`, and a reason from the protocol allowlist. Server verifies relay identity, session id, attempt state and expiry; a different relay cannot acknowledge the command.

## Pairwise local discovery

The coordinator considers at most eight issued challenges and 64 candidate comparisons per pass. It uses matching private interface ranges to choose bounded probes, never to infer connectivity. There are no subnet/port sweeps and no public-IP grouping.

1. Generate a UUID ticket and random 32-byte base64url secret, valid for 30 seconds. Persist only its hash and test metadata; retain the secret in bounded process memory until expiry.
2. Send `probe.listen` to the receiver. Payload adds `ticketId`, `secret`, `peerDeviceId`, `peerAddress` to the selected local interface/subnet snapshot. The receiver installs that one ticket and sends sequenced `probe.ready`.
3. Send `probe.send` to the initiator with the inverse selected endpoints. It broadcasts on UDP 34780 at most three times, bound to the source interface.
4. Receiver accepts only the authorized ticket, expected peer address/id, matching HMAC and current local epoch. It replies by unicast with a fresh nonce, from its selected interface. Invalid/unknown packets receive no response. Packet size is capped at 2048 bytes; agents bound ticket count and receive processing.
5. Initiator validates reply source, ticket, nonce, peer and HMAC. Both agents independently submit sequenced `probe.proof` through their authenticated WSS sessions. The coordinator requires the identical valid reply transcript from BOTH identities and checks their snapshots again before storing links.

UDP datagrams carry `version`, `kind=challenge|reply`, `ticketId`, `from`, `to`, `nonce`, `responseNonce`, `signature`. Nonces are random 16-byte lowercase hex strings; challenge responseNonce is empty. The signed UTF-8 text has exactly this form, with no whitespace/newline:

```text
wakebridge|2|<ticketId>|<from>|<to>|<nonce>|<responseNonce>|<kind>
```

`signature` is lowercase hex HMAC-SHA256, using the base64url-decoded ticket secret. The proof submitted by each agent contains the ticket, both nonces and the reply signature. One reporter cannot create a verified link. API restart expires unfinished tickets. This is connectivity evidence between authorized agents, not hardware attestation against two colluding agents controlled by the same owner.

Verified links bind both device epochs and exact interface ids/IP/MAC/subnet snapshots, expire after 30 days and refresh while both peers are online. Manually authorized links are distinctly labeled `MANUAL`, expire after 24 hours, and never create a verified network domain. Domains are computed as connected components of current authenticated interface links; a multihomed device does not merge its separate interfaces by itself.

## Durable operations

`POST /api/workspaces/:workspaceId/devices/:deviceId/wake` accepts a UUID `idempotencyKey`. A workspace-key uniqueness constraint prevents replay, and a partial unique index prevents two active wake operations for the same target even with different keys. If already online, return `ONLINE / already_online` without dispatch.

For offline targets, rank current eligible links by owner priority, authenticated evidence and observed history. Record an attempt and immutable payload snapshot before dispatch. Try at most three DIFFERENT relays. Known UDP failure can fail over immediately; unknown ack status or a sent packet waits 20 seconds before another relay. Default total boot deadline is 120 seconds. All these deadlines are stored; the one-second worker queries persisted state.

States: `QUEUED`, `SENT`, `WAITING`, `ONLINE`, `FAILED`, `UNCONFIRMED`. Packet acknowledgement becomes WAITING. Only an authenticated target connection observed after the operation began becomes ONLINE. Exhausted known failures become FAILED; a successful/ambiguous dispatch without observed boot becomes UNCONFIRMED. API restart marks in-flight attempts UNCERTAIN, retains operations and never blindly reissues the same attempt id. A late or replaced-session result is ignored.

`relay-test` is a separate operation kind: its `EXECUTED / packet_sent_only` result means only packet emission. Audit records requests, authorizations and manual bindings. Query authorized operation history and relay availability reasons through the dashboard/API. A single API replica is enforced by the PostgreSQL ownership lock; timers are scheduling hints, not the durable source of truth.

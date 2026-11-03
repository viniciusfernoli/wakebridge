# Agent protocol v1 — implemented checkpoint

Transport: outbound RFC6455 WebSocket at `wss://<origin>/api/agent`. TLS certificate verification is mandatory. Only HTTP/WS loopback is allowed for local development. No token in URL or headers of HTTP upgrade. No compression. Maximum message 64KiB; JSON text only. Browser Origin is rejected on the agent socket.

Within 5s send:

```json
{
  "type": "auth",
  "version": 1,
  "token": "<exclusive-agent-token>",
  "inventory": {
    "hostname": "PC",
    "osVersion": "Windows 11",
    "architecture": "amd64",
    "agentVersion": "0.1.0",
    "cpu": "actual CPU",
    "memoryBytes": 8589934592,
    "capabilities": ["inventory"],
    "interfaces": [
      {
        "nativeId": "adapter-identity",
        "name": "Ethernet",
        "mac": "02:00:00:00:00:01",
        "addresses": [
          {
            "address": "192.168.1.10",
            "prefixLength": 24,
            "broadcast": "192.168.1.255"
          }
        ],
        "isUp": true,
        "wolSupport": "unknown"
      }
    ]
  }
}
```

The addresses above illustrate the contract only; the dashboard never injects sample inventory. MAC is nullable. IPv4 only at this checkpoint; no IPv6 WoL/discovery claim. The server responds:

```json
{
  "type": "ready",
  "version": 1,
  "deviceId": "uuid",
  "sessionId": "uuid",
  "heartbeatMs": 5000,
  "offlineAfterMs": 20000
}
```

Then send monotonically increasing sequence numbers (starting at 1) bound to this connection:

```json
{ "type": "heartbeat", "version": 1, "sessionId": "uuid", "seq": 1 }
```

Response: `{"type":"ack","version":1,"seq":1}`. Every 60s send type `inventory` with the same envelope and a complete `inventory` snapshot instead of heartbeat. Old network interfaces remain persisted with `present=false`. New sessions reset sequence numbering. Authentication must be repeated after every reconnect. One active connection per device. Code 4001 means replacement; 4000 credential_revoked/credential_rotated means stop and re-pair/reload the new credential. Code 1008 means invalid authentication, schema, operation or replay. Unknown fields and remote operation types are rejected. Agents implement no shell, shutdown or wake handlers in v1.

## Pairing

1. Agent POST `/api/pairing/start` with name/platform (`windows`) receives pairingId, secret, code and 5min expiry. Secret stays in the agent's memory. Only the human code is displayed locally; it is never logged server-side.
2. Owner POST `/api/workspaces/:id/pairing/inspect` and then `/approve` with code using their session and valid browser Origin. Inspect returns the claimed name and platform for review. These are untrusted display labels, not device attestation.
3. Agent polls `/api/pairing/claim` every 2s with pairingId and secret. Pending does not reveal another account. After owner approval the first atomic claim creates the device and returns an exclusive token once. Retries after consumption cannot retrieve it; if the response is lost, restart pairing.
4. The console agent protects its config with user-DPAPI; Windows service installation transfers it through a restricted one-time machine-DPAPI envelope and rewraps under LocalService DPAPI.

## Rotation/revocation

POST `/api/agent/rotate` with Bearer old credential atomically revokes it, returns the replacement once and closes existing sockets. Persist the replacement before reconnecting. Console/service automatic rotation is not implemented; an operator can revoke and re-pair with the installers. Owner POST `/api/workspaces/:id/devices/:deviceId/revoke` immediately disconnects and revokes all active credentials. Inventory is preserved.

## Dashboard events

`/api/events` uses the user cookie and an exact browser Origin check. Read-only events: `ready` and `devices.changed` with workspaceId. Memberships and session validity are refreshed every 20s; logout closes sockets immediately. Clients refetch authorized resources after invalidation, reconnect with jitter and refetch periodically as fallback. No inventory or secrets in event frames.

## Limits and availability

Handshake timeout 5s, heartbeat offline threshold 20s, bounded four queued messages per connection, total socket cap 1000, buffered output cap 64KiB. HTTP limits per peer: authentication 20/min, pairing 90/min, other API 300/min. This is a single-API-replica design guarded by a database lock. Offline is absence of current evidence, not an observed power state.

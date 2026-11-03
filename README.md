# WakeBridge

Self-hosted, MIT-licensed remote device platform. The second review checkpoint implements Windows and Android/TV agents, authenticated persistent connections, secure pairing, retained inventory, opt-in LAN discovery, real UDP Wake-on-LAN, relay failover, durable operations and an integrated dashboard. Complete physical acceptance is still pending on the BTV B13 and target PC. Remote shutdown/restart, complete permissions/profile management and distribution polish remain for the next phase.

## Local development on Windows

Use your existing NVS/Node installation: Node 24.11+ (24.x) and npm 10+; the current lockfile was generated with npm 12.2.0. Docker Desktop must expose the Linux engine. Go is required only to build/test the native agent. Other projects and existing databases are not used.

```powershell
Copy-Item .env.example .env
npm ci
docker compose -f infra/docker/compose.dev.yml up -d --wait
npm run db:generate
npm run db:migrate
# Optional portable Go installation, verified against official SHA-256:
.\scripts\setup-tools.ps1
.\scripts\build-windows.ps1
npm run dev
```

Open http://localhost:3100, create an account, then **Adicionar dispositivo**. API is on 4100; the separate PostgreSQL instance binds only loopback on 55432. Without `build-windows.ps1` the dashboard download has no executable yet. Docker builds generate it automatically from the Go sources.

To pair and run without elevation:
```powershell
.\.local\windows\wakebridge.exe pair --server http://localhost:3100
```
Enter the displayed temporary code in the dashboard, inspect the computer name and approve. Keep the console open. Ctrl+C disconnects; the device and interfaces remain saved. Run again with `wakebridge.exe run` to reconnect using DPAPI-protected credentials. HTTP is accepted only for loopback; use real HTTPS for another computer.

## Install the Windows service

Build output `.local/wakebridge-windows-amd64.zip` includes the executable and installation scripts. Extract together and use an **elevated** PowerShell:
```powershell
.\install-windows.ps1 -Server https://control.example.com
```
Approve the displayed code in the dashboard. Installation copies to Program Files, enrolls the device, registers automatic startup and recovery, then starts as **LocalService**, not LocalSystem. Restricted credential/log storage is in `%ProgramData%\WakeBridge`; it needs administrator permission only for installation/removal. Never install the service with a writable executable path. The console config lives in `%LOCALAPPDATA%\WakeBridge` and is separate from service identity.

```powershell
.\uninstall-windows.ps1
# Include -PurgeCredentials only to remove local service credentials/logs as well.
```
Also revoke the old agent in the dashboard. Server inventory is retained. Binaries are currently unsigned; code signing and a graphical installer are not claimed.

## Checks

```powershell
npm run lint
npm run build
npm run typecheck
npm test
npm run test:e2e
# Windows only, after build-windows.ps1:
npm run test:native
```
Integration tests create a randomly named isolated PostgreSQL database, apply real migrations, start a separate API, use real WebSockets, and remove only that database afterward. The configured PostgreSQL user must have CREATEDB (the local container user does). `test:native` executes the actual Go binary: pairs, verifies hardware/DPAPI, terminates, verifies retained inventory, reconnects and executes a real UDP wake command. Its exact Magic Packet was captured; target boot is simulated. `npm run test:relays` covers authenticated discovery, both relay platforms, failover and restart recovery using explicit protocol simulators. No simulated inventory is seeded into the regular dashboard.

See [validation.md](docs/validation.md) for actual evidence and limitations and [protocol.md](docs/protocol.md) for the cross-language contract.

To review the built Linux images locally without a domain, build both Dockerfile targets as `wakebridge-api:review` and `wakebridge-web:review`, then run `docker compose -f infra/docker/compose.review.yml up -d --wait`. This separate database/Caddy stack serves http://localhost:3200. It deliberately uses local HTTP and development cookies; production uses the HTTPS configuration below.

## VPS deployment

1. Point a domain at your Linux VPS. Allow inbound TCP 80/443 and optionally UDP 443 on the **VPS**. No home-router inbound ports are used.
2. Copy `.env.production.example` to `.env`. Set a strong database password in both fields (URL-encode it in DATABASE_URL), your domain and ACME email. DATABASE_URL uses hostname `db` inside Compose.
3. `docker compose up -d --build --wait`. Caddy obtains a public certificate; browsers/agents use HTTPS/WSS on 443. PostgreSQL, API and Next have no published host ports.
4. Create your account; set `REGISTRATION_ENABLED=false` and recreate the API to close public signup. There is no email delivery/recovery flow at this checkpoint; preserve access to the owner account.

One API replica is supported and enforced. Do not scale it yet. Migration deployment runs before API startup. Do not use local HTTP credentials for internet access. Public ACME/DNS issuance requires a real domain and is not validated by local builds.

## Backup and update

On a Linux host:
```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > wakebridge.dump
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' < wakebridge.dump
```
Restoring overwrites that database; stop the API first and verify the destination. Protect dumps because they contain personal inventory and credential hashes. Keep encrypted off-host backups, `.env` and Caddy volumes. For updates, back up first, pull reviewed source and run `docker compose up -d --build --wait`. Database rollback requires a matching backup, not an older API alone. Avoid `docker compose down -v` unless intentionally discarding database/certificates.

## Wake-on-LAN boundaries

Every Windows interface reports hardware wake support **unknown**: Ethernet presence never proves S5 support. To use a Windows relay, pair with `--lan` (or install with `-EnableLanRelay`); on Android, explicitly enable LAN access and grant the OS permission. Authorize each participating device in its dashboard details, keep both agents online for the authenticated connectivity test, then use **Ligar computador** after the target disconnects. The operation records dispatch and waits for the target agent to reconnect. A packet report never proves the machine booted.

If discovery fails, select the exact source/target interfaces and explicitly authorize a manual same-LAN association. **Testar emissão do pacote** checks dispatch only; it is not a wake verification. Changed interface/network epochs invalidate links; relay restarts need a fresh test or a manual association if the target is offline. BIOS/UEFI settings, NIC power options, Windows Fast Startup and physical power/network behavior still require hardware tests. Android/BTV standby availability cannot be inferred from another device.

See [the Android build and physical test procedure](docs/android-and-hardware.md), [protocol v2](docs/protocol-v2.md) and [the second checkpoint validation](docs/phase2-validation.md).

No arbitrary command, program, shell or script execution is exposed. See [architecture.md](docs/architecture.md).

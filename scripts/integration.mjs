import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Client } = require("pg");
const { WebSocket } = require("ws");
require("dotenv").config({
  path: new URL("../.env", import.meta.url),
  quiet: true,
});
const connection = new URL(
  process.env.DATABASE_URL ??
    "postgresql://wakebridge:change-this-development-password@localhost:55432/wakebridge",
);
const dbName = `wb_test_${randomBytes(6).toString("hex")}`;
assert.match(dbName, /^wb_test_[a-f0-9]{12}$/);
const admin = new Client({ connectionString: connection.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${dbName}"`);
connection.pathname = `/${dbName}`;
const db = new Client({ connectionString: connection.toString() });
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = "http://localhost:3100";
const base = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  DATABASE_URL: connection.toString(),
  NODE_ENV: "test",
  WEB_ORIGIN: origin,
  PORT: String(port),
  ...(process.argv.includes("--relays")
    ? {
        WAKE_TIMEOUT_MS: "6000",
        COMMAND_ACK_TIMEOUT_MS: "1500",
        RELAY_RETRY_MS: "900",
        ORCHESTRATOR_TICK_MS: "100",
      }
    : {}),
};
let server;
let native;
let nativeDirectory;
let serverLog = "";
let checks = 0;
const sockets = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function check(name, action) {
  await action();
  console.log(`PASS ${name}`);
  checks++;
}
async function request(path, body, cookie, extra = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
  });
  return {
    status: response.status,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    body: await response.json(),
  };
}
async function until(action, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await action()) return;
    await sleep(250);
  }
  throw new Error("Condition timed out");
}
async function socket(path = "/api/agent", options = {}) {
  const ws = new WebSocket(base.replace("http", "ws") + path, options);
  sockets.push(ws);
  await once(ws, "open");
  return ws;
}
function message(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Message timeout"));
    }, 6000);
    const receive = (raw) => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const closed = () => {
      cleanup();
      reject(new Error("Connection closed before message"));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", receive);
      ws.off("close", closed);
    }
    ws.once("message", receive);
    ws.once("close", closed);
  });
}
async function restartServer() {
  server.kill();
  await Promise.race([once(server, "exit"), sleep(5000)]);
  server = spawn(process.execPath, ["dist/main.js"], {
    cwd: new URL("../apps/api", import.meta.url),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (d) => {
    serverLog = (serverLog + d).slice(-6000);
  });
  server.stderr.on("data", (d) => {
    serverLog = (serverLog + d).slice(-6000);
  });
  await until(async () => {
    try {
      return (await request("health")).status === 200;
    } catch {
      return false;
    }
  }, 30000);
}
async function pair(cookie, workspaceId, name = "Integration PC") {
  const start = await request("pairing/start", { name, platform: "windows" });
  assert.equal(start.status, 201);
  const approved = await request(
    `workspaces/${workspaceId}/pairing/approve`,
    { code: start.body.code },
    cookie,
  );
  assert.equal(approved.status, 200);
  const claimed = await request("pairing/claim", {
    pairingId: start.body.pairingId,
    secret: start.body.secret,
  });
  assert.equal(claimed.status, 200);
  return { ...claimed.body, start: start.body };
}
const inventory = {
  hostname: "integration-agent",
  osVersion: "Windows simulator",
  architecture: "amd64",
  agentVersion: "0.1.0",
  cpu: "Protocol test",
  memoryBytes: 8192,
  capabilities: ["inventory"],
  interfaces: [
    {
      nativeId: "test-guid",
      name: "Ethernet",
      mac: "02:00:00:00:00:01",
      addresses: [
        {
          address: "192.168.7.20",
          prefixLength: 24,
          broadcast: "192.168.7.255",
        },
      ],
      isUp: true,
      wolSupport: "unknown",
    },
  ],
};
try {
  execFileSync(
    process.execPath,
    [require.resolve("prisma/build/index.js"), "migrate", "deploy"],
    {
      cwd: new URL("../apps/api", import.meta.url),
      env: environment,
      stdio: "pipe",
    },
  );
  await db.connect();
  server = spawn(process.execPath, ["dist/main.js"], {
    cwd: new URL("../apps/api", import.meta.url),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (d) => {
    serverLog = (serverLog + d).slice(-6000);
  });
  server.stderr.on("data", (d) => {
    serverLog = (serverLog + d).slice(-6000);
  });
  await until(async () => {
    try {
      return (await request("health")).status === 200;
    } catch {
      return false;
    }
  }, 30000);
  let owner;
  let other;
  let workspaceId;
  let paired;
  let agent;
  let ready;
  await check(
    "validation, origin protection and unauthenticated access",
    async () => {
      assert.equal((await request("auth/me")).status, 401);
      assert.equal(
        (
          await request("auth/register", {
            name: "Test",
            email: "owner@example.test",
            password: "short",
            workspaceName: "Test house",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("auth/login", {}, null, {
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
    },
  );
  await check(
    "real account, workspace and secure session lifecycle",
    async () => {
      owner = await request("auth/register", {
        name: "Owner",
        email: "owner@example.test",
        password: "test-password-12345",
        workspaceName: "Test house",
      });
      assert.equal(owner.status, 201);
      assert.ok(owner.cookie);
      assert.equal(owner.body.passwordHash, undefined);
      const me = await request("auth/me", undefined, owner.cookie);
      workspaceId = me.body.workspaces[0].id;
      assert.equal(me.body.workspaces[0].role, "OWNER");
      other = await request("auth/register", {
        name: "Other",
        email: "other@example.test",
        password: "test-password-54321",
        workspaceName: "Other house",
      });
      assert.equal(other.status, 201);
      assert.equal(
        (
          await request("auth/login", {
            email: "owner@example.test",
            password: "wrong-password-000",
          })
        ).status,
        401,
      );
      const login = await request("auth/login", {
        email: "owner@example.test",
        password: "test-password-12345",
      });
      assert.equal(login.status, 200);
      assert.equal(
        (await request("auth/logout", {}, login.cookie)).status,
        200,
      );
      assert.equal(
        (await request("auth/me", undefined, login.cookie)).status,
        401,
      );
    },
  );
  await check("workspace isolation and viewer cannot pair", async () => {
    assert.equal(
      (
        await request(
          `workspaces/${workspaceId}/devices`,
          undefined,
          other.cookie,
        )
      ).status,
      403,
    );
    const otherMe = await request("auth/me", undefined, other.cookie);
    await db.query(
      'INSERT INTO "Membership" ("userId","workspaceId","role") VALUES ($1,$2,\'VIEWER\')',
      [otherMe.body.id, workspaceId],
    );
    assert.equal(
      (
        await request(
          `workspaces/${workspaceId}/pairing/approve`,
          { code: "1234-5678" },
          other.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `workspaces/${workspaceId}/devices`,
          undefined,
          other.cookie,
        )
      ).status,
      200,
    );
  });
  await check(
    "pairing secret, expiry, one-use consumption and race protection",
    async () => {
      const start = await request("pairing/start", {
        name: "Concurrent PC",
        platform: "windows",
      });
      const payload = {
        pairingId: start.body.pairingId,
        secret: start.body.secret,
      };
      assert.equal(
        (
          await request("pairing/claim", {
            ...payload,
            secret: "wrong".repeat(12),
          })
        ).status,
        401,
      );
      assert.equal(
        (await request("pairing/claim", payload)).body.status,
        "pending",
      );
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/pairing/inspect`,
            { code: start.body.code },
            owner.cookie,
          )
        ).body.name,
        "Concurrent PC",
      );
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/pairing/approve`,
            { code: start.body.code },
            owner.cookie,
          )
        ).status,
        200,
      );
      const claims = await Promise.all([
        request("pairing/claim", payload),
        request("pairing/claim", payload),
      ]);
      assert.equal(
        claims.filter((r) => r.status === 200 && r.body.status === "paired")
          .length,
        1,
      );
      assert.equal((await request("pairing/claim", payload)).status, 401);
      const expired = await request("pairing/start", {
        name: "Expired",
        platform: "windows",
      });
      await db.query(
        'UPDATE "Pairing" SET "expiresAt" = NOW() - INTERVAL \'1 minute\' WHERE id = $1',
        [expired.body.pairingId],
      );
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/pairing/approve`,
            { code: expired.body.code },
            owner.cookie,
          )
        ).status,
        409,
      );
      paired = await pair(owner.cookie, workspaceId);
    },
  );
  await check(
    "WebSocket authentication, native inventory and live browser event",
    async () => {
      const viewer = await socket("/api/events", {
        headers: { Cookie: owner.cookie, Origin: origin },
      });
      await message(viewer);
      const event = message(viewer);
      agent = await socket();
      const next = message(agent);
      agent.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: paired.token,
          inventory,
        }),
      );
      ready = await next;
      assert.equal(ready.type, "ready");
      assert.equal(ready.deviceId, paired.deviceId);
      assert.equal((await event).workspaceId, workspaceId);
      const view = await request(
        `workspaces/${workspaceId}/devices`,
        undefined,
        owner.cookie,
      );
      const device = view.body.find((d) => d.id === paired.deviceId);
      assert.equal(device.status, "online");
      assert.equal(device.interfaces[0].mac, inventory.interfaces[0].mac);
      assert.equal(device.memoryBytes, "8192");
    },
  );
  await check("heartbeat acknowledgement and replay rejection", async () => {
    const heartbeat = {
      type: "heartbeat",
      version: 1,
      sessionId: ready.sessionId,
      seq: 1,
    };
    const next = message(agent);
    agent.send(JSON.stringify(heartbeat));
    assert.equal((await next).seq, 1);
    let snapshot = message(agent);
    agent.send(
      JSON.stringify({
        type: "inventory",
        version: 1,
        sessionId: ready.sessionId,
        seq: 2,
        inventory: { ...inventory, interfaces: [] },
      }),
    );
    await snapshot;
    let view = await request(
      `workspaces/${workspaceId}/devices`,
      undefined,
      owner.cookie,
    );
    assert.equal(
      view.body.find((d) => d.id === paired.deviceId).interfaces[0].present,
      false,
    );
    snapshot = message(agent);
    agent.send(
      JSON.stringify({
        type: "inventory",
        version: 1,
        sessionId: ready.sessionId,
        seq: 3,
        inventory,
      }),
    );
    await snapshot;
    view = await request(
      `workspaces/${workspaceId}/devices`,
      undefined,
      owner.cookie,
    );
    assert.equal(
      view.body.find((d) => d.id === paired.deviceId).interfaces[0].present,
      true,
    );
    const close = once(agent, "close");
    agent.send(JSON.stringify(heartbeat));
    assert.equal((await close)[0], 1008);
    await until(
      async () =>
        (
          await request(
            `workspaces/${workspaceId}/devices`,
            undefined,
            owner.cookie,
          )
        ).body.find((d) => d.id === paired.deviceId).status === "offline",
    );
  });
  await check(
    "offline inventory persists and reauthentication restores online",
    async () => {
      const view = await request(
        `workspaces/${workspaceId}/devices`,
        undefined,
        owner.cookie,
      );
      const offline = view.body.find((d) => d.id === paired.deviceId);
      assert.equal(offline.interfaces.length, 1);
      assert.equal(offline.status, "offline");
      agent = await socket();
      const next = message(agent);
      agent.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: paired.token,
          inventory,
        }),
      );
      ready = await next;
      assert.equal(ready.type, "ready");
    },
  );
  await check(
    "new session replaces old and old close cannot mark new session offline",
    async () => {
      const old = agent;
      const closed = once(old, "close");
      agent = await socket();
      const next = message(agent);
      agent.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: paired.token,
          inventory,
        }),
      );
      ready = await next;
      assert.equal((await closed)[0], 4001);
      await sleep(150);
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/devices`,
            undefined,
            owner.cookie,
          )
        ).body.find((d) => d.id === paired.deviceId).status,
        "online",
      );
    },
  );
  await check("unknown commands are rejected without execution", async () => {
    const closed = once(agent, "close");
    agent.send(
      JSON.stringify({ type: "shell", version: 1, command: "whoami" }),
    );
    assert.equal((await closed)[0], 1008);
  });
  await check("rotation revokes the old credential atomically", async () => {
    const rotated = await request("agent/rotate", {}, null, {
      Authorization: `Bearer ${paired.token}`,
    });
    assert.equal(rotated.status, 200);
    assert.equal(
      (
        await request("agent/rotate", {}, null, {
          Authorization: `Bearer ${paired.token}`,
        })
      ).status,
      401,
    );
    paired.token = rotated.body.token;
    agent = await socket();
    const next = message(agent);
    agent.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        token: paired.token,
        inventory,
      }),
    );
    ready = await next;
    assert.equal(ready.type, "ready");
  });
  await check(
    "revocation closes connections and preserves inventory",
    async () => {
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/devices/${paired.deviceId}/revoke`,
            {},
            other.cookie,
          )
        ).status,
        403,
      );
      const closed = once(agent, "close");
      assert.equal(
        (
          await request(
            `workspaces/${workspaceId}/devices/${paired.deviceId}/revoke`,
            {},
            owner.cookie,
          )
        ).status,
        200,
      );
      await closed;
      const view = await request(
        `workspaces/${workspaceId}/devices`,
        undefined,
        owner.cookie,
      );
      assert.equal(
        view.body.find((d) => d.id === paired.deviceId).interfaces.length,
        1,
      );
      const rejected = await socket();
      const close = once(rejected, "close");
      rejected.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: paired.token,
          inventory,
        }),
      );
      assert.equal((await close)[0], 1008);
      const audits = await request(
        `workspaces/${workspaceId}/history`,
        undefined,
        owner.cookie,
      );
      assert.ok(audits.body.some((a) => a.action === "device.revoked"));
      const credentials = await db.query(
        'SELECT "tokenHash" FROM "Credential" WHERE "deviceId" = $1',
        [paired.deviceId],
      );
      assert.ok(
        credentials.rows.every(
          (c) => c.tokenHash.length === 64 && c.tokenHash !== paired.token,
        ),
      );
    },
  );
  await check(
    "heartbeat timeout marks offline without removing interfaces",
    async () => {
      const quiet = await pair(owner.cookie, workspaceId, "Silent PC");
      const ws = await socket();
      const next = message(ws);
      ws.send(
        JSON.stringify({
          type: "auth",
          version: 1,
          token: quiet.token,
          inventory,
        }),
      );
      await next;
      await until(
        async () =>
          (
            await request(
              `workspaces/${workspaceId}/devices`,
              undefined,
              owner.cookie,
            )
          ).body.find((d) => d.id === quiet.deviceId).status === "offline",
        25000,
      );
      const persisted = await db.query(
        'SELECT COUNT(*)::int AS count FROM "NetworkInterface" WHERE "deviceId" = $1',
        [quiet.deviceId],
      );
      assert.equal(persisted.rows[0].count, 1);
    },
  );
  if (process.argv.includes("--relays")) {
    const { relayCases } = await import("./relay-cases.mjs");
    await relayCases({
      request,
      socket,
      message,
      until,
      check,
      owner,
      other,
      workspaceId,
      baseInventory: inventory,
      restartServer,
    });
  }
  if (process.argv.includes("--native")) {
    assert.equal(
      process.platform,
      "win32",
      "Native Windows validation must run on Windows",
    );
    const binary = fileURLToPath(
      new URL("../.local/windows/wakebridge.exe", import.meta.url),
    );
    assert.ok(existsSync(binary), "Build the native Windows agent first");
    nativeDirectory = mkdtempSync(
      path.join(tmpdir(), "wakebridge-native-test-"),
    );
    let output = "";
    let nativeDeviceId;
    await check(
      "native Go executable pairs, protects credentials and reports actual hardware",
      async () => {
        native = spawn(
          binary,
          [
            "pair",
            "--server",
            base,
            "--name",
            "Native Windows integration",
            "--config-dir",
            nativeDirectory,
            "--lan",
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        native.stdout.on("data", (d) => {
          output += d;
        });
        native.stderr.on("data", () => {});
        await until(
          async () => /Pairing code: (\d{4}-\d{4})/.test(output),
          10000,
        );
        const code = output.match(/Pairing code: (\d{4}-\d{4})/)[1];
        assert.equal(
          (
            await request(
              `workspaces/${workspaceId}/pairing/approve`,
              { code },
              owner.cookie,
            )
          ).status,
          200,
        );
        await until(async () => {
          const data = (
            await request(
              `workspaces/${workspaceId}/devices`,
              undefined,
              owner.cookie,
            )
          ).body;
          const found = data.find(
            (d) => d.name === "Native Windows integration",
          );
          if (!found || found.status !== "online") return false;
          nativeDeviceId = found.id;
          assert.ok(Number(found.memoryBytes) > 0);
          assert.ok(found.hostname);
          assert.ok(found.interfaces.length > 0);
          assert.ok(found.interfaces.every((n) => n.wolSupport === "unknown"));
          return true;
        }, 12000);
        const raw = readFileSync(path.join(nativeDirectory, "agent.dpapi"));
        assert.equal(raw.includes(Buffer.from("wb_agent_")), false);
      },
    );
    await check(
      "native process termination leaves hardware inventory offline",
      async () => {
        native.kill();
        await once(native, "exit");
        await until(async () => {
          const found = (
            await request(
              `workspaces/${workspaceId}/devices`,
              undefined,
              owner.cookie,
            )
          ).body.find((d) => d.id === nativeDeviceId);
          assert.ok(found.interfaces.length);
          return found.status === "offline";
        });
      },
    );
    await check(
      "native process restarts using DPAPI identity and reconnects as the same device",
      async () => {
        native = spawn(binary, ["run", "--config-dir", nativeDirectory], {
          windowsHide: true,
          stdio: "ignore",
        });
        await until(async () => {
          const list = (
            await request(
              `workspaces/${workspaceId}/devices`,
              undefined,
              owner.cookie,
            )
          ).body;
          assert.equal(
            list.filter((d) => d.name === "Native Windows integration").length,
            1,
          );
          return list.find((d) => d.id === nativeDeviceId).status === "online";
        }, 10000);
      },
    );
  }
  if (process.argv.includes("--native")) {
    const nativeDevice = (
      await request(
        `workspaces/${workspaceId}/devices`,
        undefined,
        owner.cookie,
      )
    ).body.find((d) => d.name === "Native Windows integration");
    const { nativeWakeCase } = await import("./native-wake-case.mjs");
    await nativeWakeCase({
      request,
      socket,
      message,
      until,
      check,
      owner,
      workspaceId,
      nativeDeviceId: nativeDevice.id,
      inventory,
    });
  }
  console.log(
    `${checks} integration groups passed against an isolated PostgreSQL database and real NestJS/WebSocket server.`,
  );
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  if (native && native.exitCode === null) {
    native.kill();
    await Promise.race([once(native, "exit"), sleep(3000)]);
  }
  if (
    nativeDirectory &&
    path.basename(nativeDirectory).startsWith("wakebridge-native-test-") &&
    path.dirname(nativeDirectory) === tmpdir()
  )
    rmSync(nativeDirectory, { recursive: true, force: true });
  for (const ws of sockets) ws.terminate();
  if (server) {
    server.kill();
    await Promise.race([once(server, "exit"), sleep(5000)]);
  }
  await db.end();
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
    [dbName],
  );
  await admin.query(`DROP DATABASE "${dbName}"`);
  await admin.end();
}

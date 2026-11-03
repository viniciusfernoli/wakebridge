// HTTP/proxy smoke only. This does not claim browser rendering or interaction coverage.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
require("dotenv").config({
  path: new URL("../.env", import.meta.url),
  quiet: true,
});
const { Client } = require("pg");
const { WebSocket } = require("ws");
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
assert.ok(
  new URL(origin).hostname === "localhost",
  "This smoke is restricted to localhost development",
);
const base = process.env.SMOKE_BASE ?? origin;
assert.ok(
  ["localhost", "caddy"].includes(new URL(base).hostname),
  "Only local development/review transports are allowed",
);
const suffix = randomBytes(8).toString("hex");
let userId;
let workspaceId;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let viewer;
try {
  const health = await fetch(base + "/api/health");
  assert.equal(health.status, 200);
  assert.match(health.headers.get("cache-control"), /no-store/);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /WakeBridge/);
  const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons)
    assert.equal((await fetch(base + icon.src)).status, 200);
  assert.equal((await fetch(base + "/downloads/wakebridge.exe")).status, 200);
  const register = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Proxy smoke",
      email: `proxy-${suffix}@example.test`,
      password: randomBytes(24).toString("base64url"),
      workspaceName: "Proxy smoke test",
    }),
  });
  assert.equal(register.status, 201);
  userId = (await register.json()).id;
  const cookie = register.headers.get("set-cookie").split(";")[0];
  const me = await (
    await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } })
  ).json();
  workspaceId = me.workspaces[0].id;
  viewer = new WebSocket(base.replace("http", "ws") + "/api/events", {
    headers: { Cookie: cookie, Origin: origin },
  });
  const ready = once(viewer, "message");
  await once(viewer, "open");
  assert.equal(JSON.parse((await ready)[0].toString()).type, "ready");
  viewer.close();
  const logout = await fetch(base + "/api/auth/logout", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await fetch(base + "/api/auth/me", { headers: { Cookie: cookie } }))
      .status,
    401,
  );
  console.log(
    "PASS HTTP, authenticated routing, cookie logout, WebSocket upgrade, PWA assets and native download. Visual browser QA remains pending.",
  );
} finally {
  viewer?.terminate();
  // Only the identifiers created by this run, with the random test email guard, can be deleted.
  if (userId) {
    const result = await db.query(
      'DELETE FROM "User" WHERE id=$1 AND email=$2 RETURNING id',
      [userId, `proxy-${suffix}@example.test`],
    );
    if (result.rowCount === 1 && workspaceId)
      await db.query(
        "DELETE FROM \"Workspace\" WHERE id=$1 AND name='Proxy smoke test'",
        [workspaceId],
      );
  }
  await db.end();
}

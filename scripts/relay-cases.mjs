import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export async function relayCases({
  request,
  socket,
  message,
  until,
  check,
  owner,
  other,
  workspaceId,
  baseInventory,
  restartServer,
}) {
  const sims = [];
  const peers = new Map();
  const pending = [];
  let complete = false;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const apiPath = `workspaces/${workspaceId}`;
  const list = async () =>
    (await request(`${apiPath}/devices`, undefined, owner.cookie)).body;
  const operations = async () =>
    (await request(`${apiPath}/operations`, undefined, owner.cookie)).body;
  const operation = async (id) => (await operations()).find((o) => o.id === id);
  async function enroll(name, platform = "windows") {
    const start = await request("pairing/start", { name, platform });
    assert.equal(start.status, 201);
    assert.equal(
      (
        await request(
          `${apiPath}/pairing/approve`,
          { code: start.body.code },
          owner.cookie,
        )
      ).status,
      200,
    );
    const claim = await request("pairing/claim", {
      pairingId: start.body.pairingId,
      secret: start.body.secret,
    });
    assert.equal(claim.status, 200);
    return claim.body;
  }
  async function simulator(name, platform, address, mac) {
    const identity = await enroll(name, platform);
    const inv = {
      ...baseInventory,
      hostname: name,
      osVersion: `${platform} protocol simulator`,
      agentVersion: "0.2.0",
      lanEnabled: true,
      networkEpoch: digest(name),
      capabilities: ["inventory", "wol", "discovery"],
      interfaces: [
        {
          ...baseInventory.interfaces[0],
          nativeId: `iface-${name}`,
          mac,
          addresses: [
            { address, prefixLength: 24, broadcast: "192.168.7.255" },
          ],
        },
      ],
    };
    const sim = {
      identity,
      inv,
      seq: 0,
      ws: null,
      session: null,
      beat: null,
      behaviour: "packet_sent",
      held: [],
      commands: [],
    };
    sim.send = (body) =>
      sim.ws.send(
        JSON.stringify({
          ...body,
          version: 2,
          sessionId: sim.session,
          seq: ++sim.seq,
        }),
      );
    sim.result = (command, status, reason) =>
      sim.send({
        type: "command.result",
        commandId: command.commandId,
        status,
        reason,
      });
    sim.close = () => {
      clearInterval(sim.beat);
      sim.ws?.close();
    };
    sim.connect = async () => {
      sim.seq = 0;
      sim.ws = await socket();
      sim.ws.on("message", async (raw) => {
        const command = JSON.parse(raw.toString());
        if (command.type !== "command") return;
        sim.commands.push(command);
        if (command.action === "probe.listen") {
          peers.set(command.commandId, { sim, payload: command.payload });
          sim.send({ type: "probe.ready", ticketId: command.commandId });
        }
        if (command.action === "probe.send") {
          const listener = peers.get(command.commandId);
          assert.ok(listener);
          assert.equal(listener.payload.secret, command.payload.secret);
          const nonce = randomBytes(16).toString("hex"),
            responseNonce = randomBytes(16).toString("hex");
          const value = `wakebridge|2|${command.commandId}|${listener.sim.identity.deviceId}|${sim.identity.deviceId}|${nonce}|${responseNonce}|reply`;
          const signature = createHmac(
            "sha256",
            Buffer.from(command.payload.secret, "base64url"),
          )
            .update(value)
            .digest("hex");
          const proof = {
            type: "probe.proof",
            ticketId: command.commandId,
            nonce,
            responseNonce,
            signature,
          };
          sim.send(proof);
          if (complete) listener.sim.send(proof);
          else pending.push(() => listener.sim.send(proof));
        }
        if (command.action === "wake") {
          if (sim.behaviour === "hold") sim.held.push(command);
          else if (sim.behaviour === "failed")
            sim.result(command, "failed", "udp_failed");
          else sim.result(command, "packet_sent", "udp_sent");
        }
      });
      const ready = message(sim.ws);
      sim.ws.send(
        JSON.stringify({
          type: "auth",
          version: 2,
          token: identity.token,
          inventory: inv,
        }),
      );
      const response = await ready;
      assert.equal(response.type, "ready");
      sim.session = response.sessionId;
      sim.beat = setInterval(() => {
        if (sim.ws.readyState === 1) sim.send({ type: "heartbeat" });
      }, 2500);
    };
    await sim.connect();
    sims.push(sim);
    return sim;
  }
  try {
    let android, windows, target;
    await check(
      "Android and Windows relay identities pair with explicit LAN capabilities",
      async () => {
        android = await simulator(
          "Android relay",
          "android",
          "192.168.7.10",
          null,
        );
        windows = await simulator(
          "Windows relay",
          "windows",
          "192.168.7.11",
          "02:00:00:00:00:11",
        );
        target = await simulator(
          "Wake target",
          "windows",
          "192.168.7.20",
          "02:00:00:00:00:20",
        );
        for (const [sim, priority] of [
          [android, 10],
          [windows, 5],
          [target, 0],
        ])
          assert.equal(
            (
              await request(
                `${apiPath}/devices/${sim.identity.deviceId}/relay-policy`,
                { approved: true, priority },
                owner.cookie,
              )
            ).status,
            200,
          );
      },
    );
    await check(
      "one-sided local proof cannot create a relay association",
      async () => {
        await request(`${apiPath}/discovery`, {}, owner.cookie);
        await until(async () => pending.length >= 2);
        const options = await request(
          `${apiPath}/devices/${target.identity.deviceId}/relays`,
          undefined,
          owner.cookie,
        );
        assert.equal(options.body.length, 0);
      },
    );
    await check(
      "matching independent authenticated transcripts establish LAN groups and two relay types",
      async () => {
        complete = true;
        for (const publish of pending) publish();
        pending.length = 0;
        await until(
          async () =>
            (
              await request(
                `${apiPath}/devices/${target.identity.deviceId}/relays`,
                undefined,
                owner.cookie,
              )
            ).body.length === 2,
        );
        const options = (
          await request(
            `${apiPath}/devices/${target.identity.deviceId}/relays`,
            undefined,
            owner.cookie,
          )
        ).body;
        assert.ok(
          options.every(
            (l) =>
              l.evidence === "AUTHENTICATED" && l.unavailableReason === null,
          ),
        );
        assert.deepEqual(
          new Set(options.map((l) => l.relay.platform)),
          new Set(["windows", "android"]),
        );
        const networks = (
          await request(`${apiPath}/networks`, undefined, owner.cookie)
        ).body;
        assert.equal(networks.domains.length, 1);
        assert.equal(networks.domains[0].members.length, 3);
      },
    );
    await check(
      "wake authorization, idempotency, relay failover and connection-bound results",
      async () => {
        target.close();
        await until(
          async () =>
            (await list()).find((d) => d.id === target.identity.deviceId)
              .status === "offline",
        );
        android.behaviour = "failed";
        windows.behaviour = "hold";
        const body = { idempotencyKey: randomUUID() };
        assert.equal(
          (
            await request(
              `${apiPath}/devices/${target.identity.deviceId}/wake`,
              body,
              other.cookie,
            )
          ).status,
          403,
        );
        const started = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          body,
          owner.cookie,
        );
        assert.equal(started.status, 200);
        const id = started.body.id;
        await until(async () => windows.held.length === 1);
        const held = windows.held.shift();
        android.result(held, "packet_sent", "udp_sent");
        await new Promise((r) => setTimeout(r, 150));
        const before = await operation(id);
        assert.equal(before.state, "SENT");
        assert.equal(before.attempts.length, 2);
        assert.equal(before.attempts[1].state, "SENT");
        assert.equal(before.attempts[0].relayId, android.identity.deviceId);
        windows.result(held, "packet_sent", "udp_sent");
        await until(async () => (await operation(id)).state === "WAITING");
        const duplicate = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          body,
          owner.cookie,
        );
        assert.equal(duplicate.body.id, id);
        const concurrent = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          { idempotencyKey: randomUUID() },
          owner.cookie,
        );
        assert.equal(concurrent.body.id, id);
        assert.notEqual((await operation(id)).state, "ONLINE");
        await target.connect();
        await until(async () => (await operation(id)).state === "ONLINE");
        const persisted = await operation(id);
        assert.equal(persisted.reason, "agent_reconnected");
        assert.equal(persisted.attempts[1].payload.mac, "02:00:00:00:00:20");
      },
    );
    await check(
      "packet dispatch without target return ends unconfirmed, never online",
      async () => {
        target.close();
        await until(
          async () =>
            (await list()).find((d) => d.id === target.identity.deviceId)
              .status === "offline",
        );
        windows.behaviour = "packet_sent";
        const response = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          { idempotencyKey: randomUUID() },
          owner.cookie,
        );
        await until(
          async () =>
            (await operation(response.body.id)).state === "UNCONFIRMED",
          8500,
        );
        assert.equal(
          (await operation(response.body.id)).reason,
          "boot_not_observed",
        );
          await target.connect();
          assert.equal((await operation(response.body.id)).state, "UNCONFIRMED");
          target.close();
          await until(async()=>(await list()).find(d=>d.id===target.identity.deviceId).status==='offline');
      },
    );
    await check(
      "changed network epochs invalidate old associations",
      async () => {
        for (const sim of [android, windows]) {
          sim.inv.networkEpoch = digest(sim.identity.deviceId + "changed");
          sim.send({ type: "inventory", inventory: sim.inv });
        }
        await until(async () =>
          (
            await request(
              `${apiPath}/devices/${target.identity.deviceId}/relays`,
              undefined,
              owner.cookie,
            )
          ).body.every((l) => l.unavailableReason === "network_changed"),
        );
        const response = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          { idempotencyKey: randomUUID() },
          owner.cookie,
        );
        assert.equal(response.body.state, "FAILED");
        assert.equal(response.body.reason, "no_eligible_relay");
      },
    );
    await check(
      "manual same-LAN consent is labeled and relay test confirms only packet emission",
      async () => {
        const devices = await list();
        const source = devices.find((d) => d.id === android.identity.deviceId);
        const dest = devices.find((d) => d.id === target.identity.deviceId);
        const body = {
          relayId: source.id,
          relayInterfaceId: source.interfaces[0].id,
          targetInterfaceId: dest.interfaces[0].id,
          confirmSameLan: true,
        };
        assert.equal(
          (
            await request(
              `${apiPath}/devices/${dest.id}/manual-relay`,
              { ...body, confirmSameLan: false },
              owner.cookie,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request(
              `${apiPath}/devices/${dest.id}/manual-relay`,
              body,
              owner.cookie,
            )
          ).status,
          200,
        );
        const links = (
          await request(
            `${apiPath}/devices/${dest.id}/relays`,
            undefined,
            owner.cookie,
          )
        ).body;
        const link = links.find((l) => l.relayId === source.id);
        assert.equal(link.evidence, "MANUAL");
        assert.equal(link.unavailableReason, null);
        android.behaviour = "packet_sent";
        const test = await request(
          `${apiPath}/devices/${dest.id}/relay-test`,
          { idempotencyKey: randomUUID(), linkId: link.id },
          owner.cookie,
        );
        await until(
          async () => (await operation(test.body.id)).state === "EXECUTED",
        );
        assert.equal(
          (await operation(test.body.id)).reason,
          "packet_sent_only",
        );
      },
    );
    await check(
      "API restart preserves operation and fences an ambiguous old-session result",
      async () => {
        android.behaviour = "hold";
        const response = await request(
          `${apiPath}/devices/${target.identity.deviceId}/wake`,
          { idempotencyKey: randomUUID() },
          owner.cookie,
        );
        await until(async () => android.held.length > 0);
        const command = android.held.shift();
        const original = await operation(response.body.id);
        assert.equal(original.attempts[0].state, "SENT");
        for (const sim of [android, windows]) sim.close();
        await restartServer();
        await android.connect();
        android.result(command, "packet_sent", "udp_sent");
        const persisted = await operation(response.body.id);
        assert.equal(persisted.attempts[0].state, "UNCERTAIN");
        assert.equal(persisted.attempts[0].reason, "server_restart");
        assert.notEqual(persisted.state, "ONLINE");
        assert.equal(
          android.commands.filter((c) => c.commandId === command.commandId)
            .length,
          1,
        );
      },
    );
  } finally {
    for (const sim of sims) sim.close();
  }
}

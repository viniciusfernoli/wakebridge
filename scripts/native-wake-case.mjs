import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import dgram from "node:dgram";
export async function nativeWakeCase({
  request,
  socket,
  message,
  until,
  check,
  owner,
  workspaceId,
  nativeDeviceId,
  inventory,
}) {
  const base = `workspaces/${workspaceId}`;
  let targetSocket;
  let capture;
  try {
    await check(
      "native Windows relay executes a real UDP wake command; only target reconnection confirms online",
      async () => {
        const native = (
          await request(`${base}/devices`, undefined, owner.cookie)
        ).body.find((d) => d.id === nativeDeviceId);
        assert.equal(native.lanEnabled, true);
        const network = native.interfaces.find(
          (n) =>
            n.present &&
            n.isUp &&
            n.addresses.some(
              (a) =>
                a.prefixLength >= 1 &&
                a.prefixLength <= 30 &&
                a.broadcast &&
                /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address),
            ),
        );
        assert.ok(
          network,
          "Native test requires a directly connected private IPv4 interface",
        );
        const address = network.addresses.find(
          (a) => a.broadcast && a.prefixLength >= 1 && a.prefixLength <= 30,
        );
        const n = address.address
          .split(".")
          .reduce((sum, p) => ((sum << 8) | +p) >>> 0, 0);
        const mask = (0xffffffff << (32 - address.prefixLength)) >>> 0;
        const networkNumber = (n & mask) >>> 0;
        const destination =
          (networkNumber + (n - networkNumber === 1 ? 2 : 1)) >>> 0;
        const targetAddress = [24, 16, 8, 0]
          .map((s) => (destination >>> s) & 255)
          .join(".");
        const mac =
          "02:" +
          randomBytes(5).toString("hex").match(/../g).join(":").toUpperCase();
        const started = await request("pairing/start", {
          name: "Native wake target (simulated boot)",
          platform: "windows",
        });
        assert.equal(started.status, 201);
        assert.equal(
          (
            await request(
              `${base}/pairing/approve`,
              { code: started.body.code },
              owner.cookie,
            )
          ).status,
          200,
        );
        const target = (
          await request("pairing/claim", {
            pairingId: started.body.pairingId,
            secret: started.body.secret,
          })
        ).body;
        const targetInventory = {
          ...inventory,
          hostname: "simulated-boot-target",
          agentVersion: "0.2.0",
          lanEnabled: false,
          networkEpoch: createHash("sha256")
            .update(target.deviceId)
            .digest("hex"),
          interfaces: [
            {
              ...inventory.interfaces[0],
              nativeId: "native-test-target",
              mac,
              addresses: [
                {
                  address: targetAddress,
                  prefixLength: address.prefixLength,
                  broadcast: address.broadcast,
                },
              ],
            },
          ],
        };
        async function connectTarget() {
          targetSocket = await socket();
          const ready = message(targetSocket);
          targetSocket.send(
            JSON.stringify({
              type: "auth",
              version: 2,
              token: target.token,
              inventory: targetInventory,
            }),
          );
          await ready;
        }
        await connectTarget();
        const dest = (
          await request(`${base}/devices`, undefined, owner.cookie)
        ).body.find((d) => d.id === target.deviceId);
        assert.equal(
          (
            await request(
              `${base}/devices/${nativeDeviceId}/relay-policy`,
              { approved: true, priority: 10 },
              owner.cookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await request(
              `${base}/devices/${target.deviceId}/manual-relay`,
              {
                relayId: nativeDeviceId,
                relayInterfaceId: network.id,
                targetInterfaceId: dest.interfaces[0].id,
                confirmSameLan: true,
              },
              owner.cookie,
            )
          ).status,
          200,
        );
        targetSocket.close();
        await until(
          async () =>
            (
              await request(`${base}/devices`, undefined, owner.cookie)
            ).body.find((d) => d.id === target.deviceId).status === "offline",
        );
        let received = false;
        capture = dgram.createSocket("udp4");
        capture.on("message", (bytes) => {
          const expected = Buffer.from(mac.replaceAll(":", ""), "hex");
          if (
            bytes.length === 102 &&
            bytes.subarray(0, 6).equals(Buffer.alloc(6, 255)) &&
            bytes.subarray(6, 12).equals(expected)
          )
            received = true;
        });
        await new Promise((resolve) => {
          capture.once("error", resolve);
          capture.bind(9, "0.0.0.0", resolve);
        });
        const operation = (
          await request(
            `${base}/devices/${target.deviceId}/wake`,
            { idempotencyKey: randomUUID() },
            owner.cookie,
          )
        ).body;
        let current;
        await until(async () => {
          current = (
            await request(`${base}/operations`, undefined, owner.cookie)
          ).body.find((o) => o.id === operation.id);
          return current.attempts.some((a) => a.state === "PACKET_SENT");
        }, 8000);
        assert.equal(current.state, "WAITING");
        assert.equal(current.attempts[0].relayId, nativeDeviceId);
        assert.equal(current.attempts[0].reason, "udp_sent");
        console.log(
          received
            ? "PASS exact native Magic Packet captured from actual UDP broadcast"
            : "INFO Native OS reported successful UDP emission; physical delivery is not asserted.",
        );
        await connectTarget();
        await until(
          async () =>
            (
              await request(`${base}/operations`, undefined, owner.cookie)
            ).body.find((o) => o.id === operation.id).state === "ONLINE",
        );
      },
    );
  } finally {
    targetSocket?.close();
    if (capture) {
      try {
        capture.close();
      } catch {
        /* bind may have failed because port 9 was already in use */
      }
    }
  }
}

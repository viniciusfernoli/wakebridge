import { test } from "node:test";
import assert from "node:assert/strict";
import { agentMessageSchema, inventorySchema } from "@wakebridge/shared";
const inventory = {
  hostname: "test",
  osVersion: "Windows 11",
  architecture: "amd64",
  agentVersion: "0.1.0",
  cpu: "test",
  memoryBytes: 1024,
  capabilities: ["inventory"],
  interfaces: [
    {
      nativeId: "eth0",
      name: "Ethernet",
      mac: "01:23:45:67:89:ab",
      addresses: [
        {
          address: "192.168.1.10",
          prefixLength: 24,
          broadcast: "192.168.1.255",
        },
      ],
      isUp: true,
      wolSupport: "unknown",
    },
  ],
};
test("inventory validates and canonicalizes MACs", () => {
  assert.equal(
    inventorySchema.parse(inventory).interfaces[0].mac,
    "01:23:45:67:89:AB",
  );
});
test("no shell, extra authority fields or future versions are accepted", () => {
  assert.equal(
    agentMessageSchema.safeParse({ type: "shell", command: "whoami" }).success,
    false,
  );
  assert.equal(
    inventorySchema.safeParse({ ...inventory, workspaceId: "other" }).success,
    false,
  );
  assert.equal(
    agentMessageSchema.safeParse({
      type: "auth",
      version: 3,
      token: "x".repeat(50),
      inventory,
    }).success,
    false,
  );
});
test("rejects unsafe interface and heartbeat input", () => {
  const malformed = structuredClone(inventory);
  malformed.interfaces[0].addresses[0].address = "999.1.1.1";
  assert.equal(inventorySchema.safeParse(malformed).success, false);
  assert.equal(
    agentMessageSchema.safeParse({
      type: "heartbeat",
      version: 1,
      sessionId: "not-a-uuid",
      seq: -1,
    }).success,
    false,
  );
});

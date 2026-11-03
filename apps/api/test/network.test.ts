import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directedBroadcast,
  isPrivate,
  sameSubnet,
  validMac,
  signature,
  verifySignature,
  transcript,
} from "../src/network";
test("WoL subnet validation never assumes routed broadcast", () => {
  assert.equal(directedBroadcast("192.168.7.10", 24), "192.168.7.255");
  assert.equal(sameSubnet("192.168.7.10", "192.168.8.10", 24), false);
  assert.equal(isPrivate("8.8.8.8"), false);
  assert.equal(isPrivate("172.16.1.5"), true);
  assert.throws(() => directedBroadcast("10.0.0.1", 32));
});
test("MAC validation rejects multicast and all-zero identities", () => {
  assert.equal(validMac("02:11:22:33:44:55"), true);
  assert.equal(validMac("FF:FF:FF:FF:FF:FF"), false);
  assert.equal(validMac("00:00:00:00:00:00"), false);
});
test("discovery transcripts bind pair, ticket, nonce and direction", () => {
  const secret = Buffer.alloc(32).toString("base64url");
  const message = transcript(
    "ticket",
    "from",
    "to",
    "nonce",
    "response",
    "reply",
  );
  const proof = signature(secret, message);
  assert.ok(verifySignature(secret, message, proof));
  assert.equal(
    verifySignature(
      secret,
      transcript("ticket", "to", "from", "nonce", "response", "reply"),
      proof,
    ),
    false,
  );
  assert.equal(verifySignature(secret, message, "aa"), false);
});

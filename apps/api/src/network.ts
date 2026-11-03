import { createHmac, timingSafeEqual } from "node:crypto";
export function ipNumber(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || +p > 255))
    throw new Error("Invalid IPv4");
  return parts.reduce((value, p) => ((value << 8) | +p) >>> 0, 0);
}
export function isPrivate(ip: string) {
  const n = ipNumber(ip);
  return n >>> 24 === 10 || n >>> 20 === 0xac1 || n >>> 16 === 0xc0a8;
}
export function directedBroadcast(ip: string, prefix: number) {
  if (prefix < 1 || prefix > 30) throw new Error("No broadcast subnet");
  const n = (ipNumber(ip) | (0xffffffff >>> prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}
export function sameSubnet(a: string, b: string, prefix: number) {
  return (
    prefix >= 1 &&
    prefix <= 30 &&
    ipNumber(a) >>> (32 - prefix) === ipNumber(b) >>> (32 - prefix)
  );
}
export function validMac(mac: string) {
  return (
    /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) &&
    mac !== "00:00:00:00:00:00" &&
    (parseInt(mac.slice(0, 2), 16) & 1) === 0
  );
}
export function transcript(
  ticket: string,
  from: string,
  to: string,
  nonce: string,
  responseNonce: string,
  kind: string,
) {
  return `wakebridge|2|${ticket}|${from}|${to}|${nonce}|${responseNonce}|${kind}`;
}
export function signature(secret: string, value: string) {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value)
    .digest("hex");
}
export function verifySignature(secret: string, value: string, proof: string) {
  const expected = Buffer.from(signature(secret, value), "hex");
  const actual = Buffer.from(proof, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

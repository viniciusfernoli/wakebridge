import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const COMMAND_PROTOCOL_VERSION = 2 as const;
export const AGENT_VERSION = "0.2.0";
const text = z.string().trim().min(1).max(200);
const ipv4 = z.string().refine((s) => {
  const p = s.split(".");
  return (
    p.length === 4 && p.every((n) => /^\d{1,3}$/.test(n) && Number(n) <= 255)
  );
}, "Invalid IPv4 address");
export const networkInterfaceSchema = z
  .object({
    nativeId: text,
    name: text,
    mac: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/)
      .transform((s) => s.toUpperCase())
      .nullable(),
    addresses: z
      .array(
        z
          .object({
            address: ipv4,
            prefixLength: z.number().int().min(0).max(32),
            broadcast: ipv4.nullable(),
          })
          .strict(),
      )
      .max(16),
    isUp: z.boolean(),
    wolSupport: z.enum(["unknown", "candidate"]),
  })
  .strict();
export const inventorySchema = z
  .object({
    hostname: text,
    osVersion: text,
    architecture: text,
    agentVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    cpu: text,
    memoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capabilities: z.array(z.enum(["inventory", "wol", "discovery"])).max(3),
    lanEnabled: z.boolean().optional(),
    networkEpoch: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    interfaces: z.array(networkInterfaceSchema).max(32),
  })
  .strict();
export const agentMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("auth"),
      version: z.union([z.literal(1), z.literal(2)]),
      token: z.string().min(40).max(128),
      inventory: inventorySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      version: z.union([z.literal(1), z.literal(2)]),
      sessionId: z.string().uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      type: z.literal("inventory"),
      version: z.union([z.literal(1), z.literal(2)]),
      sessionId: z.string().uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      inventory: inventorySchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("command.result"),
      version: z.literal(2),
      sessionId: z.string().uuid(),
      seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      commandId: z.string().uuid(),
      status: z.enum(["packet_sent", "failed"]),
      reason: z.enum([
        "udp_sent",
        "not_authorized",
        "expired",
        "duplicate",
        "invalid_payload",
        "interface_changed",
        "network_unavailable",
        "udp_failed",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("probe.ready"),
      version: z.literal(2),
      sessionId: z.string().uuid(),
      seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ticketId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("probe.proof"),
      version: z.literal(2),
      sessionId: z.string().uuid(),
      seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ticketId: z.string().uuid(),
      nonce: z.string().regex(/^[a-f0-9]{32}$/),
      responseNonce: z.string().regex(/^[a-f0-9]{32}$/),
      signature: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export const wolPayloadSchema = z
  .object({
    localInterfaceId: text,
    localAddress: ipv4,
    networkEpoch: z.string().regex(/^[a-f0-9]{64}$/),
    targetAddress: ipv4,
    prefixLength: z.number().int().min(1).max(30),
    broadcast: ipv4,
    mac: z.string().regex(/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/),
  })
  .strict();
export type WolPayload = z.infer<typeof wolPayloadSchema>;
export const commandSchema = z
  .object({
    type: z.literal("command"),
    version: z.literal(2),
    commandId: z.string().uuid(),
    operationId: z.string().uuid().optional(),
    sessionId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
    action: z.literal("wake"),
    payload: wolPayloadSchema,
  })
  .strict();
export type Inventory = z.infer<typeof inventorySchema>;
export type DeviceView = {
  id: string;
  name: string;
  platform: string;
  hostname: string | null;
  osVersion: string | null;
  architecture: string | null;
  agentVersion: string | null;
  cpu: string | null;
  memoryBytes: string | null;
  capabilities: string[];
  lanEnabled: boolean;
  relayApproved: boolean;
  relayPriority: number;
  status: "online" | "offline" | "never_seen";
  lastSeen: string | null;
  interfaces: {
    id: string;
    name: string;
    mac: string | null;
    addresses: {
      address: string;
      prefixLength: number;
      broadcast: string | null;
    }[];
    isUp: boolean;
    present: boolean;
    wolSupport: string;
  }[];
};

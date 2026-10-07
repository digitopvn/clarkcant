import { describe, expect, it } from "vitest";

import {
  CHANNEL_CONTRACT_VERSION,
  DEFAULT_CHANNEL_ATTENTION_POLICY,
  INGRESS_MODES,
  channelAttentionPolicySchema,
  channelBindingSchema,
  channelCapabilitiesSchema,
  channelEventSchema,
  channelIngressModeSchema,
  channelReplyRouteSchema,
  channelSourceId,
  ingressModeSchema,
  messageRecordSchema,
} from "../src/index.ts";

/**
 * The provider-neutral channel contracts: what an adapter hands the host, what a binding says, and where a reply goes.
 * Nothing in them is one provider's; a provider's own fields stay inside its adapter.
 */

const AT = "2026-10-07T09:00:00.000Z";

const message = {
  version: CHANNEL_CONTRACT_VERSION,
  kind: "message",
  eventId: "evt-1",
  occurredAt: AT,
  space: { externalSpaceId: "space-1", kind: "direct" },
  externalMessageId: "m-1",
  actor: { externalActorId: "u-1", displayName: "Lan" },
  content: { text: "hello", format: "plain" },
  mentionsClark: false,
} as const;

describe("ingress modes", () => {
  it("are one shared vocabulary, the channel one included", () => {
    expect(INGRESS_MODES).toEqual(["webhook", "poll", "long-poll", "stream", "gateway", "relay", "local-watch"]);
    expect(channelIngressModeSchema).toBe(ingressModeSchema);
    expect(ingressModeSchema.safeParse("smoke-signal").success).toBe(false);
  });
});

describe("a channel event", () => {
  it("parses a provider-neutral message", () => {
    expect(channelEventSchema.parse(message)).toEqual(message);
  });

  it("refuses a field one provider invented", () => {
    expect(channelEventSchema.safeParse({ ...message, telegramChatId: 42 }).success).toBe(false);
  });

  it("refuses empty text and a version it does not know", () => {
    expect(channelEventSchema.safeParse({ ...message, content: { text: "", format: "plain" } }).success).toBe(false);
    expect(channelEventSchema.safeParse({ ...message, version: 2 }).success).toBe(false);
  });
});

describe("capabilities", () => {
  it("require text and refuse an unknown flag", () => {
    expect(channelCapabilitiesSchema.safeParse({ text: true, threads: true, maxTextLength: 4096 }).success).toBe(true);
    expect(channelCapabilitiesSchema.safeParse({}).success).toBe(false);
    expect(channelCapabilitiesSchema.safeParse({ text: true, stickers: true }).success).toBe(false);
  });
});

describe("a binding", () => {
  const binding = {
    version: CHANNEL_CONTRACT_VERSION,
    bindingId: "chb_1",
    connectionRef: "conn_abc",
    provider: "fake-chat",
    providerAccountId: "bot-1",
    externalSpaceId: "space-1",
    spaceKind: "group",
    conversationId: "conv_1",
    audiencePolicy: { kind: "space" },
    attentionPolicy: {},
    grantRefs: [],
    state: "active",
    createdAt: AT,
    updatedAt: AT,
  };

  it("fills the attention defaults: mentions, replies and direct talk start a turn, other talk is context", () => {
    const parsed = channelBindingSchema.parse(binding);
    expect(parsed.attentionPolicy).toEqual(DEFAULT_CHANNEL_ATTENTION_POLICY);
    expect(DEFAULT_CHANNEL_ATTENTION_POLICY).toMatchObject({ direct: true, mention: true, everyMessage: false });
    expect(DEFAULT_CHANNEL_ATTENTION_POLICY).toEqual(channelAttentionPolicySchema.parse({}));
  });

  it("refuses a provider name that is not a plain slug and a connection ref without its prefix", () => {
    expect(channelBindingSchema.safeParse({ ...binding, provider: "Fake Chat" }).success).toBe(false);
    expect(channelBindingSchema.safeParse({ ...binding, connectionRef: "abc" }).success).toBe(false);
  });

  it("accepts a standing grant only as tool:<name>, so a typo is refused rather than granting nothing", () => {
    expect(channelBindingSchema.safeParse({ ...binding, grantRefs: ["tool:run_command"] }).success).toBe(true);
    expect(channelBindingSchema.safeParse({ ...binding, grantRefs: ["run_command"] }).success).toBe(false);
    expect(channelBindingSchema.safeParse({ ...binding, grantRefs: ["tool:Run Command"] }).success).toBe(false);
    expect(channelBindingSchema.safeParse({ ...binding, grantRefs: ["tool:*"] }).success).toBe(false);
  });

  it("bounds the burst window and the queue", () => {
    expect(channelBindingSchema.safeParse({ ...binding, attentionPolicy: { burstWindowMs: 120_000 } }).success).toBe(false);
    expect(channelBindingSchema.safeParse({ ...binding, attentionPolicy: { maxQueuedPerThread: 0 } }).success).toBe(false);
  });
});

describe("a reply route", () => {
  it("carries the address back and nothing secret", () => {
    const route = {
      version: CHANNEL_CONTRACT_VERSION,
      bindingId: "chb_1",
      address: { connectionRef: "conn_abc", externalSpaceId: "space-1", replyToExternalMessageId: "m-1" },
      inboundMessageId: "msg_1",
      actorPrincipalId: "prin_1",
    };
    expect(channelReplyRouteSchema.parse(route)).toEqual(route);
    expect(channelReplyRouteSchema.safeParse({ ...route, token: "secret" }).success).toBe(false);
  });

  it("names the intake source a connection's messages are recorded under", () => {
    expect(channelSourceId("conn_abc")).toBe("channel:conn_abc");
  });
});

describe("a stored message", () => {
  const record = {
    messageId: "msg_1",
    conversationId: "conv_1",
    role: "user",
    blocks: [{ type: "text", format: "plain", content: "hi", streaming: false }],
    authorNodeId: "node_1",
    createdAt: AT,
    delivery: "accepted",
  };

  it("may say who wrote it and what it answers, and still reads without either", () => {
    const parsed = messageRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    const authored = messageRecordSchema.parse({ ...record, authorPrincipalId: "prin_1", inReplyToMessageId: "msg_0", origin: "channel" });
    expect(authored).toMatchObject({ authorPrincipalId: "prin_1", inReplyToMessageId: "msg_0", origin: "channel" });
  });
});

import { describe, expect, it } from "vitest";

import {
  CHANNEL_CONTRACT_VERSION,
  CHANNEL_MESSAGE_TOPIC,
  type ChannelBinding,
  type ChannelEvent,
  DEFAULT_CHANNEL_ATTENTION_POLICY,
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type ExternalConnection,
  type Instant,
  type MessageBlock,
} from "@clarkcant/contracts";

import {
  type AttentionFacts,
  channelEventSignal,
  channelThreadKey,
  channelTurnData,
  coalescedTurnText,
  routeChannelEvent,
  splitChannelText,
} from "../src/channel-attention.ts";
import { decideChannelReply } from "../src/channel-delivery-policy.ts";
import { channelReplyText } from "../src/channel-reply-text.ts";

/**
 * The Attention Router decides from facts the host holds, the same way every time: Clark's own words never start
 * anything, an unbound space starts nothing, and in a bound group only talk that asks for Clark costs a turn.
 */

const AT = "2026-10-07T09:00:00.000Z" as Instant;

const connection: ExternalConnection = {
  version: CHANNEL_CONTRACT_VERSION,
  connectionRef: "conn_abc" as ExternalConnection["connectionRef"],
  provider: "fake-chat",
  providerAccountId: "bot-1",
  principalId: "prin_owner",
  ingressMode: "webhook",
  state: "connected",
  selfActorIds: ["bot-1"],
  createdAt: AT,
  updatedAt: AT,
};

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    version: CHANNEL_CONTRACT_VERSION,
    bindingId: "chb_1",
    connectionRef: connection.connectionRef,
    provider: "fake-chat",
    providerAccountId: "bot-1",
    externalSpaceId: "space-1",
    spaceKind: "group",
    conversationId: "conv_1",
    audiencePolicy: { kind: "space" },
    attentionPolicy: DEFAULT_CHANNEL_ATTENTION_POLICY,
    grantRefs: [],
    state: "active",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function event(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    version: CHANNEL_CONTRACT_VERSION,
    kind: "message",
    eventId: "evt-1",
    occurredAt: AT,
    space: { externalSpaceId: "space-1", kind: "group" },
    externalMessageId: "m-1",
    actor: { externalActorId: "u-1", displayName: "Lan" },
    content: { text: "hello", format: "plain" },
    mentionsClark: false,
    ...overrides,
  };
}

function facts(overrides: Partial<AttentionFacts> = {}): AttentionFacts {
  return {
    event: event(),
    connection,
    binding: binding(),
    actorPrincipalId: "prin_lan",
    sentByClark: false,
    repliesToClark: false,
    clarkInThread: false,
    ...overrides,
  };
}

describe("routing a channel message", () => {
  it("starts a turn for a direct message, a mention and a reply to Clark", () => {
    expect(routeChannelEvent(facts({ event: event({ space: { externalSpaceId: "space-1", kind: "direct" } }) }))).toEqual({
      route: "turn",
      because: "direct",
    });
    expect(routeChannelEvent(facts({ event: event({ mentionsClark: true }) }))).toEqual({ route: "turn", because: "mention" });
    expect(routeChannelEvent(facts({ repliesToClark: true }))).toEqual({ route: "turn", because: "reply-to-clark" });
  });

  it("keeps group talk that does not ask for Clark as context", () => {
    expect(routeChannelEvent(facts()).route).toBe("context");
  });

  it("follows a thread Clark already spoke in, but not a whole space without threads", () => {
    expect(routeChannelEvent(facts({ clarkInThread: true, event: event({ externalThreadId: "t-1" }) }))).toEqual({
      route: "turn",
      because: "participating-thread",
    });
    expect(routeChannelEvent(facts({ clarkInThread: true })).route).toBe("context");
  });

  it("answers every message only when the binding says so", () => {
    const chatty = binding({ attentionPolicy: { ...DEFAULT_CHANNEL_ATTENTION_POLICY, everyMessage: true } });
    expect(routeChannelEvent(facts({ binding: chatty }))).toEqual({ route: "turn", because: "every-message" });
  });

  it("never acts on Clark's own message, however it is recognized, even when it mentions Clark", () => {
    const loud = event({ mentionsClark: true, space: { externalSpaceId: "space-1", kind: "direct" } });
    expect(routeChannelEvent(facts({ event: loud, sentByClark: true })).route).toBe("ignore");
    expect(routeChannelEvent(facts({ event: { ...loud, selfAuthored: true } })).route).toBe("ignore");
    expect(routeChannelEvent(facts({ event: { ...loud, actor: { externalActorId: "bot-1" } } })).route).toBe("ignore");
  });

  it("starts nothing in an unbound space, a paused binding or a revoked connection", () => {
    const direct = event({ space: { externalSpaceId: "space-1", kind: "direct" } });
    expect(routeChannelEvent(facts({ event: direct, binding: undefined })).route).toBe("ignore");
    expect(routeChannelEvent(facts({ event: direct, binding: binding({ state: "paused" }) })).route).toBe("ignore");
    expect(routeChannelEvent(facts({ event: direct, connection: { ...connection, state: "revoked" } })).route).toBe("ignore");
  });

  it("keeps a sender outside the binding's audience as context rather than refusing them", () => {
    const audience = binding({ audiencePolicy: { kind: "principals", principalIds: ["prin_owner"] } });
    const decision = routeChannelEvent(facts({ binding: audience, event: event({ mentionsClark: true }) }));
    expect(decision.route).toBe("context");
    expect(routeChannelEvent(facts({ binding: audience, actorPrincipalId: "prin_owner", event: event({ mentionsClark: true }) })).route).toBe(
      "turn",
    );
  });
});

describe("a channel message as the shared intake records it", () => {
  it("is a generic signal deduplicated on the event id, with no provider id in its subject", () => {
    const signal = channelEventSignal(connection, event(), false);
    expect(signal).toMatchObject({
      source: { kind: "external", provider: "fake-chat", sourceId: "channel:conn_abc" },
      topic: CHANNEL_MESSAGE_TOPIC,
      dedupeKey: "evt-1",
      subject: { type: "group-message", refs: { connection: "conn_abc" } },
    });
    expect(JSON.stringify(signal.subject)).not.toMatch(/m-1|space-1|u-1/);
  });

  it("keys a thread by connection, space and thread", () => {
    expect(channelThreadKey("conn_abc", event())).not.toBe(channelThreadKey("conn_abc", event({ externalThreadId: "t-1" })));
  });
});

describe("what a channel turn is given", () => {
  it("joins a burst in the order it was written", () => {
    expect(coalescedTurnText([{ content: { text: "one", format: "plain" } }, { content: { text: " two ", format: "plain" } }])).toBe(
      "one\n\ntwo",
    );
  });

  it("says where it came from and quotes context newest-first within a bound, with no ids", () => {
    const context = Array.from({ length: 200 }, (_, index) => ({ senderName: "Minh", text: `line ${String(index)} ${"x".repeat(100)}` }));
    const data = channelTurnData({ provider: "fake-chat", spaceKind: "group", senderName: "Lan", context });
    expect(data).toMatch(/group chat \(fake-chat\) from Lan/);
    expect(data).toMatch(/line 199/);
    expect(data).not.toMatch(/line 0 /);
    expect(data.length).toBeLessThanOrEqual(6_000);
  });

  it("splits a long reply at line breaks into pieces a provider accepts", () => {
    const pieces = splitChannelText(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100);
    expect(pieces).toEqual(["a".repeat(60), "b".repeat(60)]);
    expect(splitChannelText("x".repeat(250), 100).map((piece) => piece.length)).toEqual([100, 100, 50]);
  });
});

describe("whether a reply goes back where the message was written", () => {
  const policy = (overrides: Partial<ExecutionPolicyConfig> = {}): ExecutionPolicyConfig => ({ ...DEFAULT_EXECUTION_POLICY_CONFIG, ...overrides });

  it("is sent in every mode: the binding is the owner's decision that Clark talks there", () => {
    for (const mode of ["autonomous", "guarded", "ask"] as const) {
      expect(decideChannelReply(policy({ mode }), "sha256:x").kind).toBe("execute");
    }
  });

  it("is held when a rule asks before communication, and refused by a deny rule or a prohibition", () => {
    expect(decideChannelReply(policy({ rules: [{ effectCategory: "communication", decision: "ask" }] }), "sha256:x").kind).toBe("ask");
    expect(decideChannelReply(policy({ rules: [{ effectCategory: "communication", decision: "deny" }] }), "sha256:x").kind).toBe("deny");
    expect(decideChannelReply(policy({ prohibition: "all" }), "sha256:x").kind).toBe("deny");
  });
});

describe("what of a reply is said on a channel", () => {
  it("is Clark's words and views' text alternatives, never the owner's cards or tool activity", () => {
    // Only the fields the function reads are filled; the blocks are never validated here.
    const blocks = [
      { type: "text", format: "plain", content: "Lịch họp: thứ Hai 9 giờ.", streaming: false },
      { type: "tool-activity", name: "calendar", label: "Đọc lịch", status: "succeeded" },
      { type: "system-card", owner: "host", cardId: "card_1", title: "Trả lời bằng model" },
      { type: "approval-card", owner: "host", approvalId: "apr_1", operationDescription: "Gửi email" },
      { type: "widget-ref", textAlternative: "Bảng lịch tuần" },
    ] as unknown as MessageBlock[];
    expect(channelReplyText(blocks)).toBe("Lịch họp: thứ Hai 9 giờ.\n\nBảng lịch tuần");
  });
});

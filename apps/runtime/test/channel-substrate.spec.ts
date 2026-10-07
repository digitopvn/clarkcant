import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExternalConnection,
  type Instant,
  type MessageRecord,
  messageBlocksAsText,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, type ModelTurnInput, writeRegisteredPreference } from "@clarkcant/core";
import {
  channelDeliveryReceiptsForMessage,
  channelInputsInState,
  createConversation,
  getEffect,
  getChannelInput,
  latestMessages,
  putExternalConnection,
} from "@clarkcant/storage";

import { createChannelAdapterRegistry } from "../src/channels/channel-adapter-registry.ts";
import { type ChannelService, startChannelService } from "../src/channels/channel-service.ts";
import { bindChannelSpace, createExternalConnection } from "../src/channels/channel-setup.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { type FakeChannelAdapter, type FakeChannelMessage, createFakeChannelAdapter, fakeDelivery } from "./fake-channel-adapter.ts";

/**
 * The channel substrate end to end, on an in-memory provider: a message on a bound channel is recorded once by the
 * shared intake, routed by the Attention Router, answered by the same Clark turn a typed message gets, and the reply is
 * carried back as an effect with a receipt — and none of it twice, across redeliveries and a restart.
 */

const CONVERSATION = "conv_channel";
let dir: string;
let services: NodeServices;
let adapter: FakeChannelAdapter;
let channels: ChannelService;
let connection: ExternalConnection;
let clock: number;
let turns: ModelTurnInput[];
let answer: (input: ModelTurnInput) => Promise<string>;

const now = (): Instant => new Date(clock).toISOString() as Instant;
const advance = (ms: number): void => {
  clock += ms;
};

function boot(): void {
  services = bootNodeServices({ dataDir: dir, label: "channel node" });
  services.conductor.respondWithModel = async (input) => {
    turns.push(input);
    const text = await answer(input);
    return { text, segments: [{ kind: "text", text }], provider: "test-provider", model: "test-model", elapsedMs: 1 };
  };
  const registry = createChannelAdapterRegistry();
  registry.register(adapter);
  channels = startChannelService(services, { registry, now, intervalMs: 60_000 });
}

function setup() {
  return { db: services.runtime.db, now, newId: services.conductor.newId };
}

function bind(input: { space: string; kind: "direct" | "group"; burstWindowMs?: number }) {
  return bindChannelSpace(setup(), {
    connectionRef: connection.connectionRef,
    externalSpaceId: input.space,
    spaceKind: input.kind,
    conversationId: CONVERSATION,
    attentionPolicy: { burstWindowMs: input.burstWindowMs ?? 0 },
  });
}

async function deliver(...messages: FakeChannelMessage[]) {
  const result = await channels.receive(connection.connectionRef, fakeDelivery(messages));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function transcript(): MessageRecord[] {
  return latestMessages(services.runtime.db, CONVERSATION, 100);
}

function signalCount(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM signal_deliveries").get() as { n: number }).n;
}

const textOf = (message: MessageRecord): string => messageBlocksAsText(message.blocks);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-channels-"));
  clock = Date.UTC(2026, 9, 7, 9, 0);
  turns = [];
  answer = async (input) => `Đã nhận: ${input.text}`;
  adapter = createFakeChannelAdapter();
  boot();
  createConversation(services.runtime.db, { conversationId: CONVERSATION, homeNodeId: services.runtime.identity.nodeId, at: now() });
  connection = createExternalConnection(setup(), {
    provider: "fake-chat",
    providerAccountId: "bot-1",
    principalId: services.runtime.identity.ownerPrincipalId,
    ingressMode: "webhook",
  });
});

afterEach(async () => {
  await channels.stop();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a direct message on a bound channel", () => {
  it("becomes a Clark turn whose reply goes back where it was written", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    await deliver({ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", name: "Lan", text: "chào Clark" });
    await channels.idle();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("chào Clark");
    // Told where it came from, by name, with no provider id in what the model reads.
    expect(turns[0]?.data).toMatch(/direct chat \(fake-chat\)/);
    expect(turns[0]?.data).toMatch(/sender's display name: "Lan"/);
    // Lan is not the owner, so the turn is a participant's, and the model is told so by the host.
    expect(turns[0]?.data).toMatch(/NOT the owner/);
    expect(turns[0]?.channelAuthority).toMatchObject({ standing: "participant", grants: [] });
    expect(JSON.stringify(turns[0])).not.toMatch(/dm-lan|u-lan|m-1|conn_/);

    const [user, reply] = transcript();
    expect(user).toMatchObject({ role: "user", origin: "channel" });
    expect(user?.authorPrincipalId).toMatch(/^prin_/);
    expect(user?.authorPrincipalId).not.toBe(services.runtime.identity.ownerPrincipalId);
    expect(reply?.role).toBe("assistant");

    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]).toMatchObject({
      address: { connectionRef: connection.connectionRef, externalSpaceId: "dm-lan", replyToExternalMessageId: "m-1" },
      content: { text: "Đã nhận: chào Clark", format: "plain" },
    });
    const receipts = channelDeliveryReceiptsForMessage(services.runtime.db, reply?.messageId ?? "");
    expect(receipts).toMatchObject([{ state: "sent", externalMessageId: "out-1", operation: "send" }]);
    // The send is an effect in the one ledger, settled as answered.
    const effect = getEffect(services.runtime.db, receipts[0]?.effectId ?? "");
    expect(effect).toMatchObject({ category: "communication", capabilityRef: "channel.fake-chat.send" });
    expect(effect?.state).toBe("confirmed");
  });

  it("is recorded once however often the provider delivers it", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    const message = { id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "một lần thôi" } as const;
    expect(await deliver(message)).toEqual({ ok: true, recorded: 1, duplicates: 0 });
    expect(await deliver(message)).toEqual({ ok: true, recorded: 0, duplicates: 1 });
    await channels.idle();
    expect(await deliver(message)).toEqual({ ok: true, recorded: 0, duplicates: 1 });
    await channels.idle();
    expect(turns).toHaveLength(1);
    expect(adapter.sends).toHaveLength(1);
    expect(signalCount()).toBe(1);
  });

  it("is refused before it is read when the provider's signature does not match", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    const result = await channels.receive(
      connection.connectionRef,
      fakeDelivery([{ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "giả mạo" }], "forged"),
    );
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    await channels.idle();
    expect(turns).toHaveLength(0);
    expect(signalCount()).toBe(0);
  });

  it("starts nothing in a space nobody bound", async () => {
    await deliver({ id: "m-1", space: "dm-stranger", kind: "direct", from: "u-x", text: "hi bot" });
    await channels.idle();
    expect(turns).toHaveLength(0);
    expect(adapter.sends).toHaveLength(0);
    expect(channelInputsInState(services.runtime.db, ["ignored"])).toHaveLength(1);
  });
});

describe("a bound group", () => {
  it("keeps talk that does not ask for Clark as context, and hands it to the next turn there", async () => {
    bind({ space: "group-1", kind: "group" });
    await deliver({ id: "g-1", space: "group-1", from: "u-minh", name: "Minh", text: "mai họp lúc 9 giờ nhé" });
    await channels.idle();
    expect(turns).toHaveLength(0);
    expect(adapter.sends).toHaveLength(0);
    expect(transcript()).toHaveLength(0);
    expect(channelInputsInState(services.runtime.db, ["context"])).toHaveLength(1);

    await deliver({ id: "g-2", space: "group-1", from: "u-lan", name: "Lan", text: "@clark mấy giờ họp?", mentionsBot: true });
    await channels.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.data).toContain('"Minh": "mai họp lúc 9 giờ nhé"');
    expect(adapter.sends).toHaveLength(1);

    // Handed to one turn only: the next turn there is not given the same talk again.
    expect(channelInputsInState(services.runtime.db, ["context"])).toHaveLength(0);
    await deliver({ id: "g-3", space: "group-1", from: "u-lan", name: "Lan", text: "@clark còn gì nữa không?", mentionsBot: true });
    await channels.idle();
    expect(turns).toHaveLength(2);
    expect(turns[1]?.data).not.toMatch(/mai họp/);
  });

  it("does not hand a turn talk from hours before it", async () => {
    bind({ space: "group-1", kind: "group" });
    await deliver({ id: "g-1", space: "group-1", from: "u-minh", name: "Minh", text: "chuyện hôm qua" });
    await channels.idle();
    advance(7 * 60 * 60_000);
    await deliver({ id: "g-2", space: "group-1", from: "u-lan", name: "Lan", text: "@clark chào", mentionsBot: true });
    await channels.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.data).not.toMatch(/chuyện hôm qua/);
  });

  it("answers a reply to Clark's message, and links it to the message it answers", async () => {
    bind({ space: "group-1", kind: "group" });
    await deliver({ id: "g-1", space: "group-1", from: "u-lan", text: "@clark tóm tắt giúp", mentionsBot: true });
    await channels.idle();
    const sent = adapter.sends[0]?.externalMessageId ?? "";
    await deliver({ id: "g-2", space: "group-1", from: "u-lan", text: "cảm ơn, thêm chi tiết nhé", replyTo: sent });
    await channels.idle();
    expect(turns).toHaveLength(2);
    const users = transcript().filter((message) => message.role === "user");
    const firstReply = transcript().find((message) => message.role === "assistant");
    expect(users[1]?.inReplyToMessageId).toBe(firstReply?.messageId);
  });

  it("coalesces one person's burst into one turn once the thread goes quiet", async () => {
    bind({ space: "group-1", kind: "group", burstWindowMs: 1_500 });
    await deliver({ id: "g-1", space: "group-1", from: "u-lan", text: "@clark ơi", mentionsBot: true });
    advance(400);
    await deliver({ id: "g-2", space: "group-1", from: "u-lan", text: "@clark cho mình hỏi", mentionsBot: true });
    advance(400);
    await deliver({ id: "g-3", space: "group-1", from: "u-lan", text: "@clark lịch tuần sau?", mentionsBot: true });
    // Still inside the window: nothing has run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toHaveLength(0);

    advance(2_000);
    await channels.idle();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("@clark ơi\n\n@clark cho mình hỏi\n\n@clark lịch tuần sau?");
    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]?.address.replyToExternalMessageId).toBe("g-3");
    expect(channelInputsInState(services.runtime.db, ["coalesced"])).toHaveLength(2);
  });

  it("never answers itself: Clark's own account and the echo of its own reply are ignored", async () => {
    bind({ space: "group-1", kind: "group" });
    await deliver({ id: "g-1", space: "group-1", from: "u-lan", text: "@clark chào", mentionsBot: true });
    await channels.idle();
    const echoed = adapter.sends[0]?.externalMessageId ?? "";
    // The provider echoes Clark's reply back, and a message from the bot account mentions Clark.
    await deliver(
      { id: echoed, updateId: `echo-${echoed}`, space: "group-1", from: "someone-else", text: "Đã nhận", mentionsBot: true },
      { id: "g-self", space: "group-1", from: "bot-1", text: "@clark loop?", mentionsBot: true },
    );
    await channels.idle();
    expect(turns).toHaveLength(1);
    expect(adapter.sends).toHaveLength(1);
  });

  it("drops the oldest of a thread's queue beyond its bound, and says so in the conversation", async () => {
    bindChannelSpace(setup(), {
      connectionRef: connection.connectionRef,
      externalSpaceId: "group-1",
      spaceKind: "group",
      conversationId: CONVERSATION,
      attentionPolicy: { burstWindowMs: 60_000, maxQueuedPerThread: 2 },
    });
    for (const [index, from] of ["u-a", "u-b", "u-c"].entries()) {
      await deliver({ id: `g-${String(index)}`, space: "group-1", from, text: "@clark?", mentionsBot: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channelInputsInState(services.runtime.db, ["dropped"]).map((input) => input.signalId)).toHaveLength(1);
    expect(transcript().some((message) => /fake-chat/.test(textOf(message)))).toBe(true);
    advance(61_000);
    await channels.idle();
    expect(turns).toHaveLength(2);
  });
});

describe("a reply that cannot be promised", () => {
  it("is unknown when the provider never answers, and is not sent again", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    adapter.sendMode = "throw";
    await deliver({ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "gửi được không?" });
    await channels.idle();
    expect(adapter.sends).toHaveLength(1);
    const reply = transcript().find((message) => message.role === "assistant");
    expect(channelDeliveryReceiptsForMessage(services.runtime.db, reply?.messageId ?? "")).toMatchObject([{ state: "unknown" }]);

    // The ledger holds it as unknown, so the conversation may say the inbox asks about it.
    expect(textOf(transcript().at(-1) as MessageRecord)).toMatch(/hộp thư hỏi bạn/);

    adapter.sendMode = "sent";
    channels.kick();
    await channels.idle();
    expect(adapter.sends).toHaveLength(1);
  });

  it("names a revoked connection as the cause, not the owner's settings", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    answer = async (input) => {
      putExternalConnection(services.runtime.db, { ...connection, state: "revoked", updatedAt: now() });
      return `Đã nhận: ${input.text}`;
    };
    await deliver({ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "còn đó không?" });
    await channels.idle();
    expect(adapter.sends).toHaveLength(0);
    const said = textOf(transcript().at(-1) as MessageRecord);
    expect(said).toMatch(/đã bị thu hồi/);
    expect(said).not.toMatch(/Cài đặt/);
  });

  it("names the provider's refusal as the cause", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    adapter.sendMode = "not-sent";
    await deliver({ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "gửi nhé" });
    await channels.idle();
    const said = textOf(transcript().at(-1) as MessageRecord);
    expect(said).toMatch(/fake-chat từ chối câu trả lời này: the provider refused the chat/);
    expect(said).not.toMatch(/Cài đặt/);
  });

  it("is held when the owner asked to be asked about communication, and the conversation says why", async () => {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, rules: [{ effectCategory: "communication", decision: "ask" }] },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);
    bind({ space: "dm-lan", kind: "direct" });
    await deliver({ id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "trả lời nhé" });
    await channels.idle();
    expect(adapter.sends).toHaveLength(0);
    const reply = transcript().find((message) => message.role === "assistant");
    expect(channelDeliveryReceiptsForMessage(services.runtime.db, reply?.messageId ?? "")).toMatchObject([{ state: "held" }]);
    expect(textOf(transcript().at(-1) as MessageRecord)).toMatch(/fake-chat vì chính sách của bạn.*Cài đặt → Điều khiển/);
  });
});

describe("a node that stops while it answers", () => {
  it("does not answer the same message again when it starts", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    // The first turn never finishes: the node stops under it.
    answer = async () => {
      started();
      return await new Promise<string>(() => undefined);
    };
    const message = { id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "đang dở" } as const;
    await deliver(message);
    channels.kick();
    await running;
    const [input] = channelInputsInState(services.runtime.db, ["started"]);
    expect(input).toBeDefined();
    void channels.stop(0);
    services.runtime.close();

    answer = async (turn) => `Đã nhận: ${turn.text}`;
    boot();
    // The provider redelivers what it never saw answered.
    expect(await deliver(message)).toEqual({ ok: true, recorded: 0, duplicates: 1 });
    await channels.idle();

    expect(getChannelInput(services.runtime.db, input?.signalId ?? "")?.state).toBe("interrupted");
    expect(turns).toHaveLength(1);
    expect(adapter.sends).toHaveLength(0);
    expect(transcript().filter((each) => each.role === "user")).toHaveLength(1);
    expect(textOf(transcript().at(-1) as MessageRecord)).toMatch(/fake-chat/);
    expect(textOf(transcript().at(-1) as MessageRecord)).not.toMatch(/một phần/);
  });

  it("says part of the reply had gone out when the node stopped between its pieces", async () => {
    bind({ space: "dm-lan", kind: "direct" });
    adapter.maxTextLength = 20;
    answer = async () => `${"a".repeat(18)}\n${"b".repeat(18)}`;
    let firstSent: () => void = () => undefined;
    const sentOnce = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    adapter.afterSend = () => {
      adapter.sendMode = "hang";
      firstSent();
    };
    const message = { id: "m-1", space: "dm-lan", kind: "direct", from: "u-lan", text: "dài nhé" } as const;
    await deliver(message);
    channels.kick();
    await sentOnce;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.sends).toHaveLength(2);
    void channels.stop(0);
    services.runtime.close();

    adapter.sendMode = "sent";
    delete adapter.afterSend;
    boot();
    await channels.idle();
    expect(adapter.sends).toHaveLength(2);
    expect(textOf(transcript().at(-1) as MessageRecord)).toMatch(/một phần câu trả lời đã tới đó/);
  });
});

import { describe, expect, it } from "vitest";

import {
  CHANNEL_CONTRACT_VERSION,
  type ChannelBinding,
  DEFAULT_CHANNEL_ATTENTION_POLICY,
  type ExternalConnection,
  type Instant,
} from "@clarkcant/contracts";

import {
  MIGRATIONS,
  channelContextJournal,
  channelInputsInState,
  claimChannelDeliveryReceipt,
  createConversation,
  deleteConversationRows,
  ensureExternalIdentity,
  findChannelBinding,
  findExternalMessageLink,
  getChannelBinding,
  migrate,
  openDatabase,
  putChannelBinding,
  putExternalConnection,
  recordChannelInput,
  recordExternalMessageLink,
  recordSignalDelivery,
  transaction,
  trimChannelContextJournal,
  updateChannelInput,
} from "../src/index.ts";

/**
 * Where external channels are kept: connections, the senders mapped to principals, spaces bound to conversations,
 * provider message ids linked to Clark's, what the channel branch did with each recorded message, and one receipt per
 * outbound operation. Added by a new migration over an existing database, never by editing an applied one.
 */

const VERSION = 44;
const at = (minute: number): Instant => new Date(Date.UTC(2026, 9, 7, 9, minute)).toISOString() as Instant;

const connection: ExternalConnection = {
  version: CHANNEL_CONTRACT_VERSION,
  connectionRef: "conn_abc" as ExternalConnection["connectionRef"],
  provider: "fake-chat",
  providerAccountId: "bot-1",
  principalId: "prin_owner",
  ingressMode: "webhook",
  state: "connected",
  selfActorIds: ["bot-1"],
  createdAt: at(0),
  updatedAt: at(0),
};

function binding(overrides: Partial<ChannelBinding> = {}): ChannelBinding {
  return {
    version: CHANNEL_CONTRACT_VERSION,
    bindingId: "chb_space",
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
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

function freshDb() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: "conv_1", homeNodeId: "node_1", at: at(0) });
  putExternalConnection(db, connection);
  return db;
}

function signal(db: ReturnType<typeof freshDb>, eventId: string, minute: number): string {
  return recordSignalDelivery(db, {
    signalId: `sig_${eventId}`,
    source: { kind: "external", provider: "fake-chat", sourceId: "channel:conn_abc" },
    topic: "channel.message.received",
    subject: { type: "group-message", refs: { connection: "conn_abc" } },
    payload: {},
    occurredAt: at(minute),
    dedupeKey: eventId,
    provenance: { selfGenerated: false, via: "test" },
    receivedAt: at(minute),
  }).signalId;
}

describe("the external channels migration", () => {
  it("applies over a database that predates it and is not applied twice", () => {
    const db = openDatabase({ path: ":memory:" });
    migrate(db, MIGRATIONS.filter((migration) => migration.version < VERSION));
    createConversation(db, { conversationId: "conv_old", homeNodeId: "node_1", at: at(0) });
    expect(migrate(db, MIGRATIONS).applied).toContain(VERSION);
    expect(migrate(db, MIGRATIONS).applied).toEqual([]);
    for (const table of [
      "external_connections",
      "external_identities",
      "external_channel_bindings",
      "external_message_links",
      "channel_inputs",
      "channel_delivery_receipts",
    ]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table).toBeDefined();
    }
  });
});

describe("channel records", () => {
  it("finds the thread's own binding before the whole space's", () => {
    const db = freshDb();
    putChannelBinding(db, binding());
    putChannelBinding(db, binding({ bindingId: "chb_thread", externalThreadId: "t-1" }));
    const where = { connectionRef: "conn_abc", externalSpaceId: "space-1" };
    expect(findChannelBinding(db, { ...where, externalThreadId: "t-1" })?.bindingId).toBe("chb_thread");
    expect(findChannelBinding(db, { ...where, externalThreadId: "t-2" })?.bindingId).toBe("chb_space");
    expect(findChannelBinding(db, { connectionRef: "conn_abc", externalSpaceId: "space-2" })).toBeUndefined();
    expect(getChannelBinding(db, "chb_space")?.attentionPolicy).toEqual(DEFAULT_CHANNEL_ATTENTION_POLICY);
  });

  it("maps a sender to one principal however often they write", () => {
    const db = freshDb();
    const first = ensureExternalIdentity(db, { connectionRef: connection.connectionRef, externalActorId: "u-1", principalId: "prin_a", linkedAt: at(1) });
    const again = ensureExternalIdentity(db, { connectionRef: connection.connectionRef, externalActorId: "u-1", principalId: "prin_b", linkedAt: at(2) });
    expect(again.principalId).toBe(first.principalId);
  });

  it("records a channel message once, and keeps only the newest context", () => {
    const db = freshDb();
    putChannelBinding(db, binding());
    const ids = [1, 2, 3].map((minute) => signal(db, `evt-${String(minute)}`, minute));
    for (const [index, signalId] of ids.entries()) {
      expect(recordChannelInput(db, { signalId, connectionRef: "conn_abc", threadKey: "k", receivedAt: at(index + 1) })).toBe(true);
      expect(recordChannelInput(db, { signalId, connectionRef: "conn_abc", threadKey: "k", receivedAt: at(index + 1) })).toBe(false);
      updateChannelInput(db, signalId, { state: "context", at: at(5), bindingId: "chb_space" });
    }
    expect(trimChannelContextJournal(db, "chb_space", 2, at(6))).toBe(1);
    expect(channelContextJournal(db, "chb_space", 10).map((input) => input.signalId)).toEqual(ids.slice(1));
    expect(channelInputsInState(db, ["context-expired"]).map((input) => input.signalId)).toEqual([ids[0]]);
  });

  it("answers a second claim of the same outbound operation with the first one's receipt", () => {
    const db = freshDb();
    const receipt = {
      receiptId: "rcpt_1",
      connectionRef: connection.connectionRef,
      bindingId: "chb_space",
      operation: "send" as const,
      idempotencyKey: "reply:msg_1:0",
      state: "pending" as const,
      conversationId: "conv_1",
      messageId: "msg_1",
      createdAt: at(1),
      updatedAt: at(1),
    };
    expect(claimChannelDeliveryReceipt(db, receipt).created).toBe(true);
    const second = claimChannelDeliveryReceipt(db, { ...receipt, receiptId: "rcpt_2" });
    expect(second).toEqual({ created: false, receipt });
  });

  it("goes with the conversation it is bound to", () => {
    const db = freshDb();
    putChannelBinding(db, binding());
    const signalId = signal(db, "evt-1", 1);
    recordChannelInput(db, { signalId, connectionRef: "conn_abc", threadKey: "k", receivedAt: at(1) });
    updateChannelInput(db, signalId, { state: "context", at: at(1), bindingId: "chb_space" });
    recordExternalMessageLink(db, {
      connectionRef: connection.connectionRef,
      provider: "fake-chat",
      externalSpaceId: "space-1",
      externalMessageId: "m-1",
      conversationId: "conv_1",
      messageId: "msg_1",
      direction: "inbound",
      createdAt: at(1),
    });
    transaction(db, () => deleteConversationRows(db, "conv_1"));
    expect(getChannelBinding(db, "chb_space")).toBeUndefined();
    expect(findExternalMessageLink(db, { connectionRef: "conn_abc", externalSpaceId: "space-1", externalMessageId: "m-1" })).toBeUndefined();
    expect(channelInputsInState(db, ["context"])).toEqual([]);
  });
});

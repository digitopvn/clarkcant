import { beforeEach, describe, expect, it } from "vitest";

import { instantSchema, nodeIdSchema, type PeerEnvelope } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";

import { negotiate, receiveEnvelope, sendEnvelope } from "../src/index.ts";

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");
const NODE_B = nodeIdSchema.parse("node_b");

let counter = 0;
function deps(handler = () => ({ outcome: "accepted" })) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return {
    db,
    nodeId: NODE_B,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
    supportedVersions: { min: 1, max: 2 },
    knownDelegationIds: new Set<string>(),
    handler,
  };
}

function envelope(overrides: Partial<PeerEnvelope> = {}): PeerEnvelope {
  return {
    protocol: "agent.nodelink",
    version: 1,
    messageId: "msg_1",
    correlationId: "corr_1",
    senderNodeId: NODE_A,
    recipientNodeId: NODE_B,
    kind: "status",
    sourceSequence: 1,
    sentAt: AT,
    payload: { taskState: "running", taskRevision: 1 },
    ...overrides,
  } as PeerEnvelope;
}

let d: ReturnType<typeof deps>;
beforeEach(() => {
  d = deps();
});

describe("inbound validation (T08)", () => {
  it("accepts a valid envelope from the authenticated peer", () => {
    const result = receiveEnvelope(d, envelope(), { authenticatedSenderNodeId: NODE_A });
    expect(result.status).toBe("processed");
  });

  it("rejects an envelope whose claimed sender is not the authenticated peer", () => {
    // Private network reachability is not authorization, and a self-declared identity
    // inside the payload is data rather than proof.
    const result = receiveEnvelope(d, envelope(), { authenticatedSenderNodeId: NODE_B });
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.code).toBe("SENDER_MISMATCH");
  });

  it("rejects an envelope from an unsupported protocol version (T11)", () => {
    const result = receiveEnvelope(d, envelope({ version: 9 }), { authenticatedSenderNodeId: NODE_A });
    expect(result.status).toBe("rejected");
  });

  it("rejects a status envelope that omits its required payload fields", () => {
    const result = receiveEnvelope(d, envelope({ payload: {} }), { authenticatedSenderNodeId: NODE_A });
    expect(result.status).toBe("rejected");
  });
});

describe("at-least-once delivery with durable dedup (T02, T03)", () => {
  it("returns the recorded outcome for a resent envelope instead of running the handler again", () => {
    let handled = 0;
    const withCounter = deps(() => {
      handled += 1;
      return { outcome: "accepted", attempt: handled };
    });

    const first = receiveEnvelope(withCounter, envelope(), { authenticatedSenderNodeId: NODE_A });
    expect(first.status).toBe("processed");

    const resend = receiveEnvelope(withCounter, envelope(), { authenticatedSenderNodeId: NODE_A });
    expect(resend.status).toBe("duplicate");
    expect(handled).toBe(1);
    // The original answer is returned verbatim, so a lost acknowledgement cannot
    // become a second delegated task.
    expect(resend.status === "duplicate" && resend.responseJson).toBe(first.status === "processed" ? first.responseJson : "");
  });

  it("advances the peer cursor so the next sequence is accepted", () => {
    receiveEnvelope(d, envelope(), { authenticatedSenderNodeId: NODE_A });
    const next = receiveEnvelope(d, envelope({ messageId: "msg_2", sourceSequence: 2 }), {
      authenticatedSenderNodeId: NODE_A,
    });
    expect(next.status).toBe("processed");
  });
});

describe("outbound durability", () => {
  it("records intent before transmission", () => {
    sendEnvelope(d, envelope({ recipientNodeId: NODE_B }));
    const rows = d.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acknowledged_at IS NULL").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
  });
});

describe("version negotiation surface", () => {
  it("exposes negotiation through the gateway module", () => {
    const local = {
      protocol: { name: "agent.nodelink" as const, min: 1, max: 2 },
      appVersion: "0.2.0",
      hostApi: { name: "agent.apphost" as const, min: 1, max: 1 },
      capabilityGenerations: {},
    };
    expect(negotiate(local, local).mode).toBe("full");
  });
});

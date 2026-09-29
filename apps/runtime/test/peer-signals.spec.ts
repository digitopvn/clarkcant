import { afterEach, describe, expect, it } from "vitest";

import { type Instant, type MessageRecord, type PeerEnvelope } from "@clarkcant/contracts";
import { allRows, parseJson, pendingOutbox } from "@clarkcant/storage";

import { createAutomationTools } from "../src/automation-tools.ts";
import { startAutomationService } from "../src/automation-service.ts";
import { startPeerDelivery } from "../src/peer-signals.ts";
import { type LiveNode, call, identityOf, liveNodes, pair, tokenFor } from "./live-nodes.ts";

/**
 * One Clark's news reaching another's standing requests.
 *
 * Two real nodes, paired the way a person pairs them, with real HTTP between them. Node A says something happened;
 * node B, where the person asked to be told, answers it with the automation they set up there. What the tests are
 * careful about is that the news is a fact and not a command: B decides what it starts, B decides whose news it is,
 * and a node B never confirmed gets nothing in.
 */

const nodes = liveNodes();

afterEach(async () => {
  await nodes.stopAll();
});

/** A node with its automation service and its delivery pass running, as `wireRuntime` starts them. */
async function startClark(label: string): Promise<LiveNode> {
  return nodes.start(label, (services) => {
    services.automation = startAutomationService(services, { intervalMs: 3_600_000 });
    services.peerDelivery = startPeerDelivery(
      { db: services.runtime.db, identity: services.runtime.identity, now: () => new Date().toISOString() as Instant },
      { intervalMs: 3_600_000, log: () => undefined },
    );
  });
}

async function conversation(node: LiveNode): Promise<string> {
  const response = await call(node, "/conversations", { body: { title: "Tin từ máy khác" }, token: node.token });
  expect(response.status).toBe(201);
  return String(response.body["conversationId"]);
}

async function remindOn(node: LiveNode, conversationId: string, topic: string, match: unknown[] = []): Promise<void> {
  const tool = createAutomationTools({
    db: node.services.runtime.db,
    nodeId: identityOf(node).nodeId,
    principalId: identityOf(node).ownerPrincipalId,
    conversationId,
    now: () => new Date().toISOString() as Instant,
    newId: node.services.conductor.newId,
    ownedRoots: () => [],
  }).find((candidate) => candidate.name === "create_automation");
  const created = (await tool?.execute({ summary: `Báo khi có ${topic}`, topic, match, action: "remind", message: "máy kia báo" } as never)) as
    | { text: string }
    | undefined;
  expect(created?.text).toContain("Set up.");
}

function signalsOn(node: LiveNode): { topic: string; source: { kind: string; sourceId: string; provider?: string } }[] {
  return allRows<{ document: string }>(node.services.runtime.db, "SELECT document FROM signal_deliveries ORDER BY rowid").map(
    (row) => JSON.parse(row.document) as { topic: string; source: { kind: string; sourceId: string } },
  );
}

function reminders(node: LiveNode, conversationId: string): string[] {
  return allRows<{ document: string }>(
    node.services.runtime.db,
    "SELECT document FROM messages WHERE conversation_id = ? ORDER BY sequence",
    conversationId,
  ).flatMap((row) => {
    const message = parseJson<MessageRecord>(row.document, "messages.document");
    return message.role === "assistant"
      ? message.blocks.flatMap((block) => (block.type === "text" && block.content.startsWith("Nhắc bạn") ? [block.content] : []))
      : [];
  });
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a paired Clark's news", () => {
  it("reaches the standing request the person set up on the other node, under the sender's name", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    await pair(a, b);
    const conversationId = await conversation(b);
    await remindOn(b, conversationId, "peer.build.failed", [{ path: "payload.branch", op: "equals", value: "main" }]);

    const sent = await call(a, `/peers/${identityOf(b).nodeId}/signals`, {
      body: { id: "build-812", topic: "build.failed", payload: { branch: "main" }, subject: { type: "build", id: "812" } },
      token: a.token,
    });
    expect(sent.status).toBe(202);

    // Delivered by A's own pass, matched by B's own service: nobody drives either by hand.
    await waitUntil(() => reminders(b, conversationId).length === 1, "the reminder on B");
    expect(reminders(b, conversationId)).toEqual(["Nhắc bạn — Báo khi có peer.build.failed: máy kia báo"]);
    expect(signalsOn(b)).toMatchObject([
      { topic: "peer.build.failed", source: { kind: "peer", provider: "clarkcant", sourceId: identityOf(a).nodeId } },
    ]);
    expect(pendingOutbox(a.services.runtime.db)).toEqual([]);
  });

  it("is recorded once, whether the envelope is resent or the same event is sent again", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    await pair(a, b);
    const conversationId = await conversation(b);
    await remindOn(b, conversationId, "peer.build.failed");

    const body = { id: "build-812", topic: "build.failed" };
    expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body, token: a.token })).status).toBe(202);
    await waitUntil(() => signalsOn(b).length === 1 && pendingOutbox(a.services.runtime.db).length === 0, "the first delivery");

    // The same envelope again, as a retry after a lost acknowledgement: answered from B's inbox.
    const [sentEnvelope] = allRows<{ document: string }>(a.services.runtime.db, "SELECT document FROM outbox").map(
      (row) => JSON.parse(row.document) as PeerEnvelope,
    );
    const replay = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify(sentEnvelope),
    });
    expect(((await replay.json()) as { status: string }).status).toBe("duplicate");

    // The same event under a new envelope: B keys it by the sender's id for the event, so it is still one signal.
    expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body, token: a.token })).status).toBe(202);
    await waitUntil(() => pendingOutbox(a.services.runtime.db).length === 0, "the second delivery");
    b.services.automation?.tick();
    expect(signalsOn(b)).toHaveLength(1);
    expect(reminders(b, conversationId)).toHaveLength(1);
  });

  it("cannot pass itself off as another source, or as another node", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    await pair(a, b);
    const conversationId = await conversation(b);
    await remindOn(b, conversationId, "github.issue.labeled");

    // A GitHub-shaped topic from a peer is the peer's news about GitHub, not a GitHub delivery.
    expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body: { id: "x", topic: "github.issue.labeled" }, token: a.token })).status).toBe(202);
    await waitUntil(() => signalsOn(b).length === 1, "the delivery");
    b.services.automation?.tick();
    expect(signalsOn(b)[0]).toMatchObject({ topic: "peer.github.issue.labeled", source: { kind: "peer" } });
    expect(reminders(b, conversationId)).toEqual([]);

    // An envelope that says it came from somewhere else is refused by what the channel says, not read.
    const forged = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(a, b)}` },
      body: JSON.stringify({
        protocol: "agent.nodelink",
        version: 1,
        messageId: "msg_forged",
        correlationId: "msg_forged",
        senderNodeId: "node_someone_else",
        recipientNodeId: identityOf(b).nodeId,
        kind: "signal",
        sourceSequence: 99,
        sentAt: new Date().toISOString(),
        payload: {
          signal: { source: { kind: "external", provider: "github", sourceId: "acme/widgets" }, topic: "issue.labeled", payload: {}, occurredAt: new Date().toISOString(), dedupeKey: "forged" },
        },
      }),
    });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as { code: string }).code).toBe("SENDER_MISMATCH");
    expect(signalsOn(b)).toHaveLength(1);
  });

  it("gets nothing in from a node that was never confirmed, and is not sent to one", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    const stranger = await startClark("stranger");
    await pair(a, b);

    // Unknown to B: its derived token is one B never recorded.
    const envelope = {
      protocol: "agent.nodelink",
      version: 1,
      messageId: "msg_1",
      correlationId: "msg_1",
      senderNodeId: identityOf(stranger).nodeId,
      recipientNodeId: identityOf(b).nodeId,
      kind: "signal",
      sourceSequence: 1,
      sentAt: new Date().toISOString(),
      payload: { signal: { source: { kind: "local", sourceId: "x" }, topic: "build.failed", payload: {}, occurredAt: new Date().toISOString(), dedupeKey: "k" } },
    };
    const refused = await fetch(`${b.base}/peers/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor(stranger, b)}` },
      body: JSON.stringify(envelope),
    });
    expect(refused.status).toBe(401);
    expect(signalsOn(b)).toEqual([]);

    // And A does not queue news for a node it never paired with.
    const unpaired = await call(a, `/peers/${identityOf(stranger).nodeId}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token });
    expect(unpaired.status).toBe(404);
    expect(unpaired.body).toMatchObject({ code: "PEER_UNKNOWN" });
    expect(pendingOutbox(a.services.runtime.db)).toEqual([]);
  });

  it("is kept until the peer can take it, and sent on the next pass", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    await pair(a, b);
    await b.stop();

    expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body: { id: "1", topic: "build.failed" }, token: a.token })).status).toBe(202);
    // The attempt fails while B is down; the envelope stays owed rather than being dropped.
    await waitUntil(
      () => allRows<{ attempts: number }>(a.services.runtime.db, "SELECT attempts FROM outbox")[0]?.attempts === 1,
      "the failed attempt",
    );
    expect(pendingOutbox(a.services.runtime.db)).toHaveLength(1);
  });

  it("is refused before it is queued when it is not a signal", async () => {
    const a = await startClark("linux box");
    const b = await startClark("laptop");
    await pair(a, b);
    for (const body of [{ topic: "build.failed" }, { id: "1", topic: "Build Failed" }, { id: "1", topic: "x", payload: [1] }]) {
      expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body, token: a.token })).status).toBe(400);
    }
    // Only the owner of A says what A tells its peers.
    expect((await call(a, `/peers/${identityOf(b).nodeId}/signals`, { body: { id: "1", topic: "build.failed" } })).status).toBe(401);
    expect(pendingOutbox(a.services.runtime.db)).toEqual([]);
  });
});

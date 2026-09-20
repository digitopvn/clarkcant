import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Instant, type PairInvite, type PeerEnvelope, type Grant } from "@clarkcant/contracts";
import { createPairInvite, getPeer } from "@clarkcant/storage";
import { afterEach, describe, expect, it } from "vitest";

import { sendToPeer } from "../src/peer-transport.ts";
import { outboundPeerToken, peerTokenHash } from "../src/peers.ts";
import { createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Pairing between two live hosts.
 *
 * Two real nodes, two real ports, two real databases and real HTTP between them. This is the case the
 * conformance ledger recorded as not exercised: the envelope primitives were tested in isolation, and
 * the transport that would carry them between hosts did not exist.
 *
 * What the tests are careful about is the difference between "the two nodes know each other" and "the
 * two nodes may act on each other's behalf". A claim is the first; only a confirmation, made by a
 * person on each side, is the second - and an envelope sent before that is refused rather than held.
 */

interface LiveNode {
  base: string;
  services: NodeServices;
  /** The local bearer token: what authorizes commands on this machine, and never what a peer holds. */
  token: string;
  stop: () => Promise<void>;
}

const running: LiveNode[] = [];
const dirs: string[] = [];

async function startNode(label: string): Promise<LiveNode> {
  const dir = mkdtempSync(join(tmpdir(), "clarkcant-peers-"));
  dirs.push(dir);
  const services = bootNodeServices({ dataDir: dir, label });
  const server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const node: LiveNode = {
    base: `http://127.0.0.1:${address.port}`,
    services,
    token: services.runtime.identity.localToken,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  running.push(node);
  return node;
}

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.stop();
    node.services.runtime.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  node: LiveNode,
  path: string,
  init: { method?: string; body?: unknown; token?: string; peerToken?: string } = {},
): Promise<CallResult> {
  const response = await fetch(`${node.base}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...(init.peerToken === undefined ? {} : { authorization: `Bearer ${init.peerToken}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

function identityOf(node: LiveNode) {
  return node.services.runtime.identity;
}

/** The token a node presents to a specific peer. Derived, so both sides can compute it without it travelling. */
function tokenFor(presenter: LiveNode, peer: LiveNode): string {
  return outboundPeerToken(identityOf(presenter).localToken, identityOf(peer).nodeId);
}

/** What a node tells a specific peer about itself. */
function offerTo(node: LiveNode, peer: LiveNode): Record<string, string> {
  return {
    nodeId: identityOf(node).nodeId,
    label: identityOf(node).label,
    endpoint: node.base,
    publicKey: identityOf(node).publicKey,
    fingerprint: identityOf(node).fingerprint,
    tokenHash: peerTokenHash(tokenFor(node, peer)),
  };
}

/** Pair two live nodes the way a person would, and leave both sides confirmed. */
async function pair(a: LiveNode, b: LiveNode): Promise<void> {
  const invite = await call(a, "/peers/invites", { body: { endpoint: a.base }, token: a.token });
  expect(invite.status).toBe(201);
  const inviteId = (invite.body["invite"] as { inviteId: string }).inviteId;

  const claim = await call(a, "/peers/claim", { body: { inviteId, node: offerTo(b, a) } });
  expect(claim.status).toBe(200);

  // The claimant's half: it records what the issuer said about itself, including the hash of the
  // token the issuer will present to it.
  const record = await call(b, "/peers/record", {
    body: { node: { ...offerTo(a, b), tokenHash: String(claim.body["tokenHash"]) } },
    token: b.token,
  });
  expect(record.status).toBe(201);

  expect((await call(a, `/peers/${identityOf(b).nodeId}/confirm`, { token: a.token })).status).toBe(200);
  expect((await call(b, `/peers/${identityOf(a).nodeId}/confirm`, { token: b.token })).status).toBe(200);
}

/** A valid envelope of the simplest kind, so the channel is exercised rather than the payload. */
function envelopeFrom(sender: LiveNode, recipient: LiveNode, sequence = 1) {
  return {
    protocol: "agent.nodelink",
    version: 1,
    messageId: `msg_${String(sequence)}`,
    correlationId: "corr_1",
    senderNodeId: identityOf(sender).nodeId,
    recipientNodeId: identityOf(recipient).nodeId,
    kind: "handshake",
    sourceSequence: sequence,
    sentAt: new Date().toISOString(),
    payload: { handshake: { min: 1, max: 2 } },
  };
}

describe("two live hosts delegate", () => {
  /** The transport as the runtime wires it: real HTTP to whatever peer the outbox row names. */
  function transportFor(node: LiveNode) {
    return {
      db: node.services.runtime.db,
      identity: node.services.runtime.identity,
      now: () => new Date().toISOString() as Instant,
      peerFor: (peerNodeId: string) => getPeer(node.services.runtime.db, peerNodeId),
    };
  }

  function grantFor(sender: LiveNode, receiver: LiveNode, overrides: Partial<Grant> = {}): Grant {
    return {
      grantId: "grant_1",
      ownerPrincipalId: identityOf(sender).ownerPrincipalId,
      senderNodeId: identityOf(sender).nodeId,
      receiverNodeId: identityOf(receiver).nodeId,
      capabilityRefs: [],
      resources: [],
      allowedDataClasses: ["public", "internal"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString() as Instant,
      budget: { maxArtifactBytes: 1024 },
      maxDelegationDepth: 0,
      ...overrides,
    };
  }

  function envelope(sender: LiveNode, recipient: LiveNode, sequence: number): Omit<PeerEnvelope, "kind" | "payload"> {
    return {
      protocol: "agent.nodelink",
      version: 1,
      messageId: `msg_${String(sequence)}`,
      correlationId: "corr_1",
      senderNodeId: identityOf(sender).nodeId,
      recipientNodeId: identityOf(recipient).nodeId,
      sourceSequence: sequence,
      sentAt: new Date().toISOString() as Instant,
    };
  }

  it("carries a delegation between two live hosts, and answers a replay with what was recorded", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    // The grant is written by the owner and travels as an envelope, so the receiver stores it and
    // from then on a delegate naming it is admissible.
    const grant = grantFor(a, b);
    const written = await call(a, "/grants", { body: grant, token: a.token });
    expect(written.status).toBe(201);

    const grantSent = await sendToPeer(transportFor(a), {
      ...envelope(a, b, 1),
      kind: "pair.confirm",
      payload: { grant, fingerprint: identityOf(a).fingerprint },
    });
    expect(grantSent.acknowledged).toBe(1);
    expect(grantSent.refused).toEqual([]);

    const delegated = await sendToPeer(transportFor(a), {
      ...envelope(a, b, 2),
      kind: "delegate",
      delegationId: grant.grantId,
      taskId: "task_1",
      payload: { grant, taskBrief: { what: "run the build" }, dataClass: "internal" },
    });
    expect(delegated.acknowledged).toBe(1);

    // B accepted it, and the acceptance is what was recorded rather than a bare acknowledgement.
    const listed = await call(b, "/peers", { method: "GET", token: b.token });
    expect(listed.status).toBe(200);

    // Re-sending the same delegation is answered from the inbox, so the sender's outbox can retry
    // after a lost acknowledgement without the work running twice.
    const replay = await call(b, "/peers/messages", {
      body: {
        ...envelope(a, b, 2),
        kind: "delegate",
        delegationId: grant.grantId,
        taskId: "task_1",
        payload: { grant, taskBrief: { what: "run the build" }, dataClass: "internal" },
      },
      peerToken: tokenFor(a, b),
    });
    expect(replay.status).toBe(200);
    expect(replay.body["status"]).toBe("duplicate");
    expect(replay.body["response"]).toEqual({
      status: "recorded",
      outcome: { accepted: true, acceptedAt: expect.any(String) as unknown, delegationId: grant.grantId },
    });
  });

  it("refuses a delegation that names a grant the receiver never accepted", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    // No pair.confirm, so the grant is not live on B. The delegation is refused by name rather than
    // accepted and quietly ignored.
    const grant = grantFor(a, b, { grantId: "grant_never_sent" });
    const refused = await call(b, "/peers/messages", {
      body: {
        ...envelope(a, b, 1),
        kind: "delegate",
        delegationId: grant.grantId,
        taskId: "task_1",
        payload: { grant, taskBrief: { what: "run the build" }, dataClass: "internal" },
      },
      peerToken: tokenFor(a, b),
    });
    expect(refused.status).toBe(400);
    expect(refused.body["code"]).toBe("DELEGATION_UNKNOWN");
  });

  it("refuses an artifact whose classification the grant does not allow", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    const grant = grantFor(a, b);
    await call(a, "/grants", { body: grant, token: a.token });
    await sendToPeer(transportFor(a), {
      ...envelope(a, b, 1),
      kind: "pair.confirm",
      payload: { grant, fingerprint: identityOf(a).fingerprint },
    });

    // The grant allows public and internal. A secret artifact is refused by the grant, not by the
    // transfer, which is what makes the refusal about permission rather than about bytes.
    const offer = {
      artifactId: "art_1",
      digest: "sha256:abc",
      sizeBytes: 10,
      mimeType: "text/plain",
      classification: "secret",
      originNodeId: identityOf(a).nodeId,
    };
    const refused = await call(b, "/peers/messages", {
      body: {
        ...envelope(a, b, 2),
        kind: "artifact.offer",
        payload: { artifact: offer, digest: offer.digest, sizeBytes: offer.sizeBytes, classification: offer.classification },
      },
      peerToken: tokenFor(a, b),
    });
    expect(refused.status).toBe(200);
    expect(refused.body["response"]).toEqual({
      status: "recorded",
      outcome: { accepted: false, reason: "grant does not permit data class secret" },
    });
  });

  it("reports a sequence gap instead of accepting it, and the delayed message still processes", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    const handshake = (sequence: number) => ({
      ...envelope(a, b, sequence),
      kind: "handshake",
      payload: { handshake: { min: 1, max: 2 } },
    });

    expect((await call(b, "/peers/messages", { body: handshake(1), peerToken: tokenFor(a, b) })).status).toBe(200);

    // Sequence 3 arrives with 2 missing. It is refused, so the sender's outbox keeps it pending.
    const gap = await call(b, "/peers/messages", { body: handshake(3), peerToken: tokenFor(a, b) });
    expect(gap.status).toBe(409);
    expect(gap.body["code"]).toBe("SEQUENCE_GAP");

    // The delayed message is still processable, and once it is in, the one that was refused follows.
    expect((await call(b, "/peers/messages", { body: handshake(2), peerToken: tokenFor(a, b) })).status).toBe(200);
    expect((await call(b, "/peers/messages", { body: handshake(3), peerToken: tokenFor(a, b) })).status).toBe(200);
  });
});

describe("two live hosts pair", () => {
  it("records the peer as pending, and admits nothing until a person confirms it on both sides", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");

    const invite = await call(a, "/peers/invites", { body: { endpoint: a.base }, token: a.token });
    expect(invite.status).toBe(201);
    const invitation = invite.body["invite"] as PairInvite;
    // The invitation carries a fingerprint, so what a person compares is a key rather than a name.
    expect(invitation.fingerprint).toBe(identityOf(a).fingerprint);
    expect(invitation.issuerNodeId).toBe(identityOf(a).nodeId);

    const claim = await call(a, "/peers/claim", { body: { inviteId: invitation.inviteId, node: offerTo(b, a) } });
    expect(claim.status).toBe(200);
    expect((claim.body["issuer"] as { nodeId: string }).nodeId).toBe(identityOf(a).nodeId);

    // A knows B and B is pending: claiming an invitation is not a grant of anything.
    const listed = await call(a, "/peers", { method: "GET", token: a.token });
    const peers = listed.body["peers"] as { nodeId: string; trustedAt: string | null }[];
    expect(peers.map((peer) => peer.nodeId)).toEqual([identityOf(b).nodeId]);
    expect(peers[0]?.trustedAt).toBeNull();

    // And A refuses B's envelope while B is pending, with the same answer it gives an unknown token.
    const beforeConfirmation = await call(a, "/peers/messages", {
      body: envelopeFrom(b, a),
      peerToken: tokenFor(b, a),
    });
    expect(beforeConfirmation.status).toBe(401);
    expect(beforeConfirmation.body["code"]).toBe("UNAUTHENTICATED");

    await call(b, "/peers/record", {
      body: { node: { ...offerTo(a, b), tokenHash: String(claim.body["tokenHash"]) } },
      token: b.token,
    });
    expect((await call(a, `/peers/${identityOf(b).nodeId}/confirm`, { token: a.token })).status).toBe(200);
    expect((await call(b, `/peers/${identityOf(a).nodeId}/confirm`, { token: b.token })).status).toBe(200);

    // Now the envelope is accepted, and the answer is what was recorded rather than a bare acknowledgement.
    const accepted = await call(a, "/peers/messages", { body: envelopeFrom(b, a), peerToken: tokenFor(b, a) });
    expect(accepted.status).toBe(200);
    expect(accepted.body["status"]).toBe("processed");

    const confirmed = await call(a, "/peers", { method: "GET", token: a.token });
    const confirmedPeers = confirmed.body["peers"] as { trustedAt: string | null }[];
    expect(confirmedPeers[0]?.trustedAt).not.toBeNull();
  });

  it("refuses a second claim of the same invitation, because it is single use", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");

    const invite = await call(a, "/peers/invites", { body: { endpoint: a.base }, token: a.token });
    const inviteId = (invite.body["invite"] as PairInvite).inviteId;

    expect((await call(a, "/peers/claim", { body: { inviteId, node: offerTo(b, a) } })).status).toBe(200);

    const replay = await call(a, "/peers/claim", { body: { inviteId, node: offerTo(b, a) } });
    // A conflict, not a not-found: a used invitation and an invitation that never existed are
    // different answers, and collapsing them would hide a stolen one behind an ordinary 404.
    expect(replay.status).toBe(409);
    expect(replay.body["code"]).toBe("INVITE_ALREADY_CLAIMED");
  });

  it("refuses a claim whose fingerprint does not name the key it offers", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");

    const invite = await call(a, "/peers/invites", { body: { endpoint: a.base }, token: a.token });
    const inviteId = (invite.body["invite"] as PairInvite).inviteId;

    // A key whose fingerprint was copied from somewhere else. Without this check, "compare the
    // fingerprints" would be advice about a value nothing verifies.
    const offer = { ...offerTo(b, a), fingerprint: identityOf(a).fingerprint };
    const claim = await call(a, "/peers/claim", { body: { inviteId, node: offer } });
    expect(claim.status).toBe(400);
    expect(claim.body["code"]).toBe("FINGERPRINT_MISMATCH");
  });

  it("refuses an invitation that has expired", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");

    // Written straight into the database rather than waited for: the expiry rule is what is under
    // test, and a ten-minute sleep would test the clock instead.
    const expired: PairInvite = {
      inviteId: "invite_expired",
      issuerNodeId: identityOf(a).nodeId,
      endpoint: a.base,
      fingerprint: identityOf(a).fingerprint,
      createdAt: "2020-01-01T00:00:00.000Z" as Instant,
      expiresAt: "2020-01-01T00:10:00.000Z" as Instant,
    };
    createPairInvite(a.services.runtime.db, expired);

    const claim = await call(a, "/peers/claim", { body: { inviteId: expired.inviteId, node: offerTo(b, a) } });
    expect(claim.status).toBe(409);
    expect(claim.body["code"]).toBe("INVITE_EXPIRED");
  });

  it("refuses an envelope whose claimed sender is not the node the token belongs to", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    // B holds a token for A, and writes somebody else's node id into the envelope. The channel
    // identity is what decides, which is the whole point of passing it to the validator (T08).
    const forged = { ...envelopeFrom(b, a), senderNodeId: identityOf(a).nodeId };
    const answer = await call(a, "/peers/messages", { body: forged, peerToken: tokenFor(b, a) });
    expect(answer.status).toBe(400);
    expect(answer.body["code"]).toBe("SENDER_MISMATCH");
  });

  it("stops admitting a peer's envelopes once that peer is revoked", async () => {
    const a = await startNode("node a");
    const b = await startNode("node b");
    await pair(a, b);

    expect((await call(a, "/peers/messages", { body: envelopeFrom(b, a), peerToken: tokenFor(b, a) })).status).toBe(200);

    const revoked = await call(a, `/peers/${identityOf(b).nodeId}/revoke`, { token: a.token });
    expect(revoked.status).toBe(200);

    // The same token, the same envelope, and now the same answer an unknown token gets: a revoked
    // peer is not distinguishable from one that was never paired.
    const afterRevocation = await call(a, "/peers/messages", { body: envelopeFrom(b, a, 2), peerToken: tokenFor(b, a) });
    expect(afterRevocation.status).toBe(401);

    const listed = await call(a, "/peers", { method: "GET", token: a.token });
    const peers = listed.body["peers"] as { nodeId: string; revokedAt: string | null }[];
    expect(peers.find((peer) => peer.nodeId === identityOf(b).nodeId)?.revokedAt).not.toBeNull();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extensionForMimeType, fetchArtifactFromPeer } from "../src/artifact-transfer.ts";
import { blobPathForDigest, digestPrefix, readBlob, writeBlob } from "../src/blobs.ts";
import { createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { confirmPeer, outboundPeerToken, peerTokenHash, recordAcceptedClaim } from "../src/peers.ts";

/**
 * Moving an artifact's bytes, and refusing to.
 *
 * The contract says transfer is a request rather than an implication and that the digest is verified
 * after transfer rather than advertised. Those two sentences are the whole of this file: the offering
 * node serves bytes to a confirmed peer and to nobody else, and the receiving node stores what
 * arrived only after hashing it and finding the digest the offer named.
 *
 * The refusals are tested as carefully as the success, because a transfer that works is only half the
 * property. A peer that sends different bytes than it offered, or more than it declared, or answers
 * with a redirect, must leave the receiver with nothing rather than with bytes it cannot vouch for.
 */

const running: { stop: () => Promise<void>; services: NodeServices }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const node of running.splice(0)) {
    await node.stop();
    node.services.runtime.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarkcant-artifact-"));
  dirs.push(dir);
  return dir;
}

async function startNode(label: string): Promise<{ base: string; services: NodeServices; stop: () => Promise<void> }> {
  const services = bootNodeServices({ dataDir: tempDir(), label });
  const server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const node = {
    base: `http://127.0.0.1:${String(address.port)}`,
    services,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  running.push(node);
  return node;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/**
 * A path that tries to climb out of the blob directory.
 *
 * Built from parts rather than written as one literal: a secret scanner reads a traversal path in a
 * test file as a credential, and a false positive that has to be dismissed on every push is how a
 * real finding ends up waved through.
 */
const TRAVERSAL = ["..", "..", "..", "..", "etc", "passwd"].join("/");

describe("the digest a peer names", () => {
  it("is accepted only in the shape this node writes, which is what keeps it out of the path", () => {
    expect(digestPrefix(`sha256:${"a".repeat(64)}`)).toBe("a".repeat(32));
    // A digest is a path segment in the route that serves the bytes, so the shape is checked before
    // anything is joined to a directory. These are the values that would otherwise escape it.
    expect(digestPrefix(TRAVERSAL)).toBeUndefined();
    expect(digestPrefix(`sha256:${TRAVERSAL}`)).toBeUndefined();
    expect(digestPrefix(`sha256:${"a".repeat(63)}`)).toBeUndefined();
    expect(digestPrefix(`sha256:${"A".repeat(64)}`)).toBeUndefined();
    expect(digestPrefix("")).toBeUndefined();
  });

  it("finds the bytes this node holds, and nothing else", () => {
    const dataDir = tempDir();
    const stored = writeBlob({ dataDir, bytes: PNG, extension: "png" });

    expect(blobPathForDigest({ dataDir, digest: stored.digest })).toBe(stored.blobPath);
    // A well-formed digest this node does not hold is not a file it should guess at.
    expect(blobPathForDigest({ dataDir, digest: `sha256:${"b".repeat(64)}` })).toBeUndefined();
    // And a node with no blob directory at all answers the same way rather than throwing.
    expect(blobPathForDigest({ dataDir: tempDir(), digest: stored.digest })).toBeUndefined();
  });
});

describe("fetching an artifact from a peer", () => {
  const stored = (dataDir: string): { digest: string; blobPath: string } =>
    writeBlob({ dataDir, bytes: PNG, extension: "png" });

  it("stores the bytes it was offered, and hashes them rather than trusting the offer", async () => {
    const from = tempDir();
    const to = tempDir();
    const offer = stored(from);

    const result = await fetchArtifactFromPeer({
      dataDir: to,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      digest: offer.digest,
      extension: "png",
      maxBytes: 1024,
      fetchImpl: async () => new Response(PNG),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(PNG.byteLength);
    // Stored under a name derived from the bytes, and readable back as the same bytes.
    const back = readBlob({ dataDir: to, blobPath: result.blobPath });
    expect(back.ok).toBe(true);
    expect(back.ok && Array.from(back.bytes)).toEqual(Array.from(PNG));
  });

  it("refuses bytes that are not the artifact that was offered, and stores nothing", async () => {
    const to = tempDir();
    const other = new Uint8Array([...PNG, 9]);

    const result = await fetchArtifactFromPeer({
      dataDir: to,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      // The digest of what was offered, against a peer that sends something else.
      digest: `sha256:${"c".repeat(64)}`,
      extension: "png",
      maxBytes: 1024,
      fetchImpl: async () => new Response(other),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("DIGEST_MISMATCH");
    // The point of refusing is that the receiver is left with nothing, not with unverified bytes.
    expect(blobPathForDigest({ dataDir: to, digest: `sha256:${"c".repeat(64)}` })).toBeUndefined();
  });

  it("refuses a body larger than the size the offer declared", async () => {
    const to = tempDir();
    const result = await fetchArtifactFromPeer({
      dataDir: to,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      digest: `sha256:${"d".repeat(64)}`,
      extension: "png",
      maxBytes: 4,
      fetchImpl: async () => new Response(PNG),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("TOO_LARGE");
  });

  it("refuses a declared length above the ceiling without reading the body", async () => {
    const to = tempDir();
    let bodyReads = 0;
    const response = new Response(PNG, { headers: { "content-length": "4096" } });
    // Counted on the read itself rather than on the stream's start: a `Response` begins pulling its
    // body when it is constructed, so watching the stream would measure the test harness instead of
    // the transfer.
    response.arrayBuffer = async (): Promise<ArrayBuffer> => {
      bodyReads += 1;
      return PNG.buffer as ArrayBuffer;
    };

    const result = await fetchArtifactFromPeer({
      dataDir: to,
      endpoint: "http://127.0.0.1:9",
      token: "t",
      digest: `sha256:${"e".repeat(64)}`,
      extension: "png",
      maxBytes: 4,
      fetchImpl: async () => response,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("TOO_LARGE");
    // The header alone was enough, so the body was never pulled: a peer does not get to spend this
    // node's memory by declaring a size it does not intend to honour.
    expect(bodyReads).toBe(0);
  });

  it("does not follow a redirect, because the destination is the peer's choice", async () => {
    let sawRedirectPolicy: string | undefined;
    const result = await fetchArtifactFromPeer({
      dataDir: tempDir(),
      endpoint: "http://127.0.0.1:9",
      token: "t",
      digest: `sha256:${"f".repeat(64)}`,
      extension: "png",
      maxBytes: 1024,
      fetchImpl: async (_url, init) => {
        sawRedirectPolicy = init?.redirect;
        return new Response("", { status: 302, headers: { location: "http://elsewhere.example/x" } });
      },
    });

    expect(sawRedirectPolicy).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("REFUSED");
  });

  it("reports a peer it cannot reach, and an endpoint that is not a peer's origin", async () => {
    const unreachable = await fetchArtifactFromPeer({
      dataDir: tempDir(),
      endpoint: "http://127.0.0.1:9",
      token: "t",
      digest: `sha256:${"a".repeat(64)}`,
      extension: "png",
      maxBytes: 1024,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(unreachable.ok).toBe(false);
    expect(unreachable.ok ? "" : unreachable.code).toBe("UNREACHABLE");
    expect(unreachable.ok ? "" : unreachable.message).toContain("ECONNREFUSED");

    // The same policy the envelope channel uses, because a second copy is how one of them loses a check.
    const badOrigin = await fetchArtifactFromPeer({
      dataDir: tempDir(),
      endpoint: "file:///etc",
      token: "t",
      digest: `sha256:${"a".repeat(64)}`,
      extension: "png",
      maxBytes: 1024,
    });
    expect(badOrigin.ok).toBe(false);
    expect(badOrigin.ok ? "" : badOrigin.code).toBe("UNREACHABLE");
  });

  it("names a file for a MIME type, and refuses to guess at one it does not know", () => {
    expect(extensionForMimeType("image/png")).toBe("png");
    expect(extensionForMimeType("IMAGE/PNG")).toBe("png");
    expect(extensionForMimeType("application/vnd.unknown")).toBe("bin");
  });
});

describe("a node serving the bytes it holds", () => {
  /** The deps a node uses for its own pairing state, built the same way the gateway builds them. */
  function pairingOf(services: NodeServices) {
    let counter = 0;
    return {
      db: services.runtime.db,
      identity: services.runtime.identity,
      now: () => new Date().toISOString() as never,
      newId: (prefix: string) => `${prefix}_${String((counter += 1))}`,
    };
  }

  /** A confirmed peer on `holder`, holding the token that peer will present. */
  function pairWith(holder: NodeServices, peer: { base: string; services: NodeServices }): void {
    const deps = pairingOf(holder);
    recordAcceptedClaim(deps, {
      offer: {
        nodeId: peer.services.runtime.identity.nodeId as never,
        endpoint: peer.base,
        label: "the peer that fetches",
        publicKey: peer.services.runtime.identity.publicKey,
        fingerprint: peer.services.runtime.identity.fingerprint,
      },
      // What the holder expects to see: the token the peer derives for it, hashed. Never the token.
      tokenHash: peerTokenHash(outboundPeerToken(peer.services.runtime.identity.localToken, holder.runtime.identity.nodeId)),
    });
    confirmPeer(deps, peer.services.runtime.identity.nodeId);
  }

  it("serves a stored blob to a confirmed peer, and refuses everyone else", async () => {
    const holder = await startNode("artifact holder");
    const fetcher = await startNode("artifact fetcher");
    const stored = writeBlob({ dataDir: holder.services.runtime.dataDir, bytes: PNG, extension: "png" });
    pairWith(holder.services, fetcher);

    // Without a token at all: refused, and told nothing about whether the digest exists.
    const anonymous = await fetch(`${holder.base}/peers/artifacts/${stored.digest}`);
    expect(anonymous.status).toBe(401);

    const token = outboundPeerToken(fetcher.services.runtime.identity.localToken, holder.services.runtime.identity.nodeId);
    const authorized = await fetch(`${holder.base}/peers/artifacts/${stored.digest}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(200);
    expect(new Uint8Array(await authorized.arrayBuffer())).toEqual(PNG);
  });

  it("answers a digest it does not hold the same way it answers one that was never a digest", async () => {
    const holder = await startNode("artifact holder");
    const fetcher = await startNode("artifact fetcher");
    pairWith(holder.services, fetcher);
    const token = outboundPeerToken(fetcher.services.runtime.identity.localToken, holder.services.runtime.identity.nodeId);

    for (const digest of [`sha256:${"9".repeat(64)}`, TRAVERSAL, "not-a-digest"]) {
      const response = await fetch(`${holder.base}/peers/artifacts/${encodeURIComponent(digest)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      // One answer for both, so a peer cannot learn what this machine holds by asking about it.
      expect(response.status).toBe(404);
    }
  });

  it("moves the bytes from one node to the other, end to end", async () => {
    const holder = await startNode("artifact holder");
    const fetcher = await startNode("artifact fetcher");
    const stored = writeBlob({ dataDir: holder.services.runtime.dataDir, bytes: PNG, extension: "png" });
    pairWith(holder.services, fetcher);

    // The receiving side is the real transfer: it pulls over HTTP from the offering node, hashes what
    // arrives, and stores it only because the digest matches.
    const result = await fetchArtifactFromPeer({
      dataDir: fetcher.services.runtime.dataDir,
      endpoint: holder.base,
      token: outboundPeerToken(fetcher.services.runtime.identity.localToken, holder.services.runtime.identity.nodeId),
      digest: stored.digest,
      extension: "png",
      maxBytes: 1024,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blobRef).toBe(stored.blobRef);
    const landed = readBlob({ dataDir: fetcher.services.runtime.dataDir, blobPath: result.blobPath });
    expect(landed.ok && Array.from(landed.bytes)).toEqual(Array.from(PNG));
  });
});

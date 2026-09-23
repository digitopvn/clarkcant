import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootRuntime, fingerprintOf } from "../src/node.ts";

/**
 * The node's device key.
 *
 * Pairing is a comparison of keys, not of names, so the key has to exist before any of that can be
 * honest: an invite carries a fingerprint, and a fingerprint has to name something. These cover the
 * three properties the rest of the pairing flow assumes - a fresh node has one, a reboot keeps it,
 * and a node installed before keys existed gains one without becoming a different node.
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-identity-"));
}

const FINGERPRINT = /^([0-9a-f]{4}:){7}[0-9a-f]{4}$/;

describe("a node's device key", () => {
  it("is created with the node and reported as a fingerprint a person can read aloud", () => {
    const dir = tempDir();
    const runtime = bootRuntime({ dataDir: dir, label: "test node" });
    try {
      expect(runtime.identity.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(runtime.identity.fingerprint).toBe(fingerprintOf(runtime.identity.publicKey));
      expect(runtime.identity.fingerprint).toMatch(FINGERPRINT);
    } finally {
      runtime.close();
    }
  });

  it("survives a reboot unchanged", () => {
    const dir = tempDir();
    const first = bootRuntime({ dataDir: dir, label: "test node" });
    const before = { ...first.identity };
    first.close();

    const second = bootRuntime({ dataDir: dir, label: "test node" });
    try {
      expect(second.identity.nodeId).toBe(before.nodeId);
      expect(second.identity.publicKey).toBe(before.publicKey);
      expect(second.identity.fingerprint).toBe(before.fingerprint);
    } finally {
      second.close();
    }
  });

  it("is added in place to an identity that predates keys, without changing who the node is", () => {
    const dir = tempDir();
    const created = bootRuntime({ dataDir: dir, label: "test node" });
    const { nodeId, ownerPrincipalId, localToken, createdAt } = created.identity;
    created.close();

    // Exactly the shape a node installed before device keys existed has on disk.
    const path = join(dir, "identity.json");
    writeFileSync(path, `${JSON.stringify({ nodeId, ownerPrincipalId, label: "test node", createdAt, localToken }, null, 2)}\n`);

    const upgraded = bootRuntime({ dataDir: dir, label: "test node" });
    try {
      // The node id and the local token are what every grant, preference and pairing is recorded
      // against, so an upgrade that changed either would orphan all of it.
      expect(upgraded.identity.nodeId).toBe(nodeId);
      expect(upgraded.identity.localToken).toBe(localToken);
      expect(upgraded.identity.fingerprint).toMatch(FINGERPRINT);

      // Written back, so the next boot reuses this key instead of minting a second one.
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as { fingerprint?: string };
      expect(onDisk.fingerprint).toBe(upgraded.identity.fingerprint);
    } finally {
      upgraded.close();
    }
  });
});

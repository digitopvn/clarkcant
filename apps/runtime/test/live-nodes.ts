import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import { PEER_FEATURES } from "@clarkcant/contracts";

import { outboundPeerToken, peerTokenHash } from "../src/peers.ts";
import { createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Real nodes for a test: each its own data directory, database and port, with real HTTP between them.
 *
 * Shared by the journeys that need two Clarks — a peer's signal, a delegated task — so each one pairs them the way a
 * person does rather than by writing rows, and a change to pairing breaks them all at once instead of one quietly.
 */

export interface LiveNode {
  base: string;
  services: NodeServices;
  /** The local bearer token: what authorizes commands on this machine, and never what a peer holds. */
  token: string;
  stop: () => Promise<void>;
}

export interface CallResult {
  status: number;
  body: Record<string, unknown>;
}

export function liveNodes(): {
  start: (label: string, prepare?: (services: NodeServices) => void) => Promise<LiveNode>;
  stopAll: () => Promise<void>;
} {
  const running: LiveNode[] = [];
  const dirs: string[] = [];
  return {
    async start(label, prepare) {
      const dir = mkdtempSync(join(tmpdir(), "clarkcant-live-node-"));
      dirs.push(dir);
      const services = bootNodeServices({ dataDir: dir, label });
      prepare?.(services);
      const server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const node: LiveNode = {
        base: `http://127.0.0.1:${String(address.port)}`,
        services,
        token: services.runtime.identity.localToken,
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
      running.push(node);
      return node;
    },
    async stopAll() {
      for (const node of running.splice(0)) {
        node.services.automation?.stop();
        node.services.peerDelivery?.stop();
        await node.stop();
        node.services.runtime.close();
      }
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

export async function call(
  node: LiveNode,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<CallResult> {
  const response = await fetch(`${node.base}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

export function identityOf(node: LiveNode) {
  return node.services.runtime.identity;
}

/** The token a node presents to a specific peer. Derived, so both sides can compute it without it travelling. */
export function tokenFor(presenter: LiveNode, peer: LiveNode): string {
  return outboundPeerToken(identityOf(presenter).localToken, identityOf(peer).nodeId);
}

function offerTo(node: LiveNode, peer: LiveNode, advertise: boolean): Record<string, unknown> {
  return {
    nodeId: identityOf(node).nodeId,
    label: identityOf(node).label,
    endpoint: node.base,
    publicKey: identityOf(node).publicKey,
    fingerprint: identityOf(node).fingerprint,
    tokenHash: peerTokenHash(tokenFor(node, peer)),
    ...(advertise ? { features: [...PEER_FEATURES] } : {}),
  };
}

/**
 * Pair two live nodes the way a person would: an invitation, a claim, and a confirmation on each side.
 *
 * `advertise` has each offer say what its node takes, as this build's own pairing does; without it the offers are a
 * build's from before features, and each node learns the other's from the answers to what it delivers.
 */
export async function pair(a: LiveNode, b: LiveNode, options: { advertise?: boolean } = {}): Promise<void> {
  const advertise = options.advertise === true;
  const invite = await call(a, "/peers/invites", { body: { endpoint: a.base }, token: a.token });
  expect(invite.status).toBe(201);
  const inviteId = (invite.body["invite"] as { inviteId: string }).inviteId;
  const claim = await call(a, "/peers/claim", { body: { inviteId, node: offerTo(b, a, advertise) } });
  expect(claim.status).toBe(200);
  const record = await call(b, "/peers/record", {
    body: { node: { ...offerTo(a, b, advertise), tokenHash: String(claim.body["tokenHash"]) } },
    token: b.token,
  });
  expect(record.status).toBe(201);
  expect((await call(a, `/peers/${identityOf(b).nodeId}/confirm`, { token: a.token })).status).toBe(200);
  expect((await call(b, `/peers/${identityOf(a).nodeId}/confirm`, { token: b.token })).status).toBe(200);
}

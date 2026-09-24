# Distributed Runtime & Deployment

> English (default) · [Tiếng Việt](distributed-runtime.vi.md)

**Baseline:** blueprint v2, 16/09/2026. NodeLink is the proposed protocol between installations of the app. This does not claim that Pi or A2A already provide all of these semantics.

## 1. Collaboration model: autonomous nodes, one unified conversation

Choose **controlled federation**, not distributed shared memory and not a swarm that talks to itself without end. Each node runs independently. A conversation has a home node that keeps the ordered user timeline; other nodes are given scoped tasks and return events/artifacts.

Example:

```text
Desktop conversation client
    -> Home runtime on VPS A
         -> Desktop node: read files that have been permitted
         -> VPS A: aggregate data and keep the timeline
         -> VPS B: build/test in the workspace on B
```

Or the local desktop is home and VPS A/B are executors. The user does not need to choose a topology on every prompt; onboarding/an explicit request sets the home, and the router picks the executor by permissions/locality. The user can still ask "which machine is this running on?" or "don't send source off the laptop".

Initial scope: same owner, several machines. There is no implicit transitive trust: A pairing B and B pairing C does not give A rights on C. Raw user prompts/secrets are never forwarded to the whole network to ask who will take the job.

## 2. Which protocol is used for what?

| Protocol | Role in the app | Does not replace |
|---|---|---|
| App command/event API | Client ↔ runtime, state/surface/actions | Vendor OAuth or OS isolation |
| Native NodeLink | Node ↔ node delegation, grants, correlated events, artifacts | Shared filesystem/multi-master database |
| MCP | Calling tools/resources from existing services | Managing the whole conversation/runtime |
| MCP Apps | UI resource + host bridge for tool apps [R06–R08] | The app's own pin lifecycle and data ownership |
| A2A | Adapter to agents outside the ecosystem, roadmap [R10] | App-specific UI/state replay/permissions/installation |
| Tailscale/private network | One reachability and encrypted-network option [R28] | App identity/grants or user approval |

Do not implement every standard in full in the first milestone. MCP/MCP Apps are in the baseline; the external A2A adapter keeps an extension seam but is not required for a certified release.

## 3. Deployment profiles

### 3.1 Local desktop

The app bundle contains the runtime and the UI. Private local socket + authenticated handshake. No public port, no mandatory cloud account. Node pairing is enabled only when the user asks to connect a machine.

### 3.2 Headless server

Non-root OCI core image, persistent data volume, loopback/private bind by default. TLS ingress and application auth must be checked before remote use. The user opens web chat or attaches with the desktop client; the server needs no monitor/GPU/browser engine for text/runtime.

Native alternative: signed/checksummed release bundle, unprivileged service account, systemd unit with tested hardening. Config/secrets are not put into world-readable flags or shell history. The user is not made to install Node/Pi globals; the launcher uses the bundled runtime.

### 3.3 Browser worker

The browser driver/binary is added when needed; the engine version is matched to the pinned Playwright. Managed profiles live on a suitable encrypted/restricted volume; a profile directory is never shared between two browser processes. CDP is private only and authenticated through the broker; the raw port is never exposed.

### 3.4 Virtual desktop worker

Optional Linux image with a desktop/display server and an input/screenshot adapter. It is not a "headless=false" flag on a server with no display. Preview/human takeover goes over an authenticated short-lived transport. By default it does not mount the host home, host display or Docker socket; egress/CPU/memory/PIDs are restricted. A container is not treated as equivalent to a VM against a host-kernel adversary.

## 4. Bootstrap and pairing

Installing the binary/image is a bootstrap step outside the model while no app exists yet. Goal: an installer or a short sample command provided by the actual release, then all setup through chat. The user is not required to learn the terminal for day-to-day operation.

Pairing flow:

1. The target node creates a device identity and a single-use, short-expiry invite; no resource rights are opened yet.
2. The user puts the endpoint/invite into chat or scans a QR code on a trusted client. Invite secrets are not stored verbatim in the long-term transcript.
3. The client shows the host fingerprint/node name and network reachability. TLS/mTLS or a signed app handshake verifies the key; a DNS endpoint is not enough to trust a node.
4. The owner confirms the node pair and the initial grants: for example only `projects.read`, `build.run` on a specific workspace, no host filesystem/root shell.
5. Receiver policy checks its own limits; stores the trust relationship + bounded delegation permissions.
6. Probe, capability negotiation and a real status card. "Paired" is different from "can run Browser Use" or "already has credentials".

An invite/QR is not a long-lived OAuth access token. A replayed invite is rejected; key rotation needs an authenticated transition; a lost device/revoke removes rights from the next call and stops accepting new delegations. Already submitted effects may need reconciliation.

**Shipped state (2026-09-20).** Pairing runs for real between two live nodes: two nodes, two ports, two databases, real HTTP between them. The device key is Ed25519 generated in place and stored in `identity.json` readable only by the owner; the fingerprint is the sha256 of the public key printed in groups of four characters so a person can read it aloud. The invite is single-use and expires after 10 minutes; a claim records the peer in the **pending** state, and a pending peer has its envelopes rejected rather than queued. The channel opens only when a person confirms on **both** sides.

The token each node presents to its peer is **derived** as `HMAC(localToken, peerNodeId)`. This means no credential crosses the wire during pairing (the two sides only exchange sha256 values), and only the sha256 sits in the database — so a copy of the database cannot be replayed at the peer. The transport is HTTP to the peer's own gateway (`/peers/messages`), with a durable outbox (intent is written before sending) and dedup by message id on the receiving side.

**Not yet.** `NodeLinkTransport` in `packages/node-link` is still a stub for a socket-style transport: no TLS/mTLS yet, no WebSocket, no keepalive or reconnect cursor. Step 3 says TLS/mTLS or a signed app handshake verifies the key — today key verification is **fingerprint comparison**, and the channel is HTTP, so only a node reachable over plain HTTP can pair today. Step 4 (initial grants) and step 6 (probe, capability negotiation, status card) still belong to P4. The delegation path is wired: the owner writes a grant (`POST /grants`), that grant travels to the peer in the `pair.confirm` envelope, and from then on a `delegate` envelope naming exactly that grant is accepted while one naming an unknown delegation is rejected with `DELEGATION_UNKNOWN`. The receiver's accept policy is the **intersection** of the live grants from that sender — following the contract rule that a grant is only narrowed, never widened by holding another grant; a grant that does not set `maxArtifactBytes` allows **zero** bytes. Artifacts are currently only **evaluated**; no bytes are transferred yet. A sequence gap is reported with `SEQUENCE_GAP` and a peer's cursor only advances contiguously, so a late message is still processed instead of being treated as a regression.

If neither node is reachable, the app explains that a private-network adapter or a reachable gateway is needed. Choose the Tailscale adapter or an operator TLS endpoint; **do not promise connectivity through every firewall when no supporting infrastructure exists**. Do not build a bespoke relay/NAT traversal in the foundation beta. A public client/browser over Tailscale still needs network access and properly configured HTTPS.

## 5. Trust and delegation grants

A minimal grant has owner, senderNodeId, receiverNodeId, permitted capability IDs, resource refs, expiry, budget, allowed data classes and delegation depth. The receiver intersects it with local policy; the sender cannot raise the receiver's rights through a prompt.

The principal of an invocation consists of the verified peer identity and the delegated origin user; self-declared identity fields in JSON are not trusted. A pack must not mint grants itself or use the credentials of a connection outside its scope.

Delegation carries the task brief/context that is needed. Do not copy the whole Pi session if only a build command is needed. Artifact transfer is a separate request with source/destination, MIME/size/digest, classification and user grant. A remote workspace must already exist or be cloned/created by an explicit task.

## 6. Proposed NodeLink envelope

```typescript
// Internal app schema proposal, validate with discriminated unions in code.
interface PeerEnvelope {
  protocol: 'agent.nodelink';
  version: 1;
  messageId: string;
  correlationId: string;
  senderNodeId: string;
  recipientNodeId: string;
  kind: 'delegate' | 'accepted' | 'status' | 'input.request'
      | 'input.response' | 'cancel.request' | 'result' | 'artifact.offer';
  delegationId: string;
  taskId: string;
  expectedTaskRevision?: number;
  runId?: string;
  executionEpoch?: number;
  sourceSequence?: number;
  payload: unknown; // Mandatory per-kind runtime validation, never passed through.
}
```

Headers/signatures/auth channel bind the actual sender. `senderNodeId` alone is not proof of identity. A resource reference is `(nodeId, opaqueResourceId, resourceVersion)`; no remote `file://` or local absolute path assembled by the model.

The default transport is HTTPS request/response for commands and WSS for events. Keepalive/backpressure/rate/size limits, reconnect with cursor. An indefinitely open connection is never the source of truth; durable data lives in the DB.

## 7. Delivery semantics

**At-least-once delivery + durable dedup**; exactly-once external effects are not claimed. The sender writes intent/outbox before sending. The receiver transaction writes the inbox dedup and the accepted task, and only then acks. Worker start goes from the receiver outbox.

If the sender loses the ack, it resends the same command/delegation ID. The receiver returns the known accepted/outcome and does not create a new run. Event sourceSequence increases monotonically per node/stream; the home dedups and projects them into its own timeline. There is no "global order" created from wall-clock time across machines.

Every peer event keeps its original provenance; a home summary must not lose the unknown/waiting_approval state. Worker token deltas may be coalesced/transient; approvals/effects/result commits are durable.

## 8. Failure matrix

| Situation | Correct behavior |
|---|---|
| Desktop client closed, home on VPS | Home/jobs continue; reconnect replays |
| Home desktop asleep, worker on VPS | Worker continues within the granted grant/budget; does not pretend home is online; waits when input is needed |
| Peer loses network before accepted | Sender stays pending, retries with the same ID; no job is created on another node |
| Network lost after an external effect | Receiver reconciles; home shows unknown, does not repeat the effect |
| Home restart | Load snapshot/outbox/inbox, reconcile peers before any new risky dispatch |
| Executor restart | Recover task/effect ledger; old process/status must be verified, not just read from JSONL |
| Two nodes on the same remote Git repo | Local worktree locks are not enough; push relies on expected remote ref / conflict handling, no automatic force |
| Key revoked while a task is running | Block new commands/delegations; cancel/reconcile according to the granted scope, report clearly which effects already went out |
| Package version mismatch | Negotiate capability version or unavailable; never change the schema silently |
| No supported auth/OS driver | Task waits for setup or switches approach after consent; never pretends to be ready |

**No automatic home failover in v0.2.** Moving home is a future explicit export/migration/drain gate. Never let two nodes both append to the authoritative timeline because of a network partition. "Smooth" does not mean hiding a failure.

## 9. Cross-node approvals and input

The executor emits `input.request`/`approval.request` bound to the exact operation, account/node/resource/digest and expiry. The home renders a **host-owned** card; the user decision is authenticated and returned to the exact request. The executor revalidates that the request is still current before executing.

Pairing consent does not mean approving all deployments/money transfers/message sends. A widget can propose an invocation but cannot issue a new grant itself. When a node needs secrets, the secure auth channel terminates at that node's vault; the home model only receives connectionRef/status.

## 10. Budgets and avoiding agent chatter

Default executor pool of 2 workers per node, configurable per machine; a separate conductor slot. Global conversation budget, per-task depth/hops cap (proposed depth 2, approved nodes), timeout and token limits. Numeric defaults are targets to be measured, not benchmarks.

A subagent may not broadcast to the whole network looking for work. A worker requests a capability through the scheduler; the scheduler chooses the executor. Progress polling is deterministic and does not create LLM ping-pong. Cross-node plans have bounded subtasks and clear completion criteria.

## 11. Ops, backup, upgrade

- Separate quotas for sessions/artifacts/browser profiles/images; a full disk must stop safely without corrupting success state.
- Consistent DB backup + content manifest; key backup has its own policy. Live-copying WAL files with an ad-hoc script and calling it a valid backup is not acceptable.
- Upgrade drains affected runs, verifies protocol compatibility, snapshots the DB, migrates transactionally where appropriate, boots a healthcheck. Rolling back package activation is different from rolling back an irreversible DB migration; a migration failure needs a tested restore path.
- Peers reconnect within the negotiated version window; an incompatible node keeps read/status if supported and does not accept new effects.
- Logs carry task/run/peer/connection/widget traces but redact secrets/tokens/content by default.
- Server uninstall does not delete project/remote account data; token revoke and runtime-data removal are separate choices.

## 12. Required release proof

Clean macOS + two independent Linux VPS/namespaces run J4. Try one real network topology with TLS/private networking; a local mock is not enough to prove NAT/reachability. Measure reconnect, duplicate delivery, revoked grants, unknown effects, dependency/version mismatch and node restart.

Sources for protocol/tool separation and connectivity: [R06–R10, R28](research-and-decisions.md). The ownership/delivery/policy semantics here are design choices of the app.

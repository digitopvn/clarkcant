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

**Signals between paired nodes (issue #244).** A node tells a confirmed peer that something happened with `POST /peers/{nodeId}/signals` on its own gateway; the signal goes into the outbox as a NodeLink `signal` message and a delivery pass on the node carries the outbox to its peers — at once when something is queued, and every 30 seconds after that, with the outbox's own backoff and dead-lettering. A `signal` is a fact, never a command: it carries no grant and asks for nothing. The receiver records it with the sender the authenticated channel names, never the one the envelope claims, under the topic `peer.<topic>`, so a peer cannot pass its news off as a GitHub delivery, a signed webhook or a timer; only the standing requests the receiving node's owner set up there decide what it starts. The same event sent again is recorded once. A node sends nothing to a peer that is unknown, pending or revoked.

**Tasks between paired nodes (issue #244).** A task automation can name a confirmed peer as the node that runs it (`executor`, chosen from `list_peers`). When the automation is set up, the sending node's owner writes a task grant for exactly its folders, repositories and effects, and that grant travels in `pair.confirm`; each run then queues a `delegate` whose brief is the goal, those resources and those effects, under a task id the sender chose, so a resent hand-over finds the same task instead of starting a second one. The receiving node runs nothing its own owner has not allowed: its owner allows a peer with `allow_peer_tasks` (folders, repositories, effects — `stop` withdraws it), the hand-over is checked against the stored grant **intersected** with that allowance, resources must match exactly, and the task is created with origin `delegated` and only the effects both sides allowed. Any other effect waits for the receiving node's owner in every execution mode, even a local write a general rule would let through. Every outcome goes back as a `result`: done, failed, refused (with the reason, said on both sides), stopped, or unknown because the receiver restarted part-way. The sender accepts it only from the node the task was handed to, records the peer's run and its receipt as evidence on its own task, and each owner hears it in the conversation they set it up from. A stop on the sender travels as `cancel.request`: the receiver ends the worker it runs for the task, and its answer — stopped, or unknown when the worker finished anyway — confirms it. A hand-over under a grant that has expired or been revoked is answered with that reason. A hand-over or a stop the sender gives up delivering settles its task all the same: failed when the peer refused it, unknown when the peer never answered. A `pair.confirm` whose grant was written by the receiving node's own owner, or that reuses a held grant id for another pair of nodes, is refused. **Follow-ups (issue #253).** While the task waits on the receiving owner's approval, the receiver sends `status` (`waiting_approval`, and `running` once allowed); the sender's owner hears it in the conversation and the inbox, with the task still `running` on the sender, because only the receiving owner can decide. A refusal or an approval left to expire ends the task on the receiver and goes back as a `result` that it never ran, so the sender's task settles instead of waiting. Each executor automation records its own grant (`grantId` on its action) and its runs go under that grant only; pausing or removing it withdraws that grant on both nodes with `revoke`, and resuming writes a new one. A per-run time limit (`maxMinutesPerRun`) travels as the grant's `budget.maxWallClockMs`; the receiver applies the grant's budget, intersected with its own allowance, to the task it creates (time and tokens) and refuses a hand-over past the grant's `maxRuns`. Artifact return is still open (#263).

**What a peer can run for this node (issue #264).** Before a task is handed over, the sending node can ask a confirmed peer what it can run for it: `GET /peers/capabilities` on the peer's gateway, with the derived peer token, answered only to a paired peer (anything else is `401`) and asked only of a peer that advertises `capabilities`. The answer is a versioned, strict summary `{ version: 1, allowed, capabilities: [{ ref, ready }] }` (at most 32 entries) built from nothing but the receiving owner's `allow_peer_tasks` allowance for that peer: the capability refs the allowance covers (`project.file.read@1`, plus `project.code.change@1` when it allows writing), each with whether that node can run it now — the same check a hand-over is decided by. No folder, no other capability the node runs and no reason leave the node, and a peer that was allowed nothing hears `allowed: false` and nothing more. `list_peers` shows each peer's answer, and `create_automation` with an `executor` adds a warning — never a refusal — when the peer's owner has not allowed this node, does not allow the capability the task needs, or the peer cannot run it right now; a peer that could not be asked (an older build, no answer within 5 seconds, an answer that is not a summary) is said to be unknown. The answer is a snapshot and only warns: the receiving node's own check when a task arrives still decides. When a hand-over reaches a node that allows it but cannot run its capability yet (a pack still loading, for example) and the sender advertises `capabilities`, the receiver keeps the task in `waiting_capability` instead of refusing it, tells its own owner, and at once sends `status` `waiting_capability` naming the `capabilityRef`; the sender's owner hears in the conversation and the inbox which capability it waits for, while the sender's task stays `running`. When the capability becomes usable the task runs by itself and the receiver sends `status` `running` with that `capabilityRef`; a stop from the sender ends a waiting task at once. A hand-over from a sender that does not advertise `capabilities` — a build from before this — is refused at once, as before. The route and both statuses ride the existing envelope at protocol version 1: the advertised feature versions them, and no storage migration was needed. Each node learns the other's features from pairing offers and from the answers to what it delivers, so on a pairing made before this build the peer is shown as unknown, and a hand-over it cannot run yet is refused as before, until each node has delivered something to the other.

**Notices between paired nodes (issue #170).** A node puts something in a confirmed peer's inbox with a NodeLink `notice` message: words and a key, nothing more. The producer for now is `POST /peers/{nodeId}/notices`, so local tools can tell a paired Clark that takes notices; a node sends none on its own, and a task a peer handed over reaches the sender through its `result`, not a notice. Only a decision the receiving node's owner made admits a peer's notices: a live grant the receiver wrote to that peer, or a live `allow_peer_tasks` allowance for it. A grant the sender wrote, or a pairing alone, does not count. Anything else is refused with a code (`PEER_NOT_ALLOWED`, `RATE_LIMITED`, `NOTICE_UNREADABLE`, `NOTICES_OFF`) and the reason, and that refusal is final: it is an answer, not a failed delivery, so the sender does not retry it. Because the route had already answered `202`, the sender records the refusal on the message's outbox row and tells its own owner in the inbox — once per peer and reason — which notice did not arrive, why, that nothing was recorded there and it is not sent again, and what would change that (for example, the other owner allowing work with this Clark). The receiver takes at most 30 notices a minute from one peer and refuses the rest the same way; it keeps at most 20 undismissed notices from one peer, dropping that peer's oldest and never the node's own or another peer's. A notice is recorded as the peer's (`sourceKind` `peer`, `originNodeId` the sender the authenticated channel names, subject `peer`) under the key `peer:<senderNodeId>:<key>`, so at-least-once delivery and replays land once. Its title and body are bounded by the contract and treated as data (control, bidi and zero-width characters removed), and the sender can never contribute actions: what can be done with a notice is decided by the receiving host. A peer's notice links to a conversation on the receiving node only when it is about a task that node handed to that very peer. The waiting item clears on both sides: the sender's "waiting on the other owner" notice is dismissed when the receiver reports `running`, when a result from the executing node arrives (including a refusal or an expiry), or when the sender gives up delivering and settles the task. Deciding the receiver's approval **from the sender** is not implemented: that needs a grant capability for remote decisions, with the owner verified and the decision bound to the operation digest (#274).

**What a peer says it takes.** A node sends notices only to a peer that has said it takes them. Every `200` from `POST /peers/messages` carries `features` (today `["notice", "skip", "capabilities"]`) and the answering node's `label`, and so does a `409` `SEQUENCE_GAP`; a pairing offer carries them too; the sender records both for that peer, and only from those two places. Unknown features are dropped and at most 16 are read; the label is treated as data (control, bidi and zero-width characters removed, whitespace collapsed, at most 64 characters, empty means none). An answer without `features` — a build from before this — clears what the peer said, so a node that was downgraded gets no notices, and `POST /peers/{nodeId}/notices` answers `409` `NOTICES_UNSUPPORTED`, saying what to do: a node paired before features existed learns them from the peer's answer to anything it delivers, so sending that peer a signal first refreshes them, and a peer running an older build needs updating. Every other NodeLink message works as before with such a peer. The two columns come from storage migration 34. The answer is read within bounds: one delivery has 30 seconds, answer included, and at most 16 KiB of the answer is read. Past either, the answer is ignored — the message stays acknowledged when the status was `200`, and a delivery that got no answer in time is retried like any other — so a slow, stalled or oversized answer from one peer cannot hold the delivery pass, the other peers behind it, or the outage check after it.

**A peer that cannot be reached.** When delivery to a confirmed peer has been failing for more than 10 minutes, the node records one notice per outage. The outage is read from the outbox's own retry state, not a second record: a message still being retried whose last attempt failed after the peer's last acknowledgement. What the notice says follows the last failure. If the peer did not answer, it says the device has not answered since a given time, that what is owed stays in the outbox and is still retried automatically for a while, and to turn the device on or pair again if it is off or has moved. If the peer answered with a `4xx`, it says the device answers but refuses, with the status, and to check the pairing or update ClarkCant — not to turn anything on. If it answered with a `5xx`, it says the device is on but ClarkCant there failed to handle it, that the messages are still retried, and to look at ClarkCant on that device and restart or update it. When everything owed has been given up on (dead-lettered) since the last acknowledgement, it says sending stopped and those messages will not be sent again, with no promise of retries, that the tasks handed to that device were settled in their conversations, and to send again what is still needed once the device works. The 10 minutes count only time this process watched: the clock starts at the later of the oldest failure, the process start, and the last wake from sleep (a delivery tick that came more than twice its interval late), so a restart or a laptop lid does not raise a notice at once for an old failure; when that moved the start, the notice says "at least since". Times are shown in the node's own time zone, with the zone. One outage — everything between two acknowledgements — has one notice showing at a time: each change of what is wrong within it is a new notice under the next step of the outage's key (`peer-offline:<peer>:<lastAck|never>:<step>:<situation>`), replacing the previous one, so a situation that comes back (unreachable, given up, unreachable again) is said again rather than lost in a dismissed row. While the situation stays the same it is the same notice, so one the person dismissed stays dismissed, and the next outage is a new one. It is dismissed as soon as the peer acknowledges anything again, and when the pairing is revoked. A message given up on still settles its task as before. The notice names the peer by the label it gave, or by node id when it gave none.

**A message given up on (issue #277).** Because the receiver refuses everything past a gap, one message given up on used to leave every later message to that peer refused for good. Now a node that gives up on a message sends a peer that advertises `skip` a NodeLink `skip` message in its place, and what follows is delivered. The skip lists what was given up on (sequence, message id, kind and task id, at most 50 per skip), covers only messages above the highest sequence the peer acknowledged and below the lowest one still owed, and occupies the sequence of the last one it covers, so it can never skip a message the peer was owed and never sent, one it already acknowledged, or one not yet queued. The receiver processes it only ahead of its cursor and moves the cursor to it; it leaves out anything it had received after all, and a skip whose every sequence had arrived is answered as stale and changes nothing. A replay is answered from the inbox. The sender acknowledges a skip only once it has read the peer's answer: it tells its owner first, then records the acknowledgement and its audit together, so an unreadable answer or a crash in between sends the skip again, and the replay's answer tells the owner once. Both sides audit the skip (audit kind `peer`, outcome `failed`), and each owner gets one inbox notice per skip that says what failed, that later messages are kept and go on in order, what happens to the tasks involved and what to do (send or ask for it again), and only then lists what was lost and for which task, shortened to fit the notice. It says a task was settled only when a hand-over or stop was lost; a lost question, answer or approval is not sent again, and whoever waits for it waits until the request expires. A lost `result` settles the delegating task as uncertain on the receiving side, in the task's conversation, because nobody there can vouch for how it ended; a lost hand-over or stop still settles the task on the sender as before. The receiver tells its owner at most 30 times a minute per peer, and still skips and audits past that. A run of more than 50 given-up messages takes several skips, all sent before anything the gap would refuse is sent again. To a peer that takes skips, messages go lowest sequence first and one at a time, so what waits behind a refused message is not refused with it; when nothing answers at all (or the peer fails on its side, rejects the token or asks to wait), each waiting message is counted as failing whenever it is due, on its own schedule, even while the one ahead of it waits out its backoff, so it is given up on no later than it would have been had it been sent itself. A message given up on that way never left the node, so a hand-over among them settles its task as failed (it did not run there), not as uncertain. A peer that does not advertise `skip` — a build from before this — keeps the old behaviour, and while a message given up on is still missing there, the sender's owner is told once per stretch without an acknowledgement that the pairing is stuck: that device has not said it can skip lost messages, and updating ClarkCant there frees it; that notice goes when the peer acknowledges something again. A peer that answers a skip `400` with any code but `SKIP_INVALID` is taken as not taking skips until an answer advertises them again. An updated peer says it takes skips in its next `409` `SEQUENCE_GAP`, and the skip follows at once. The envelope stays at protocol version 1: the advertised feature is what versions the new kind, and no storage migration was needed.

**Not yet.** `NodeLinkTransport` in `packages/node-link` is still a stub for a socket-style transport: no TLS/mTLS yet, no WebSocket, no keepalive or reconnect cursor. Step 3 says TLS/mTLS or a signed app handshake verifies the key — today key verification is **fingerprint comparison**, and the channel is HTTP, so only a node reachable over plain HTTP can pair today. Step 4 (initial grants) and step 6 (probe, capability negotiation, status card) still belong to P4; what exists of step 6 today is the per-peer capability summary above, not a probe or a status card. The delegation path is wired: the owner writes a grant (`POST /grants`), that grant travels to the peer in the `pair.confirm` envelope, and from then on a `delegate` envelope naming exactly that grant is accepted while one naming an unknown delegation is rejected with `DELEGATION_UNKNOWN`. The receiver's accept policy is the **intersection** of the live grants from that sender — following the contract rule that a grant is only narrowed, never widened by holding another grant; a grant that does not set `maxArtifactBytes` allows **zero** bytes. Artifacts are currently only **evaluated**; no bytes are transferred yet. A sequence gap is reported with `SEQUENCE_GAP` and a peer's cursor only advances contiguously, so a late message is still processed instead of being treated as a regression; only a `skip` (below) moves the cursor past a gap.

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

# Open interfaces — API, MCP, WebSocket, CLI

> English (default) · [Tiếng Việt](open-interfaces.vi.md)

Actually you don't need to read this: once a node is running, ask Clark (`clarkcant ask "how do I connect Cursor to you?"`).

ClarkCant is built on open standards so that any third-party app or AI tool can work with the same Clark a person
talks to. Every surface below is served by the one runtime node, on the same origin and behind the same bearer token,
and every one of them ends at the same gateway handler (`apps/runtime/src/gateway.ts`). There is no second
business-logic stack: an MCP tool, a WebSocket frame and a CLI command are each a request to a route an HTTP caller
could make, so the checks, refusals and audit trail are identical everywhere.

| Surface | Standard | Endpoint | Code |
|---|---|---|---|
| REST API | HTTP/JSON, OpenAPI 3.1 | `/openapi.json` | `apps/runtime/src/routes/*` |
| Streaming | Server-Sent Events | `POST /conversations/{id}/messages/stream` | `routes/conversations.ts` |
| MCP | Model Context Protocol, Streamable HTTP | `POST /mcp` | `routes/mcp.ts` |
| MCP (stdio) | Model Context Protocol, stdio | `clarkcant mcp` | `apps/cli/src/cli.ts` |
| WebSocket | JSON frames, `clarkcant.ws.v1` | `/ws` | `apps/runtime/src/api-socket.ts` |
| CLI | – | `clarkcant` | `apps/cli` |
| Discovery | JSON | `/.well-known/clarkcant.json` | `apps/runtime/src/open-interfaces.ts` |

Tests: `apps/runtime/test/open-interfaces.spec.ts`, `apps/cli/test/cli.spec.ts`.

## Connecting

- Default URL `http://127.0.0.1:8765`. A node binds loopback unless started with `--allow-public-bind`, which requires
  TLS in front of it (see [installation](installation.md)).
- Every route except `/health`, `/.well-known/clarkcant.json` and `/openapi.json` requires
  `Authorization: Bearer <token>`. The token is `localToken` in `<data-dir>/identity.json` (default `~/.clarkcant`,
  Docker `/data/identity.json`). A missing and a wrong token get the same `401 UNAUTHENTICATED`.
- Refusals are JSON: `{ "code": "SOME_CODE", "message": "..." }`.

## REST

The stable surface is the one `/openapi.json` describes:

| Method | Path | Body |
|---|---|---|
| GET | `/node` | – |
| GET / POST | `/conversations` | `{ title? }` |
| POST | `/conversations/{id}/messages` | `{ text, attachmentIds?, references? }` — waits for the answer |
| POST | `/conversations/{id}/messages/stream` | same, answered as SSE: `delta`, `reasoning`, `tool-start`, `tool-end`, `host-control`, `error`, `done` |
| POST | `/conversations/{id}/stop` | `{ source? }` — stops the reply being written; keeps what was written, labelled as stopped; answers `{ stopped }` |
| GET | `/conversations/{id}/timeline?after=N` | – |
| POST | `/conversations/{id}/questions/{questionId}/answer` | `{ text?, optionIds?, confirmed? }` |
| POST | `/conversations/{id}/questions/{questionId}/cancel` | – |
| POST | `/signals` | `{ source, topic, subject?, payload, occurredAt, dedupeKey, provenance? }` — something happened; `202` recorded, `200` already recorded |
| POST | `/signals/github` | a GitHub webhook delivery, signed with the webhook secret instead of the token — see below |
| POST | `/signals/webhook/{source}` | `{ id, topic, payload?, subject?, occurredAt? }` signed with that source's secret instead of the token — see below |
| GET | `/automations` | – the standing requests set up in conversation, each with its recent runs |
| GET | `/composer/suggestions?trigger=/\|@&q=&conversationId=` | – what the composer offers after `/` or `@` |
| POST | `/stop` | – emergency stop |

```bash
TOKEN=$(jq -r .localToken ~/.clarkcant/identity.json)
ID=$(curl -s -X POST localhost:8765/conversations -H "authorization: Bearer $TOKEN" | jq -r .conversationId)
curl -N -X POST localhost:8765/conversations/$ID/messages/stream \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"hello"}'
```

A `host-control` event is the agent asking the page to change something (open Settings on a tab, switch the model,
open voice mode). When the agent asked for it, the event's decision carries a `controlId`, and the page answers with
`POST /app-intents/host-control/{controlId}` `{ ran, say }` once it has carried the action out or failed to. The agent
is told the page's own answer, so it says the app changed only when the page reported it did; with no answer within
a few seconds it is told the action is unconfirmed. Each `controlId` is answered once (a second answer gets
`404 HOST_CONTROL_NOT_EXPECTED`), and the plain `/messages` route never waits for one. The audit record of an action
the agent asked for while answering a spoken sentence has `source: "voice-agent"`, distinct from a person's own spoken
command (`source: "voice"`).

A signal is how anything outside the conversation tells the node that something happened: a CI run, a script, a
service of your own. It is recorded before anything is matched, then answered against the standing requests the person
set up by saying "when X happens, do Y" to Clark. A topic is dotted lower-case words (`build.finished`); the payload is
at most 64 KB; the same `(source.sourceId, dedupeKey)` sent again is answered `200` with the signal already recorded,
so a sender that retries never starts the work twice. `timer` and `system` sources are the node's own and are refused
with `403 SOURCE_RESERVED`. Automations are created, paused, resumed and removed in conversation; `/automations` only
reads them.

```bash
curl -X POST localhost:8765/signals -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "source": { "kind": "external", "provider": "ci", "sourceId": "ci:my-repo" },
  "topic": "build.finished",
  "subject": { "type": "build", "id": "812" },
  "payload": { "status": "failed" },
  "occurredAt": "2026-09-29T08:00:00.000Z",
  "dedupeKey": "build-812"
}'
```

GitHub delivers to `POST /signals/github` without the node's token: a repository webhook (content type
`application/json`) signs each delivery with a secret the node keeps as `github_webhook_secret`, and a delivery whose
`X-Hub-Signature-256` does not verify is refused `401` with nothing recorded. Clark asks for that secret through its
host-owned secret form the first time a GitHub automation is set up, so the value never enters the conversation. A
verified delivery becomes a signal — `github.issue.labeled|opened|edited`, `github.pull_request.opened|synchronize`,
`github.issue_comment.created`, `github.pull_request_review_comment.created`, `github.workflow_run.completed`,
`github.check_suite.completed`, and the other actions of those events — with the repository as
`subject.refs.repository`, deduplicated on `X-GitHub-Delivery`. What the node's own GitHub logins did (the
`signals.github.selfLogins` preference) is marked self-generated and starts nothing unless an automation asked for it,
and a task only starts in a local clone whose `origin` is the repository the signal is about. Bodies over 2 MiB are
refused `413`.

A node GitHub cannot reach polls instead, with nothing to set up. Each github.com repository an active `github.*`
automation names with `subject.refs.repository` (`equals`, or each name of `in`) has its Events API listing read
into the same signals — issues, pull requests and their comments; CI runs still need the webhook — deduplicated on the
event id. A repository is polled at most every five minutes, or less often when GitHub's `X-Poll-Interval` says so,
with `If-None-Match` so an unchanged listing is a `304`; a rate limit waits until GitHub's reset. The cursor and tag
are stored per repository, so a restart goes on where it stopped and records each event once. A repository with a
verified webhook delivery in the last 24 hours is not polled, and a node with no such automation makes no request. A
public repository needs no token; a private one is read with `github_token` when the person stored it for the
`signals:github` consumer. A refusal, or three failures in a row, leaves one inbox notice, and the repository is tried
again with a growing wait (up to six hours) or at once when the token is stored again. Automations bound to another
`subject.refs.host` are left to the webhook.

Anything else that can sign a request delivers to `POST /signals/webhook/{source}`, also without the node's token. The
person names the source when they set up a standing request on a `webhook.<source>.<what happened>` topic, and Clark
asks for the source's shared secret through the same host-owned form, stored as `webhook_<source>_secret` for that
source only. The sender signs the raw body with it — `X-Signature-256: sha256=<hex HMAC-SHA256>` — and sends
`{ "id": "build-812", "topic": "build.failed", "payload": { "branch": "main" } }`; the node records the signal
`webhook.<source>.build.failed`, deduplicated on `id`. The topic is always prefixed with the source's name, so a sender
cannot make its delivery look like GitHub's or another source's. A missing or wrong signature is refused `401` with
nothing recorded, a source with no secret set is `404`, and bodies over 256 KiB are refused `413`.

```bash
BODY='{"id":"build-812","topic":"build.failed","payload":{"branch":"main"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.* //')
curl -X POST localhost:8765/signals/webhook/deploys -H 'content-type: application/json' \
  -H "x-signature-256: sha256=$SIG" -d "$BODY"
```

A paired node tells another what happened with `POST /peers/{nodeId}/signals` `{ id, topic, payload?, subject?,
occurredAt? }` on its own gateway, with its own token. The signal is queued in the outbox and carried to the peer as a
NodeLink `signal` message; the peer records it as `peer.<topic>` from the node the authenticated channel says sent it,
so its standing requests decide what, if anything, it starts. See [distributed runtime](distributed-runtime.md).

A paired node puts something in the other owner's inbox with `POST /peers/{nodeId}/notices` `{ id, title, body?,
category?, severity? }` on its own gateway, with its own token (`202` queued; `404` `PEER_UNKNOWN` for a peer that is
not paired and confirmed; `409` `NOTICES_UNSUPPORTED` for a peer that has not said it takes notices, with a message
saying to send that peer something first or update it; `400` for anything else). This route is the producer for now: nothing on a node sends notices by itself, so local tools — the CLI, an MCP
client, an automation — use it to tell a paired Clark that accepts them. It travels as a NodeLink `notice` message
whose payload is `notice` `{ key, category, severity, title, body? }` — a strict object: title at most 120 characters,
body at most 500, key at most 160, and nothing else, so there is no field for actions, a subject or a link. The
receiver records it only when its own owner chose to work with the sender — a live grant the receiver wrote to that
peer, or a live allowance for it; a grant the sender wrote does not count — and at most 30 a minute from one peer.
Otherwise it answers `accepted: false` with a `code` (`PEER_NOT_ALLOWED`, `RATE_LIMITED`, `NOTICE_UNREADABLE`,
`NOTICES_OFF`) and a `reason`, which is final: the sender does not retry it, records it on the outbox row, and puts
one notice per peer and reason in its own owner's inbox saying what did not arrive, why, and what would change it. It is recorded as
the peer's (`sourceKind` `peer`, `originNodeId`, subject `peer`) under the key `peer:<senderNodeId>:<key>`, so a resend
or a replay is one notice; its text is treated as data (control, bidi and zero-width characters removed); one peer keeps
at most 20 undismissed notices, its oldest going first, without pushing out the node's own or another peer's; and what
can be done with it is worked out by the receiving host like for any notice.

Every `200` from `POST /peers/messages` carries `features` (what the answering node takes beyond the base envelopes;
today `["notice", "skip", "capabilities", "artifacts"]`) and `label` (what it calls itself), and so does a `409` `SEQUENCE_GAP` (`{ code, expected,
received, features, label }`). The sender records both for that peer, only from an answer to something it delivered
over the authenticated channel; a pairing offer may carry `features` too. Unknown features are dropped, the label is
cleaned and cut to 64 characters, and a peer that advertised nothing — a build from before this — is sent no notices
and no skips until an answer says it takes them. The sender reads at most 16 KiB of an answer, within the delivery's
30-second deadline; an answer past either is ignored, and the message stays acknowledged when its status was `200`.

A node that advertises `capabilities` answers `GET /peers/capabilities` for a paired peer, with that peer's derived peer
token (anything else is `401` `UNAUTHENTICATED`), with `{ version: 1, allowed, waits, capabilities: [{ ref, ready }] }` — a
strict object, at most 32 entries, built only from the allowance that node's owner set for the asking peer: the
capability refs the allowance covers and whether the node can run each one now; `allowed: false` with an empty list when
there is no allowance. `waits` says whether a run the asking peer hands over that the node cannot start yet waits there
(`true`) or is refused at once (`false`: the node has not yet heard that the peer advertises `capabilities`), and the
setup warning says the run waits only when it is `true`. It holds no folder, no other capability and no reason. The asking node waits at most 5 seconds,
refuses redirects, and drops an answer that does not match the schema exactly; `list_peers` and `create_automation` with
an `executor` use it to show and to warn, never to refuse. When a hand-over has to wait for a capability on the
receiving node and the sender advertises `capabilities`, the receiver sends a NodeLink `status` whose payload is `{
taskState: "waiting_capability", taskRevision, message, capabilityRef }`, then the same with `taskState: "running"` once
the task starts. The wait has no time limit; both owners are told when it starts, and the sender can stop it. A sender that
does not advertise `capabilities` is refused at once, as before. The envelope stays at protocol version 1; the
advertised feature is what versions the route and these statuses. See [distributed runtime](distributed-runtime.md).

To a sender that advertises `artifacts`, a node that ran a handed-over task offers each file its worker wrote as its own
NodeLink `artifact.offer` for that `taskId`, queued ahead of the `result`: payload `{ artifact: { artifactId, digest,
sizeBytes, mimeType, classification, originNodeId }, digest, sizeBytes, classification, name }`, where `name` is the
file's path relative to the folder it was written in (at most 200 characters, treated as data). The `result`'s
`evidence.artifacts` names the same files as `[{ artifactId, digest, name, sizeBytes, mimeType }]` — at most 8, each at
most 4 MiB, digests `sha256:<64 hex>`. The sender answers each offer `accepted` or not with a `reason`, decided only
by its own owner's grant for that task: its `budget.maxArtifactBytes`, counted across the task's files, where none or
0 takes no file. It then pulls an accepted file from `GET /peers/artifacts/{digest}` with its derived peer token; the
offering node serves a digest only to the peer it offered it to (`401` without a peer token, `404` otherwise, the same
as an unknown digest), and the sender reads no more than the size offered and checks the digest before storing it.
`create_automation` takes `maxArtifactBytes` (0 to 16 MiB, with an `executor` only). A sender that does not advertise
`artifacts` is offered nothing. The envelope stays at protocol version 1; the advertised feature versions the offers
and `evidence.artifacts`.

NodeLink sequences every envelope a node sends one peer, and the peer refuses anything past a gap with `409`
`SEQUENCE_GAP`. When the sender gives up on a message after 12 failed attempts, a peer that advertises `skip` is sent a
NodeLink `skip` message in its place; the envelope stays at protocol version 1, and the advertised feature is what
versions it. (A revoked pairing's messages are given up on too, but nothing, a skip included, is sent to a revoked
peer.) Its payload is `skip` `{ through, lost: [{ sequence, messageId, kind, taskId? }] }` — a strict object:
`through` equals the envelope's own `sourceSequence` (the slot of the last message it gives up on, so it can never reach
past a message not yet sent), `lost` lists 1 to 50 given-up messages in ascending sequence order, the last one at
`through`, none of kind `skip`, and a `taskId` is id-shaped; anything else is refused whole with `400` `SKIP_INVALID`.
The sender covers only given-up messages above the highest sequence the peer acknowledged and below the lowest one still
owed, one skip at a time, and sends as many skips as a longer run needs before anything the gap would refuse is sent
again. The receiver processes a skip only ahead of its cursor, moves the cursor to `through`, and answers
`accepted: true` with `from` (the first sequence it had not received), `through` and `settled` (tasks it handed the
sender whose lost `result` it settled as uncertain); a replay is answered from its inbox, and a skip whose every
sequence had arrived after all is answered `200` `status: "stale"` with `code` `SKIP_STALE`, changing nothing. The
sender acknowledges a skip only once it has read that answer: it tells its owner first, then records the
acknowledgement and its audit event together, so an answer it cannot read, or a crash, sends the skip again and the
replay's answer tells it once. Both sides write an audit event of kind `peer` and put one notice in their owner's inbox
(keys `peer-lost:<peerNodeId>:out|in:<through>`) that says what failed, what was kept and what happens to the tasks
involved before it lists what was lost, so the list is what gets shortened to fit; the receiver tells its owner at most
30 times a minute per peer. A node without a skip handler answers `400` `UNSUPPORTED_KIND` and does not advertise it; a
sender whose skip is answered `400` with any code but `SKIP_INVALID` records that the peer takes no skips (until an
answer advertises `skip` again), gives the skip up and reports the pairing as stuck. To a peer that does not advertise
`skip`, delivery stays as before, and the sender's owner is told once per stretch without an acknowledgement
(`peer-stuck:<peerNodeId>:<lastAck|never>`) that the pairing is stuck until that device updates, but only while a
message given up on is still missing there; the next `409` from an updated peer carries `skip`, and the skip follows.
To a peer that takes skips, messages go lowest sequence first and one at a time, so what waits behind a refused message
is not refused with it.

A standing request's task can also run on a paired node. That is set up in conversation, not through a route: the
sending node's owner names the peer as the task's executor, and the receiving node's owner says what that peer may run
there (folders, repositories, effects). The nodes exchange the grant, the hand-over (`delegate`), its answer
(`result`) and a stop (`cancel.request`) as NodeLink messages; the receiver runs the task only within both, and each
owner hears the outcome in their own conversation. While the task waits for the receiving owner's approval, the
receiver says so with `status` (`taskState` `waiting_approval`, then `running` once allowed), and the sender's owner
is told without being offered the decision. Pausing or removing the automation withdraws its own grant with
`revoke` (`grantId`, `reason`), which only the grant's sender can send. A per-run time limit given when the automation
is set up (`maxMinutesPerRun`) travels as the grant's `budget.maxWallClockMs`, and the receiver stops a run when it
runs out; a grant's `maxRuns` and `maxTokens` are held the same way.

A message can carry what the person picked after `/` or `@` in the composer as `references`: `{ "version": 1,
"items": [...] }`, at most 8, each one of `skill { skillId, source, revision }`, `project { projectId }`,
`file|folder { projectId, path }` (a path relative to the project, never absolute), `mcp-server { serviceKey }`,
`conversation { conversationId }`, `background-work { workId }` or `notice { noticeId }`, all with a `label`. The node
checks each one again when the message is sent — the skill is still there at that revision, the path still resolves
inside the project once links are followed, the project is still inside the approved folders, the notice is still in the inbox —
and a reference that no longer holds refuses the whole message with `400 REFERENCE_NOT_AVAILABLE`, naming it, before
anything is stored. What passes is kept on the user message as a `reference` block and briefed to the turn by
project-relative path; a skill's instructions are included in that turn. A reference is a pointer, not a permission:
reading, running or changing anything it names still goes through the node's usual checks.

`GET /composer/suggestions` is what fills the picker: skills after `/`; projects, services, conversations (by title, or
by the start of the first message when the title is the clients' placeholder) and background work after `@`; one
directory of a project after `@<project>/`. At most 8 rows, ranked exact, then prefix, then substring, then by kind
(projects, services, conversations, work), recently used first, with diacritics optional when typing. With nothing
typed after `@`, each kind gets its share of the rows. A row that cannot be chosen says why in `disabledReason`. A
service is labelled with the id its package gave it and carries only its state (running, failed, not running), never
what it was started with or why it failed; its `serviceKey` also names the package generation running it, so an update
makes an earlier reference stale.

The inbox routes are reachable with the same token but are **not** in `/openapi.json` yet and may change: `GET /inbox`
(what waits on the person, the notices, the notices snoozed for later, the kinds quieted and the versions skipped),
`GET /inbox/summary`,
`POST /inbox/read` and `/inbox/unread`, per notice `POST /inbox/notices/:id/<action>` where the action is `dismiss`,
`restore`, `snooze`, `unsnooze`, `suppress`, `unsuppress`, `skip-version` or `unskip-version`, and
`DELETE /inbox/suppressions/:id`, plus `DELETE /inbox/skipped-versions/:kind/:name/:version` (`package` or `pi`, each part
URL-encoded) to take a skip back from the list, even after its notice is gone. `snooze` takes `{ "until": "<ISO instant>" }`, ahead of
now and at most 30 days away (else `400 SNOOZE_OUT_OF_RANGE`); the notice leaves the list and the unread count and comes
back unread once that time has passed; `unsnooze` returns it at once, read or unread as it was before. `suppress` quiets
the notice's kind for this principal: later notices of that kind are still listed but arrive read and raise no
notification. Only a narrow kind can be quieted, one tied to an automation, a signal source, a package, a node, or a
person's own background work; any other kind would also silence reminders and every other automation's notices, so
the route refuses it with `409 SUPPRESSION_TOO_BROAD` and the notice's `actions` never offer it. `skip-version`
stops update notices for the version the stored notice names, and anything older, for this principal, and dismisses
the notice; any body is ignored, a notice that names no version answers `409 NOT_AN_UPDATE`, and `unskip-version`
undoes it. Each route acts only on the calling principal's own notices. `POST /effects/:effectId/reconcile` with
`{ "outcome": "confirmed" | "failed", "source"?: "click" | "chat" | "voice" }` records what the person saw of an action
whose outcome was unknown, the answer an unknown-outcome notice offers as its two buttons: `404 RESOURCE_NOT_FOUND` for
an effect of another principal's task, of another node, or none at all, `409 EFFECT_NOT_UNKNOWN` once it is no longer
unknown; it is person-only, as below. `source` is a label the caller supplies for where the answer was given and is
stored as given, not provenance; who answered is the authenticated principal. A notice's `actions` (at most 12) may
also offer operations on the thing itself, each backed by a route: `retry` is `POST /work/:id/retry` (runs failed,
stopped or interrupted background work again as new work in the same conversation, once), `ask-again` is
`POST /conversations/:id/questions/:questionId/ask-again` (asks an expired question again as a new one), `update` is
the ordinary `POST /packages/install` with the version the notice names, and `review-update` opens Settings. An action
listed with `unavailable` (`conversation-gone`, `work-gone`, `package-gone`, `already-current`) says why it cannot be
taken now. The shapes are `packages/contracts/src/inbox.ts`; the behaviour is described in
[system-architecture.md](system-architecture.md) under the inbox.

Other routes exist (settings, packages, widgets, peers…) and are reachable with the same token, but they are not yet
part of the stable description and may change.

## MCP

`POST /mcp` implements the Streamable HTTP transport with JSON answers (protocol `2025-06-18`, also `2025-03-26` and
`2024-11-05`). `GET /mcp` answers `405`: the server never speaks first. Methods: `initialize`, `ping`, `tools/list`,
`tools/call`; notifications get a bare `202`.

| Tool | Arguments | Route it calls |
|---|---|---|
| `ask_clark` | `text`, `conversationId?`, `title?` | `POST /conversations` (when needed), `POST /conversations/{id}/messages` |
| `list_conversations` | – | `GET /conversations` |
| `create_conversation` | `title?` | `POST /conversations` |
| `read_conversation` | `conversationId`, `after?` | `GET /conversations/{id}/timeline` |
| `answer_question` | `conversationId`, `questionId`, `text?`, `optionIds?`, `confirmed?` | `POST …/questions/{questionId}/answer` |
| `stop_reply` | `conversationId` | `POST /conversations/{id}/stop` |
| `stop_all_work` | – | `POST /stop` |
| `node_status` | – | `GET /node` |

**No approval tool, on purpose.** An approval is the person's decision about something an agent wants to do; an MCP
tool for it would let an AI client approve its own guarded action. Approvals stay on the person's own surfaces, and
the generic relays (a WebSocket `request` frame, `clarkcant api`) and MCP refuse every route that records a person's
decision with `403 PERSON_ONLY` for the same reason: approving a guarded action (on a card, or one a running task
raised), deciding a package capability,
confirming an app intent, reporting what the page did with an action the agent asked for, trusting a paired peer,
issuing a grant, and recording whether an action whose outcome nobody saw took effect
(`POST /effects/{effectId}/reconcile`; an AI client that could say "that push landed" could clear its own task's
uncertainty and then report its own success). Exporting a table as a CSV file
(`POST /conversations/{id}/widgets/{instanceId}/export`) is refused on the same relays too: the file is written for
the person who is looking at the table, not handed to a machine client. Stop, answering a question and reading stay
available. The discovery document lists this under `personDecisions`.

Client configuration — HTTP:

```json
{ "mcpServers": { "clarkcant": { "url": "http://127.0.0.1:8765/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

stdio, for clients that launch a process (the bridge reads the token from `~/.clarkcant` or `CLARKCANT_TOKEN`):

```json
{ "mcpServers": { "clarkcant": { "command": "node", "args": ["/path/to/clarkcant/apps/cli/src/main.ts", "mcp"] } } }
```

## WebSocket

`ws://127.0.0.1:8765/ws`. A browser cannot put a header on a WebSocket, so the first frame authenticates, as on the
`/voice` and `/terminal` sockets:

```
→ { "type": "auth", "token": "<token>" }
← { "type": "ready", "protocol": "clarkcant.ws.v1" }
→ { "type": "request", "id": "1", "method": "POST", "path": "/conversations/<id>/messages/stream", "body": { "text": "hi" } }
← { "type": "event", "id": "1", "event": "delta", "data": { "text": "Hel" } }
← { "type": "event", "id": "1", "event": "done", "data": { … } }
← { "type": "response", "id": "1", "status": 200, "body": null }
```

- Any REST route except a person's decision can be sent as a `request` frame; the answer is the gateway's own status
  and body.
- `id` is echoed exactly as sent, string or number.
- Query parameters go in a `query` object on the frame, not in `path`.
- Up to 16 requests may run at once per socket, told apart by `id`.
- A refused request (`INVALID_FRAME`, `TOO_MANY_REQUESTS`) gets an `error` frame carrying its `id` instead of a
  `response`; that frame is the last one for the `id`.
- A route that answers with bytes (attachments, images) returns `415 USE_HTTP`.
- `ping` → `pong`. No auth within 10 s, or a wrong token: an `error` frame and close code `4401`.

## CLI

`apps/cli` (`@clarkcant/cli`) is a client of the gateway and nothing more. It is not published to npm yet; run it
from a checkout with `node apps/cli/src/main.ts` or `pnpm clarkcant`.

| Command | |
|---|---|
| `clarkcant ask "<text>" [-c <conversationId>]` | streams the answer to stdout; the conversation id goes to stderr |
| `clarkcant status` | node label, URL, model |
| `clarkcant conversations` / `new [title]` / `read <id>` | conversations |
| `clarkcant stop` | emergency stop |
| `clarkcant api <METHOD> <path> [jsonBody]` | any route except a person's decision |
| `clarkcant mcp` | MCP over stdio |
| `clarkcant discover` | the discovery document |

Connection: `--url` / `CLARKCANT_URL`, `--token` / `CLARKCANT_TOKEN`, else `identity.json` in `--data-dir` /
`CLARKCANT_DATA_DIR` (default `~/.clarkcant`). The identity file is only read for a node on this machine
(`localhost`, `127.x`, `::1`); a remote `--url` needs `--token` or `CLARKCANT_TOKEN`, so the local token is never sent
to another host. `clarkcant mcp` forwards each line as it arrives, so a `ping` is answered while a long call runs.
`--json` prints raw JSON.

## Changing a surface

Follow the rules in [AGENTS.md](../AGENTS.md#open-interfaces): a new capability goes through a gateway route first,
the other surfaces reach it through that route, `open-interfaces.ts` and this document change in the same PR, and a
docs change for the website is filed as an `ai-handle` issue on `digitopvn/clarkcant-web`.

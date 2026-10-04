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
| POST | `/conversations/{id}/delete` | `{ deletionPermit? }` — person-owned deletion; policy may ask or refuse |
| POST | `/conversations/{id}/messages` | `{ text, attachmentIds?, references? }` — waits for the answer |
| POST | `/conversations/{id}/messages/stream` | same, answered as SSE: `delta`, `reasoning`, `tool-start`, `tool-end`, `host-control`, `widget-perform`, `error`, `done` |
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

A `widget-perform` event is Clark asking a widget the page shows to perform one of the actions its package offers
(`offeredActions`, [widget-development.md §10.3](widget-development.md#103-actions-clark-performs-actionsperform1)).
The node has already checked it: the binding, the input against the declared schema, and the person's execution
policy. The node sends one only on a stream request that carries `x-clarkcant-widget-perform: 1`, the version the page
runs. Any other caller is sent none, and the perform is refused at once with `FRAME_NOT_MOUNTED`. That includes the
plain `/messages` route, MCP, the relay and `clarkcant api`.

The event's `request` is `{ v: 1, performId, instanceId, actionBindingId, action, input }`. The page hands it to the
mounted frame and answers `POST /app-intents/widget-perform/{performId}` with one of:

- `{ status: "done", output? }`;
- `{ status: "refused", by: "page" | "widget", code, message }`;
- `{ status: "no-answer", message }`.

`by: "page"` is taken only with the page's own codes, such as `FRAME_NOT_MOUNTED`, `SURFACE_GONE`,
`PERFORM_UNREADABLE` and `PERFORM_VERSION_UNSUPPORTED`. A page that cannot read a request, or gets another version,
still answers under its `performId`. A widget's refusal reaches Clark as `WIDGET_REFUSED`, with the widget's code in
`widgetCode`.

Each `performId` is answered once; a second answer gets `404 WIDGET_PERFORM_NOT_EXPECTED`. Nothing is queued for
later. With no answer within 8 seconds, or a `no-answer` report, the perform is recorded as uncertain and is not
retried. The report route is person-only, like the host-control report.

When the execution policy asks first, the answer is a host approval card instead. Deciding it at
`POST /conversations/{id}/approvals/{approvalId}/decide` with the same header can hand the approved perform to this
page. Then the decision's answer carries `perform` (the request), and the page reports it the same way. A decide
request without the header approves without sending anything, and the receipt says so. The same perform asked again
while its card waits is answered `202` with that card's `approvalRequired.approvalId` and `alreadyWaiting: true`, and
no second card. A conversation holds at most 8 waiting perform cards (`429 PERFORM_CARDS_WAITING`), and an input
longer than 1,200 characters as JSON is refused (`413 PERFORM_INPUT_TOO_LONG`) because the card shows the whole input.

The node's own page sends `x-clarkcant-surface: composer` with the messages a person types into it, and the node
stores that as the message's `surface`; a spoken message is stored with `surface: "voice"` by the node itself. A
message posted without the header (MCP, the WebSocket relay, `clarkcant api`, a script) is stored without a surface.
Only a message with a surface counts as the person's own words where that matters, such as which sites a browser task
may act on; any other value of the header is ignored.

### Who asked: a turn's origin

The node also records who started each turn, as the user message's `origin`, when it accepts the message. It is read
from what the gateway already knows and never from the request body:

| `origin` | Set when |
|---|---|
| `person` | the node's own page sent the message (`x-clarkcant-surface: composer`), it was spoken, or the person answered a card or pressed a widget action in the page |
| `mcp` | MCP `ask_clark`, which posts with `x-clarkcant-surface: mcp` |
| `relay` | the WebSocket relay, which posts with `x-clarkcant-surface: relay` |
| `cli-api` | any other token holder: `clarkcant api`, a script, or any other value of the header |
| `automation` | a scheduled or standing automation's task |
| `peer` | a task another node delegated to this one |

A body field such as `"origin": "person"` is ignored, so a machine surface cannot claim to be the person. The token
is the trust boundary, as it is for `surface`: a holder that sends the composer's header itself is treated as the page.

The origin is passed to the execution policy as part of the intent, and is written on the approval card a turn
causes, on its row in `GET /activity` (`origin`), and in the audit log. By default it changes no decision: a turn an
AI client started over MCP is decided exactly as the person's own message is. A person who wants more sets the
policy's `machineTurns` to `"ask"` (the `execution.machineTurns` preference, or Settings → Control → Requests from
other programs). Then a turn from `mcp`, `relay` or `cli-api` asks before a risky effect (`external-write`,
`destructive`, `financial`, `communication`, `media-capture`) the policy would otherwise have run. A deny rule or a
prohibition still wins; reads, local writes, the person's own turns, automations and peers are unchanged.

The origin stays with the work it started:

- When the person approves a card a program's turn raised, the turn that carries on after the approval keeps the
  program's origin. The person approved that one effect, not the rest of the program's plan, so the next risky step
  is asked about again under `"ask"`. The approved effect's audit and activity rows keep the origin too.
- A message whose origin differs from the running turn's is never steered into it. It interrupts and becomes a turn
  of its own with its own origin. A message sent to the background lane is recorded in the audit log with its origin.

`machineTurns` is part of the execution policy, and the policy routes (`PUT /preferences/execution.policy`,
`execution.machineTurns`, their `/undo`, and `POST /autonomy`) are open to any token holder, including the relay and
`clarkcant api`. So a program holding the node token can change this setting. Undoing `execution.machineTurns` puts
back only that choice; it answers `undone: false` when the last policy write did not change it.

### Conversation deletion

The person's text command “delete this conversation” and spoken equivalent resolve to the same `conversation.delete`
intent as the REST capability. `POST /conversations/{id}/delete` accepts `{}`. Current execution policy decides whether
to execute, ask or deny: autonomous mode honours the person's explicit instruction; guarded/ask mode or an ask rule
may return `202` with `{ deleted: false, decision: { kind: "needs-confirmation", intent, readBack, confirmationToken } }`.
Answer through person-owned `POST /app-intents/confirm` with the token and `decision: "granted" | "denied"`. A granted
decision carries `intent.deletionPermit`; send it to the original delete route. It is principal/target bound, expires
after two minutes and is spent once in the deletion transaction. A denial consumes the question without deleting.
Policy is checked again; a new refusal still wins over an earlier approval.

`200` reports `{ deleted: true, conversationId, attachments, artifacts, pendingFiles, readBack }`. `409` with
`{ deleted: false, decision: { kind: "refused", say } }` explains what was kept and what to do next. Unfinished,
paused or uncertain tasks, running turns, background work and widget actions still settling refuse deletion. Foreign
keys stay enabled; conversation-owned rows, attachments, all widget artifacts (including never-attached finalized
files), grants and cleanup jobs commit together. Physical files are removed only after commit; shared bytes stay.
Locked files remain queued for startup/periodic cleanup, and `pendingFiles` says how many are still waiting.

There is no Undo copy: deletion releases retained files and quota. Saved memory, independent resources, session logs
and append-only audit/replication history remain. The client starts a fresh conversation only after success. A lost
network reply means the result is unknown, so reload before retrying. MCP, the WebSocket relay and `clarkcant api`
refuse the delete route and confirmation with `403 PERSON_ONLY`; agent app intents cannot delete either.

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
The offering node offers files only when the sender's grant for the task sets a byte budget above 0 and its own
owner's allowance for that sender sets one too (`allow_peer_tasks` takes `maxArtifactBytes`, 0 to 16 MiB; none when
omitted), both covering the `internal` class, and within the smaller budget. It drops any path its worker reports
outside the task's folders, never offers a markup or script type, and names each file it leaves out in the `result`
message without storing it. Blocked MIME types are matched after lowercasing and dropping parameters.
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
whose outcome was unknown (a command a task ran, or a form a browser task submitted and the page never answered), the answer an unknown-outcome notice offers as its two buttons: `404 RESOURCE_NOT_FOUND` for
an effect of another principal's task, of another node, or none at all, `409 EFFECT_NOT_UNKNOWN` once it is no longer
unknown; it is person-only, as below. `source` is a label the caller supplies for where the answer was given and is
stored as given, not provenance; who answered is the authenticated principal. A notice's `actions` (at most 12) may
also offer operations on the thing itself, each backed by a route: `retry` is `POST /work/:id/retry` (runs failed,
stopped or interrupted background work again as new work in the same conversation, once), `ask-again` is
`POST /conversations/:id/questions/:questionId/ask-again` (asks an expired question again as a new one), `update` is
the ordinary `POST /packages/install` with the version the notice names, and `review-update` opens Settings. A package
update notice also carries `reachChange` when the package is installed: what the named version's listing reaches
compared with the installed manifest, as `{ verdict: "wider" | "narrower" | "unchanged", profile?, gpu?, origins, secrets,
keyDestinations, browserTokens, connectionScopes, connectionEndpoints }`, each set as `{ added, removed, addedMore?,
removedMore? }` with at most 32 items per list and the rest counted, `keyDestinations` as each (key, origin) pair a key
is sent to, and `profile` as the two profile names with each bounded limit that changes; or `{ verdict: "unknown" }`
when the package is installed at another version and the two cannot be compared
(`packages/contracts/src/reach-change.ts`). It also carries `unreadFields` (`{ count, names }`) when the listing of the
named version has fields this node does not read and dropped, so the change it shows does not pass for everything the
listing says. The web client parses `GET /inbox` item by item, so one item that does not
match the contract is left out and counted rather than failing the whole inbox. An action
listed with `unavailable` (`conversation-gone`, `work-gone`, `package-gone`, `already-current`) says why it cannot be
taken now. The shapes are `packages/contracts/src/inbox.ts`; the behaviour is described in
[system-architecture.md](system-architecture.md) under the inbox.

The theme routes are reachable with the same token but are **not** in `/openapi.json` yet and may change.
`GET /themes` answers `{ themes, problems, unchecked }`: Clark Default first, then every theme the `themes` facets of
the installed packages provide, each with its `themeRef` (`package:<package id>#<theme id>`) and its provider (package
id, version, digest, trust lane and source tier); `problems` names each theme that did not pass validation, and
`unchecked` each installed package whose files this node could not read. A theme whose colours fail the contrast audit Clark
Default is held to (`requiredPairs` in `packages/design-tokens/src/contrast.ts`) is a problem too, with a `contrast`
list of the pairs that fail, and is not listed as selectable. Each pair is `{ scheme, foreground, background, ratio,
minimum }`: the colour scheme, the two colour token names, the measured ratio rounded to two decimals and the ratio
required. A readable theme that would make a protected state hard to tell apart (danger from warning or success, a
status from body text, the focus ring from other edges, disabled text from enabled text, an edge from the card or the
page, text, a status colour, the accent or the focus ring on a surface finished by an effect or on the page under the
backdrop and its pointer light, or an Orb default whose light vanishes into the page) is a problem in the same way,
with a `protected` list instead: each entry is `{ scheme, check, first, second, value, minimum }`, where `check` is one
of `status-distinct`, `status-vs-text`, `focus-vs-border`, `disabled-distinct`, `edge-visible`, `surface-readable` or
`orb-visible`, and `value` is a perceptual distance (OKLab ΔE × 100), or a contrast ratio for `surface-readable`.
`first` is a colour token name, or `"orb"` for `orb-visible`, which measures the brightest light the theme's Orb adds
against `canvas`. `message` fields are English, for logs; a client words a failure for its reader from `code`,
`contrast` and `protected`, and words a `code` it does not know in a generic sentence.
`GET /appearance` answers what the page should
draw: `selectedRef` (the `experience.themeRef` preference, chosen with `PUT /preferences/experience.themeRef`
`{ "value": "<themeRef>" }`), `appliedRef`, the validated `theme` document (`null` for Clark Default), its `provider`,
and a `fallback` `{ code, message, contrast?, protected? }` when the choice cannot be drawn — `THEME_NOT_INSTALLED`,
`THEME_INVALID`, `THEME_LOW_CONTRAST` (the only code that carries `contrast`), `THEME_PROTECTED` (the only code that
carries `protected`), `THEME_UNAVAILABLE` or `THEME_UNKNOWN` — in which case Clark Default is drawn and `selectedRef` is
kept, so reinstalling the package brings the theme back. Writing `experience.themeRef` checks the reference first: one
this node cannot draw is refused with `409` and the same code, reason and `contrast` or `protected`, and nothing is
stored. The node does not push package changes: a client re-reads `/appearance` after it changes a package and when its
window comes back into view. The shapes are `packages/contracts/src/themes.ts`.

`GET /appearance?themeRef=<encoded reference>` resolves a checked theme for read-only preview, without writing any
preference. Malformed references answer `400`; unavailable themes return the normal fallback. Personal appearance
adds optional `customization: { accent, density }`: accent is `null` or `{ dark: "#RRGGBB", light: "#RRGGBB" }`, density
is `comfortable | compact`. Write these through registered `experience.accent` and `experience.density` preferences.
Accent is audited in both schemes and for protected states before a write (including a theme choice under the saved
accent); refusal is `409` and leaves storage unchanged. `customizationFallback` names why an installed update made a
saved accent unsafe; the theme's accent is drawn and the saved preference is retained. The compiler owns these
choices, so iframe and detached renderers receive the same bounded snapshot. `experience.recentThemes` contains up
to six distinct references, updated atomically with a registered theme write.

Widgets consume the resolved public `AppearanceSnapshot` rather than this raw theme response. Bridge v2 optionally
includes `appearance` in init with `appearance@1`, then sends source/nonce-checked
`{ kind: "appearance.changed", nonce, revision, appearance }` with matching revisions. The DOM-independent SDK exposes
deeply frozen `appearance.current()` / `subscribe(handler)`; no state write or capability accompanies the snapshot.
The desktop detached bootstrap/event relay carries the same checked revision without credentials. Widget definitions
may declare `appearanceMode: "adaptive" | "fixed"` (absent means adaptive); directory entries optionally carry
`widgetAppearance: [{ id, mode }]` as discovery claims, never authority, and each `marketplace-results` card row
repeats them under the same schema. See
[widget authoring and bridge compatibility](widget-development.md#appearance-appearance1).

A theme document declaring `appearanceApi.min` 2 may also choose the rest of the look, always by name or bounded number
and never as CSS: `typography` (font profiles and heading weight), `border`, `shadow`, `motion` (speed and easing;
reduced motion stays none whatever it says), `icons`, `radius.field`, `recipes` (one host-owned recipe per button, card,
input, modal, badge and composer), `effects` (a backdrop: dot grid, hard grid, scanlines, grain or paper; a surface
finish: glass, soft glow, paper or grain; each with a bounded intensity) and `orb` (a default Orb preset with optional
colours, used only while the person has not chosen an Orb). An unknown field, recipe or effect, or a value out of range,
is refused. The appearance app intents are `appearance.set-theme` (`themeRef`), `appearance.set-color-scheme`
(`colorScheme`: `light`, `dark` or `system`), `appearance.reset` (Clark Default, following the system) and
`appearance.open-theme-gallery`. `POST /app-intents` and the agent's `control_app` accept them; a theme is checked
against this node's themes and refused with a sentence when it cannot be drawn. None of them asks for confirmation.

`POST /inbox/notices/:id/actions/:action` is the one route for a notice's own actions, whoever asks: the inbox panel,
a typed or spoken sentence, the main and voice agent, MCP's `act_on_notice` and `clarkcant api`. The action is one of
`mark-read`, `mark-unread`, `dismiss`, `restore`, `snooze`, `unsnooze`, `suppress`, `unsuppress`, `retry`, `update`,
`skip-version` or `ask-again` (`NOTICE_OPERATION_IDS`), matched as sent: the segment is never percent-decoded, so an
encoded name such as `%75pdate` is `400 UNKNOWN_ACTION`, not `update`. The body is `{}`, or carries `until` (an ISO
instant, for `snooze` only and required there) and `source` (`click`, `chat` or `voice`: how the person asked, recorded
with the action; a label, not provenance). Apart from `mark-read` and `mark-unread`, the node checks the action against
the notice's `actions` as they are now, and refuses anything else without changing anything: `400 UNKNOWN_ACTION` for
a name that is not a notice action, `403 PERSON_ONLY` for `reconcile-confirmed` and `reconcile-failed` (the person's
answer, on its own route below), `409 SURFACE_ACTION` for `open`, `ask-clark`, `add-to-context`, `review-update`
and `copy-details` (they change what the person's screen shows or holds, so only that screen does them), `404 RESOURCE_NOT_FOUND` for a notice
that is gone, dismissed or another principal's, `409 ACTION_NOT_OFFERED` when the notice does not offer it now, and
`409 ACTION_UNAVAILABLE` with a `reason` code (`conversation-gone`, `work-gone`, `package-gone`, `already-current`)
when it is listed but cannot be taken now; a client words that reason for its reader, and the English `message` is
for logs. `restore` is the undo of `dismiss`: it brings back a notice dismissed within the last five minutes
(`NOTICE_DISMISS_UNDO_WINDOW_MS`), answers `done` for a notice that is not dismissed, and `409 UNDO_EXPIRED` once the
window has passed. **`update` is person-only**: it installs code and grants what the package asks for, so the
WebSocket relay, `clarkcant api` and MCP refuse the route with `403 PERSON_ONLY` (`isPersonOnlyRoute`), MCP's
`act_on_notice` does not offer it, and the node refuses it with the same code when an agent's `act_on_notice` names it.
The person's own page reaches it from the notice's Update button, or from a spoken request they confirmed. A second
`update` for the same notice while one is installing answers `409 ACTION_IN_PROGRESS`. `update` answers the install
route's own refusals unchanged, and `202` with `{ "outcome": "approval-required", "approvalId", "version" }` when the
person's execution mode asks before installing; nothing is installed then, and a second request while that approval
is still pending answers the same `approvalId`. That approval waits in the inbox as an `install-approval` item, where
the person decides it (below). Otherwise `200` with
`{ noticeId, action, outcome: "done" }` plus what the action produced (`snoozedUntil`, `workId` with `state` and
`position`, `version` with `pendingCapabilities` and `deniedCapabilities` for an installed update, `questionId`);
`retry` and `ask-again` take the old notice out, so asking twice answers `404` the second time. Every action, refused
or not, is recorded as an `inbox.notice-action` event with the surface it came from and its result. The per-action
routes above still answer as before.

Files a widget holds by reference (`artifacts@1`, [widget-development.md §10.1](widget-development.md#101-files-by-reference-artifacts1))
are in `/openapi.json`. Every answer carries an `ArtifactRef` (`{ v, artifactId, kind, mimeType, sizeBytes, name,
digest? }`), bytes, or a refusal whose code names what was wrong (`packages/contracts/src/artifacts.ts`). None
carries a path.

| Method | Path | Body / answer |
|---|---|---|
| GET | `/artifacts/{artifactId}` | – the artifact, and its `artifactRef` for a file a widget holds; another principal's is `404 ARTIFACT_NOT_FOUND` |
| GET | `/artifacts/{artifactId}/content` | – the bytes of a finalized artifact, for the host's Open; `409 ARTIFACT_NOT_FINALIZED` while it is being written |
| POST | `/artifacts/{artifactId}/export` | `{ suggestedName? }` — Save As: the bytes as a download under a file name, never a path. **Person-only** |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts` | `{ mimeType, name? }` — a working artifact this instance may write; `201 { artifactRef }` |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/pick` | `{ name, mimeType, contentBase64, accept? }` — a file the person chose in host chrome, granted to this instance. **Person-only** |
| GET | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}` | – the ref, if this instance's grant still holds |
| GET | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/content?offset=&length=` | – `{ artifactRef, offset, eof, contentBase64 }`, at most 262,144 bytes |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/chunks` | `{ offset, contentBase64 }` — at most 262,144 bytes, starting where the artifact ends |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/finalize` | – fixes the bytes after checking them against the declared type |
| POST | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}/attach` | `{ name? }` – `201 { artifactRef, attachmentRef }` through the attachment pipeline; the person sends it with their next message. `name` is the widget's proposed file name, which the node sanitizes, as it sanitizes the artifact's own name when `name` is absent (a non-string `name` is `400 INVALID_SCHEMA`). The first attach decides the name: attaching the same artifact again returns that attachment, whatever `name` it proposes |
| DELETE | `/conversations/{id}/widgets/{instanceId}/artifacts/{artifactId}` | – discards a file this instance made, with its bytes unless an attachment or another record still points at them; another's is `403 ARTIFACT_NOT_CREATOR` |

**On a machine surface, the five write routes go through the execution policy.** Create, chunks, finalize, attach and
discard are a widget's acts. The person's own app calls them as before. When MCP, the WebSocket relay or
`clarkcant api` carries one, an AI client or a remote machine would be writing as the widget, so the node decides each
write under the person's execution policy (`packages/contracts/src/machine-surfaces.ts`,
`apps/runtime/src/application/machine-artifact-writes.ts`). Each write is a `local-write` effect, except discarding a
file that is not an unfinished one the same asker started (the same relay connection, or the same surface for MCP and `clarkcant api`): that may delete the person's only copy, so it is
`destructive`, and it is asked about under Guarded and, since nobody in the conversation asked for it, under
Autonomous too. When the person opted to be asked about machine-surface turns (`machineTurns: "ask"`), each write is decided as a turn that surface asked for: a destructive discard is then asked about even over a rule that runs destructive effects, and the card says who asked.

- **The policy runs it** (Autonomous, or Guarded with no rule asking): the write runs and answers as above.
- **The policy asks** (Ask every time, a rule that asks, or a destructive discard): nothing is written. A host-owned
  approval card goes into the widget's conversation, worded in the person's language, and the caller gets
  `202 { outcome: "approval-required", approvalRequired: { approvalId }, operation, message }`. Only the person decides
  the card, on the person-only decide route; the relay and `clarkcant api` refuse that route with `403 PERSON_ONLY`, and
  MCP has no tool for it. A card is per file, never per chunk, and never carries bytes. Approving a create makes the
  file and gives a write right on it: its chunks and its finalize run without another card for 15 minutes. A chunk or
  finalize for an existing working file asks for the same write access, and is sent again once the person approves.
  The right ends on finalize, discard or expiry. Who holds it depends on what the node can tell apart: over the
  WebSocket relay it is only the one connection that asked (the node gives each socket its own id); MCP calls and
  `clarkcant api` runs carry no per-client identity, so there it is any client of that surface, not just the one that
  asked. The card and its receipt say which, before and after the person decides. Attach and discard are asked about
  one at a time. A receipt (`widget_artifact_write`,
  with `args.approvalId` and `args.artifactId`, or `args.code` when it failed) answers every decided card, including one
  that could no longer run because the widget left, the policy changed, the file changed or the card was tampered
  with. Asking again for the same thing answers the card already waiting; past 8 waiting cards from one surface in one
  conversation, the answer is `429 APPROVALS_PENDING`. That count is kept in memory, so a restart resets it; the
  cards already in the conversation still wait for the person.
- **The policy refuses** (a rule refusing the category, or a node-wide prohibition): `403 POLICY_REFUSED`, nothing
  written.

A content type that is not a media type, or an artifact id the node did not issue, is refused before any card is shown,
as is anything the broker would refuse anyway. Every write a machine surface carries is recorded in the audit log (kind
`widget-artifact`) with the surface (`mcp`, `relay` or `cli-api`), the widget instance, the artifact id, the operation
and the decision. A write the policy ran also gets an activity record once the broker accepted it. Neither the audit
nor the conversation ever holds the file's bytes. The surface is read from the `x-clarkcant-surface` header that the
node's own surfaces set (`clarkcant api` sends `cli-api`); a body field never sets it, and a WebSocket frame cannot set
it either. A request over plain HTTP without that header is the person's own token acting directly, as the person's
app does, and is not policy-checked; any HTTP caller can add the header, so it only ever sends a write through the
policy, never lets one skip it. Reads stay reachable on every surface. Save As and the picker stay person-only.

Package jobs a widget follows (`jobs@1`, [widget-development.md §10.2](widget-development.md#102-long-running-jobs-jobs1))
are in `/openapi.json`. A press on a binding whose capability runs as a job answers with a JobRef (`job_…`) instead of
waiting for the service; these routes read and stop it. A JobRef is a pointer, not a permission: the node answers only
when one of this instance's own invoke bindings started the job, in this conversation, for the same principal, package
generation and capability. Anything else, including a ref that does not exist, is `404 JOB_NOT_FOUND`
(`packages/contracts/src/jobs.ts`).

| Method | Path | Body / answer |
|---|---|---|
| GET | `/conversations/{id}/widgets/{instanceId}/jobs` | – `{ jobs: [...] }`, newest first and at most 20: the jobs this widget's own invoke bindings started, so a remounted widget finds its running jobs. Each entry has the same fields as the single-job route's `job` and passes the same owner check; an instance outside the conversation is `404 INSTANCE_UNKNOWN`. In a frame this is `jobs.list()`, offered as its own bridge extension `jobs.list@1` beside `jobs@1` |
| GET | `/conversations/{id}/widgets/{instanceId}/jobs/{jobId}` | – `{ job: { jobId, status, progress?, resultRefs, output?, error?, createdAt, startedAt?, endedAt? } }`; files are `ArtifactRef`s, never paths |
| POST | `/conversations/{id}/widgets/{instanceId}/jobs/{jobId}` | – cancels the service request, `202 { accepted, jobId }`; an ended job is `409 JOB_NOT_RUNNING` and stays readable |

A node without a job host answers `503 JOB_UNAVAILABLE`. `POST /stop` also cancels running package jobs and counts them
in `stopped.jobs`.

The list route is not limited to the person's own surfaces, by design, the same as the single-job routes beside it
(`packages/contracts/src/machine-surfaces.ts` names none of them). A machine client, such as an MCP or relay client, can
list an instance's jobs, their outputs and their `ArtifactRef`s without knowing a JobRef first. It
learns nothing it could not read one job at a time, and it cannot read a file's bytes through these routes.

Browser tokens a frame asks for (`tokens@1`, [widget-development.md §14.3](widget-development.md#143-browser-tokens-tokens1))
are in `/openapi.json`. Host chrome asks for them on behalf of the frame it mounted, with the random session id it gave
that mount. A token is issued only for a provider and scopes the widget's package declared in its UI facet's
`browserTokens`, and only when the node has an adapter that mints a scoped token for those scopes and that lifetime
(30–3600 s, 900 s when none is asked). A request is refused, never narrowed. The node keeps only the provider's token
id and audits the provider and outcome as `browser-token`, never the value
(`packages/contracts/src/browser-token.ts`).

| Method | Path | Body / answer |
|---|---|---|
| POST | `/conversations/{id}/widgets/{instanceId}/browser-tokens` | `{ session, request: { provider, scopes, ttlSeconds? } }` — `{ token: { provider, token, scopes, expiresAt } }`. Person-only |
| DELETE | `/conversations/{id}/widgets/{instanceId}/browser-tokens/{session}` | – `{ ended: true, revoked }`; the session's tokens are revoked where the provider supports it, and a later request for it is `409 TOKEN_SESSION_ENDED` |

Refusals: `403 TOKEN_PROVIDER_NOT_DECLARED` or `TOKEN_SCOPE_NOT_DECLARED`, `409 TOKEN_PACKAGE_NOT_ACTIVE` or
`TOKEN_SESSION_ENDED`, `422 TOKEN_PROVIDER_UNSCOPED`, `TOKEN_SCOPE_NOT_SUPPORTED` or `TOKEN_TTL_TOO_LONG`,
`502 TOKEN_ISSUE_FAILED`, and `503 TOKEN_PROVIDER_UNAVAILABLE` on a node without an adapter for the provider. No
provider adapter ships yet. A node started with `CC_BROWSER_TOKEN_FIXTURE=1` registers in-process fixture providers for
the browser suite and answers `GET /browser-token-fixture/issued`; without it, that route is `404`. A node started
with `CC_UPDATE_CHECK_FIXTURE=1` answers `POST /update-check-fixture/run` by running the package update check once
(`{ packageUpdates }`), so the browser suite can be offered an update after installing; without it, that route is `404`.

The bridge side (`tokens@1`) is offered in `init.extensions` only to a frame whose package declared browser tokens.
`token.request` is answered with `token-result`; the SDK and the host's frame session refuse a `state.update`,
`semantic.publish` or `actions.invoke` that carries an issued token with `TOKEN_NOT_ALLOWED`.


Every instance route is checked again against that instance's grant. A ref is a pointer, not a permission, so an
expired (`403 ARTIFACT_GRANT_EXPIRED`) or revoked (`403 ARTIFACT_GRANT_REVOKED`) grant stops the next call. Sizes,
types and quota follow the attachment rules (`413 ARTIFACT_TOO_LARGE`, `415 ARTIFACT_TYPE_MISMATCH`, `409
ARTIFACT_QUOTA_EXCEEDED`), and one instance holds at most 128 MiB of the quota (`409 ARTIFACT_INSTANCE_QUOTA_EXCEEDED`),
counting the files it made and the attachments it made from them but not the files the person picked for it. An attach
of a file already attached answers with the same attachment.
A file name in `Content-Disposition` is sent as RFC 6266 describes: an ASCII `filename` and the real name as
percent-encoded UTF-8 in `filename*`. Bidi controls are dropped from both, a percent sign becomes `_` in the ASCII
name, and a name longer than 120 characters is shortened before its extension, which is always kept.

**Installing a package is person-only.** `POST /packages/install` `{ "packageId", "version" }` is what the app's own
Install button and a notice's `update` call; no agent tool installs a package (the package tool lists, uninstalls,
restores and rolls back), and the WebSocket relay, `clarkcant api` and MCP refuse the route with `403 PERSON_ONLY`.

For a package listed by a path on this machine the node copies its files into its package cache
(`<dataDir>/package-cache/local/<sha256>`) and digests the copy (`digestOfDirectory`, the digest a git or npm fetch
computes), so the request needs no digest from the client. The copy is staged in a temporary folder, digested from the
bytes written there and only then renamed to its content-addressed name; the same bytes installed again reuse the copy
already there. The copy does not hold up the node while it runs. The `marketplace-results` card carries the digest of
the files as each local listing's `contentDigest`, computed when the node listed them, and the Install button sends it
back as `{ "contentDigest" }`. If the copy differs from it (the files changed since the list was made, including while
the install was copying them), the install is refused with `409 DIGEST_MISMATCH` and a reason that says so and tells
the person to search again; nothing is installed, asked or cached, and the card marks that row as changed rather than
offering the same refused install again. A request without `contentDigest` (a card from before the field, or a notice's
`update`) installs the files as they are when it arrives: the node lists the path again after the copy, and if any file
or folder changed its size, modification time or identity while it was being copied, the install is refused with
`409 DIGEST_MISMATCH` and a reason saying so, so a copy is never a mix of two versions. The installed package runs from
the copy, not the path: its files, frames, widgets, themes and services are read from the snapshot its generation
records (`snapshotDigest` on the generation and in `GET /packages`), so later edits to the path never run until the
package is installed again, which copies and checks the files anew and activates a new generation. If the listing
changes under an installed package instead (the same version listed again with another `digest`, or another version
listed), neither the copy nor the path is served for that listing: `GET /packages/:id/:version/files/…`, the frame route
and the conversation's widget read answer `409 NOT_INSTALLED` until the package is installed again, and its widgets keep
their state. A path whose files cannot be copied is refused with `400 LOCAL_SOURCE_UNREADABLE`: unreadable, holding a
symbolic link, junction or hard link (which the copy refuses rather than follows; on every platform a file replaced by a
link or another file after it was listed is refused too), or too large to verify (more than 5,000 files, 5,000 folders,
folders 64 deep or 64 MiB, the bound that keeps a search's digests cheap; the card then carries no `contentDigest` for
it). A `.git` folder at the root is left out in any letter case. A copy the node cannot write into its own cache (a full
disk, a cache folder it may not write, a rename Windows keeps refusing) is refused with `503 PACKAGE_CACHE_UNAVAILABLE`
and a reason saying the files were not changed and to try again. These checks run before the execution policy decides,
so a person whose mode would deny the install still gets the `409`, `400` or `503` rather than `403 POLICY_REFUSED`;
the copy a refused or asked install made stays in the cache and is reused. The `effect.executed` record of a local
install names the copy it runs (`files sha256:…` in its description). A local install's plan and generation carry the
listing's `digest`; a client that sends `{ "localDigest" }` names that identity itself, as before, and its install
still runs from a copy. A package installed from a path before snapshots keeps reading its path until it is installed
again; nothing is migrated or deleted. Temporary folders a stopped install left in the cache are removed by a later
install once they are an hour old; otherwise the package cache has no garbage collection, for snapshots as for git and
npm artifacts, so a snapshot no generation uses any more stays on disk until the cache is cleared by hand.

When the person's execution mode asks before installing, it answers `202` with
`{ "code": "APPROVAL_REQUIRED", "approvalId" }` and installs nothing. The question then waits in `GET /inbox` under
`waiting` as `{ "kind": "install-approval", approvalId, packageId, version, displayName, riskTier, permissions,
description, operationDigest, requestedAt, expiresAt, reach?, reachChange?, unreadFields? }`: `permissions` is what the listing says the package asks for,
`reach` what it reaches outside its sandbox, `reachChange` (for an update of an installed package) what that version
adds to or drops from the installed one's reach, in the same shape as on the update notice, `unreadFields`
(`{ count, names }`) the fields the listing carries that this node does not read and dropped, counted in full and named only as plain identifier paths, at most 8 (the same
field is on each `marketplace-results` row and on a package update notice; see
[directory metadata](widget-development.md#18-directory-metadata)),
and `operationDigest` the listed artifact's digest the question is about. It is listed only while the directory still
lists that artifact; a package or version republished since is left out, and installing it again asks about what it is
now. The person decides it with `POST /packages/approvals/:id/decision`
`{ "decision": "granted" | "denied", "digest": "<operationDigest>" }`, the same person-only route that decides a
package capability. `denied` answers `200` `{ decision, packageId, version }` and installs nothing. `granted` runs the
same install again, with every check it makes, bound to that digest: a listing whose digest changed since the question
is refused with `409 DIGEST_MISMATCH` before anything is decided, and the approval stays pending. For a package listed
by a path on this machine the question also pins the content of its files when it was asked (`digestOfDirectory`, the
digest a git or npm fetch computes); if those files change afterwards the question is no longer listed, and Approve is
refused with the same `409 DIGEST_MISMATCH` and a reason saying so, installing nothing; installing it again asks about
the files as they are now, and a path whose files cannot be read is refused when asked (`400 LOCAL_SOURCE_UNREADABLE`).
A policy that now
forbids installing still refuses (`403 POLICY_REFUSED`); success answers `200` with
`{ decision: "granted", installed: { packageId, version }, generationId, state, pendingCapabilities,
deniedCapabilities }`. A decision on another digest is `409 APPROVAL_FORGED`, a second decision
`409 APPROVAL_ALREADY_DECIDED`, and one after the ten-minute deadline `409 APPROVAL_EXPIRED`. An approval nobody
decided in time is settled as expired by the node's periodic sweep, which leaves a notice saying nothing was
installed. Every outcome (`asked`, `installed`, `denied`, `expired`, `refused` or `failed`, with its code) is recorded
as a `package.install-approval` event.

The widget action call, `POST /conversations/{id}/widgets/{instanceId}/actions`, takes a body the route validates with
`actionInvocationSchema` (`packages/contracts/src/widgets.ts`); anything outside it is `400 INVALID_SCHEMA`, and so is
an `invocationId` starting with `view-state:`, which is reserved for the node's own records. An optional `variant`
picks the call. Absent is the ordinary invocation, answered with the outcome and the conversation timeline.
`"view-state"` is the state-only write of a host-held player's playback state (`canvas.video@1`, `canvas.audio@1`),
and it carries a required `sequence`: a positive integer that grows with every write the player makes, across page
loads, at most a day past the node's clock (the host sends `max(now in milliseconds, previous + 1)`). It takes the same
owner, binding, revision, digest and input checks, then answers
`200 { variant, duplicate, instanceId, revision, stateRevision, state }` with no timeline, an unmoved instance revision
and one invocation record per binding. A write whose `sequence` is not newer than the last one accepted, including a
retry or a replayed older id, writes nothing and is answered `duplicate: true` (with `stale: true` when it was an older
write) with the state and revision the node holds now. A `sequence` without the variant, or the variant without one, is
`400 INVALID_SCHEMA`; any other binding is `400 UNSUPPORTED_ACTION`, and any other `variant` value is
`400 INVALID_SCHEMA`. See [widget development §8.11](widget-development.md#811-media-widgets-and-semantic-state).

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
| `read_inbox` | – | `GET /inbox` |
| `act_on_notice` | `noticeId`, `action`, `until?` | `POST /inbox/notices/{noticeId}/actions/{action}` |

**No approval tool, on purpose.** An approval is the person's decision about something an agent wants to do; an MCP
tool for it would let an AI client approve its own guarded action. Approvals stay on the person's own surfaces, and
the generic relays (a WebSocket `request` frame, `clarkcant api`) and MCP refuse every route that records a person's
decision with `403 PERSON_ONLY` for the same reason: approving a guarded action (on a card, or one a running task
raised), deciding a package capability, installing a package (`POST /packages/install`) or deciding an install the
person's execution mode asked about, confirming an app intent, reporting what the page did with an action the agent asked for, reporting what a widget's frame did with an action Clark asked it to perform (`POST /app-intents/widget-perform/{performId}`), trusting a paired peer,
issuing a grant, asking for a browser token for a frame
(`POST /conversations/{id}/widgets/{instanceId}/browser-tokens`; only the host chrome that mounted the frame asks, and a
machine client would be asking for a credential to keep), and recording whether an action whose outcome nobody saw took effect
(`POST /effects/{effectId}/reconcile`; an AI client that could say "that push landed" could clear its own task's
uncertainty and then report its own success). Exporting a table as a CSV file
(`POST /conversations/{id}/widgets/{instanceId}/export`) is refused on the same relays too: the file is written for
the person who is looking at the table, not handed to a machine client. Saving a widget's artifact
(`POST /artifacts/{artifactId}/export`) and handing a widget a file the person picked
(`POST /conversations/{id}/widgets/{instanceId}/artifacts/pick`) are refused the same way. What is held back is the
act, not the data: saving is the person choosing to keep a file, and a machine client can still read a finalized
artifact's bytes through `GET /artifacts/{artifactId}/content`. Picking grants a widget bytes only the person's choice
may give it. Stop, answering a question and reading stay
available, and so does `act_on_notice`: it never offers the person's answer about an unknown outcome or installing a
notice's update (`403 PERSON_ONLY` for both, the update route refused as above). `read_inbox` marks every notice's
title and body as data reported by other work, never instructions, and keeps each on one line. The discovery document
lists this under `personDecisions`.

**A package service's own MCP connection.** The node is the MCP client of each package service it runs over stdio.
When the service's `tools` facet declares `egress`, the node's `initialize` request offers
`capabilities.experimental["clarkcant/egress"]` (`version: 1`), and the service may send the node the request
`clarkcant/egress.fetch` with `{ version: 1, url, method?, headers?, body? }`. The node makes the HTTP request to a
declared origin only, adds the declared credential header from the secret stored for `package:<id>`, follows no
redirect, and replaces the secret with `[redacted]` in what it returns as a best-effort guard. It answers only `GET` and
`HEAD` unless a call in flight was decided as `external-write` or riskier, rate-limits each service, and refuses
loopback and private origins unless the node runs with `CC_EGRESS_ALLOW_PRIVATE_NETWORK=1`. Refusals are JSON-RPC
errors `-32010` to `-32018`
(`packages/contracts/src/service-egress.ts`, [widget-development.md §14.2](widget-development.md#142-reaching-a-provider-from-a-service)).
This method is not on `POST /mcp`.

WebMCP (a page exposing tools to a browser's own agent) was considered for the same notice actions and is not offered:
the proposal is still a draft without a shipped browser API, and ClarkCant's page has no tool surface of its own to
expose; the MCP tools above are the machine surface.

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

- Any REST route except a person's decision or installing a package can be sent as a `request` frame; the answer is
  the gateway's own status and body.
- `id` is echoed exactly as sent, string or number.
- Query parameters go in a `query` object on the frame, not in `path`.
- Up to 16 requests may run at once per socket, told apart by `id`.
- A refused request (`INVALID_FRAME`, `TOO_MANY_REQUESTS`) gets an `error` frame carrying its `id` instead of a
  `response`; that frame is the last one for the `id`.
- A route that answers with bytes (attachments, images) returns `415 USE_HTTP`.
- `ping` → `pong`. No auth within 10 s, or a wrong token: an `error` frame and close code `4401`.

## CLI

`apps/cli` (`@clarkcant/cli`) is a client of the gateway. The only exception is `instructions check`, which contacts
no node and checks a local file against an open contract. The CLI is not published to npm yet; run it from a checkout
with `node apps/cli/src/main.ts` or `pnpm clarkcant`.

| Command | |
|---|---|
| `clarkcant ask "<text>" [-c <conversationId>]` | streams the answer to stdout; the conversation id goes to stderr |
| `clarkcant status` | node label, URL, model |
| `clarkcant conversations` / `new [title]` / `read <id>` | conversations |
| `clarkcant stop` | emergency stop |
| `clarkcant api <METHOD> <path> [jsonBody]` | any route except a person's decision or installing a package |
| `clarkcant mcp` | MCP over stdio |
| `clarkcant discover` | the discovery document |
| `clarkcant instructions check [file]` | checks a project's `.clarkcant/instructions.json` offline (see below) |

Connection: `--url` / `CLARKCANT_URL`, `--token` / `CLARKCANT_TOKEN`, else `identity.json` in `--data-dir` /
`CLARKCANT_DATA_DIR` (default `~/.clarkcant`). The identity file is only read for a node on this machine
(`localhost`, `127.x`, `::1`); a remote `--url` needs `--token` or `CLARKCANT_TOKEN`, so the local token is never sent
to another host. `clarkcant mcp` forwards each line as it arrives, so a `ping` is answered while a long call runs.
`--json` prints raw JSON.

## Project instructions file

`<project>/.clarkcant/instructions.json` holds a project's conditional instructions: rules that state a snippet
(`<project>/.clarkcant/instructions/<name>.md`) while the work touches what the rule is about. It is a versioned open
contract. The schema is `packages/contracts/src/project-instructions.ts`
(`projectInstructionsFileSchema`, `readProjectInstructions`, `projectInstructionsProblems`). The node reads the file with
it, and `clarkcant instructions check` validates it with the same schema. How a rule applies is described in
[system-architecture.md §7.2](system-architecture.md).

```json
{
  "version": 1,
  "rules": [
    { "when": { "path": "packages/storage/**", "operation": "write" }, "include": ["migrations"], "pin": false }
  ]
}
```

- `version` is required in a file written now. Version 1 is the only version. A file without `version`, written before
  the field was required, is still read as version 1. The node does not read a file with a version it does not know.
- `rules` holds at most 32 rules. Each rule has `when`, an `include` list of 1 to 8 snippet names (lowercase letters,
  digits and `-`, up to 64 characters), and an optional `pin`. `when` may name `project`, `path`, `operation`
  (`read`, `write`, `command`, `test`, `deploy`), `capability`, `role` (`foreground`, `background`, `task`) and
  `skill`. Each takes one value or a list of up to 16. A `path` glob has at most 200 characters, 16 wildcards and
  32 folders. Unknown fields are refused, and a file larger than 64 KB is not read.
- The node leaves out a rule that does not parse and applies the rest. `clarkcant instructions check` holds a file to the
  rules for writing it: a missing `version` and every invalid rule are each reported on their own line, and the exit
  code is 1. `--json` prints `{ path, ok, problems }`. The default file is `.clarkcant/instructions.json` in the current
  folder.
- An instruction grants nothing. The node reads it only from a project inside a root the person granted, and every
  effect still goes through the execution policy. A package cannot contribute rules yet.

## Changing a surface

Follow the rules in [AGENTS.md](../AGENTS.md#open-interfaces): a new capability goes through a gateway route first,
the other surfaces reach it through that route, `open-interfaces.ts` and this document change in the same PR, and a
docs change for the website is filed as an `ai-handle` issue on `digitopvn/clarkcant-web`.

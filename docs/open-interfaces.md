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
(what waits on the person, the notices, the notices snoozed for later and the kinds quieted), `GET /inbox/summary`,
`POST /inbox/read` and `/inbox/unread`, per notice `POST /inbox/notices/:id/<action>` where the action is `dismiss`,
`restore`, `snooze`, `unsnooze`, `suppress` or `unsuppress`, and `DELETE /inbox/suppressions/:id`. `snooze` takes `{ "until": "<ISO instant>" }`, ahead of
now and at most 30 days away (else `400 SNOOZE_OUT_OF_RANGE`); the notice leaves the list and the unread count and comes
back unread once that time has passed; `unsnooze` returns it at once, read or unread as it was before. `suppress` quiets
the notice's kind for this principal: later notices of that kind are still listed but arrive read and raise no
notification. Only a narrow kind can be quieted, one tied to an automation, a signal source, a package, a node, or a
person's own background work; any other kind would also silence reminders and every other automation's notices, so
the route refuses it with `409 SUPPRESSION_TOO_BROAD` and the notice's `actions` never offer it. Each route acts only on the calling principal's own
notices. The shapes are `packages/contracts/src/inbox.ts`; the behaviour is described in
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
confirming an app intent, reporting what the page did with an action the agent asked for, trusting a paired peer and
issuing a grant. Exporting a table as a CSV file
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

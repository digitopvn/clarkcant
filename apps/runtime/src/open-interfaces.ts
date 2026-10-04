import { MAP_TILE_KEY_OFFLINE_REASONS, PERSON_ONLY_REFUSAL } from "@clarkcant/contracts";

/**
 * The node's open interfaces, described in the formats other tools already read.
 *
 * Every surface a third-party app or AI tool can use — HTTP/JSON, Server-Sent Events, MCP, the WebSocket and the
 * CLI — ends at the same gateway handler with the same bearer token. These two documents say so in machine-readable
 * form: a discovery document a client can fetch first, and an OpenAPI description of the stable REST surface.
 *
 * Both are public and both are static: they describe routes, not this node, so they disclose no identity, and a
 * client can read them before it holds a token.
 */

/** MCP protocol revisions the `/mcp` endpoint answers, newest first. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The frame protocol spoken on `/ws` after authentication. */
export const API_SOCKET_PROTOCOL = "clarkcant.ws.v1";

export const API_SOCKET_PATH = "/ws";
export const MCP_PATH = "/mcp";
export const DISCOVERY_PATH = "/.well-known/clarkcant.json";
export const OPENAPI_PATH = "/openapi.json";

export function discoveryDocument(): Record<string, unknown> {
  return {
    name: "clarkcant",
    apiVersion: "v1",
    auth: {
      scheme: "bearer",
      header: "Authorization",
      tokenSource: "localToken in <data-dir>/identity.json (default data dir ~/.clarkcant)",
    },
    surfaces: {
      api: { transport: "http", openapi: OPENAPI_PATH, health: "/health", streaming: "text/event-stream" },
      mcp: { endpoint: MCP_PATH, transport: "streamable-http", protocolVersions: MCP_PROTOCOL_VERSIONS },
      websocket: { endpoint: API_SOCKET_PATH, protocol: API_SOCKET_PROTOCOL, auth: "first frame { type: 'auth', token }" },
      cli: { command: "clarkcant", package: "@clarkcant/cli", mcpStdio: "clarkcant mcp" },
    },
    // Told up front so a tool does not try: approvals, grants, trust, file exports, installing a package or a notice's
    // update, and deciding an install the policy asked about are made by the person in the app.
    personDecisions: {
      refusedOn: ["websocket", "mcp", "cli api"],
      refusal: { status: 403, code: PERSON_ONLY_REFUSAL.code },
    },
  };
}

const errorSchema = {
  type: "object",
  required: ["code", "message"],
  properties: { code: { type: "string" }, message: { type: "string" } },
};

const messageBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 20_000 },
          attachmentIds: { type: "array", items: { type: "string" } },
          references: {
            type: "object",
            description:
              "What the person picked after / or @ in the composer: { version: 1, items } with at most 8 items, each " +
              "{ kind, label, ... } for a skill, project, file, folder, mcp-server, conversation, background-work or " +
              "notice. Checked again when the message is sent; one that no longer holds refuses the message with 400 " +
              "REFERENCE_NOT_AVAILABLE naming it. A reference is a pointer, not a permission.",
            required: ["version", "items"],
            properties: { version: { const: 1 }, items: { type: "array", maxItems: 8, items: { type: "object" } } },
          },
        },
      },
    },
  },
};

const conversationId = { name: "conversationId", in: "path", required: true, schema: { type: "string" } };
const questionId = { name: "questionId", in: "path", required: true, schema: { type: "string" } };
const instanceId = { name: "instanceId", in: "path", required: true, schema: { type: "string" } };
const artifactId = { name: "artifactId", in: "path", required: true, schema: { type: "string" } };
const jobId = { name: "jobId", in: "path", required: true, schema: { type: "string", pattern: "^job_[A-Za-z0-9_-]{1,120}$" } };
const tokenSession = { name: "session", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } };

function ok(description: string): Record<string, unknown> {
  return { description, content: { "application/json": { schema: { type: "object" } } } };
}

/** A refusal answered with the Error body, under its own description. */
function refusal(description: string): Record<string, unknown> {
  return { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
}

const refusals = {
  "400": refusal("Malformed request"),
  "401": refusal("Missing or wrong bearer token"),
  "404": refusal("No such resource"),
};

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "ClarkCant node API",
      version: "1.0.0",
      description:
        "The stable REST surface of a ClarkCant node. MCP (" +
        MCP_PATH +
        "), the WebSocket (" +
        API_SOCKET_PATH +
        ") and the CLI reach these same routes with the same token.",
    },
    servers: [{ url: "http://127.0.0.1:8765", description: "Default local node" }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: { Error: errorSchema },
    },
    paths: {
      "/health": {
        get: { summary: "Readiness probe", security: [], responses: { "200": ok("Node is serving") } },
      },
      [DISCOVERY_PATH]: {
        get: { summary: "Discovery document for every open surface", security: [], responses: { "200": ok("Surfaces") } },
      },
      [OPENAPI_PATH]: {
        get: { summary: "This document", security: [], responses: { "200": ok("OpenAPI 3.1") } },
      },
      "/node": { get: { summary: "The node and its configured model", responses: { "200": ok("Node"), ...refusals } } },
      "/conversations": {
        get: { summary: "List conversations", responses: { "200": ok("Conversations"), ...refusals } },
        post: {
          summary: "Create a conversation",
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { title: { type: "string", maxLength: 200 } } } } },
          },
          responses: { "201": ok("Created: { conversationId, homeNodeId }"), ...refusals },
        },
      },
      "/conversations/{conversationId}/delete": {
        post: {
          summary: "Delete a local conversation and release its attachments and widget files",
          description: "Person-only. Execution policy chooses execute, ask or deny. A 202 question uses /app-intents/confirm; its scoped deletionPermit is sent back here. No Undo. Unsettled work refuses deletion; saved memory, shared resources, session logs and audit history remain.",
          parameters: [conversationId],
          requestBody: {required: true, content: {"application/json": {schema: {type: "object", additionalProperties: false, properties: {deletionPermit: {type: "string", format: "uuid"}}}}}},
          responses: {"200": ok("Deleted: { deleted: true, conversationId, attachments, artifacts, pendingFiles, readBack }"), "202": ok("Policy asks: { deleted: false, decision }"), "409": ok("Kept: { deleted: false, decision }"), ...refusals},
        },
      },
      "/conversations/{conversationId}/messages": {
        post: {
          summary: "Send a message and wait for Clark's answer",
          parameters: [conversationId],
          requestBody: messageBody,
          responses: {
            "200": ok("Answered: { resolution, taskId, messageIds, timeline }"),
            "202": ok("Accepted: work continues (task, background or steered turn)"),
            ...refusals,
          },
        },
      },
      "/conversations/{conversationId}/messages/stream": {
        post: {
          summary: "Send a message and stream the answer",
          description:
            "Server-Sent Events in the order the turn produced them: delta { text }, reasoning, tool-start, tool-end, " +
            "host-control, widget-perform { request } (an action Clark asks a widget shown on this page to perform, sent only " +
            "when the request carries x-clarkcant-widget-perform: 1; the page reports what the frame answered at " +
            "/app-intents/widget-perform/{performId}), error, and a final " +
            "done { resolution, taskId, messageIds, timeline }.",
          parameters: [conversationId],
          requestBody: messageBody,
          responses: { "200": { description: "Event stream", content: { "text/event-stream": { schema: { type: "string" } } } }, ...refusals },
        },
      },
      "/conversations/{conversationId}/stop": {
        post: {
          summary: "Stop the reply this conversation is writing",
          description:
            "Aborts the provider for this conversation's running turn. What was already written is kept and labelled " +
            "as stopped; nothing written after the stop reaches it. Answers { stopped: false } when no reply was " +
            "running. A stop is recorded in the audit log with where it came from.",
          parameters: [conversationId],
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { source: { type: "string", enum: ["chat", "voice"] } } },
              },
            },
          },
          responses: { "200": ok("Answered: { stopped }"), ...refusals },
        },
      },
      "/conversations/{conversationId}/timeline": {
        get: {
          summary: "Read a conversation",
          parameters: [conversationId, { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
          responses: { "200": ok("Timeline: { conversationId, cursor, messages, pins, instances, snapshots }"), ...refusals },
        },
      },
      "/conversations/{conversationId}/questions/{questionId}/answer": {
        post: {
          summary: "Answer a question Clark asked",
          parameters: [conversationId, questionId],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    text: { type: "string" },
                    optionIds: { type: "array", items: { type: "string" } },
                    confirmed: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: { "200": ok("Answered; a new turn starts"), "409": ok("The question can no longer be answered"), ...refusals },
        },
      },
      "/conversations/{conversationId}/questions/{questionId}/cancel": {
        post: { summary: "Drop a waiting question", parameters: [conversationId, questionId], responses: { "200": ok("Cancelled"), ...refusals } },
      },
      "/signals": {
        post: {
          summary: "Tell the node something happened",
          description:
            "One signal: { source: { kind, provider?, sourceId }, topic, subject?, payload, occurredAt, dedupeKey, " +
            "provenance? }. A topic is dotted lower-case words; the payload is at most 64 KB. It is recorded before " +
            "anything is matched, then answered against the standing requests the person set up in conversation. The " +
            "same (source.sourceId, dedupeKey) again is 200 with the signal already recorded, never a second one. " +
            "Timer and system signals are the node's own and are refused with 403 SOURCE_RESERVED.",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "202": ok("Recorded: { signalId, duplicate: false }"),
            "200": ok("Already recorded: { signalId, duplicate: true }"),
            "403": ok("SOURCE_RESERVED: timer and system signals come from the node itself"),
            "413": ok("SIGNAL_TOO_LARGE"),
            ...refusals,
          },
        },
      },
      "/signals/github": {
        post: {
          summary: "GitHub's repository webhook",
          description:
            "A delivery exactly as GitHub sends it, verified instead of the bearer token: HMAC-SHA256 of the raw body " +
            "with the webhook secret the node keeps as github_webhook_secret, in X-Hub-Signature-256. Normalized into " +
            "a signal (github.issue.*, github.pull_request.*, github.issue_comment.*, " +
            "github.pull_request_review_comment.*, github.workflow_run.*, github.check_suite.*) deduplicated on " +
            "X-GitHub-Delivery. Signals caused by the node's own GitHub logins (signals.github.selfLogins) are marked " +
            "selfGenerated. Bodies over 2 MiB are refused with 413.",
          security: [],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "202": ok("Recorded: { signalId, duplicate: false }"),
            "200": ok("A redelivery { signalId, duplicate: true }, a ping { pong: true }, or an event not turned into signals { ignored }"),
            "400": ok("DELIVERY_INVALID: no event, no delivery id, or not a GitHub payload"),
            "401": ok("SIGNATURE_INVALID: missing or wrong signature; nothing is recorded"),
            "413": ok("PAYLOAD_TOO_LARGE"),
            "503": ok("GITHUB_WEBHOOK_NOT_CONFIGURED: the node has no webhook secret yet"),
          },
        },
      },
      "/signals/webhook/{source}": {
        post: {
          summary: "A signed webhook from anything, as a named signal source",
          description:
            "{ id, topic, payload?, subject?, occurredAt? }, verified instead of the bearer token: HMAC-SHA256 of the raw " +
            "body with the secret the node keeps as webhook_<source>_secret, as sha256=<hex> in X-Signature-256. " +
            "Recorded as the signal webhook.<source>.<topic>, deduplicated on id, so a sender cannot name another " +
            "source's topic. A source with no secret set is not found. Bodies over 256 KiB are refused with 413.",
          security: [],
          parameters: [{ name: "source", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" } }],
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "202": ok("Recorded: { signalId, duplicate: false }"),
            "200": ok("A redelivery: { signalId, duplicate: true }"),
            "400": ok("DELIVERY_INVALID: not { id, topic, payload?, subject?, occurredAt? }"),
            "401": ok("SIGNATURE_INVALID: missing or wrong signature; nothing is recorded"),
            "404": ok("WEBHOOK_SOURCE_UNKNOWN: no secret is set for this source"),
            "413": ok("PAYLOAD_TOO_LARGE"),
          },
        },
      },
      "/automations": {
        get: {
          summary: "The standing requests set up in conversation, each with what it did lately",
          description: "Read-only. An automation is created, paused, resumed and removed by asking Clark in conversation.",
          responses: { "200": ok("{ automations: [{ intent, recentRuns }] }"), ...refusals },
        },
      },
      "/composer/suggestions": {
        get: {
          summary: "What the composer offers after / or @",
          description:
            "Read-only and local: skills after /; projects, services, titled conversations and background work after @; " +
            "one directory of a project after @<project>/. At most 8 rows, ranked exact, then prefix, then substring. " +
            "A row that cannot be chosen says why in disabledReason. No row carries an absolute path.",
          parameters: [
            { name: "trigger", in: "query", required: true, schema: { type: "string", enum: ["/", "@"] } },
            { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
            { name: "conversationId", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("{ trigger, query, suggestions: [{ key, trigger, kind, label, note?, disabledReason?, ref }] }"), ...refusals },
        },
      },
      "/map-tiles": {
        get: {
          summary: "Whether maps on this node show raster tiles, and whose",
          description:
            "{ provider: { origin, attribution, maxZoom } | null, offline? } from the maps.tilePolicy preference. " +
            "Never the provider's path template or key. null means maps draw their offline basemap only, and offline says " +
            "why: no-provider (the default), key-unavailable (the policy needs a key and none is saved), or " +
            "key-origin-mismatch (the saved key was entered for another origin, so the node does not send it to this one).",
          responses: { "200": ok("{ provider, offline? }"), ...refusals },
        },
      },
      "/map-tiles/key": {
        get: {
          summary: "Whether a map tile provider key is saved, and the one origin it is sent to",
          description: "{ key: { origin? } | null }. Never the value. A key with no origin is bound to none and is sent nowhere.",
          responses: { "200": ok("{ key }"), ...refusals },
        },
        put: {
          summary: "Enter the map tile provider key, bound to an origin",
          description:
            "{ origin, value }. Stored as the host's own secret maps:tiles, which the node sends only to that origin; entering " +
            "it again for another origin moves the binding, and nothing else does. Answers { key: { origin } }, never the " +
            "value. Person-only: 403 PERSON_ONLY on machine surfaces.",
          responses: { "200": ok("{ key: { origin } }"), "403": ok("PERSON_ONLY on a machine surface"), ...refusals },
        },
        delete: {
          summary: "Remove the map tile provider key",
          description: "{ removed }. Person-only: 403 PERSON_ONLY on machine surfaces.",
          responses: { "200": ok("{ removed }"), "403": ok("PERSON_ONLY on a machine surface"), ...refusals },
        },
      },
      "/map-tiles/{z}/{x}/{y}": {
        get: {
          summary: "One raster tile from the tile policy's provider, fetched by the node",
          description:
            "Only the provider the policy names, on its own path template; z up to its maxZoom (at most 19), x and y on " +
            "that zoom's grid. Redirects are not followed. Served only as image/png or image/webp, checked by the " +
            "provider's type and the bytes, at most 512 KiB, with nosniff. The saved key is added by the node only when it " +
            "was entered for the policy's origin, and never returned. 404 MAP_TILES_OFF with no policy, 404 MAP_TILE_MISSING " +
            "when the provider has no tile at that address, 400 MAP_TILE_OUT_OF_BOUNDS, 429 MAP_TILES_RATE_LIMITED, " +
            "502 MAP_TILE_FAILED or MAP_TILE_REFUSED, 503 MAP_TILE_KEY_UNAVAILABLE. The 503 carries offline " +
            "(key-unavailable or key-origin-mismatch, as GET /map-tiles says) when the saved key is missing or bound to " +
            "another origin, whether the node finds that before asking the provider or while handing the key over; when the " +
            "key is in place but the node's secret store refuses to hand it over, the 503 has no offline.",
          parameters: ["z", "x", "y"].map((name) => ({ name, in: "path", required: true, schema: { type: "integer", minimum: 0 } })),
          responses: {
            "200": { description: "The tile, as image/png or image/webp" },
            ...refusals,
            "400": refusal("MAP_TILE_OUT_OF_BOUNDS: z, x or y is not a whole number on the provider's grid"),
            "404": refusal("MAP_TILES_OFF with no tile policy, or MAP_TILE_MISSING when the provider has no tile there"),
            "429": refusal("MAP_TILES_RATE_LIMITED: too many tile requests reach the provider; ask again shortly"),
            "502": refusal("MAP_TILE_FAILED when the provider cannot be reached, redirects or fails; MAP_TILE_REFUSED when its tile is not a bounded PNG or WebP"),
            "503": {
              description: "MAP_TILE_KEY_UNAVAILABLE: offline is present when the key is missing or bound to another origin, absent when the secret store refuses it",
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/Error" },
                      { properties: { offline: { type: "string", enum: [...MAP_TILE_KEY_OFFLINE_REASONS] } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      "/artifacts/{artifactId}": {
        get: {
          summary: "Describe an artifact",
          description:
            "{ artifact: { artifactId, digest, sizeBytes, mimeType, originNodeId, createdAt, expiresAt, expired } }, and " +
            "for a file a widget holds also { artifactRef: { v, artifactId, kind, mimeType, sizeBytes, name, digest? } }. " +
            "Nothing here carries a path. Another principal's artifact answers 404 ARTIFACT_NOT_FOUND.",
          parameters: [artifactId],
          responses: { "200": ok("{ artifactRef }"), ...refusals },
        },
      },
      "/artifacts/{artifactId}/content": {
        get: {
          summary: "The bytes of a finalized artifact, for the host's own Open",
          description:
            "Sealed artifacts only; a working one answers 409 ARTIFACT_NOT_FINALIZED. Served with nosniff, inline " +
            "only for images and text.",
          parameters: [artifactId],
          responses: { "200": { description: "The bytes, under the sniffed type" }, "409": ok("ARTIFACT_NOT_FINALIZED"), "410": ok("ARTIFACT_BYTES_MISSING"), ...refusals },
        },
      },
      "/artifacts/{artifactId}/export": {
        post: {
          summary: "Save As: the bytes of a finalized artifact as a download",
          description:
            "{ suggestedName? }, a file name and never a path. Person-only: refused with 403 PERSON_ONLY on the " +
            "WebSocket, MCP and `clarkcant api`, because it writes a file onto the person's machine.",
          parameters: [artifactId],
          requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { suggestedName: { type: "string", maxLength: 200 } } } } },
          },
          responses: {
            "200": { description: "The bytes, as an attachment download" },
            "403": ok("PERSON_ONLY on a machine surface"),
            "409": ok("ARTIFACT_NOT_FINALIZED"),
            ...refusals,
          },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts": {
        post: {
          summary: "Start a working artifact a widget instance may write",
          description:
            "{ mimeType, name? }. The type must be one the attachment pipeline accepts. The instance receives a write " +
            "grant that expires; the artifact expires unless it is written to or finalized. Every later call is " +
            "re-checked against the instance's grant.",
          parameters: [conversationId, instanceId],
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["mimeType"] } } } },
          responses: { "201": ok("{ artifactRef }"), "415": ok("ARTIFACT_TYPE_UNSUPPORTED"), ...refusals },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/pick": {
        post: {
          summary: "A file the person chose in host chrome, granted to one widget instance",
          description:
            "{ name, mimeType, contentBase64, accept? }. The bytes decide the type; name, type, size (25 MiB) and the " +
            "principal's quota are the attachment rules. Person-only: 403 PERSON_ONLY on machine surfaces.",
          parameters: [conversationId, instanceId],
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["name", "contentBase64"] } } } },
          responses: {
            "201": ok("{ artifactRef }"),
            "403": ok("PERSON_ONLY on a machine surface"),
            "409": ok("ARTIFACT_INSTANCE_QUOTA_EXCEEDED or ARTIFACT_QUOTA_EXCEEDED"),
            "413": ok("ARTIFACT_TOO_LARGE"),
            "415": ok("ARTIFACT_TYPE_MISMATCH, ARTIFACT_TYPE_UNSUPPORTED or ARTIFACT_TYPE_NOT_ACCEPTED"),
            ...refusals,
          },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/{artifactId}": {
        get: {
          summary: "Describe an artifact this instance was granted",
          parameters: [conversationId, instanceId, artifactId],
          responses: { "200": ok("{ artifactRef }"), "403": ok("ARTIFACT_NOT_GRANTED, ARTIFACT_GRANT_EXPIRED or ARTIFACT_GRANT_REVOKED"), ...refusals },
        },
        delete: {
          summary: "Discard a file this instance made",
          description:
            "Only a file the calling instance created, working or finalized; a file the person chose, or one another widget " +
            "made, is 403 ARTIFACT_NOT_CREATOR. The record and every grant on it go; the bytes go too unless an attachment " +
            "or another record still points at them. What was discarded no longer counts against the instance's share.",
          parameters: [conversationId, instanceId, artifactId],
          responses: { "200": ok("{ discarded: true, artifactId }"), "403": ok("ARTIFACT_NOT_CREATOR, ARTIFACT_NOT_GRANTED or ARTIFACT_GRANT_REVOKED"), ...refusals },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/{artifactId}/content": {
        get: {
          summary: "One bounded range of an artifact's bytes",
          description: "offset (default 0) and length (1 to 262144, default 262144). A length past the end is shortened and eof is true.",
          parameters: [
            conversationId,
            instanceId,
            artifactId,
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
            { name: "length", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 262_144 } },
          ],
          responses: { ...refusals, "200": ok("{ artifactRef, offset, eof, contentBase64 }"), "400": ok("ARTIFACT_RANGE_INVALID") },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/{artifactId}/chunks": {
        post: {
          summary: "Append one chunk to a working artifact",
          description:
            "{ offset, contentBase64 }: at most 262144 bytes, and offset must equal the artifact's current size, so a " +
            "repeated or reordered chunk is refused with 409 ARTIFACT_OFFSET_MISMATCH instead of stored twice.",
          parameters: [conversationId, instanceId, artifactId],
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["offset", "contentBase64"] } } } },
          responses: { "200": ok("{ artifactRef }"), "409": ok("ARTIFACT_OFFSET_MISMATCH, ARTIFACT_NOT_WRITABLE, ARTIFACT_INSTANCE_QUOTA_EXCEEDED (128 MiB per instance) or ARTIFACT_QUOTA_EXCEEDED"), "413": ok("ARTIFACT_CHUNK_TOO_LARGE or ARTIFACT_TOO_LARGE"), ...refusals },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/{artifactId}/finalize": {
        post: {
          summary: "Fix a working artifact's bytes",
          description: "The bytes are sniffed against the declared type; a disagreement is 415 ARTIFACT_TYPE_MISMATCH and the artifact stays writable.",
          parameters: [conversationId, instanceId, artifactId],
          responses: { "200": ok("{ artifactRef } with kind finalized and a digest"), "415": ok("ARTIFACT_TYPE_MISMATCH"), ...refusals },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/artifacts/{artifactId}/attach": {
        post: {
          summary: "Make a finalized artifact an attachment of this conversation",
          description:
            "Through the attachment pipeline (sniff, allowlist, quota). The answer's attachmentRef is sent with the " +
            "person's next message like any other attachment; the model reads it through the attachment brief or read_attachment.",
          parameters: [conversationId, instanceId, artifactId],
          responses: { "201": ok("{ artifactRef, attachmentRef }"), "409": ok("ARTIFACT_NOT_FINALIZED"), ...refusals },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/jobs": {
        get: {
          summary: "List the package jobs this instance started (jobs@1)",
          description:
            "Newest first, at most 20: the jobs this instance's own invoke bindings started, from a click, a spoken " +
            "command or Clark, read with the same owner tuple a single job is. A remounted frame finds its running jobs here.",
          parameters: [conversationId, instanceId],
          responses: { ...refusals, "200": ok("{ jobs: JobSnapshot[] }"), "404": ok("INSTANCE_UNKNOWN"), "503": ok("JOB_UNAVAILABLE") },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/jobs/{jobId}": {
        get: {
          summary: "Read a package job this instance started (jobs@1)",
          description:
            "A JobRef is a pointer, not authority: the job must have been started by one of this instance's own invoke " +
            "bindings, in this conversation, for the same principal, package generation and capability. Anything else, " +
            "including a ref that does not exist, is 404 JOB_NOT_FOUND. Progress is only what the service reported; a " +
            "finished job's files are ArtifactRefs this instance may read, never paths.",
          parameters: [conversationId, instanceId, jobId],
          responses: {
            ...refusals,
            "200": ok("{ job: { jobId, status, progress?, resultRefs, output?, error?, createdAt, startedAt?, endedAt? } }"),
            "404": ok("JOB_NOT_FOUND"),
            "503": ok("JOB_UNAVAILABLE"),
          },
        },
        post: {
          summary: "Stop a package job this instance started",
          description:
            "Cancels the running service request. A job that already reached the service may have completed its effect, " +
            "and its ending says so. An ended job is 409 JOB_NOT_RUNNING with its saved result still readable.",
          parameters: [conversationId, instanceId, jobId],
          responses: { ...refusals, "202": ok("{ accepted: true, jobId }"), "404": ok("JOB_NOT_FOUND"), "409": ok("JOB_NOT_RUNNING") },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/browser-tokens": {
        post: {
          summary: "Issue a short-lived browser token to one mounted frame (tokens@1). Person-only",
          description:
            "{ session, request: { provider, scopes, ttlSeconds? } }. session is the random id the host chrome gave this " +
            "mount of the frame. Issued only for a provider and scopes the widget's package declared in its UI facet's " +
            "browserTokens, and only when the provider's adapter says it can mint a scoped token for those scopes and that " +
            "lifetime (at most 3600 s, 900 s when none is asked). The token is bound to this instance and session, never " +
            "stored by the node, revoked when the session ends where the provider supports it, and audited by provider " +
            "and outcome only. A request is refused, never narrowed.",
          parameters: [conversationId, instanceId],
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["session", "request"] } } } },
          responses: {
            ...refusals,
            "200": ok("{ token: { provider, token, scopes, expiresAt } }"),
            "403": ok("TOKEN_PROVIDER_NOT_DECLARED, TOKEN_SCOPE_NOT_DECLARED or PERSON_ONLY"),
            "404": ok("RESOURCE_NOT_FOUND: no such instance in this conversation"),
            "409": ok("TOKEN_PACKAGE_NOT_ACTIVE or TOKEN_SESSION_ENDED"),
            "422": ok("TOKEN_PROVIDER_UNSCOPED, TOKEN_SCOPE_NOT_SUPPORTED or TOKEN_TTL_TOO_LONG"),
            "502": ok("TOKEN_ISSUE_FAILED"),
            "503": ok("TOKEN_PROVIDER_UNAVAILABLE: no adapter for this provider on this node"),
          },
        },
      },
      "/conversations/{conversationId}/widgets/{instanceId}/browser-tokens/{session}": {
        delete: {
          summary: "End one frame session's browser tokens",
          description:
            "Called by host chrome when the frame mounted under session goes. The node revokes what that session was " +
            "given where the provider supports it, and refuses any later request for the session with TOKEN_SESSION_ENDED.",
          parameters: [conversationId, instanceId, tokenSession],
          responses: { ...refusals, "200": ok("{ ended: true, revoked }: how many tokens were withdrawn"), "400": ok("INVALID_SCHEMA"), "404": ok("RESOURCE_NOT_FOUND") },
        },
      },
      "/stop": {
        post: {
          summary: "Emergency stop",
          description: "Kills running commands, interrupts turns and stops background work and package jobs on this node.",
          responses: { "200": ok("{ ok, stopped }"), ...refusals },
        },
      },
    },
  };
}

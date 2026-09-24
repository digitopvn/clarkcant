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
        },
      },
    },
  },
};

const conversationId = { name: "conversationId", in: "path", required: true, schema: { type: "string" } };
const questionId = { name: "questionId", in: "path", required: true, schema: { type: "string" } };

function ok(description: string): Record<string, unknown> {
  return { description, content: { "application/json": { schema: { type: "object" } } } };
}

const refusals = {
  "400": { description: "Malformed request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "401": { description: "Missing or wrong bearer token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "404": { description: "No such resource", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
            "host-control, error, and a final done { resolution, taskId, messageIds, timeline }.",
          parameters: [conversationId],
          requestBody: messageBody,
          responses: { "200": { description: "Event stream", content: { "text/event-stream": { schema: { type: "string" } } } }, ...refusals },
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
      "/stop": {
        post: {
          summary: "Emergency stop",
          description: "Kills running commands, interrupts turns and stops background work on this node.",
          responses: { "200": ok("{ ok, stopped }"), ...refusals },
        },
      },
    },
  };
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { ARTIFACT_LIMITS } from "@clarkcant/contracts";

/**
 * MCP tool and auth adapter seam.
 *
 * What is implemented here is the part that is pure logic and therefore testable
 * without a server: parsing tool metadata into our capability shape, deciding
 * whether a server's declared authorization method is one we can perform, and
 * validating that a token was issued for the audience we intend to call.
 *
 * The parts that need a live server are marked blocked rather than approximated.
 *
 * Note the trust position: tool descriptions and names from a server are untrusted
 * input. They are displayed to the user but never treated as instructions, and a
 * server cannot widen its own permissions by describing itself generously.
 */

export const mcpToolMetadataSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
});
export type McpToolMetadata = z.infer<typeof mcpToolMetadataSchema>;

/** Bytes returned by an MCP tool, kept separate from its human-readable text and never exposed as a path. */
export interface McpToolFile {
  mimeType: string;
  bytes: Uint8Array;
}

export interface McpToolResult {
  content: string;
  files?: McpToolFile[];
  filesOmitted?: true;
}

const MAX_TOOL_RESULT_FILES = 32;
const MAX_TOOL_RESULT_BYTES = 128 * 1024 * 1024;

/** Keep MCP text readable and extract bounded image/audio/resource bytes for the node's ArtifactRef broker. */
export function normalizeMcpToolResult(value: unknown): McpToolResult {
  const result = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const contentParts = Array.isArray(result["content"]) ? result["content"] : [];
  const text: string[] = [];
  const files: McpToolFile[] = [];
  let bytesStored = 0;
  let filesOmitted = false;
  const add = (mimeType: unknown, bytes: Uint8Array | undefined): void => {
    if (typeof mimeType !== "string" || bytes === undefined) {
      filesOmitted = true;
      return;
    }
    if (files.length >= MAX_TOOL_RESULT_FILES || bytes.byteLength > ARTIFACT_LIMITS.maxBytes || bytesStored + bytes.byteLength > MAX_TOOL_RESULT_BYTES) {
      filesOmitted = true;
      return;
    }
    files.push({ mimeType, bytes });
    bytesStored += bytes.byteLength;
  };
  const decode = (data: unknown): Uint8Array | undefined => {
    if (typeof data !== "string" || data.length > Math.ceil(ARTIFACT_LIMITS.maxBytes / 3) * 4
      || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return undefined;
    try {
      const bytes = Buffer.from(data, "base64");
      return bytes.toString("base64") === data ? new Uint8Array(bytes) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const entry of contentParts) {
    if (entry === null || typeof entry !== "object") continue;
    const part = entry as Record<string, unknown>;
    if (part["type"] === "text" && typeof part["text"] === "string") {
      text.push(part["text"]);
      continue;
    }
    if (part["type"] === "image" || part["type"] === "audio") {
      const bytes = decode(part["data"]);
      if (bytes === undefined) filesOmitted = true;
      else add(part["mimeType"], bytes);
      continue;
    }
    if (part["type"] !== "resource" || part["resource"] === null || typeof part["resource"] !== "object") continue;
    const resource = part["resource"] as Record<string, unknown>;
    const mimeType = typeof resource["mimeType"] === "string" ? resource["mimeType"] : "text/plain";
    if (typeof resource["text"] === "string") {
      if (Buffer.byteLength(resource["text"], "utf8") > ARTIFACT_LIMITS.maxBytes) filesOmitted = true;
      else add(mimeType, new TextEncoder().encode(resource["text"]));
    }
    else if (typeof resource["blob"] === "string") {
      const bytes = decode(resource["blob"]);
      if (bytes === undefined) filesOmitted = true;
      else add(mimeType, bytes);
    }
  }
  if (filesOmitted) text.push("Some service file results were omitted because they were malformed or exceeded the bounded artifact limits.");
  return {
    content: text.join("\n"),
    ...(files.length === 0 ? {} : { files }),
    ...(filesOmitted ? { filesOmitted: true as const } : {}),
  };
}

export interface NormalizedMcpTool {
  /** Namespaced to avoid collisions between servers. */
  capabilityRef: string;
  serverId: string;
  toolName: string;
  summary: string;
  inputSchema: Record<string, unknown>;
  effectCategory: "read" | "local-write" | "external-write" | "destructive";
  /** Whether the tool may be called without fresh approval. */
  safeWithoutApproval: boolean;
}

/**
 * Normalise a server's tool into a capability.
 *
 * The annotations are hints from an untrusted party, so they are used to *raise*
 * caution, never to lower it: a tool that does not claim to be read-only is treated
 * as a write, and a tool claiming `destructiveHint` is always destructive regardless
 * of what else it claims.
 */
export function normalizeMcpTool(
  serverId: string,
  tool: McpToolMetadata,
): NormalizedMcpTool {
  const annotations = tool.annotations ?? {};
  const claimsReadOnly = annotations.readOnlyHint === true;

  let effectCategory: NormalizedMcpTool["effectCategory"];
  if (annotations.destructiveHint === true) effectCategory = "destructive";
  else if (claimsReadOnly && annotations.idempotentHint === true && annotations.openWorldHint !== true) {
    effectCategory = "read";
  } else if (claimsReadOnly) effectCategory = "read";
  else effectCategory = "external-write";

  return {
    capabilityRef: `mcp.${sanitize(serverId)}.${sanitize(tool.name)}@1`,
    serverId,
    toolName: tool.name,
    summary: tool.description?.slice(0, 400) ?? `MCP tool ${tool.name} on ${serverId}`,
    inputSchema: tool.inputSchema,
    effectCategory,
    // Only a read-only, closed-world, idempotent tool skips approval. Everything else
    // asks, because being wrong in that direction is cheap and the other is not.
    safeWithoutApproval: effectCategory === "read",
  };
}

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Stable digest of a tool set, so a changed schema invalidates prior consent. */
export function toolSetDigest(tools: readonly McpToolMetadata[]): string {
  const canonical = [...tools]
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

export const mcpAuthRequirementSchema = z.strictObject({
  /** Whether the server advertises protected-resource metadata. */
  protectedResourceMetadata: z.string().min(1).max(500).optional(),
  authorizationServers: z.array(z.string().min(1).max(500)).max(16),
  /** Client registration methods the server supports. */
  registrationMethods: z.array(z.enum(["dynamic", "static", "none"])).max(4),
});
export type McpAuthRequirement = z.infer<typeof mcpAuthRequirementSchema>;

/**
 * Whether this client can perform the server's flow.
 *
 * The blueprint is explicit that not every server supports dynamic client
 * registration and that assuming otherwise produces a mysterious failure. Saying
 * "this server needs a pre-registered client" is a usable answer; attempting and
 * failing is not.
 */
export function canPerformAuth(requirement: McpAuthRequirement): { possible: true } | { possible: false; reason: string } {
  if (requirement.registrationMethods.includes("none")) return { possible: true };
  if (requirement.registrationMethods.includes("dynamic")) return { possible: true };
  if (requirement.authorizationServers.length === 0) {
    return { possible: false, reason: "the server declares no authorization server, so no flow can be started" };
  }
  return {
    possible: false,
    reason:
      "the server supports only a pre-registered client and no client credentials are configured for it; an operator must register this application first",
  };
}

/**
 * Verify a token's audience.
 *
 * A token issued for server A must never be presented to server B. Skipping this is
 * how a credential leaks sideways through a proxy of trusted-looking servers, so it
 * is checked on every call rather than only at link time.
 */
export function verifyTokenAudience(input: {
  tokenAudience: string | string[];
  expectedResource: string;
}): { ok: true } | { ok: false; reason: string } {
  const audiences = Array.isArray(input.tokenAudience) ? input.tokenAudience : [input.tokenAudience];
  if (!audiences.includes(input.expectedResource)) {
    return {
      ok: false,
      reason: `the token's audience [${audiences.join(", ")}] does not include the resource being called (${input.expectedResource}); the token was not issued for this server and must not be forwarded`,
    };
  }
  return { ok: true };
}

/**
 * The live MCP transports.
 *
 * Two of them, because a server is reached in two ways: stdio for a process on this machine, and
 * streamable HTTP for one that is not. Both are exercised against a real server rather than a mock.
 *
 * Metadata normalization, effect classification, tool-set digesting, auth-capability checks and
 * audience validation are implemented and tested. MCP Apps UI resource hosting is not built.
 */
export interface McpTransport {
  listTools(): Promise<McpToolMetadata[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

export {
  StdioMcpTransport,
  connectStdio,
  MCP_TRANSPORT_STATUS,
  McpRequestCancelled,
  McpRequestNotSent,
  McpRequestTimeout,
  type StdioMcpTransportOptions,
  type ServerHandshake,
} from "./stdio.ts";
export {
  MCP_HTTP_TRANSPORT_STATUS,
  StreamableHttpMcpTransport,
  connectStreamableHttp,
  type StreamableHttpMcpTransportOptions,
} from "./streamable-http.ts";

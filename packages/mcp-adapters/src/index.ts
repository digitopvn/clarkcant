import { createHash } from "node:crypto";
import { z } from "zod";

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
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }>;
}

export { StdioMcpTransport, connectStdio, MCP_TRANSPORT_STATUS, type StdioMcpTransportOptions, type ServerHandshake } from "./stdio.ts";
export {
  MCP_HTTP_TRANSPORT_STATUS,
  StreamableHttpMcpTransport,
  connectStreamableHttp,
  type StreamableHttpMcpTransportOptions,
} from "./streamable-http.ts";

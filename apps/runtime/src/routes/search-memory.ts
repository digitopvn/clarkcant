import { deleteMemory, listMemories, memoryCounts, type MemoryDeps } from "../memory.ts";
import { ingestSessionEntries, searchSessions } from "../session-search.ts";
import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * History search and what the node remembers.
 *
 * Both are principal-scoped at the query, which is what makes somebody else's history or somebody else's memory
 * unreachable rather than merely unaddressed: the scope comes from the transport, exactly as every other route
 * does, so there is no principal in the query or the path to lie about.
 *
 * The route owns its own HTTP: parsing a write, mapping a refusal to a status, and the shape of the answer.
 * Every dependency is a parameter, narrowed to the node fields these routes read.
 */
export interface SearchMemoryRouteDeps {
  services: Pick<NodeServices, "runtime" | "search" | "conductor">;
  request: GatewayRequest;
  segments: string[];
}

/**
 * The search family. `undefined` means the request is not one of these routes.
 */
export async function handleSearchRoutes(deps: SearchMemoryRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments } = deps;
  if (segments[0] !== "search") return undefined;
  const search = deps.services.search;

  // POST /search/sessions/:sessionId/ingest
  if (segments.length === 4 && segments[1] === "sessions" && segments[3] === "ingest" && request.method === "POST") {
    const sessionId = segments[2] ?? "";
    const outcome = ingestSessionEntries(search, { sessionId });
    if ("error" in outcome) {
      const status = outcome.error.includes("another principal") ? 403 : 404;
      return fail(status, "SESSION_NOT_INDEXED", outcome.error);
    }
    return json(200, outcome);
  }

  // GET /search/sessions?q=…&limit=…  and  POST /search/sessions {query}
  if (segments.length === 2 && segments[1] === "sessions") {
    const fromQuery = request.query.q ?? "";
    let text = fromQuery;
    let limit: number | undefined;
    let conversationId: string | undefined;
    let taskId: string | undefined;
    let source: "message" | "session_entry" | undefined;

    if (request.method === "POST") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      text = typeof parsed.value.query === "string" ? parsed.value.query : "";
      if (typeof parsed.value.limit === "number") limit = parsed.value.limit;
      if (typeof parsed.value.conversationId === "string") conversationId = parsed.value.conversationId;
      if (typeof parsed.value.taskId === "string") taskId = parsed.value.taskId;
      if (parsed.value.source === "message" || parsed.value.source === "session_entry") source = parsed.value.source;
    } else if (request.method !== "GET") {
      return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /search/sessions`);
    }

    if (text.trim() === "") {
      return fail(400, "INVALID_SCHEMA", "a search must carry a non-empty query");
    }

    const outcome = await searchSessions(search, {
      text: text.slice(0, 500),
      ...(limit === undefined ? {} : { limit: Math.max(1, Math.min(limit, 50)) }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(source === undefined ? {} : { source }),
    });
    return json(200, outcome);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * The memory family. `undefined` means the request is not one of these routes.
 *
 * Reading answers with the records and a count per kind, because a screen that shows a list also wants to say how
 * much there is. Deleting removes the row for real, and a delete that matched nothing is a 404 rather than a quiet
 * success: the caller asked to remove something and it is still there, so "it worked" would be a lie the person
 * cannot see through.
 */
export function handleMemoryRoutes(deps: SearchMemoryRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  if (segments[0] !== "memory" || segments.length > 2) return undefined;
  const { runtime } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;
  const memoryDeps: MemoryDeps = {
    db: runtime.db,
    now: () => new Date().toISOString(),
    newId: deps.services.conductor.newId,
  };

  if (segments.length === 1) {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "memory is read here, not written");
    return {
      status: 200,
      body: { items: listMemories(memoryDeps, principalId), counts: memoryCounts(memoryDeps, principalId) },
    };
  }

  if (request.method !== "DELETE") return fail(405, "METHOD_NOT_ALLOWED", "a remembered thing is deleted here");
  const memoryId = segments[1] ?? "";
  if (!deleteMemory(memoryDeps, principalId, memoryId)) {
    return fail(404, "NOT_FOUND", "this node has no such remembered thing for this principal");
  }
  return { status: 200, body: { removed: true } };
}

/**
 * Calling the node from the main process, with the node's own token.
 *
 * The host holds the credential so the detached renderer never does: the window asks for an action, and the host
 * performs it. A refusal keeps the node's own structure — its `code` and whatever else the body carried — because the
 * window answers its widget from that structure, the way the conversation does: a stale state write, for one, carries
 * the state and revision the node holds, and a refusal reduced to a sentence would lose both.
 *
 * Plain JavaScript beside `main.mjs`, which Electron loads without a TypeScript step, and kept free of Electron so a
 * unit test drives it with a stand-in `fetch`.
 */

/**
 * The refusal for a node answer that was not ok.
 *
 * The node answers a refusal as a flat `{ code, message, ...details }` (`fail` in the runtime's `routes/http.ts`), so
 * the details are the body without its code and message.
 *
 * @param {number} status
 * @param {unknown} body
 * @returns {{ ok: false, refused: string, status: number, code: string, details: Record<string, unknown> }}
 */
export function nodeRefusal(status, body) {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
  const { code, message, ...details } = record;
  const reason = typeof message === "string" && message !== "" ? message : `status ${String(status)}`;
  return {
    ok: false,
    refused: `the node refused: ${reason}`,
    status,
    code: typeof code === "string" && code !== "" ? code : "UNKNOWN",
    details,
  };
}

/** The headers the host sets on every call, by their lowercase names. */
const HOST_HEADERS = Object.freeze(["content-type", "authorization"]);

/**
 * The extra headers a caller adds, as the host sends them.
 *
 * HTTP header names ignore case, so a name is compared in lowercase: `Authorization` is the host's header as much as
 * `authorization` is, and kept beside it, the two would be joined into one value carrying both credentials. A caller's
 * header the host sets itself is dropped; the rest are sent under their lowercase names, so two spellings of one
 * header cannot both reach the node either.
 *
 * @param {Record<string, string> | undefined} headers
 * @returns {Record<string, string>}
 */
export function callerHeaders(headers) {
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (HOST_HEADERS.includes(lower)) continue;
    kept[lower] = value;
  }
  return kept;
}

/** The answer for a call the node accepted and did not finish answering in time. */
function nodeTimeout() {
  return { ok: false, refused: "the node did not answer in time", code: "NODE_TIMEOUT", details: {} };
}

/**
 * A `callNode(path, init)` bound to a way of reading the node session.
 *
 * `readSession` answers `{ ok: true, baseUrl, token } | { ok: false, refused }`; it is read on every call, so a token
 * rotated on disk is the token the next call carries.
 *
 * @param {{ readSession: () => ({ ok: true, baseUrl: string, token: string } | { ok: false, refused: string }), fetch?: typeof fetch }} deps
 */
export function createNodeCaller(deps) {
  const send = deps.fetch ?? fetch;
  /**
   * `headers` adds to the two this always sends and cannot replace them, in any spelling: a caller may say which
   * surface a press came from, never whose credential it carries. `timeoutMs` bounds a call the node accepts and never
   * finishes answering, the body included. `binary` answers an ok response as its bytes (`bytes`, `contentType`,
   * `contentDisposition`) rather than as JSON; a refusal is read as JSON either way.
   *
   * @param {string} path
   * @param {{ method?: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number, binary?: boolean }} [init]
   */
  return async function callNode(path, init) {
    const session = deps.readSession();
    if (!session.ok) return { ok: false, refused: session.refused, code: "NO_NODE_SESSION", details: {} };
    // A timer of the global clock rather than `AbortSignal.timeout`, so it is cleared once the call settles.
    const controller = init?.timeoutMs === undefined ? undefined : new globalThis.AbortController();
    const timer = controller === undefined ? undefined : globalThis.setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      let response;
      try {
        response = await send(`${session.baseUrl}${path}`, {
          method: init?.method ?? "POST",
          headers: {
            ...callerHeaders(init?.headers),
            "content-type": "application/json",
            authorization: `Bearer ${session.token}`,
          },
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        });
      } catch (error) {
        if (controller?.signal.aborted === true) return nodeTimeout();
        // Named rather than swallowed: "the node is not answering" and "the node said no" are different, and only
        // one of them is worth retrying.
        return {
          ok: false,
          refused: `the node could not be reached (${error?.cause?.code ?? error?.code ?? "unreachable"})`,
          code: "NODE_UNREACHABLE",
          details: {},
        };
      }
      if (init?.binary === true && response.ok) {
        // Bytes for the host to write, never parsed: an export. The node's own name and type for them come along.
        try {
          return {
            ok: true,
            bytes: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") ?? "",
            contentDisposition: response.headers.get("content-disposition") ?? "",
          };
        } catch (error) {
          if (controller?.signal.aborted === true) return nodeTimeout();
          return { ok: false, refused: `the node's answer could not be read (${error?.code ?? "unreadable"})`, code: "NODE_UNREACHABLE", details: {} };
        }
      }
      let body;
      try {
        body = await response.json();
      } catch {
        // A node that sent its status and never finished the body has not answered either.
        if (controller?.signal.aborted === true) return nodeTimeout();
        body = undefined;
      }
      if (!response.ok) return nodeRefusal(response.status, body);
      return { ok: true, body };
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  };
}

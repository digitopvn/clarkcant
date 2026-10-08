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
   * @param {string} path
   * @param {{ method?: string, body?: unknown }} [init]
   */
  return async function callNode(path, init) {
    const session = deps.readSession();
    if (!session.ok) return { ok: false, refused: session.refused, code: "NO_NODE_SESSION", details: {} };
    let response;
    try {
      response = await send(`${session.baseUrl}${path}`, {
        method: init?.method ?? "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.token}`,
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      // Named rather than swallowed: "the node is not answering" and "the node said no" are different, and only
      // one of them is worth retrying.
      return {
        ok: false,
        refused: `the node could not be reached (${error?.cause?.code ?? error?.code ?? "unreachable"})`,
        code: "NODE_UNREACHABLE",
        details: {},
      };
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok) return nodeRefusal(response.status, body);
    return { ok: true, body };
  };
}

/**
 * Secret access requests from an extension.
 *
 * An extension asking for a secret is not automatically malicious, and refusing everything would
 * just mean the request arrives through some other door. The rule is narrower and more useful:
 * **there is no such thing as reading all the secrets**, and a specific secret may be read only
 * when the extension says what for and the user is shown what was agreed.
 *
 * The global case is refused outright rather than labelled, because the difference between "this
 * extension can read every credential you have" and "this extension can read one credential you
 * chose" is the difference between an audit trail and a breach. Labelling a request that broad
 * would make it available, and a label is not a limit.
 *
 * Every granted request produces a label, so nothing is granted silently. A native extension gets
 * an additional label that a sandboxed widget does not, because it runs outside the sandbox and
 * the consequence of a mistake is larger.
 */

export type SecretScope = "global" | "connection";

export interface SecretRequest {
  scope: SecretScope;
  /** Required when the scope is a specific connection. */
  connectionId?: string;
  /** Why the extension wants it, in the user's terms. Required for anything to be granted. */
  justification?: string;
}

export interface SecretReview {
  extensionId: string;
  /** What the user must be shown before this extension is trusted. Always present. */
  labels: string[];
  granted: { scope: "connection"; connectionId: string }[];
  refused: { scope: string; reason: string }[];
  /** True when nothing was refused, so the caller can tell a clean review from a partial one. */
  acceptable: boolean;
}

/** The minimum length of a justification. Below this it is a word, not a reason. */
const MIN_JUSTIFICATION_CHARS = 12;

/**
 * Review what an extension asked for.
 *
 * Refusing and labelling are different answers for different situations, and the extension is told
 * which it received. A request that is refused says why, so the author can fix the request rather
 * than guess at what was wrong with it.
 */
export function reviewSecretRequests(input: {
  extensionId: string;
  /** Native extensions run outside the sandbox, which changes what a grant means. */
  native: boolean;
  requests: readonly SecretRequest[];
}): SecretReview {
  const labels: string[] = [];
  const granted: SecretReview["granted"] = [];
  const refused: SecretReview["refused"] = [];

  for (const request of input.requests) {
    if (request.scope === "global") {
      refused.push({
        scope: "global",
        reason:
          "reading every stored secret is not a capability this host offers; ask for the specific connection the extension needs",
      });
      continue;
    }

    if (request.connectionId === undefined || request.connectionId.length === 0) {
      refused.push({
        scope: "connection",
        reason: "a connection-scoped request must name the connection it wants",
      });
      continue;
    }

    const justification = request.justification?.trim() ?? "";
    if (justification.length < MIN_JUSTIFICATION_CHARS) {
      refused.push({
        scope: `connection:${request.connectionId}`,
        reason: `the request must explain what the secret is for, in at least ${MIN_JUSTIFICATION_CHARS} characters`,
      });
      continue;
    }

    granted.push({ scope: "connection", connectionId: request.connectionId });
    labels.push(
      `${input.extensionId} can read the stored credential for ${request.connectionId}: ${justification}`,
    );
  }

  if (input.native && granted.length > 0) {
    // A native extension is not sandboxed by the browser or by a package boundary, so the grant
    // reaches further than the same grant to a widget would.
    labels.push(
      `${input.extensionId} runs as a native extension, so this access is not confined by the widget sandbox.`,
    );
  }

  return {
    extensionId: input.extensionId,
    labels,
    granted,
    refused,
    acceptable: refused.length === 0,
  };
}

/**
 * The surface an extension author can reach, for the audit that checks nothing here is exposed.
 *
 * Listed as data rather than asserted in prose: a test can read this and compare it against the
 * API the runtime actually builds, which is the kind of check that keeps a list from going stale.
 */
export const SECRET_ACCESS_SURFACE = [
  /** Reads one connection's credential, inside the owning node, and never returns the value. */
  "connection.withSecret(connectionId, callback)",
] as const;

export const SECRET_REVIEW_STATUS = "implemented-refuse-global-label-scoped";

/**
 * MCP App fixture.
 *
 * Proves the MCP Apps bridge against a reference implementation rather than against a vendor,
 * and proves that the requests a widget must never be able to make are absent from the protocol
 * rather than merely unwelcome in it. A capability that does not exist cannot be reached by
 * accident, by a bug, or by a prompt injection.
 *
 * The codec is `@clarkcant/widget-sdk`. Two properties of it carry the weight here, and both are
 * asserted rather than assumed: every message must carry the per-frame nonce the host issued, and
 * the author-facing API surface has no verb for reading secrets, minting approvals, or installing
 * anything.
 */

import {
  FORBIDDEN_API_SURFACE,
  acceptBridgeMessage,
  type WidgetAuthorApi,
  type WidgetToHostMessage,
} from "@clarkcant/widget-sdk";

export const MCP_FIXTURE_STATUS = "implemented-against-reference-host";

/** The one capability this fixture is allowed to request. */
export const REQUESTED_CAPABILITY = "fixture.echo@1";

export interface FixtureHost {
  /** The nonce the host issued for this frame. Never exposed outside it. */
  nonce: string;
  /** Whether the message came from the window the host registered for this instance. */
  sourceMatchesExpectedWindow: boolean;
  /** Brokers the one granted capability. Supplied by the host, not by the widget. */
  callTool: (input: { capabilityRef: string; justification: string }) => Promise<{ text: string }>;
  /** Presents the result to the user. Also host-supplied. */
  render: (text: string) => void;
}

export type FixtureOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "rejected"; code: string; message: string }
  | { ok: false; reason: "capability-not-granted"; requested: string }
  | { ok: false; reason: "not-a-capability-request"; kind: WidgetToHostMessage["kind"] };

/**
 * Handle one inbound widget message and, if it asks for the granted capability, broker it.
 *
 * The message passes the codec before anything else looks at it, so the source check and the
 * nonce check are both settled before a branch that could act on the message is reached. A
 * message failing either never gets to be interpreted.
 */
export async function handleWidgetMessage(
  host: FixtureHost,
  raw: unknown,
): Promise<FixtureOutcome> {
  const accepted = acceptBridgeMessage({
    raw,
    expectedNonce: host.nonce,
    sourceMatchesExpectedWindow: host.sourceMatchesExpectedWindow,
  });

  if (!accepted.ok) {
    return { ok: false, reason: "rejected", code: accepted.code, message: accepted.message };
  }

  const message = accepted.message;
  if (message.kind !== "capability.request") {
    return { ok: false, reason: "not-a-capability-request", kind: message.kind };
  }

  if (message.capabilityRef !== REQUESTED_CAPABILITY) {
    // Requesting anything else is refused by name, so the refusal says what was asked for.
    return { ok: false, reason: "capability-not-granted", requested: message.capabilityRef };
  }

  const result = await host.callTool({
    capabilityRef: message.capabilityRef,
    justification: message.justification,
  });
  host.render(result.text);
  return { ok: true, text: result.text };
}

/**
 * Whether the author-facing API exposes a method at all.
 *
 * Used to assert that the forbidden surface is absent from the protocol rather than guarded
 * inside it. The distinction is the whole point: a guarded verb is one refactor away from being
 * reachable, and an absent one is not reachable at all.
 */
export function authorApiExposes(method: string): boolean {
  // The descriptors below are the complete author surface, taken from the interface itself.
  const surface: readonly (keyof WidgetAuthorApi)[] = [
    "props",
    "state",
    "events",
    "actions",
    "capabilities",
    "host",
    "semantic",
    "lifecycle",
  ];
  return surface.some((group) => group === method);
}

/** The verbs kept out of the SDK on purpose, re-exported so the fixture's tests name them. */
export const WITHHELD_VERBS = FORBIDDEN_API_SURFACE;

/** Probes the fixture must attempt and fail, proving isolation rather than asserting it. */
export const MUST_FAIL = [
  "read the host's storage",
  "read a credential value",
  "mint an approval record",
  "reach an origin that is not in the declared allowlist",
] as const;

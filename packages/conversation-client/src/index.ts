/**
 * @clarkcant/conversation-client
 *
 * Shared React conversation surface: one timeline, one composer, pins, widget mount
 * points and the host-owned trust cards. The same components serve web and desktop, and
 * nothing here may depend on Node, so the renderer stays portable.
 *
 * @implementation-status stub
 * TODO(P1): the React components themselves. The contracts this package renders are
 * implemented and tested (`@clarkcant/contracts` surfaces, `@clarkcant/widget-host`
 * block preparation and `@clarkcant/design-tokens` contrast), and the mount contract
 * below is fixed; the component tree is not written.
 *
 * What a component in this package is allowed to assume:
 *   - every block it renders has already passed `prepareBlocksForRender`, so a
 *     host-owned trust card in the tree was built by the host and not by a pack;
 *   - widget props have already been validated, and an invalid or unknown definition
 *     arrives as a text block rather than as a broken mount;
 *   - colours come from `@clarkcant/design-tokens`, which the test suite audits for
 *     WCAG AA in both themes, so no component chooses its own colour.
 */

import type { ConversationSnapshot, MessageBlock, MessageRecord, Pin } from "@clarkcant/contracts";

/** Props every conversation surface accepts, regardless of which client hosts it. */
export interface ConversationSurfaceProps {
  snapshot: ConversationSnapshot;
  messages: MessageRecord[];
  pins: Pin[];
  /** Called with the revision the user saw, so a stale action is refused server-side. */
  onAction: (input: { instanceId: string; actionBindingId: string; expectedRevision: number; input: Record<string, unknown>; invocationId: string }) => void;
  onSend: (text: string) => void;
  onPinChange: (pinId: string, displayMode: Pin["displayMode"]) => void;
  /** Rendered instead of a widget when its definition is unavailable. */
  renderBlock: (block: MessageBlock) => unknown;
}

/** The block types a client must be able to render, and no others. */
export const REQUIRED_BLOCK_RENDERERS: readonly MessageBlock["type"][] = [
  "text",
  "surface",
  "widget-ref",
  "artifact",
  "evidence",
  "system-card",
  "approval-card",
  "credential-card",
  "connection-card",
];

/**
 * @implementation-status stub
 * TODO(P1): component implementations. This constant exists so the renderer checklist
 * is a single list rather than spread across the codebase.
 */
export const CONVERSATION_CLIENT_STATUS = "contract-declared-components-not-implemented";

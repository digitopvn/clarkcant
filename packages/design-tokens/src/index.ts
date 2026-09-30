/**
 * @clarkcant/design-tokens
 *
 * Versioned design tokens, the appearance compiler that turns a theme document into a
 * bounded snapshot, and computed WCAG contrast checks. The contrast utilities exist so the
 * accessibility guarantee is measured rather than asserted: the palette is only "AA
 * compliant" if `auditClarkSchemes()` says so, and the test suite fails otherwise.
 */

export * from "./tokens.ts";
export * from "./motion.ts";
export * from "./contrast.ts";
export * from "./appearance.ts";
export * from "./identity.ts";
export * from "./orb.ts";
export * from "./protected.ts";
export * from "./css.ts";

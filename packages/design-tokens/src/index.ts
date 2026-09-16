/**
 * @clarkcant/design-tokens
 *
 * Versioned design tokens plus computed WCAG contrast checks. The contrast utilities
 * exist so the accessibility guarantee is measured rather than asserted: the palette is
 * only "AA compliant" if `auditAllThemes()` says so, and the test suite fails otherwise.
 */

export * from "./tokens.ts";
export * from "./contrast.ts";

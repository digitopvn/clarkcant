/**
 * The canonical widget catalog.
 *
 * One import for anything that needs to describe, list, search, test or preview a built-in widget:
 * the conversation client's library surface, the CLI dev host, the runtime's app-intent target table
 * and the catalog conformance tests all read this layer, so metadata cannot drift between them.
 *
 * Nothing here imports React or a Node builtin. That is a hard constraint rather than a preference:
 * the same module is loaded by the browser client and by Node tooling, and the validator in
 * particular used to live behind a package root that reads `node:crypto`.
 */

export * from "./registry.ts";
export * from "./fixtures.ts";
export * from "./search.ts";
export * from "./preview.ts";
export * from "./validate-props.ts";

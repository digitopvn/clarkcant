/**
 * The canonical repository: where releases are published and where the change history can be read. The release tooling
 * links notes to it, and the runtime points to it when this build's notes cannot be read.
 *
 * A module of its own, with no imports, so the dependency-free release tooling (`tools/release/notes-data.mjs`) reads
 * the same value without loading the schemas.
 */
export const CLARK_REPOSITORY_URL = "https://github.com/digitopvn/clarkcant";

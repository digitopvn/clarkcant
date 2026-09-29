/**
 * The desktop's file picker and Save As, as policy with no Electron in it.
 *
 * Kept apart from `main.mjs` for the same reason `security.mjs` is: what crosses the bridge is the security property,
 * and it has to be checked by a test rather than by opening a window. The property is that **no path reaches the
 * renderer**. A chosen file comes back as its bare name, its type and its bytes; the renderer may later ask to write
 * back to "the file it picked", and it names that file by an opaque handle this process minted — the path behind the
 * handle never leaves the main process.
 */

import { randomBytes } from "node:crypto";
import { basename } from "node:path";

/**
 * The content types a node accepts for a file, and the extensions each is saved and filtered by.
 *
 * The same list as the node's attachment allowlist. A copy, because the main process cannot load the TypeScript
 * contracts package; the node sniffs and checks every byte it is given, so a disagreement here is a picker that
 * offers a file the node then refuses with its reason — never a file the node takes that it should not.
 */
export const PICKABLE_TYPES = Object.freeze([
  { mime: "image/png", extensions: ["png"] },
  { mime: "image/jpeg", extensions: ["jpg", "jpeg"] },
  { mime: "image/webp", extensions: ["webp"] },
  { mime: "image/gif", extensions: ["gif"] },
  { mime: "application/pdf", extensions: ["pdf"] },
  { mime: "text/plain", extensions: ["txt", "text", "log"] },
  { mime: "text/markdown", extensions: ["md", "markdown"] },
  { mime: "text/csv", extensions: ["csv"] },
  { mime: "application/json", extensions: ["json"] },
]);

/** The largest file the picker reads: the node's own ceiling for one file. */
export const MAX_PICK_BYTES = 26_214_400;

/** How many picked files may be written back to at once. The oldest handle is forgotten first. */
export const MAX_FILE_HANDLES = 64;

const MIME_PATTERN = /^[a-z][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/;

/** The type a file name says it is, or `application/octet-stream`, which the node will refuse with its reason. */
export function mimeForFileName(name) {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return PICKABLE_TYPES.find((entry) => entry.extensions.includes(extension))?.mime ?? "application/octet-stream";
}

/**
 * The OS dialog's filters for what the widget said it accepts.
 *
 * Only types the node would take are offered. An empty accept list is every type the node takes, not every file.
 */
export function dialogFiltersForAccept(accept) {
  const wanted = Array.isArray(accept) ? accept.filter((entry) => typeof entry === "string" && MIME_PATTERN.test(entry)) : [];
  const matches = (mime) =>
    wanted.length === 0 ||
    wanted.some((entry) => entry === mime || (entry.endsWith("/*") && mime.startsWith(entry.slice(0, -1))));
  const extensions = PICKABLE_TYPES.filter((entry) => matches(entry.mime)).flatMap((entry) => entry.extensions);
  return extensions.length === 0 ? [] : [{ name: "Files", extensions }];
}

/** A picker request as the host will act on it. */
export function reviewPickFileRequest(input) {
  if (typeof input !== "object" || input === null) return { allowed: false, reason: "a pick request is an object" };
  const accept = input.accept ?? [];
  if (!Array.isArray(accept) || accept.length > 16 || !accept.every((entry) => typeof entry === "string" && MIME_PATTERN.test(entry))) {
    return { allowed: false, reason: "accept is a list of at most 16 MIME types such as text/plain or image/*" };
  }
  const filters = dialogFiltersForAccept(accept);
  if (accept.length > 0 && filters.length === 0) {
    return { allowed: false, reason: "none of the accepted types is a file this node can hold" };
  }
  const title = typeof input.title === "string" && input.title.trim() !== "" ? input.title.slice(0, 120) : "Choose a file";
  return { allowed: true, title, filters };
}

/**
 * A file name to suggest in the save dialog: the last segment of whatever was given, without control characters.
 *
 * A suggestion only — the person chooses where the file goes — but a name carrying `../` or a drive would pre-fill the
 * dialog somewhere the person did not choose, so it is cut to a bare name first.
 */
export function suggestedSaveName(name) {
  const text = typeof name === "string" ? name : "";
  // Control characters and the characters a Windows file name cannot hold are dropped, one code point at a time.
  const bare = [...basename(text.replaceAll("\\", "/"))]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f && !'<>:"|?*'.includes(character);
    })
    .join("")
    .trim()
    .slice(0, 200);
  return bare === "" || bare === "." || bare === ".." ? "file" : bare;
}

/** A save request as the host will act on it. The bytes are bounded like a pick. */
export function reviewSaveFileRequest(input) {
  if (typeof input !== "object" || input === null) return { allowed: false, reason: "a save request is an object" };
  if (typeof input.contentBase64 !== "string" || input.contentBase64.length > Math.ceil((MAX_PICK_BYTES * 4) / 3) + 4) {
    return { allowed: false, reason: `the bytes travel as base64 of at most ${MAX_PICK_BYTES} bytes` };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) {
    return { allowed: false, reason: "the bytes are not valid base64" };
  }
  if (input.replaceHandle !== undefined && (typeof input.replaceHandle !== "string" || !/^fh_[a-f0-9]{32}$/.test(input.replaceHandle))) {
    return { allowed: false, reason: "a file handle is one this window was given by the picker" };
  }
  return {
    allowed: true,
    suggestedName: suggestedSaveName(input.suggestedName),
    replaceHandle: input.replaceHandle,
  };
}

/**
 * Handles for files the person picked, held in the main process.
 *
 * The renderer holds the handle; this holds the path. Bounded, so a renderer that picks without end cannot grow it.
 */
export function createFileHandles(limit = MAX_FILE_HANDLES) {
  const paths = new Map();
  return {
    remember(path) {
      const handle = `fh_${randomBytes(16).toString("hex")}`;
      paths.set(handle, path);
      while (paths.size > limit) paths.delete(paths.keys().next().value);
      return handle;
    },
    pathFor(handle) {
      return typeof handle === "string" ? paths.get(handle) : undefined;
    },
    size() {
      return paths.size;
    },
  };
}

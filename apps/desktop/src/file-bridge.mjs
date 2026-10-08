/**
 * The desktop's file picker and Save As, as policy with no Electron in it.
 *
 * Kept apart from `main.mjs` for the same reason `security.mjs` is: what crosses the bridge is the security property,
 * and it has to be checked by a test rather than by opening a window. The property is that **no path reaches the
 * renderer**. A chosen file comes back as its bare name, its type and its bytes; the renderer may later ask to write
 * back to "the file it picked", and it names that file by an opaque handle this process minted — the path behind the
 * handle never leaves the main process.
 *
 * Nor does anything else the file system says. An error from opening or writing a file carries its path in its message
 * (`EBUSY: resource busy or locked, open 'C:\\Users\\…'`), so what goes back is a fixed code the renderer turns into a
 * sentence in the person's language, and at most the error's own code (`EBUSY`, `EPERM`) — never its message.
 */

import { randomBytes } from "node:crypto";
import { chmod, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  { mime: "text/tab-separated-values", extensions: ["tsv", "tab"] },
  { mime: "application/json", extensions: ["json"] },
  { mime: "audio/wav", extensions: ["wav"] },
]);

/**
 * Why a pick or a save did not happen, as a code the renderer words. Fixed, so no text a file system or a dialog chose
 * reaches the page.
 */
export const FILE_REFUSALS = Object.freeze([
  "INVALID_REQUEST",
  "NO_WINDOW",
  "NOT_A_FILE",
  "FILE_TOO_LARGE",
  "READ_FAILED",
  "WRITE_FAILED",
  "HANDLE_UNKNOWN",
  "REPLACE_TYPE_MISMATCH",
]);

/**
 * A refusal the bridge may answer with: the code, and — when the cause is a file-system error — only that error's code.
 * The cause's message is never read, because that is where the path is.
 */
export function fileRefusal(code, cause) {
  const refused = FILE_REFUSALS.includes(code) ? code : "INVALID_REQUEST";
  const errno = typeof cause === "object" && cause !== null && typeof cause.code === "string" && /^E[A-Z]{2,15}$/.test(cause.code)
    ? cause.code
    : undefined;
  return { ok: false, refused, ...(errno === undefined ? {} : { errorCode: errno }) };
}

/** The largest file the picker reads: the node's own ceiling for one file. */
export const MAX_PICK_BYTES = 26_214_400;

/** How many picked files may be written back to at once. The oldest handle is forgotten first. */
export const MAX_FILE_HANDLES = 64;

const MIME_PATTERN = /^[a-z][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/;

/**
 * The type a file name says it is, or nothing: the node then reads what the file is from its bytes, and refuses one it
 * cannot hold with its reason. Never a generic binary type, which the node would take as a claim the bytes contradict.
 */
export function mimeForFileName(name) {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return PICKABLE_TYPES.find((entry) => entry.extensions.includes(extension))?.mime ?? "";
}

/**
 * The OS dialog's filters for what the widget said it accepts.
 *
 * Only types the node would take are offered. An empty accept list is every type the node takes, not every file.
 */
export function dialogFiltersForAccept(accept, filterName = "Files") {
  const wanted = Array.isArray(accept) ? accept.filter((entry) => typeof entry === "string" && MIME_PATTERN.test(entry)) : [];
  const matches = (mime) =>
    wanted.length === 0 ||
    wanted.some((entry) => entry === mime || (entry.endsWith("/*") && mime.startsWith(entry.slice(0, -1))));
  const extensions = PICKABLE_TYPES.filter((entry) => matches(entry.mime)).flatMap((entry) => entry.extensions);
  return extensions.length === 0 ? [] : [{ name: filterName, extensions }];
}

/** The extensions a type is saved under, or `undefined` for a type the node does not hold. */
export function extensionsForType(mimeType) {
  return PICKABLE_TYPES.find((entry) => entry.mime === mimeType)?.extensions;
}

/**
 * The name to pre-fill in Save As: a bare name (`suggestedSaveName`) ending in the type's extension.
 *
 * The same rule the node applies to an export's name, applied again here because this is the process that writes the
 * file: a `text/plain` file suggested as `invoice.bat` is offered as `invoice.txt`, never as something the OS would run.
 */
export function saveNameForType(name, mimeType) {
  const bare = suggestedSaveName(name).replace(/[. ]+$/u, "");
  const extensions = extensionsForType(mimeType);
  if (extensions === undefined) return bare === "" ? "file" : bare;
  const dot = bare.lastIndexOf(".");
  const hasExtension = dot > 0 && /^[\p{L}\p{N}_-]{1,16}$/u.test(bare.slice(dot + 1));
  const current = hasExtension ? bare.slice(dot + 1).toLowerCase() : "";
  if (extensions.includes(current)) return bare;
  const stem = hasExtension ? bare.slice(0, dot) : bare;
  return `${stem === "" ? "file" : stem}.${extensions[0]}`;
}

/** A dialog string the renderer passed in the person's language, or the English one when it passed none. */
function label(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : fallback;
}

/** A picker request as the host will act on it. */
export function reviewPickFileRequest(input) {
  if (typeof input !== "object" || input === null) return { allowed: false, reason: "a pick request is an object" };
  const accept = input.accept ?? [];
  if (!Array.isArray(accept) || accept.length > 16 || !accept.every((entry) => typeof entry === "string" && MIME_PATTERN.test(entry))) {
    return { allowed: false, reason: "accept is a list of at most 16 MIME types such as text/plain or image/*" };
  }
  const filters = dialogFiltersForAccept(accept, label(input.filterName, "Files"));
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
    return { allowed: false, reason: "a file handle is one the picker minted in this app" };
  }
  const dialog = reviewSaveDialog(input);
  return dialog.allowed ? { ...dialog, replaceHandle: input.replaceHandle } : dialog;
}

/**
 * The dialogs a save opens, as the host will draw them: the type the file is saved as, the name Save As offers, and the
 * words of the replace question. Shared by a save whose bytes the renderer sent and an export whose bytes the host read
 * from the node itself, so both ask the same question in the same words.
 */
export function reviewSaveDialog(input) {
  // The type decides the extension and what may be replaced, so a save names one the node holds.
  if (typeof input.mimeType !== "string" || extensionsForType(input.mimeType) === undefined) {
    return { allowed: false, reason: "a save names the file's type, one the node holds" };
  }
  const labels = typeof input.labels === "object" && input.labels !== null ? input.labels : {};
  const extensions = extensionsForType(input.mimeType);
  return {
    allowed: true,
    mimeType: input.mimeType,
    suggestedName: saveNameForType(input.suggestedName, input.mimeType),
    filters: [{ name: label(labels.filterName, "Files"), extensions }],
    dialog: {
      replaceTitle: label(labels.replaceTitle, "Replace file"),
      replaceMessage: label(labels.replaceMessage, "Replace {name} with this version?"),
      replace: label(labels.replace, "Replace"),
      cancel: label(labels.cancel, "Cancel"),
    },
  };
}

/**
 * The file name a node's `Content-Disposition` gives an export, as a bare name, or `undefined` when it gives none. The
 * same reading as the conversation's (`attachmentFilename` in `@clarkcant/conversation-client`), so an export saved from
 * a detached window is offered under the name the same export gets in the conversation.
 */
export function dispositionFilename(header) {
  if (typeof header !== "string" || header === "") return undefined;
  let name;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (extended !== undefined) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;\s]+)/i.exec(header)?.[1];
  const cleaned = name === undefined
    ? undefined
    : [...name].filter((char) => char !== "/" && char !== "\\" && char.charCodeAt(0) >= 0x20).join("").trim();
  return cleaned === undefined || cleaned === "" || /^\.+$/.test(cleaned) ? undefined : cleaned;
}

/**
 * Whether a file on disk may be replaced by bytes of this type: its extension must name the same type.
 *
 * Writing a PDF over `notes.md` would leave a file that no longer opens as what its name says; the person is asked to
 * use Save As instead.
 */
export function replaceKeepsType(targetName, mimeType) {
  return extensionsForType(mimeType) !== undefined && mimeForFileName(targetName) === mimeType;
}

/** Errors Windows gives a rename while another program — an indexer, an antivirus, a sync client — briefly holds the file. */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** How many times a rename is tried on Windows before the write is given up, and the pause before the first retry. */
const RENAME_ATTEMPTS = 6;
const RENAME_RETRY_DELAY_MS = 40;

/**
 * Write a file whole or not at all.
 *
 * The bytes go to a temporary file beside the target, and that file is renamed over it: a rename within one folder
 * replaces the old file in one step, so a failure part-way — a full disk, a locked file, a crash — leaves the original
 * as it was instead of truncated. The temporary file is removed when the write does not finish.
 *
 * What the person had is kept as well as the bytes allow:
 *
 * - a **link** is followed, and the file it points at is written, so the link stays a link instead of being replaced by
 *   a copy that no longer follows the file it named;
 * - the original's **permissions** are given to the new file on macOS and Linux, so a file only its owner could read
 *   does not become readable by everyone because it was saved again;
 * - on **Windows**, a rename refused because another program holds the file for a moment is tried again a few times
 *   before the write is given up.
 *
 * The temporary name is short and does not repeat the target's, so a long file name never makes it too long to create.
 * `options` is for tests: the platform, the rename and the pause between tries.
 */
export async function writeFileWhole(target, bytes, options = {}) {
  const platform = options.platform ?? process.platform;
  const renameFile = options.rename ?? rename;
  const retryDelayMs = options.retryDelayMs ?? RENAME_RETRY_DELAY_MS;
  // A save to a new file has nothing to follow or keep; any other failure here is the write's to report.
  const existing = await realpath(target).catch((cause) => {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  });
  const destination = existing ?? target;
  const mode = existing === undefined || platform === "win32" ? undefined : (await stat(existing)).mode & 0o7777;
  const temporary = join(dirname(destination), `.cc-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    // The mode given to writeFile is narrowed by the process's umask; this sets it exactly.
    if (mode !== undefined) await chmod(temporary, mode);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameFile(temporary, destination);
        break;
      } catch (cause) {
        const transient = platform === "win32" && TRANSIENT_RENAME_CODES.has(cause?.code);
        if (!transient || attempt >= RENAME_ATTEMPTS) throw cause;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
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

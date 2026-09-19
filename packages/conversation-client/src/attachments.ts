import { validateAttachmentCandidate } from "@clarkcant/contracts";

/**
 * The composer's attachment logic, with no DOM in it.
 *
 * Split out for one reason: the rules a person meets when they add a file — the ceiling, the allowlist, the
 * name check — are the same rules the node applies, and a component cannot be tested against them without a
 * browser. Everything here is a pure function over plain values, so the interesting cases are unit tests
 * rather than screenshots.
 *
 * The one thing this file deliberately does **not** decide is the quota. `clientAccepts` reports on the file
 * in front of it, and the quota depends on everything the principal already stores, which only the node
 * knows. A client that guessed would refuse files the node would have taken.
 */

/** What the interface knows about a file that is on its way to the node. */
export interface AttachmentChip {
  /** Stable for the life of the chip, so removing it does not depend on its name or its index. */
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  /**
   * `ready` means the node stored it and its id is usable in a message.
   *
   * A failed chip is kept rather than dropped: a person whose file was refused needs to see why, and
   * silently removing it would look like the click did nothing.
   */
  state: "checking" | "ready" | "failed";
  /** Present once the node has stored the bytes. */
  attachmentId?: string;
  /** Present when the node or the pre-check refused, phrased for the person reading it. */
  reason?: string;
}

export type AttachmentAction =
  | { type: "add"; chips: readonly AttachmentChip[] }
  | { type: "remove"; id: string }
  | { type: "stored"; id: string; attachmentId: string }
  | { type: "failed"; id: string; reason: string }
  | { type: "sent" };

/**
 * The chip list, as a reducer.
 *
 * A reducer rather than state spread across handlers because the transitions have to hold together: an
 * upload that finishes after its chip was removed must not resurrect it, and `sent` must clear only the
 * chips whose bytes are actually stored.
 */
export function attachmentReducer(
  state: readonly AttachmentChip[],
  action: AttachmentAction,
): readonly AttachmentChip[] {
  switch (action.type) {
    case "add":
      return [...state, ...action.chips];
    case "remove":
      return state.filter((chip) => chip.id !== action.id);
    case "stored":
      return state.map((chip) =>
        chip.id === action.id ? { ...chip, state: "ready" as const, attachmentId: action.attachmentId } : chip,
      );
    case "failed":
      return state.map((chip) =>
        chip.id === action.id ? { ...chip, state: "failed" as const, reason: action.reason } : chip,
      );
    case "sent":
      // Ready chips are gone because the message now owns them; a failed one stays, because nothing was
      // sent for it and its explanation is the only place the person can read what went wrong.
      return state.filter((chip) => chip.state === "failed");
    default: {
      // Unreachable while the union is exhaustive. Present because a new action added without a case here
      // must fail loudly rather than leave the chip list in a state nobody decided.
      action satisfies never;
      throw new Error(`unhandled attachment action: ${JSON.stringify(action)}`);
    }
  }
}

/** The ids a message should carry: the stored ones, in the order the person added them. */
export function readyAttachmentIds(chips: readonly AttachmentChip[]): string[] {
  return chips.flatMap((chip) => (chip.state === "ready" && chip.attachmentId !== undefined ? [chip.attachmentId] : []));
}

/**
 * Whether a file is worth uploading at all.
 *
 * Runs the contract's own rules, so the composer refuses in a millisecond what the node would refuse after
 * a 25 MB upload. `usedBytes` is zero because the quota is the node's to decide.
 */
export function clientAccepts(input: {
  filename: string;
  mime: string;
  sizeBytes: number;
}): { ok: true } | { ok: false; code: string; message: string } {
  const outcome = validateAttachmentCandidate({ ...input, usedBytes: 0 });
  return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, message: outcome.message };
}

/**
 * A size a person can read.
 *
 * One decimal below ten, none above it: `1.5 KB` and `12 KB` are both answers somebody can compare at a
 * glance, whereas `1.5000 KB` is a number pretending to be precise about a file size.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

/**
 * The extension a pasted file should carry for a content type.
 *
 * A naming table, not an allowlist: which types a node accepts is decided by the contract, and this only
 * says what to call a nameless file of one of them. The two types whose subtype is not their extension
 * (`image/jpeg`, `text/plain`) are why it is a table rather than a split on the slash.
 */
const PASTED_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

/**
 * A name for a file that arrived without one.
 *
 * A pasted image from a clipboard is a blob with a type and no filename at all. The node refuses an empty
 * name, and it should: a nameless attachment is a row nobody can recognise later. So one is derived from
 * what is known — the moment it was pasted and, more usefully, the type.
 */
export function nameForPastedFile(mime: string, at: Date): string {
  const type = mime.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  // Falling back to the subtype rather than to "bin": a refused type is refused by `clientAccepts` anyway,
  // and a name that says what the file claimed to be is more use in that message than a generic one.
  const extension = PASTED_EXTENSIONS[type] ?? type.split("/").at(1) ?? "bin";
  // Colons are not legal in a Windows filename and the timestamp is ISO and UTC, so they are removed rather
  // than escaped: the name only has to be distinct and readable.
  const stamp = at.toISOString().slice(0, 19).replaceAll(":", "-");
  return `pasted-${stamp}.${extension}`;
}

/**
 * Base64 for an uploaded file.
 *
 * Chunked because a 25 MB file spread through `String.fromCharCode(...bytes)` overflows the argument limit
 * and throws — the failure being a stack error rather than anything to do with the file.
 */
export function toBase64(bytes: Uint8Array, chunkBytes = 32_768): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes));
  }
  return btoa(binary);
}

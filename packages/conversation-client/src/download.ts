/**
 * Saving a file the person asked for, in whichever host the page runs in.
 *
 * A browser has one way to put bytes on disk: its own download flow, where the browser — not the page — decides where
 * the file goes. The desktop shell has an OS Save As, reached through its named bridge methods; the renderer hands it a
 * name and bytes and learns only whether the file was saved. Neither path tells the page where the file went.
 */

import { DesktopFileError } from "./artifact-messages.ts";
import { toBase64 } from "./attachments.ts";

/** Hand a file to the browser's download flow, then release the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadObjectUrl(url, filename);
  // The click starts the download synchronously; the URL is released once the browser has read it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Hand an object URL someone else owns to the browser's download flow, under a name.
 *
 * A download, not a navigation: no window is opened, so a popup blocker has nothing to block when it follows an awaited
 * read, which is how a table export already saves. The desktop shell takes the same path, through Electron's own
 * download handling. The URL is not released here; its owner does that.
 */
export function downloadObjectUrl(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * What the desktop shell answers a pick or a save with. Only names, types, bytes and opaque handles — never a path.
 * A refusal is a fixed code (`refused`) and at most the file system's own code (`errorCode`), never a message.
 */
export interface DesktopFileBridge {
  pickFile(input: { title?: string; accept?: readonly string[]; filterName?: string }): Promise<{
    ok: boolean;
    canceled?: boolean;
    refused?: string;
    errorCode?: string;
    file?: { name: string; mimeType: string; contentBase64: string; handle: string };
  }>;
  saveFile(input: {
    suggestedName: string;
    mimeType: string;
    contentBase64: string;
    replaceHandle?: string;
    labels?: DesktopDialogLabels;
  }): Promise<{
    ok: boolean;
    canceled?: boolean;
    saved?: boolean;
    name?: string;
    refused?: string;
    errorCode?: string;
  }>;
}

/** The desktop dialogs' words in the person's language (`desktopDialogLabels`). */
export interface DesktopDialogLabels {
  filterName: string;
  replaceTitle: string;
  replaceMessage: string;
  replace: string;
  cancel: string;
}

/**
 * What became of a save: written by the OS Save As (`saved`), handed to the browser's download flow (`downloaded`) —
 * which only starts a download, so it is never reported as saved — or declined in the dialog (`cancelled`).
 */
export interface SaveOutcome {
  outcome: "saved" | "downloaded" | "cancelled";
  name: string;
}

/**
 * The desktop's file bridge, or `undefined` in a browser.
 *
 * Read from the bridge rather than assumed, like the detach bridge: a browser has none, and a control that needs it is
 * then drawn as the browser's version of itself rather than as a button that fails.
 */
export function desktopFileBridge(): DesktopFileBridge | undefined {
  if (typeof window === "undefined") return undefined;
  /*
   * SAFETY: `clarkcant` is injected by the desktop preload through `contextBridge`, so it has no declared type. Both
   * methods are checked for being functions before the value is treated as a bridge.
   */
  const candidate = (window as unknown as { clarkcant?: Record<string, unknown> }).clarkcant;
  if (candidate === undefined || typeof candidate["pickFile"] !== "function" || typeof candidate["saveFile"] !== "function") {
    return undefined;
  }
  return candidate as unknown as DesktopFileBridge;
}

/** Base64 of a blob's bytes, for the desktop bridge. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Put exported bytes where the person chooses: the OS Save As on the desktop (or, given a handle, back over the file
 * they picked, after the shell asks), the browser's download otherwise.
 *
 * Answers what became of it and under which bare name — never where. A refusal from the shell throws a
 * `DesktopFileError` carrying its code, so the sentence the person reads is this page's, in their language.
 */
export async function saveForPerson(
  blob: Blob,
  filename: string,
  options: { mimeType: string; replaceHandle?: string | undefined; labels?: DesktopDialogLabels | undefined },
): Promise<SaveOutcome> {
  const bridge = desktopFileBridge();
  if (bridge === undefined) {
    downloadBlob(blob, filename);
    return { outcome: "downloaded", name: filename };
  }
  let answer: Awaited<ReturnType<DesktopFileBridge["saveFile"]>>;
  try {
    answer = await bridge.saveFile({
      suggestedName: filename,
      mimeType: options.mimeType,
      contentBase64: await blobToBase64(blob),
      ...(options.replaceHandle === undefined ? {} : { replaceHandle: options.replaceHandle }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
    });
  } catch {
    // A bridge that threw says nothing this page can safely repeat.
    throw new DesktopFileError("DESKTOP_FAILED");
  }
  if (answer.ok && answer.canceled === true) return { outcome: "cancelled", name: filename };
  if (!answer.ok || answer.saved !== true) throw new DesktopFileError(answer.refused ?? "WRITE_FAILED", answer.errorCode);
  return { outcome: "saved", name: answer.name ?? filename };
}
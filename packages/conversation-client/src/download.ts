/**
 * Saving a file the person asked for, in whichever host the page runs in.
 *
 * A browser has one way to put bytes on disk: its own download flow, where the browser — not the page — decides where
 * the file goes. The desktop shell has an OS Save As, reached through its named bridge methods; the renderer hands it a
 * name and bytes and learns only whether the file was saved. Neither path tells the page where the file went.
 */

import { toBase64 } from "./attachments.ts";

/** Hand a file to the browser's download flow, then release the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // The click starts the download synchronously; the URL is released once the browser has read it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** What the desktop shell answers a pick or a save with. Only names, types, bytes and opaque handles — never a path. */
export interface DesktopFileBridge {
  pickFile(input: { title?: string; accept?: readonly string[] }): Promise<{
    ok: boolean;
    canceled?: boolean;
    refused?: string;
    file?: { name: string; mimeType: string; contentBase64: string; handle: string };
  }>;
  saveFile(input: { suggestedName: string; contentBase64: string; replaceHandle?: string }): Promise<{
    ok: boolean;
    canceled?: boolean;
    saved?: boolean;
    name?: string;
    refused?: string;
  }>;
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
 * Answers whether it was saved and under which bare name — never where. A refusal from the shell throws with its reason.
 */
export async function saveForPerson(
  blob: Blob,
  filename: string,
  options: { replaceHandle?: string | undefined } = {},
): Promise<{ saved: boolean; name: string }> {
  const bridge = desktopFileBridge();
  if (bridge === undefined) {
    downloadBlob(blob, filename);
    return { saved: true, name: filename };
  }
  const answer = await bridge.saveFile({
    suggestedName: filename,
    contentBase64: await blobToBase64(blob),
    ...(options.replaceHandle === undefined ? {} : { replaceHandle: options.replaceHandle }),
  });
  if (answer.ok && answer.canceled === true) return { saved: false, name: filename };
  if (!answer.ok || answer.saved !== true) throw new Error(answer.refused ?? "the file could not be written");
  return { saved: true, name: answer.name ?? filename };
}
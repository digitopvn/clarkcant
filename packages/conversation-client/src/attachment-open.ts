import type { ObjectUrlStatus, ObjectUrls } from "./use-object-urls.ts";

/**
 * Downloading an attached file from its card, reading its bytes only then.
 *
 * A file card lists its attachment *on request* (see `use-object-urls.ts`), so drawing a conversation reads none of its
 * files. Pressing Download asks for that one file through the authenticated client; once its object URL lands, the card
 * hands it to the browser's download flow. A download rather than a new tab: it is what the card always did, and it opens
 * no window, so nothing a popup blocker or the desktop shell refuses stands between the read and the file.
 */

/**
 * What a file card's Download control says.
 *
 * - `idle`: nothing asked for, or the last download already handed over; pressing reads the file (or reuses what was read).
 * - `opening`: asked for and still being read. No progress is claimed, because the read reports none.
 * - `failed`: the node did not give the bytes; pressing tries again.
 */
export type AttachmentDownloadState = "idle" | "opening" | "failed";

export function attachmentDownloadState(status: ObjectUrlStatus, waiting: boolean): AttachmentDownloadState {
  if (status === "failed") return "failed";
  // `idle` while waiting is the render between the request and the set saying it is in flight: the read has been asked for.
  if (waiting && (status === "loading" || status === "idle")) return "opening";
  return "idle";
}

/**
 * A press on the Download control.
 *
 * Bytes already read are downloaded at once, with no second read. Otherwise the file is asked for (or asked for again
 * after a failure) and the answer is `true`: the download waits for the read, and `settleAttachmentDownload` finishes it.
 * A press while the read is in flight changes nothing.
 */
export function pressAttachmentDownload(
  urls: Pick<ObjectUrls, "get" | "status" | "request" | "retry">,
  attachmentId: string,
  save: (url: string) => void,
): boolean {
  const status = urls.status(attachmentId);
  if (status === "ready") {
    const url = urls.get(attachmentId);
    if (url !== undefined) save(url);
    return false;
  }
  if (status === "loading") return true;
  if (status === "failed") {
    urls.retry(attachmentId);
    return true;
  }
  if (status === "idle") {
    urls.request(attachmentId);
    return true;
  }
  return false;
}

/**
 * Finishes a download that was waiting for its read, once the read settled. Answers whether it is still waiting.
 *
 * Ready: the URL goes to the download flow, once. Failed, or no longer listed: nothing is downloaded, and the card says
 * why from the status.
 */
export function settleAttachmentDownload(
  urls: Pick<ObjectUrls, "get" | "status">,
  attachmentId: string,
  save: (url: string) => void,
): boolean {
  const status = urls.status(attachmentId);
  if (status === "loading" || status === "idle") return true;
  if (status === "ready") {
    const url = urls.get(attachmentId);
    if (url !== undefined) save(url);
  }
  return false;
}

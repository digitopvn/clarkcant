import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GatewayClient } from "../src/api.ts";
import { attachmentDownloadState, pressAttachmentDownload, settleAttachmentDownload } from "../src/attachment-open.ts";
import { renderBlock } from "../src/blocks.tsx";
import { createObjectUrlSet, type ObjectUrlSet } from "../src/use-object-urls.ts";

/**
 * Downloading an attached file from its card: nothing is read when the card is drawn, one read when Download is pressed,
 * and the download handed over once that read lands.
 */

function urlSet() {
  const fetched: string[] = [];
  const revoked: string[] = [];
  const settle = new Map<string, { resolve: (url: string) => void; reject: (cause: Error) => void }>();
  const set: ObjectUrlSet = createObjectUrlSet({
    fetchUrl: (reference) => {
      fetched.push(reference);
      return new Promise<string>((resolve, reject) => settle.set(reference, { resolve, reject }));
    },
    revoke: (url) => revoked.push(url),
    onChange: () => undefined,
  });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    set,
    fetched,
    revoked,
    answer: async (reference: string) => {
      settle.get(reference)?.resolve(`blob:${reference}`);
      await flush();
    },
    fail: async (reference: string) => {
      settle.get(reference)?.reject(new Error("refused"));
      await flush();
    },
  };
}

describe("a file card's download", () => {
  it("reads the file only when Download is pressed, then hands it over once", async () => {
    const run = urlSet();
    run.set.want([], ["att_one", "att_two"]);
    expect(run.fetched).toEqual([]);
    expect(attachmentDownloadState(run.set.status("att_one"), false)).toBe("idle");

    const saved: string[] = [];
    const save = (url: string) => saved.push(url);
    expect(pressAttachmentDownload(run.set, "att_one", save)).toBe(true);
    expect(run.fetched).toEqual(["att_one"]);
    expect(attachmentDownloadState(run.set.status("att_one"), true)).toBe("opening");
    // Still being read: nothing is downloaded, and a second press reads nothing more.
    expect(settleAttachmentDownload(run.set, "att_one", save)).toBe(true);
    expect(pressAttachmentDownload(run.set, "att_one", save)).toBe(true);
    expect(run.fetched).toEqual(["att_one"]);
    expect(saved).toEqual([]);

    await run.answer("att_one");
    expect(settleAttachmentDownload(run.set, "att_one", save)).toBe(false);
    expect(saved).toEqual(["blob:att_one"]);
    expect(attachmentDownloadState(run.set.status("att_one"), false)).toBe("idle");

    // Downloaded again from the bytes already read: no second read, and the other card read nothing.
    expect(pressAttachmentDownload(run.set, "att_one", save)).toBe(false);
    expect(saved).toEqual(["blob:att_one", "blob:att_one"]);
    expect(run.fetched).toEqual(["att_one"]);
    expect(run.set.status("att_two")).toBe("idle");
  });

  it("says a refused read failed, downloads nothing, and reads again only when the person presses again", async () => {
    const run = urlSet();
    run.set.want([], ["att_one"]);
    const saved: string[] = [];
    const save = (url: string) => saved.push(url);
    pressAttachmentDownload(run.set, "att_one", save);
    await run.fail("att_one");
    expect(settleAttachmentDownload(run.set, "att_one", save)).toBe(false);
    expect(saved).toEqual([]);
    expect(attachmentDownloadState(run.set.status("att_one"), false)).toBe("failed");
    expect(run.fetched).toEqual(["att_one"]);

    expect(pressAttachmentDownload(run.set, "att_one", save)).toBe(true);
    expect(run.fetched).toEqual(["att_one", "att_one"]);
    expect(attachmentDownloadState(run.set.status("att_one"), true)).toBe("opening");
    await run.answer("att_one");
    expect(settleAttachmentDownload(run.set, "att_one", save)).toBe(false);
    expect(saved).toEqual(["blob:att_one"]);
  });

  it("downloads nothing for a card that left the conversation while its file was read, and releases the late URL", async () => {
    const run = urlSet();
    run.set.want([], ["att_one"]);
    const saved: string[] = [];
    pressAttachmentDownload(run.set, "att_one", (url) => saved.push(url));
    run.set.want([], []);
    expect(settleAttachmentDownload(run.set, "att_one", (url) => saved.push(url))).toBe(false);
    await run.answer("att_one");
    expect(saved).toEqual([]);
    expect(run.revoked).toEqual(["blob:att_one"]);
  });

  it("does nothing for a reference no card listed", () => {
    const run = urlSet();
    expect(pressAttachmentDownload(run.set, "att_none", () => undefined)).toBe(false);
    expect(run.fetched).toEqual([]);
  });
});

describe("a file card as drawn", () => {
  const ATTACHMENT = {
    attachmentId: "att_report",
    filename: "bao-cao.pdf",
    mime: "application/pdf",
    kind: "pdf",
    sizeBytes: 2048,
    sha256: `sha256:${"a".repeat(64)}`,
    blobRef: `${"b".repeat(32)}.pdf`,
  };
  const surface = (() => null) as unknown as Parameters<typeof renderBlock>[2];

  function draw(client: GatewayClient | undefined, attachment: Record<string, unknown> = ATTACHMENT): string {
    const element = renderBlock({ type: "attachment", attachment }, 0, surface, undefined, client, (key) => key);
    if (element === null) throw new Error("the attachment block was not drawn");
    return renderToStaticMarkup(element);
  }

  // Drawn on the server, so no effect runs: this checks the markup. That nothing is read when a conversation opens is
  // counted where effects do run, in the browser journey `lazy-attachments.spec.ts`, and in the set's own tests above.
  it("offers a Download button with no URL in the page, and lists the file as not asked for", () => {
    const client = { attachmentObjectUrl: () => Promise.resolve("blob:never") } as unknown as GatewayClient;
    const drawn = draw(client);
    expect(drawn).toMatch(/<button[^>]*type="button"[^>]*data-attachment-download="true"[^>]*aria-disabled="false"/u);
    expect(drawn).not.toContain("href=");
    expect(drawn).not.toContain("blob:");
    expect(drawn).not.toContain("/attachments/");
    // An empty polite status, there before anything is said, so what it later says is heard.
    expect(drawn).toMatch(/<span[^>]*role="status"[^>]*aria-live="polite"[^>]*data-attachment-status="idle"><\/span>/u);
    expect(drawn).toContain("bao-cao.pdf");
  });

  it("says a view with no node connection has no file, rather than a button that cannot work", () => {
    const drawn = draw(undefined);
    expect(drawn).toContain('data-attachment-missing="true"');
    expect(drawn).not.toContain("<button");
  });
});

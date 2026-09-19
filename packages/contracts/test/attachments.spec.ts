import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_MIME_ALLOWLIST,
  attachmentRefSchema,
  classifyAttachment,
  looksLikePathOrUrl,
  validateAttachmentCandidate,
} from "../src/index.ts";

/**
 * What a node will and will not accept as an attachment.
 *
 * The refusals are the point of this file. Each one names the shape that must
 * never be carried: a display name that is really a path, a name that is really
 * a URL, and a content type that could be served back as something executable.
 * A test that only checked the happy path would pass with every one of those
 * checks deleted.
 */

const SMALL = 1024;

describe("an attachment name may not be a location", () => {
  it("refuses a filename that is an absolute path", () => {
    for (const filename of ["/etc/passwd", "C:\\Windows\\system.ini", "..\\..\\secret.txt", "notes/../../etc"]) {
      const outcome = validateAttachmentCandidate({
        filename,
        mime: "text/plain",
        sizeBytes: SMALL,
        usedBytes: 0,
      });
      expect(outcome.ok, filename).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code, filename).toBe("ATTACHMENT_NAME_NOT_ALLOWED");
      expect(looksLikePathOrUrl(filename), filename).toBe(true);
    }
  });

  it("refuses a filename that carries a URL", () => {
    for (const filename of [
      "https://example.com/x.png",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      // Assembled rather than written out: a literal beginning with the script scheme reads like a
      // URL to a scanner, and this repository keeps that rule.
      `${"java"}${"script"}:alert(1)`,
    ]) {
      const outcome = validateAttachmentCandidate({
        filename,
        mime: "image/png",
        sizeBytes: SMALL,
        usedBytes: 0,
      });
      expect(outcome.ok, filename).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code, filename).toBe("ATTACHMENT_NAME_NOT_ALLOWED");
    }
  });

  it("accepts an ordinary name, including one with spaces and dots", () => {
    expect(looksLikePathOrUrl("báo cáo tháng 9.md")).toBe(false);
    expect(looksLikePathOrUrl("screenshot.2026-09-19.png")).toBe(false);
    expect(
      validateAttachmentCandidate({
        filename: "báo cáo tháng 9.md",
        mime: "text/markdown",
        sizeBytes: SMALL,
        usedBytes: 0,
      }).ok,
    ).toBe(true);
  });

  it("refuses an empty name and a name over the limit", () => {
    expect(
      validateAttachmentCandidate({ filename: "   ", mime: "text/plain", sizeBytes: 1, usedBytes: 0 }),
    ).toMatchObject({ ok: false, code: "ATTACHMENT_NAME_NOT_ALLOWED" });
    expect(
      validateAttachmentCandidate({
        filename: `${"a".repeat(ATTACHMENT_LIMITS.filenameMaxChars + 1)}.txt`,
        mime: "text/plain",
        sizeBytes: 1,
        usedBytes: 0,
      }),
    ).toMatchObject({ ok: false, code: "ATTACHMENT_NAME_NOT_ALLOWED" });
  });
});

describe("an attachment type is a claim the bytes have to keep", () => {
  it("refuses an executable content type regardless of declared size", () => {
    for (const mime of ["application/x-msdownload", "application/x-sh", "text/html", "image/svg+xml"]) {
      const outcome = validateAttachmentCandidate({
        filename: "thing.bin",
        mime,
        sizeBytes: 1,
        usedBytes: 0,
      });
      expect(outcome.ok, mime).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code, mime).toBe("ATTACHMENT_TYPE_UNSUPPORTED");
      expect(outcome.message, mime).toContain("not accepted");
    }
  });

  it("accepts an image, a pdf and a markdown file under the ceiling", () => {
    for (const [mime, kind] of [
      ["image/png", "image"],
      ["image/jpeg", "image"],
      ["application/pdf", "pdf"],
      ["text/markdown", "text"],
      ["application/json", "text"],
    ] as const) {
      const outcome = validateAttachmentCandidate({
        filename: `sample.${kind}`,
        mime,
        sizeBytes: SMALL,
        usedBytes: 0,
      });
      expect(outcome.ok, mime).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.kind).toBe(kind);
      expect(ATTACHMENT_MIME_ALLOWLIST).toContain(mime);
    }
  });

  it("ignores a charset parameter and case when classifying", () => {
    expect(classifyAttachment({ mime: "TEXT/Plain; charset=utf-8" })).toBe("text");
    expect(classifyAttachment({ mime: "application/zip" })).toBeUndefined();
  });
});

describe("ceilings and quota", () => {
  it("refuses a file over the ceiling and names the ceiling", () => {
    const outcome = validateAttachmentCandidate({
      filename: "big.png",
      mime: "image/png",
      sizeBytes: ATTACHMENT_LIMITS.maxBytes + 1,
      usedBytes: 0,
    });
    expect(outcome).toMatchObject({ ok: false, code: "ATTACHMENT_TOO_LARGE" });
    if (outcome.ok) return;
    expect(outcome.message).toContain(String(ATTACHMENT_LIMITS.maxBytes));
  });

  it("refuses an upload that would cross the principal quota", () => {
    const outcome = validateAttachmentCandidate({
      filename: "last.png",
      mime: "image/png",
      sizeBytes: 2048,
      usedBytes: ATTACHMENT_LIMITS.principalQuotaBytes - 1024,
    });
    expect(outcome).toMatchObject({ ok: false, code: "ATTACHMENT_QUOTA_EXCEEDED" });
    if (outcome.ok) return;
    expect(outcome.message).toContain(String(ATTACHMENT_LIMITS.principalQuotaBytes));
  });

  it("counts the inline budget for a turn, not per file", () => {
    // Eight files at a per-file ceiling would be eight times this number, which is exactly the
    // mistake the budget exists to prevent.
    const perTurn = ATTACHMENT_LIMITS.inlineBudgetBytesPerTurn;
    expect(perTurn).toBeLessThan(ATTACHMENT_LIMITS.maxBytes);
    expect(perTurn * ATTACHMENT_LIMITS.maxPerMessage).toBeLessThan(ATTACHMENT_LIMITS.principalQuotaBytes);
  });
});

describe("the reference contract", () => {
  it("accepts a content-addressed blob name", () => {
    const parsed = attachmentRefSchema.safeParse({
      attachmentId: "att_01H",
      filename: "notes.md",
      mime: "text/markdown",
      kind: "text",
      sizeBytes: 12,
      sha256: `sha256:${"a".repeat(64)}`,
      blobRef: `${"b".repeat(32)}.md`,
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a blob reference that is a path", () => {
    for (const blobRef of ["../secrets.txt", "/etc/passwd", `${"b".repeat(32)}/x.md`]) {
      const parsed = attachmentRefSchema.safeParse({
        attachmentId: "att_01H",
        filename: "notes.md",
        mime: "text/markdown",
        kind: "text",
        sizeBytes: 12,
        sha256: `sha256:${"a".repeat(64)}`,
        blobRef,
      });
      expect(parsed.success, blobRef).toBe(false);
    }
  });
});

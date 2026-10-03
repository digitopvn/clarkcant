import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CHUNK_BASE64_MAX,
  ARTIFACT_EXTENSIONS,
  ARTIFACT_LIMITS,
  ARTIFACT_MIME_ALLOWLIST,
  ARTIFACT_REFUSAL_CODES,
  artifactAcceptMatches,
  artifactAcceptSchema,
  artifactFileName,
  artifactRefSchema,
  artifactRefusalStatus,
  checkArtifactRange,
  decideArtifactAccess,
  defaultArtifactName,
  isPersonOnlyRoute,
  readArtifactViewer,
  sanitizeProposedArtifactName,
  validateAttachmentCandidate,
} from "../src/index.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const LATER = "2026-09-30T13:00:00.000Z";
const EARLIER = "2026-09-30T11:00:00.000Z";

describe("an artifact ref", () => {
  it("parses a finalized ref with its digest", () => {
    const ref = artifactRefSchema.parse({
      v: 1,
      artifactId: "art_abc123",
      kind: "finalized",
      mimeType: "text/plain",
      sizeBytes: 12,
      name: "notes.txt",
      digest: DIGEST,
    });
    expect(ref.kind).toBe("finalized");
  });

  it("refuses a sealed ref without a digest and a working ref with one", () => {
    expect(
      artifactRefSchema.safeParse({ v: 1, artifactId: "art_a", kind: "external", mimeType: "text/plain", sizeBytes: 1, name: "a.txt" })
        .success,
    ).toBe(false);
    expect(
      artifactRefSchema.safeParse({
        v: 1,
        artifactId: "art_a",
        kind: "working",
        mimeType: "text/plain",
        sizeBytes: 1,
        name: "a.txt",
        digest: DIGEST,
      }).success,
    ).toBe(false);
  });

  it("never carries a path: a name that is a path or a URL is refused, and no field can hold one", () => {
    for (const name of ["C:\\Users\\me\\secret.txt", "/home/me/secret.txt", "../secret.txt", "file:///etc/passwd", "https://x.test/a"]) {
      expect(
        artifactRefSchema.safeParse({ v: 1, artifactId: "art_a", kind: "working", mimeType: "text/plain", sizeBytes: 0, name })
          .success,
      ).toBe(false);
    }
    // Strict: a location smuggled in as an extra field is refused rather than carried along.
    expect(
      artifactRefSchema.safeParse({
        v: 1,
        artifactId: "art_a",
        kind: "working",
        mimeType: "text/plain",
        sizeBytes: 0,
        name: "a.txt",
        path: "/home/me/a.txt",
      }).success,
    ).toBe(false);
  });

  it("is versioned: another version is refused", () => {
    expect(
      artifactRefSchema.safeParse({ v: 2, artifactId: "art_a", kind: "working", mimeType: "text/plain", sizeBytes: 0, name: "a.txt" })
        .success,
    ).toBe(false);
  });
});

describe("deciding a use of a ref", () => {
  const artifact = { ownerPrincipalId: "prn_me", state: "writable" as const };
  const grant = { instanceId: "winst_a", principalId: "prn_me", access: "write" as const, expiresAt: LATER };
  const decide = (overrides: Partial<Parameters<typeof decideArtifactAccess>[0]>) =>
    decideArtifactAccess({ principalId: "prn_me", instanceId: "winst_a", need: "read", artifact, grant, nowMs: NOW, ...overrides });

  it("allows the granted instance of the owner", () => {
    expect(decide({})).toEqual({ ok: true });
    expect(decide({ need: "write" })).toEqual({ ok: true });
  });

  it("refuses another principal's artifact, with a reason", () => {
    expect(decide({ principalId: "prn_other" })).toMatchObject({ ok: false, code: "ARTIFACT_CROSS_PRINCIPAL" });
    expect(decide({ grant: { ...grant, principalId: "prn_other" } })).toMatchObject({ ok: false, code: "ARTIFACT_CROSS_PRINCIPAL" });
  });

  it("refuses an instance that was never granted it", () => {
    expect(decide({ instanceId: "winst_b" })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_GRANTED" });
    expect(decide({ grant: undefined })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_GRANTED" });
  });

  it("refuses an expired or revoked grant", () => {
    expect(decide({ grant: { ...grant, expiresAt: EARLIER } })).toMatchObject({ ok: false, code: "ARTIFACT_GRANT_EXPIRED" });
    expect(decide({ grant: { ...grant, revokedAt: EARLIER } })).toMatchObject({ ok: false, code: "ARTIFACT_GRANT_REVOKED" });
  });

  it("refuses an expired artifact and an absent one", () => {
    expect(decide({ artifact: { ...artifact, expiresAt: EARLIER } })).toMatchObject({ ok: false, code: "ARTIFACT_EXPIRED" });
    expect(decide({ artifact: undefined })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_FOUND" });
  });

  it("refuses a write to sealed bytes or through a read-only grant", () => {
    expect(decide({ need: "write", artifact: { ...artifact, state: "sealed" } })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_WRITABLE" });
    expect(decide({ need: "write", grant: { ...grant, access: "read" } })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_WRITABLE" });
  });

  it("keeps a finalized file readable by the widget that wrote it after its grant's time, and nothing more", () => {
    const sealed = { ownerPrincipalId: "prn_me", state: "sealed" as const, kind: "finalized" as const, instanceId: "winst_a" };
    const lapsed = { ...grant, access: "read" as const, expiresAt: EARLIER };
    expect(decide({ artifact: sealed, grant: lapsed })).toEqual({ ok: true });
    // Another widget holding a lapsed grant on the same file is refused on time.
    expect(decide({ artifact: sealed, instanceId: "winst_b", grant: { ...lapsed, instanceId: "winst_b" } })).toMatchObject({
      ok: false,
      code: "ARTIFACT_GRANT_EXPIRED",
    });
    // A file the person chose runs out for the widget it was handed to, and says to ask the person again.
    const picked = decide({ artifact: { ...sealed, kind: "external" }, grant: lapsed });
    expect(picked).toMatchObject({ ok: false, code: "ARTIFACT_GRANT_EXPIRED" });
    expect(picked.ok ? "" : picked.message).toContain("choose the file again");
    // Still a read only, and still never past a revocation or another principal.
    expect(decide({ artifact: sealed, grant: lapsed, need: "write" })).toMatchObject({ ok: false, code: "ARTIFACT_GRANT_EXPIRED" });
    expect(decide({ artifact: sealed, grant: { ...lapsed, revokedAt: EARLIER } })).toMatchObject({ ok: false, code: "ARTIFACT_GRANT_REVOKED" });
    expect(decide({ artifact: sealed, grant: lapsed, principalId: "prn_other" })).toMatchObject({ ok: false, code: "ARTIFACT_CROSS_PRINCIPAL" });
  });

  it("names the first thing that was wrong: ownership before the grant", () => {
    expect(decide({ principalId: "prn_other", grant: undefined })).toMatchObject({ code: "ARTIFACT_CROSS_PRINCIPAL" });
  });
});

describe("bounded ranges", () => {
  it("shortens a read past the end and says it reached the end", () => {
    expect(checkArtifactRange({ offset: 10, length: 100, sizeBytes: 50 })).toEqual({ ok: true, offset: 10, length: 40, eof: true });
    expect(checkArtifactRange({ offset: 0, length: 10, sizeBytes: 50 })).toEqual({ ok: true, offset: 0, length: 10, eof: false });
  });

  it("refuses a length over the bound, a negative offset and an offset past the end", () => {
    expect(checkArtifactRange({ offset: 0, length: ARTIFACT_LIMITS.maxReadBytes + 1, sizeBytes: 10 })).toMatchObject({
      ok: false,
      code: "ARTIFACT_RANGE_INVALID",
    });
    expect(checkArtifactRange({ offset: -1, length: 1, sizeBytes: 10 })).toMatchObject({ ok: false });
    expect(checkArtifactRange({ offset: 11, length: 1, sizeBytes: 10 })).toMatchObject({ ok: false });
    expect(checkArtifactRange({ offset: "0", length: 1, sizeBytes: 10 })).toMatchObject({ ok: false });
  });

  it("sizes the base64 bound for one full chunk", () => {
    expect(ARTIFACT_CHUNK_BASE64_MAX).toBe(Buffer.from(new Uint8Array(ARTIFACT_LIMITS.chunkBytes)).toString("base64").length);
  });
});

describe("accept lists and names", () => {
  it("matches exact types and wildcards", () => {
    expect(artifactAcceptMatches([], "text/plain")).toBe(true);
    expect(artifactAcceptMatches(["text/*"], "text/markdown")).toBe(true);
    expect(artifactAcceptMatches(["image/png"], "image/jpeg")).toBe(false);
    expect(artifactAcceptSchema.safeParse("text/*").success).toBe(true);
    expect(artifactAcceptSchema.safeParse(".txt").success).toBe(false);
    // A pattern that looks like a path is not a MIME type, however loosely it matches the character set.
    expect(artifactAcceptSchema.safeParse("../x").success).toBe(false);
  });

  it("gives a working artifact a file name for its type", () => {
    expect(defaultArtifactName("text/markdown")).toBe("untitled.md");
  });

  it("maps every refusal to a status", () => {
    for (const code of ARTIFACT_REFUSAL_CODES) expect(artifactRefusalStatus(code)).toBeGreaterThanOrEqual(400);
    // A widget touching a file it did not make is a permission; a full share is a state the widget can change.
    expect(artifactRefusalStatus("ARTIFACT_NOT_CREATOR")).toBe(403);
    expect(artifactRefusalStatus("ARTIFACT_INSTANCE_QUOTA_EXCEEDED")).toBe(409);
  });

  it("holds one widget's share inside the principal's quota", () => {
    expect(ARTIFACT_LIMITS.instanceQuotaBytes).toBe(128 * 1024 * 1024);
    expect(ARTIFACT_LIMITS.instanceQuotaBytes).toBeGreaterThanOrEqual(ARTIFACT_LIMITS.maxBytes);
  });

  it("names a saved file by its bytes' type, whatever the widget suggested", () => {
    expect(artifactFileName("ghi-chu.md", "text/markdown")).toBe("ghi-chu.md");
    expect(artifactFileName("invoice.bat", "text/plain")).toBe("invoice.txt");
    expect(artifactFileName("Kế hoạch", "text/markdown")).toBe("Kế hoạch.md");
    expect(artifactFileName("ảnh.JPEG", "image/jpeg")).toBe("ảnh.JPEG");
    expect(artifactFileName("bao-cao. . ", "application/pdf")).toBe("bao-cao.pdf");
    expect(artifactFileName("  ", "text/csv")).toBe("file.csv");
    // Every allowed type has a name to be saved under.
    for (const mime of ARTIFACT_MIME_ALLOWLIST) expect(ARTIFACT_EXTENSIONS[mime]?.length ?? 0).toBeGreaterThan(0);
  });

  it("shortens a long name by character, never through one", () => {
    const long = artifactFileName(`${"ệ".repeat(300)}.exe`, "text/plain");
    expect(Array.from(long)).toHaveLength(ARTIFACT_LIMITS.nameMaxChars);
    expect(long.endsWith(".txt")).toBe(true);
    const emoji = artifactFileName(`${"😀".repeat(300)}.exe`, "text/plain");
    expect(Array.from(emoji)).toHaveLength(ARTIFACT_LIMITS.nameMaxChars);
    // No lone surrogate: the name survives a round trip through UTF-8 unchanged.
    expect(new TextDecoder().decode(new TextEncoder().encode(emoji))).toBe(emoji);
  });
});

describe("a name a widget proposes for a file it attaches", () => {
  const attachable = (name: string, mime: string): boolean =>
    validateAttachmentCandidate({ filename: name, mime, sizeBytes: 1, usedBytes: 0 }).ok;

  it("keeps a descriptive name and the extension the bytes' type has", () => {
    expect(sanitizeProposedArtifactName("a-red-kite-3f9a1c.png", "image/png")).toBe("a-red-kite-3f9a1c.png");
    expect(sanitizeProposedArtifactName("Ảnh.JPEG", "image/jpeg")).toBe("Ảnh.jpeg");
    expect(sanitizeProposedArtifactName("bao cao (ban 2)", "text/markdown")).toBe("bao cao (ban 2).md");
  });

  it("keeps only the last part of a path, and never a parent step", () => {
    expect(sanitizeProposedArtifactName("../../etc/passwd", "text/plain")).toBe("passwd.txt");
    expect(sanitizeProposedArtifactName("..\\..\\Windows\\win.ini", "text/plain")).toBe("win.txt");
    expect(sanitizeProposedArtifactName("C:\\Users\\an\\anh.png", "image/png")).toBe("anh.png");
    expect(sanitizeProposedArtifactName("https://evil.example/x/anh.png", "image/png")).toBe("anh.png");
    expect(sanitizeProposedArtifactName("..", "image/png")).toBe("untitled.png");
    expect(sanitizeProposedArtifactName("a..b...png", "image/png")).toBe("a.b.png");
    // A name that is only an extension, a hidden file's, has no stem to keep.
    expect(sanitizeProposedArtifactName(".hidden", "text/plain")).toBe("untitled.txt");
    expect(sanitizeProposedArtifactName(".png", "image/png")).toBe("untitled.png");
    for (const proposed of ["../x", "/abs/y.png", "C:z.png", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const name = sanitizeProposedArtifactName(proposed, "image/png");
      expect(name, proposed).not.toMatch(/[\\/:]|\.\./u);
      expect(attachable(name, "image/png"), proposed).toBe(true);
    }
  });

  it("removes control, format and direction characters, and turns anything else unsafe into a dash", () => {
    expect(sanitizeProposedArtifactName("hoa-don\u202Egpj.exe", "image/png")).toBe("hoa-dongpj.png");
    expect(sanitizeProposedArtifactName("anh\u0000\u0007\n\tmoi\u200B.png", "image/png")).toBe("anhmoi.png");
    expect(sanitizeProposedArtifactName("a<b>c|d?e*f\"g'h.png", "image/png")).toBe("a-b-c-d-e-f-g-h.png");
    expect(sanitizeProposedArtifactName("con mèo 🐱 bay", "image/png")).toBe("con mèo - bay.png");
  });

  it("removes characters drawn as nothing, so a name cannot look empty or like another", () => {
    // U+3164 Hangul filler, U+034F combining grapheme joiner, a variation selector, a soft hyphen.
    expect(sanitizeProposedArtifactName("ㅤ.png", "image/png")).toBe("untitled.png");
    expect(sanitizeProposedArtifactName("ㅤ͏️", "image/png")).toBe("untitled.png");
    expect(sanitizeProposedArtifactName("an͏h️-mo­i.png", "image/png")).toBe("anh-moi.png");
  });

  it("keeps a dotted stem whose tail is not an extension, and appends the type's", () => {
    expect(sanitizeProposedArtifactName("kite-v2.1", "image/png")).toBe("kite-v2.1.png");
    expect(sanitizeProposedArtifactName("ban 1.2.3", "text/markdown")).toBe("ban 1.2.3.md");
    // A tail that is an extension of another type is replaced, never kept in front: no `hoa-don.exe.png`.
    expect(sanitizeProposedArtifactName("hoa-don.exe", "image/png")).toBe("hoa-don.png");
  });

  it("keeps letters of any script, composed", () => {
    // Decomposed Vietnamese (as macOS writes it) comes out composed, so the same name is one name.
    expect(sanitizeProposedArtifactName("Ke\u0302\u0301 hoa\u0323ch.md", "text/markdown")).toBe("Kế hoạch.md");
    expect(sanitizeProposedArtifactName("東京の夜.png", "image/png")).toBe("東京の夜.png");
  });

  it("gives the bytes' type its extension, whatever the widget said", () => {
    expect(sanitizeProposedArtifactName("chay-toi.exe", "image/png")).toBe("chay-toi.png");
    expect(sanitizeProposedArtifactName("anh.jpg", "image/png")).toBe("anh.png");
    expect(sanitizeProposedArtifactName("anh", "image/webp")).toBe("anh.webp");
    expect(sanitizeProposedArtifactName("anh.tar.gz", "image/gif")).toBe("anh.tar.gif");
  });

  it("limits the length by code point, never cutting through a character", () => {
    const long = sanitizeProposedArtifactName(`${"ệ".repeat(500)}.png`, "image/png");
    expect(Array.from(long)).toHaveLength(ARTIFACT_LIMITS.proposedNameMaxChars);
    expect(long.endsWith("ệ.png")).toBe(true);
    expect(attachable(long, "image/png")).toBe(true);
    // A cut that lands on a separator does not leave the stem ending in one.
    const spaced = sanitizeProposedArtifactName(`${"a".repeat(95)} ${"b".repeat(50)}`, "image/png");
    expect(spaced).toBe(`${"a".repeat(95)}.png`);
    // A proposal far past any limit is read only so far.
    expect(Array.from(sanitizeProposedArtifactName("x".repeat(100_000), "image/png"))).toHaveLength(ARTIFACT_LIMITS.proposedNameMaxChars);
  });

  it("falls back to the default name when nothing usable is left", () => {
    for (const proposed of ["", "   ", "...", "///", "\u202E\u0000", "-- .", "🐱🐱"]) {
      expect(sanitizeProposedArtifactName(proposed, "image/png"), JSON.stringify(proposed)).toBe("untitled.png");
    }
    for (const proposed of [undefined, null, 42, { name: "x.png" }]) {
      expect(sanitizeProposedArtifactName(proposed, "image/png")).toBe("untitled.png");
    }
  });
});

describe("routes only the person may call", () => {
  it("holds Save As and the file picker back from machine surfaces, under any spelling", () => {
    expect(isPersonOnlyRoute("POST", "/artifacts/art_x/export")).toBe(true);
    expect(isPersonOnlyRoute("post", "//artifacts//art_x/export/?x=1")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/conversations/conv_x/widgets/winst_x/artifacts/pick")).toBe(true);
    // Reading, writing chunks and attaching stay reachable: they are a widget's work, re-checked against its grant.
    expect(isPersonOnlyRoute("GET", "/artifacts/art_x/content")).toBe(false);
    expect(isPersonOnlyRoute("POST", "/conversations/conv_x/widgets/winst_x/artifacts/art_x/chunks")).toBe(false);
    expect(isPersonOnlyRoute("POST", "/conversations/conv_x/widgets/winst_x/artifacts")).toBe(false);
  });
});
describe("a file card that points at an artifact", () => {
  const ref = { v: 1, artifactId: "art_abc123", kind: "finalized", mimeType: "text/plain", sizeBytes: 12, name: "ghi-chu.txt", digest: DIGEST };

  it("carries the reference whole, so the host can offer Open and Save As for it", () => {
    const content = readArtifactViewer("file", { name: "ghi-chu.txt", artifactRef: ref });
    expect(content?.kind === "file" ? content.card.artifactRef : undefined).toEqual(ref);
  });

  it("refuses a reference with a path in it, or one that is not a reference at all", () => {
    expect(readArtifactViewer("file", { name: "a.txt", artifactRef: { ...ref, name: "/home/me/a.txt" } })).toBeUndefined();
    expect(readArtifactViewer("file", { name: "a.txt", artifactRef: { artifactId: "art_abc123", path: "C:/a.txt" } })).toBeUndefined();
    expect(readArtifactViewer("file", { name: "a.txt", artifactRef: { ...ref, artifactId: "../../etc" } })).toBeUndefined();
  });
});
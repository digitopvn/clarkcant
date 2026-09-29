import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CHUNK_BASE64_MAX,
  ARTIFACT_LIMITS,
  ARTIFACT_REFUSAL_CODES,
  artifactAcceptMatches,
  artifactAcceptSchema,
  artifactRefSchema,
  artifactRefusalStatus,
  checkArtifactRange,
  decideArtifactAccess,
  defaultArtifactName,
  isPersonOnlyRoute,
  readArtifactViewer,
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
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_PAGE_MIGRATION,
  EMPTY_MEDIA_POLICY,
  MAX_DOCUMENT_PAGES,
  MEDIA_CONTENT_LIMITS,
  MEDIA_STATE_VERSION,
  checkMediaUrl,
  hostNamesAddress,
  normalizeAudioType,
  paginateDocumentText,
  parseHostFileRef,
  parseMediaPolicy,
  readAudio,
  readDocument,
  readDocumentPage,
  stateAsCurrentVersion,
} from "../src/index.ts";

const POLICY = { origins: ["https://media.example.com"] };

describe("the media content policy", () => {
  it("allows no origin by default", () => {
    expect(parseMediaPolicy(undefined)).toEqual({ ok: true, policy: { origins: [] } });
    expect(parseMediaPolicy(" , ")).toEqual({ ok: true, policy: { origins: [] } });
    expect(checkMediaUrl("https://media.example.com/a.mp3", EMPTY_MEDIA_POLICY)).toMatchObject({ ok: false, rule: "origin-not-allowed" });
  });

  it("reads a list of bare https origins, and refuses the whole setting when one entry is not one", () => {
    expect(parseMediaPolicy("https://b.example.com, https://a.example.com:8443")).toEqual({
      ok: true,
      policy: { origins: ["https://a.example.com:8443", "https://b.example.com"] },
    });
    for (const entry of ["http://a.example.com", "https://user:pw@a.example.com", "https://a.example.com/podcasts", "https://a.example.com/", "not a url"]) {
      const parsed = parseMediaPolicy(`https://ok.example.com,${entry}`);
      expect(parsed.ok, entry).toBe(false);
    }
  });

  it("names the rule each refused URL broke", () => {
    expect(checkMediaUrl("http://media.example.com/a.mp3", POLICY)).toMatchObject({ ok: false, rule: "https-only" });
    expect(checkMediaUrl("https://u:p@media.example.com/a.mp3", POLICY)).toMatchObject({ ok: false, rule: "credentials-in-url" });
    expect(checkMediaUrl("https://media.example.com.evil.test/a.mp3", POLICY)).toMatchObject({ ok: false, rule: "origin-not-allowed" });
    expect(checkMediaUrl("https://media.example.com:8443/a.mp3", POLICY)).toMatchObject({ ok: false, rule: "origin-not-allowed" });
    expect(checkMediaUrl("::", POLICY)).toMatchObject({ ok: false, rule: "source" });
    const refused = checkMediaUrl("ftp://media.example.com/a.mp3", POLICY);
    expect(refused.ok === false && refused.message).toContain("(media policy rule: https-only)");
    expect(checkMediaUrl("https://media.example.com/show/a.mp3?x=1", POLICY)).toMatchObject({ ok: true });
  });

  it("knows which hosts name their own address", () => {
    expect(hostNamesAddress("127.0.0.1")).toBe(true);
    expect(hostNamesAddress("[::1]")).toBe(true);
    expect(hostNamesAddress("localhost")).toBe(true);
    expect(hostNamesAddress("media.example.com")).toBe(false);
  });

  it("reads what a server calls an audio file under the type the node uses", () => {
    expect(normalizeAudioType("audio/mp3")).toBe("audio/mpeg");
    expect(normalizeAudioType("Audio/MPEG; charset=binary")).toBe("audio/mpeg");
    expect(normalizeAudioType("application/ogg")).toBe("audio/ogg");
    expect(normalizeAudioType("audio/x-wav")).toBe("audio/wav");
    expect(normalizeAudioType("audio/webm")).toBe("audio/webm");
    expect(normalizeAudioType("text/html")).toBeUndefined();
    expect(normalizeAudioType("video/mp4")).toBeUndefined();
    expect(normalizeAudioType(undefined)).toBeUndefined();
  });

  it("parses only host file references, never a URL or a path", () => {
    expect(parseHostFileRef("artifact:art_1")).toEqual({ kind: "artifact", id: "art_1" });
    expect(parseHostFileRef("attachment:att-2")).toEqual({ kind: "attachment", id: "att-2" });
    expect(parseHostFileRef("https://x.test/a")).toBeUndefined();
    expect(parseHostFileRef("artifact:../a")).toBeUndefined();
    expect(parseHostFileRef("img_1")).toBeUndefined();
  });
});

describe("the stored media props", () => {
  it("reads an audio player only with a host reference and a type it plays", () => {
    expect(readAudio({ title: "T", audioRef: "artifact:a", mimeType: "audio/ogg", durationSeconds: 3.5, transcript: "" })).toEqual({
      title: "T",
      audioRef: "artifact:a",
      mimeType: "audio/ogg",
      durationSeconds: 3.5,
    });
    expect(readAudio({ title: "T", audioRef: "https://x.test/a.mp3", mimeType: "audio/mpeg" })).toBeUndefined();
    expect(readAudio({ title: "T", audioRef: "artifact:a", mimeType: "video/mp4" })).toBeUndefined();
  });

  it("splits a document into bounded pages and says when it was cut", () => {
    const short = paginateDocumentText("hello\nworld");
    expect(short).toEqual({ pages: ["hello\nworld"], totalChars: 11, truncated: false });
    expect(paginateDocumentText("")).toEqual({ pages: [""], totalChars: 0, truncated: false });

    const words = Array.from({ length: 5_000 }, (_, index) => `word${String(index)}`).join(" ");
    const long = paginateDocumentText(words);
    expect(long.truncated).toBe(true);
    expect(long.totalChars).toBe(Array.from(words).length);
    expect(long.pages.length).toBeLessThanOrEqual(MAX_DOCUMENT_PAGES);
    for (const page of long.pages) expect(Array.from(page).length).toBeLessThanOrEqual(MEDIA_CONTENT_LIMITS.documentPageChars);
    expect(long.pages.join("").length).toBeLessThanOrEqual(MEDIA_CONTENT_LIMITS.maxDocumentChars);
    // A page ends between words rather than inside one.
    expect(long.pages[0]?.endsWith(" ")).toBe(true);
    // Every character kept is kept once, in order.
    expect(words.startsWith(long.pages.join(""))).toBe(true);
  });

  it("never splits a character that takes two code units", () => {
    const text = "😀".repeat(MEDIA_CONTENT_LIMITS.documentPageChars + 5);
    const preview = paginateDocumentText(text);
    expect(preview.pages).toHaveLength(2);
    expect(Array.from(preview.pages[0] ?? "")).toHaveLength(MEDIA_CONTENT_LIMITS.documentPageChars);
    expect(preview.pages.join("")).toBe(text);
  });

  it("counts past the kept prefix by code point, and takes a whole document's length when given only its start", () => {
    const text = "😀".repeat(MEDIA_CONTENT_LIMITS.maxDocumentChars + 7);
    const preview = paginateDocumentText(text);
    expect(preview.totalChars).toBe(MEDIA_CONTENT_LIMITS.maxDocumentChars + 7);
    expect(preview.truncated).toBe(true);
    expect(Array.from(preview.pages.join("")).length).toBeLessThanOrEqual(MEDIA_CONTENT_LIMITS.maxDocumentChars);
    const start = paginateDocumentText("short start", 1_000_000);
    expect(start).toMatchObject({ totalChars: 1_000_000, truncated: true, pages: ["short start"] });
  });

  it("reads a stored preview and the page it is on, clamped to the pages it has", () => {
    const props = { name: "a.txt", mimeType: "text/plain", documentRef: "attachment:a", pages: ["one", "two"], totalChars: 6, truncated: false };
    expect(readDocument(props)).toMatchObject({ name: "a.txt", pages: ["one", "two"] });
    expect(readDocument({ ...props, mimeType: "text/html" })).toBeUndefined();
    expect(readDocument({ ...props, pages: [] })).toBeUndefined();
    expect(readDocumentPage({ page: 1 }, 2)).toBe(1);
    expect(readDocumentPage({ page: 9 }, 2)).toBe(1);
    expect(readDocumentPage({ page: -3 }, 2)).toBe(0);
    expect(readDocumentPage(undefined, 2)).toBe(0);
  });

  it("migrates a page state written before it had a version to the first page", () => {
    expect(DOCUMENT_PAGE_MIGRATION.to).toBe(MEDIA_STATE_VERSION);
    expect(stateAsCurrentVersion({ stateVersion: MEDIA_STATE_VERSION, stateMigrations: [DOCUMENT_PAGE_MIGRATION] }, { stateVersion: 1, body: {} })).toEqual({
      stateVersion: 2,
      body: { page: 0 },
    });
  });
});

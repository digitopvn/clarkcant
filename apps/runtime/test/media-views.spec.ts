import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Instant,
  type MediaPolicy,
  type MessageBlock,
  MEDIA_CONTENT_LIMITS,
  SEMANTIC_LIMITS,
  canonicalSemanticDoc,
  mediaRefusal,
} from "@clarkcant/contracts";
import { getActionBinding, getInstance, liveStateOf } from "@clarkcant/core";
import { AUDIO, DOCUMENT } from "@clarkcant/data-canvas";
import { appendMessage, getArtifactGrant, getBrokerArtifact, insertAttachment, insertBrokerArtifact } from "@clarkcant/storage";

import { invokeWidgetAction } from "../src/application/widget-actions.ts";
import { blobsDir, writeBlob } from "../src/blobs.ts";
import { layoutLeafWidgets } from "../src/compose-layout.ts";
import type { FetchedAudio } from "../src/media-fetch.ts";
import { type MediaViewDeps, mediaPolicyFromEnv } from "../src/media-views.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { toneWav } from "../src/test-support/media-fixtures.ts";
import { buildViewCatalog } from "../src/view-catalog.ts";
import { buildWidgetSemantic } from "../src/widget-semantic.ts";

/**
 * The audio player and the document preview, placed the way a model's `show_view` places them.
 *
 * A model names a source; the node reads it, holds it to the media content policy, and stores only what it checked.
 * What matters here is what is refused and why, what is kept, and that a fetched file becomes an artifact of the
 * conversation that the page plays from the node rather than from the origin it came from.
 */

const AT = "2026-10-02T05:00:00.000Z" as Instant;
const CONVERSATION = "conv_media_views";
const ORIGIN = "https://media.example.com";
const BIDI = String.fromCodePoint(0x202e);

let dir: string;
let services: NodeServices;
let counter = 0;
let fetched: string[] = [];
let answer: (url: string) => FetchedAudio | ReturnType<typeof mediaRefusal>;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

function media(policy: MediaPolicy = { origins: [ORIGIN] }): MediaViewDeps {
  return {
    dataDir: dir,
    policy: () => policy,
    fetchAudio: (url) => {
      fetched.push(url);
      return Promise.resolve(answer(url));
    },
  };
}

async function place(definitionId: string, props: Record<string, unknown>, options: { conversationId?: string; deps?: MediaViewDeps; caption?: string } = {}) {
  const view = buildViewCatalog(services.conductor, undefined, undefined, options.deps ?? media()).find((entry) => entry.id === definitionId);
  if (view === undefined) throw new Error(`${definitionId} is not in the catalog`);
  const messageId = `msg_${String(++counter)}`;
  const block = (await view.build({
    props,
    caption: options.caption ?? "",
    at: AT,
    principal: { principalId: owner(), kind: "user", nodeId: services.runtime.identity.nodeId } as never,
    messageId,
    conversationId: options.conversationId ?? CONVERSATION,
  })) as Extract<MessageBlock, { type: "surface" }>;
  appendMessage(
    services.runtime.db,
    { messageId, conversationId: CONVERSATION, role: "assistant", authorNodeId: services.runtime.identity.nodeId, delivery: "accepted", createdAt: AT, blocks: [block] } as never,
    counter,
  );
  return block;
}

function heldArtifact(artifactId: string, bytes: Uint8Array, mimeType: string, overrides: { ownerPrincipalId?: string; conversationId?: string; name?: string } = {}): void {
  const blob = writeBlob({ dataDir: dir, bytes, extension: "bin" });
  insertBrokerArtifact(services.runtime.db, {
    artifactId,
    ownerPrincipalId: overrides.ownerPrincipalId ?? owner(),
    kind: "finalized",
    state: "sealed",
    conversationId: overrides.conversationId ?? CONVERSATION,
    // Saved by some earlier widget of the conversation; the player never needs that widget's grant to read it.
    instanceId: "inst_earlier",
    name: overrides.name ?? `${artifactId}.bin`,
    mimeType,
    sizeBytes: bytes.byteLength,
    digest: blob.digest,
    blobPath: blob.blobPath,
    stagingRef: undefined,
    createdAt: AT,
    expiresAt: undefined,
    originNodeId: services.runtime.identity.nodeId,
  } as never);
}

function heldAttachment(attachmentId: string, bytes: Uint8Array, filename: string, mime: string, kind: "pdf" | "text"): void {
  const blob = writeBlob({ dataDir: dir, bytes, extension: filename.split(".").at(-1) ?? "bin" });
  insertAttachment(services.runtime.db, {
    attachmentId,
    principalId: owner(),
    conversationId: CONVERSATION,
    filename,
    mime,
    kind,
    sizeBytes: bytes.byteLength,
    sha256: blob.digest,
    blobPath: blob.blobPath,
    createdAt: AT,
  } as never);
}

function pdf(pages: readonly string[]): Uint8Array {
  const objects = pages.flatMap((text, index) => [
    `${String(3 + index * 2)} 0 obj << /Type /Page /Parent 2 0 R /Contents ${String(4 + index * 2)} 0 R >> endobj`,
    `${String(4 + index * 2)} 0 obj << /Length ${String(text.length + 12)} >>\nstream\nBT (${text}) Tj ET\nendstream\nendobj`,
  ]);
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    `2 0 obj << /Type /Pages /Kids [${pages.map((_, index) => `${String(3 + index * 2)} 0 R`).join(" ")}] /Count ${String(pages.length)} >> endobj`,
    ...objects,
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return new Uint8Array(Buffer.from(body, "latin1"));
}

async function setView(instanceId: string, input: Record<string, unknown>) {
  const instance = getInstance(services.conductor, instanceId);
  const bindingId = instance?.actionBindingIds[0] ?? "";
  const binding = getActionBinding(services.conductor, bindingId);
  return invokeWidgetAction(
    services,
    {
      conversationId: CONVERSATION,
      principalId: owner() as never,
      instanceId,
      actionBindingId: bindingId,
      expectedRevision: instance?.revision ?? 0,
      expectedBindingDigest: binding?.bindingDigest ?? "",
      input,
      invocationId: `inv_${String(++counter)}`,
    },
    "click",
  );
}

function instanceRows(): number {
  return (services.runtime.db.prepare("SELECT COUNT(*) AS n FROM widget_instances").get() as { n: number }).n;
}

function semanticOf(instanceId: string) {
  const doc = buildWidgetSemantic(services.conductor, instanceId);
  if (doc === undefined) throw new Error("no document");
  return doc;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-media-views-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  for (const conversationId of [CONVERSATION, "conv_other"]) {
    services.runtime.db
      .prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)")
      .run(conversationId, services.runtime.identity.nodeId, AT, AT);
  }
  fetched = [];
  answer = (url) => ({ ok: true, bytes: toneWav({ seconds: 2 }), mimeType: "audio/wav", durationSeconds: 2, origin: new URL(url).origin });
});

afterEach(() => {
  services.runtime.db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("the model's vocabulary", () => {
  it("offers both only on a node that has a media policy, and keeps them out of layouts", () => {
    const withMedia = buildViewCatalog(services.conductor, undefined, undefined, media()).map((view) => view.id);
    expect(withMedia).toEqual(expect.arrayContaining([AUDIO.id, DOCUMENT.id]));
    expect(buildViewCatalog(services.conductor).map((view) => view.id)).not.toContain(AUDIO.id);
    const leaves = layoutLeafWidgets(services.compose.registry);
    expect(leaves).not.toContain(AUDIO.id);
    expect(leaves).not.toContain(DOCUMENT.id);
    const audio = buildViewCatalog(services.conductor, undefined, undefined, media()).find((view) => view.id === AUDIO.id);
    expect(audio?.notes).toContain("never plays by itself");
    expect(audio?.notes).toContain("none unless the operator named some");
  });

  it("reads the policy from the environment, allowing nothing when it is unset or cannot be read", () => {
    const lines: string[] = [];
    expect(mediaPolicyFromEnv({}, (line) => lines.push(line))).toEqual({ origins: [] });
    expect(lines).toEqual([]);
    expect(mediaPolicyFromEnv({ CC_MEDIA_ORIGINS: `${ORIGIN},http://plain.example.com` }, (line) => lines.push(line))).toEqual({ origins: [] });
    expect(lines[0]).toContain("CC_MEDIA_ORIGINS was not used");
    expect(mediaPolicyFromEnv({ CC_MEDIA_ORIGINS: ORIGIN }, (line) => lines.push(line))).toEqual({ origins: [ORIGIN] });
  });
});

describe("placing an audio player from an allowed URL", () => {
  it("stores the fetched file as a sealed artifact of the conversation, granted to the player, and plays it from the node", async () => {
    const block = await place(AUDIO.id, { title: "Morning brief", url: `${ORIGIN}/brief.wav`, transcript: "Good morning." });
    expect(fetched).toEqual([`${ORIGIN}/brief.wav`]);
    const instanceId = block.snapshot.instanceId ?? "";
    const props = getInstance(services.conductor, instanceId)?.props ?? {};
    expect(props).toMatchObject({ title: "Morning brief", mimeType: "audio/wav", durationSeconds: 2, sourceOrigin: ORIGIN, transcript: "Good morning." });
    expect(JSON.stringify(props)).not.toContain("brief.wav");
    const artifactId = String(props.audioRef).replace(/^artifact:/, "");
    expect(props.audioRef).toMatch(/^artifact:/);
    const record = getBrokerArtifact(services.runtime.db, artifactId);
    expect(record).toMatchObject({ kind: "external", state: "sealed", conversationId: CONVERSATION, instanceId, ownerPrincipalId: owner(), mimeType: "audio/wav", name: "Morning brief.wav" });
    expect(existsSync(record?.blobPath ?? "")).toBe(true);
    expect(getArtifactGrant(services.runtime.db, artifactId, instanceId)).toMatchObject({ access: "read" });
    expect(block.snapshot.textAlternative).toBe("Audio: Morning brief (0:02). Transcript: Good morning.");
    expect(block.snapshot.presentationRef).toBe(`catalog:${AUDIO.id}`);
  });

  it("places the fetched artifact again by its id, without fetching", async () => {
    const first = await place(AUDIO.id, { title: "Brief", url: `${ORIGIN}/brief.wav` });
    const artifactId = String(getInstance(services.conductor, first.snapshot.instanceId ?? "")?.props.audioRef).replace(/^artifact:/, "");
    fetched = [];
    const second = await place(AUDIO.id, { title: "Brief again", artifactId });
    expect(fetched).toEqual([]);
    expect(getInstance(services.conductor, second.snapshot.instanceId ?? "")?.props).toMatchObject({ audioRef: `artifact:${artifactId}`, mimeType: "audio/wav" });
  });

  it("refuses with the rule a refused fetch broke, stores nothing, and keeps no blob", async () => {
    answer = () => mediaRefusal("private-address", "media.example.com resolves to 10.0.0.1");
    await expect(place(AUDIO.id, { title: "x", url: `${ORIGIN}/a.wav` })).rejects.toThrow("(media policy rule: private-address)");
    expect(instanceRows()).toBe(0);
    expect(existsSync(blobsDir(dir)) ? readdirSync(blobsDir(dir)) : []).toEqual([]);
  });

  it("checks the URL against the policy it is given, so a node with no origins fetches nothing", async () => {
    const deps: MediaViewDeps = { dataDir: dir, policy: () => ({ origins: [] }) };
    await expect(place(AUDIO.id, { title: "x", url: `${ORIGIN}/a.wav` }, { deps })).rejects.toThrow("(media policy rule: origin-not-allowed)");
    await expect(place(AUDIO.id, { title: "x", url: "http://media.example.com/a.wav" }, { deps })).rejects.toThrow("(media policy rule: https-only)");
    await expect(place(AUDIO.id, { title: "x", url: "https://u:p@media.example.com/a.wav" }, { deps })).rejects.toThrow(
      "(media policy rule: credentials-in-url)",
    );
    expect(instanceRows()).toBe(0);
  });

  it("refuses a title or transcript the schema cannot hold before fetching anything", async () => {
    fetched = [];
    await expect(place(AUDIO.id, { title: "t".repeat(201), url: `${ORIGIN}/a.wav` })).rejects.toThrow("props.title is longer than 200 characters");
    await expect(
      place(AUDIO.id, { title: "x", url: `${ORIGIN}/a.wav`, transcript: "w".repeat(MEDIA_CONTENT_LIMITS.maxTranscriptChars + 1) }),
    ).rejects.toThrow("props.transcript is longer than");
    expect(fetched).toEqual([]);
    expect(instanceRows()).toBe(0);
  });
});

describe("placing an audio player from a file the conversation holds", () => {
  it("plays an artifact after checking its bytes, with the length read from the file", async () => {
    heldArtifact("art_tone", toneWav({ seconds: 3 }), "audio/x-wav");
    const block = await place(AUDIO.id, { title: "Tone", artifactId: "art_tone" });
    expect(getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props).toEqual({
      title: "Tone",
      audioRef: "artifact:art_tone",
      mimeType: "audio/wav",
      durationSeconds: 3,
      sizeBytes: toneWav({ seconds: 3 }).byteLength,
    });
  });

  it.each([
    ["a type the model supplied", { title: "x", artifactId: "art_tone", mimeType: "audio/mpeg" }, "mimeType is not something a model sets"],
    ["a length the model supplied", { title: "x", artifactId: "art_tone", durationSeconds: 1 }, "durationSeconds is not something a model sets"],
    ["two sources", { title: "x", artifactId: "art_tone", url: `${ORIGIN}/a.wav` }, "(media policy rule: source)"],
    ["no source", { title: "x" }, "(media policy rule: source)"],
    ["an id this node does not issue", { title: "x", artifactId: "../art" }, "(media policy rule: source)"],
    ["a missing title", { artifactId: "art_tone" }, "props.title names the audio"],
  ])("refuses %s", async (_name, props, reason) => {
    heldArtifact("art_tone", toneWav({ seconds: 1 }), "audio/wav");
    await expect(place(AUDIO.id, props)).rejects.toThrow(reason);
    expect(instanceRows()).toBe(0);
  });

  it("gives one answer for another conversation's, another person's and an absent file", async () => {
    heldArtifact("art_elsewhere", toneWav({ seconds: 1 }), "audio/wav", { conversationId: "conv_other" });
    heldArtifact("art_theirs", toneWav({ seconds: 1 }), "audio/wav", { ownerPrincipalId: "prin_someone_else" });
    for (const artifactId of ["art_elsewhere", "art_theirs", "art_absent"]) {
      await expect(place(AUDIO.id, { title: "x", artifactId })).rejects.toThrow(
        "there is no file with that artifactId in this conversation (media policy rule: not-found)",
      );
    }
  });

  it("refuses a file whose bytes are not the audio it is recorded as, or not audio at all", async () => {
    heldArtifact("art_lie", toneWav({ seconds: 1 }), "audio/mpeg");
    await expect(place(AUDIO.id, { title: "x", artifactId: "art_lie" })).rejects.toThrow("(media policy rule: type-mismatch)");
    heldArtifact("art_page", new TextEncoder().encode("<script>alert(1)</script>"), "text/html");
    await expect(place(AUDIO.id, { title: "x", artifactId: "art_page" })).rejects.toThrow("(media policy rule: type-not-allowed)");
    heldAttachment("att_note", new TextEncoder().encode("hello"), "note.txt", "text/plain", "text");
    await expect(place(AUDIO.id, { title: "x", attachmentId: "att_note" })).rejects.toThrow("(media policy rule: type-not-allowed)");
    heldArtifact("art_long", toneWav({ seconds: MEDIA_CONTENT_LIMITS.maxAudioSeconds + 10, sampleRate: 1 }), "audio/wav");
    await expect(place(AUDIO.id, { title: "x", artifactId: "art_long" })).rejects.toThrow("(media policy rule: too-long)");
  });
});

describe("the player's state", () => {
  it("keeps where the person paused, and reads it as the audio's semantic state within the limits", async () => {
    heldArtifact("art_tone", toneWav({ seconds: 3 }), "audio/wav");
    await expect(place(AUDIO.id, { title: `Tone${BIDI}`, artifactId: "art_tone" })).rejects.toThrow("U+202E");
    const block = await place(AUDIO.id, { title: "Tone", artifactId: "art_tone", transcript: `Words${BIDI} ${"x".repeat(3_900)}` });
    expect(getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props.transcript).toContain(BIDI);
    expect(block.snapshot.textAlternative).not.toContain(BIDI);
    expect(block.snapshot.textAlternative).toContain("Transcript: Words⟨U+202E⟩ x");
    const instanceId = block.snapshot.instanceId ?? "";
    expect(semanticOf(instanceId)).toMatchObject({ summary: expect.stringContaining("Audio paused"), values: { status: "paused", position: 0, duration: 3, hasTranscript: true } });
    expect((await setView(instanceId, { status: "paused", position: 1.25, duration: 3 })).ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId, AUDIO)?.body).toEqual({ status: "paused", position: 1.25, duration: 3 });
    const doc = semanticOf(instanceId);
    expect(doc.values).toMatchObject({ position: 1.3, duration: 3 });
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);
    expect(canonicalSemanticDoc(doc)).not.toContain(BIDI);
    expect(block.snapshot.textAlternative.length).toBeLessThanOrEqual(4_000 + 200);
  });

  it("refuses a position past the end", async () => {
    heldArtifact("art_tone", toneWav({ seconds: 3 }), "audio/wav");
    const instanceId = (await place(AUDIO.id, { title: "Tone", artifactId: "art_tone" })).snapshot.instanceId ?? "";
    const outcome = await setView(instanceId, { status: "playing", position: 9, duration: 3 });
    expect(outcome.ok).toBe(false);
  });
});

describe("placing a document preview", () => {
  it("reads a PDF attachment's text into pages and counts the PDF's own pages", async () => {
    heldAttachment("att_report", pdf(["First page text", "Second page text"]), "report.pdf", "application/pdf", "pdf");
    const block = await place(DOCUMENT.id, { attachmentId: "att_report", title: "Quarterly report" });
    const props = getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props ?? {};
    expect(props).toMatchObject({
      title: "Quarterly report",
      name: "report.pdf",
      mimeType: "application/pdf",
      documentRef: "attachment:att_report",
      sourcePages: 2,
      truncated: false,
    });
    expect((props.pages as string[]).join("")).toContain("First page text");
    expect(block.snapshot.textAlternative).toBe("Document: report.pdf — a text preview in 1 page of a 2-page PDF.");
  });

  it("pages a long text file within the bounds, says it was cut, and keeps the page the person is on", async () => {
    const text = Array.from({ length: 3_000 }, (_, index) => `line ${String(index)} ${BIDI}`).join("\n");
    heldArtifact("art_notes", new TextEncoder().encode(text), "text/plain");
    const block = await place(DOCUMENT.id, { artifactId: "art_notes" });
    const instanceId = block.snapshot.instanceId ?? "";
    const props = getInstance(services.conductor, instanceId)?.props ?? {};
    const pages = props.pages as string[];
    expect(pages.length).toBeLessThanOrEqual(10);
    expect(props.truncated).toBe(true);
    expect(props.totalChars).toBe(Array.from(text).length);
    expect(block.snapshot.textAlternative).toContain(", cut short.");

    expect(semanticOf(instanceId)).toMatchObject({ values: { pageCount: pages.length, currentPage: 1, truncated: true } });
    expect((await setView(instanceId, { page: 3 })).ok).toBe(true);
    expect(liveStateOf(services.conductor, instanceId, DOCUMENT)?.body).toEqual({ page: 3 });
    const doc = semanticOf(instanceId);
    expect(doc.summary).toBe(`Document: art_notes.bin, page 4 of ${String(pages.length)} (preview cut short)`);
    expect(canonicalSemanticDoc(doc).length).toBeLessThanOrEqual(SEMANTIC_LIMITS.bytes);

    const outcome = await setView(instanceId, { page: pages.length });
    expect(outcome.ok).toBe(false);
    expect(liveStateOf(services.conductor, instanceId, DOCUMENT)?.body).toEqual({ page: 3 });
  });

  it("decodes only the start of a large text file, counts the rest, and clips a long name by character", async () => {
    // Past the decode window: four bytes for every character a preview can keep.
    const line = "ă".repeat(99) + "\n";
    const text = line.repeat(Math.ceil((MEDIA_CONTENT_LIMITS.maxDocumentChars * 4) / (Buffer.byteLength(line) - 1)) + 10);
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBeGreaterThan(MEDIA_CONTENT_LIMITS.maxDocumentChars * 4);
    const name = `${"ồ".repeat(300)}.txt`;
    heldArtifact("art_big", bytes, "text/plain", { name });
    const block = await place(DOCUMENT.id, { artifactId: "art_big" });
    const props = getInstance(services.conductor, block.snapshot.instanceId ?? "")?.props ?? {};
    expect(props.totalChars).toBe(Array.from(text).length);
    expect(props.truncated).toBe(true);
    expect((props.pages as string[]).join("")).toBe(text.slice(0, (props.pages as string[]).join("").length));
    expect(Array.from(String(props.name))).toHaveLength(255);
  });

  it.each([
    ["a file that is not a document", () => heldArtifact("art_x", toneWav({ seconds: 1 }), "audio/wav"), { artifactId: "art_x" }, "(media policy rule: type-not-allowed)"],
    ["an HTML page", () => heldArtifact("art_x", new TextEncoder().encode("<script></script>"), "text/html"), { artifactId: "art_x" }, "(media policy rule: type-not-allowed)"],
    ["a PDF with no text", () => heldArtifact("art_x", pdf([]), "application/pdf"), { artifactId: "art_x" }, "its text could not be read"],
    ["a URL", () => undefined, { url: "https://media.example.com/a.pdf" }, "url is not something a model sets"],
    ["pages the model wrote", () => heldArtifact("art_x", new TextEncoder().encode("hi"), "text/plain"), { artifactId: "art_x", pages: ["fake"] }, "pages is not something a model sets"],
  ])("refuses %s", async (_name, seed, props, reason) => {
    seed();
    await expect(place(DOCUMENT.id, props)).rejects.toThrow(reason);
    expect(instanceRows()).toBe(0);
  });
});

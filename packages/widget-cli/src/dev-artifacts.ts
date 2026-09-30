import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import {
  ARTIFACT_LIMITS,
  ARTIFACT_MIME_ALLOWLIST,
  artifactAcceptMatches,
  artifactNameSchema,
  checkArtifactRange,
  defaultArtifactName,
} from "@clarkcant/contracts";
import type { FrameArtifactOutcome } from "@clarkcant/widget-host";
import { artifactRequestSchema, type ArtifactRef } from "@clarkcant/widget-sdk";

/**
 * `artifacts@1` in `clark widget dev`: the picker, simulated with the package's own fixture files.
 *
 * A widget that picks, reads, writes and exports files has to be developed somewhere other than a conversation, and
 * the dev host is that place. It answers the same requests with the same refusal codes the node does, over files the
 * author put in `fixtures/files/`, so what an author builds against here is the contract a real host enforces.
 *
 * What it does **not** do is pretend to be the node. It holds everything in memory, forgets it when the dev host
 * stops, does not sniff bytes, and saves nothing to disk: an export or an attach is recorded in the shell's log, and
 * the shell says so. The picker is the shell's "File picker" control, which chooses which fixture file the next pick
 * returns — or that the person cancels — so both paths can be exercised on purpose.
 *
 * The widget never learns where a fixture file is. It gets the file's bare name, its type, its size and its digest,
 * exactly as it would from a real pick.
 */

/** A file in `fixtures/files/`, by name. Its path stays in this process. */
export interface DevFixtureFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export const DEV_FIXTURE_FILE_LIMITS = Object.freeze({
  /** Files read from `fixtures/files/`. More than this is a fixture directory, not a picker. */
  maxFiles: 32,
  /** One fixture file. The node's own per-file ceiling. */
  maxBytes: ARTIFACT_LIMITS.maxBytes,
});

const EXTENSION_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * The fixture files a package offers its simulated picker, and what was skipped with the reason.
 *
 * Only files a node would hold: a type outside the attachment allowlist, a file over the ceiling or a name that is
 * not a plain file name is skipped with a reason rather than offered and then refused, so the picker lists what a
 * person could really pick.
 */
export function readFixtureFiles(root: string): { files: DevFixtureFile[]; skipped: string[] } {
  const directory = join(root, "fixtures", "files");
  const files: DevFixtureFile[] = [];
  const skipped: string[] = [];
  if (!existsSync(directory)) return { files, skipped };
  for (const name of readdirSync(directory).sort()) {
    const full = join(directory, name);
    if (!statSync(full).isFile()) continue;
    const mimeType = EXTENSION_TYPES[extname(name).toLowerCase()];
    if (mimeType === undefined || !ARTIFACT_MIME_ALLOWLIST.includes(mimeType)) {
      skipped.push(`${name}: not a type a node holds`);
      continue;
    }
    if (!artifactNameSchema.safeParse(name).success) {
      skipped.push(`${name}: not a plain file name`);
      continue;
    }
    if (statSync(full).size > DEV_FIXTURE_FILE_LIMITS.maxBytes) {
      skipped.push(`${name}: larger than ${String(DEV_FIXTURE_FILE_LIMITS.maxBytes)} bytes`);
      continue;
    }
    if (files.length >= DEV_FIXTURE_FILE_LIMITS.maxFiles) {
      skipped.push(`${name}: more than ${String(DEV_FIXTURE_FILE_LIMITS.maxFiles)} fixture files`);
      continue;
    }
    files.push({ name, mimeType, bytes: new Uint8Array(readFileSync(full)) });
  }
  return { files, skipped };
}

/** What the dev host did with a file, for the shell's log. Names and sizes only. */
export interface DevArtifactEvent {
  op: "pick" | "create" | "finalize" | "export" | "attach" | "discard";
  name: string;
  sizeBytes: number;
}

interface HeldArtifact {
  ref: ArtifactRef;
  chunks: Uint8Array[];
}

const refuse = (code: string, message: string): FrameArtifactOutcome => ({ status: "refused", code, message });

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const digestOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The dev host's broker.
 *
 * `choosePick` is the shell's picker control: the name of the fixture file the next pick returns, or `""` for a
 * person who closes the picker. Read on every pick, so switching the control changes the next pick.
 */
export function createDevArtifactBroker(input: {
  files: readonly DevFixtureFile[];
  choosePick: () => string;
}): { handle: (request: unknown) => Promise<FrameArtifactOutcome>; events: () => readonly DevArtifactEvent[] } {
  const held = new Map<string, HeldArtifact>();
  const events: DevArtifactEvent[] = [];
  const mint = (): string => `art_dev_${randomBytes(12).toString("hex")}`;
  const record = (op: DevArtifactEvent["op"], ref: ArtifactRef): void => {
    events.push({ op, name: ref.name, sizeBytes: ref.sizeBytes });
    // Bounded: a widget in a loop should not grow the dev host without end.
    if (events.length > 200) events.shift();
  };
  const find = (artifactId: string): HeldArtifact | undefined => held.get(artifactId);
  const missing = (): FrameArtifactOutcome =>
    refuse("ARTIFACT_NOT_FOUND", "that artifact is not held by this dev host (it forgets everything when it stops)");
  /** Bytes this widget holds, against the node's per-widget share, so a widget that never discards is caught here. */
  const heldBytes = (): number => [...held.values()].reduce((sum, artifact) => sum + artifact.ref.sizeBytes, 0);
  const overShare = (adding: number): FrameArtifactOutcome | undefined =>
    heldBytes() + adding > ARTIFACT_LIMITS.instanceQuotaBytes
      ? refuse(
          "ARTIFACT_INSTANCE_QUOTA_EXCEEDED",
          `a widget holds at most ${String(ARTIFACT_LIMITS.instanceQuotaBytes)} bytes of files; discard some with artifacts.discard`,
        )
      : undefined;

  const handle = async (raw: unknown): Promise<FrameArtifactOutcome> => {
    const parsed = artifactRequestSchema.safeParse(raw);
    // The same code a real frame session gives a message that fails the bridge schema.
    if (!parsed.success) return refuse("SCHEMA_INVALID", "the request does not match the artifacts@1 schema");
    const request = parsed.data;
    switch (request.op) {
      case "pick": {
        const chosen = input.choosePick();
        if (chosen === "") return { status: "cancelled", message: "the picker was closed (the dev shell's File picker is set to Cancel)" };
        const file = input.files.find((candidate) => candidate.name === chosen);
        if (file === undefined) return { status: "cancelled", message: `the fixture file ${chosen} is no longer there` };
        if (!artifactAcceptMatches(request.accept, file.mimeType)) {
          return refuse("ARTIFACT_TYPE_NOT_ACCEPTED", `${file.name} is ${file.mimeType}, which the widget did not ask for`);
        }
        const full = overShare(file.bytes.byteLength);
        if (full !== undefined) return full;
        const ref: ArtifactRef = {
          v: 1,
          artifactId: mint(),
          kind: "external",
          mimeType: file.mimeType,
          sizeBytes: file.bytes.byteLength,
          name: file.name,
          digest: digestOf(file.bytes),
        };
        held.set(ref.artifactId, { ref, chunks: [file.bytes] });
        record("pick", ref);
        return { status: "ok", ref };
      }
      case "read": {
        const artifact = find(request.artifactId);
        if (artifact === undefined) return missing();
        const range = checkArtifactRange({ offset: request.offset, length: request.length, sizeBytes: artifact.ref.sizeBytes });
        if (!range.ok) return refuse(range.code, range.message);
        const bytes = concat(artifact.chunks).subarray(range.offset, range.offset + range.length);
        return { status: "ok", ref: artifact.ref, chunkBase64: Buffer.from(bytes).toString("base64"), eof: range.eof };
      }
      case "create": {
        if (!ARTIFACT_MIME_ALLOWLIST.includes(request.mimeType)) {
          return refuse("ARTIFACT_TYPE_UNSUPPORTED", `${request.mimeType} is not a type a widget may create`);
        }
        const name = request.name === undefined || request.name.trim() === "" ? defaultArtifactName(request.mimeType) : request.name;
        if (!artifactNameSchema.safeParse(name).success) {
          return refuse("ARTIFACT_NAME_NOT_ALLOWED", "a name is a file name, not a path or a URL");
        }
        const ref: ArtifactRef = { v: 1, artifactId: mint(), kind: "working", mimeType: request.mimeType, sizeBytes: 0, name };
        held.set(ref.artifactId, { ref, chunks: [] });
        record("create", ref);
        return { status: "ok", ref };
      }
      case "write": {
        const artifact = find(request.artifactId);
        if (artifact === undefined) return missing();
        if (artifact.ref.kind !== "working") return refuse("ARTIFACT_NOT_WRITABLE", "only a working artifact takes writes");
        const chunk = new Uint8Array(Buffer.from(request.chunkBase64, "base64"));
        if (chunk.byteLength > ARTIFACT_LIMITS.chunkBytes) {
          return refuse("ARTIFACT_CHUNK_TOO_LARGE", `one write is at most ${String(ARTIFACT_LIMITS.chunkBytes)} bytes`);
        }
        if (request.offset !== artifact.ref.sizeBytes) {
          return refuse(
            "ARTIFACT_OFFSET_MISMATCH",
            `the artifact holds ${String(artifact.ref.sizeBytes)} bytes, so the next write starts there, not at ${String(request.offset)}`,
          );
        }
        if (artifact.ref.sizeBytes + chunk.byteLength > ARTIFACT_LIMITS.maxBytes) {
          return refuse("ARTIFACT_TOO_LARGE", `an artifact is at most ${String(ARTIFACT_LIMITS.maxBytes)} bytes`);
        }
        const full = overShare(chunk.byteLength);
        if (full !== undefined) return full;
        artifact.chunks.push(chunk);
        artifact.ref = { ...artifact.ref, sizeBytes: artifact.ref.sizeBytes + chunk.byteLength };
        return { status: "ok", ref: artifact.ref };
      }
      case "finalize": {
        const artifact = find(request.artifactId);
        if (artifact === undefined) return missing();
        if (artifact.ref.kind !== "working") return { status: "ok", ref: artifact.ref };
        const bytes = concat(artifact.chunks);
        artifact.chunks = [bytes];
        artifact.ref = { ...artifact.ref, kind: "finalized", digest: digestOf(bytes) };
        record("finalize", artifact.ref);
        return { status: "ok", ref: artifact.ref };
      }
      case "export":
      case "attach": {
        const artifact = find(request.artifactId);
        if (artifact === undefined) return missing();
        if (artifact.ref.kind === "working") {
          return refuse("ARTIFACT_NOT_FINALIZED", `finalize the artifact before ${request.op === "export" ? "saving" : "attaching"} it`);
        }
        const recorded = request.op === "export" ? { ...artifact.ref, name: request.suggestedName } : artifact.ref;
        record(request.op, recorded);
        return { status: "ok", ref: artifact.ref };
      }
      case "discard": {
        const artifact = find(request.artifactId);
        if (artifact === undefined) return missing();
        // As the node: a file the person chose is theirs, and only a file the widget made can be given back.
        if (artifact.ref.kind === "external") {
          return refuse("ARTIFACT_NOT_CREATOR", "a file the person chose is theirs; a widget cannot discard it");
        }
        held.delete(request.artifactId);
        record("discard", artifact.ref);
        return { status: "ok" };
      }
    }
  };

  return { handle, events: () => events };
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { fixtureClip } from "../service/wav.mjs";

/**
 * The render service over its real transport: the process the container runs, spoken to over standard streams by a
 * stand-in host that answers `clarkcant/artifacts.read` from bytes it holds, the way the node streams a granted file.
 * The node's own checks (grant, profile cap, results) are tested in the runtime; this is what the service does with
 * what it is offered and sent.
 */

const SERVER = fileURLToPath(new URL("../service/server.mjs", import.meta.url));
const CHUNK = 262_144;

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Offer {
  version: 1;
  methods: string[];
  chunkBytes: number;
  maxInputBytes: number;
  maxMediaSeconds: number;
  maxResultBytes: number;
}

const OFFER: Offer = {
  version: 1,
  methods: ["clarkcant/artifacts.read"],
  chunkBytes: CHUNK,
  maxInputBytes: 25 * 1024 * 1024,
  maxMediaSeconds: 3600,
  maxResultBytes: 3 * 1024 * 1024,
};

const running: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

/** Start the service and a host that serves `files` by artifact id, recording every read and every message. */
function host(files: Record<string, Uint8Array>, options: { refuseReads?: string } = {}) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  running.push(child);
  const messages: Message[] = [];
  const reads: { artifactId: string; offset: number; length: number }[] = [];
  const waiters: { test: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  let buffer = "";
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const message = JSON.parse(buffer.slice(0, index)) as Message;
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      messages.push(message);
      if (message.method === "clarkcant/artifacts.read" && message.id !== undefined) {
        const params = message.params as { artifactId: string; offset: number; length: number };
        reads.push(params);
        const file = files[params.artifactId];
        if (options.refuseReads !== undefined || file === undefined) {
          send({ id: message.id, error: { code: -32021, message: options.refuseReads ?? "not an input of this call" } });
        } else {
          const bytes = file.subarray(params.offset, params.offset + params.length);
          send({
            id: message.id,
            result: {
              artifactId: params.artifactId,
              offset: params.offset,
              bytes: Buffer.from(bytes).toString("base64"),
              eof: params.offset + bytes.byteLength >= file.byteLength,
              sizeBytes: file.byteLength,
              mimeType: "audio/wav",
            },
          });
        }
      }
      for (const waiter of waiters.splice(0)) {
        if (waiter.test(message)) waiter.resolve(message);
        else waiters.push(waiter);
      }
    }
  });
  const next = (test: (message: Message) => boolean): Promise<Message> => {
    const seen = messages.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve) => waiters.push({ test, resolve }));
  };
  const initialize = async (offer: Offer | undefined) => {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: offer === undefined ? {} : { experimental: { "clarkcant/artifacts": offer } } } });
    await next((message) => message.id === 1);
  };
  const call = (id: number, args: Record<string, unknown>) => {
    send({ id, method: "tools/call", params: { name: "render_audio", arguments: args, _meta: { progressToken: id } } });
    return next((message) => message.id === id && message.method === undefined);
  };
  return { child, messages, reads, send, next, initialize, call };
}

function textOf(result: Record<string, unknown> | undefined): string {
  const content = (result?.content ?? []) as { type: string; text?: string }[];
  return content.find((part) => part.type === "text")?.text ?? "";
}

function fileOf(result: Record<string, unknown> | undefined): Uint8Array {
  const content = (result?.content ?? []) as { type: string; resource?: { blob: string; mimeType: string } }[];
  const resource = content.find((part) => part.type === "resource")?.resource;
  if (resource === undefined) throw new Error("no file in the answer");
  expect(resource.mimeType).toBe("audio/wav");
  return new Uint8Array(Buffer.from(resource.blob, "base64"));
}

describe("the render service", () => {
  it("lists one tool that names the file by artifact id and takes only gain, trims and pace", async () => {
    const service = host({});
    await service.initialize(OFFER);
    service.send({ id: 2, method: "tools/list" });
    const listed = await service.next((message) => message.id === 2);
    const tools = (listed.result?.tools ?? []) as { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[];
    expect(tools.map((tool) => tool.name)).toEqual(["render_audio"]);
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {}).sort()).toEqual(["gainDb", "paceMs", "source", "trimEndMs", "trimStartMs"]);
    expect(tools[0]?.inputSchema.required).toEqual(["source", "gainDb"]);
  });

  it("reads a clip larger than one chunk in bounded ranges, reports rising progress, and returns the rendered file", async () => {
    const clip = fixtureClip({ seconds: 24 });
    const service = host({ art_clip: clip });
    await service.initialize(OFFER);
    const answer = await service.call(7, { source: "art_clip", gainDb: -6, trimStartMs: 500, trimEndMs: 500 });
    expect(answer.result?.isError).toBeUndefined();
    expect(textOf(answer.result)).toBe("Rendered 23.0 s at -6 dB (1 channel, 22050 Hz).");
    const output = fileOf(answer.result);
    expect(output.byteLength).toBe(44 + 23 * 22_050 * 2);

    // Every read asked for at most one chunk, of the one file this call was given.
    expect(service.reads.length).toBeGreaterThan(2);
    expect(service.reads.every((read) => read.artifactId === "art_clip" && read.length <= CHUNK)).toBe(true);

    const progress = service.messages
      .filter((message) => message.method === "notifications/progress")
      .map((message) => message.params as { progressToken: number; progress: number; total: number; message: string });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every((step) => step.progressToken === 7 && step.total === 23 * 22_050 * 2)).toBe(true);
    expect(progress.map((step) => step.progress)).toEqual([...progress.map((step) => step.progress)].sort((a, b) => a - b));
    expect(progress.at(-1)?.progress).toBe(progress.at(-1)?.total);
    expect(progress.at(-1)?.message).toBe("Rendered 991 KiB of 991 KiB");
  });

  it("returns the same bytes for the same clip and parameters, so the digest is the render's", async () => {
    const clip = fixtureClip({ seconds: 2 });
    const digests: string[] = [];
    for (const id of [3, 4]) {
      const service = host({ art_clip: clip });
      await service.initialize(OFFER);
      const answer = await service.call(id, { source: "art_clip", gainDb: -6, trimStartMs: 250, trimEndMs: 250 });
      digests.push(`sha256:${createHash("sha256").update(fileOf(answer.result)).digest("hex")}`);
    }
    // The same digest the transform's own test pins, reached through the process and the chunked reads.
    expect(digests).toEqual([
      "sha256:ab48b6a572cb2314cc133629b3eb353dc4e3bb070ca1cbad1d47c9b29f3f9262",
      "sha256:ab48b6a572cb2314cc133629b3eb353dc4e3bb070ca1cbad1d47c9b29f3f9262",
    ]);
  });

  it("stops mid-render when the host cancels, and answers nothing, so no partial file is sent", async () => {
    const clip = fixtureClip({ seconds: 24 });
    const service = host({ art_clip: clip });
    await service.initialize(OFFER);
    void service.call(9, { source: "art_clip", gainDb: 0, paceMs: 150 });
    await service.next((message) => message.method === "notifications/progress");
    service.send({ method: "notifications/cancelled", params: { requestId: 9, reason: "the person stopped it" } });
    const readsAtCancel = service.reads.length;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(service.messages.some((message) => message.id === 9 && message.method === undefined)).toBe(false);
    // At most the read already in flight finishes; nothing is read after the cancel is heard.
    expect(service.reads.length).toBeLessThanOrEqual(readsAtCancel + 1);
    const progress = service.messages.filter((message) => message.method === "notifications/progress");
    expect((progress.at(-1)?.params as { progress: number; total: number }).progress).toBeLessThan(clip.byteLength - 44);

    // The service is still there for the next call.
    const answer = await service.call(10, { source: "art_clip", gainDb: 0, trimEndMs: 23_000 });
    expect(textOf(answer.result)).toBe("Rendered 1.0 s at 0 dB (1 channel, 22050 Hz).");
  });

  it("refuses a clip longer than the profile's media cap before rendering any of it", async () => {
    const clip = fixtureClip({ seconds: 24 });
    const service = host({ art_clip: clip });
    await service.initialize({ ...OFFER, maxMediaSeconds: 10 });
    const answer = await service.call(5, { source: "art_clip", gainDb: 0 });
    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer.result)).toBe("The clip is 24.0 s long, over the 10.0 s this package's resource profile allows. Nothing was rendered.");
    // Only the header was read.
    expect(service.reads).toEqual([{ version: 1, artifactId: "art_clip", offset: 0, length: 4096 }]);
    expect(service.messages.some((message) => message.method === "notifications/progress")).toBe(false);
  });

  it("refuses a render larger than one result may carry", async () => {
    const service = host({ art_clip: fixtureClip({ seconds: 24 }) });
    await service.initialize({ ...OFFER, maxResultBytes: 512 * 1024 });
    const answer = await service.call(6, { source: "art_clip", gainDb: 0 });
    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer.result)).toBe("The render would be 1034 KiB, over the 512 KiB one result may carry. Trim the clip and try again.");
  });

  it("says what failed when the host refuses a read or offers nothing, and renders nothing", async () => {
    const refused = host({ art_clip: fixtureClip({ seconds: 2 }) }, { refuseReads: "the grant on this file was revoked" });
    await refused.initialize(OFFER);
    const answer = await refused.call(2, { source: "art_clip", gainDb: 0 });
    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer.result)).toBe("The host stopped reading the clip: the grant on this file was revoked");

    const bare = host({ art_clip: fixtureClip({ seconds: 2 }) });
    await bare.initialize(undefined);
    const nothing = await bare.call(2, { source: "art_clip", gainDb: 0 });
    expect(textOf(nothing.result)).toBe("This host does not stream files to services, so there is nothing to render.");
    expect(bare.reads).toEqual([]);
  });

  it("refuses a file that is not 16-bit PCM WAV with the reason", async () => {
    const clip = fixtureClip({ seconds: 2 });
    new DataView(clip.buffer).setUint16(20, 3, true);
    const service = host({ art_clip: clip });
    await service.initialize(OFFER);
    const answer = await service.call(2, { source: "art_clip", gainDb: 0 });
    expect(textOf(answer.result)).toBe("The clip cannot be rendered: only uncompressed 16-bit PCM WAV can be rendered.");
  });
});

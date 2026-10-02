import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEDIA_CONTENT_LIMITS, type MediaPolicy } from "@clarkcant/contracts";

import { audioDurationSeconds, sniffAudio } from "../src/audio-content.ts";
import { checkAudioBytes, fetchAudio, privateAddress } from "../src/media-fetch.ts";
import { selfSignedCertificate, toneWav } from "../src/test-support/media-fixtures.ts";

/**
 * The media content policy's fetch and content checks, against a real https origin on loopback.
 *
 * The origin is this test's own server with a certificate made for the run and trusted only by the fetches here, so
 * what is checked is the node's real request path — TLS, redirects, a bounded read — rather than a stand-in for it.
 */

/** Synthetic containers: just the header bytes each format keeps its length in. */
function oggOpus(seconds: number): Uint8Array {
  const preSkip = 312;
  const page = (granule: bigint, payload: number[]): number[] => {
    const head = Buffer.alloc(27);
    head.write("OggS", 0, "latin1");
    head.writeBigUInt64LE(granule, 6);
    head[26] = 1;
    return [...head, payload.length, ...payload];
  };
  const opusHead = Buffer.alloc(19);
  opusHead.write("OpusHead", 0, "latin1");
  opusHead[8] = 1;
  opusHead[9] = 2;
  opusHead.writeUInt16LE(preSkip, 10);
  opusHead.writeUInt32LE(48_000, 12);
  return new Uint8Array([...page(0n, [...opusHead]), ...page(BigInt(Math.round(seconds * 48_000) + preSkip), [0, 0, 0])]);
}

function webm(durationMs: number): Uint8Array {
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(durationMs);
  const info = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x44, 0x89, 0x88, ...duration];
  return new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from("webm", "latin1"),
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x80 | info.length, ...info,
  ]);
}

/** MPEG-1 layer III at 128 kbit/s and 44.1 kHz, with an optional Xing frame count and ID3 tag. */
function mp3(options: { bytes: number; xingFrames?: number; id3?: boolean }): Uint8Array {
  const frame = Buffer.alloc(options.bytes);
  frame.set([0xff, 0xfb, 0x90, 0x64], 0);
  if (options.xingFrames !== undefined) {
    frame.write("Xing", 36, "latin1");
    frame.writeUInt32BE(1, 40);
    frame.writeUInt32BE(options.xingFrames, 44);
  }
  if (options.id3 !== true) return new Uint8Array(frame);
  return new Uint8Array([...Buffer.from("ID3", "latin1"), 3, 0, 0, 0, 0, 0, 10, ...Buffer.alloc(10), ...frame]);
}

describe("reading what an audio file is from its bytes", () => {
  it("knows each type the policy allows, and how long each plays", () => {
    const wav = toneWav({ seconds: 1.5 });
    expect(sniffAudio(wav)).toBe("audio/wav");
    expect(audioDurationSeconds(wav, "audio/wav")).toBeCloseTo(1.5, 3);

    const ogg = oggOpus(2);
    expect(sniffAudio(ogg)).toBe("audio/ogg");
    expect(audioDurationSeconds(ogg, "audio/ogg")).toBeCloseTo(2, 3);

    const recorded = webm(2_500);
    expect(sniffAudio(recorded)).toBe("audio/webm");
    expect(audioDurationSeconds(recorded, "audio/webm")).toBeCloseTo(2.5, 3);

    const constant = mp3({ bytes: 16_000 });
    expect(sniffAudio(constant)).toBe("audio/mpeg");
    expect(audioDurationSeconds(constant, "audio/mpeg")).toBeCloseTo(1, 3);

    const variable = mp3({ bytes: 4_000, xingFrames: 100, id3: true });
    expect(sniffAudio(variable)).toBe("audio/mpeg");
    expect(audioDurationSeconds(variable, "audio/mpeg")).toBeCloseTo((100 * 1152) / 44_100, 3);
  });

  it("refuses bytes that are not audio, or not the type they were declared as", () => {
    expect(sniffAudio(new TextEncoder().encode("<html><script>alert(1)</script></html>"))).toBeUndefined();
    expect(checkAudioBytes(new TextEncoder().encode("<html></html>"), "audio/mpeg", "node")).toMatchObject({ ok: false, rule: "type-mismatch" });
    expect(checkAudioBytes(toneWav({ seconds: 1 }), "audio/mpeg", "node")).toMatchObject({ ok: false, rule: "type-mismatch" });
  });

  it("refuses a file whose length it cannot read, or one over the ceiling", () => {
    // A recorded WebM that never wrote its duration.
    const unknown = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...Buffer.from("webm", "latin1"), 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x43, 0xb6, 0x75, 0x80]);
    expect(checkAudioBytes(unknown, "audio/webm", "node")).toMatchObject({ ok: false, rule: "duration-unknown" });
    // Two bytes a second for 4,000 seconds.
    const long = toneWav({ seconds: 4_000, sampleRate: 1 });
    expect(checkAudioBytes(long, "audio/wav", "node")).toMatchObject({ ok: false, rule: "too-long" });
    expect(checkAudioBytes(toneWav({ seconds: 2 }), "audio/wav", "node")).toMatchObject({ ok: true, mimeType: "audio/wav" });
  });
});

describe("fetching audio under the media policy", () => {
  const tls = selfSignedCertificate();
  const seen: IncomingHttpHeaders[] = [];
  let server: Server;
  let origin: string;
  let policy: MediaPolicy;
  const tone = Buffer.from(toneWav({ seconds: 1 }));

  const routes: Record<string, (response: ServerResponse) => void> = {
    "/tone.wav": (response) => response.writeHead(200, { "content-type": "audio/wav", "set-cookie": "session=1" }).end(tone),
    "/hop": (response) => response.writeHead(302, { location: "/tone.wav" }).end(),
    "/away": (response) => response.writeHead(302, { location: "https://localhost:1/tone.wav" }).end(),
    "/plain": (response) => response.writeHead(302, { location: "http://127.0.0.1:1/tone.wav" }).end(),
    "/loop": (response) => response.writeHead(302, { location: "/loop" }).end(),
    "/page.html": (response) => response.writeHead(200, { "content-type": "text/html" }).end("<script>alert(1)</script>"),
    "/mislabeled.mp3": (response) => response.writeHead(200, { "content-type": "audio/mpeg" }).end(tone),
    "/claims-large.wav": (response) => {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(MEDIA_CONTENT_LIMITS.maxAudioBytes + 1) });
      response.write(tone.subarray(0, 64));
    },
    "/streams-large.wav": (response) => {
      response.writeHead(200, { "content-type": "audio/wav" });
      const chunk = Buffer.alloc(1024 * 1024);
      for (let sent = 0; sent <= MEDIA_CONTENT_LIMITS.maxAudioBytes; sent += chunk.byteLength) response.write(chunk);
      response.end();
    },
    "/gone.wav": (response) => response.writeHead(404).end(),
    "/slow.wav": () => undefined,
    // Headers and the start of the body arrive, then nothing more.
    "/stalls.wav": (response) => {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(tone.byteLength) });
      response.write(tone.subarray(0, 64));
    },
    // The connection drops partway through the body.
    "/cut.wav": (response) => {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": String(tone.byteLength) });
      response.write(tone.subarray(0, 64), () => response.socket?.destroy());
    },
  };

  beforeAll(async () => {
    server = createServer({ cert: tls.cert, key: tls.key }, (request, response) => {
      seen.push(request.headers);
      (routes[request.url ?? ""] ?? ((answer: ServerResponse) => answer.writeHead(404).end()))(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    policy = { origins: [origin] };
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const fetchFrom = (path: string, extra: { timeoutMs?: number } = {}) => fetchAudio(`${origin}${path}`, { policy, ca: tls.cert, ...extra });

  it("fetches allowed audio, following a redirect within the origin, and sends nothing that identifies anyone", async () => {
    seen.length = 0;
    const fetched = await fetchFrom("/hop");
    expect(fetched).toMatchObject({ ok: true, mimeType: "audio/wav", origin });
    expect(fetched.ok && fetched.durationSeconds).toBeCloseTo(1, 3);
    expect(fetched.ok && Buffer.from(fetched.bytes).equals(tone)).toBe(true);
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
      expect(headers["accept-encoding"]).toBe("identity");
    }
  });

  it("refuses before connecting when the URL breaks the policy", async () => {
    expect(await fetchAudio(`${origin.replace("https:", "http:")}/tone.wav`, { policy, ca: tls.cert })).toMatchObject({ ok: false, rule: "https-only" });
    expect(await fetchAudio(origin.replace("https://", "https://user:secret@") + "/tone.wav", { policy, ca: tls.cert })).toMatchObject({
      ok: false,
      rule: "credentials-in-url",
    });
    expect(await fetchAudio(`${origin}/tone.wav`, { policy: { origins: [] }, ca: tls.cert })).toMatchObject({ ok: false, rule: "origin-not-allowed" });
  });

  it("refuses a name that resolves to a loopback or private address the policy did not name", async () => {
    const port = new URL(origin).port;
    const named = `https://media.test:${port}`;
    const resolved: string[] = [];
    const refused = await fetchAudio(`${named}/tone.wav`, {
      policy: { origins: [named] },
      ca: tls.cert,
      lookup: (hostname, callback) => {
        resolved.push(hostname);
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    });
    expect(resolved).toEqual(["media.test"]);
    expect(refused).toMatchObject({ ok: false, rule: "private-address" });
    for (const address of ["10.1.2.3", "192.168.0.4", "169.254.169.254", "::1", "fd00::1"]) {
      const result = await fetchAudio(`${named}/tone.wav`, {
        policy: { origins: [named] },
        ca: tls.cert,
        lookup: (_hostname, callback) => callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]),
      });
      expect(result, address).toMatchObject({ ok: false, rule: "private-address" });
    }
  });

  it("follows a redirect only within the allowed origin, and only so many times", async () => {
    expect(await fetchFrom("/away")).toMatchObject({ ok: false, rule: "redirect-off-origin" });
    expect(await fetchFrom("/plain")).toMatchObject({ ok: false, rule: "https-only" });
    expect(await fetchFrom("/loop")).toMatchObject({ ok: false, rule: "too-many-redirects" });
  });

  it("refuses a type that is not allowed audio, or bytes that are not the declared type", async () => {
    expect(await fetchFrom("/page.html")).toMatchObject({ ok: false, rule: "type-not-allowed" });
    expect(await fetchFrom("/mislabeled.mp3")).toMatchObject({ ok: false, rule: "type-mismatch" });
  });

  it("refuses an oversized file from its declared length, or as soon as the body crosses the ceiling", async () => {
    expect(await fetchFrom("/claims-large.wav")).toMatchObject({ ok: false, rule: "too-large" });
    expect(await fetchFrom("/streams-large.wav")).toMatchObject({ ok: false, rule: "too-large" });
  });

  it("names a missing file and a fetch that ran out of time", async () => {
    expect(await fetchFrom("/gone.wav")).toMatchObject({ ok: false, rule: "not-found" });
    expect(await fetchFrom("/slow.wav", { timeoutMs: 300 })).toMatchObject({ ok: false, rule: "timeout" });
  });

  it("settles a fetch whose body stalls or is cut short, and says why in fixed words", async () => {
    expect(await fetchFrom("/stalls.wav", { timeoutMs: 400 })).toMatchObject({ ok: false, rule: "timeout" });
    const cut = await fetchFrom("/cut.wav");
    expect(cut).toMatchObject({ ok: false, rule: "fetch-failed" });
    expect(!cut.ok && cut.message).toMatch(/could not be reached: (the connection was cut|the connection closed|the connection failed)/);
    // A stopped turn ends the read too.
    const stop = new AbortController();
    const pending = fetchAudio(`${origin}/stalls.wav`, { policy, ca: tls.cert, timeoutMs: 10_000 }, stop.signal);
    setTimeout(() => stop.abort(), 150);
    expect(await pending).toMatchObject({ ok: false, rule: "fetch-failed" });
  });

  it("refuses the other address ranges no public media origin uses", () => {
    for (const address of ["100.64.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "fec0::1", "ff02::1", "::ffff:100.64.0.1"]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "2606:2800:220:1::1"]) expect(privateAddress(address), address).toBe(false);
  });
});

describe("reading malformed audio headers", () => {
  it("reports a header that points past its own bytes as an unknown length, never as a crash", () => {
    const wav = toneWav({ seconds: 1 });
    // A fmt chunk cut before its byte rate.
    const shortFmt = wav.slice(0, 30);
    expect(() => checkAudioBytes(shortFmt, "audio/wav", "node")).not.toThrow();
    expect(checkAudioBytes(shortFmt, "audio/wav", "node")).toMatchObject({ ok: false, rule: "duration-unknown" });
    // Each container cut at every length through its header.
    const samples: [Uint8Array, "audio/wav" | "audio/ogg" | "audio/webm" | "audio/mpeg"][] = [
      [wav, "audio/wav"],
      [oggOpus(2), "audio/ogg"],
      [webm(2_000), "audio/webm"],
      [mp3({ bytes: 4_000, xingFrames: 40 }), "audio/mpeg"],
    ];
    for (const [bytes, mime] of samples) {
      for (let length = 0; length <= Math.min(bytes.byteLength, 160); length += 1) {
        const cut = bytes.slice(0, length);
        expect(() => audioDurationSeconds(cut, mime), `${mime} cut at ${String(length)}`).not.toThrow();
        expect(() => checkAudioBytes(cut, mime, "node"), `${mime} cut at ${String(length)}`).not.toThrow();
      }
    }
  });
});

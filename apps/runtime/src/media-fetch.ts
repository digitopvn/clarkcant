import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";

import {
  type AudioMimeType,
  type MediaPolicy,
  type MediaRefusal,
  MEDIA_CONTENT_LIMITS,
  checkMediaUrl,
  hostNamesAddress,
  mediaRefusal,
  normalizeAudioType,
} from "@clarkcant/contracts";

import { audioDurationSeconds, sniffAudio } from "./audio-content.ts";
import { isPrivateNetworkHost } from "./service-egress.ts";

/**
 * Fetch one audio file for the media content policy.
 *
 * The node fetches; the page never does. Each step is a rule a refusal can name:
 *
 * - **Where.** https only, no credentials in the URL, and an origin the policy allows (`checkMediaUrl`). A redirect is
 *   followed only to the same origin, at most `maxRedirects` times, and is checked again before it is followed.
 * - **Which address.** A name is resolved here and refused when any address it resolves to is loopback, private or
 *   link-local, so a public name that points inside the network cannot reach it. The check runs at connection time, on
 *   the address actually dialled, so a name that changes its answer between a check and the request cannot slip past.
 *   An origin the policy writes as an address (`https://127.0.0.1:8443`) names that address itself and is allowed.
 * - **What is sent.** No cookie, no authorization, no referrer: a plain GET with an identity encoding.
 * - **How much.** A declared length over the ceiling is refused before the body is read, and the body is counted as it
 *   arrives and abandoned the moment it crosses the ceiling. The whole fetch has a deadline.
 * - **What it is.** The declared type must be an audio type the node plays and must match what the bytes are; the
 *   duration is read from the container and held to the ceiling.
 */

export interface MediaFetchDeps {
  policy: MediaPolicy;
  /** Name resolution, replaced in tests so a name can be made to resolve to loopback. */
  lookup?: (hostname: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void;
  /** Extra trusted certificates, for a test's own https origin. Production relies on the platform's store. */
  ca?: string;
  timeoutMs?: number;
}

export interface FetchedAudio {
  ok: true;
  bytes: Uint8Array;
  mimeType: AudioMimeType;
  durationSeconds: number;
  origin: string;
}

class PolicyError extends Error {
  readonly refusal: MediaRefusal;
  constructor(refusal: MediaRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

function privateAddress(address: string): boolean {
  return isPrivateNetworkHost(new URL(`https://${isIP(address) === 6 ? `[${address}]` : address}`));
}

/**
 * A lookup that refuses private addresses for a name the policy did not write as an address.
 *
 * Node asks for one address or for all of them depending on how the socket connects, and both shapes are answered.
 */
function guardedLookup(deps: MediaFetchDeps): LookupFunction {
  const resolve =
    deps.lookup ??
    ((hostname: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) =>
      dnsLookup(hostname, { all: true }, (error, addresses) => callback(error, addresses)));
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, (error, addresses) => {
      if (error !== null) return callback(error);
      if (addresses.length === 0) return callback(new Error(`${hostname} did not resolve`));
      const inside = addresses.find((entry) => privateAddress(entry.address));
      if (inside !== undefined && !hostNamesAddress(hostname)) {
        const refused = new PolicyError(
          mediaRefusal("private-address", `${hostname} resolves to ${inside.address}, a loopback, private or link-local address, which the policy does not name`),
        );
        return callback(refused);
      }
      if (options.all === true) return callback(null, addresses);
      const first = addresses[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  }) as unknown as LookupFunction;
}

function get(url: URL, deps: MediaFetchDeps, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        // Nothing that identifies the person or the node: no cookie, no authorization, no referrer.
        headers: { accept: "audio/*", "accept-encoding": "identity", "user-agent": "ClarkCant-media/1" },
        lookup: guardedLookup(deps),
        signal,
        // A fresh connection per fetch, so one fetch's connection is never reused under another fetch's checks.
        agent: false,
        ...(deps.ca === undefined ? {} : { ca: deps.ca }),
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}

function readBounded(response: IncomingMessage, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MEDIA_CONTENT_LIMITS.maxAudioBytes) {
        response.destroy();
        reject(new PolicyError(mediaRefusal("too-large", `the audio is over the ${String(MEDIA_CONTENT_LIMITS.maxAudioBytes)} byte ceiling`)));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    response.on("error", reject);
    signal.addEventListener("abort", () => response.destroy(), { once: true });
  });
}

export async function fetchAudio(
  raw: string,
  deps: MediaFetchDeps,
  signal?: AbortSignal,
): Promise<FetchedAudio | MediaRefusal> {
  const checked = checkMediaUrl(raw, deps.policy);
  if (!checked.ok) return checked;
  const origin = checked.url.origin;
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? MEDIA_CONTENT_LIMITS.fetchTimeoutMs);
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);

  try {
    let url = checked.url;
    let response: IncomingMessage | undefined;
    for (let redirects = 0; ; redirects += 1) {
      response = await get(url, deps, combined);
      const status = response.statusCode ?? 0;
      if (status < 300 || status >= 400 || status === 304) break;
      response.resume();
      const location = response.headers.location;
      if (location === undefined) return mediaRefusal("fetch-failed", `${origin} answered ${String(status)} without saying where to`);
      if (redirects >= MEDIA_CONTENT_LIMITS.maxRedirects) {
        return mediaRefusal("too-many-redirects", `${origin} redirected more than ${String(MEDIA_CONTENT_LIMITS.maxRedirects)} times`);
      }
      const next = new URL(location, url);
      if (next.protocol !== "https:") return mediaRefusal("https-only", `${origin} redirected to ${next.protocol.replace(/:$/, "")}`);
      if (next.username !== "" || next.password !== "") return mediaRefusal("credentials-in-url", `${origin} redirected to a URL carrying credentials`);
      if (next.origin !== origin) return mediaRefusal("redirect-off-origin", `${origin} redirected to ${next.origin}, and a redirect may only stay within the allowed origin`);
      url = next;
    }
    const status = response.statusCode ?? 0;
    if (status === 404 || status === 410) {
      response.resume();
      return mediaRefusal("not-found", `${origin} has no file at that address (${String(status)})`);
    }
    if (status !== 200) {
      response.resume();
      return mediaRefusal("fetch-failed", `${origin} answered ${String(status)}`);
    }
    const declaredHeader = response.headers["content-type"];
    const declared = normalizeAudioType(declaredHeader);
    if (declared === undefined) {
      response.resume();
      return mediaRefusal("type-not-allowed", `${origin} sent ${declaredHeader ?? "no content type"}, which is not an audio type this node plays (mp3, ogg, wav or webm)`);
    }
    const encoding = response.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "identity") {
      response.resume();
      return mediaRefusal("type-mismatch", `${origin} sent the audio ${encoding}-encoded, which this node does not unpack`);
    }
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MEDIA_CONTENT_LIMITS.maxAudioBytes) {
      response.destroy();
      return mediaRefusal("too-large", `the audio is ${String(declaredLength)} bytes, over the ${String(MEDIA_CONTENT_LIMITS.maxAudioBytes)} byte ceiling`);
    }
    const bytes = await readBounded(response, combined);
    return checkAudioBytes(bytes, declared, origin);
  } catch (error) {
    if (error instanceof PolicyError) return error.refusal;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof PolicyError) return cause.refusal;
    if (deadline.aborted) return mediaRefusal("timeout", `${origin} did not send the audio within ${String(Math.round((deps.timeoutMs ?? MEDIA_CONTENT_LIMITS.fetchTimeoutMs) / 1000))} seconds`);
    if (signal?.aborted === true) return mediaRefusal("fetch-failed", "the fetch was stopped");
    return mediaRefusal("fetch-failed", `${origin} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Hold bytes to the content rules: a type the bytes really are, the one that was declared, and a length the container
 * states and the ceiling allows. Shared by a fetched file and a file already on the node.
 */
export function checkAudioBytes(
  bytes: Uint8Array,
  declared: AudioMimeType,
  origin: string,
): FetchedAudio | MediaRefusal {
  if (bytes.byteLength > MEDIA_CONTENT_LIMITS.maxAudioBytes) {
    return mediaRefusal("too-large", `the audio is over the ${String(MEDIA_CONTENT_LIMITS.maxAudioBytes)} byte ceiling`);
  }
  const sniffed = sniffAudio(bytes);
  if (sniffed === undefined) return mediaRefusal("type-mismatch", `the bytes are not ${declared} or any audio type this node plays`);
  if (sniffed !== declared) return mediaRefusal("type-mismatch", `the bytes are ${sniffed} but were declared as ${declared}`);
  const durationSeconds = audioDurationSeconds(bytes, sniffed);
  if (durationSeconds === undefined) return mediaRefusal("duration-unknown", `the ${sniffed} file does not state how long it plays, so its length cannot be held to the ceiling`);
  if (durationSeconds > MEDIA_CONTENT_LIMITS.maxAudioSeconds) {
    return mediaRefusal("too-long", `the audio plays for ${String(Math.round(durationSeconds))} seconds, over the ${String(MEDIA_CONTENT_LIMITS.maxAudioSeconds)} second ceiling`);
  }
  return { ok: true, bytes, mimeType: sniffed, durationSeconds, origin };
}

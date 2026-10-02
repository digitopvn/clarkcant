import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { renderImage } from "../service/png.mjs";

/**
 * A fake image provider, for the image generator's tests and browser journeys.
 *
 * It behaves like the small slice of a real provider the service uses: a request starts an image, each status read
 * reports one more finished step, and a finished image is a PNG. It is not a mock of the service: the service talks to
 * it only through the node's egress broker, so what it sees is what the node sent.
 *
 * It checks the credential the node adds. A request without `Authorization: Bearer <key>` is answered 401, so a test
 * that reaches a finished image has also shown the key was added on the node, never by the service or the widget.
 * Starting an image is a POST with the prompt in a JSON body, as a real provider's API takes it; status and image are
 * GET. A POST is something the node sends only for a capability declared `external-write`, and a prompt in the URL is
 * refused here, so a service that put it there is caught.
 */

export interface FakeProviderRequest {
  method: string;
  path: string;
  /** Whether the request carried the expected credential. The header itself is not kept. */
  authorized: boolean;
}

export interface FakeProvider {
  origin: string;
  port: number;
  requests: FakeProviderRequest[];
  /** Stop every image at this many finished steps until `release`, so a test can act while a job runs. */
  holdAt(step: number): void;
  release(): void;
  /**
   * The next image started fails when it reaches this step. With `echoKey`, the reason also repeats the key the
   * request carried, as it was sent and JSON-escaped, the way a careless provider's error might.
   */
  failNext(atStep: number, reason?: string, options?: { echoKey?: boolean }): void;
  close(): Promise<void>;
}

export const FAKE_PROVIDER_STEPS = 4;

interface Image {
  prompt: string;
  done: number;
  failAt?: number;
  reason?: string;
}

export async function startFakeProvider(input: { key: string; port?: number; host?: string }): Promise<FakeProvider> {
  const images = new Map<string, Image>();
  const requests: FakeProviderRequest[] = [];
  let held: number | undefined;
  let failing: { atStep: number; reason: string; echoKey: boolean } | undefined;
  let next = 0;

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.length) });
    response.end(bytes);
  };

  const start = (request: IncomingMessage, response: ServerResponse, url: URL, body: Buffer): void => {
    if (url.search !== "") return send(response, 400, { error: "the prompt goes in the body, not the URL" });
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "a JSON body is required" });
    let prompt = "";
    try {
      const parsed = JSON.parse(body.toString("utf8")) as { prompt?: unknown };
      prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
    } catch {
      return send(response, 400, { error: "the body is not JSON" });
    }
    if (prompt.trim() === "") return send(response, 400, { error: "a prompt is required" });
    next += 1;
    const id = `img_${String(next)}`;
    const sent = request.headers.authorization ?? "";
    // Echoed as it was sent, inside a JSON answer, so the bytes on the wire carry it JSON-escaped.
    images.set(id, {
      prompt,
      done: 0,
      ...(failing === undefined
        ? {}
        : { failAt: failing.atStep, reason: failing.echoKey ? `${failing.reason} (request signed with ${sent})` : failing.reason }),
    });
    failing = undefined;
    return send(response, 200, { id });
  };

  const handle = (request: IncomingMessage, response: ServerResponse, body: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    const authorized = request.headers.authorization === `Bearer ${input.key}`;
    requests.push({ method: request.method ?? "", path: url.pathname, authorized });
    const starting = url.pathname === "/v1/images/generate";
    if (request.method !== (starting ? "POST" : "GET")) return send(response, 405, { error: starting ? "only POST starts an image" : "only GET is served" });
    if (!authorized) return send(response, 401, { error: "a valid key is required" });
    if (starting) return start(request, response, url, body);
    const match = /^\/v1\/images\/([A-Za-z0-9_]+)(\/image)?$/.exec(url.pathname);
    const image = match === null ? undefined : images.get(match[1] ?? "");
    if (match === null || image === undefined) return send(response, 404, { error: "no such image" });
    if (match[2] === "/image") {
      if (image.done < FAKE_PROVIDER_STEPS || image.failAt !== undefined) return send(response, 409, { error: "the image is not finished" });
      const png = renderImage(image.prompt);
      response.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
      response.end(png);
      return;
    }
    // One read, one more finished step: the progress a test sees is exactly the reads the service made.
    const ceiling = held ?? FAKE_PROVIDER_STEPS;
    if (image.done < Math.min(ceiling, FAKE_PROVIDER_STEPS)) image.done += 1;
    if (image.failAt !== undefined && image.done >= image.failAt) {
      return send(response, 200, { status: "failed", done: image.done, total: FAKE_PROVIDER_STEPS, error: image.reason });
    }
    const status = image.done >= FAKE_PROVIDER_STEPS ? "succeeded" : "running";
    return send(response, 200, { status, done: image.done, total: FAKE_PROVIDER_STEPS });
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handle(request, response, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, input.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    holdAt: (step) => {
      held = step;
    },
    release: () => {
      held = undefined;
    },
    failNext: (atStep, reason = "the provider ran out of ink", options = {}) => {
      failing = { atStep, reason, echoKey: options.echoKey === true };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

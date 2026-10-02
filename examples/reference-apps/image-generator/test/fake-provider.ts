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
 * Only GET is served, the method a `read` capability's egress may use.
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
  /** The next image started fails when it reaches this step. */
  failNext(atStep: number, reason?: string): void;
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
  let failing: { atStep: number; reason: string } | undefined;
  let next = 0;

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.length) });
    response.end(bytes);
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    const authorized = request.headers.authorization === `Bearer ${input.key}`;
    requests.push({ method: request.method ?? "", path: url.pathname, authorized });
    if (request.method !== "GET") return send(response, 405, { error: "only GET is served" });
    if (!authorized) return send(response, 401, { error: "a valid key is required" });

    if (url.pathname === "/v1/images/generate") {
      const prompt = url.searchParams.get("prompt") ?? "";
      if (prompt.trim() === "") return send(response, 400, { error: "a prompt is required" });
      next += 1;
      const id = `img_${String(next)}`;
      images.set(id, { prompt, done: 0, ...(failing === undefined ? {} : { failAt: failing.atStep, reason: failing.reason }) });
      failing = undefined;
      return send(response, 200, { id });
    }
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

  const server = createServer(handle);
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
    failNext: (atStep, reason = "the provider ran out of ink") => {
      failing = { atStep, reason };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

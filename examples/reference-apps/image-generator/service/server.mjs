/*
 * The image generator's service: a Model Context Protocol server over standard streams with one tool, `generate_image`.
 *
 * The node runs it as a job: the call answers at once with a JobRef, and this service reports progress while it works.
 * Progress is only ever what the provider said: a step is reported when the provider's answer shows a new one.
 *
 * Its container has no network and it never holds the provider's key. Every request to the provider is a
 * `clarkcant/egress.fetch` request to the node, which sends it to the origin this package declared and adds the key the
 * person stored for this package. The origin is read from the package's own manifest, so the service asks for exactly
 * what was declared. A copy made with `clark widget init --template ai-generator` starts with the placeholder origin
 * `https://images.example.com`, which reaches no provider: replace it, and the paths below, with your provider's. With no
 * origin declared — the shape `clark widget init --template ui-with-service` starts from —
 * the service draws the picture itself.
 *
 * No dependencies on purpose: the container mounts the package read-only.
 */

import { readFileSync } from "node:fs";

import { IMAGE_SIZE, renderImage } from "./png.mjs";

const manifest = JSON.parse(readFileSync(new URL("../clarkcant.json", import.meta.url), "utf8"));
const tools = manifest.facets.find((facet) => facet.kind === "tools");
const ORIGIN = tools?.egress?.origins?.[0]?.origin;

/** How often the provider is asked how its work is going. */
const POLL_MS = 300;
/** Steps the service draws in when it draws the picture itself. */
const LOCAL_STEPS = 4;

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate one image from a text prompt, reporting the provider's progress.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["prompt"],
      additionalProperties: false,
    },
    // Asking a provider to draw writes to someone else's service and spends the person's quota there; drawing here does not.
    annotations: { readOnlyHint: ORIGIN === undefined, openWorldHint: ORIGIN !== undefined },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function failure(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** Whether the node said, in `initialize`, that it answers egress requests. */
let egressOffered = false;
/** Requests this service sent the node, by id, waiting for the node's answer. */
const asked = new Map();
let nextAsk = 0;
/** Calls still running, and the ones of them the node cancelled, by request id. A cancelled call is not answered. */
const running = new Set();
const cancelled = new Set();

function askNode(method, params) {
  nextAsk += 1;
  const id = `egress-${String(nextAsk)}`;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/**
 * One request to the provider through the node. Answers `{ status, bytes }`, or `{ error }` when the node refused it.
 *
 * Reads are GET. Starting an image is a POST with the prompt in a JSON body, never in the URL: the node lets a service
 * send anything but GET or HEAD only for a capability declared `external-write`, and a URL lands in more logs than a
 * body does.
 */
async function providerAsk(path, json) {
  const answer = await askNode("clarkcant/egress.fetch", {
    version: 1,
    url: `${ORIGIN}${path}`,
    ...(json === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: JSON.stringify(json) } }),
  });
  if (answer.error !== undefined) return { error: String(answer.error.message ?? "the node did not make the request") };
  return { status: Number(answer.result?.status ?? 0), bytes: Buffer.from(answer.result?.body?.data ?? "", "base64") };
}

function providerJson(reply) {
  try {
    return JSON.parse(reply.bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function progress(token, current, total, message) {
  if (token === undefined) return;
  send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: current, total, message } });
}

// The widget reads the prompt back from this wording (`OUTPUT_PROMPT` in `widgets/main/main.js`) to name an image it
// attaches: change both together.
function result(prompt, png) {
  return {
    content: [
      { type: "text", text: `Image for “${prompt}” (${String(IMAGE_SIZE)}×${String(IMAGE_SIZE)} PNG).` },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ],
  };
}

/** The provider's work, step by step, as the provider reports it. Undefined when the call was cancelled. */
async function generateWithProvider(id, prompt, token) {
  if (!egressOffered) return failure("The node does not make provider requests for this service.");
  const started = await providerAsk("/v1/images/generate", { prompt });
  if (cancelled.has(id)) return undefined;
  if (started.error !== undefined) return failure(`The provider was not reached: ${started.error}`);
  if (started.status === 401) return failure("The provider refused the key this package was given (401).");
  const created = providerJson(started);
  if (started.status !== 200 || typeof created?.id !== "string") {
    return failure(`The provider did not start the image (${String(started.status)}).`);
  }

  let reported = -1;
  for (;;) {
    const polled = await providerAsk(`/v1/images/${encodeURIComponent(created.id)}`);
    if (cancelled.has(id)) return undefined;
    if (polled.error !== undefined) return failure(`The provider stopped answering: ${polled.error}`);
    const state = providerJson(polled);
    if (polled.status !== 200 || state === undefined) return failure(`The provider answered ${String(polled.status)}.`);
    if (state.status === "failed") return failure(`The provider could not make the image: ${String(state.error ?? "no reason given")}`);
    const done = Number(state.done ?? 0);
    const total = Number(state.total ?? 1);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done !== reported && done <= total) {
      reported = done;
      progress(token, done, total, `The provider finished step ${String(done)} of ${String(total)}.`);
    }
    if (state.status === "succeeded") break;
    await wait(POLL_MS);
    if (cancelled.has(id)) return undefined;
  }

  const image = await providerAsk(`/v1/images/${encodeURIComponent(created.id)}/image`);
  if (cancelled.has(id)) return undefined;
  if (image.error !== undefined || image.status !== 200) {
    return failure(`The provider did not send the finished image (${image.error ?? String(image.status)}).`);
  }
  return result(prompt, image.bytes);
}

/** The same steps, drawn here: for a package that declares no provider. */
async function generateLocally(id, prompt, token) {
  for (let step = 1; step <= LOCAL_STEPS; step += 1) {
    await wait(POLL_MS);
    if (cancelled.has(id)) return undefined;
    progress(token, step, LOCAL_STEPS, `Drew step ${String(step)} of ${String(LOCAL_STEPS)}.`);
  }
  return result(prompt, renderImage(prompt));
}

async function generate(id, args, token) {
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (prompt === "" || prompt.length > 500) {
    send({ jsonrpc: "2.0", id, result: failure("A prompt of 1 to 500 characters is needed.") });
    return;
  }
  let answer;
  running.add(id);
  try {
    answer = ORIGIN === undefined ? await generateLocally(id, prompt, token) : await generateWithProvider(id, prompt, token);
  } catch (cause) {
    answer = failure(`The image could not be made: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  running.delete(id);
  // The protocol says a cancelled request is not answered.
  if (cancelled.delete(id) || answer === undefined) return;
  send({ jsonrpc: "2.0", id, result: answer });
}

function handle(message) {
  const { id, method, params } = message;
  // The node's answer to a request this service sent.
  if (method === undefined && id !== undefined) {
    const resolve = asked.get(id);
    if (resolve !== undefined) {
      asked.delete(id);
      resolve(message);
    }
    return;
  }
  if (method === "notifications/cancelled") {
    if (running.has(params?.requestId)) cancelled.add(params.requestId);
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    egressOffered = params?.capabilities?.experimental?.["clarkcant/egress"]?.version === 1;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: manifest.id, version: manifest.version },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call" && params?.name === "generate_image") {
    void generate(id, params?.arguments, params?._meta?.progressToken);
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed message is dropped rather than ending the service.
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

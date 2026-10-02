/*
 * The media render service: a Model Context Protocol server over standard streams.
 *
 * One tool, `render_audio`, that applies gain and trim to a WAV file a widget holds. The service never holds the file:
 * the call names it by artifact id, and the host — which checked the widget's grant and the profile's input cap before
 * sending the call — streams its bytes on request, one bounded range at a time (`clarkcant/artifacts.read`). The
 * rendered file goes back in the answer, and the host keeps it as an artifact only if the job completes; a cancelled
 * render answers nothing, so nothing half-rendered is ever presented as finished.
 *
 * No dependencies and no network: the container mounts this folder read-only and has none. What it may read and how
 * much is what the host offered in `initialize`, from the resource profile it granted; a manifest cannot raise it.
 */

import { WAV_HEADER_BYTES, applyGain, parseWavHeader, renderPlan, wavHeader } from "./wav.mjs";

const READ_METHOD = "clarkcant/artifacts.read";
const ARTIFACTS_CAPABILITY = "clarkcant/artifacts";

const TOOLS = [
  {
    name: "render_audio",
    description: "Render a WAV clip with a gain change and an optional trim, reporting progress as it reads the clip.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", pattern: "^art_[A-Za-z0-9_-]{1,120}$" },
        gainDb: { type: "number", minimum: -24, maximum: 12 },
        trimStartMs: { type: "integer", minimum: 0, maximum: 7200000 },
        trimEndMs: { type: "integer", minimum: 0, maximum: 7200000 },
        paceMs: { type: "integer", minimum: 0, maximum: 2000 },
      },
      required: ["source", "gainDb"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/** What the host offered for reading files, from `initialize`; undefined when it offered nothing. */
let offer;
/** Requests this service sent the host and is waiting on, by id. */
const asked = new Map();
let nextAsk = 1;
/** Renders in progress, by request id, so a cancel stops the one it names. */
const renders = new Map();

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function failure(id, message) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } });
}

/** Ask the host for one range of a file this call was given. */
function readRange(artifactId, offset, length) {
  const id = `read-${String(nextAsk++)}`;
  return new Promise((resolve, reject) => {
    asked.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method: READ_METHOD, params: { version: 1, artifactId, offset, length } });
  }).then((answer) => ({ ...answer, bytes: new Uint8Array(Buffer.from(answer.bytes, "base64")) }));
}

function kib(bytes) {
  return `${String(Math.round(bytes / 1024))} KiB`;
}

function seconds(value) {
  return `${value.toFixed(1)} s`;
}

async function render(id, args, progressToken) {
  const state = { cancelled: false };
  renders.set(id, state);
  try {
    if (offer === undefined) {
      failure(id, "This host does not stream files to services, so there is nothing to render.");
      return;
    }
    const chunk = Math.max(4096, Math.min(offer.chunkBytes, 262144));
    const head = await readRange(args.source, 0, Math.min(WAV_HEADER_BYTES, chunk));
    if (state.cancelled) return;
    if (head.mimeType !== "audio/wav") {
      failure(id, `The picked file is ${head.mimeType}; this tool renders WAV audio.`);
      return;
    }
    const header = parseWavHeader(head.bytes, head.sizeBytes);
    if (!header.ok) {
      failure(id, `The clip cannot be rendered: ${header.reason}.`);
      return;
    }
    // Only the service can read a duration, so the profile's media cap is enforced here, before any work.
    if (header.durationSeconds > offer.maxMediaSeconds) {
      failure(
        id,
        `The clip is ${seconds(header.durationSeconds)} long, over the ${seconds(offer.maxMediaSeconds)} this package's resource profile allows. Nothing was rendered.`,
      );
      return;
    }
    const plan = renderPlan(header, args);
    if (!plan.ok) {
      failure(id, `The clip cannot be rendered: ${plan.reason}.`);
      return;
    }
    const outputBytes = 44 + (plan.end - plan.start);
    if (outputBytes > offer.maxResultBytes) {
      failure(id, `The render would be ${kib(outputBytes)}, over the ${kib(offer.maxResultBytes)} one result may carry. Trim the clip and try again.`);
      return;
    }

    const output = new Uint8Array(outputBytes);
    output.set(wavHeader(header.format, plan.end - plan.start), 0);
    const total = plan.end - plan.start;
    let done = 0;
    const pace = Number.isInteger(args.paceMs) ? args.paceMs : 0;
    while (done < total) {
      const length = Math.min(chunk, total - done);
      const read = await readRange(args.source, plan.start + done, length);
      if (state.cancelled) return;
      if (read.bytes.byteLength === 0) {
        failure(id, "The clip ended before its samples did; nothing was rendered.");
        return;
      }
      output.set(applyGain(read.bytes, plan.gain), 44 + done);
      done += read.bytes.byteLength;
      if (progressToken !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: done, total, message: `Rendered ${kib(done)} of ${kib(total)}` },
        });
      }
      if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
      if (state.cancelled) return;
    }

    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Rendered ${seconds(plan.durationSeconds)} at ${String(args.gainDb)} dB (${String(header.format.channels)} channel${header.format.channels === 1 ? "" : "s"}, ${String(header.format.sampleRate)} Hz).`,
          },
          {
            type: "resource",
            resource: { uri: "file:///data/render.wav", mimeType: "audio/wav", blob: Buffer.from(output).toString("base64") },
          },
        ],
      },
    });
  } catch (cause) {
    // A cancelled render is not answered; a host that refused a read is, with its reason.
    if (!state.cancelled) failure(id, `The host stopped reading the clip: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    renders.delete(id);
  }
}

function handle(message) {
  const { id, method, params } = message;
  // An answer to one of this service's own reads.
  if (method === undefined && id !== undefined) {
    const waiting = asked.get(id);
    if (waiting === undefined) return;
    asked.delete(id);
    if (message.error !== undefined) waiting.reject(new Error(String(message.error.message ?? "the host refused the read")));
    else waiting.resolve(message.result);
    return;
  }
  if (method === "notifications/cancelled") {
    const state = renders.get(params?.requestId);
    if (state !== undefined) state.cancelled = true;
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    const offered = params?.capabilities?.experimental?.[ARTIFACTS_CAPABILITY];
    offer = offered !== null && typeof offered === "object" && offered.version === 1 ? offered : undefined;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "com.clarkcant.reference.media-render", version: "1.0.0" },
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
  if (method === "tools/call") {
    if (params?.name !== "render_audio") {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(params?.name)}` } });
      return;
    }
    void render(id, params?.arguments ?? {}, params?._meta?.progressToken);
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

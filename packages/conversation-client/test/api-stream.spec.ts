import { describe, expect, it } from "vitest";

import { GatewayClient, GatewayError, parseSseChunk, type SendMessageResult } from "../src/api.ts";
import type { Timeline } from "../src/api.ts";

/**
 * The streamed reply, from the client's side.
 *
 * Two things are being pinned here. The first is the frame parser, because a chunk boundary is where
 * an event stream actually breaks: the server writes when it has something to say, the network
 * delivers what it likes, and a parser that only understands whole frames loses text at sizes nobody
 * tests with. The second is the end of the stream, because a truncated reply drawn as a finished
 * answer is worse than a visible error.
 */

const TIMELINE: Timeline = {
  conversationId: "conv_1",
  cursor: 0,
  messages: [],
  pins: [],
  instances: [],
  snapshots: [],
  metadata: { messageCount: 0, taskCount: 0, updatedAt: "1970-01-01T00:00:00.000Z" },
  activeTaskIds: [],
};

/** A response body that hands over exactly the pieces it was given, however they are cut. */
function streamOf(pieces: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

function clientFor(response: Response, recorded?: { url?: string; init?: RequestInit | undefined }): GatewayClient {
  return new GatewayClient({
    baseUrl: "http://127.0.0.1:8765",
    token: "tok",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      if (recorded !== undefined) {
        recorded.url = String(url);
        recorded.init = init;
      }
      return response;
    }) as unknown as typeof fetch,
  });
}

function sseResponse(pieces: readonly string[], status = 200): Response {
  return new Response(streamOf(pieces), { status, headers: { "content-type": "text/event-stream" } });
}

describe("reading an event stream", () => {
  it("splits whole frames and keeps the incomplete tail", () => {
    const parsed = parseSseChunk('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te');
    expect(parsed.events).toEqual([{ event: "delta", data: '{"text":"a"}' }]);
    expect(parsed.rest).toBe('event: delta\ndata: {"te');
  });

  it("survives a frame cut in half by a chunk boundary", () => {
    // The case the incremental signature exists for: the event name itself arrives in two pieces.
    const first = parseSseChunk('event: del');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(`${first.rest}ta\ndata: {"text":"hi"}\n\n`);
    expect(second.events).toEqual([{ event: "delta", data: '{"text":"hi"}' }]);
    expect(second.rest).toBe("");
  });

  it("ignores keep-alive comments", () => {
    // These arrive every fifteen seconds while a model is thinking. If they were returned as events,
    // every one of them would reach the caller as an empty delta.
    const parsed = parseSseChunk(": keep-alive\n\nevent: delta\ndata: {}\n\n");
    expect(parsed.events).toEqual([{ event: "delta", data: "{}" }]);
  });

  it("accepts the separator with carriage returns", () => {
    const parsed = parseSseChunk('event: delta\r\ndata: {"text":"x"}\r\n\r\n');
    expect(parsed.events).toEqual([{ event: "delta", data: '{"text":"x"}' }]);
  });

  it("joins several data lines inside one frame", () => {
    const parsed = parseSseChunk("event: delta\ndata: one\ndata: two\n\n");
    expect(parsed.events).toEqual([{ event: "delta", data: "one\ntwo" }]);
  });

  it("defaults the event name when a frame does not carry one", () => {
    expect(parseSseChunk("data: {}\n\n").events).toEqual([{ event: "message", data: "{}" }]);
  });
});

describe("streaming a message", () => {
  it("reports the deltas and then the finished timeline", async () => {
    const chunks: string[] = [];
    let done: SendMessageResult | undefined;
    const client = clientFor(
      sseResponse([
        'event: delta\ndata: {"text":"2 "}\n\n',
        'event: delta\ndata: {"text":"+ 2"}\n\n',
        `event: done\ndata: ${JSON.stringify({ resolution: "model", taskId: null, messageIds: ["m1"], timeline: TIMELINE })}\n\n`,
      ]),
    );

    await client.streamMessage("conv_1", "2+2?", {
      onEvent: (event) => {
        if (event.type === "text-delta") chunks.push(event.text);
      },
      onDone: (result) => {
        done = result;
      },
    });

    expect(chunks.join("")).toBe("2 + 2");
    expect(done?.resolution).toBe("model");
    expect(done?.messageIds).toEqual(["m1"]);
    expect(done?.timeline.conversationId).toBe("conv_1");
  });

  it("asks the route that streams, with the bearer token", async () => {
    const recorded: { url?: string; init?: RequestInit | undefined } = {};
    const client = clientFor(
      sseResponse([`event: done\ndata: ${JSON.stringify({ resolution: "sample", taskId: null, messageIds: [], timeline: TIMELINE })}\n\n`]),
      recorded,
    );
    await client.streamMessage("conv_1", "hello", { onEvent: () => undefined, onDone: () => undefined });

    expect(recorded.url).toBe("http://127.0.0.1:8765/conversations/conv_1/messages/stream");
    expect(recorded.init?.method).toBe("POST");
    expect((recorded.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(recorded.init?.body).toBe(JSON.stringify({ text: "hello" }));
  });

  it("refuses a reply that ended early instead of drawing it as finished", async () => {
    const client = clientFor(sseResponse(['event: delta\ndata: {"text":"half a sen"}\n\n']));
    await expect(
      client.streamMessage("conv_1", "hello", { onEvent: () => undefined, onDone: () => undefined }),
    ).rejects.toMatchObject({ name: "GatewayError", code: "STREAM_INCOMPLETE" });
  });

  it("reports a failure the node sent on the stream", async () => {
    const client = clientFor(
      sseResponse(['event: error\ndata: {"code":"TURN_FAILED","message":"the model went away"}\n\n']),
    );
    let failure: unknown;
    try {
      await client.streamMessage("conv_1", "hello", { onEvent: () => undefined, onDone: () => undefined });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).code).toBe("TURN_FAILED");
    expect((failure as GatewayError).message).toContain("the model went away");
  });

  it("reports a refusal that never became a stream", async () => {
    // A refusal is an ordinary JSON response with a status, and it must not be mistaken for a stream
    // that simply produced nothing.
    const client = clientFor(
      new Response(JSON.stringify({ code: "RESOURCE_NOT_FOUND", message: "no such conversation" }), { status: 404 }),
    );
    let failure: unknown;
    try {
      await client.streamMessage("conv_missing", "hello", { onEvent: () => undefined, onDone: () => undefined });
    } catch (cause) {
      failure = cause;
    }
    expect((failure as GatewayError).code).toBe("RESOURCE_NOT_FOUND");
    expect((failure as GatewayError).status).toBe(404);
  });

  it("reports a frame that is not the JSON it claims to be", async () => {
    const client = clientFor(sseResponse(["event: delta\ndata: not json\n\n"]));
    await expect(
      client.streamMessage("conv_1", "hello", { onEvent: () => undefined, onDone: () => undefined }),
    ).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
  });

  it("ignores an event it does not know, rather than failing a reply that is arriving", async () => {
    const chunks: string[] = [];
    const client = clientFor(
      sseResponse([
        'event: notice\ndata: {"anything":true}\n\n',
        'event: delta\ndata: {"text":"ok"}\n\n',
        `event: done\ndata: ${JSON.stringify({ resolution: "model", taskId: null, messageIds: [], timeline: TIMELINE })}\n\n`,
      ]),
    );
    await client.streamMessage("conv_1", "hello", { onEvent: (event) => {
        if (event.type === "text-delta") chunks.push(event.text);
      }, onDone: () => undefined });
    expect(chunks.join("")).toBe("ok");
  });
});

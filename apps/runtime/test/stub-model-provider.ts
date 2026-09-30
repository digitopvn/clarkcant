import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/**
 * A model provider on 127.0.0.1 that speaks the OpenAI chat-completions stream, for tests that run a real model worker
 * without calling any vendor.
 *
 * Every request is recorded as it arrived — the authorization it carried and the tool names it offered the model — and
 * answered from a script, one reply per request. A reply can also hold its response open until the client goes away,
 * which is how a test sees a stop reach the provider call.
 */

export const STUB_PROVIDER = "clark-stub";
export const STUB_MODEL = "stub-model";

export type StubReply =
  | { kind: "text"; text: string; usage?: { prompt: number; completion: number } }
  | { kind: "tools"; calls: { name: string; arguments: Record<string, unknown> }[]; usage?: { prompt: number; completion: number } }
  /** Headers and nothing else, held open until the client closes the connection. */
  | { kind: "hang" }
  /** An error response, as a provider sends one: a status and an OpenAI-shaped error body carrying `message`. */
  | { kind: "reject"; status: number; message: string };

export interface StubRequest {
  authorization: string | undefined;
  model: string | undefined;
  tools: string[];
}

export interface StubProvider {
  baseUrl: string;
  requests: StubRequest[];
  /** How many held-open responses ended because the client closed the connection. */
  closedByClient: () => number;
  close: () => Promise<void>;
}

export async function startStubProvider(script: (index: number) => StubReply): Promise<StubProvider> {
  const requests: StubRequest[] = [];
  let closedByClient = 0;
  const open = new Set<ServerResponse>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url?.endsWith("/chat/completions") !== true) {
        res.writeHead(404).end();
        return;
      }
      let body: { model?: unknown; tools?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const tools = Array.isArray(body.tools)
        ? body.tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name ?? ""))
        : [];
      const index = requests.length;
      requests.push({
        authorization: req.headers.authorization,
        model: typeof body.model === "string" ? body.model : undefined,
        tools,
      });
      const reply = script(index);
      if (reply.kind === "reject") {
        res
          .writeHead(reply.status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: reply.message, type: "invalid_request_error", code: "invalid_api_key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (reply.kind === "hang") {
        open.add(res);
        res.on("close", () => {
          if (open.delete(res)) closedByClient += 1;
        });
        res.flushHeaders();
        return;
      }
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const base = { id: `chatcmpl-${String(index)}`, object: "chat.completion.chunk", created: 0, model: STUB_MODEL };
      if (reply.kind === "text") {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: reply.calls.map((call, position) => ({
                  index: position,
                  id: `call_${String(index)}_${String(position)}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
              finish_reason: null,
            },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      const usage = reply.usage ?? { prompt: 10, completion: 5 };
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
      });
      res.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    requests,
    closedByClient: () => closedByClient,
    close: async () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A model runtime configuration directory naming the stub as a provider, with no key in it: a worker that reaches the
 * stub with a key got that key from somewhere else, which is what a test of the handoff needs to be able to say.
 */
export function writeStubAgentDir(dir: string, baseUrl: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        [STUB_PROVIDER]: {
          baseUrl,
          api: "openai-completions",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: STUB_MODEL }],
        },
      },
    }),
    "utf8",
  );
  return dir;
}

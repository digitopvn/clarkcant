import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootNodeServices, createNodeServer, type NodeServices } from "@clarkcant/runtime";

import { type CliIo, resolveConnection, runCli } from "../src/cli.ts";

/**
 * The CLI against a real node over real HTTP.
 *
 * The command is a client and nothing else, so the only honest test is one where a node answers it: a stubbed
 * `fetch` would prove the CLI builds the requests it was written to build, not that the node accepts them.
 */

let dir: string;
let services: NodeServices;
let server: Server;
let url: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-cli-"));
  services = bootNodeServices({ dataDir: dir, label: "cli node" });
  server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function io(extra: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    // The token is found through the data dir, the way a person on the node's machine would use it.
    env: { CLARKCANT_URL: url, CLARKCANT_DATA_DIR: dir },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    out,
    err,
    ...extra,
  };
}

describe("connection", () => {
  it("prefers a flag to the environment, and the environment to the identity file", () => {
    const flags = new Map<string, string | true>([["url", "http://flag:1/"]]);
    const connection = resolveConnection(flags, {
      env: { CLARKCANT_URL: "http://env:2", CLARKCANT_TOKEN: "from-env" },
      stdout: () => undefined,
      stderr: () => undefined,
      readFile: () => JSON.stringify({ localToken: "from-file" }),
    });
    expect(connection).toEqual({ url: "http://flag:1", token: "from-env" });

    const fromFile = resolveConnection(new Map(), {
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
      readFile: () => JSON.stringify({ localToken: "from-file" }),
    });
    expect(fromFile.token).toBe("from-file");
  });
});

describe("the identity file's token", () => {
  const file = (): string => JSON.stringify({ localToken: "from-file" });
  const quiet = { stdout: () => undefined, stderr: () => undefined, readFile: file };

  it("is used for a node on this machine", () => {
    for (const url of ["http://127.0.0.1:8765", "http://localhost:1", "http://[::1]:2"]) {
      expect(resolveConnection(new Map([["url", url]]), { env: {}, ...quiet }).token).toBe("from-file");
    }
  });

  it("is never sent to another host", () => {
    for (const url of ["https://other.example", "http://10.0.0.5:8765", "http://127.0.0.1.evil.example"]) {
      expect(resolveConnection(new Map([["url", url]]), { env: {}, ...quiet }).token).toBeUndefined();
    }
    // An explicit token still reaches a remote node; that is the person's own choice.
    expect(resolveConnection(new Map([["url", "https://other.example"]]), { env: { CLARKCANT_TOKEN: "given" }, ...quiet }).token).toBe(
      "given",
    );
  });
});

describe("instructions check", () => {
  const RULE = { when: { path: "packages/storage/**", operation: "write" }, include: ["migrations"] };
  /** A project folder with an instructions file, and the snippets it includes unless told otherwise. */
  const project = (file: unknown, snippets: string[] = ["migrations"]): string => {
    const folder = mkdtempSync(join(dir, "project-"));
    mkdirSync(join(folder, ".clarkcant", "instructions"), { recursive: true });
    writeFileSync(join(folder, ".clarkcant", "instructions.json"), typeof file === "string" ? file : JSON.stringify(file));
    for (const name of snippets) writeFileSync(join(folder, ".clarkcant", "instructions", `${name}.md`), "words");
    return folder;
  };
  const instructions = (folder: string): string => join(folder, ".clarkcant", "instructions.json");
  /** Reads through the real file system, and remembers what it was asked to read. */
  const spy = (): { read: string[]; readFile: (path: string) => string } => {
    const read: string[] = [];
    return {
      read,
      readFile: (path) => {
        read.push(path);
        return readFileSync(path, "utf8");
      },
    };
  };

  it("passes a versioned file without talking to a node", async () => {
    const file = instructions(project({ version: 1, rules: [RULE] }));
    const fake = spy();
    let fetched = false;
    const run = io({
      readFile: fake.readFile,
      fetch: (async () => {
        fetched = true;
        throw new Error("no node");
      }) as typeof fetch,
    });
    expect(await runCli(["instructions", "check", file], run)).toBe(0);
    expect(run.out.join("")).toBe(`${file}: ok (1 rule)\n`);
    // Not even the identity file is read: only the instructions file.
    expect(fake.read).toEqual([file]);
    expect(fetched).toBe(false);
  });

  it("checks a project folder's file, and accepts an editor's $schema", async () => {
    const folder = project({ $schema: "https://example.invalid/instructions.json", version: 1, rules: [RULE] });
    const run = io();
    expect(await runCli(["instructions", "check", folder], run)).toBe(0);
    expect(run.out.join("")).toBe(`${instructions(folder)}: ok (1 rule)\n`);
  });

  it("reports a missing version and each invalid rule, one line each, in the field's own words", async () => {
    const file = instructions(
      project({ rules: [RULE, { include: ["../out"] }, { when: { operation: "delete", role: ["task", 3] }, include: ["migrations"] }] }),
    );
    const run = io();
    expect(await runCli(["instructions", "check", file], run)).toBe(1);
    expect(run.out.join("").trimEnd().split("\n")).toEqual([
      `${file}: version: missing; write "version": 1 (a node still reads a file without it as version 1)`,
      `${file}: rules[1].include[0]: must be a snippet name of lowercase letters, digits and -`,
      `${file}: rules[2].when.operation: must be one of read, write, command, test, deploy or a list of 1 to 16 of them`,
      `${file}: rules[2].when.role: item [1] must be one of foreground, background, task`,
    ]);
  });

  it("says once that a newer version needs a newer ClarkCant, without judging the rest by version 1", async () => {
    const file = instructions(project({ version: 2, rules: [{ ...RULE, future: true }] }));
    const run = io();
    expect(await runCli(["instructions", "check", file, "--json"], run)).toBe(1);
    expect(JSON.parse(run.out.join(""))).toEqual({
      path: file,
      ok: false,
      problems: ["version 2 is newer than this build reads (1); update ClarkCant"],
      warnings: [],
    });
  });

  it("warns about an include with no snippet file, without failing the check", async () => {
    const file = instructions(project({ version: 1, rules: [{ ...RULE, include: ["migrations", "gone"] }] }));
    const run = io();
    expect(await runCli(["instructions", "check", file], run)).toBe(0);
    expect(run.out.join("").trimEnd().split("\n")).toEqual([
      `${file}: warning: rules[0].include[1]: no instructions/gone.md beside this file, so the rule states nothing for it`,
      `${file}: ok (1 rule)`,
    ]);
  });

  it("answers JSON, and says plainly when the file cannot be read, is too large or is not JSON", async () => {
    const ok = instructions(project({ version: 1, rules: [] }));
    const asJson = io();
    expect(await runCli(["instructions", "check", ok, "--json"], asJson)).toBe(0);
    expect(JSON.parse(asJson.out.join(""))).toEqual({ path: ok, ok: true, problems: [], warnings: [] });

    const bad = instructions(project("{ not json"));
    const broken = io();
    expect(await runCli(["instructions", "check", bad], broken)).toBe(1);
    expect(broken.out.join("")).toBe(`${bad}: file: not valid JSON\n`);

    // Too large is said from the size alone: the file is never read.
    const large = instructions(project(`{"version":1,"rules":[],"pad":"${"x".repeat(70 * 1024)}"}`));
    const fake = spy();
    const tooLarge = io({ readFile: fake.readFile });
    expect(await runCli(["instructions", "check", large], tooLarge)).toBe(1);
    expect(tooLarge.out.join("")).toBe(`${large}: file: larger than 65536 bytes, so a node does not read it\n`);
    expect(fake.read).toEqual([]);

    const gone = join(dir, "gone.json");
    const missing = io();
    expect(await runCli(["instructions", "check", gone], missing)).toBe(1);
    expect(missing.err.join("")).toContain(`could not read ${gone}`);
    // A folder with no instructions file names the file it looked for.
    const empty = mkdtempSync(join(dir, "empty-"));
    const none = io();
    expect(await runCli(["instructions", "check", empty], none)).toBe(1);
    expect(none.err.join("")).toContain(`could not read ${instructions(empty)}`);
    const wrong = io();
    expect(await runCli(["instructions", "fix"], wrong)).toBe(1);
  });

  /** A package folder whose manifest declares one instructions facet at `rules/instructions.json`. */
  const pkg = (rules: unknown, overrides: Record<string, unknown> = {}, snippets: string[] = ["migrations"]): string => {
    const folder = mkdtempSync(join(dir, "package-"));
    mkdirSync(join(folder, "rules", "instructions"), { recursive: true });
    writeFileSync(
      join(folder, "clarkcant.json"),
      JSON.stringify({
        schemaVersion: 3,
        id: "com.example.rules",
        version: "1.0.0",
        displayName: "Rules",
        description: "Project instructions as a package.",
        hostApi: { min: 1, max: 1 },
        facets: [{ kind: "instructions", id: "rules", entry: "rules/instructions.json", isolation: "declarative" }],
        requestedCapabilities: [],
        permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
        platforms: ["web"],
        ...overrides,
      }),
    );
    writeFileSync(join(folder, "rules", "instructions.json"), JSON.stringify(rules));
    for (const name of snippets) writeFileSync(join(folder, "rules", "instructions", `${name}.md`), "words");
    return folder;
  };

  it("checks a package's instructions facet, from its folder or its clarkcant.json", async () => {
    const folder = pkg({ version: 1, rules: [RULE] });
    const manifest = join(folder, "clarkcant.json");
    const run = io();
    expect(await runCli(["instructions", "check", folder], run)).toBe(0);
    expect(run.out.join("")).toBe(`${manifest}: ok (1 rule)\n`);
    expect(await runCli(["instructions", "check", manifest], io())).toBe(0);
  });

  it("reports a facet's invalid rules and missing snippets, warns about a pin, and needs schemaVersion 3", async () => {
    const folder = pkg({ version: 1, rules: [{ ...RULE, pin: true }, { when: {}, include: ["../x"] }] }, {}, []);
    const run = io();
    expect(await runCli(["instructions", "check", folder], run)).toBe(1);
    const out = run.out.join("");
    expect(out).toContain("facet rules (rules/instructions.json): rules[1]");
    expect(out).toContain("facet rules (rules/instructions.json): rules[0].include[0]: no instructions/migrations.md");
    expect(out).toContain("rules[0].pin: ignored for a package's rules");

    const old = io();
    expect(await runCli(["instructions", "check", pkg({ version: 1, rules: [RULE] }, { schemaVersion: 2 })], old)).toBe(1);
    expect(old.out.join("")).toContain('an instructions facet needs "schemaVersion": 3');

    const gone = pkg({ version: 1, rules: [RULE] }, { facets: [{ kind: "instructions", id: "rules", entry: "rules/none.json", isolation: "declarative" }] });
    const missing = io();
    expect(await runCli(["instructions", "check", gone], missing)).toBe(1);
    expect(missing.out.join("")).toContain("facet rules (rules/none.json): no such file in the package");
  });
});
describe("commands", () => {
  it("reports the node's status", async () => {
    const run = io();
    expect(await runCli(["status"], run)).toBe(0);
    expect(run.out.join("")).toContain("cli node");
  });

  it("says plainly when the token is wrong", async () => {
    const run = io();
    expect(await runCli(["conversations", "--token", "wrong"], run)).toBe(1);
    expect(run.err.join("")).toContain("UNAUTHENTICATED");
  });

  it("creates, lists and reads a conversation", async () => {
    const created = io();
    expect(await runCli(["new", "from", "the", "terminal"], created)).toBe(0);
    const conversationId = created.out.join("").trim();
    expect(conversationId).toMatch(/^conv_/);

    const listed = io();
    await runCli(["conversations"], listed);
    expect(listed.out.join("")).toContain(`${conversationId}  from the terminal`);

    const read = io();
    expect(await runCli(["read", conversationId, "--json"], read)).toBe(0);
    expect(JSON.parse(read.out.join(""))).toMatchObject({ conversationId });
  });

  it("asks Clark over the streaming route and names the conversation on stderr", async () => {
    const run = io();
    expect(await runCli(["ask", "hello", "Clark"], run)).toBe(0);
    expect(run.err.join("")).toMatch(/conversation conv_\S+ \(continue with -c conv_/);

    const conversationId = /conversation (conv_\S+)/.exec(run.err.join(""))?.[1] ?? "";
    const read = io();
    await runCli(["read", conversationId], read);
    expect(read.out.join("")).toContain("you: hello Clark");
  });

  it("says on stderr when the message joined the reply already being written", async () => {
    // The node answers a message steered into the running turn with `resolution: "steered"` and no message of its own.
    const steered: typeof fetch = async (input, init) => {
      if (!String(input).endsWith("/messages/stream")) return await fetch(input, init);
      const done = JSON.stringify({ resolution: "steered", taskId: null, messageIds: [], timeline: { messages: [] } });
      return new Response(`event: done\ndata: ${done}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const run = io({ fetch: steered });
    expect(await runCli(["ask", "-c", "conv_running", "and", "the", "tests"], run)).toBe(0);
    expect(run.out.join("")).toBe("");
    expect(run.err.join("")).toContain("joined the reply Clark is already writing");
  });

  it("reaches any route through api", async () => {
    const run = io();
    expect(await runCli(["api", "GET", "/node"], run)).toBe(0);
    expect(JSON.parse(run.out.join(""))).toMatchObject({ label: "cli node" });

    const missing = io();
    expect(await runCli(["api", "GET", "/conversations/conv_missing/timeline"], missing)).toBe(1);
  });

  it("marks what api carries as the clarkcant api surface, and nothing else it sends", async () => {
    const surfaces: (string | null)[] = [];
    const watched: typeof fetch = (input, init) => {
      surfaces.push(new Headers(init?.headers).get("x-clarkcant-surface"));
      return fetch(input, init);
    };
    expect(await runCli(["api", "GET", "/node"], io({ fetch: watched }))).toBe(0);
    expect(await runCli(["status"], io({ fetch: watched }))).toBe(0);
    // The node decides a widget's artifact writes by the execution policy when they arrive under this mark.
    expect(surfaces[0]).toBe("cli-api");
    expect(surfaces.length).toBeGreaterThan(1);
    expect(surfaces.slice(1).every((surface) => surface === null)).toBe(true);
  });

  it("does not carry an approval decision through api", async () => {
    const run = io();
    expect(await runCli(["api", "POST", "/conversations/conv_x/approvals/appr_y/decide", "{}"], run)).toBe(1);
    expect(run.err.join("")).toContain("decided by the person");
  });

  it("does not install packages, decide installs or delete conversations through api, under any spelling", async () => {
    for (const path of ["/packages/install", "//packages//install/", "/packages/install?x=1", "/packages/approvals/appr_y/decision", "/conversations/conv_x/delete", "//conversations//conv_x//delete/?x=1"]) {
      const run = io();
      expect(await runCli(["api", "POST", path, '{"packageId":"com.example.x","version":"1.0.0"}'], run), path).toBe(1);
      expect(run.err.join(""), path).toContain("installing packages");
    }
  });

  it("refuses an unknown option and an option missing its value instead of guessing", async () => {
    const unknown = io();
    expect(await runCli(["--port", "9000", "status"], unknown)).toBe(1);
    expect(unknown.err.join("")).toContain("unknown option --port");

    const missing = io();
    expect(await runCli(["status", "--url"], missing)).toBe(1);
    expect(missing.err.join("")).toContain("--url needs a value");
  });

  it("prints the discovery document", async () => {
    const run = io();
    expect(await runCli(["discover"], run)).toBe(0);
    expect(JSON.parse(run.out.join(""))).toMatchObject({ surfaces: { mcp: { endpoint: "/mcp" } } });
  });

  it("bridges MCP over stdio: one line in, one line out, nothing for a notification", async () => {
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      "not json",
    ];
    const run = io({
      stdinLines: async function* () {
        yield* lines;
      },
    });
    expect(await runCli(["mcp"], run)).toBe(0);
    const answers = run.out.join("").trim().split("\n").map((line) => JSON.parse(line) as { id: unknown; error?: unknown });
    // Lines are forwarded concurrently, so answers arrive in completion order; each is matched by its id.
    expect(answers.map((answer) => answer.id).sort()).toEqual([1, 2, null].sort());
    expect(answers.find((answer) => answer.id === null)?.error).toMatchObject({ code: -32700 });
  });

  it("answers a ping while an earlier MCP request is still running", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const written: unknown[] = [];
    const run = io({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const message = JSON.parse(String(init?.body)) as { id: number; method: string };
        if (message.method === "tools/call") await slow;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }), { status: 200 });
      }) as typeof fetch,
      stdout: (text: string) => {
        const answer = JSON.parse(text) as { id: number };
        written.push(answer.id);
        // The ping's answer is written while the slow call is still held open; only then is it let go.
        if (answer.id === 2) release();
      },
      stdinLines: async function* () {
        yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_clark", arguments: {} } });
        yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
      },
    });
    expect(await runCli(["mcp"], run)).toBe(0);
    expect(written).toEqual([2, 1]);
  });

  it("turns a refused MCP request into a JSON-RPC error rather than silence", async () => {
    const run = io({
      env: { CLARKCANT_URL: url, CLARKCANT_TOKEN: "wrong" },
      stdinLines: async function* () {
        yield JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
      },
    });
    await runCli(["mcp"], run);
    expect(JSON.parse(run.out.join(""))).toMatchObject({ id: 7, error: { code: -32000 } });
  });
});

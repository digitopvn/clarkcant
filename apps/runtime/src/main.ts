#!/usr/bin/env node
/**
 * Headless runtime entry point.
 *
 * Boots a node and serves the authenticated command gateway on loopback by default.
 * Binding a public interface requires an explicit flag, because a node with a public
 * listener and no TLS is the deployment mistake the blueprint names: application
 * authorization is required regardless of how private the network looks.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MessageBlock, MessageRecord } from "@clarkcant/contracts";
import { instantSchema } from "@clarkcant/contracts";
import { applyEnvFile } from "@clarkcant/pi-adapter";

import { handleRequest, decideApprovalForNode, type GatewayResponse } from "./gateway.ts";
import { machineRoots } from "./fs-search.ts";
import { resolveProject, refreshProjectIndex } from "./project-finder.ts";
import { commandDigest } from "./run-command.ts";
import { captureSnapshot, createInstance, handleUserMessage, requestApproval, setPreference, type CoordinationDeps } from "@clarkcant/core";
import { GALLERY, YOUTUBE } from "@clarkcant/data-canvas";
import { definitionDigest } from "@clarkcant/widget-host";
import { listLocalImages, messagesSince, readCredential } from "@clarkcant/storage";
import { attachVoiceGateway, VOICE_ANSWER_NOTE, VOICE_CREDENTIAL_NAME } from "./voice-session.ts";
import { indexMessages, textOfMessage } from "./session-search.ts";
import { FixtureLiveAdapter } from "./voice-fixture.ts";
import { SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";

import { createModelTurn, type ViewDescriptor } from "./model-turn.ts";
import { buildViewCatalog } from "./view-catalog.ts";
import { registerNodeTools } from "./tool-catalogue.ts";
import { composeMiniApp } from "./compose-mini-app.ts";
import { createNodeTools } from "./node-tools.ts";
import { registerSessionFile, sessionsDirectory } from "./session-store.ts";
import { bootNodeServices, type NodeServices } from "./services.ts";
import type { ProjectSessionStarter } from "./project-session.ts";

interface CliOptions {
  dataDir: string;
  host: string;
  port: number;
  label: string;
  allowPublicBind: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: get("data-dir") ?? join(homedir(), ".clarkcant"),
    host: get("host") ?? "127.0.0.1",
    port: Number.parseInt(get("port") ?? "8765", 10),
    label: get("label") ?? "local runtime",
    allowPublicBind: argv.includes("--allow-public-bind"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(options.host);
  if (!isLoopback && !options.allowPublicBind) {
    process.stderr.write(
      `Refusing to bind ${options.host}.\n` +
        "A node reachable from the network needs TLS and an explicit acknowledgement that you have it.\n" +
        "Pass --allow-public-bind only when that is true.\n",
    );
    process.exit(2);
  }

  // Credentials are read from a local file before anything is assembled, because whether the
  // node has a model decides whether the conductor is built with a way to answer at all. A
  // variable already present in the environment wins, so a deployment that sets the real
  // secret does not have it replaced by a file in the checkout. Only the names taken are
  // reported; no value is ever written to a log.
  const envFile = applyEnvFile(join(process.cwd(), ".env"), process.env, (path) => readFileSync(path, "utf8"));
  if (envFile.loaded.length > 0) {
    process.stderr.write(`read ${envFile.loaded.length} variable(s) from .env: ${envFile.loaded.join(", ")}\n`);
  }

  // Filled after the node boots. The catalog is built from widget dependencies that only exist
  // once `bootNodeServices` has run, and the node is created with the model turn already in hand,
  // so the turn reads this lazily at the moment a conversation starts rather than at startup.
  const viewCatalog: ViewDescriptor[] = [];
  /**
   * Filled once the node has booted.
   *
   * The model turn is built before the services because whether the node has a model decides how
   * the conductor is assembled, and the session store lives in the services. The callback fires on
   * the first session creation, long after both exist, so the ordering is a fact about startup
   * rather than a race.
   */
  const sessionWiring: { index?: NodeServices["sessions"]; principalId?: string } = {};
  const searchWiring: { deps?: NodeServices["search"] } = {};
  const projectWiring: { deps?: NodeServices["projects"] } = {};
  /**
   * Where an approval request is recorded, filled once the node has booted.
   *
   * `run_command` is registered only with these: a node that cannot record a decision cannot ask for one,
   * and a tool that could only refuse is worse than no tool at all.
   */
  const approvalWiring: { deps?: CoordinationDeps } = {};
  /** Filled once the node has booted, so the scripted turn below can compose a real surface. */
  const modelWiring: { compose?: NodeServices["compose"] } = {};

  /**
   * A deterministic composer, for the browser suite.
   *
   * It exists for the same reason the voice fixture does: a composed surface can only be produced by
   * a turn, and a turn needs a provider — so without a deterministic path the browser code that
   * renders a composed surface could never be exercised in CI. It answers only overview-shaped
   * requests and returns nothing for anything else, which leaves the scripted recipes and the model
   * path exactly as they were. Every part of the production pipeline still runs: candidates, compiler,
   * coverage check, transactional capture, timeline.
   */
  const modelFixture = process.env.CC_MODEL_FIXTURE === "1";
  const fixtureCompose = async (input: {
    conversationId: string;
    principal: { principalId: string };
    text: string;
    messageId: string;
  }): Promise<{ block: MessageBlock; text: string } | undefined> => {
    /*
     * A command proposal, scripted.
     *
     * The same reason the other fixtures exist: the browser half of this feature — a card with two
     * buttons and a receipt — needs a way to be reached without a provider account, and a fixture that
     * cannot produce the card would leave the client wiring tested by nothing at all.
     */
    if (/chạy lệnh thử|thử chạy lệnh/i.test(input.text)) {
      const approvals = approvalWiring.deps;
      if (approvals === undefined) return undefined;
      const cwd = options.dataDir;
      const command = `node -e "process.stdout.write('fixture ran')"`;
      const approval = requestApproval(approvals, {
        operationDigest: commandDigest(command, cwd),
        operationDescription: `Chạy lệnh trong ${cwd} (fixture) - chỉ để thử đường duyệt`,
        effectCategory: "local-write",
        ttlMs: 900_000,
      });
      return {
        text: "Đây là yêu cầu duyệt do fixture tạo, không phải model thật. Chưa có gì chạy cả.",
        block: {
          type: "approval-card",
          owner: "host",
          approvalId: approval.approvalId,
          operationDescription: approval.operationDescription,
          operationDigest: approval.operationDigest,
          effectCategory: "local-write",
          expiresAt: approval.expiresAt,
          decider: "user",
          decision: "pending",
          payload: JSON.stringify({ command, cwd }),
        },
      };
    }

    /*
     * The turn that follows an approved command.
     *
     * An approval hands the real output back to the agent so it can carry on, and on a fixture node that turn
     * has to have an answer too: without one the request waits for a model that is not there, and the browser
     * suite measures a timeout instead of a continuation.
     */
    if (/Lệnh đã được duyệt/i.test(input.text)) {
      const reply = "Fixture: lệnh đã chạy xong, tui đã đọc kết quả và tiếp tục công việc.";
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    /*
     * A spoken sentence, answered.
     *
     * The voice fixture says exactly these words once a second of audio has reached the node, so this is
     * what makes the whole loop provable in a real browser without a provider account: a sentence spoken
     * into a microphone becomes a message, the agent answers it, and the session reads the answer back.
     */
    if (/audio giả lập|thiết bị micro/i.test(input.text)) {
      const reply = "Fixture đã nhận câu bạn nói và trả lời qua hội thoại, không phải model thật.";
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    /*
     * A card asking for a secret.
     *
     * The fixture exists for the same reason the approval one does: the browser half of this needs a way to be
     * reached without a provider account, and a node that never happens to need a key would leave the whole input
     * path tested by nothing at all. The field is host-owned, so it is drawn by the host and not by a widget.
     */
    if (/nhập key thử|nhap key thu/i.test(input.text)) {
      const reply = "Fixture: node này cần một khoá để thử đường nhập secret (không phải model thật).";
      return {
        text: reply,
        block: {
          type: "credential-card",
          owner: "host",
          requestId: `cred_${input.messageId}`,
          purpose: "Khoá thử cho fixture, để kiểm tra ô nhập secret.",
          destination: "vault-node",
          fields: [{ name: "fixture_key", label: "Khoá thử", masked: true, hostOwned: true }],
          // A card that never expires would be a card that asks forever, so the fixture's does expire. Built through
          // the contract's own schema rather than asserted into the branded type, because an assertion here would be
          // the place a malformed instant got in.
          expiresAt: instantSchema.parse(new Date(Date.now() + 900_000).toISOString()),
        },
      };
    }

    /*
     * A video somebody else hosts, named by identifier.
     *
     * The embed is the one surface whose content comes from outside the node, which makes it the one worth a
     * browser assertion: the address is built by the host from an identifier it validated, and a client that
     * turned an address the model chose into an embed would be a different thing entirely.
     */
    if (/video youtube|youtube/i.test(input.text)) {
      const instance = createInstance(services.conductor, {
        definition: YOUTUBE,
        packageDigest: definitionDigest(YOUTUBE),
        ownerPrincipalId: input.principal.principalId,
        props: {
          videoId: "dQw4w9WgXcQ",
          title: "Video thử (fixture)",
          description: "Fixture: một video nhúng, không phải model thật.",
        },
      });
      const snapshot = captureSnapshot(services.conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: YOUTUBE.textFallback,
        presentationRef: `catalog:${YOUTUBE.id}`,
      });
      const reply = "Fixture: một video YouTube, để thử đường nhúng (không phải model thật).";
      return {
        text: reply,
        block: { type: "surface", definitionRef: { id: YOUTUBE.id, version: YOUTUBE.version }, snapshot },
      };
    }

    /*
     * Pictures this node holds, as a gallery.
     *
     * The picture widgets draw references the host minted, so the only way to reach them without a provider
     * account is a fixture that reads what this node actually has. The browser suite uploads a real image and
     * then asks for this, which is the difference between a widget that was drawn and one that was mentioned:
     * a fixture carrying its own pictures would prove nothing about the resolver behind them.
     */
    if (/thư viện ảnh|thu vien anh|gallery/i.test(input.text)) {
      const images = listLocalImages(services.runtime.db, input.principal.principalId, 12);
      if (images.length === 0) {
        const empty = "Fixture: node này chưa có ảnh nào để dựng thư viện.";
        return { text: empty, block: { type: "text", format: "plain", content: empty, streaming: false } };
      }
      const instance = createInstance(services.conductor, {
        definition: GALLERY,
        packageDigest: definitionDigest(GALLERY),
        ownerPrincipalId: input.principal.principalId,
        props: {
          imageRefs: images.map((image) => image.imageId),
          alts: images.map((image) => image.altText),
          title: "Thư viện ảnh (fixture)",
        },
      });
      const snapshot = captureSnapshot(services.conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: GALLERY.textFallback,
        presentationRef: `catalog:${GALLERY.id}`,
      });
      const reply = "Fixture: thư viện ảnh dựng từ những ảnh node này đang giữ, không phải model thật.";
      return {
        text: reply,
        block: { type: "surface", definitionRef: { id: GALLERY.id, version: GALLERY.version }, snapshot },
      };
    }

    if (!/tổng quan|tong quan|overview/i.test(input.text)) return undefined;
    const compose = modelWiring.compose;
    if (compose === undefined) return undefined;

    const outcome = await composeMiniApp(compose, {
      conversationId: input.conversationId,
      messageId: input.messageId,
      principalId: input.principal.principalId as never,
      intent: input.text,
      explicitTemplateId: "overview",
    });
    const text = outcome.ok
      ? "Đây là tổng quan dựng bởi fixture model trên dữ liệu thật của node này (không phải model thật)."
      : `Fixture không dựng được tổng quan: ${outcome.message}`;
    return {
      text,
      block: outcome.ok
        ? outcome.block
        : { type: "text", format: "plain", content: text, streaming: false },
    };
  };

  /**
   * A session starter that starts nothing.
   *
   * The same reason the model and voice fixtures exist: the flow that starts a session in a chosen
   * directory has a browser half, and proving it must not spawn a worker process — which would need a
   * provider, a longer wait than any test should take, and would leave a session behind on the machine
   * running the suite. It answers the shape the gateway expects and says out loud that it is a fixture.
   */
  const sessionFixture = process.env.CC_SESSION_FIXTURE === "1";
  const fixtureProjectSessions = (): ProjectSessionStarter => {
    let started = 0;
    return {
      available: () => ({ available: true }),
      start: async (input) => {
        started += 1;
        void input;
        return { sessionId: `sess_fixture_${started}`, sessionFile: undefined };
      },
    };
  };

  const modelTurn = await createModelTurn({
    env: process.env,
    cwd: process.cwd(),
    sessionDir: join(options.dataDir, "sessions"),
    onSessionFile: ({ sessionId, sessionFile }) => {
      if (sessionWiring.index === undefined || sessionWiring.principalId === undefined) return;
      const registered = registerSessionFile(sessionWiring.index, {
        sessionId,
        principalId: sessionWiring.principalId,
        path: sessionFile,
      });
      if (!registered.ok) {
        process.stderr.write(`session ${sessionId}: ${registered.message}\n`);
      }
    },
    views: () => viewCatalog,
    // The conversation so far, for a session that has just been created.
    //
    // A session is dropped when a turn fails, because a session that failed a turn is the thing that is broken;
    // the thread is not, so the next message is answered by an agent that has been told what it is joining
    // rather than by one that has never heard of it.
    history: async (conversationId) => {
      const records = messagesSince(services.runtime.db, conversationId, 0, 40);
      return records
        .filter((record): record is MessageRecord & { role: "user" | "assistant" } => record.role === "user" || record.role === "assistant")
        .map((record) => ({ role: record.role, text: textOfMessage(record) }));
    },
    // The node registers the sample dataset itself, so this is the complete set it holds rather
    // than a guess. The model is told these names because a view over data that is not there
    // renders as nothing, which reads as a broken widget instead of a missing fact.
    datasetRefs: () => [SAMPLE_DATASET.datasetId],
    // The Session Manager's search surface, exposed to the main model as its own tool. Read from a
    // closure so the services it needs, which are assembled below, exist by the time a turn runs.
    // The Session Manager's read-only reports, including the project finder. Built by a function a
    // test can call: an inline list here is how `find_project` came to exist without ever being
    // registered, and nothing could see the difference.
    extraTools: () => {
      const search = searchWiring.deps;
      const projects = projectWiring.deps;
      const approvals = approvalWiring.deps;
      if (search === undefined || projects === undefined || approvals === undefined) return [];
      const tools = createNodeTools({
        search,
        projects,
        approvals: () => approvals,
        // "Where should this go?" goes through the finder, which is where Jev decides when several folders
        // could be meant. The model is told to look before it proposes, and an ambiguous answer comes back
        // as a question rather than as a guess.
        resolveFolder: async (intent) => {
          const resolution = await resolveProject(projects, { intent });
          if (resolution.status === "resolved") {
            return { status: "resolved", cwd: resolution.project.path, relPath: resolution.relPath };
          }
          if (resolution.status === "clarify") {
            return { status: "ask", message: resolution.question, options: resolution.options };
          }
          return {
            status: "ask",
            message: resolution.status === "rejected" ? resolution.message : resolution.question,
            options: [],
          };
        },
      });
      // Published for the Tools tab, from the same call that hands them to the model: a tab that built its own list
      // would be a second source of truth for what this node can do, and the first thing to drift from it.
      registerNodeTools(tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description })));
      return tools;
    },
  });
  process.stderr.write(
    modelTurn === undefined
      ? "no model configured; the node will answer with scripts and capabilities only\n"
      : `model: ${modelTurn.selection.provider}/${modelTurn.selection.id}` +
          ` (turn limit ${modelTurn.budget.maxWallClockMs} ms, ${modelTurn.budget.maxTokens} tokens)\n`,
  );

  const services: NodeServices = bootNodeServices({
    dataDir: options.dataDir,
    label: options.label,
    ...(modelTurn === undefined ? {} : { respondWithModel: modelTurn.answer }),
    // The fixture is a composer rather than a model: it never displaces the model turn, and the
    // recipes still answer everything it declines.
    ...(modelFixture ? { composeFromIntent: fixtureCompose } : {}),
    ...(sessionFixture ? { projectSessions: fixtureProjectSessions() } : {}),
    ...(modelTurn === undefined
      ? {}
      : {
          model: {
            provider: modelTurn.selection.provider,
            id: modelTurn.selection.id,
            maxWallClockMs: modelTurn.budget.maxWallClockMs,
            maxTokens: modelTurn.budget.maxTokens,
          },
        }),
  });

  sessionWiring.index = services.sessions;
  sessionWiring.principalId = services.runtime.identity.ownerPrincipalId;
  searchWiring.deps = services.search;
  // The turn control the gateway needs to answer a message that arrives while something is running. Assigned here
  // rather than passed into bootNodeServices, because the model turn is built above and the services just below it,
  // and this is the first line where both exist.
  if (modelTurn !== undefined) {
    services.turnControl = {
      running: () => modelTurn.running(),
      interrupt: (conversationId) => modelTurn.interrupt(conversationId),
      steer: (conversationId, text) => modelTurn.steer(conversationId, text),
    };
  }
  projectWiring.deps = services.projects;
  approvalWiring.deps = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => new Date().toISOString() as never,
    // The conductor's own id generator, so an approval id looks like every other id this node writes.
    newId: services.conductor.newId,
  };

  // A fixture node arranges its own precondition: the scripted command proposal has to have somewhere to
  // run, and a browser run must never depend on a developer's real approved folders.
  if (modelFixture) {
    setPreference(
      { db: services.runtime.db, now: () => new Date().toISOString() as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: "workspace.roots",
        scope: "global",
        value: [options.dataDir],
        source: "user",
      },
    );
  }
  modelWiring.compose = services.compose;

  if (sessionFixture) {
    process.stderr.write(
      "project sessions: FIXTURE starter loaded — a session is reported, and no worker is spawned\n",
    );
  }

  if (modelFixture) {
    // Said out loud, because a fixture that is indistinguishable from a model is worse than no
    // fixture: a screenshot from this node must not be read as model output.
    process.stderr.write(
      "overview: FIXTURE composer loaded — overview requests are scripted, and no provider is called for them\n",
    );
  }

  // The model may now ask for these views. When there are none the `show_view` tool is not
  // registered at all, which is why this is reported rather than left to be discovered: a node
  // that cannot show anything should say so once at startup, not fail a turn later.
  viewCatalog.push(...buildViewCatalog(services.conductor, services.compose));
  // Said out loud because it is a capability with a privacy shape: the model may search this machine's
  // files, the walk is read-only and bounded, and the lines it finds go to the provider as the tool's
  // result. An operator who did not want that should be able to learn it from the startup line.
  process.stderr.write(
    `filesystem search: read-only over ${machineRoots().join(", ")} — no index is built; matches are sent to the model provider\n`,
  );

  /*
   * Build the project index, in the background and after the node is listening.
   *
   * Nothing at runtime ever refreshed it before this: it was written only when somebody picked a project, so
   * asking which projects are on this machine answered with the two folders that had already been opened, and an
   * agent looking for a folder it could see on disk found nothing.
   *
   * Bounded in time as well as in entries, because one of this machine's roots is a cloud drive and a scan that
   * waits for it can run for minutes. An aborted scan is not allowed to prune - the finder checks that itself -
   * so stopping early leaves the previous index alone rather than emptying it.
   */
  const indexScan = new AbortController();
  const indexBudget = setTimeout(() => indexScan.abort(), 60_000);
  void refreshProjectIndex(services.projects, { signal: indexScan.signal })
    .then((outcome) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: ${outcome.scanned} scanned, ${outcome.kept} kept, ${outcome.removed} removed` +
          (outcome.truncated || outcome.stoppedEarly ? " — the scan stopped early, so the index is partial\n" : "\n"),
      );
    })
    .catch((cause: unknown) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: not built — ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    });
  process.stderr.write(
    viewCatalog.length === 0
      ? "no widget definitions on this node; the model can answer in words only\n"
      : `views: ${viewCatalog.length} definition(s) the model may show — ${viewCatalog.map((view) => view.id).join(", ")}\n`,
  );
  process.stderr.write(
    services.missingFamilies.length === 0
      ? "catalog: every family a composed surface needs is drawable\n"
      : `catalog: a composed surface would be missing ${services.missingFamilies.join(", ")}\n`,
  );
  process.stderr.write(`session transcripts: ${sessionsDirectory(options.dataDir)}\n`);
  process.stderr.write(
    services.jev.config.enabled
      ? `selector: ${services.jev.config.model} pinned, ${services.jev.config.timeoutMs} ms per turn\n`
      : "selector: disabled (no credential or local-only); composed surfaces use the deterministic path\n",
  );

  const server = createServer((request, response) => {    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);

      // The handler is guarded. A request that cannot be satisfied is the request's problem, and
      // answering it with a 500 is the whole job of this boundary — letting it reach the process
      // means one bad message takes the node down and every other conversation with it. That is
      // exactly how this was found: a duplicate id killed the node the user was reviewing.
      let result: GatewayResponse;
      try {
        result = await handleRequest(
          { services },
          {
            method: request.method ?? "GET",
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: request.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          },
        );
      } catch (cause) {
        // The message is reported rather than swallowed, because a caller that cannot see why a
        // request failed will retry it unchanged.
        process.stderr.write(
          `request ${request.method ?? "GET"} ${url.pathname} failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`,
        );
        result = {
          status: 500,
          body: {
            error: {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        // The browser client is served from a different origin during development, and the
        // gateway is token-authenticated rather than cookie-authenticated, so a wildcard
        // origin here grants nothing a caller does not already need the token for.
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };

      // A body that is written over time: the status line and headers go out now, and the handler
      // sends the rest as it produces it. The turn keeps running even if the client leaves, because
      // the answer is stored either way — stopping it would discard work the user paid for because
      // they closed a tab.
      if (result.stream !== undefined) {
        headers["content-type"] = result.stream.contentType;
        // `no-transform` as well as `no-cache`: the point of this response is its timing, so an
        // intermediary that may buffer and re-chunk it is being told not to.
        headers["cache-control"] = "no-cache, no-transform";
        response.writeHead(result.status, headers);
        response.flushHeaders();

        // `writableFinished` is what distinguishes a finished response from a client that hung up:
        // the 'close' event fires for both, and only the second one means there is nobody to write
        // to. Without this check the flag would latch on the first completed write and the stream
        // would silently stop reporting.
        let clientGone = false;
        response.on("close", () => {
          if (!response.writableFinished) clientGone = true;
        });
        // A write to a socket the peer has dropped reports itself here rather than throwing, and an
        // unhandled 'error' on a response stream takes the process with it.
        response.on("error", () => {
          clientGone = true;
        });

        // A comment frame every fifteen seconds. A stream that is waiting on a model looks like an
        // idle connection to anything between here and the browser, and an idle connection is what
        // gets closed; a comment is valid SSE that the parser ignores.
        const keepAlive = setInterval(() => {
          if (!clientGone) response.write(": keep-alive\n\n");
        }, 15_000);
        keepAlive.unref();

        try {
          await result.stream.run((chunk) => {
            if (!clientGone) response.write(chunk);
          });
        } finally {
          clearInterval(keepAlive);
          response.end();
        }
        return;
      }

      // Imported images are served as their own bytes under the content type the host verified
      // from the file's magic bytes, rather than wrapped in a JSON envelope the client would have
      // to decode and re-type.
      if (result.binary !== undefined) {
        headers["content-type"] = result.binary.contentType;
        headers["content-length"] = String(result.binary.bytes.byteLength);
        // Private: an image URL is authorized by a token, and a shared cache in front of a node
        // must not hand one principal's image to another.
        headers["cache-control"] = "private, max-age=300";
        response.writeHead(result.status, headers);
        response.end(Buffer.from(result.binary.bytes));
        return;
      }

      response.writeHead(result.status, headers);
      response.end(`${JSON.stringify(result.body)}\n`);
    });
  });

  /**
   * The voice socket.
   *
   * Attached to the same server as the command gateway, so a browser needs one origin and one
   * token rather than a second service to discover. The credential is read here and handed to the
   * gateway as a function, which is what keeps it out of the module that serves the browser.
   */
  const voiceModel = process.env.CC_VOICE_MODEL;
  /**
   * A provider that answers on a script, so the browser-to-node path can be verified end to end
   * without an account and without spending quota on every run. A node running it says so, because
   * a fake that is indistinguishable from the real thing is worse than having no fake at all.
   */
  const voiceFixture = process.env.CC_VOICE_FIXTURE === "1";
  const voice = attachVoiceGateway({
    server,
    services,
    credential: () =>
      voiceFixture
        ? "fixture-credential"
        : // The vault first, then the environment. A key typed into the credential card is a key the person
          // expects to be used, and an environment variable that happens to be absent must not make that
          // expectation false. Read at open time rather than cached, so the next attempt after typing one finds it.
          process.env.GEMINI_API_KEY ??
          readCredential(services.runtime.db, services.runtime.identity.ownerPrincipalId, VOICE_CREDENTIAL_NAME),
    ...(voiceFixture ? { createAdapter: () => new FixtureLiveAdapter() } : {}),
    ...(voiceModel === undefined ? {} : { model: voiceModel }),
    /**
     * What a finished sentence does.
     *
     * It becomes a message in the conversation and the agent answers it, with whatever tools the
     * answer needs. The words that come back are what the voice session reads aloud, which is why the
     * live model is told not to answer anything itself: this is the only answer in the room.
     */
    answer: async ({ conversationId, text, at: spokenAt, onText }) => {
      const outcome = await handleUserMessage(services.conductor, {
        conversationId: conversationId as never,
        principal: {
          principalId: services.runtime.identity.ownerPrincipalId as never,
          kind: "user",
          nodeId: services.runtime.identity.nodeId as never,
        },
        text,
        at: spokenAt as never,
        // Spoken turns are answered briefly: the session has to read the answer out loud.
        note: VOICE_ANSWER_NOTE,
        // The voice surface is a caller holding an open stream like any other, so it gets the same
        // events the typed path gets. Only text is forwarded: the reasoning and tool events belong to
        // the conversation, which is refreshed when the turn ends.
        ...(onText === undefined
          ? {}
          : {
              emit: (event: { type: string; text?: string }) => {
                if (event.type === "text-delta" && typeof event.text === "string") onText(event.text);
              },
            }),
      });
      // Indexed where the messages were just written, for the same reason the typed route does it:
      // a sentence that was spoken is a message like any other, and search must not disagree with the
      // conversation about what was said.
      indexMessages(services.search, { conversationId, messages: outcome.messages, at: spokenAt });

      const reply = outcome.messages
        .filter((message) => message.role === "assistant")
        .map((message) => textOfMessage(message))
        .join("\n\n")
        .trim();
      // A turn can end with an operation waiting for a decision. The voice session asks about it out loud, and
      // needs the digest the card was shown with: it is the same binding the button sends.
      const proposed = outcome.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === "approval-card" && block.decision === "pending");
      // `find` returns the union it searched, so the block is narrowed again here: nothing else may be read
      // off an approval card.
      const pending = proposed !== undefined && proposed.type === "approval-card" ? proposed : undefined;
      return {
        reply,
        recordedMessages: outcome.messages.length,
        ...(pending === undefined
          ? {}
          : {
              pendingApproval: {
                approvalId: pending.approvalId,
                digest: pending.operationDigest,
                description: pending.operationDescription,
              },
            }),
      };
    },
    /**
     * Carry out what the user just said yes or no to.
     *
     * The same function the HTTP route calls, so a decision made by voice and a decision made by pressing the
     * card mean exactly the same thing: the same digest check, the same receipt in the same conversation.
     */
    decideApproval: async ({ conversationId, approvalId, decision, digest }) => {
      const result = await decideApprovalForNode(services, {
        conversationId,
        approvalId,
        decision,
        digest,
        principal: {
          principalId: services.runtime.identity.ownerPrincipalId,
          kind: "user",
          nodeId: services.runtime.identity.nodeId,
        },
        at: new Date().toISOString() as never,
      });
      return result.ok
        ? // The agent's continuation is what the person should hear: the command ran, and this is what the agent
          // made of it. `message` is spoken by the session.
          { ok: true, message: result.continuation ?? result.outcome ?? "Đã chạy xong lệnh đó." }
        : { ok: false, message: result.message };
    },
  });
  process.stderr.write(
    voiceFixture
      ? "voice: FIXTURE provider loaded — audio and transcripts on /voice are scripted, not model output\n"
      : process.env.GEMINI_API_KEY === undefined
        ? "voice: no GEMINI_API_KEY, so a voice session will be refused with the reason rather than failing silently\n"
        : `voice: live voice sessions available on /voice (model ${voiceModel ?? "the pinned default"})\n`,
  );

  /**
   * A port that is already taken, reported plainly.
   *
   * Node's default is an unhandled `'error'` event: twenty lines of stack trace and no
   * statement of the problem or what to do about it. This is the failure an operator of a
   * local node meets most often — a second node, or one left over from last time — so it is
   * worth four lines of plain language rather than a stack trace to interpret.
   */
  server.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${options.port} on ${options.host} is already in use.\n` +
          "Another node is probably running. Stop it, or start this one on a different port with" +
          ` --port <number>.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`The node could not listen on ${options.host}:${options.port}: ${cause.message}\n`);
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    /*
     * Publish what this node can do, at boot rather than at the first turn.
     *
     * The tools are built on demand for a turn, and that is the right time for a turn. It is the wrong time for the
     * Tools tab, which asks the question before anything has been sent: publishing only inside the lazy builder meant
     * the answer was "none" exactly when somebody looked, which is what a probe against a running node showed.
     *
     * Built from the same wirings the turn uses, and without the folder-resolution refinement, which changes how
     * run_command picks a folder rather than whether it exists.
     */
    const bootApprovals = approvalWiring.deps;
    if (bootApprovals !== undefined) {
      registerNodeTools(
        createNodeTools({ search: services.search, projects: services.projects, approvals: () => bootApprovals }).map(
          (tool) => ({ name: tool.name, label: tool.label, description: tool.description }),
        ),
      );
    }
    process.stderr.write(
      `clarkcant node "${services.runtime.identity.label}" listening on http://${options.host}:${options.port}\n`,
    );
    process.stderr.write(`node id: ${services.runtime.identity.nodeId}\n`);
    process.stderr.write(`data dir: ${services.runtime.dataDir}\n`);
    process.stderr.write("commands require the bearer token stored in the node's identity.json\n");
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}; closing the node\n`);
    void voice.close();
    server.close(() => {
      void modelTurn?.dispose();
      services.runtime.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();

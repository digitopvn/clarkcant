#!/usr/bin/env node
/**
 * Headless runtime entry point.
 *
 * Boots a node and serves the authenticated command gateway on loopback by default.
 * Binding a public interface requires an explicit flag, because a node with a public
 * listener and no TLS is the deployment mistake the blueprint names: application
 * authorization is required regardless of how private the network looks.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MessageBlock, MessageRecord } from "@clarkcant/contracts";
import { instantSchema, describeAppIntent } from "@clarkcant/contracts";
import { applyEnvFile } from "@clarkcant/pi-adapter";

import { decideApprovalForNode, invokeWidgetAction, widgetActionTarget } from "./gateway.ts";
import { NO_FOCUSED_SURFACE_SAY } from "./widget-voice-action.ts";
import {
  type AppIntentDeps,
  consumeConfirmation,
  decideAppIntent,
  mintConfirmation,
} from "./app-intents.ts";
import { createNodeServer } from "./server.ts";
import { machineRoots } from "./fs-search.ts";
import { resolveProject, refreshProjectIndex } from "./project-finder.ts";
import { commandDigest } from "./run-command.ts";
import { captureSnapshot, createInstance, saveActionBinding, createTask, handleUserMessage, readExecutionPolicy, readPersonalInstructions, directoryIndexPath, recordAppIntentEvent, requestApproval, setPreference, type CoordinationDeps } from "@clarkcant/core";
import { GALLERY, YOUTUBE } from "@clarkcant/data-canvas";
import { definitionDigest } from "@clarkcant/widget-host";
import { listLocalImages, messagesSince, readCredential,
  readPreference,
  upsertArtifact,
} from "@clarkcant/storage";
import { attachVoiceGateway, VOICE_ANSWER_NOTE, VOICE_CREDENTIAL_NAME } from "./voice-session.ts";
import { indexMessages, textOfMessage } from "./session-search.ts";
import { FixtureLiveAdapter } from "./voice-fixture.ts";
import { SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";

import { createModelTurn, type ViewDescriptor } from "./model-turn.ts";
import { memoryBrief } from "./memory.ts";
import { attachmentRefsForLastUserMessage } from "./attachments.ts";
import { blobsDir, readBlob } from "./blobs.ts";
import { extractPdfText } from "./pdf-text.ts";
import { buildViewCatalog } from "./view-catalog.ts";
import { registerNodeTools } from "./tool-catalogue.ts";
import { composeMiniApp } from "./compose-mini-app.ts";
import { createNodeTools, createRememberTool } from "./node-tools.ts";
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

/**
 * The registry's dependencies.
 *
 * A function rather than a constant so the clock is read when a decision is made, not when the node booted.
 */
function appIntentDepsFor(services: NodeServices): AppIntentDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => new Date().toISOString() as never,
    newId: services.conductor.newId,
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
  /** Distinguishes two scripted questions, because the card's answerability is keyed by its id. */
  let fixtureQuestionCounter = 0;
  const fixtureCompose = async (input: {
    conversationId: string;
    principal: { principalId: string };
    text: string;
    messageId: string;
  }): Promise<{ block: MessageBlock; text: string } | undefined> => {
    /*
     * The attachment, read back - the acceptance criterion this feature is judged by.
     *
     * "Attach two files, send, and the agent answers using the file's content" is what the issue asks the browser
     * suite to show, and nothing showed it: the prompt carries the refs and the `read_attachment` tool reads text,
     * but no journey ever watched an answer use a file. On this fixture node there is no model turn, so the fixture
     * stands in for the agent and reads the bytes through the same helpers the prompt and the tool use. That proves
     * the pipeline - the file reached the node, the node made its content readable, and the reply carries it. It does
     * not prove a model would use it, which needs a provider and is recorded as such.
     */
    const attached = attachmentRefsForLastUserMessage({
      db: services.runtime.db,
      conversationId: input.conversationId,
    });
    const readable = attached.filter((ref) => ref.kind === "text" || ref.kind === "pdf");
    if (readable.length > 0) {
      const quoted = readable
        .map((ref) => {
          const blob = readBlob({
            dataDir: options.dataDir,
            blobPath: join(blobsDir(options.dataDir), ref.blobRef),
          });
          if (!blob.ok) return `${ref.filename}: ${blob.message}`;
          // A PDF is read through the same extractor the tool and the prompt use, so this journey exercises the
          // production path rather than a shortcut written for the fixture.
          if (ref.kind === "pdf") {
            const extracted = extractPdfText(blob.bytes);
            return extracted.ok ? `${ref.filename}:\n${extracted.text}` : `${ref.filename}: ${extracted.reason}`;
          }
          return `${ref.filename}:\n${new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes)}`;
        })
        .join("\n\n");
      return {
        text: "Tui đọc tệp bạn gửi. Nội dung nó nói:",
        block: { type: "text", format: "markdown", content: quoted, streaming: false },
      };
    }
    /*
     * A command proposal, scripted.
     *
     * The same reason the other fixtures exist: the browser half of this feature — a card with two
     * buttons and a receipt — needs a way to be reached without a provider account, and a fixture that
     * cannot produce the card would leave the client wiring tested by nothing at all.
     */
    /*
     * A question, scripted — the producer for the question card.
     *
     * The same reason the approval fixture exists: the browser half of this feature is a card whose answer
     * becomes the user's next message, and a card nothing can produce would leave that wiring tested by
     * nothing at all.
     */
    if (/biểu mẫu|thử form|fill a form/i.test(input.text)) {
      const formId = `form_fixture_${fixtureQuestionCounter += 1}`;
      return {
        text: "Đây là biểu mẫu do fixture tạo, không phải model thật.",
        block: {
          type: "form-card",
          owner: "host",
          formId,
          title: "Cho tôi biết vài thông tin",
          fields: [
            { id: "field-1", label: "Tên dự án", kind: "text", required: true, placeholder: "ví dụ: clarkcant" },
            { id: "field-2", label: "Ghi chú", kind: "textarea" },
          ],
        },
      };
    }

    /*
     * A task, scripted — but a real row in the database.
     *
     * The Stop control's entire claim is that pressing it changes the node's record of the task, so a card
     * carrying an invented id would prove nothing: the browser journey would be asserting against a task that
     * does not exist. This makes the row the control actually acts on.
     */
    if (/task dài|chạy task|long task/i.test(input.text)) {
      const taskDeps = {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => instantSchema.parse(new Date().toISOString()),
        newId: services.conductor.newId,
      };
      const task = createTask(taskDeps, {
        conversationId: input.conversationId as never,
        goal: "Task do fixture tạo để thử nút dừng",
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user" as const,
          nodeId: services.runtime.identity.nodeId as never,
        },
      });
      const at = instantSchema.parse(new Date().toISOString());
      return {
        text: "Đây là task do fixture tạo, không phải model thật, và chưa chạy ở đâu cả.",
        block: {
          type: "task-progress-card",
          owner: "host",
          cardId: services.conductor.newId("card"),
          taskId: task.taskId,
          goal: task.goal,
          status: "queued",
          steps: [],
          startedAt: at,
          updatedAt: at,
          cancellable: true,
        },
      };
    }

    /*
     * A diff, scripted.
     *
     * The keyboard journey needs a diff that is long enough to scroll and present without a pointer, and a card
     * nothing can produce would leave that journey asserting against a component no user can reach.
     */
    if (/xem diff|xem thay đổi|thử diff|show diff/i.test(input.text)) {
      return {
        text: "Đây là diff do fixture tạo, không phải model thật.",
        block: {
          type: "code-diff-card",
          owner: "host",
          cardId: services.conductor.newId("card"),
          summary: "Đổi cách task được đánh dấu là đã dừng",
          files: [
            {
              path: "packages/core/src/task-service.ts",
              additions: 2,
              deletions: 1,
              hunks: [
                {
                  header: "@@ -495,3 +495,4 @@ cancelTask",
                  lines: [
                    { kind: "context", text: "const requested = applyTaskEvent(deps, taskId, \"cancel.requested\");" },
                    { kind: "remove", text: "if (requested.ok) return requested.task;" },
                    { kind: "add", text: "if (!requested.ok) return requested;" },
                    { kind: "add", text: "return confirmed(requested.task);" },
                  ],
                },
              ],
            },
          ],
          truncated: false,
          // Required by the schema: a diff says when it was taken, because a change shown without a time reads
          // as the current state of the code rather than as a snapshot of it.
          updatedAt: instantSchema.parse(new Date().toISOString()),
        },
      };
    }

    /*
     * An artifact, scripted — and written to the artifacts table, so reopening it asks the node about something
     * that exists rather than about an id invented for the journey.
     *
     * This is a fixture rather than a model, and that is a limitation worth naming: nothing in the product
     * produces an artifact yet, so the reopen path can be exercised end to end but not reached in normal use.
     */
    if (/artifact|tệp lớn/i.test(input.text)) {
      const artifactId = services.conductor.newId("art");
      const at = instantSchema.parse(new Date().toISOString());
      const digest = "sha256:3f786850e387550fdab836ed7e6dc881de23001b09c2f0f8b9f2f1e6c0c4a1b7";
      upsertArtifact(services.runtime.db, {
        artifactId,
        digest,
        sizeBytes: 20480,
        mimeType: "application/pdf",
        classification: "internal",
        originNodeId: services.runtime.identity.nodeId,
        createdAt: at,
      });
      return {
        text: "Đây là artifact do fixture tạo, không phải model thật.",
        block: {
          type: "artifact",
          artifactId,
          mimeType: "application/pdf",
          sizeBytes: 20480,
          digest,
          label: "báo cáo quý.pdf",
        },
      };
    }

    /*
     * A browser session, scripted — created in the node's own registry, so takeover has something to change hands
     * over rather than a card carrying an id nothing has heard of.
     */
    if (/browser|trình duyệt/i.test(input.text)) {
      const created = services.controlSessions.create({
        sessionId: services.conductor.newId("bs"),
        surface: "browser",
        label: "đang mở form thanh toán",
      });
      return {
        text: "Đây là phiên browser do fixture tạo, không phải model thật.",
        block: {
          type: "browser-session-card",
          owner: "host",
          cardId: services.conductor.newId("card"),
          sessionId: created.sessionId,
          label: created.label,
          driver: created.owner,
          status: created.status,
          leaseEpoch: created.leaseEpoch,
          updatedAt: instantSchema.parse(new Date().toISOString()),
        },
      };
    }

    /*
     * A desktop session, scripted — created in the node's registry, and left in the state a real one starts in.
     *
     * The screen permission belongs to the operating system, so the honest default is "not granted yet" and the
     * card has to say so. A fixture that pretended the preview was available would let the journey pass while the
     * one thing that matters about this surface went unasserted.
     */
    if (/màn hình|desktop|điều khiển máy/i.test(input.text)) {
      const created = services.controlSessions.create({
        sessionId: services.conductor.newId("cs"),
        surface: "computer",
        label: "đang sửa bảng tính",
        preview: "needs-permission",
        previewReason: "ứng dụng chưa được cấp quyền ghi màn hình",
      });
      return {
        text: "Đây là phiên điều khiển màn hình do fixture tạo, không phải model thật.",
        block: {
          type: "computer-session-card",
          owner: "host",
          cardId: services.conductor.newId("card"),
          sessionId: created.sessionId,
          label: created.label,
          driver: created.owner,
          status: created.status,
          leaseEpoch: created.leaseEpoch,
          preview: created.preview,
          ...(created.previewReason === undefined ? {} : { previewReason: created.previewReason }),
          updatedAt: instantSchema.parse(new Date().toISOString()),
        },
      };
    }

    if (/hỏi tôi|thử hỏi|ask me/i.test(input.text)) {
      const questionId = `q_fixture_${fixtureQuestionCounter += 1}`;
      return {
        text: "Đây là câu hỏi do fixture tạo, không phải model thật.",
        block: {
          type: "question-card",
          owner: "host",
          questionId,
          question: "Bạn muốn tôi mở dự án nào?",
          options: [
            { id: "option-1", label: "Dự án hiện tại", detail: "thư mục này" },
            { id: "option-2", label: "Dự án khác", detail: "tôi sẽ chỉ đường" },
          ],
        },
      };
    }

    /*
     * The marketplace-results card, produced without a directory on disk.
     *
     * A fixture proves the wiring, not the provider: the search itself is covered by the core tests, and what the
     * browser has to be shown is that this card renders its source, version, digest and risk lane — and that it
     * offers no install button of its own.
     */
    if (/tìm gói|marketplace|search package/i.test(input.text)) {
      return {
        text: "Đây là kết quả do fixture tạo, không phải model thật.",
        block: {
          type: "marketplace-results",
          owner: "host",
          cardId: "market_fixture_1",
          query: "dashboard",
          directory: "/tmp/cc-directory.json",
          results: [
            {
              packageId: "com.acme.dashboard",
              version: "1.0.0",
              displayName: "Dashboard",
              description: "biểu đồ cho dự án",
              // An exact npm version, which is what the directory fixture beside this lists: the install resolves the
              // entry from the index, so a card whose source disagreed with it would be testing two different things.
              source: { kind: "npm", name: "com.acme.dashboard", version: "1.0.0" },
              digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
              riskTier: "isolated-ui",
              facets: ["ui"],
              platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
            },
            {
              /*
               * A second result the directory does **not** list, so the refusal path is reachable from the interface
               * rather than only from a test that calls the route. A listing somebody can click and get a named
               * refusal from is the difference between "we handle that" and "we say we handle that".
               */
              packageId: "com.acme.not-listed",
              version: "2.0.0",
              displayName: "Not Listed",
              description: "không có trong directory",
              source: { kind: "npm", name: "com.acme.not-listed", version: "2.0.0" },
              digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
              riskTier: "isolated-ui",
              facets: ["ui"],
              platforms: ["darwin-arm64", "linux-x64", "win32-x64", "web"],
            },
          ],
        },
      };
    }

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
     * A widget that runs in its own frame.
     *
     * The instance is created here and its binding attached here, because a frame can only invoke what the instance
     * already holds: the session refuses an id it was not told about, and the node refuses one the instance does not
     * carry. The block is what puts the "mở bản hiện tại" affordance in the transcript — without it the instance
     * exists and nothing offers to open it.
     *
     * The definition is written out rather than imported, because it has to agree with the fixture package on disk:
     * the node resolves a definition to a package by reading that package's own `widget.json`, so a fixture that
     * disagreed with the file would describe a widget nothing can serve.
     */
    if (/widget cách ly|isolated widget/i.test(input.text)) {
      const definition = {
        id: "com.example.frame-widget.main@1",
        version: "0.1.0",
        renderer: "isolated-app" as const,
        propsSchema: {
          type: "object",
          properties: { title: { type: "string", maxLength: 200 } },
          required: ["title"],
          additionalProperties: false,
        },
        eventSchemas: {},
        stateSchema: { type: "object", properties: {}, additionalProperties: true },
        stateVersion: 0,
        semanticDescription: "A widget that runs in its own frame.",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true, minHeight: 160 },
        textFallback: "Widget trong frame: nội dung chưa xem được ở chế độ chỉ có chữ.",
        effectCategories: [],
        datasetRefs: [],
      };
      const instance = createInstance(services.conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Widget trong frame (fixture)" },
      });
      saveActionBinding(services.conductor, {
        // Fixed, because the fixture package's own code names it: a generated id would be one the widget cannot know.
        actionBindingId: "binding_frame_widget_fixture",
        instanceId: instance.instanceId,
        definitionId: definition.id,
        packageGeneration: `${definition.id}#fixture`,
        // A `view` operation on purpose: it is the one the M1 surface performs, so the round trip is about the
        // frame's plumbing rather than about a policy question that has its own tests.
        proposal: { kind: "view", operation: "view.save", args: {} },
        label: "Gửi ý định",
        inputSchema: {},
        allowedDataRefs: [],
        fixedConstraints: {},
        effectCategory: "read",
        requiresApproval: false,
        limits: {},
        bindingDigest: "sha256:frame-widget-binding",
        createdAt: instantSchema.parse(new Date().toISOString()),
      });
      const snapshot = captureSnapshot(services.conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: một widget chạy trong frame cách ly (không phải model thật).",
        block: {
          type: "surface",
          definitionRef: { id: definition.id, version: definition.version },
          snapshot,
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

    /*
     * A sentence that asks the node to remember something.
     *
     * The fixture stands in for the agent and calls the same `remember` tool a model calls, with the arguments a
     * model would pass, so the path exercised here is the tool's own: its validation, its redaction, the write, the
     * brief the next turn reads, and the Memory tab reading it back. What a fixture cannot prove is the provider's
     * judgement - that a model would decide to call it - and that stays an opt-in check behind a provider key.
     */
    const asked = /(?:nhớ rằng|ghi nhớ)\s*[:：]?\s*(.+)/i.exec(input.text);
    if (asked !== null) {
      const tool = createRememberTool({
        db: services.runtime.db,
        principalId: input.principal.principalId,
        conversationId: input.conversationId,
        now: () => new Date().toISOString(),
        newId: services.conductor.newId,
      });
      const remembered = await tool.execute({ kind: "preference", scope: "node", text: (asked[1] ?? "").trim() });
      const reply = `Fixture: ${remembered.text}`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
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

  /*
   * The model a person chose, read when a session is created rather than at boot.
   *
   * Lazily because `services` - which owns the database and the identity the preference is keyed by - is built below
   * this line; a value would be the same ordering mistake the typecheck refused twice. By the time anybody sends a
   * message this node is fully built, so the read happens against a node that exists.
   */
  const chosenModel = (): { provider: string; id: string } | undefined => {
    const stored = readPreference(services.runtime.db, services.runtime.identity.ownerPrincipalId, "model", "node");
    const [provider, id] = (stored ?? "").split("/");
    return provider === undefined || provider === "" || id === undefined || id === ""
      ? undefined
      : { provider, id };
  };

  const modelTurn = await createModelTurn({
    env: process.env,
    cwd: process.cwd(),
    model: chosenModel,
    /*
     * The user's own instructions, read on every turn rather than captured here.
     *
     * The same laziness as `chosenModel`, for the same ordering reason and one more: the promise of the
     * feature is that a preference written while the app is open reaches the next turn. A value captured at
     * boot would make it a restart instead.
     *
     * `readPersonalInstructions` answers nothing unless the toggle is on and there is text, so a disabled
     * preference leaves the system prompt byte-for-byte as it was rather than adding an empty section.
     */
    personalInstructions: () =>
      readPersonalInstructions(
        { db: services.runtime.db, now: () => new Date().toISOString() as never },
        services.runtime.identity.ownerPrincipalId,
      ),
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
    // The files the current message carries, read back from the row that message was stored as. The
    // timeline and this prompt are then the same reading, so a conversation reopened tomorrow attaches
    // the same files to the same turn. `attachmentBrief` inlines a text file's content and names anything
    // binary by id; no path is ever part of it.
    attachments: {
      dataDir: options.dataDir,
      refsFor: (conversationId) =>
        attachmentRefsForLastUserMessage({ db: services.runtime.db, conversationId }),
    },
    // The node registers the sample dataset itself, so this is the complete set it holds rather
    // than a guess. The model is told these names because a view over data that is not there
    // renders as nothing, which reads as a broken widget instead of a missing fact.
    datasetRefs: () => [SAMPLE_DATASET.datasetId],
    /*
     * What was remembered, for the turn about to run.
     *
     * Read per turn rather than captured once, so a record somebody deletes in the Memory tab stops being
     * sent on the very next turn. That is what makes that screen's promise true rather than decorative.
     */
    memoryBrief: (conversationId) =>
      memoryBrief(
        { db: services.runtime.db, now: () => new Date().toISOString(), newId: services.conductor.newId },
        { principalId: services.runtime.identity.ownerPrincipalId, conversationId },
      ),
    // The Session Manager's search surface, exposed to the main model as its own tool. Read from a
    // closure so the services it needs, which are assembled below, exist by the time a turn runs.
    // The Session Manager's read-only reports, including the project finder. Built by a function a
    // test can call: an inline list here is how `find_project` came to exist without ever being
    // registered, and nothing could see the difference.
    extraTools: (turn) => {
      const search = searchWiring.deps;
      const projects = projectWiring.deps;
      const approvals = approvalWiring.deps;
      if (search === undefined || projects === undefined || approvals === undefined) return [];
      // Built through the contract's own schema rather than asserted into the branded type: an assertion
      // here would be the place a malformed instant got in.
      const now = () => instantSchema.parse(new Date().toISOString());
      const tools = createNodeTools({
        search,
        projects,
        approvals: () => approvals,
        /*
         * The policy is read when a tool call happens rather than captured when this node booted: the
         * promise of the setting is that it changes what happens next, and a captured value would make it
         * a restart instead.
         */
        policy: () =>
          readExecutionPolicy(
            { db: services.runtime.db, now },
            services.runtime.identity.ownerPrincipalId,
          ),
        /*
         * Where a command that runs without a card leaves its record.
         *
         * The same event log the task lifecycle writes to, because autonomy is only checkable if the
         * effects it performed are findable afterwards.
         */
        audit: () => ({
          deps: {
            db: services.runtime.db,
            nodeId: services.runtime.identity.nodeId,
            newId: services.conductor.newId,
            now,
          },
          principalId: search.principalId,
          conversationId: turn.conversationId,
        }),
        /* The card's id has to outlive the turn, so it comes from the node's own id generator. */
        questions: { newId: services.conductor.newId },
        // Always passed: an unconfigured directory is something the tool reports, not a reason to hide it.
        directory: { indexPath: directoryIndexPath(process.env), newId: services.conductor.newId },
        // Reading an attached file is scoped to the conversation this turn belongs to, which is the
        // only thing the tool needs to check beyond the principal.
        attachments: { dataDir: options.dataDir, conversationId: turn.conversationId },
        // Remembering is scoped to the turn's conversation the same way, and the id comes from the node's own
        // generator: the model supplies what to remember, never who it belongs to.
        memory: { conversationId: turn.conversationId, newId: services.conductor.newId },
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
      runInBackground: (input) => modelTurn.runInBackground(input),
    };
    // The catalogue travels the same way and for the same reason: the model turn exists above this line and the
    // services exist below it, so this is the first place both do. Published as the turn's own function rather than
    // as a snapshot, so a provider added by upgrading pi is visible without restarting the node.
    services.modelCatalogue = modelTurn.catalogue;
    // The same line, for the same reason: the adapter exists above this and the services below it.
    services.extensions = modelTurn.extensions;
    services.piSettings = modelTurn.piSettings;
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
    /*
     * The background path needs a turn control, and the fixture node has none.
     *
     * Measured: `services.turnControl` is assigned only when a model turn exists, and `createModelTurn` returns
     * undefined without a model selection - while the adapter it would otherwise build is the real one, so naming a
     * provider in the environment would put a real provider call behind every turn. The suite's own journey says a
     * fixture node has a model turn and asserts the accepted path rather than the refusal, so the control is what is
     * published here: a scripted background runner and nothing else. No model identity and no catalogue, because the
     * fixture node deliberately reports that it has no model, and other journeys assert exactly that.
     */
    if (services.turnControl === undefined) {
      services.turnControl = {
        running: () => [],
        interrupt: () => true,
        steer: () => Promise.resolve(false),
        runInBackground: (input) =>
          Promise.resolve(`Đã xử lý đoạn này trong một phiên nền (fixture): ${input.text.slice(0, 80)}`),
      };
      process.stderr.write(
        "background: FIXTURE turn control loaded — background work is scripted, and no provider is called\n",
      );
    }
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

  const server = createNodeServer({
    services,
    origin: `http://${options.host}:${options.port}`,
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
  /**
   * The words the scripted provider will say, when the fixture is loaded.
   *
   * Read when a session opens rather than captured once, so a test can set them and then open one. On a real node this
   * stays undefined, and the route that would write it is not registered either - which is the gate.
   */
  let voiceFixtureWords: string | undefined;
  if (voiceFixture) {
    services.voiceFixture = {
      setWords: (words: string) => {
        voiceFixtureWords = words;
      },
    };
  }
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
    ...(voiceFixture
      ? {
          /**
           * The scripted words apply to **the next session and no further**.
           *
           * Consumed here rather than read on every utterance, because the value lives on the node and the node
           * outlives a session. Reading it live leaked one suite's script into the next: voice.spec.ts, which
           * scripts nothing and expects the fixture's own sentence, failed after this suite had run - a failure
           * that only appeared in a whole-suite run, which is exactly why the whole suite is the gate.
           */
          createAdapter: () => {
            const scripted = voiceFixtureWords;
            voiceFixtureWords = undefined;
            return new FixtureLiveAdapter({ ...(scripted === undefined ? {} : { words: scripted }) });
          },
        }
      : {}),
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
    /**
     * What a spoken sentence means to the application.
     *
     * The same registry the typed route and a click go through, with source "voice" so the audit answers "was this
     * clicked or heard". `none` is returned unchanged and the session then treats the sentence as a question for the
     * agent, which is what keeps ordinary speech out of the app-control path.
     */
    resolveAppIntent: ({ text, conversationId }) => {
      const deps = appIntentDepsFor(services);
      const principalId = services.runtime.identity.ownerPrincipalId;
      return decideAppIntent(
        deps,
        { principalId, request: { text, source: "voice" }, conversationId },
        (intent) => mintConfirmation(deps, { principalId, intent, source: "voice" }),
      );
    },
    /**
     * Turn a spoken confirmation into permission, once.
     *
     * A refusal as well as a failure comes back as a non-executable decision, because the page must never be handed
     * something it would act on when the answer was no or the token was stale.
     */
    confirmAppIntent: ({ token, decision }) => {
      const deps = appIntentDepsFor(services);
      const outcome = consumeConfirmation(deps, { principalId: services.runtime.identity.ownerPrincipalId, token });
      if (!outcome.ok) {
        const say =
          outcome.code === "CONFIRMATION_EXPIRED"
            ? "Lời xác nhận đã quá hạn. Bạn nói lại câu lệnh nhé."
            : "Tôi không còn lời xác nhận nào đang chờ.";
        return { kind: "refused", say };
      }
      if (decision === "denied") return { kind: "refused", say: "Tôi đã bỏ qua câu lệnh đó." };
      recordAppIntentEvent(deps, { intent: outcome.intent, source: outcome.source, confirmed: true });
      return {
        kind: "intent",
        intent: outcome.intent,
        requiresConfirmation: false,
        readBack: describeAppIntent(outcome.intent),
      };
    },
    /**
     * Run a widget action the person asked for out loud.
     *
     * The same function a click goes through, with the difference that a click brings a cursor and a sentence does
     * not: the revision and the binding digest are read from the node's own state rather than taken from the page. A
     * sentence is a request to do the thing, not a claim about which revision it was looking at.
     */
    widgetAction: async ({ conversationId, action, focused }) => {
      const instanceId = focused?.instanceId;
      if (instanceId === undefined) return { ok: false, say: NO_FOCUSED_SURFACE_SAY };

      const target = widgetActionTarget(services, instanceId, action.actionBindingId);
      if (target === undefined) {
        // The page's view was older than the instance, or the action is gone. Either way this is a refusal and not a
        // guess: invoking a binding the instance no longer announces is exactly what the digest check exists for.
        return { ok: false, say: "Widget đang mở không còn hành động đó nữa. Bạn mở lại rồi thử lại giúp tôi nhé." };
      }

      const result = invokeWidgetAction(services, {
        conversationId,
        principalId: services.runtime.identity.ownerPrincipalId,
        instanceId,
        actionBindingId: action.actionBindingId,
        expectedRevision: target.revision,
        expectedBindingDigest: target.bindingDigest,
        // What the words implied. Empty when the person named the action without saying what it should do, and the
        // widget's own contract then answers that it wanted an argument - which is better than this guessing a period.
        input: action.args,
        invocationId: `inv_${randomUUID()}`,
      });

      if (!result.ok) return { ok: false, say: `Không thực hiện được: ${result.message}` };
      const landedOn = typeof result.body.revision === "number" ? result.body.revision : target.revision;
      return { ok: true, instanceId, revision: landedOn, say: `Đã ${action.label}.` };
    },
  });
  /*
   * Published to the settings route, from the same object the voice sessions use.
   *
   * A surface that built its own capability list would be a second source of truth for what the provider
   * supports, and the first thing to drift from it.
   */
  services.voiceCapabilities = () => voice.capabilities();
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

  /*
   * A failure nobody caught is written down rather than fatal, and this is the one that was actually killing the node.
   *
   * The evidence was narrow: a full browser suite saw the process disappear partway through and every request after it
   * fail with "connection refused", while a guard on unhandled *rejections* caught nothing at all. No rejection means
   * an exception - a thrown error on a path nobody wrapped, most likely a child process reporting a failure of its own
   * - and Node's default for that is also to exit.
   *
   * A node that exits takes every connected client with it, which is strictly worse than a line of stderr. The node's
   * job is to stay up and answer; a bad turn should end that turn, not every conversation at once.
   */
  const noteFailure = (what: string, reason: unknown): void => {
    process.stderr.write(
      `${what} (the node stays up): ${reason instanceof Error ? reason.message : String(reason)}\n`,
    );
  };
  process.on("unhandledRejection", (reason) => noteFailure("unhandled rejection", reason));
  process.on("uncaughtException", (error) => noteFailure("uncaught exception", error));

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

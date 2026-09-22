import { type Instant, type MessageBlock, instantSchema } from "@clarkcant/contracts";
import {
  type ConductorDeps,
  type CoordinationDeps,
  captureSnapshot,
  createInstance,
  createTask,
  requestApproval,
  saveActionBinding,
  setPreference,
} from "@clarkcant/core";
import { GALLERY, YOUTUBE } from "@clarkcant/data-canvas";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { listLocalImages, upsertArtifact } from "@clarkcant/storage";
import { definitionDigest } from "@clarkcant/widget-host";
import { join } from "node:path";

import { createAskUserQuestionTool } from "../ask-user-question.ts";
import { attachmentRefsForLastUserMessage } from "../attachments.ts";
import { blobsDir, readBlob } from "../blobs.ts";
import { composeMiniApp } from "../compose-mini-app.ts";
import { type InteractionDeps } from "../interactions.ts";
import { writeCurrentAlias, writeModelPool } from "../model-registry.ts";
import { createNodeTools, createRememberTool, type CommandToolDeps } from "../node-tools.ts";
import { extractPdfText } from "../pdf-text.ts";
import { type ProjectFinderDeps } from "../project-finder.ts";
import { createRequestSecretTool, type RequestSecretDeps } from "../request-secret.ts";
import { commandDigest } from "../run-command.ts";
import { storeSessionPreview } from "../session-preview.ts";
import { type NodeServices } from "../services.ts";

/**
 * The deterministic composer, and the preconditions it needs to be reachable.
 *
 * A composed surface can only be produced by a turn, and a turn needs a provider - so without this the browser code
 * that renders a composed surface could never be exercised in CI. It answers only the sentences it scripts and
 * returns nothing for anything else, which leaves the scripted recipes and the model path exactly as they were.
 * Every part of the production pipeline still runs: candidates, compiler, coverage check, transactional capture,
 * timeline.
 *
 * Nothing here is a mock in the testing sense: every card it produces is written through the same tool or registry
 * the product uses, so what a journey asserts against is a row the node really holds. Where a part cannot be real -
 * there is no browser to photograph - the card says so, and the startup line says a fixture is loaded.
 *
 * This module is reached only through `bootstrap/fixtures.ts`, which imports it when a `CC_*_FIXTURE` gate is set.
 * A production node evaluates no gate and never loads the module, so none of this is in its process.
 */

/**
 * What the composer reads from the node.
 *
 * The wiring is a set of getters rather than values because the node publishes most of it after the composer is
 * built: the closure is handed to `bootNodeServices` before the services exist and is only called once a message
 * arrives, long after everything it reads has been assigned.
 */
export interface FixtureModelWiring {
  approvals: () => CoordinationDeps | undefined;
  command: () => CommandToolDeps | undefined;
  search: () => NodeServices["search"] | undefined;
  projects: () => ProjectFinderDeps | undefined;
  interactions: (conversationId: string) => InteractionDeps | undefined;
  secrets: () => RequestSecretDeps | undefined;
  compose: () => NodeServices["compose"] | undefined;
}

export interface FixtureModelDeps {
  /** The node this fixture stands in for, read when a turn asks rather than when the composer is built. */
  services: () => Pick<NodeServices, "runtime" | "conductor" | "controlSessions">;
  dataDir: string;
  wiring: FixtureModelWiring;
}

/** The shape the conductor asks for, so a fixture that stopped matching the seam would not compile. */
export type FixtureCompose = NonNullable<ConductorDeps["composeFromIntent"]>;

/**
 * The scripted composer.
 *
 * `questionCounter` distinguishes two scripted questions, because a form card's answerability is keyed by its id.
 */
export function createModelComposer(deps: FixtureModelDeps): FixtureCompose {
  let questionCounter = 0;

  const compose = async (input: {
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
      db: deps.services().runtime.db,
      conversationId: input.conversationId,
    });
    const readable = attached.filter((ref) => ref.kind === "text" || ref.kind === "pdf");
    if (readable.length > 0) {
      const quoted = readable
        .map((ref) => {
          const blob = readBlob({
            dataDir: deps.dataDir,
            blobPath: join(blobsDir(deps.dataDir), ref.blobRef),
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
     * A secret the node does not have, asked for through the real tool.
     *
     * The browser half of this cannot be reached without a provider account unless something scripts the model's
     * half, and what it has to prove is negative: the value a person types never appears in the page, the
     * conversation, or anything the model is handed afterwards.
     */
    if (/xin secret thử|thử xin secret/i.test(input.text)) {
      const secrets = deps.wiring.secrets();
      if (secrets === undefined) return undefined;
      const answer = await createRequestSecretTool(secrets).execute({
        name: "openai_api_key",
        label: "OpenAI API key",
        description: "Dùng để chạy model OpenAI trên node này.",
        secretKind: "api-key",
        consumer: "capability:openai",
      });
      if (answer.hostCard === undefined) {
        return { text: answer.text, block: { type: "text", format: "plain", content: answer.text, streaming: false } };
      }
      // SAFETY: the card was built against the credential-card schema in contracts; the adapter's shape is loose
      // because it must not depend on contracts, and the node validates blocks before they reach a transcript.
      return { text: answer.text, block: answer.hostCard as unknown as MessageBlock };
    }

    /*
     * A question the agent asks, through the real tool.
     *
     * Same reason as the command fixtures: the browser half of this feature — a card, a click, and an answer
     * that comes back as a new turn — cannot be reached without a provider account unless something scripts the
     * model's half. It calls the tool the model calls, so what the browser proves is the real path.
     */
    if (/hỏi tui chọn|thử hỏi tui/i.test(input.text)) {
      const interactions = deps.wiring.interactions(input.conversationId);
      if (interactions === undefined) return undefined;
      const answer = await createAskUserQuestionTool(interactions).execute({
        question: "Chọn môi trường triển khai.",
        kind: "single-choice",
        options: [
          { id: "staging", label: "Staging" },
          { id: "production", label: "Production" },
        ],
      });
      const asked = answer.hostBlocks?.[0];
      if (asked === undefined) {
        return { text: answer.text, block: { type: "text", format: "plain", content: answer.text, streaming: false } };
      }
      // SAFETY: the block was built by the interaction manager against the message-block union; the adapter's
      // shape is loose because it must not depend on contracts, and the node validates blocks before storing.
      return { text: answer.text, block: asked as unknown as MessageBlock };
    }

    // The turn the answer opens. Without this the request would wait for a model that is not there.
    if (/Trả lời cho câu hỏi/i.test(input.text)) {
      const reply = "Fixture: tui đã nhận câu trả lời và tiếp tục công việc.";
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    /*
     * A command that runs without a card.
     *
     * The fixture for the default policy, and the browser half of the claim this refactor rests on: a command
     * is proposed, the host preflights it, no policy layer is wired on a fixture node (so the fail-open
     * setting governs), and it runs — with no approval card anywhere in the conversation. It drives the real
     * tool rather than a scripted block, because a fixture that drew its own receipt would prove nothing about
     * the path a real command takes.
     */
    if (/chạy lệnh tự động|tự chạy lệnh/i.test(input.text)) {
      const command = deps.wiring.command();
      const search = deps.wiring.search();
      const projects = deps.wiring.projects();
      if (command === undefined || search === undefined || projects === undefined) return undefined;
      const tool = createNodeTools({ search, projects, command }).find((entry) => entry.name === "run_command");
      if (tool === undefined) return undefined;

      const answer = await tool.execute({
        command: `node -e "process.stdout.write('fixture ran')"`,
        cwd: deps.dataDir,
        why: "fixture: chứng minh lệnh chạy không cần thẻ duyệt",
      });
      const first = answer.hostBlocks?.[0];
      if (first === undefined) {
        return { text: answer.text, block: { type: "text", format: "plain", content: answer.text, streaming: false } };
      }
      // SAFETY: this is the tool-activity block the guarded run built from the message-block union; the
      // adapter's shape is loose because it must not depend on contracts, and the node validates blocks
      // before they reach a transcript.
      return { text: answer.text, block: first as unknown as MessageBlock };
    }

    /*
     * A question, scripted — the producer for the question card.
     *
     * The same reason the approval fixture exists: the browser half of this feature is a card whose answer
     * becomes the user's next message, and a card nothing can produce would leave that wiring tested by
     * nothing at all.
     */
    if (/biểu mẫu|thử form|fill a form/i.test(input.text)) {
      const formId = `form_fixture_${questionCounter += 1}`;
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
        db: deps.services().runtime.db,
        nodeId: deps.services().runtime.identity.nodeId,
        now: () => instantSchema.parse(new Date().toISOString()),
        newId: deps.services().conductor.newId,
      };
      const task = createTask(taskDeps, {
        conversationId: input.conversationId as never,
        goal: "Task do fixture tạo để thử nút dừng",
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user" as const,
          nodeId: deps.services().runtime.identity.nodeId as never,
        },
      });
      const at = instantSchema.parse(new Date().toISOString());
      return {
        text: "Đây là task do fixture tạo, không phải model thật, và chưa chạy ở đâu cả.",
        block: {
          type: "task-progress-card",
          owner: "host",
          cardId: deps.services().conductor.newId("card"),
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
          cardId: deps.services().conductor.newId("card"),
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
      const artifactId = deps.services().conductor.newId("art");
      const at = instantSchema.parse(new Date().toISOString());
      const digest = "sha256:3f786850e387550fdab836ed7e6dc881de23001b09c2f0f8b9f2f1e6c0c4a1b7";
      upsertArtifact(deps.services().runtime.db, {
        artifactId,
        digest,
        sizeBytes: 20480,
        mimeType: "application/pdf",
        classification: "internal",
        originNodeId: deps.services().runtime.identity.nodeId,
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
      const created = deps.services().controlSessions.create({
        sessionId: deps.services().conductor.newId("bs"),
        surface: "browser",
        label: "đang mở form thanh toán",
      });
      /*
       * The frame is captured, stored and referenced — not described. On a fixture node there is no browser to
       * photograph, so the capture is a fixed PNG: that proves the wiring (bytes reach the blob store, the card
       * carries a reference to them) and it does not prove a browser rendered anything. That distinction is the
       * whole reason the ledger row names which half is real.
       */
      const frame = await storeSessionPreview({
        dataDir: deps.dataDir,
        capture: () =>
          Promise.resolve({
            bytes: new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
              0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length and tag
              0x00, 0x00, 0x05, 0x00, // width 1280
              0x00, 0x00, 0x02, 0xd0, // height 720
              0x08, 0x06, 0x00, 0x00, 0x00,
            ]),
            contentType: "image/png",
            viewport: { width: 1280, height: 720 },
          }),
      });
      return {
        text: "Đây là phiên browser do fixture tạo, không phải model thật.",
        block: {
          type: "browser-session-card",
          owner: "host",
          cardId: deps.services().conductor.newId("card"),
          sessionId: created.sessionId,
          label: created.label,
          driver: created.owner,
          status: created.status,
          leaseEpoch: created.leaseEpoch,
          updatedAt: instantSchema.parse(new Date().toISOString()),
          // The state the node reports, which is what the client reads as `preview`.
          preview: created.preview,
          ...(created.previewReason === undefined ? {} : { previewReason: created.previewReason }),
          /*
           * Only when the frame was really stored. A capture that failed leaves the card without one, which the
           * interface can say out loud — the alternative is a card showing an empty box as if it were a screen.
           */
          ...(frame.ok
            ? {
                previewFrame: {
                  digest: frame.digest,
                  viewport: frame.viewport,
                  capturedAt: instantSchema.parse(new Date().toISOString()),
                },
              }
            : {}),
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
      const created = deps.services().controlSessions.create({
        sessionId: deps.services().conductor.newId("cs"),
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
          cardId: deps.services().conductor.newId("card"),
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
      const questionId = `q_fixture_${questionCounter += 1}`;
      return {
        text: "Đây là câu hỏi do fixture tạo, không phải model thật.",
        block: {
          type: "question-card",
          owner: "host",
          questionId,
          prompt: "Bạn muốn tôi mở dự án nào?",
          questionType: "single-choice",
          options: [
            { id: "option-1", label: "Dự án hiện tại", description: "thư mục này" },
            { id: "option-2", label: "Dự án khác", description: "tôi sẽ chỉ đường" },
          ],
          allowOther: false,
          voicePrompt: "Bạn muốn tôi mở dự án nào? Dự án hiện tại, hay một dự án khác?",
          status: "waiting",
          createdAt: instantSchema.parse(new Date().toISOString()),
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
      const approvals = deps.wiring.approvals();
      if (approvals === undefined) return undefined;
      const cwd = deps.dataDir;
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
      const instance = createInstance(deps.services().conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Widget trong frame (fixture)" },
      });
      saveActionBinding(deps.services().conductor, {
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
      const snapshot = captureSnapshot(deps.services().conductor, {
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
      const instance = createInstance(deps.services().conductor, {
        definition: YOUTUBE,
        packageDigest: definitionDigest(YOUTUBE),
        ownerPrincipalId: input.principal.principalId,
        props: {
          videoId: "dQw4w9WgXcQ",
          title: "Video thử (fixture)",
          description: "Fixture: một video nhúng, không phải model thật.",
        },
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
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
      const images = listLocalImages(deps.services().runtime.db, input.principal.principalId, 12);
      if (images.length === 0) {
        const empty = "Fixture: node này chưa có ảnh nào để dựng thư viện.";
        return { text: empty, block: { type: "text", format: "plain", content: empty, streaming: false } };
      }
      const instance = createInstance(deps.services().conductor, {
        definition: GALLERY,
        packageDigest: definitionDigest(GALLERY),
        ownerPrincipalId: input.principal.principalId,
        props: {
          imageRefs: images.map((image) => image.imageId),
          alts: images.map((image) => image.altText),
          title: "Thư viện ảnh (fixture)",
        },
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
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
        db: deps.services().runtime.db,
        principalId: input.principal.principalId,
        conversationId: input.conversationId,
        now: () => new Date().toISOString(),
        newId: deps.services().conductor.newId,
      });
      const remembered = await tool.execute({ kind: "preference", scope: "node", text: (asked[1] ?? "").trim() });
      const reply = `Fixture: ${remembered.text}`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    if (!/tổng quan|tong quan|overview/i.test(input.text)) return undefined;
    const compose = deps.wiring.compose();
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

  return compose;
}

/**
 * A turn control for a fixture node.
 *
 * Starting a background session is the one path a node cannot answer from a recipe: it goes through the turn control,
 * which only exists when a model turn does - and a fixture node has none by design, because it answers with scripts
 * rather than a provider. Without this, the browser half of that path is untestable: the client would report the
 * node's refusal, which is correct behaviour and not the thing a test of the selection menu should be measuring.
 *
 * It is not a model. It says so, waits a moment, and answers with a fixture sentence. The wait is the point: a session
 * that starts and finishes inside the same millisecond is a session no client can ever draw, and drawing it - the
 * chip in the header, the reply in the conversation - is exactly what the browser test asserts.
 */
export function applyScriptedTurnControl(services: Pick<NodeServices, "turnControl">): void {
  if (services.turnControl !== undefined) return;
  services.turnControl = {
    running: () => [],
    interrupt: () => false,
    steer: async () => false,
    runInBackground: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const reply = "Fixture: việc nền đã xong, tui đã đọc kết quả và tiếp tục công việc.";
      return reply;
    },
  };
}

/**
 * The scripted background control, for a fixture node that published none above.
 *
 * Left as it was, line for line, including the startup line it prints: the node's behaviour is what it was.
 */
export function applyScriptedBackgroundControl(services: NodeServices): void {
  if (services.turnControl !== undefined) return;
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

/**
 * The preconditions a fixture node arranges for itself.
 *
 * The scripted command proposal has to have somewhere to run, and a browser run must never depend on a developer's
 * real approved folders; the hotkey journey needs profiles to walk; and the pool needs the catalogue it is checked
 * against, or the fixture contradicts itself by naming providers the Models tab reports it has never heard of.
 */
export function arrangeModelNode(deps: { services: NodeServices; dataDir: string }): void {
  const { services, dataDir } = deps;
  setPreference(
    { db: services.runtime.db, now: () => new Date().toISOString() as never },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: "workspace.roots",
      scope: "global",
      value: [dataDir],
      source: "user",
    },
  );

  /*
   * A pool for the hotkey, and a current alias.
   *
   * The identifiers are the fake adapter's, and no session is created from them here, because the fixture answers
   * every turn itself.
   */
  const at = new Date().toISOString() as Instant;
  writeModelPool(
    services.runtime.db,
    services.runtime.identity.ownerPrincipalId,
    {
      profiles: [
        {
          modelProfileId: "profile_fast",
          alias: "fast",
          provider: "fake",
          modelId: "fake-model",
          enabled: true,
          roles: ["foreground"],
          priority: 10,
        },
        {
          modelProfileId: "profile_smart",
          alias: "smart",
          provider: "fake-other",
          modelId: "fake-other-model",
          enabled: true,
          roles: ["foreground", "coding"],
          priority: 20,
        },
      ],
    },
    at,
  );
  writeCurrentAlias(services.runtime.db, services.runtime.identity.ownerPrincipalId, "fast", at);

  /*
   * And the catalogue those providers are supposed to come from.
   *
   * The list is the fake adapter's, which exists for exactly this - being read on a machine with no provider
   * account - so the panel, the pool validation and the chooser all have something real to be exercised against.
   * Only when nothing else answered, so a fixture node that does build a model turn keeps its own catalogue.
   */
  services.modelCatalogue ??= () => new FakePiAdapter().catalogue();
}

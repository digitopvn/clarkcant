import {
  type CapabilityRef,
  type Instant,
  type MessageBlock,
  advanceEffect,
  instantSchema,
  platformForHost,
  widgetDefinitionSchema,
} from "@clarkcant/contracts";
import {
  HOST_API_VERSION,
  type ConductorDeps,
  type ConductorEmit,
  type CoordinationDeps,
  advanceResolving,
  applyTaskEvent,
  captureSnapshot,
  createInstance,
  createTask,
  directoryIndexPath,
  markEffectUnknown,
  modelReplyCard,
  prepareEffect,
  readExecutionPolicy,
  requestApproval,
  listInstalledPackages,
  saveActionBinding,
  setPreference,
} from "@clarkcant/core";
import { GALLERY, STATUS, TABLE, YOUTUBE } from "@clarkcant/data-canvas";
import { FakePiAdapter, type WorkerEvent } from "@clarkcant/pi-adapter";
import {
  getNotification,
  listArtifactsForConversation,
  listLocalImages,
  upsertArtifact,
  upsertDataset,
  upsertEffect,
} from "@clarkcant/storage";
import { fixturesFor } from "@clarkcant/widget-catalog";
import { definitionDigest } from "@clarkcant/widget-host";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { artifactRefFromRecord } from "../artifact-broker.ts";
import { createAskUserQuestionTool } from "../ask-user-question.ts";
import { compileWidgetAction } from "../application/action-bindings.ts";
import { capabilityInvokeDeps } from "../application/capability-invoke.ts";
import { attachmentRefsForLastUserMessage } from "../attachments.ts";
import { blobsDir, readBlob } from "../blobs.ts";
import { composeMiniApp } from "../compose-mini-app.ts";
import { sweepUnknownEffects } from "../effect-notices.ts";
import { referenceBrief, referencesForLastUserMessage } from "../composer-references.ts";
import { QUESTION_TTL_MS, type InteractionDeps, createQuestion } from "../interactions.ts";
import { sweepExpired } from "../expiry-notices.ts";
import { checkForUpdates } from "../update-checks.ts";
import { type ModelTurn, createModelTurn } from "../model-turn.ts";
import { writeCurrentAlias, writeModelPool } from "../model-registry.ts";
import { createAutomationTools } from "../automation-tools.ts";
import { controlApp, createNodeTools, createRememberTool, createSearchDirectoryTool, type CommandToolDeps } from "../node-tools.ts";
import { extractPdfText } from "../pdf-text.ts";
import { type ProjectFinderDeps, indexDirectoryPath } from "../project-finder.ts";
import { createInvokeCapabilityTool } from "../invoke-capability-tool.ts";
import { createInspectUiTool } from "../inspect-ui-tool.ts";
import { createRequestSecretTool, type RequestSecretDeps } from "../request-secret.ts";
import { commandDigest } from "../run-command.ts";
import { captureBrowserFrame, previewPageUrl } from "./browser-frame.ts";
import { type NodeServices } from "../services.ts";
import { createTaskBrowserBroker, taskProfileDir } from "../task-browser.ts";
import { buildViewCatalog } from "../view-catalog.ts";
import { conversationUiContext } from "../widget-semantic.ts";

/** The reference image generator's definition, as its package ships it, and the job capability its button calls. */
const IMAGE_GENERATOR_DEFINITION = new URL("../../../../examples/reference-apps/image-generator/widgets/main/widget.json", import.meta.url);
const IMAGE_GENERATE = "com.clarkcant.reference.image-generator.image.generate@1" as CapabilityRef;

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
  services: () => Pick<
    NodeServices,
    | "runtime"
    | "conductor"
    | "controlSessions"
    | "terminals"
    | "hostControl"
    | "serviceHost"
    | "automation"
    | "projects"
    | "skills"
    | "search"
    | "peerDelivery"
  >;
  dataDir: string;
  wiring: FixtureModelWiring;
}

/** The shape the conductor asks for, so a fixture that stopped matching the seam would not compile. */
export type FixtureCompose = NonNullable<ConductorDeps["composeFromIntent"]>;

/** How many pieces the long reply is written in, and how long each takes: about a minute, far longer than a stop. */
const LONG_REPLY_PIECES = 400;
const LONG_REPLY_PIECE_MS = 150;

/**
 * Sixty deterministic rows for the table journey: enough for six pages of ten, twelve places that each repeat five
 * times so a search narrows to a known count, and one note a spreadsheet would run as a formula.
 */
const FIXTURE_REVENUE_PLACES = [
  "Đồng Nai",
  "Hà Nội",
  "Huế",
  "Cần Thơ",
  "Đà Nẵng",
  "Hải Phòng",
  "An Giang",
  "Lâm Đồng",
  "Nghệ An",
  "Quảng Ninh",
  "Khánh Hòa",
  "Bình Dương",
];
/**
 * The sample calendar's events in October 2026, shown in Ho Chi Minh City: a timed event, one that crosses midnight, an
 * all-day event over three days, one written in Berlin time, one written with no offset at all (a time in the calendar's
 * own timezone), a single all-day day, one that ends at midnight, and a timed event on the all-day day. Fixed times, so
 * what each view draws does not depend on when the test runs or on the timezone of the node or the browser.
 */
const FIXTURE_CALENDAR_ROWS: Record<string, unknown>[] = [
  { eventId: "evt_standup", title: "Họp đầu tuần", startsAt: "2026-10-05T02:00:00Z", endsAt: "2026-10-05T03:00:00Z", timezone: "Asia/Ho_Chi_Minh" },
  { eventId: "evt_deploy", title: "Triển khai đêm", startsAt: "2026-10-06T15:00:00Z", endsAt: "2026-10-06T19:00:00Z", timezone: "Asia/Ho_Chi_Minh" },
  { eventId: "evt_offsite", title: "Hội thảo nhóm", allDay: true, startDate: "2026-10-07", endDate: "2026-10-10" },
  { eventId: "evt_berlin", title: "Gọi với Berlin", startsAt: "2026-10-08T08:00:00Z", endsAt: "2026-10-08T09:00:00Z", timezone: "Europe/Berlin" },
  { eventId: "evt_local", title: "Họp giờ địa phương", startsAt: "2026-10-09T14:00:00", endsAt: "2026-10-09T15:00:00" },
  { eventId: "evt_review", title: "Rà soát cuối ngày", startsAt: "2026-10-12T15:00:00Z", endsAt: "2026-10-12T17:00:00Z", timezone: "Asia/Ho_Chi_Minh" },
  { eventId: "evt_holiday", title: "Ngày nghỉ", allDay: true, date: "2026-10-20" },
  { eventId: "evt_lunch", title: "Ăn trưa nhóm", startsAt: "2026-10-20T05:00:00Z", endsAt: "2026-10-20T06:00:00Z", timezone: "Asia/Ho_Chi_Minh" },
];

/** The weeks the sample area chart draws; rising and distinct, as an area chart's x must be. */
const FIXTURE_RUN_WEEKS = ["W35", "W36", "W37", "W38", "W39", "W40"];
const FIXTURE_REVENUE_ROWS: Record<string, unknown>[] = Array.from({ length: 60 }, (_, index) => ({
  code: `P${String(index + 1).padStart(2, "0")}`,
  province: `${FIXTURE_REVENUE_PLACES[index % FIXTURE_REVENUE_PLACES.length] ?? ""} ${String(Math.floor(index / 12) + 1)}`,
  revenue: 100 + ((index * 73) % 900),
  growth: (((index * 17) % 41) - 20) / 100,
  updatedOn: new Date(Date.UTC(2026, 8, 1 + (index % 28))).toISOString().slice(0, 10),
  note: index === 0 ? '=HYPERLINK("http://example.invalid","xem")' : "",
}));

/**
 * A provider that writes slowly and stops when it is told to.
 *
 * The Stop journey needs a reply in flight to stop, and a fixture node has no provider to write one. This is the one
 * part that is scripted: the turn around it is the production model turn, so the stop the browser presses travels
 * the real route, the real `interrupt`, and ends with the real partial reply and label.
 */
class SlowReplyAdapter extends FakePiAdapter {
  readonly #listeners = new Map<string, Set<(event: WorkerEvent) => void>>();
  readonly #stopped = new Set<string>();

  override subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(sessionId, listeners);
    const release = super.subscribe(sessionId, listener);
    return () => {
      listeners.delete(listener);
      release();
    };
  }

  /** Stops writing. Unlike the plain fake it says nothing more, which is what a provider that honours an abort does. */
  override async abort(sessionId: string): Promise<void> {
    this.#stopped.add(sessionId);
  }

  override async prompt(sessionId: string): Promise<void> {
    this.#stopped.delete(sessionId);
    for (let piece = 1; piece <= LONG_REPLY_PIECES && !this.#stopped.has(sessionId); piece += 1) {
      for (const listener of this.#listeners.get(sessionId) ?? []) {
        listener({ type: "text-delta", sessionId, delta: `Đoạn ${String(piece)}. ` });
      }
      await new Promise((resolve) => setTimeout(resolve, LONG_REPLY_PIECE_MS));
    }
  }
}

/**
 * The model turn behind the long reply, built on first use.
 *
 * Shared by the composer that starts a reply and the turn control that stops it, which is why it lives at module
 * level: the two are built by different seams, and a stop that reached a different turn would stop nothing.
 */
let longReplyTurn: Promise<ModelTurn | undefined> | undefined;
/** The same turn once built, for the turn control, which is asked synchronously. */
let longReplyBuilt: ModelTurn | undefined;

function longReplyModelTurn(): Promise<ModelTurn | undefined> {
  longReplyTurn ??= createModelTurn({
    env: { CC_MODEL_PROVIDER: "fake", CC_MODEL_ID: "fake-model" },
    cwd: process.cwd(),
    adapter: new SlowReplyAdapter(),
  }).then((turn) => {
    longReplyBuilt = turn;
    return turn;
  });
  return longReplyTurn;
}

/**
 * A model turn whose provider answers with the prompt it was given, built on first use.
 *
 * The UI-context journey has to show what a model is told about the screen, and a fixture node has no provider to be
 * told anything. The turn is the production one, reading the node's own widget state the way the composition root
 * wires it; the only scripted part is a provider that repeats its prompt, so what the page shows is what a model would
 * have read.
 */
let uiEchoTurn: Promise<ModelTurn | undefined> | undefined;

function uiEchoModelTurn(conductor: () => NodeServices["conductor"]): Promise<ModelTurn | undefined> {
  uiEchoTurn ??= createModelTurn({
    env: { CC_MODEL_PROVIDER: "fake", CC_MODEL_ID: "fake-model" },
    cwd: process.cwd(),
    adapter: new FakePiAdapter(),
    uiContext: (conversationId) => conversationUiContext(conductor(), conversationId),
  });
  return uiEchoTurn;
}

/**
 * The `control_app` call a scripted sentence stands for, if it is one.
 *
 * Two spellings: the original "go home" sentences the voice journey says, and `agent control_app <kind> [arg]`,
 * where the argument is the tab of `settings.tab`, the alias of `model.select`, the profile of `orb.select`, the theme
 * of `appearance.set-theme` or the scheme of `appearance.set-color-scheme`, so one
 * fixture line covers every
 * kind the tool offers without a sentence per kind. Several calls separated by `;` are made one after another in
 * the same turn, the way a model may call the tool twice before it answers - which is how a journey reaches an
 * action, such as `nav.conversation`, that only means something while a panel covers the composer.
 */
export function controlAppFixtureCalls(text: string): Record<string, unknown>[] | undefined {
  if (/nhờ agent xử lý giúp tôi việc quay về màn hình bắt đầu|go home through the agent/i.test(text)) {
    return [{ kind: "nav.home" }];
  }
  const match = /^agent control_app (.+)$/i.exec(text.trim());
  if (match === null) return undefined;
  const calls: Record<string, unknown>[] = [];
  for (const part of (match[1] ?? "").split(";")) {
    const call = /^([a-z.-]+)(?: ([\w-]+))?$/i.exec(part.trim());
    if (call === null) return undefined;
    const [, kind = "", arg] = call;
    if (arg === undefined) calls.push({ kind });
    else if (kind === "model.select") calls.push({ kind, modelAlias: arg });
    else if (kind === "orb.select") calls.push({ kind, orbProfile: arg });
    else if (kind === "appearance.set-theme") calls.push({ kind, theme: arg });
    else if (kind === "appearance.set-color-scheme") calls.push({ kind, colorScheme: arg });
    else calls.push({ kind, tab: arg });
  }
  return calls;
}

/** The reference text editor's definition, as its package ships it. */
const TEXT_EDITOR_DEFINITION = new URL("../../../../examples/reference-apps/text-editor/widgets/main/widget.json", import.meta.url);

/** What the editor's rewrite button asks Clark; the fixture recognises its own button by it. */
const TEXT_EDITOR_REWRITE_INTENT =
  "Viết lại đoạn văn bản đang được chọn trong trình soạn thảo. Chỉ trả lời bằng đoạn thay thế, trong một khối ``` duy nhất.";

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
    emit?: (event: ConductorEmit) => void;
    channel?: "voice" | "chat";
    note?: string;
    data?: string;
  }): Promise<{ block: MessageBlock; text: string } | undefined> => {
    /*
     * A press of an `agent` action button, answered.
     *
     * The turn itself is the product's: the host checked the binding and started it with the button's label as the
     * person's message and the offered intent as guidance. What the fixture adds is only the reply, and it quotes the
     * intent it was given, so a journey can see that what the model was asked is what the button was made to ask. When
     * the host read context for the button, the reply quotes it too — from the turn's data section, which is where the
     * host puts it, never from the guidance note: what reached the model is what the host read.
     */
    const pressed = input.note === undefined ? null : /You offered it for: (.+?)\nDo that now\.$/su.exec(input.note);
    /*
     * The reference text editor's "rewrite the selection" button, answered with a replacement.
     *
     * The excerpt is read from the data section the host built from the editor's semantic document, never from the
     * guidance note, so the reply quotes what reached the model. The replacement is the excerpt upper-cased: a
     * deterministic change a journey can assert, inside the one fenced block the button's intent asks for.
     */
    if (pressed !== null && (pressed[1] ?? "").includes(TEXT_EDITOR_REWRITE_INTENT)) {
      const quoted = /^\s*selectedText: ("(?:[^"\\]|\\.)*")$/mu.exec(input.data ?? "");
      const excerpt = quoted === null ? undefined : (JSON.parse(quoted[1] ?? '""') as unknown);
      const reply =
        typeof excerpt !== "string" || excerpt === ""
          ? "Fixture: host không gửi đoạn nào đang được chọn, nên không có gì để viết lại."
          : `Fixture: viết lại đoạn host đọc được "${excerpt}".\n\`\`\`text\n${excerpt.toLocaleUpperCase("vi")}\n\`\`\``;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }
    if (pressed !== null) {
      const context = (input.data ?? "").split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
      const reply =
        `Fixture: đã nhận yêu cầu từ nút "${input.text}". Việc cần làm: ${(pressed[1] ?? "").trim()}` +
        (context === "" ? "" : ` Ngữ cảnh host đọc: ${context.slice(0, 600)}`);
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

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
     * The references, as the turn would brief them.
     *
     * A fixture node has no model to follow a skill, so it answers with the reference section the model turn would have
     * been given, built by the same `referenceBrief` from the same stored blocks. That proves the pipeline from the
     * picker to the prompt; it does not prove a model would follow the skill, which needs a provider.
     */
    const referenced = referencesForLastUserMessage({ db: deps.services().runtime.db, conversationId: input.conversationId });
    const skills = deps.services().skills;
    if (referenced.length > 0 && skills !== undefined) {
      const brief = await referenceBrief({
        blocks: referenced,
        projects: deps.services().projects,
        skillBody: (name, revision) => skills.body(name, revision),
        notice: (noticeId) =>
          getNotification(deps.services().runtime.db, deps.services().runtime.identity.ownerPrincipalId, noticeId)?.notice,
      });
      const reply = `Fixture: lượt này được đưa phần tham chiếu sau.\n\n${brief}`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }
    /*
     * A command proposal, scripted.
     *
     * The same reason the other fixtures exist: the browser half of this feature — a card with two
     * buttons and a receipt — needs a way to be reached without a provider account, and a fixture that
     * cannot produce the card would leave the client wiring tested by nothing at all.
     */
    /*
     * A long reply, written slowly by the production model turn - the browser half of stopping one.
     *
     * The reply the stop leaves behind is the model turn's own: its partial text, and the same card every stopped
     * turn ends with, so what the journey asserts is what a person with a provider would see.
     */
    if (/viết một câu trả lời thật dài|write a very long reply/i.test(input.text)) {
      const turn = await longReplyModelTurn();
      if (turn === undefined) return undefined;
      const reply = await turn.answer({
        conversationId: input.conversationId as never,
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user",
          nodeId: deps.services().runtime.identity.nodeId as never,
        },
        text: input.text,
        messageId: input.messageId,
        onEvent: (event) => input.emit?.(event),
      });
      const at = instantSchema.parse(new Date().toISOString());
      return { text: reply.text, block: modelReplyCard(deps.services().conductor, reply, at) };
    }

    /*
     * What the screen shows, as a model turn would be told it (#195).
     *
     * The reply is the prompt the turn built, so a journey can read whether the note about the widgets a person changed
     * arrived, whether a second question with nothing changed was told nothing, and whether a later change came as a
     * delta.
     */
    if (/^(?:giao diện đang cho thấy gì|what does the ui show)\??$/iu.test(input.text.trim())) {
      const turn = await uiEchoModelTurn(() => deps.services().conductor);
      if (turn === undefined) return undefined;
      const reply = await turn.answer({
        conversationId: input.conversationId as never,
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user",
          nodeId: deps.services().runtime.identity.nodeId as never,
        },
        text: input.text,
        messageId: input.messageId,
        onEvent: (event) => input.emit?.(event),
      });
      return { text: reply.text, block: { type: "text", format: "plain", content: reply.text, streaming: false } };
    }

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
     * A question nobody answered in time, for the inbox's "Ask again".
     *
     * A question waits fifteen minutes, which no browser test should. The card is written through the same manager a
     * turn uses, with the clock it was asked at set back past that deadline, and then the node's own expiry sweep runs
     * once instead of on its next minute: the notice the inbox shows is the one the sweep writes, naming the question.
     */
    if (/để một câu hỏi hết hạn/i.test(input.text)) {
      const interactions = deps.wiring.interactions(input.conversationId);
      if (interactions === undefined) return undefined;
      const askedAt = instantSchema.parse(new Date(Date.now() - QUESTION_TTL_MS - 60_000).toISOString());
      const asked = createQuestion(
        { ...interactions, now: () => askedAt },
        {
          question: "Chọn khu vực máy chủ cho bản thử.",
          kind: "single-choice",
          options: [
            { id: "sg", label: "Singapore" },
            { id: "hn", label: "Hà Nội" },
          ],
        },
      );
      const reply = asked.ok ? "Fixture: tui đã hỏi một câu và để nó hết hạn, không ai trả lời." : asked.message;
      if (asked.ok) sweepExpired(deps.services(), instantSchema.parse(new Date().toISOString()));
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    if (/^(?:kiểm tra giao diện|inspect the ui)$/iu.test(input.text.trim())) {
      const inspectUi = createInspectUiTool({ deps: () => deps.services().conductor, conversationId: input.conversationId });
      const result = await inspectUi.execute({ scope: "recent" });
      return { text: result.text, block: { type: "text", format: "plain", content: result.text, streaming: false } };
    }

    /*
     * An update check against a scripted directory, for the inbox's update actions.
     *
     * The browser suite's directory lists one version of each package, so nothing installed ever has an update and the
     * update notice could never be drawn. This runs the node's own check once, against a directory that offers the
     * next patch of every installed package from npm. The versions are not in the real directory, which is the point:
     * "Update" then reaches the install route and is refused by name, and nothing installed changes. The Pi half is
     * answered with a version that is not newer, so it says nothing.
     */
    if (/kiểm tra bản cập nhật thử/i.test(input.text)) {
      const services = deps.services();
      const platform = platformForHost(process.platform, process.arch);
      const now = () => instantSchema.parse(new Date().toISOString());
      const installed = listInstalledPackages({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now,
        newId: services.conductor.newId,
      });
      const report = await checkForUpdates({
        services,
        installedPackages: installed,
        directory: installed.map((view) => ({
          packageId: view.packageId,
          version: nextPatch(view.version),
          sourceKind: "npm" as const,
          lane: view.lane,
          digest: `sha256:fixture-next-${view.packageId}`,
          hostApi: { min: HOST_API_VERSION, max: HOST_API_VERSION },
          platforms: platform === undefined ? [] : [platform],
        })),
        piInstalledVersion: "1.0.0",
        fetchImpl: async () => new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }),
        now,
      });
      const reply = `Fixture: đã kiểm tra bản cập nhật thử, ${String(report.packageUpdates)} gói có bản mới.`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
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
     * The app-control tool, called the way a model turn calls it - the browser half of issue #129's voice
     * criterion.
     *
     * `controlApp` is the same function `control_app` executes with in production: same validation, same
     * audit call, same `host-control` event, and the same wait for the page's report. What is scripted is
     * only the decision to call it, which a live model made through a tool call this fixture cannot produce
     * without a provider account. Calling the same function a model turn would have called is what keeps
     * this a browser proof of `runAppIntent` reaching the page and reporting back, rather than a proof of the
     * fixture's own wiring. The reply is the tool's own answer, so a journey can read what the model was told.
     */
    const controlCalls = controlAppFixtureCalls(input.text);
    if (controlCalls !== undefined) {
      const answers: string[] = [];
      // One at a time, as a model's turn would: each call waits for the page's report before the next is made.
      for (const controlCall of controlCalls) {
        const outcome = await controlApp(
          {
            db: deps.services().runtime.db,
            nodeId: deps.services().runtime.identity.nodeId,
            now: () => instantSchema.parse(new Date().toISOString()),
            newId: deps.services().conductor.newId,
            principalId: input.principal.principalId,
            conversationId: input.conversationId as never,
            onEvent: () => input.emit,
            channel: () => input.channel ?? "chat",
            hostControl: deps.services().hostControl,
          },
          controlCall,
        );
        answers.push(outcome.say);
      }
      const reply = answers.join("\n");
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
     * A reminder set up to happen on its own, through the real tool.
     *
     * The sentence is scripted; the automation is the node's own — stored, matched against a signal a journey sends to
     * `POST /signals`, and said back in this conversation by the automation service — so the browser sees the path a
     * real standing request takes.
     */
    const standing = /^nhắc tôi khi có ([a-z0-9._-]+):\s*(.+)$/iu.exec(input.text.trim());
    if (standing !== null) {
      const services = deps.services();
      const topic = (standing[1] ?? "").toLowerCase();
      const tool = createAutomationTools({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        principalId: services.runtime.identity.ownerPrincipalId,
        conversationId: input.conversationId,
        now: () => instantSchema.parse(new Date().toISOString()),
        newId: services.conductor.newId,
        ownedRoots: () => [deps.dataDir],
        kick: () => services.automation?.kick(),
      }).find((entry) => entry.name === "create_automation");
      if (tool === undefined) return undefined;
      const answer = await tool.execute({
        summary: `Nhắc khi có ${topic}`,
        topic,
        action: "remind",
        message: (standing[2] ?? "").trim(),
      });
      return { text: answer.text, block: { type: "text", format: "plain", content: answer.text, streaming: false } };
    }
    /*
     * A terminal, opened through the real tool.
     *
     * The decision to call `terminal_open` is scripted; everything after it is the node's own path — the policy, the
     * PTY, the card — so the browser journey types into a real shell rather than a picture of one.
     */
    if (/mở terminal|open a terminal/i.test(input.text)) {
      const command = deps.wiring.command();
      const search = deps.wiring.search();
      const projects = deps.wiring.projects();
      if (command === undefined || search === undefined || projects === undefined) return undefined;
      const tool = createNodeTools({
        search,
        projects,
        command,
        terminals: {
          registry: deps.services().terminals,
          newId: deps.services().conductor.newId,
          conversationId: input.conversationId,
        },
      }).find((entry) => entry.name === "terminal_open");
      if (tool === undefined) return undefined;
      const prefill = /điền sẵn|prefill/i.test(input.text);
      const answer = await tool.execute({
        cwd: deps.dataDir,
        title: "fixture terminal",
        ...(prefill ? { command: "echo điền-sẵn" } : {}),
      });
      const first = answer.hostBlocks?.[0];
      if (first === undefined) {
        return { text: answer.text, block: { type: "text", format: "plain", content: answer.text, streaming: false } };
      }
      // SAFETY: the card `terminal_open` built against the message-block union; the node validates it before storing.
      return { text: answer.text, block: first as unknown as MessageBlock };
    }

    /*
     * A code block, a diff and a file card, placed through the same views `show_view` uses. The code holds a script tag and
     * a line far wider than a phone, so the browser journey sees both drawn as text inside the card. "bản diff sai" starts a
     * hunk at old line 0 while keeping context lines, so the refusal a model would read is the host's own sentence.
     *
     * "khối mã ẩn" and "bản diff ẩn" hold a bidi control and a zero-width space, which the page must draw as markers rather
     * than apply; the code also holds a line separator, which must count as a line so the numbers stay beside their lines.
     * "bản diff xuống dòng" puts a line separator inside one diff line, which the host refuses.
     */
    /*
     * A file card for the file a widget last fixed in this conversation: the newest picked or finalized artifact the
     * person owns here. The card carries the artifact's reference, not its bytes or a place, so opening and saving it go
     * back to the node, which checks the owner again. With none, the reply says so rather than inventing a file.
     */
    if (/^(?:đặt|place)\s+(?:thẻ tệp của widget|widget file card)$/iu.test(input.text.trim())) {
      const db = deps.services().runtime.db;
      const record = listArtifactsForConversation(db, input.conversationId)
        .filter((candidate) => candidate.state === "sealed" && candidate.ownerPrincipalId === input.principal.principalId)
        .at(-1);
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.file@1");
      if (record === undefined || view === undefined) {
        const reply = "Fixture: cuộc trò chuyện này chưa có tệp nào của widget.";
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
      const artifactRef = artifactRefFromRecord(record);
      const block = await view.build({
        props: {
          name: artifactRef.name,
          mediaType: artifactRef.mimeType,
          sizeBytes: artifactRef.sizeBytes,
          source: "Widget tệp (fixture)",
          artifactRef,
        },
        caption: "",
        at: instantSchema.parse(new Date().toISOString()),
        principal: input.principal as never,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      return { text: "Fixture: thẻ tệp của widget (không phải model thật).", block };
    }

    const viewer = /^(?:đặt|place)\s+(khối mã|khối mã ẩn|bản diff|bản diff sai|bản diff ẩn|bản diff xuống dòng|thẻ tệp)$/iu.exec(
      input.text.trim(),
    );
    if (viewer !== null) {
      const which = (viewer[1] ?? "").toLowerCase();
      const definitionId = which.startsWith("khối mã") ? "canvas.code@1" : which === "thẻ tệp" ? "canvas.file@1" : "canvas.diff@1";
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === definitionId);
      if (view === undefined) return undefined;
      const bidi = String.fromCodePoint(0x202e);
      const zeroWidth = String.fromCodePoint(0x200b);
      const lineSeparator = String.fromCodePoint(0x2028);
      const props: Record<string, unknown> =
        which === "khối mã ẩn"
          ? {
              title: "Kiểm tra quyền",
              path: "src/auth/role.ts",
              startLine: 10,
              code: [
                "// Kiểm tra quyền truy cập.",
                `const role = "user${bidi} // chỉ admin${zeroWidth}";`,
                `if (role === "admin") {${lineSeparator}  grant();`,
                "}",
              ].join("\n"),
            }
          : which === "bản diff ẩn" || which === "bản diff xuống dòng"
            ? {
                title: "Đổi quyền",
                files: [
                  {
                    path: "src/auth/role.ts",
                    hunks: [
                      {
                        oldStart: 10,
                        newStart: 10,
                        lines: [
                          { kind: "context", text: "// Kiểm tra quyền truy cập." },
                          { kind: "remove", text: 'const role = "user";' },
                          {
                            kind: "add",
                            text:
                              which === "bản diff ẩn" ? `const role = "user${bidi} // chỉ admin";` : `const role = "user";${lineSeparator}grant();`,
                          },
                        ],
                      },
                    ],
                  },
                ],
              }
            : which === "khối mã"
          ? {
              title: "Hàm định dạng tiền",
              path: "packages/billing/src/format-money.ts",
              startLine: 40,
              code: [
                "// Định dạng số tiền theo đồng Việt Nam.",
                "export function formatMoney(amount: number): string {",
                '  const note = "<script>alert(1)</script>";',
                '  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount) + " " + note.length.toString();',
                "}",
              ].join("\n"),
            }
          : which === "thẻ tệp"
            ? {
                name: "bao-cao-quy-3.pdf",
                mediaType: "application/pdf",
                sizeBytes: 482_133,
                source: "Clark tạo từ bảng doanh thu",
                path: "Tài liệu/Báo cáo/bao-cao-quy-3.pdf",
                summary: "Doanh thu quý 3, so với quý 2 và cùng kỳ năm trước.",
              }
            : {
                title: "Sửa lỗi làm tròn",
                files: [
                  {
                    path: "packages/billing/src/format-money.ts",
                    hunks: [
                      {
                        oldStart: which === "bản diff sai" ? 0 : 40,
                        newStart: 40,
                        section: "export function formatMoney(amount: number): string {",
                        lines: [
                          { kind: "context", text: "export function formatMoney(amount: number): string {" },
                          { kind: "remove", text: '  return amount.toFixed(2) + " ₫";' },
                          { kind: "add", text: '  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);' },
                          { kind: "context", text: "}" },
                        ],
                      },
                    ],
                  },
                  {
                    path: "packages/billing/test/format-money.spec.ts",
                    hunks: [
                      {
                        oldStart: 0,
                        newStart: 1,
                        lines: [
                          { kind: "add", text: 'import { formatMoney } from "../src/format-money.ts";' },
                          { kind: "add", text: 'it("rounds to whole dong", () => expect(formatMoney(1250.5)).toBe("1.251 ₫"));' },
                        ],
                      },
                    ],
                  },
                ],
              };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt ${which} (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * A form and a list, placed through the views the model's `show_view` uses.
     *
     * The proposals are scripted; the descriptors are the real ones, so the fields are checked, the action is compiled
     * with the input it accepts and the refusal of a form that asks for a secret is the host's own sentence. Both are
     * bound to Clark rather than to a package service, so they run on a node with no container engine.
     */
    const primitive = /^(?:đặt|place)\s+(biểu mẫu|biểu mẫu bí mật|danh sách|danh sách trống)$/iu.exec(input.text.trim());
    if (primitive !== null) {
      const services = deps.services();
      const which = (primitive[1] ?? "").toLowerCase();
      const catalog = buildViewCatalog(services.conductor, undefined, () => ({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        serviceHost: services.serviceHost,
        now: () => new Date().toISOString(),
        newId: services.conductor.newId,
      }));
      const isForm = which.startsWith("biểu mẫu");
      const view = catalog.find((entry) => entry.id === (isForm ? "canvas.form@1" : "canvas.list@1"));
      if (view === undefined) return undefined;
      const props: Record<string, unknown> = isForm
        ? {
            title: "Đặt lịch họp",
            description: "Clark ghi cuộc họp vào việc cần làm khi bạn gửi.",
            submitLabel: "Gửi cho Clark",
            fields:
              which === "biểu mẫu bí mật"
                ? [{ name: "password", label: "Mật khẩu email", kind: "text", required: true }]
                : [
                    { name: "topic", label: "Chủ đề", kind: "text", required: true, maxLength: 120, placeholder: "Ví dụ: rà soát quý" },
                    { name: "day", label: "Ngày họp", kind: "date", required: true },
                    { name: "start", label: "Giờ bắt đầu", kind: "time" },
                    { name: "minutes", label: "Thời lượng (phút)", kind: "slider", min: 15, max: 120, step: 15 },
                    {
                      name: "room",
                      label: "Phòng",
                      kind: "radio",
                      options: [
                        { value: "online", label: "Trực tuyến" },
                        { value: "hq", label: "Văn phòng" },
                      ],
                    },
                    {
                      name: "people",
                      label: "Người tham dự",
                      kind: "chips",
                      options: [
                        { value: "an", label: "An" },
                        { value: "binh", label: "Bình" },
                        { value: "chi", label: "Chi" },
                      ],
                    },
                    { name: "remind", label: "Nhắc trước 10 phút", kind: "toggle" },
                  ],
            action: { kind: "agent", intent: "Ghi cuộc họp này vào danh sách việc cần làm, với đúng những gì đã điền." },
          }
        : {
            title: "Việc chờ xử lý",
            selection: "multi",
            pageSize: 5,
            emptyText: "Không còn việc nào chờ.",
            items:
              which === "danh sách trống"
                ? []
                : Array.from({ length: 12 }, (_, index) => ({
                    id: `task-${String(index + 1)}`,
                    title: `Việc số ${String(index + 1)}`,
                    subtitle: index % 2 === 0 ? "Cần xem lại" : "Đang chờ phản hồi",
                    meta: `${String(index + 1)} ngày`,
                  })),
            itemActionLabel: "Nhờ Clark xử lý",
            action: { kind: "agent", intent: "Xử lý việc được chọn và báo lại kết quả." },
          };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt một ${isForm ? "biểu mẫu" : "danh sách"} (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * A status card kept by a node from before one-line labels were enforced: its label holds a line break, which this
     * node refuses. Written straight to the conductor without this node's props check, as that older node wrote it, so
     * the page's own check is what decides how it is drawn: it says it cannot read the card rather than drawing a forged
     * second line.
     */
    if (/^(?:đặt|place)\s+thẻ\s+trạng thái cũ$/iu.test(input.text.trim())) {
      const { validateProps: _thisNodesCheck, ...olderNode } = deps.services().conductor;
      const instance = createInstance(olderNode, {
        definition: STATUS,
        packageDigest: definitionDigest(STATUS),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Bản dựng cũ", label: "Dòng một\nDòng hai", tone: "info" },
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: "Bản dựng cũ: Dòng một Dòng hai (info)",
        presentationRef: `catalog:${STATUS.id}`,
      });
      return {
        text: "Fixture: một thẻ trạng thái do node cũ lưu (không phải model thật).",
        block: { type: "surface", definitionRef: { id: STATUS.id, version: STATUS.version }, snapshot },
      };
    }

    /*
     * A status, progress or details card, placed through the same views `show_view` uses. "tiến độ sai" proposes a value
     * above its maximum, so the refusal a model would read is the host's own sentence.
     */
    const card = /^(?:đặt|place)\s+thẻ\s+(trạng thái|tiến độ|các bước|chi tiết|tiến độ sai)$/iu.exec(input.text.trim());
    if (card !== null) {
      const which = (card[1] ?? "").toLowerCase();
      const catalog = buildViewCatalog(deps.services().conductor);
      const definitionId =
        which === "trạng thái" ? "canvas.status@1" : which === "chi tiết" ? "canvas.details@1" : "canvas.progress@1";
      const view = catalog.find((entry) => entry.id === definitionId);
      if (view === undefined) return undefined;
      const props: Record<string, unknown> =
        which === "trạng thái"
          ? {
              title: "Bản dựng đêm qua",
              label: "Chạy xong nhưng có 2 test chập chờn",
              tone: "warning",
              detail: "Hai test E2E phải chạy lại mới qua.",
              asOf: "2026-09-30T07:30:00+07:00",
            }
          : which === "chi tiết"
            ? {
                title: "Đơn #1042",
                items: [
                  { label: "Khách hàng", value: "Nguyễn Thị Lan" },
                  { label: "Tổng tiền", value: "1.250.000 ₫" },
                  { label: "Trạng thái", value: "Đang giao" },
                ],
              }
            : which === "các bước"
              ? {
                  title: "Chuyển nhà",
                  steps: [
                    { label: "Đóng thùng", status: "done" },
                    { label: "Chuyển đồ", status: "current" },
                    { label: "Lắp internet", status: "pending" },
                  ],
                }
              : { title: "Nhập ảnh", label: "Ảnh đã nhập", value: which === "tiến độ sai" ? 130 : 42, max: 120, unit: "ảnh" };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt thẻ ${which} (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * A browser task whose submit is never answered — a real browser, a real page and the product's own broker.
     *
     * What is scripted is the model's part and the dispatch: this fixture is a composer, not a model that calls tools,
     * so it creates the task and the broker itself rather than through `start_browser_task` and the dispatcher, and it
     * asks for the steps a worker would. The page is served by this node and never answers the form it receives, the
     * managed browser is the pack's Playwright driver, and every step goes through the broker a dispatched browser task
     * gets, so the ledger row, the task turning uncertain and the inbox notice are all written by the calls production
     * makes. A second press is asked for too, to show it is refused.
     */
    if (/gửi đơn trên trang không phản hồi|lost browser submit/iu.test(input.text)) {
      const services = deps.services();
      const now = () => instantSchema.parse(new Date().toISOString());
      const taskDeps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
      let submissions = 0;
      const page = createServer((request, response) => {
        if (request.method === "POST") {
          submissions += 1;
          request.resume();
          return; // never answered: the case the ledger exists for
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><html><head><title>Apply</title></head><body><form method="post" action="/apply">` +
            `<input name="name" aria-label="Your name"><button>Send application</button></form></body></html>`,
        );
      });
      await new Promise<void>((resolve, reject) => {
        page.once("error", reject);
        page.listen(0, "127.0.0.1", resolve);
      });
      const address = page.address();
      const origin = address === null || typeof address === "string" ? "" : `http://127.0.0.1:${String(address.port)}`;
      const task = createTask(taskDeps, {
        conversationId: input.conversationId as never,
        goal: `Gửi đơn ứng tuyển ở ${origin}/apply`,
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user" as const,
          nodeId: services.runtime.identity.nodeId as never,
        },
        // The checked list the browser tool stores: this page, which is the node's own.
        origin: { kind: "interactive", principalId: input.principal.principalId, sites: [origin] },
      });
      applyTaskEvent(taskDeps, task.taskId, "resolve.start");
      advanceResolving(taskDeps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
      applyTaskEvent(taskDeps, task.taskId, "dispatch.acknowledged");
      const ask = createTaskBrowserBroker({
        ledger: { services, taskId: task.taskId },
        conversationId: input.conversationId,
        intent: { kind: "interactive" },
        policy: () => readExecutionPolicy({ db: services.runtime.db, now }, input.principal.principalId),
        principalId: input.principal.principalId,
        allowedOrigins: [origin],
        // Nobody approved anything: the press goes ahead only while the node's policy lets it by itself.
        admission: "policy",
        profileDir: taskProfileDir(join(deps.dataDir, "browser-profiles"), task.taskId),
        answerTimeoutMs: 1500,
      });
      let outcome: string;
      try {
        const opened = await ask({ action: "open", url: `${origin}/apply` });
        const name = /^(\S+) input\S* "Your name"/mu.exec(opened.text)?.[1];
        if (opened.kind !== "done" || name === undefined) throw new Error(`the page did not open: ${opened.text}`);
        await ask({ action: "fill", ref: name, value: "Ada" });
        const observed = await ask({ action: "observe" });
        const send = /^(\S+) button "Send application" \(submits\)/mu.exec(observed.text)?.[1];
        if (send === undefined) throw new Error(`the page has no submit to press: ${observed.text}`);
        const pressed = await ask({ action: "click", ref: send });
        const again = await ask({ action: "click", ref: send });
        outcome =
          `lần bấm gửi: ${pressed.kind === "unknown" ? "chưa rõ kết quả" : pressed.kind}; ` +
          `bấm lại: ${again.kind === "refused" ? "bị từ chối" : again.kind}; trang đã nhận ${String(submissions)} lần gửi.`;
      } catch (cause) {
        outcome = `trình duyệt không chạy được (${cause instanceof Error ? cause.message.slice(0, 300) : String(cause)}).`;
      } finally {
        await ask.close();
        page.closeAllConnections();
        await new Promise<void>((resolve) => page.close(() => resolve()));
      }
      const reply =
        `Đây là việc trên trình duyệt do fixture tạo, không phải model thật — ${outcome} ` +
        `Hộp thư có một thông báo để bạn ghi nhận nếu kết quả chưa rõ.`;
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }

    /*
     * The calendar over sample events written to a dataset the person owns, placed through the same view `show_view`
     * uses, opening in the view named ("tuần", "lịch trình", or the month when none is). "tháng sai" names a month that
     * does not exist, so the refusal a model would read is the host's own sentence. "bỏ sự kiện đêm khỏi lịch mẫu"
     * rewrites the dataset without the event that crosses midnight, the way a provider that replaces its rows would.
     */
    const calendar = /^(?:đặt|place)\s+lịch mẫu(?:\s+(tuần|lịch trình|tháng sai))?$/iu.exec(input.text.trim());
    const dropNight = /^bỏ sự kiện đêm khỏi lịch mẫu$/iu.test(input.text.trim());
    if (calendar !== null || dropNight) {
      const { runtime } = deps.services();
      const rows = dropNight ? FIXTURE_CALENDAR_ROWS.filter((row) => row.eventId !== "evt_deploy") : FIXTURE_CALENDAR_ROWS;
      upsertDataset(runtime.db, {
        datasetId: "dataset_fixture_calendar",
        originNodeId: runtime.identity.nodeId,
        rowCount: rows.length,
        freshness: "sample",
        updatedAt: instantSchema.parse(new Date().toISOString()),
        document: { rows },
        ownerPrincipalId: input.principal.principalId,
      });
      if (dropNight) {
        const reply = "Fixture: lịch mẫu không còn sự kiện đêm (không phải model thật).";
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
      const which = (calendar?.[1] ?? "").toLowerCase();
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.calendar@1");
      if (view === undefined) return undefined;
      const props: Record<string, unknown> = {
        title: "Lịch nhóm (mẫu)",
        datasetRef: "dataset_fixture_calendar",
        month: which === "tháng sai" ? "2026-13" : "2026-10",
        timezone: "Asia/Ho_Chi_Minh",
        ...(which === "tuần" ? { view: "week" } : which === "lịch trình" ? { view: "agenda" } : {}),
      };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt lịch mẫu${which === "" ? "" : ` ${which}`} trên dữ liệu mẫu (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * The activity timeline from the Library's own fixture, placed through the same view `show_view` uses. "cũ trước"
     * lists the oldest first, five to a page. "trùng" repeats an entry id and "ký tự ẩn" hides a direction override in
     * a title, so the refusal a model would read is the host's own sentence.
     */
    const timeline = /^(?:đặt|place)\s+dòng thời gian(?:\s+(cũ trước|trùng|ký tự ẩn))?$/iu.exec(input.text.trim());
    if (timeline !== null) {
      const which = (timeline[1] ?? "").toLowerCase();
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.timeline@1");
      const fixture = fixturesFor("canvas.timeline@1").find((entry) => entry.id === (which === "cũ trước" ? "timeline.oldest" : "timeline.normal"));
      if (view === undefined || fixture === undefined) return undefined;
      const entries = fixture.props.entries as Record<string, unknown>[];
      const props: Record<string, unknown> =
        which === "trùng"
          ? { ...fixture.props, entries: [...entries, { ...entries[0], title: "Bản sao" }] }
          : which === "ký tự ẩn"
            ? { ...fixture.props, entries: [{ ...entries[0], title: "Đóng băng‮mã nguồn" }, ...entries.slice(1)] }
            : fixture.props;
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt dòng thời gian${which === "" ? "" : ` ${which}`} (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * The bounded tree fixture exercises the same catalog path as show_view. The malformed variants let browser
     * journeys check the host's rejection reason without relying on a provider account.
     */
    const hierarchy = /^(?:đặt|place)\s+cây phân cấp(?:\s+(trùng|quá sâu|ký tự ẩn))?$/iu.exec(input.text.trim());
    if (hierarchy !== null) {
      const which = (hierarchy[1] ?? "").toLowerCase();
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.tree@1");
      const fixture = fixturesFor("canvas.tree@1").find((entry) => entry.id === "tree.normal");
      if (view === undefined || fixture === undefined) return undefined;
      const nodes = fixture.props.nodes as Record<string, unknown>[];
      let deepNode: Record<string, unknown> = { id: "n13", label: "Mục" };
      for (let level = 12; level >= 1; level -= 1) {
        deepNode = { id: `n${String(level)}`, label: "Mục", children: [deepNode] };
      }
      const props: Record<string, unknown> =
        which === "trùng"
          ? { ...fixture.props, nodes: [...nodes, { ...nodes[0], id: "project" }] }
          : which === "quá sâu"
            ? { nodes: [deepNode] }
            : which === "ký tự ẩn"
              ? { ...fixture.props, nodes: [{ ...nodes[0], label: "Dự án ‮nói ngược" }, ...nodes.slice(1)] }
              : fixture.props;
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt cây phân cấp${which === "" ? "" : ` ${which}`} (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    // The browser journey uses the deterministic model only to place the real board descriptor; moves and saved state
    // still pass through the production renderer, host binding and revision-checked widget service.
    const boardRequest = /^(?:đặt|place)\s+bảng kanban(?:\s+(liên kết))?$/iu.exec(input.text.trim());
    if (boardRequest !== null) {
      const services = deps.services();
      const bound = boardRequest[1] !== undefined;
      const catalog = bound ? buildViewCatalog(services.conductor, undefined, () => ({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        serviceHost: services.serviceHost,
        now: () => new Date().toISOString(),
        newId: services.conductor.newId,
      })) : buildViewCatalog(services.conductor);
      const view = catalog.find((entry) => entry.id === "canvas.board@1");
      const fixture = fixturesFor("canvas.board@1").find((entry) => entry.id === "board.normal");
      if (view === undefined || fixture === undefined) return undefined;
      const block = await view.build({
        props: bound ? {
          ...fixture.props,
          action: {
            kind: "invoke",
            capabilityRef: "com.example.notes.board-move@1",
            args: {},
            bindings: ["cardId", "fromColumnId", "toColumnId", "position"].map((target) => ({ target, source: "selected-event" })),
          },
        } : fixture.props,
        caption: "",
        at: instantSchema.parse(new Date().toISOString()),
        principal: input.principal as never,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      return { text: `Fixture: đặt bảng kanban${bound ? " liên kết" : ""} (không phải model thật).`, block };
    }

    /*
     * An area or scatter chart over rows written to a dataset the person owns, placed through the same views
     * `show_view` uses. The rows are labelled `sample`, which is what they are. "lớn" draws more rows than a chart
     * holds, so the truncation label is seen; "thiếu trường" names a field the rows lack and "không phải số" plots a
     * column holding text, so the refusal a model would read is the host's own sentence.
     */
    const chart = /^(?:đặt|place)\s+biểu đồ\s+(vùng|vùng chồng|vùng co lại|phân tán|phân tán lớn|thiếu trường|không phải số)$/iu.exec(
      input.text.trim(),
    );
    /*
     * "rút gọn dữ liệu biểu đồ" keeps only the first three rows of the dataset "vùng co lại" draws, the way a provider
     * that replaces its rows would. A page still drawing the six rows it was given then asks for a point the node no
     * longer holds, and the node's refusal is what that page shows.
     */
    if (/^(?:rút gọn|shrink)\s+dữ liệu biểu đồ$/iu.test(input.text.trim())) {
      const { runtime } = deps.services();
      const rows = FIXTURE_RUN_WEEKS.slice(0, 3).map((week, index) => ({ week, runs: 120 + index * 9, failures: 3 + (index % 4) }));
      upsertDataset(runtime.db, {
        datasetId: "dataset_fixture_runs_shrinking",
        originNodeId: runtime.identity.nodeId,
        rowCount: rows.length,
        freshness: "sample",
        updatedAt: instantSchema.parse(new Date().toISOString()),
        document: { rows },
        ownerPrincipalId: input.principal.principalId,
      });
      const reply = "Fixture: dữ liệu mẫu của biểu đồ co lại còn 3 hàng (không phải model thật).";
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
    }
    if (chart !== null) {
      const which = (chart[1] ?? "").toLowerCase();
      const { runtime } = deps.services();
      const scatter = which.startsWith("phân tán");
      // A dataset per shape of rows, so writing the one with a bad row never changes what an earlier chart draws.
      const datasetId = scatter
        ? `dataset_fixture_load_${which === "phân tán lớn" ? "big" : "small"}`
        : `dataset_fixture_runs${which === "không phải số" ? "_text" : which === "vùng co lại" ? "_shrinking" : ""}`;
      const rows: Record<string, unknown>[] = scatter
        ? Array.from({ length: which === "phân tán lớn" ? 640 : 24 }, (_, index) => ({
            host: `node-${String(index + 1)}`,
            load: (index * 37) % 100,
            latency: 40 + ((index * 53) % 90),
          }))
        : FIXTURE_RUN_WEEKS.map((week, index) => ({
            week,
            runs: 120 + index * 9,
            failures: which === "không phải số" && index === 2 ? "n/a" : 3 + (index % 4),
          }));
      upsertDataset(runtime.db, {
        datasetId,
        originNodeId: runtime.identity.nodeId,
        rowCount: rows.length,
        freshness: "sample",
        updatedAt: instantSchema.parse(new Date().toISOString()),
        document: { rows },
        ownerPrincipalId: input.principal.principalId,
      });
      const definitionId = scatter ? "canvas.scatter@1" : "canvas.area@1";
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === definitionId);
      if (view === undefined) return undefined;
      const props: Record<string, unknown> = scatter
        ? {
            title: "Tải và độ trễ (mẫu)",
            datasetRef: datasetId,
            x: "load",
            y: ["latency"],
            labels: { load: "Tải", latency: "Độ trễ" },
            xUnit: "%",
            unit: "ms",
            pointLabel: "host",
          }
        : {
            title: "Lượt chạy theo tuần (mẫu)",
            datasetRef: datasetId,
            x: "week",
            ...(which === "thiếu trường"
              ? { y: ["runs", "retries"], labels: { runs: "Lượt chạy", retries: "Lượt chạy lại" } }
              : { y: ["runs", "failures"], labels: { runs: "Lượt chạy", failures: "Lượt lỗi" } }),
            unit: "lượt",
            ...(which === "vùng chồng" ? { stacked: true } : {}),
          };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: `Fixture: đặt biểu đồ ${which} trên dữ liệu mẫu (không phải model thật).`, block };
      } catch (cause) {
        const reply = `Fixture không đặt được: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
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
     * An action whose outcome nobody saw, scripted — but real rows, written by the calls the product makes.
     *
     * What is scripted is only that a push timed out: the fixture cannot reach a remote, and a node that really ran
     * `git push` against nothing would prove a network error, not a timeout. Everything after the timeout is the
     * product's own: the task runs through its machine, the effect is written down as handed off and marked unknown by
     * the same `markEffectUnknown` the command broker calls (which turns the task uncertain), and the notice is left by
     * the same sweep the node runs on its clock. The inbox's two answers then act on those rows over the real route.
     */
    if (/thao tác không rõ kết quả|unknown outcome/i.test(input.text)) {
      const services = deps.services();
      const now = () => instantSchema.parse(new Date().toISOString());
      const taskDeps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
      const task = createTask(taskDeps, {
        conversationId: input.conversationId as never,
        goal: "Đẩy nhánh fixture lên remote",
        principal: {
          principalId: input.principal.principalId as never,
          kind: "user" as const,
          nodeId: services.runtime.identity.nodeId as never,
        },
      });
      applyTaskEvent(taskDeps, task.taskId, "resolve.start");
      advanceResolving(taskDeps, task.taskId, { kind: "ready", executionNodeId: services.runtime.identity.nodeId });
      applyTaskEvent(taskDeps, task.taskId, "dispatch.acknowledged");
      const prepared = prepareEffect(taskDeps, {
        taskId: task.taskId,
        executorNodeId: services.runtime.identity.nodeId,
        category: "external-write",
        capabilityRef: "project.command.run@1" as CapabilityRef,
        intent: "git push origin fixture — (fixture)",
        operationDigest: `sha256:fixture-${task.taskId}`,
        externalSupportsDedup: false,
      });
      const submitted = advanceEffect(prepared, { to: "submitted", at: now() });
      if (submitted.ok) upsertEffect(services.runtime.db, submitted.effect);
      markEffectUnknown(taskDeps, prepared.effectId, "the command ran out of time and was stopped (fixture)");
      sweepUnknownEffects(services, now());
      const reply =
        "Đây là thao tác do fixture tạo, không phải model thật: lệnh đẩy nhánh đã hết giờ nên chưa rõ nó có hiệu lực hay " +
        "chưa. Hộp thư có một thông báo để bạn ghi nhận.";
      return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
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
       * The frame is captured from a real browser, stored and referenced — not described, and not drawn here.
       *
       * The scripted part is that this turn opened a page at all; the picture is the pack's driver photographing a
       * page the node serves, so what the card shows is bytes a browser rendered. Where there is no page to
       * photograph the frame is absent and the card says so by showing nothing, rather than showing a rectangle
       * that would be indistinguishable from a screen nobody could see.
       */
      const pageUrl = previewPageUrl(process.env);
      const frame =
        pageUrl === undefined
          ? { ok: false as const, code: "CAPTURE_FAILED" as const, message: "this node has no page for a browser session to open" }
          : await captureBrowserFrame({
              dataDir: deps.dataDir,
              nodeId: deps.services().runtime.identity.nodeId,
              pageUrl,
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
           *
           * The moment comes from the capture and not from here: a card that stamped itself would be reporting an
           * instant nobody observed, which is the same claim as showing a stale frame as the current screen.
           */
          ...(frame.ok
            ? {
                previewFrame: {
                  digest: frame.digest,
                  viewport: frame.viewport,
                  capturedAt: frame.capturedAt,
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
     * The lookup package as the real directory search lists it: from the node's directory index, through the same tool
     * a model calls, so the card shows what the listing says the package reaches before anybody presses Install.
     */
    if (/tìm gói tra từ|find the lookup package/i.test(input.text)) {
      const tool = createSearchDirectoryTool({ indexPath: directoryIndexPath(process.env), newId: (prefix) => `${prefix}_lookup` });
      const answer = await tool.execute({ query: "lookup" });
      // No directory on this node: no card, and the turn is answered the ordinary way.
      if (answer.hostCard === undefined) return undefined;
      return { text: answer.text, block: answer.hostCard as unknown as MessageBlock };
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
    /*
     * The reference text editor, placed with its own "rewrite the selection" button.
     *
     * The definition is the package's own `widget.json`, read from disk, so the instance is one the directory entry
     * serves. The button is compiled by the host's real binding compiler with the selection and the widget's semantic
     * document as its context; its id reaches the frame through props, because the frame can only press a binding the
     * instance holds and has no other way to learn its id.
     */
    if (/trình soạn thảo|text editor/i.test(input.text)) {
      const definition = widgetDefinitionSchema.parse(JSON.parse(readFileSync(TEXT_EDITOR_DEFINITION, "utf8")));
      const conductor = deps.services().conductor;
      const packageDigest = definitionDigest(definition);
      const compiled = compileWidgetAction(
        {
          db: deps.services().runtime.db,
          nodeId: deps.services().runtime.identity.nodeId,
          serviceHost: deps.services().serviceHost,
          now: () => new Date().toISOString(),
          newId: conductor.newId,
        },
        {
          definitionRef: { id: definition.id, version: definition.version, packageDigest },
          label: "Nhờ Clark viết lại đoạn đã chọn",
          action: { kind: "agent", intent: TEXT_EDITOR_REWRITE_INTENT, contextRefs: ["selection", "widget"] },
          ownerPrincipalId: input.principal.principalId,
        },
      );
      if (!compiled.ok) throw new Error(`the text editor's rewrite button did not compile: ${compiled.message}`);
      const rewriteBinding = compiled.bindTo("pending").actionBindingId;
      const instance = createInstance(conductor, {
        definition,
        packageDigest,
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Trình soạn thảo (fixture)", rewriteBinding },
      });
      saveActionBinding(conductor, compiled.bindTo(instance.instanceId));
      const snapshot = captureSnapshot(conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: trình soạn thảo văn bản mẫu, trong frame cách ly (không phải model thật).",
        block: { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot },
      };
    }

    /*
     * A widget that holds files by reference, in its own frame: the journey for `artifacts@1`. Like the frame widget
     * above, its definition agrees with the fixture package on disk (`apps/web/e2e/fixtures/artifact-widget`).
     */
    if (/widget tệp|file widget/i.test(input.text)) {
      const definition = {
        id: "com.example.artifact-widget.main@1",
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
        semanticDescription: "A widget that picks, reads, writes and saves files through the host.",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true, minHeight: 240 },
        textFallback: "Widget tệp: chọn, đọc, ghi và lưu tệp qua host; nội dung chưa xem được ở chế độ chỉ có chữ.",
        effectCategories: [],
        datasetRefs: [],
      };
      const instance = createInstance(deps.services().conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Widget tệp (fixture)" },
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: một widget giữ tệp bằng tham chiếu, trong frame cách ly (không phải model thật).",
        block: { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot },
      };
    }

    /*
     * A frame whose package was granted a profile that lets the person keep it playing out of view. What it does
     * offscreen is decided by the host from that grant and the person's press, never by the widget.
     */
    if (/widget phát|playback widget/i.test(input.text)) {
      const definition = {
        id: "com.example.playback.player@1",
        version: "1.0.0",
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
        semanticDescription: "A clock that keeps counting while its frame runs.",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true, minHeight: 160 },
        textFallback: "Đồng hồ phát: đếm khi frame của nó đang chạy.",
        effectCategories: [],
        datasetRefs: [],
      };
      const instance = createInstance(deps.services().conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Đồng hồ phát (fixture)" },
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: một widget phát trong frame cách ly (không phải model thật).",
        block: { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot },
      };
    }

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
     * An action button, placed through the view the model's `show_view` uses.
     *
     * The decision to place it is scripted; the descriptor is the real one, so the action is compiled by the host,
     * the binding is stored and the refusal of a bad proposal is the host's own sentence. `invoke` names the notes
     * package's list capability, which is served only when that package is installed and its service is running;
     * `chậm` its slow add, which a journey stops while it waits; `workflow` adds a note and then reads the list back.
     * `agent ngữ cảnh <instanceId>` asks for a summary of another widget, which the host reads from its own records.
     */
    const placed = /^(?:đặt nút|place button)\s+(agent ngữ cảnh|view|agent|invoke|workflow|chậm)(?:\s+(\S+))?$/iu.exec(input.text.trim());
    if (placed !== null) {
      const services = deps.services();
      const view = buildViewCatalog(services.conductor, undefined, () => ({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        serviceHost: services.serviceHost,
        now: () => new Date().toISOString(),
        newId: services.conductor.newId,
      })).find((entry) => entry.id === "canvas.action@1");
      if (view === undefined) return undefined;
      const kind = (placed[1] ?? "").toLowerCase();
      const props: Record<string, unknown> =
        kind === "view"
          ? {
              label: "Ghim nút này",
              description: "Giữ nút này trên kệ ghim của cuộc trò chuyện.",
              icon: "save",
              action: { kind: "view", operation: "view.save", args: {} },
            }
          : kind === "agent"
            ? {
                label: "Tóm tắt cuộc trò chuyện",
                description: "Clark tóm tắt những gì đã nói ở đây.",
                icon: "send",
                action: { kind: "agent", intent: "Tóm tắt cuộc trò chuyện này trong ba dòng." },
              }
            : kind === "agent ngữ cảnh"
              ? {
                  label: "Tóm tắt thẻ",
                  description: "Clark tóm tắt thẻ chi tiết ở trên.",
                  icon: "send",
                  action: { kind: "agent", intent: "Tóm tắt thẻ chi tiết.", contextRefs: [`widget:${placed[2] ?? ""}`] },
                }
              : kind === "invoke"
                ? {
                    label: "Tải ghi chú",
                    description: "Đọc danh sách từ dịch vụ của gói ghi chú.",
                    emphasis: "secondary",
                    icon: "refresh",
                    action: { kind: "invoke", capabilityRef: "com.example.notes.list@1", args: {} },
                  }
                : kind === "chậm"
                  ? {
                      label: "Ghi chậm",
                      description: "Ghi một ghi chú sau 30 giây, trừ khi bạn dừng trước.",
                      icon: "save",
                      action: { kind: "invoke", capabilityRef: "com.example.notes.add-slowly@1", args: { text: "ghi chậm", seconds: 30 } },
                    }
                  : {
                      label: "Ghi rồi đọc ghi chú",
                      description: "Thêm một ghi chú rồi đọc lại danh sách.",
                      icon: "play",
                      action: {
                        kind: "workflow",
                        steps: [
                          {
                            stepId: "add",
                            kind: "invoke",
                            capabilityRef: "com.example.notes.add@1",
                            args: { text: "từ quy trình" },
                            dependsOn: [],
                          },
                          { stepId: "list", kind: "invoke", capabilityRef: "com.example.notes.list@1", args: {}, dependsOn: ["add"] },
                        ],
                      },
                    };
      try {
        const block = await view.build({
          props,
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: "Fixture: đặt một nút hành động (không phải model thật).", block };
      } catch (cause) {
        const reply = `Fixture không đặt được nút: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
    }

    /*
     * The notes widget, whose buttons call its package's own service.
     *
     * The bindings are `invoke` bindings made here, because nothing in the product makes them for a package widget
     * yet: a host button is compiled from a model's proposal, but a package widget's own buttons are not. What this
     * fixture stands in for is that step, not the call. Everything after it — the binding check, the registry's
     * readiness, the capability's schema, the policy, the service in its container — is the path a real binding takes. The definition is written out for the same reason as the frame widget's: it has to agree
     * with the package's own `widget.json`.
     *
     * The binding records the generation the service host is serving now, so a later install of a different version
     * makes it stale the way a real binding would be.
     */
    if (/widget ghi chú|notes widget/i.test(input.text)) {
      const definition = {
        id: "com.example.notes.board@1",
        version: "1.0.0",
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
        semanticDescription: "Notes kept by the package's own service.",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true, minHeight: 200 },
        textFallback: "Ghi chú: danh sách ghi chú do dịch vụ của gói lưu.",
        effectCategories: ["local-write" as const],
        datasetRefs: [],
      };
      const served = deps.services().serviceHost?.serves("com.example.notes.add@1");
      const packageGeneration = served?.generationId ?? definitionDigest(definition);
      const instance = createInstance(deps.services().conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Ghi chú (fixture)" },
      });
      const bindings = [
        {
          // Fixed, because the widget's own code names them.
          actionBindingId: "binding_notes_add",
          label: "Thêm ghi chú",
          proposal: {
            kind: "invoke" as const,
            capabilityRef: "com.example.notes.add@1",
            args: {},
            bindings: [{ target: "text", source: "user-input" as const }],
          },
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
            required: ["text"],
            additionalProperties: false,
          },
          effectCategory: "local-write" as const,
        },
        {
          actionBindingId: "binding_notes_export",
          label: "Xuất ghi chú",
          proposal: {
            kind: "invoke" as const,
            capabilityRef: "com.example.notes.export@1",
            args: {},
            bindings: [
              { target: "steps", source: "user-input" as const },
              { target: "stepMs", source: "user-input" as const },
            ],
          },
          inputSchema: {
            type: "object",
            properties: { steps: { type: "integer", minimum: 1, maximum: 50 }, stepMs: { type: "integer", minimum: 10, maximum: 10000 } },
            required: ["steps", "stepMs"],
            additionalProperties: false,
          },
          effectCategory: "read" as const,
        },
        {
          actionBindingId: "binding_notes_list",
          label: "Tải danh sách",
          proposal: { kind: "invoke" as const, capabilityRef: "com.example.notes.list@1", args: {} },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          effectCategory: "read" as const,
        },
      ];
      for (const binding of bindings) {
        saveActionBinding(deps.services().conductor, {
          ...binding,
          instanceId: instance.instanceId,
          definitionId: definition.id,
          packageGeneration,
          allowedDataRefs: [],
          fixedConstraints: {},
          requiresApproval: false,
          limits: {},
          bindingDigest: `sha256:${binding.actionBindingId}`,
          createdAt: instantSchema.parse(new Date().toISOString()),
        });
      }
      const snapshot = captureSnapshot(deps.services().conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: widget ghi chú, các nút gọi dịch vụ của gói (không phải model thật).",
        block: {
          type: "surface",
          definitionRef: { id: definition.id, version: definition.version },
          snapshot,
        },
      };
    }

    /*
     * The lookup package's widget, whose one button is bound to a capability its service answers by asking the node to
     * reach a provider. Stands in for the same step as the notes widget above: the binding is scripted, and everything
     * after it — the binding check, readiness including whether the package was given its key, the service in its
     * container and the node's egress broker — is the path a real binding takes.
     */
    if (/widget tra từ|lookup widget/i.test(input.text)) {
      const definition = {
        id: "com.example.lookup.panel@1",
        version: "1.0.0",
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
        semanticDescription: "Looks words up with a provider the node reaches for the package.",
        requestedCapabilities: [],
        sizing: { compact: true, expanded: true, minHeight: 200 },
        textFallback: "Tra từ: định nghĩa do nhà cung cấp trả về qua node.",
        effectCategories: ["read" as const],
        datasetRefs: [],
      };
      const served = deps.services().serviceHost?.serves("com.example.lookup.define@1");
      const instance = createInstance(deps.services().conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Tra từ (fixture)" },
      });
      saveActionBinding(deps.services().conductor, {
        // Fixed, because the widget's own code names it.
        actionBindingId: "binding_lookup_define",
        label: "Tra từ",
        proposal: {
          kind: "invoke" as const,
          capabilityRef: "com.example.lookup.define@1",
          args: {},
          bindings: [{ target: "word", source: "user-input" as const }],
        },
        inputSchema: {
          type: "object",
          properties: { word: { type: "string", minLength: 1, maxLength: 60, pattern: "^[A-Za-z-]+$" } },
          required: ["word"],
          additionalProperties: false,
        },
        effectCategory: "read" as const,
        instanceId: instance.instanceId,
        definitionId: definition.id,
        packageGeneration: served?.generationId ?? definitionDigest(definition),
        allowedDataRefs: [],
        fixedConstraints: {},
        requiresApproval: false,
        limits: {},
        bindingDigest: "sha256:binding_lookup_define",
        createdAt: instantSchema.parse(new Date().toISOString()),
      });
      const snapshot = captureSnapshot(deps.services().conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: widget tra từ, nút gọi dịch vụ của gói qua node (không phải model thật).",
        block: {
          type: "surface",
          definitionRef: { id: definition.id, version: definition.version },
          snapshot,
        },
      };
    }

    /*
     * The reference image generator, placed with its "Tạo ảnh" button bound to the package's job capability.
     *
     * The definition is the package's own `widget.json`, read from disk, so the instance is one the directory entry
     * serves. The binding takes the prompt from the widget's state (the draft the frame keeps there), or from what the
     * press sends, which wins: a spoken "tạo ảnh" runs the draft, a click or Clark sends the prompt. Its id reaches the
     * frame through props, because the frame can only press a binding the instance holds.
     */
    if (/trình tạo ảnh|image generator/i.test(input.text)) {
      const definition = widgetDefinitionSchema.parse(JSON.parse(readFileSync(IMAGE_GENERATOR_DEFINITION, "utf8")));
      const conductor = deps.services().conductor;
      const served = deps.services().serviceHost?.serves(IMAGE_GENERATE);
      const generateBinding = conductor.newId("binding_image");
      const instance = createInstance(conductor, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: input.principal.principalId,
        props: { title: "Trình tạo ảnh (fixture)", generateBinding },
      });
      saveActionBinding(conductor, {
        actionBindingId: generateBinding,
        label: "Tạo ảnh",
        proposal: {
          kind: "invoke" as const,
          capabilityRef: IMAGE_GENERATE,
          args: {},
          bindings: [
            { target: "prompt", source: "widget-state" as const },
            { target: "prompt", source: "user-input" as const },
          ],
        },
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string", minLength: 1, maxLength: 500 } },
          additionalProperties: false,
        },
        effectCategory: "read" as const,
        instanceId: instance.instanceId,
        definitionId: definition.id,
        packageGeneration: served?.generationId ?? definitionDigest(definition),
        allowedDataRefs: [],
        fixedConstraints: {},
        requiresApproval: false,
        limits: {},
        bindingDigest: `sha256:${generateBinding}`,
        createdAt: instantSchema.parse(new Date().toISOString()),
      });
      const snapshot = captureSnapshot(conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: definition.textFallback,
        presentationRef: `isolated:${definition.id}`,
      });
      return {
        text: "Fixture: trình tạo ảnh mẫu, nút gọi dịch vụ của gói như một job (không phải model thật).",
        block: { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot },
      };
    }

    /*
     * Clark starting the image generator's job. The decision to call `invoke_capability` is scripted; the tool is the
     * real one, which starts the job through the conversation's image generator widget so that widget follows it.
     */
    const imagined = /^(?:tạo ảnh giúp tui|generate an image)\s*:\s*(.+)$/iu.exec(input.text.trim());
    if (imagined !== null) {
      const tool = createInvokeCapabilityTool({
        deps: () => capabilityInvokeDeps(deps.services()),
        conversationId: input.conversationId,
        channel: () => input.channel ?? "chat",
        widgets: () => deps.services(),
      });
      const answer = await tool.execute({ action: "invoke", ref: IMAGE_GENERATE, args: { prompt: (imagined[1] ?? "").trim() } });
      return {
        text: "Fixture: tui gọi invoke_capability (không phải model thật).",
        block: { type: "text", format: "plain", content: answer.text, streaming: false },
      };
    }

    /*
     * The agent calling the same capability the notes widget's button calls.
     *
     * The decision to call `invoke_capability` is scripted; the tool is the real one, so the gate, the policy card and
     * the service's answer are the node's own. A turn that came in by voice goes through with the voice source.
     */
    const noted = /^(?:ghi chú giúp tui|note this)\s*:?\s*(.+)$/iu.exec(input.text.trim());
    if (noted !== null || /^(?:đọc ghi chú|list my notes)\b/iu.test(input.text.trim())) {
      const tool = createInvokeCapabilityTool({
        deps: () => capabilityInvokeDeps(deps.services()),
        conversationId: input.conversationId,
        channel: () => input.channel ?? "chat",
        widgets: () => deps.services(),
      });
      const answer = await tool.execute(
        noted === null
          ? { action: "invoke", ref: "com.example.notes.list@1", args: {} }
          : { action: "invoke", ref: "com.example.notes.add@1", args: { text: (noted[1] ?? "").trim() } },
      );
      if (answer.hostCard !== undefined) {
        // SAFETY: the approval card `invokeCapability` built against the message-block union; the node validates it
        // before storing.
        return { text: answer.text, block: answer.hostCard as unknown as MessageBlock };
      }
      return {
        text: "Fixture: tui gọi invoke_capability (không phải model thật).",
        block: { type: "text", format: "plain", content: answer.text, streaming: false },
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
     * A carousel over pictures this node holds, placed through the same catalog view the model uses.
     * The browser journey supplies two local images and then checks that selection survives a pin restore.
    */
    if (/^(?:đặt|place)\s+(?:bộ ảnh|carousel)$/iu.test(input.text.trim())) {
      const recent = listLocalImages(deps.services().runtime.db, input.principal.principalId, 12);
      const images = ["First carousel image", "Second carousel image"].flatMap((altText) => {
        const image = recent.find((candidate) => candidate.altText === altText);
        return image === undefined ? [] : [image];
      });
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.carousel@1");
      if (images.length < 2 || view === undefined) {
        const reply = "Fixture: cần hai ảnh thử để dựng bộ ảnh.";
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
      const block = await view.build({
        props: {
          imageRefs: images.map((image) => image.imageId),
          alts: images.map((image) => image.altText),
          title: "Bộ ảnh (fixture)",
        },
        caption: "",
        at: instantSchema.parse(new Date().toISOString()),
        principal: input.principal as never,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      return { text: "Fixture: bộ ảnh dựng từ những ảnh node này đang giữ (không phải model thật).", block };
    }

    /*
     * A local video placed through the same catalog view the model uses, so it carries the host's playback-state
     * binding. The node has no video import yet: the browser journey answers this one reference's authenticated fetch
     * with a real WebM clip, and everything after the bytes — the object URL, the page's media policy, the player and
     * the state the node holds — is the production path.
     */
    if (/^(?:đặt|place)\s+(?:video cục bộ|local video)$/iu.test(input.text.trim())) {
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === "canvas.video@1");
      if (view === undefined) return undefined;
      const block = await view.build({
        props: { videoRef: "video_e2e_local_clip", alt: "Đoạn phim thử tám giây", title: "Video cục bộ (fixture)" },
        caption: "",
        at: instantSchema.parse(new Date().toISOString()),
        principal: input.principal as never,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      return { text: "Fixture: một video cục bộ từ tham chiếu bài kiểm thử cung cấp (không phải model thật).", block };
    }

    /*
     * A table with every part of its contract: declared columns, search, multi-select, totals, several pages and a
     * cell that is a spreadsheet formula.
     *
     * The rows are written to a real dataset owned by the person, because the export route reads the instance's own
     * dataset and nothing else: a table whose rows lived only in the fixture would have nothing to export. The data
     * is labelled `sample`, which is what it is.
     */
    if (/báo cáo doanh thu|revenue report/i.test(input.text)) {
      const { runtime, conductor } = deps.services();
      const datasetId = "dataset_fixture_revenue";
      upsertDataset(runtime.db, {
        datasetId,
        originNodeId: runtime.identity.nodeId,
        rowCount: FIXTURE_REVENUE_ROWS.length,
        freshness: "sample",
        updatedAt: instantSchema.parse(new Date().toISOString()),
        document: { rows: FIXTURE_REVENUE_ROWS },
        ownerPrincipalId: input.principal.principalId,
      });
      const instance = createInstance(conductor, {
        definition: TABLE,
        packageDigest: definitionDigest(TABLE),
        ownerPrincipalId: input.principal.principalId,
        props: {
          title: "Doanh thu theo tỉnh (fixture)",
          datasetRef: datasetId,
          pageSize: 10,
          searchable: true,
          selection: "multi",
          rowIdField: "code",
          columns: [
            { key: "province", label: "Tỉnh" },
            { key: "revenue", label: "Doanh thu", type: "number", format: { unit: "tr ₫" } },
            { key: "growth", label: "Tăng trưởng", type: "number", format: { style: "percent", decimals: 1 } },
            { key: "updatedOn", label: "Cập nhật", type: "date" },
            { key: "note", label: "Ghi chú" },
          ],
          totals: [
            { column: "revenue", fn: "sum" },
            { column: "growth", fn: "avg" },
          ],
        },
      });
      const snapshot = captureSnapshot(conductor, {
        messageId: input.messageId,
        instance,
        textAlternative: TABLE.textFallback,
        presentationRef: `catalog:${TABLE.id}`,
      });
      const reply = "Fixture: bảng doanh thu mẫu theo tỉnh, để thử sắp xếp, tìm, chọn nhiều dòng và xuất CSV (không phải model thật).";
      return {
        text: reply,
        block: { type: "surface", definitionRef: { id: TABLE.id, version: TABLE.version }, snapshot },
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
      const view = buildViewCatalog(deps.services().conductor).find((entry) => entry.id === GALLERY.id);
      if (view === undefined) return undefined;
      const block = await view.build({
        props: {
          imageRefs: images.map((image) => image.imageId),
          alts: images.map((image) => image.altText),
          title: "Thư viện ảnh (fixture)",
        },
        caption: "",
        at: instantSchema.parse(new Date().toISOString()),
        principal: input.principal as never,
        messageId: input.messageId,
        conversationId: input.conversationId,
      });
      return { text: "Fixture: thư viện ảnh dựng từ những ảnh node này đang giữ, không phải model thật.", block };
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

    /*
     * A surface the model arranges itself, proposed through the composed view's `props.layout`.
     *
     * The tree is scripted; the descriptor is the real one, so the compiler, the catalog lookup, the bounds and the
     * refusal sentence are the host's. `bảng điều khiển` is a grid of two metric tiles and a card holding a search box
     * above the table it narrows; `đầy đủ` uses every container kind; `có liên kết` connects a choice to the series a line
     * chart plots and a search box to a table through declared state; `thẻ trạng thái` puts a status, a progress and a
     * details card in the three columns of a grid; `ảnh` puts a gallery and a carousel of the person's imported pictures
     * side by side, both reporting the picture picked to one declared key; `quá sâu`, `widget lạ` and `liên kết sai` are
     * proposals the host refuses.
     */
    const arranged = /^bố cục\s+(bảng điều khiển|đầy đủ|có liên kết|liên kết sai|quá sâu|widget lạ|thẻ trạng thái|ảnh)$/iu.exec(input.text.trim());
    if (arranged !== null) {
      const compose = deps.wiring.compose();
      if (compose === undefined) return undefined;
      const view = buildViewCatalog(deps.services().conductor, compose).find((entry) => entry.id === "canvas.overview@1");
      if (view === undefined) return undefined;
      const leaf = (widget: string, props: Record<string, unknown> = {}, label?: string): Record<string, unknown> => ({
        kind: "widget",
        widget,
        props,
        ...(label === undefined ? {} : { label }),
      });
      const which = (arranged[1] ?? "").toLowerCase();
      const wired = (node: Record<string, unknown>, on?: unknown[], feed?: unknown[]): Record<string, unknown> => ({
        ...node,
        ...(on === undefined ? {} : { on }),
        ...(feed === undefined ? {} : { feed }),
      });
      const metricChoice = leaf("canvas.choice@1", {
        label: "Chỉ số trên biểu đồ",
        kind: "radio",
        options: [
          { value: "completed", label: "Việc xong" },
          { value: "created", label: "Việc tạo" },
        ],
        value: "completed",
      });
      const linkedState = {
        metric: { type: "string", initial: "completed" },
        query: { type: "string", initial: "" },
      };
      // Which pictures the two leaves show is the node's; the model names only the widgets and what they report.
      const pickPicture = [{ event: "media.select", steps: [{ op: "select-field", key: "picture", field: "selectedIndex" }] }];
      let nested: Record<string, unknown> = leaf("canvas.metrics@1");
      for (let level = 0; level < 6; level += 1) nested = { kind: "stack", children: [nested] };
      const layout: Record<string, unknown> =
        which === "bảng điều khiển"
          ? {
              kind: "grid",
              columns: 3,
              children: [
                leaf("canvas.metrics@1", { title: "Việc trong kỳ" }),
                leaf("canvas.metrics@1", { title: "Nhịp làm việc" }),
                {
                  kind: "card",
                  label: "Chi tiết theo ngày",
                  children: [
                    leaf("canvas.search@1", { label: "Tìm trong bảng", placeholder: "Ngày, số việc…" }),
                    leaf("canvas.table@1", { title: "Số việc xong theo ngày" }),
                  ],
                },
              ],
            }
          : which === "đầy đủ"
            ? {
                kind: "stack",
                children: [
                  { kind: "row", children: [leaf("canvas.metrics@1", { title: "Chỉ số" }), leaf("canvas.filter@1")] },
                  { kind: "divider" },
                  {
                    kind: "tabs",
                    label: "Xu hướng và bảng",
                    children: [
                      leaf("canvas.line@1", { title: "Xu hướng" }, "Biểu đồ"),
                      leaf("canvas.table@1", { title: "Bảng số liệu" }, "Bảng"),
                    ],
                  },
                  { kind: "split", children: [leaf("canvas.calendar@1"), leaf("canvas.cta@1")] },
                  { kind: "collapsible", label: "Thêm biểu đồ cột", children: [leaf("canvas.bar@1", { title: "Cột theo ngày" })] },
                ],
              }
            : which === "có liên kết"
              ? {
                  kind: "stack",
                  children: [
                    {
                      kind: "row",
                      children: [
                        wired(metricChoice, [{ event: "choice.change", steps: [{ op: "select-field", key: "metric", field: "value" }] }]),
                        wired(leaf("canvas.search@1", { label: "Tìm trong bảng", placeholder: "Ngày, số việc…" }), [
                          { event: "query.change", steps: [{ op: "select-field", key: "query", field: "query" }] },
                        ]),
                      ],
                    },
                    wired(leaf("canvas.line@1", { title: "Xu hướng" }), undefined, [{ op: "filter-equals", field: "series", key: "metric" }]),
                    wired(leaf("canvas.table@1", { title: "Số việc theo ngày" }), undefined, [{ op: "query", key: "query" }]),
                  ],
                }
              : which === "liên kết sai"
                ? {
                    kind: "stack",
                    children: [
                      wired(metricChoice, [{ event: "choice.change", steps: [{ op: "select-field", key: "chart", field: "value" }] }]),
                      wired(leaf("canvas.metrics@1"), undefined, [{ op: "query", key: "metric" }]),
                    ],
                  }
                : which === "quá sâu"
                  ? nested
                  : which === "thẻ trạng thái"
                    ? {
                        kind: "grid",
                        columns: 3,
                        children: [
                          leaf("canvas.status@1", { title: "Máy chủ", label: "Đang chạy", tone: "success" }),
                          leaf("canvas.progress@1", { title: "Sao lưu", label: "Tệp đã chép", value: 640, max: 1000, unit: "tệp" }),
                          leaf("canvas.details@1", {
                            title: "Đơn #1042",
                            items: [
                              { label: "Khách hàng", value: "Nguyễn Thị Lan" },
                              { label: "Địa chỉ giao hàng đầy đủ", value: "12 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh" },
                              { label: "Tổng tiền", value: "1.250.000 ₫" },
                            ],
                          }),
                        ],
                      }
                    : which === "ảnh"
                      ? {
                          kind: "split",
                          children: [
                            wired(leaf("canvas.gallery@1", { title: "Ảnh đã nhập" }), pickPicture),
                            wired(leaf("canvas.carousel@1", { title: "Đang xem" }), pickPicture),
                          ],
                        }
                      : { kind: "grid", children: [leaf("canvas.metrics@1"), leaf("canvas.sparkle@1")] };
      try {
        const block = await view.build({
          props: {
            layout,
            title:
              which === "đầy đủ"
                ? "Mọi kiểu bố cục"
                : which === "có liên kết"
                  ? "Bảng có liên kết"
                  : which === "thẻ trạng thái"
                    ? "Tình hình hôm nay"
                    : which === "ảnh"
                      ? "Ảnh của tôi"
                      : "Bảng điều khiển",
            ...(which === "có liên kết" || which === "liên kết sai" ? { state: linkedState } : {}),
            ...(which === "ảnh" ? { state: { picture: { type: "number", initial: 0 } } } : {}),
          },
          caption: "",
          at: instantSchema.parse(new Date().toISOString()),
          principal: input.principal as never,
          messageId: input.messageId,
          conversationId: input.conversationId,
        });
        return { text: "Fixture: một bố cục do model đề xuất, dựng trên dữ liệu thật của node (không phải model thật).", block };
      } catch (cause) {
        const reply = `Fixture không dựng được bố cục: ${cause instanceof Error ? cause.message : String(cause)}`;
        return { text: reply, block: { type: "text", format: "plain", content: reply, streaming: false } };
      }
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

/** The requests that already failed once on purpose, so running the same words again succeeds. */
const failedOnce = new Set<string>();

/** The next patch release of a version, for a scripted directory that offers one. */
function nextPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match === null ? "0.0.1" : `${match[1]}.${match[2]}.${String(Number(match[3]) + 1)}`;
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
    // The long reply is the one turn a fixture node runs, so it is the one a stop can reach.
    running: () => longReplyBuilt?.running() ?? [],
    interrupt: (conversationId) => longReplyBuilt?.interrupt(conversationId) ?? false,
    runningMs: (conversationId) => longReplyBuilt?.runningMs(conversationId),
    steer: async () => false,
    runInBackground: async (input) => {
      // Honours the stop like a real worker does, so a browser test can stop it and see the stop reported. A request
      // that asks for "việc nền dài" stays open for a minute, which is long enough for a browser to find and press its
      // stop; every other request finishes in a moment.
      const holdMs = input.text.includes("việc nền dài") ? 60_000 : 1_500;
      // A request that asks to fail once does, the first time its words are run: what "Try again" is for.
      const failFirst = input.text.includes("hỏng lần đầu") && !failedOnce.has(input.text);
      if (failFirst) failedOnce.add(input.text);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, holdMs);
        input.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(input.signal?.reason instanceof Error ? input.signal.reason : new Error("stopped"));
          },
          { once: true },
        );
      });
      if (failFirst) throw new Error("Fixture: lần chạy đầu hỏng có chủ ý.");
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

  // The fake adapter's skills, for the composer's slash: the same list a node with the fake model would offer.
  const skillSource = new FakePiAdapter();
  services.skills ??= {
    list: () => skillSource.skills(),
    body: (name, revision) => skillSource.skillBody(name, revision),
  };

  /*
   * One small project for the composer's `@`, inside the approved root above.
   *
   * Written into the node's own data directory, which the suite wipes before every run, so the picker has something to
   * list that is the same on every machine and never a developer's own folders. Indexed directly, as a person naming
   * the folder would, rather than waiting on the background scan.
   */
  const demo = join(dataDir, "workspace", "demo-app");
  mkdirSync(join(demo, "src"), { recursive: true });
  mkdirSync(join(demo, "docs"), { recursive: true });
  writeFileSync(join(demo, "package.json"), `${JSON.stringify({ name: "demo-app", private: true }, null, 2)}\n`);
  writeFileSync(join(demo, "README.md"), "# demo-app\n");
  writeFileSync(join(demo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(demo, "docs", "guide.md"), "# Hướng dẫn\n");
  const indexed = indexDirectoryPath(services.projects, demo);
  if (!indexed.ok) process.stderr.write(`fixture: the demo project was not indexed — ${indexed.message}\n`);
}

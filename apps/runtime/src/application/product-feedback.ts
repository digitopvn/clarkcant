import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";

import {
  type DiagnosticLine,
  type EffectRecord,
  FEEDBACK_REPOSITORY,
  type FeedbackCard,
  type FeedbackDraft,
  type FeedbackIssueRef,
  type FeedbackKind,
  type FeedbackPublication,
  type FeedbackPublishIntent,
  type FeedbackRelated,
  type FeedbackRequest,
  HANDLING_PREREQUISITES,
  type HandlingEligibility,
  type Instant,
  type IssueMention,
  type MessageBlock,
  type PhilosophyFit,
  type SafeDiagnostics,
  advanceEffect,
  feedbackMarker,
} from "@clarkcant/contracts";
import { applyTaskEvent, decideExecution, readExecutionPolicy, recordEffectExecution } from "@clarkcant/core";
import {
  activeTaskGoalsMentioningIssue,
  appendEvent,
  asJsonValue,
  getEffect,
  getFeedbackReport,
  getTask,
  insertFeedbackReport,
  payloadDigest,
  transaction,
  unsettledFeedbackReports,
  updateFeedbackReport,
  upsertEffect,
  type FeedbackReportRecord,
} from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import type { NodeServices } from "../services.ts";
import { nodeWork } from "../work-supervisor.ts";
import { type OpenedActionEffect, openActionEffect, settleActionEffect } from "./action-effects.ts";
import {
  classifyPhilosophy,
  composeIssueBody,
  composeOccurrenceComment,
  diagnosticLines,
  errorFingerprint,
  excerpt,
  issueRef,
  keywordsOf,
  localisePhilosophy,
  localiseRelated,
  manualIssueUrl,
  rankRelated,
  reportTitle,
  scrubOutbound,
} from "./feedback-compose.ts";
import {
  type FeedbackGithub,
  type FeedbackGithubClient,
  FeedbackGithubError,
  type GithubIssue,
  MarkerScanIncompleteError,
  createNodeFeedbackGithub,
} from "./feedback-github.ts";

/**
 * Product feedback, end to end (#510): the one host-owned service every way of filing a report reaches.
 *
 * `/report`, a sentence to Clark (`report_feedback`), voice, and the Feedback Composer's Create issue all end here, so
 * what is shared, how it is redacted, where it goes and what is claimed about it are decided once:
 *
 *   1. **Prepare.** The person's words, the evidence they selected and — unless they turned it off — the safe
 *      diagnostics the node already knows, each through the shared redaction, composed into an issue with only the
 *      sections somebody wrote. Its philosophy fit is classified, and GitHub is searched for what is already filed.
 *      Kept as a draft under its own `rpt_` id.
 *   2. **Publish.** One external write, in the effect ledger before it is sent: a new issue, or a comment on the open
 *      issue it duplicates. Success is claimed only after GitHub is read back and holds the report's hidden marker.
 *      A write that got no trustworthy answer is `unknown` and is found again by that marker, never sent twice.
 *   3. **Eligibility.** Whether Clark may offer to handle the issue. Every check is real; this build's last answer is
 *      that handling is not available yet, because the backend it needs (#402, #508) does not exist.
 *
 * Who decides a publish: only the person, by pressing Create issue on the host's card (a person-only route), with the
 * execution policy still able to refuse external writes. Clark, `/report bug …` and voice prepare and show; they never
 * file, so nothing a model wrote is published before the person has read it.
 */

export type FeedbackServices = Pick<NodeServices, "runtime" | "conductor" | "currentModel" | "feedbackGithub">;

type Locale = "vi" | "en";

/** How long after a write with no answer an absent marker is trusted to mean GitHub never filed it. */
export const FEEDBACK_RECONCILE_GRACE_MS = 2 * 60_000;
const CAPABILITY_REF = "clark.feedback.publish";

/** The node's GitHub for reports: the injected one (tests, the browser fixture) or the person's own. */
export function feedbackGithubOf(services: Pick<NodeServices, "runtime" | "feedbackGithub">): FeedbackGithub {
  return services.feedbackGithub ?? createNodeFeedbackGithub(services);
}

function localeOf(services: Pick<NodeServices, "runtime">, at: () => Instant): Locale {
  return preferredAppIntentLocale({ db: services.runtime.db, now: at }, services.runtime.identity.ownerPrincipalId);
}

function sayIn(locale: Locale): (vi: string, en: string) => string {
  return (vi, en) => (locale === "vi" ? vi : en);
}

let cachedVersion: string | undefined;

/** ClarkCant's own version, from the workspace manifest it runs from; `unknown` when it cannot be read. */
export function clarkVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cachedVersion = typeof manifest.version === "string" && manifest.version.length <= 40 ? manifest.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

function osName(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

/**
 * The facts this node may share about itself by default. Read from the process and the node's own settings, never
 * from the conversation: no transcript, prompt, file, environment variable, log, path or credential reaches it. The
 * error, when the report is about one, is kept as a redacted 300-character excerpt and a fingerprint.
 */
export function collectSafeDiagnostics(
  services: Pick<NodeServices, "runtime" | "currentModel">,
  request: FeedbackRequest,
  at: Instant,
): SafeDiagnostics {
  const model = services.currentModel?.();
  const scrub = (text: string): string => scrubOutbound(text, homedir());
  return {
    clarkVersion: clarkVersion(),
    os: `${osName(process.platform)} ${release()}`.slice(0, 80),
    arch: process.arch.slice(0, 20),
    runtime: `node ${process.versions.node}`.slice(0, 60),
    locale: localeOf(services, () => at),
    inputMode: request.source,
    ...(model === undefined ? {} : { provider: model.provider.slice(0, 80), model: model.id.slice(0, 120) }),
    ...(request.subsystem === undefined ? {} : { subsystem: scrub(request.subsystem).slice(0, 80) }),
    ...(request.error?.code === undefined ? {} : { errorCode: scrub(request.error.code).slice(0, 120) }),
    ...(request.error === undefined
      ? {}
      : {
          errorMessage: excerpt(scrub(request.error.message), 300),
          errorFingerprint: errorFingerprint(request.error.code, scrub(request.error.message)),
        }),
    capturedAt: at,
  };
}

export type PrepareOutcome =
  | { ok: true; draft: FeedbackDraft; diagnostics: DiagnosticLine[] }
  | { ok: false; code: "STORE_FAILED"; message: string };

async function searchRelated(
  client: FeedbackGithubClient,
  repository: string,
  query: { title: string; description: string; fingerprint?: string; now: number },
): Promise<{ related: FeedbackRelated[]; duplicateOf?: FeedbackIssueRef } | { unavailable: string }> {
  const words = keywordsOf(`${query.title} ${query.description}`, 5);
  const candidates: GithubIssue[] = [];
  try {
    if (query.fingerprint !== undefined) candidates.push(...(await client.searchIssues(`repo:${repository} is:issue ${query.fingerprint}`)));
    if (words.length > 0) candidates.push(...(await client.searchIssues(`repo:${repository} is:issue ${words.join(" OR ")}`)));
  } catch (cause) {
    return { unavailable: cause instanceof Error ? cause.message.slice(0, 300) : "GitHub search failed" };
  }
  return rankRelated(candidates, query);
}

/**
 * Prepare a report: compose, redact, classify and search, then keep it as a draft. Nothing leaves the machine here
 * except the search, which carries only keywords of the already-redacted text and the error fingerprint.
 */
export async function prepareFeedback(
  services: FeedbackServices,
  input: { request: FeedbackRequest; conversationId?: string; at: () => Instant },
): Promise<PrepareOutcome> {
  const { request } = input;
  const at = input.at();
  const home = homedir();
  const scrub = (text: string): string => scrubOutbound(text, home);
  const github = feedbackGithubOf(services);
  const reportId = services.conductor.newId("rpt");
  const diagnostics = request.includeDiagnostics ? collectSafeDiagnostics(services, request, at) : undefined;
  const title = scrub(reportTitle(request.kind, request)).slice(0, 256);
  const description = scrub(request.description);
  const philosophy: PhilosophyFit | undefined =
    request.kind === "feature" || request.philosophy !== undefined
      ? classifyPhilosophy(
          [description, request.feature?.outcome, request.feature?.proposal].filter((part) => part !== undefined).join("\n"),
          request.philosophy === undefined
            ? undefined
            : { verdict: request.philosophy.verdict, ...(request.philosophy.note === undefined ? {} : { note: scrub(request.philosophy.note) }) },
        )
      : undefined;
  const found = await searchRelated(github.reader(), github.repository, {
    title,
    description,
    ...(diagnostics?.errorFingerprint === undefined ? {} : { fingerprint: diagnostics.errorFingerprint }),
    now: Date.parse(at),
  });
  const related = "unavailable" in found ? [] : found.related;
  const duplicateOf = "unavailable" in found ? undefined : found.duplicateOf;
  const body = composeIssueBody({ reportId, request, diagnostics, related, philosophy, scrub });
  const draft: FeedbackDraft = {
    reportId,
    kind: request.kind,
    source: request.source,
    repository: github.repository,
    title,
    body,
    labels: [request.kind === "bug" ? "bug" : "enhancement"],
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(philosophy === undefined ? {} : { philosophy }),
    related,
    relatedSearch: "unavailable" in found ? { state: "unavailable", reason: found.unavailable } : { state: "checked" },
    ...(duplicateOf === undefined ? {} : { duplicateOf, occurrence: composeOccurrenceComment({ reportId, request, diagnostics, scrub }) }),
    createdAt: at,
  };
  try {
    insertFeedbackReport(services.runtime.db, {
      reportId,
      principalId: services.runtime.identity.ownerPrincipalId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      status: "draft",
      draft,
      createdAt: at,
      updatedAt: at,
    });
  } catch (cause) {
    return { ok: false, code: "STORE_FAILED", message: `the report could not be kept: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  return { ok: true, draft, diagnostics: diagnosticLines(diagnostics, localeOf(services, input.at)) };
}

/**
 * What a press asks for. `send` files the report (or, while an earlier attempt's outcome is unknown, only finds out what
 * it came to); `check` only finds out and never sends; `send-anyway` files a report whose earlier attempt can never be
 * found out, which the person chose knowing it may file twice. Nothing else publishes: Clark prepares a report and
 * shows it, and only the person's press on the host's card files it. The node never sends one again on its own.
 */
export type PublishIntent = FeedbackPublishIntent;

export type PublishOutcome =
  | { ok: true; publication: FeedbackPublication; record: FeedbackReportRecord; previousStatus: FeedbackReportRecord["status"] }
  | { ok: false; status: 404 | 409; code: string; message: string };

export interface PublishOptions {
  /** Waits between read-back attempts, in milliseconds. */
  readBackDelaysMs?: readonly number[];
  /** How long an unanswered attempt is given to appear on GitHub before its absence counts. */
  reconcileGraceMs?: number;
}

const DEFAULT_READ_BACK_DELAYS_MS = [0, 1000, 3000] as const;

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a publish of a report covers: exactly this title and body, to exactly this place. */
export function feedbackPublishDigest(draft: FeedbackDraft): string {
  return payloadDigest(
    asJsonValue({
      kind: "feedback-publish",
      reportId: draft.reportId,
      repository: draft.repository,
      title: draft.title,
      body: draft.duplicateOf === undefined ? draft.body : (draft.occurrence ?? draft.body),
      ...(draft.duplicateOf === undefined ? {} : { commentOn: draft.duplicateOf.number }),
    }),
  );
}

/**
 * Where it lands: the duplicate's issue for a comment, else the new issue. This goes into the action ledger, which is
 * written once and read by whoever looks later, in whatever language they chose then, so it is the ledger's fixed
 * English like every other entry's, never the language the node happened to be set to when the person pressed.
 */
function describeWrite(draft: FeedbackDraft): string {
  return draft.duplicateOf === undefined
    ? `Open issue “${draft.title}” on ${draft.repository}`
    : `Add another occurrence to issue #${String(draft.duplicateOf.number)} (“${draft.duplicateOf.title}”) on ${draft.repository}`;
}

function ledgerNow(): Instant {
  return new Date().toISOString() as Instant;
}

/**
 * Settle a report's effect on what GitHub was observed to hold, after the write itself went unanswered.
 *
 * Not the person's answer (`reconcileEffect` is that, and words its record as theirs): the evidence here is GitHub's
 * own list, read by the node. `unknown` moves only to `confirmed` or `failed` (`advanceEffect`), and an uncertain task
 * settles in the same write.
 */
function settleObserved(services: FeedbackServices, effect: EffectRecord, outcome: "confirmed" | "failed", evidence: string): void {
  if (effect.state !== "unknown" && effect.state !== "submitted") return;
  const deps = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: ledgerNow, newId: services.conductor.newId };
  const at = deps.now();
  const from = effect.state === "submitted" ? advanceEffect(effect, { to: "unknown", at, reason: "the write's answer was never received" }) : { ok: true as const, effect };
  if (!from.ok) return;
  const moved = advanceEffect(from.effect, { to: outcome, at, evidence: evidence.slice(0, 1000) });
  if (!moved.ok) return;
  try {
    transaction(deps.db, () => {
      upsertEffect(deps.db, moved.effect);
      const task = getTask(deps.db, effect.taskId);
      appendEvent(deps.db, {
        eventId: deps.newId("evt"),
        kind: "effect.reconciled",
        stream: "task",
        nodeId: deps.nodeId,
        ...(task === undefined ? {} : { conversationId: task.conversationId }),
        taskId: effect.taskId,
        document: { taskId: effect.taskId, effectId: effect.effectId, outcome, decidedBy: "github-read-back", source: "observed", at },
        occurredAt: at,
      });
    });
    const task = getTask(deps.db, effect.taskId);
    if (task?.state === "uncertain") applyTaskEvent(deps, effect.taskId, outcome === "confirmed" ? "reconcile.succeeded" : "reconcile.failed");
    else if (task?.state === "running") {
      applyTaskEvent(deps, effect.taskId, "run.verifying");
      applyTaskEvent(deps, effect.taskId, outcome === "confirmed" ? "verify.passed" : "verify.failed");
    }
  } catch (cause) {
    process.stderr.write(`feedback: could not settle ${effect.effectId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

type MarkerLookup =
  | { kind: "found"; issue: FeedbackIssueRef; commentUrl?: string }
  | { kind: "absent" }
  | { kind: "lookup-failed"; reason: string }
  | { kind: "inconclusive"; reason: string };

/**
 * Find the report on GitHub by its marker: the new issue it opened, or its comment on the duplicate. `attemptedAt` is
 * when the write was first handed to the ledger, which no later check moves, so the window always reaches back past
 * the moment GitHub could have created it. A new issue is looked for among the token owner's own issues only (asked of
 * GitHub once per lookup), so other traffic in the repository does not run the scan out; a list that still runs past
 * it is `inconclusive`, which checking again would not change.
 */
async function findByMarker(client: FeedbackGithubClient, draft: FeedbackDraft, attemptedAt: Instant): Promise<MarkerLookup> {
  const marker = feedbackMarker(draft.reportId);
  try {
    if (draft.duplicateOf !== undefined) {
      const comment = await client.findCommentWithMarker(draft.duplicateOf.number, marker, attemptedAt);
      return comment === undefined ? { kind: "absent" } : { kind: "found", issue: draft.duplicateOf, commentUrl: comment.url };
    }
    const creator = await client.viewerLogin();
    const issue = await client.findIssueWithMarker(marker, attemptedAt, creator);
    return issue === undefined ? { kind: "absent" } : { kind: "found", issue: issueRef(issue) };
  } catch (cause) {
    if (cause instanceof MarkerScanIncompleteError) return { kind: "inconclusive", reason: cause.message };
    return { kind: "lookup-failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function save(
  services: FeedbackServices,
  record: FeedbackReportRecord,
  status: FeedbackReportRecord["status"],
  publication: FeedbackPublication,
  effectId?: string,
): FeedbackReportRecord {
  const at = ledgerNow();
  const moved = updateFeedbackReport(services.runtime.db, { reportId: record.reportId, status, publication, ...(effectId === undefined ? {} : { effectId }), at });
  // Already published by a concurrent attempt: what GitHub was read back holding wins.
  if (!moved) return getFeedbackReport(services.runtime.db, record.reportId) ?? record;
  return { ...record, status, publication, ...(effectId === undefined ? {} : { effectId }), updatedAt: at };
}

function published(record: FeedbackReportRecord, found: { issue: FeedbackIssueRef; commentUrl?: string }): FeedbackPublication {
  return {
    status: "published",
    reportId: record.reportId,
    mode: record.draft.duplicateOf === undefined ? "created" : "commented",
    issue: found.issue,
    ...(found.commentUrl === undefined ? {} : { commentUrl: found.commentUrl }),
    confirmedAt: ledgerNow(),
  };
}

function settled(record: FeedbackReportRecord, previousStatus: FeedbackReportRecord["status"]): PublishOutcome {
  return { ok: true, publication: record.publication as FeedbackPublication, record, previousStatus };
}

/**
 * Find out what an attempt whose answer never arrived came to, without sending anything.
 *
 * Found by its marker: published. GitHub unreadable, GitHub having answered that it filed it, or too little time since
 * the attempt for an absence to mean anything: still unknown. Absent from GitHub's own list well after the attempt:
 * it was never filed, which is `failed` and retryable — the person's Send again is then the first time it is filed.
 * The time measured is the attempt's own, from the ledger, so checking again and again never moves it. When checking
 * cannot settle it (GitHub's list runs past the scan, or the ledger no longer holds the attempt, so an absence means
 * nothing) it is `unknown` and `inconclusive`: said as such, with the links for the person to look themselves.
 */
async function reconcileAttempt(
  services: FeedbackServices,
  record: FeedbackReportRecord,
  client: FeedbackGithubClient,
  say: (vi: string, en: string) => string,
  options: PublishOptions,
): Promise<FeedbackReportRecord> {
  const effect = record.effectId === undefined ? undefined : getEffect(services.runtime.db, record.effectId);
  // Without the ledger entry the search still runs from the report's last change: a marker found is proof whatever the
  // window, while a marker not found proves nothing and is answered as unknown below.
  const attemptedAt = effect?.preparedAt ?? record.updatedAt;
  const lookup = await findByMarker(client, record.draft, attemptedAt);
  if (lookup.kind === "found") {
    if (effect !== undefined) settleObserved(services, effect, "confirmed", `GitHub holds the report's marker in #${String(lookup.issue.number)}`);
    return save(services, record, "published", published(record, lookup));
  }
  if (lookup.kind === "lookup-failed") {
    return save(services, record, "unknown", {
      status: "unknown",
      reportId: record.reportId,
      reason: say(
        `Chưa kiểm tra được GitHub (${lookup.reason}). Báo cáo không được gửi lại cho tới khi biết chắc.`,
        `GitHub could not be checked (${lookup.reason}). The report is not sent again until it is known.`,
      ).slice(0, 600),
    });
  }
  if (lookup.kind === "inconclusive" || effect === undefined) {
    // The draft's own time is never later than any attempt to send it, so the person's list from then holds it if GitHub does.
    return save(services, record, "unknown", inconclusiveAttempt(record, effect?.preparedAt ?? record.draft.createdAt, say));
  }
  const settledFiled = effect.state === "confirmed";
  const tooSoon = Date.now() - Date.parse(attemptedAt) < (options.reconcileGraceMs ?? FEEDBACK_RECONCILE_GRACE_MS);
  if (settledFiled || tooSoon) {
    return save(services, record, "unknown", {
      status: "unknown",
      reportId: record.reportId,
      reason: (settledFiled
        ? say(
            "GitHub đã trả lời là đã nhận, nhưng chưa tìm thấy báo cáo theo dấu của nó. Kiểm tra lại sau ít phút.",
            "GitHub answered that it was filed, but the report cannot be found by its marker yet. Check again in a few minutes.",
          )
        : say(
            "Chưa thấy báo cáo trên GitHub. Có thể GitHub vẫn đang xử lý; kiểm tra lại sau ít phút. Báo cáo không được gửi lại trước đó.",
            "The report is not on GitHub yet. GitHub may still be processing it; check again in a few minutes. It is not sent again before then.",
          )
      ).slice(0, 600),
    });
  }
  settleObserved(services, effect, "failed", "GitHub's list holds no issue or comment with the report's marker");
  return save(services, record, "failed", {
    status: "failed",
    reportId: record.reportId,
    reason: say(
      "GitHub không có báo cáo này: lần gửi trước chưa tới nơi. Chưa có gì được tạo; Gửi lại sẽ gửi nó lần đầu.",
      "GitHub does not hold this report: the earlier attempt never arrived. Nothing was created; Send again files it for the first time.",
    ).slice(0, 600),
    retryable: true,
  });
}

/** GitHub's prefilled new-issue page for the report, or the duplicate's issue its comment would go on. */
function manualUrlOf(draft: FeedbackDraft): string {
  return draft.duplicateOf === undefined ? manualIssueUrl(draft.repository, draft.title, draft.body, draft.labels) : draft.duplicateOf.url;
}

/** An attempt checking cannot settle: said plainly, with where the person can look and file by hand. */
function inconclusiveAttempt(record: FeedbackReportRecord, since: Instant, say: (vi: string, en: string) => string): FeedbackPublication {
  const draft = record.draft;
  const day = since.slice(0, 10);
  const query = draft.duplicateOf === undefined ? `is:issue author:@me created:>=${day}` : `is:issue commenter:@me updated:>=${day}`;
  return {
    status: "unknown",
    reportId: record.reportId,
    reason: say(
      "Clark không thể biết GitHub đã giữ báo cáo này hay chưa, và kiểm tra lại cũng không thay đổi được điều đó.",
      "Clark can't tell whether GitHub kept this report, and checking again won't change that.",
    ),
    inconclusive: {
      since,
      searchUrl: `https://github.com/${draft.repository}/issues?q=${encodeURIComponent(query)}`,
      manualUrl: manualUrlOf(draft),
    },
  };
}

function isInconclusive(record: FeedbackReportRecord): boolean {
  return record.status === "unknown" && record.publication?.status === "unknown" && record.publication.inconclusive !== undefined;
}

/**
 * Publish a prepared report on the person's press, or find out what an earlier publish of it came to.
 *
 * The press is the person's decision, and the execution policy still has its say: a policy that refuses external
 * writes, or prohibits effects, refuses this one too; one that would ask first is answered by the press itself. A
 * report already published answers with what it is. One sent before without a trustworthy answer is only looked for,
 * never sent again from here (`reconcileAttempt`), unless checking cannot settle it and the person pressed Send anyway.
 */
export async function publishFeedback(
  services: FeedbackServices,
  input: { reportId: string; conversationId: string; intent: PublishIntent; at: () => Instant },
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  let record = getFeedbackReport(services.runtime.db, input.reportId);
  if (record === undefined || record.principalId !== services.runtime.identity.ownerPrincipalId) {
    return { ok: false, status: 404, code: "REPORT_NOT_FOUND", message: `no report ${input.reportId} on this node` };
  }
  const previousStatus = record.status;
  if (record.status === "published" && record.publication?.status === "published") return settled(record, previousStatus);
  const github = feedbackGithubOf(services);
  const locale = localeOf(services, input.at);
  const say = sayIn(locale);
  const draft = record.draft;
  if (draft.repository !== FEEDBACK_REPOSITORY && services.feedbackGithub === undefined) {
    return { ok: false, status: 409, code: "WRONG_REPOSITORY", message: `reports go to ${FEEDBACK_REPOSITORY} only` };
  }

  const anyway = input.intent === "send-anyway";
  if (anyway && !isInconclusive(record)) {
    return {
      ok: false,
      status: 409,
      code: "NOT_INCONCLUSIVE",
      message: "Send anyway is only for a report whose earlier attempt cannot be found out; this one can be sent or checked",
    };
  }
  // An earlier attempt that never got a trustworthy answer: find out, and send nothing.
  if (!anyway && (record.status === "publishing" || record.status === "unknown")) {
    return settled(await reconcileAttempt(services, record, github.reader(), say, options), previousStatus);
  }
  if (input.intent === "check") {
    // Nothing was sent that could be looked for: the report stands as it is.
    return record.publication === undefined
      ? { ok: false, status: 409, code: "NOTHING_SENT", message: "this report has not been sent, so there is nothing on GitHub to look for" }
      : settled(record, previousStatus);
  }

  // The person pressed; the execution policy decides whether a press may write to GitHub on this node.
  const operationDigest = feedbackPublishDigest(draft);
  const description = describeWrite(draft);
  const execution = readExecutionPolicy({ db: services.runtime.db, now: input.at }, services.runtime.identity.ownerPrincipalId);
  const asked = decideExecution({
    policy: execution,
    action: { kind: "effect", category: "external-write", operationDigest },
    intent: { kind: "interactive" },
  });
  if (asked.kind === "deny") {
    const refused: FeedbackPublication = { status: "refused", reportId: record.reportId, reason: asked.reason.slice(0, 600) };
    // A refused Send anyway sends nothing and changes nothing: the earlier attempt is still beyond checking, and saying
    // otherwise on the report would let a later plain send file it again without the warning.
    if (anyway) return { ok: true, publication: refused, record, previousStatus };
    record = save(services, record, "draft", refused);
    return settled(record, previousStatus);
  }
  // The question an "ask" policy would put is the one the person just answered by pressing on the host's card.
  const pressed = anyway
    ? "the person pressed Send anyway on the host's card, knowing an earlier attempt may already have filed it"
    : "the person pressed to file it on the host's card";
  const decision = asked.kind === "ask" ? { kind: "execute" as const, reason: pressed, audit: true } : asked;
  recordEffectExecution(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: input.at, newId: services.conductor.newId },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      mode: execution.mode,
      decision,
      category: "external-write",
      operationDigest,
      conversationId: input.conversationId,
      description,
      approvedBy: "person",
    },
  );

  const current = record;
  const attempt = github.withWriter((client) => sendAndReadBack(services, client, current, input.conversationId, description, options));
  if (!attempt.ok) {
    record = save(services, record, "draft", {
      status: "needs-access",
      reportId: record.reportId,
      reason: say(
        `Chưa gửi được: ${attempt.reason}. Thêm token GitHub (secret “github_token”) để Clark gửi giúp, hoặc tự mở issue với nội dung đã chuẩn bị.`,
        `Not filed: ${attempt.reason}. Add a GitHub token (secret “github_token”) for Clark to file it, or open the issue yourself with the prepared text.`,
      ).slice(0, 600),
      manualUrl: manualUrlOf(draft),
    });
    return settled(record, previousStatus);
  }
  return settled(await attempt.result, previousStatus);
}

/** The write itself, inside the token's one use: ledger first, then GitHub, then GitHub read back. */
async function sendAndReadBack(
  services: FeedbackServices,
  client: FeedbackGithubClient,
  record: FeedbackReportRecord,
  conversationId: string,
  description: string,
  options: PublishOptions,
): Promise<FeedbackReportRecord> {
  const draft = record.draft;
  const say = sayIn(localeOf(services, ledgerNow));
  let opened: OpenedActionEffect;
  try {
    opened = openActionEffect(services, {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      capabilityRef: CAPABILITY_REF,
      args: { reportId: draft.reportId, repository: draft.repository, ...(draft.duplicateOf === undefined ? {} : { commentOn: draft.duplicateOf.number }) },
      intent: description,
      effectCategory: "external-write",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return save(services, record, "failed", {
      status: "failed",
      reportId: record.reportId,
      reason: say(`Chưa gửi: không ghi được vào sổ hiệu ứng (${reason}).`, `Not sent: the effect ledger could not hold it (${reason}).`).slice(0, 600),
      retryable: true,
    });
  }
  const attemptedAt = opened.effect.preparedAt;
  let sending = save(services, record, "publishing", { status: "unknown", reportId: record.reportId, reason: "sending" }, opened.effect.effectId);

  let written: { issueNumber: number; commentId?: number };
  try {
    if (draft.duplicateOf === undefined) {
      const issue = await client.createIssue({ title: draft.title, body: draft.body, labels: draft.labels });
      written = { issueNumber: issue.number };
    } else {
      const comment = await client.createComment(draft.duplicateOf.number, draft.occurrence ?? draft.body);
      written = { issueNumber: draft.duplicateOf.number, commentId: comment.id };
    }
  } catch (cause) {
    const failure = cause instanceof FeedbackGithubError ? cause : new FeedbackGithubError("no-answer", cause instanceof Error ? cause.message : String(cause));
    if (failure.kind !== "no-answer") {
      settleActionEffect(services, opened, {
        kind: "not-sent",
        reason: failure.kind === "refused" ? `GitHub refused it, so nothing was filed (${failure.message})` : failure.message,
      });
      return save(services, sending, "failed", {
        status: "failed",
        reportId: record.reportId,
        reason: say(`Không gửi được: ${failure.message}. Không có gì được tạo.`, `Not filed: ${failure.message}. Nothing was created.`).slice(0, 600),
        retryable: failure.retryable,
      });
    }
    // Sent, and no answer to trust. Look once now; otherwise it is unknown and found again by its marker.
    const lookup = await findByMarker(client, draft, attemptedAt);
    if (lookup.kind === "found") {
      settleActionEffect(services, opened, { kind: "answered", evidence: `GitHub holds the report's marker in #${String(lookup.issue.number)}` });
      return save(services, sending, "published", published(sending, lookup));
    }
    settleActionEffect(services, opened, { kind: "no-answer", stopped: false, reason: failure.message });
    return save(services, sending, "unknown", {
      status: "unknown",
      reportId: record.reportId,
      reason: say(
        `Đã gửi nhưng GitHub không trả lời rõ (${failure.message}). Clark sẽ tìm lại theo dấu của báo cáo, không gửi lại.`,
        `Sent, but GitHub's answer never arrived (${failure.message}). Clark finds it again by the report's marker and does not send it twice.`,
      ).slice(0, 600),
    });
  }

  // GitHub answered. Success is what reading it back shows, not what the answer said.
  const marker = feedbackMarker(draft.reportId);
  for (const delay of options.readBackDelaysMs ?? DEFAULT_READ_BACK_DELAYS_MS) {
    await sleep(delay);
    try {
      if (written.commentId !== undefined) {
        const comment = await client.getComment(written.commentId);
        if (comment !== undefined && comment.body.includes(marker) && draft.duplicateOf !== undefined) {
          settleActionEffect(services, opened, { kind: "answered", evidence: `read back comment ${comment.url} with the report's marker` });
          return save(services, sending, "published", published(sending, { issue: draft.duplicateOf, commentUrl: comment.url }));
        }
      } else {
        const issue = await client.getIssue(written.issueNumber);
        if (issue !== undefined && issue.body.includes(marker)) {
          settleActionEffect(services, opened, { kind: "answered", evidence: `read back #${String(issue.number)} with the report's marker` });
          return save(services, sending, "published", published(sending, { issue: issueRef(issue) }));
        }
      }
    } catch {
      // A read that failed is another attempt, not an answer.
    }
  }
  // GitHub said it was filed; it could not be read back yet. The ledger keeps GitHub's answer; the report stays unknown.
  settleActionEffect(services, opened, { kind: "answered", evidence: `GitHub answered with #${String(written.issueNumber)}; reading it back did not succeed yet` });
  sending = save(services, sending, "unknown", {
    status: "unknown",
    reportId: record.reportId,
    reason: say(
      `GitHub trả lời là đã nhận (#${String(written.issueNumber)}) nhưng chưa đọc lại được. Kiểm tra lại sau ít phút.`,
      `GitHub answered with #${String(written.issueNumber)}, but it could not be read back yet. Check again in a few minutes.`,
    ).slice(0, 600),
  });
  return sending;
}

const BLOCKER_MENTION = /(?:blocked by|depends on|waiting on|bị chặn bởi|phụ thuộc(?: vào)?)\s+#(\d{1,7})/giu;

/**
 * Whether Clark may offer to handle issue `#issueNumber` now, checked against GitHub as it is, in the order a person
 * would rule it out. Every check must pass before the last one — and the last one, in this build, never does: the
 * canonical background execution backend (#402) and the `dev` release contract (#508) it needs are not available yet.
 * So this never returns `eligible: true` today, and nothing offers a Handle button.
 */
export async function checkHandlingEligibility(
  services: Pick<NodeServices, "runtime" | "feedbackGithub">,
  input: { issueNumber: number; philosophy?: PhilosophyFit; at: () => Instant },
): Promise<HandlingEligibility> {
  const say = sayIn(localeOf(services, input.at));
  const github = feedbackGithubOf(services);
  const client = github.reader();
  const no = (
    code: Extract<HandlingEligibility, { eligible: false }>["code"],
    reason: string,
    blockers: IssueMention[] = [],
    suggestion?: "plan-split",
  ): HandlingEligibility => ({
    eligible: false,
    code,
    reason: reason.slice(0, 600),
    blockers: blockers.slice(0, 10),
    ...(suggestion === undefined ? {} : { suggestion }),
  });
  let issue: GithubIssue | undefined;
  try {
    issue = await client.getIssue(input.issueNumber);
  } catch (cause) {
    return no("unreadable", say(`Chưa đọc được issue #${String(input.issueNumber)}: ${cause instanceof Error ? cause.message : String(cause)}.`, `Issue #${String(input.issueNumber)} could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`));
  }
  if (issue === undefined || issue.isPullRequest) {
    return no("unreadable", say(`GitHub không có issue #${String(input.issueNumber)} trong ${github.repository}.`, `GitHub has no issue #${String(input.issueNumber)} in ${github.repository}.`));
  }
  if (!issue.url.startsWith(`https://github.com/${github.repository}/issues/`)) {
    return no("wrong-repository", say(`Issue này không thuộc ${github.repository}.`, `This issue is not in ${github.repository}.`));
  }
  if (issue.state === "closed") return no("issue-closed", say("Issue đã đóng.", "The issue is closed."));
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (/^epic\b/iu.test(issue.title) || labels.includes("epic")) {
    return no("epic", say("Đây là một epic: cần lập kế hoạch và chia nhỏ trước, không xử lý trong một lần.", "This is an epic: it is planned and split first, not handled in one change."), [], "plan-split");
  }
  if (issue.assignees.length > 0) {
    return no("assigned", say(`Issue đã có người nhận (${issue.assignees.join(", ")}).`, `The issue is assigned (${issue.assignees.join(", ")}).`));
  }
  if (labels.includes("in progress") || labels.includes("in review")) {
    return no("in-progress", say("Issue đang được làm hoặc review.", "The issue is already in progress or in review."));
  }
  const mentioned = [...issue.body.matchAll(BLOCKER_MENTION)].map((match) => Number(match[1])).filter((n) => n !== issue.number);
  if (labels.includes("external-gate")) {
    return no("external-gate", say("Issue chờ một điều kiện bên ngoài (external-gate).", "The issue waits on an external gate."));
  }
  if (labels.includes("blocked")) {
    return no("blocked", say("Issue đang bị chặn.", "The issue is blocked."), mentioned.map((number) => ({ number })));
  }
  let activity: Awaited<ReturnType<FeedbackGithubClient["issueActivity"]>>;
  try {
    activity = await client.issueActivity(issue.number);
  } catch (cause) {
    return no("unreadable", say(`Chưa đọc được hoạt động của issue: ${cause instanceof Error ? cause.message : String(cause)}.`, `The issue's activity could not be read: ${cause instanceof Error ? cause.message : String(cause)}.`));
  }
  if (activity.openPullRequests.length > 0) {
    return no("open-pull-request", say("Đã có pull request đang mở cho issue này.", "An open pull request already references this issue."), activity.openPullRequests);
  }
  if (activity.claimedBy !== undefined) {
    return no("in-progress", say(`${activity.claimedBy} đã nhận issue này trong bình luận.`, `${activity.claimedBy} has claimed this issue in a comment.`));
  }
  const openBlockers: IssueMention[] = [];
  for (const number of mentioned.slice(0, 5)) {
    try {
      const blocker = await client.getIssue(number);
      if (blocker !== undefined && blocker.state === "open") openBlockers.push({ number, title: blocker.title.slice(0, 300), url: blocker.url });
    } catch {
      openBlockers.push({ number });
    }
  }
  if (openBlockers.length > 0) {
    return no("blocked", say("Issue phụ thuộc vào việc khác chưa xong.", "The issue depends on work that is still open."), openBlockers);
  }
  const busy = [
    ...activeTaskGoalsMentioningIssue(services.runtime.db, issue.number),
    ...nodeWork()
      .list()
      .map((view) => view.title)
      .filter((title) => new RegExp(`#${String(issue.number)}(?!\\d)`, "u").test(title)),
  ];
  if (busy.length > 0) {
    return no("active-clark-work", say("Clark đang có việc dở dang cho issue này.", "Clark already has work under way on this issue."));
  }
  if (input.philosophy?.verdict === "material-conflict") {
    return no(
      "philosophy-conflict",
      say(
        "Yêu cầu xung đột với triết lý sản phẩm; cần người quyết định đổi triết lý, chọn hướng tương thích hoặc từ chối.",
        "The request conflicts with the product philosophy; a person decides whether to change it, adopt a compatible alternative, or decline.",
      ),
    );
  }
  return no(
    "handling-unavailable",
    say(
      "Clark chưa thể tự xử lý issue: backend chạy nền chuẩn (#402) và hợp đồng nhánh dev/phát hành (#508) chưa có.",
      "Clark cannot handle issues yet: the canonical background execution backend (#402) and the dev-branch release contract (#508) are not available.",
    ),
    [...HANDLING_PREREQUISITES],
  );
}

/** The Feedback Composer, summoned blank into the conversation: kind, starting words, and exactly what would be shared. */
export function feedbackComposeCard(
  services: FeedbackServices,
  input: { kind?: FeedbackKind; description?: string; source: FeedbackRequest["source"]; at: () => Instant },
): FeedbackCard {
  const at = input.at();
  const preview = collectSafeDiagnostics(services, { kind: input.kind ?? "bug", description: "-", source: input.source, includeDiagnostics: true }, at);
  return {
    type: "feedback-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    stage: "compose",
    repository: feedbackGithubOf(services).repository,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.description === undefined || input.description.trim() === "" ? {} : { description: input.description.trim().slice(0, 4000) }),
    diagnostics: diagnosticLines(preview, localeOf(services, input.at)),
    updatedAt: at,
  };
}

/**
 * A prepared report as the host's composer card: the exact redacted issue — or the comment on the open issue it
 * duplicates — that Create issue would file, what goes with it, and what was found already filed. The card is the
 * only way this report is filed: the person reads it and presses, or nothing is sent.
 */
export function feedbackDraftCard(services: FeedbackServices, input: { draft: FeedbackDraft; at: () => Instant }): FeedbackCard {
  const { draft } = input;
  const locale = localeOf(services, input.at);
  return {
    type: "feedback-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    stage: "compose",
    repository: draft.repository,
    kind: draft.kind,
    diagnostics: diagnosticLines(draft.diagnostics, locale),
    reportId: draft.reportId,
    title: draft.title,
    preview: {
      body: draft.duplicateOf === undefined ? draft.body : (draft.occurrence ?? draft.body),
      ...(draft.duplicateOf === undefined ? {} : { duplicateOf: draft.duplicateOf }),
      ...(draft.relatedSearch.state === "unavailable" ? { searchUnavailable: draft.relatedSearch.reason.slice(0, 300) } : {}),
    },
    related: localiseRelated(draft.related, locale),
    ...(draft.philosophy === undefined ? {} : { philosophy: localisePhilosophy(draft.philosophy, locale) }),
    updatedAt: input.at(),
  };
}

/** What a publish came to, as the host's card, written when it happened. */
export function feedbackResultCard(
  services: FeedbackServices,
  input: { record: FeedbackReportRecord; publication: FeedbackPublication; eligibility?: HandlingEligibility; answers?: string; at: () => Instant },
): FeedbackCard {
  const { draft } = input.record;
  const locale = localeOf(services, input.at);
  return {
    type: "feedback-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    stage: "result",
    repository: draft.repository,
    kind: draft.kind,
    diagnostics: diagnosticLines(draft.diagnostics, locale),
    reportId: draft.reportId,
    title: draft.title,
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    publication: input.publication,
    related: localiseRelated(draft.related, locale),
    ...(draft.philosophy === undefined ? {} : { philosophy: localisePhilosophy(draft.philosophy, locale) }),
    ...(input.eligibility === undefined ? {} : { eligibility: input.eligibility }),
    updatedAt: input.at(),
  };
}

/** One sentence about a publication, in the person's language: what is known, and nothing more. */
export function describePublication(publication: FeedbackPublication, locale: Locale): string {
  const say = sayIn(locale);
  switch (publication.status) {
    case "published":
      return publication.mode === "created"
        ? say(`Đã tạo issue #${String(publication.issue.number)}: ${publication.issue.url}`, `Opened issue #${String(publication.issue.number)}: ${publication.issue.url}`)
        : say(
            `Đã có issue trùng đang mở, nên Clark thêm lần gặp này vào #${String(publication.issue.number)}: ${publication.commentUrl ?? publication.issue.url}`,
            `An open issue already covers this, so Clark added this occurrence to #${String(publication.issue.number)}: ${publication.commentUrl ?? publication.issue.url}`,
          );
    case "unknown":
      return publication.inconclusive === undefined
        ? say(`Chưa biết kết quả: ${publication.reason}`, `Outcome not known yet: ${publication.reason}`)
        : say(
            `${publication.reason} Xem các issue bạn đã mở trên GitHub (${publication.inconclusive.searchUrl}); nếu không có, bạn có thể tự gửi hoặc bấm Vẫn gửi, dù có thể tạo trùng.`,
            `${publication.reason} Look through the issues you opened on GitHub (${publication.inconclusive.searchUrl}); if it is not there, file it yourself or press Send anyway, which may file it twice.`,
          );
    case "failed":
      return say(`Chưa gửi được báo cáo. ${publication.reason}`, `The report was not filed. ${publication.reason}`);
    case "needs-access":
      return publication.reason;
    case "refused":
      return say(`Chính sách thực thi không cho gửi lên GitHub: ${publication.reason}. Chưa có gì được gửi.`, `Your execution policy does not allow writing to GitHub: ${publication.reason}. Nothing was sent.`);
  }
}

/** The issue a publication landed in, when it landed. */
function landedIssue(publication: FeedbackPublication): number | undefined {
  return publication.status === "published" ? publication.issue.number : undefined;
}

/**
 * Prepare a report and show it: the one thing `/report bug …`, `report_feedback` and voice do. Nothing is sent. The
 * answer is the host's composer card holding the exact redacted issue; the person's Create issue on it is what files it,
 * so text a model wrote never leaves the machine unseen.
 */
export async function composeFeedback(
  services: FeedbackServices,
  input: { request: FeedbackRequest; conversationId: string; at: () => Instant },
): Promise<{ ok: true; text: string; blocks: MessageBlock[]; draft: FeedbackDraft } | { ok: false; text: string }> {
  const prepared = await prepareFeedback(services, { request: input.request, conversationId: input.conversationId, at: input.at });
  if (!prepared.ok) return { ok: false, text: prepared.message };
  const say = sayIn(localeOf(services, input.at));
  const { draft } = prepared;
  const where =
    draft.duplicateOf === undefined
      ? say(`một issue mới trên ${draft.repository}`, `a new issue on ${draft.repository}`)
      : say(
          `một bình luận trên issue #${String(draft.duplicateOf.number)} đang mở mà nó trùng`,
          `a comment on #${String(draft.duplicateOf.number)}, the open issue it duplicates`,
        );
  return {
    ok: true,
    text: say(
      `Báo cáo đã sẵn sàng, đúng như sẽ được gửi: ${where}. Chưa có gì được gửi; bấm Tạo issue trên thẻ để gửi.`,
      `The report is ready, exactly as it would be filed: ${where}. Nothing has been sent; press Create issue on the card to file it.`,
    ),
    blocks: [feedbackDraftCard(services, { draft, at: input.at }) as MessageBlock],
    draft,
  };
}

/** Publish an existing report on the person's press, or check on it, and describe it, with eligibility when it landed. */
export async function publishAndDescribe(
  services: FeedbackServices,
  input: { reportId: string; conversationId: string; intent: PublishIntent; answers?: string; at: () => Instant },
  options: PublishOptions = {},
): Promise<
  | {
      ok: true;
      text: string;
      blocks: MessageBlock[];
      publication: FeedbackPublication;
      eligibility?: HandlingEligibility;
      previousStatus: FeedbackReportRecord["status"];
    }
  | { ok: false; text: string; status: number; code: string }
> {
  const locale = localeOf(services, input.at);
  const outcome = await publishFeedback(services, input, options);
  if (!outcome.ok) return { ok: false, text: outcome.message, status: outcome.status, code: outcome.code };
  const issueNumber = landedIssue(outcome.publication);
  const eligibility =
    issueNumber === undefined
      ? undefined
      : await checkHandlingEligibility(services, {
          issueNumber,
          ...(outcome.record.draft.philosophy === undefined ? {} : { philosophy: outcome.record.draft.philosophy }),
          at: input.at,
        });
  const card = feedbackResultCard(services, {
    record: outcome.record,
    publication: outcome.publication,
    ...(eligibility === undefined ? {} : { eligibility }),
    ...(input.answers === undefined ? {} : { answers: input.answers }),
    at: input.at,
  });
  return {
    ok: true,
    text: describePublication(outcome.publication, locale),
    blocks: [card as MessageBlock],
    publication: outcome.publication,
    ...(eligibility === undefined ? {} : { eligibility }),
    previousStatus: outcome.previousStatus,
  };
}

/**
 * After a restart: every report a send was handed off for and that GitHub has not yet been seen to hold is looked for
 * by its marker — never sent — and what it came to is said in its conversation when that is news: always for one the
 * node stopped in the middle of sending (nobody was told anything), and for one already known as unknown only when it
 * has since settled.
 */
export async function reconcileUnsettledFeedback(
  services: FeedbackServices,
  input: { at: () => Instant; announce: (conversationId: string, text: string, blocks: MessageBlock[]) => void },
  options: PublishOptions = {},
): Promise<{ checked: number; announced: number }> {
  let checked = 0;
  let announced = 0;
  for (const record of unsettledFeedbackReports(services.runtime.db)) {
    if (record.principalId !== services.runtime.identity.ownerPrincipalId) continue;
    const effect = record.effectId === undefined ? undefined : getEffect(services.runtime.db, record.effectId);
    const conversationId = record.conversationId ?? (effect === undefined ? undefined : getTask(services.runtime.db, effect.taskId)?.conversationId);
    const described = await publishAndDescribe(
      services,
      { reportId: record.reportId, conversationId: conversationId ?? "", intent: "check", at: input.at },
      options,
    );
    checked += 1;
    if (!described.ok || conversationId === undefined) continue;
    // Worth saying: an attempt that died mid-send, an outcome now settled, or one now known to be beyond checking.
    const nowInconclusive = described.publication.status === "unknown" && described.publication.inconclusive !== undefined;
    const news =
      described.previousStatus === "publishing" || described.publication.status !== "unknown" || (nowInconclusive && !isInconclusive(record));
    if (!news) continue;
    try {
      input.announce(conversationId, described.text, described.blocks);
      announced += 1;
    } catch (cause) {
      process.stderr.write(`feedback: could not write what ${record.reportId} came to (${cause instanceof Error ? cause.message : String(cause)})\n`);
    }
  }
  return { checked, announced };
}

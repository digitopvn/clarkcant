import { createHash } from "node:crypto";

import {
  type DiagnosticLine,
  type FeedbackIssueRef,
  type FeedbackKind,
  type FeedbackRelated,
  type FeedbackRequest,
  type PhilosophyFit,
  type PhilosophyVerdict,
  type SafeDiagnostics,
  feedbackMarker,
  redactSecrets,
} from "@clarkcant/contracts";

import type { GithubIssue } from "./feedback-github.ts";

/**
 * The pure half of product reports (#510): what is shared, how it reads, how it fits the product, and what it matches.
 *
 * Nothing here reaches the network, the database or the clock; the service in `product-feedback.ts` hands it what the
 * node knows. That is what lets every rule below be tested on its own: a report never gains a section nobody wrote,
 * never carries a secret the shared redaction knows the shape of, and never names this machine's home directory.
 */

type Locale = "vi" | "en";

/**
 * Make text safe to leave the machine: the shared secret redaction (`redactSecrets`, the same patterns every other
 * outbound path uses), then the home directory, which no pattern can know, replaced by `~`.
 */
export function scrubOutbound(text: string, homeDirectory: string | undefined): string {
  let clean = redactSecrets(text);
  if (homeDirectory !== undefined && homeDirectory.length > 3) {
    for (const form of new Set([homeDirectory, homeDirectory.replace(/\\/gu, "/"), homeDirectory.replace(/\//gu, "\\")])) {
      clean = clean.split(form).join("~");
    }
  }
  return clean;
}

/** Text cut to `max` characters on a word where one is near, with an ellipsis when anything was cut. */
export function excerpt(text: string, max: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  if (single.length <= max) return single;
  const cut = single.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Twelve hex characters of a digest of the error with what varies between two occurrences of the same failure taken
 * out: numbers, ids, quoted values. Two reports of the same failure then share a fingerprint the search can match.
 */
export function errorFingerprint(code: string | undefined, message: string): string {
  const normalised = `${code ?? ""}|${message}`
    .toLowerCase()
    .replace(/[a-z]+_[a-z0-9]{6,}/gu, "<id>")
    .replace(/"[^"]*"|'[^']*'|“[^”]*”/gu, "<value>")
    .replace(/\d+/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 12);
}

/** The diagnostics as a person reads them in "what will be shared", in their language. */
export function diagnosticLines(diagnostics: SafeDiagnostics | undefined, locale: Locale): DiagnosticLine[] {
  if (diagnostics === undefined) return [];
  const say = (vi: string, en: string): string => (locale === "vi" ? vi : en);
  const lines: Array<[string, string | undefined]> = [
    [say("Phiên bản ClarkCant", "ClarkCant version"), diagnostics.clarkVersion],
    [say("Hệ điều hành", "Operating system"), `${diagnostics.os} (${diagnostics.arch})`],
    [say("Runtime", "Runtime"), diagnostics.runtime],
    [say("Ngôn ngữ / cách nhập", "Language / input"), `${diagnostics.locale} · ${diagnostics.inputMode}`],
    [say("Model", "Model"), diagnostics.provider === undefined ? undefined : `${diagnostics.provider}${diagnostics.model === undefined ? "" : ` / ${diagnostics.model}`}`],
    [say("Phần liên quan", "Subsystem"), diagnostics.subsystem],
    [say("Mã lỗi", "Error code"), diagnostics.errorCode],
    [say("Lỗi (đã che bí mật)", "Error (redacted)"), diagnostics.errorMessage],
    [say("Dấu vân lỗi", "Error fingerprint"), diagnostics.errorFingerprint],
    [say("Thời điểm", "Captured at"), diagnostics.capturedAt],
  ];
  return lines.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value: excerpt(value, 300) }]));
}

/**
 * The product's invariants a request can run into, by what it asks for. Each rule names the invariant it touches and
 * whether meeting it is a constraint on the implementation or a conflict with the product itself. Matched in English and
 * Vietnamese, with and without diacritics.
 */
interface PhilosophyRule {
  pattern: RegExp;
  verdict: Exclude<PhilosophyVerdict, "aligned">;
  invariant: string;
  note: string;
}

const PHILOSOPHY_RULES: readonly PhilosophyRule[] = [
  {
    pattern: /\b(sidebar|side bar|dashboard|thanh b[eê]n|b[aả]ng (?:đ|d)i[eề]u khi[eể]n|permanent (?:panel|picker)|session picker)\b/iu,
    verdict: "aligned-with-constraints",
    invariant: "Conversation stays the primary surface",
    note: "Deliver it as something summoned into the conversation (a slash command, a sentence or voice returning a widget), not as permanent chrome.",
  },
  {
    pattern: /\b(always (?:ask|confirm)|confirm(?:ation)? (?:before|for) every|h[oỏ]i (?:l[aạ]i )?tr[uư][oớ]c m[oọ]i|lu[oô]n h[oỏ]i)\b/iu,
    verdict: "aligned-with-constraints",
    invariant: "Autonomy by default; Jev/policy owns escalation",
    note: "Express it as an execution-policy preference the person sets, not a confirmation added in one feature.",
  },
  {
    pattern: /\b(remove|delete|hide|drop|b[oỏ]|x[oó]a|[aẩ]n) (?:the )?(?:animated )?orb\b/iu,
    verdict: "material-conflict",
    invariant: "The animated Orb is ClarkCant's signature identity",
    note: "The Orb stays; personalization may change its palette, effects and motion, and reduced motion always wins.",
  },
  {
    pattern: /\b(widgets?|extensions?|plugins?)\b[^.]{0,60}\b(secrets?|tokens?|api keys?|credentials?|cookies?|raw ipc)\b/iu,
    verdict: "material-conflict",
    invariant: "Untrusted widgets never receive raw secrets, privileged cookies or generic IPC",
    note: "Use a host-owned capability or a scoped, short-lived token through the broker instead of handing the secret over.",
  },
  {
    pattern: /\b(bypass|skip) (?:the )?(?:code )?review|push (?:directly )?to main|hot[- ]?patch(?:ing)? (?:itself|the running)|self[- ]?approv/iu,
    verdict: "material-conflict",
    invariant: "No AI surface approves its own privileged action; code changes go through a pull request",
    note: "Self-improvement goes through an issue, a branch and a reviewed pull request, never a direct change to the running product.",
  },
  {
    pattern: /\b(only on|just for|mac[- ]?only|windows[- ]?only|linux[- ]?only|ch[iỉ] (?:tr[eê]n|cho) (?:mac|windows|linux))\b/iu,
    verdict: "aligned-with-constraints",
    invariant: "Cross-platform by default",
    note: "Keep the logic portable and put the platform part behind an adapter, with explicit behaviour on the other systems.",
  },
  {
    pattern: /\b(ignore|disable|b[oỏ] qua) (?:the )?reduced[- ]motion\b/iu,
    verdict: "material-conflict",
    invariant: "Reduced motion always wins",
    note: "Motion can be personalized, but a person's reduced-motion setting is never overridden.",
  },
];

const VERDICT_RANK: Record<PhilosophyVerdict, number> = { aligned: 0, "aligned-with-constraints": 1, "material-conflict": 2 };

/**
 * A request's fit with the product philosophy: the host's own rules, and the model's reading when one was given. The
 * stricter of the two stands, so a model can raise a concern but cannot talk one away.
 */
export function classifyPhilosophy(text: string, model: FeedbackRequest["philosophy"]): PhilosophyFit {
  const constraints = PHILOSOPHY_RULES.filter((rule) => rule.pattern.test(text));
  let verdict: PhilosophyVerdict = "aligned";
  for (const rule of constraints) if (VERDICT_RANK[rule.verdict] > VERDICT_RANK[verdict]) verdict = rule.verdict;
  if (model !== undefined && VERDICT_RANK[model.verdict] > VERDICT_RANK[verdict]) verdict = model.verdict;
  return {
    verdict,
    constraints: constraints.map((rule) => ({ invariant: rule.invariant, note: rule.note })),
    ...(model?.note === undefined ? {} : { assessment: model.note }),
  };
}

const STOP_WORDS = new Set(
  (
    "the a an and or but if then when while of to in on for with without from by at as is are was were be been it its this that these those " +
    "i me my we our you your he she they them not no can cannot could should would will do does did have has had please clark clarkcant " +
    "bug feature request report issue problem error fails failed failing work works working " +
    "và hoặc nhưng nếu thì khi của cho với trong trên từ là bị được không có này đó tôi tui mình bạn lỗi tính năng muốn cần hãy"
  ).split(" "),
);

/** The words worth searching on: lower case, no stop words, each at least three characters, the first `limit`. */
export function keywordsOf(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  for (const word of text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}_-]+/u)) {
    if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/u.test(word)) continue;
    seen.add(word);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

function wordSet(text: string): Set<string> {
  return new Set(keywordsOf(text, 40));
}

/** How alike two texts are, by the share of their search words they have in common (0 to 1). */
export function similarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

const DUPLICATE_SCORE = 0.75;
const RELATED_SCORE = 0.3;
const RECENT_CLOSED_MS = 90 * 24 * 60 * 60_000;

export function issueRef(issue: GithubIssue): FeedbackIssueRef {
  return { number: issue.number, title: issue.title.slice(0, 300), state: issue.state, url: issue.url };
}

/**
 * What GitHub found, ranked. An open issue is a duplicate only on a strong match — the same error fingerprint, or
 * nearly the same title and description; anything weaker is related. A closed issue counts only when it closed in the
 * last ninety days, and is never a duplicate: a report of a closed bug is a new occurrence worth its own issue.
 */
export function rankRelated(
  candidates: readonly GithubIssue[],
  input: { title: string; description: string; fingerprint?: string; now: number },
): { related: FeedbackRelated[]; duplicateOf?: FeedbackIssueRef } {
  const scored = new Map<number, FeedbackRelated & { score: number }>();
  for (const issue of candidates) {
    if (issue.isPullRequest || scored.has(issue.number)) continue;
    if (issue.state === "closed" && (issue.closedAt === undefined || input.now - Date.parse(issue.closedAt) > RECENT_CLOSED_MS)) continue;
    const fingerprintMatch = input.fingerprint !== undefined && issue.body.includes(input.fingerprint);
    const score = Math.max(similarity(input.title, issue.title), similarity(`${input.title} ${input.description}`, `${issue.title} ${issue.body.slice(0, 4000)}`));
    if (!fingerprintMatch && score < RELATED_SCORE) continue;
    const duplicate = issue.state === "open" && (fingerprintMatch || score >= DUPLICATE_SCORE);
    scored.set(issue.number, {
      issue: issueRef(issue),
      relation: duplicate ? "duplicate" : "related",
      basis: fingerprintMatch ? "same error fingerprint" : score >= DUPLICATE_SCORE ? "nearly the same title and description" : "similar title and description",
      score: fingerprintMatch ? 1 : score,
    });
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  const duplicate = ranked.find((entry) => entry.relation === "duplicate");
  return {
    related: ranked.map(({ score: _score, ...entry }) => entry),
    ...(duplicate === undefined ? {} : { duplicateOf: duplicate.issue }),
  };
}

/** The issue title: the person's own when they gave one, else the start of their description, prefixed by kind. */
export function reportTitle(kind: FeedbackKind, request: Pick<FeedbackRequest, "title" | "description">): string {
  const prefix = kind === "bug" ? "bug: " : "feat: ";
  const own = excerpt(request.title ?? request.description, 120);
  const stripped = own.replace(/^(?:bug|feat|feature)\s*:\s*/iu, "");
  return `${prefix}${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`;
}

function section(heading: string, body: string | undefined): string[] {
  return body === undefined ? [] : [`### ${heading}`, "", body, ""];
}

function diagnosticsSection(diagnostics: SafeDiagnostics | undefined): string[] {
  if (diagnostics === undefined) return [];
  return [
    "### Environment",
    "",
    "| | |",
    "|---|---|",
    ...diagnosticLines(diagnostics, "en").map((line) => `| ${line.label} | ${line.value.replace(/\|/gu, "\\|")} |`),
    "",
  ];
}

function relatedSection(related: readonly FeedbackRelated[]): string[] {
  if (related.length === 0) return [];
  return ["### Possibly related", "", ...related.map((entry) => `- #${String(entry.issue.number)} (${entry.basis})`), ""];
}

function philosophySection(philosophy: PhilosophyFit | undefined): string[] {
  if (philosophy === undefined) return [];
  const verdict =
    philosophy.verdict === "aligned"
      ? "Aligned with the product philosophy."
      : philosophy.verdict === "aligned-with-constraints"
        ? "Aligned, with constraints on how it is built:"
        : "In material conflict with the product philosophy as written. The outcome is recorded as asked; the philosophy-change gate decides whether to change the philosophy, adopt a compatible alternative, or decline.";
  return [
    "### Philosophy fit",
    "",
    verdict,
    ...philosophy.constraints.map((constraint) => `- **${constraint.invariant}.** ${constraint.note}`),
    ...(philosophy.assessment === undefined ? [] : ["", `Clark's reading: ${philosophy.assessment}`]),
    "",
  ];
}

/**
 * The issue body. Only sections with something in them: the person's words, what they selected as evidence, safe
 * diagnostics when they are shared, related issues found, and — for a feature — its fit with the philosophy and the
 * questions every feature answers about being replaced later. A reproduction nobody gave says so.
 *
 * Everything the person or a model wrote passes `scrub` first; the marker is added after, so redaction cannot touch it.
 */
export function composeIssueBody(input: {
  reportId: string;
  request: FeedbackRequest;
  diagnostics: SafeDiagnostics | undefined;
  related: readonly FeedbackRelated[];
  philosophy: PhilosophyFit | undefined;
  scrub: (text: string) => string;
}): string {
  const { request, scrub } = input;
  const own = (text: string | undefined): string | undefined => (text === undefined ? undefined : scrub(text));
  const evidence =
    request.evidence === undefined || request.evidence.length === 0
      ? undefined
      : request.evidence.map((item) => ["```text", scrub(item), "```"].join("\n")).join("\n\n");
  const lines: string[] =
    request.kind === "bug"
      ? [
          ...section("What happened", own(request.bug?.actual) ?? scrub(request.description)),
          ...(request.bug?.actual === undefined ? [] : section("Description", scrub(request.description))),
          ...section("What was expected", own(request.bug?.expected)),
          ...section("Steps to reproduce", own(request.bug?.reproduction) ?? "Not known yet."),
          ...section("How often", own(request.bug?.frequency)),
          ...section("Impact", own(request.bug?.impact)),
          ...section("Evidence", evidence),
          ...diagnosticsSection(input.diagnostics),
        ]
      : [
          ...section("Problem", own(request.feature?.problem) ?? scrub(request.description)),
          ...(request.feature?.problem === undefined ? [] : section("Description", scrub(request.description))),
          ...section("Desired outcome", own(request.feature?.outcome)),
          ...section("Example", own(request.feature?.example)),
          ...section("Proposed direction (not prescriptive)", own(request.feature?.proposal)),
          ...section("Non-goals", own(request.feature?.nonGoals)),
          ...section("Acceptance", own(request.feature?.acceptance)),
          ...section("Evidence", evidence),
          ...philosophySection(input.philosophy),
          "### Replaceability",
          "",
          "- Could a stronger model replace this implementation later?",
          "- Could a different runtime or provider replace it?",
          "- Which typed contract keeps it replaceable?",
          ...(request.feature?.replaceability === undefined ? [] : ["", scrub(request.feature.replaceability)]),
          "",
          ...diagnosticsSection(input.diagnostics),
        ];
  return [...lines, ...relatedSection(input.related), `_Filed from ClarkCant (${request.source})._`, "", feedbackMarker(input.reportId)].join("\n");
}

/** The comment a report adds to an open issue it duplicates: the new occurrence, in the same sections. */
export function composeOccurrenceComment(input: {
  reportId: string;
  request: FeedbackRequest;
  diagnostics: SafeDiagnostics | undefined;
  scrub: (text: string) => string;
}): string {
  const { request, scrub } = input;
  return [
    request.kind === "bug" ? "Another occurrence, reported from ClarkCant:" : "Another request for this, from ClarkCant:",
    "",
    `> ${scrub(request.description).replace(/\n/gu, "\n> ")}`,
    "",
    ...(request.kind === "bug" ? section("Steps to reproduce", request.bug?.reproduction === undefined ? undefined : scrub(request.bug.reproduction)) : []),
    ...diagnosticsSection(input.diagnostics),
    feedbackMarker(input.reportId),
  ].join("\n");
}

/** GitHub's own new-issue page, prefilled with the same redacted title and body, cut to fit a URL. */
export function manualIssueUrl(repository: string, title: string, body: string, labels: readonly string[]): string {
  const base = `https://github.com/${repository}/issues/new`;
  const query = (text: string): string =>
    `?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(labels.join(","))}&body=${encodeURIComponent(text)}`;
  let text = body;
  while (text.length > 0 && (base + query(text)).length > 7800) text = text.slice(0, Math.floor(text.length * 0.8));
  return base + query(text === body ? body : `${text}\n\n…`);
}

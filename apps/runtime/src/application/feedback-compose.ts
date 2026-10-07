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

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text with any half of a surrogate pair replaced, so it encodes (`encodeURIComponent` throws on one). */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

/** At most `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Stop a handle in shared text from notifying anyone: a word joiner after `@` keeps `@name` readable while GitHub no
 * longer reads it as a mention. An e-mail address (a letter before the `@`) is left as it is.
 */
export function neutraliseMentions(text: string): string {
  return text.replace(/(^|[^\p{L}\p{N}_`/])@(?=[\p{L}\p{N}])/gu, "$1@\u2060");
}

/**
 * Make text safe to leave the machine: the shared secret redaction (`redactSecrets`, the same patterns every other
 * outbound path uses), then the home directory, which no pattern can know, replaced by `~` — compared without case on
 * Windows, whose paths are — and handles neutralised so a report pings nobody.
 */
export function scrubOutbound(text: string, homeDirectory: string | undefined, platform: NodeJS.Platform = process.platform): string {
  let clean = redactSecrets(text);
  if (homeDirectory !== undefined && homeDirectory.length > 3) {
    for (const form of new Set([homeDirectory, homeDirectory.replace(/\\/gu, "/"), homeDirectory.replace(/\//gu, "\\")])) {
      clean = clean.replace(new RegExp(escapeRegExp(form), platform === "win32" ? "giu" : "gu"), "~");
    }
  }
  return neutraliseMentions(clean);
}

/** Text cut to `max` characters on a word where one is near, with an ellipsis when anything was cut. */
export function excerpt(text: string, max: number): string {
  const single = text.replace(/\s+/gu, " ").trim();
  if (single.length <= max) return single;
  const cut = cutText(single, max - 1);
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
 * Vietnamese, with and without diacritics. Word edges are Unicode-aware: `\b` only knows ASCII letters, so it never
 * sees the edge of "ẩn".
 */
interface PhilosophyRule {
  pattern: RegExp;
  verdict: Exclude<PhilosophyVerdict, "aligned">;
  invariant: string;
  note: string;
  vi: { invariant: string; note: string };
}

/** A pattern whose `<` and `>` are Unicode word edges. */
function edged(source: string): RegExp {
  return new RegExp(source.replaceAll("<", "(?<![\\p{L}\\p{N}_])").replaceAll(">", "(?![\\p{L}\\p{N}_])"), "iu");
}

const SECRET = String.raw`(?:secrets?|api[- ]?keys?|credentials?|cookies?|raw ipc|(?:access |auth |oauth |github |api )?tokens?(?! (?:usage|count|counts|cost|costs|limit|limits|budget|spend|per)>)|m[aậ]t kh[aẩ]u|kh[oó]a api)`;
const SURFACE = String.raw`(?:widgets?|extensions?|plugins?|ti[eệ]n [ií]ch(?: m[oở] r[oộ]ng)?)`;
const HAND_OVER = String.raw`(?:give|gives|giving|pass|passes|passing|send|sends|expose|exposes|exposing|hand|hands|share|shares|access|accesses|read|reads|receive|receives|get|gets|inject|injects|c[aấ]p|đ[uư]a|truy[eề]n|l[oộ]|chia s[eẻ]|nh[aậ]n|đ[oọ]c|truy c[aậ]p|l[aấ]y)`;

/** An operating system a request could be scoped to. */
const OS = String.raw`(?:mac(?:os)?|os x|windows|win(?:dows )?1[01]|linux|omarchy|ubuntu|arch linux)`;

const PHILOSOPHY_RULES: readonly PhilosophyRule[] = [
  {
    pattern: edged(String.raw`<(?:sidebar|side bar|dashboard|thanh b[eê]n|b[aả]ng (?:đ|d)i[eề]u khi[eể]n|permanent (?:panel|picker)|session picker)>`),
    verdict: "aligned-with-constraints",
    invariant: "Conversation stays the primary surface",
    note: "Deliver it as something summoned into the conversation (a slash command, a sentence or voice returning a widget), not as permanent chrome.",
    vi: {
      invariant: "Cuộc trò chuyện vẫn là bề mặt chính",
      note: "Đưa nó vào cuộc trò chuyện khi được gọi (lệnh gạch chéo, một câu nói hoặc giọng nói trả về widget), không thành khung cố định.",
    },
  },
  {
    pattern: edged(String.raw`<(?:always (?:ask|confirm)|confirm(?:ation)? (?:before|for) every|h[oỏ]i (?:l[aạ]i )?tr[uư][oớ]c m[oọ]i|lu[oô]n h[oỏ]i)>`),
    verdict: "aligned-with-constraints",
    invariant: "Autonomy by default; Jev/policy owns escalation",
    note: "Express it as an execution-policy preference the person sets, not a confirmation added in one feature.",
    vi: {
      invariant: "Tự chủ là mặc định; Jev/chính sách quyết định khi nào hỏi",
      note: "Diễn đạt nó thành một tuỳ chọn chính sách thực thi do người dùng đặt, không thêm hộp xác nhận riêng cho một tính năng.",
    },
  },
  {
    pattern: edged(String.raw`<(?:remove|delete|hide|drop|b[oỏ]|x[oó]a|[aẩ]n) (?:the |c[aá]i )?(?:animated )?orb>`),
    verdict: "material-conflict",
    invariant: "The animated Orb is ClarkCant's signature identity",
    note: "The Orb stays; personalization may change its palette, effects and motion, and reduced motion always wins.",
    vi: {
      invariant: "Orb động là bản sắc đặc trưng của ClarkCant",
      note: "Orb được giữ lại; cá nhân hoá có thể đổi bảng màu, hiệu ứng và chuyển động, và chế độ giảm chuyển động luôn được ưu tiên.",
    },
  },
  {
    pattern: edged(
      String.raw`<${SURFACE}>[^.]{0,60}<${HAND_OVER}>[^.]{0,40}<${SECRET}|<${HAND_OVER}>[^.]{0,40}<${SURFACE}>[^.]{0,40}<${SECRET}`,
    ),
    verdict: "material-conflict",
    invariant: "Untrusted widgets never receive raw secrets, privileged cookies or generic IPC",
    note: "Use a host-owned capability or a scoped, short-lived token through the broker instead of handing the secret over.",
    vi: {
      invariant: "Widget không tin cậy không bao giờ nhận bí mật thô, cookie đặc quyền hay IPC chung",
      note: "Dùng một năng lực do host sở hữu, hoặc token ngắn hạn có phạm vi qua broker, thay vì trao bí mật.",
    },
  },
  {
    pattern: edged(String.raw`<(?:bypass|skip) (?:the )?(?:code )?review>|<push (?:directly )?to main>|<hot[- ]?patch(?:ing)? (?:itself|the running)>|<self[- ]?approv`),
    verdict: "material-conflict",
    invariant: "No AI surface approves its own privileged action; code changes go through a pull request",
    note: "Self-improvement goes through an issue, a branch and a reviewed pull request, never a direct change to the running product.",
    vi: {
      invariant: "Không bề mặt AI nào tự duyệt hành động đặc quyền của chính nó; thay đổi mã đi qua pull request",
      note: "Tự cải tiến đi qua issue, nhánh và pull request đã review, không bao giờ sửa thẳng sản phẩm đang chạy.",
    },
  },
  {
    // A request scoped to one operating system, not any "only" or "just for": "just for fun" names no platform.
    pattern: edged(
      String.raw`<(?:only|just|exclusively) (?:on|for|in) (?:the )?${OS}>|<${OS}[- ]only>|<ch[iỉ] (?:tr[eê]n|cho|d[aà]nh cho) ${OS}>`,
    ),
    verdict: "aligned-with-constraints",
    invariant: "Cross-platform by default",
    note: "Keep the logic portable and put the platform part behind an adapter, with explicit behaviour on the other systems.",
    vi: {
      invariant: "Đa nền tảng là mặc định",
      note: "Giữ phần logic chạy được mọi nơi, đặt phần riêng của nền tảng sau một adapter, và nói rõ cách hoạt động trên các hệ khác.",
    },
  },
  {
    pattern: edged(String.raw`<(?:ignore|disable|b[oỏ] qua|t[aắ]t) (?:the )?(?:reduced[- ]motion|gi[aả]m chuy[eể]n đ[oộ]ng)>`),
    verdict: "material-conflict",
    invariant: "Reduced motion always wins",
    note: "Motion can be personalized, but a person's reduced-motion setting is never overridden.",
    vi: {
      invariant: "Giảm chuyển động luôn được ưu tiên",
      note: "Chuyển động có thể cá nhân hoá, nhưng thiết lập giảm chuyển động của người dùng không bao giờ bị ghi đè.",
    },
  },
];

const VERDICT_RANK: Record<PhilosophyVerdict, number> = { aligned: 0, "aligned-with-constraints": 1, "material-conflict": 2 };

/**
 * A request's fit with the product philosophy: the host's own rules, and the model's reading when one was given. The
 * stricter of the two stands, so a model can raise a concern but cannot talk one away.
 */
export function classifyPhilosophy(text: string, model: FeedbackRequest["philosophy"]): PhilosophyFit {
  const normalised = text.normalize("NFC");
  const constraints = PHILOSOPHY_RULES.filter((rule) => rule.pattern.test(normalised));
  let verdict: PhilosophyVerdict = "aligned";
  for (const rule of constraints) if (VERDICT_RANK[rule.verdict] > VERDICT_RANK[verdict]) verdict = rule.verdict;
  if (model !== undefined && VERDICT_RANK[model.verdict] > VERDICT_RANK[verdict]) verdict = model.verdict;
  return {
    verdict,
    constraints: constraints.map((rule) => ({ invariant: rule.invariant, note: rule.note })),
    ...(model?.note === undefined ? {} : { assessment: model.note }),
  };
}

/**
 * A fit as a person reads it on the host's card, in their language. The issue on GitHub keeps the English the rules
 * are written in; a constraint this build has no rule for (an older report's) is shown as it was written.
 */
export function localisePhilosophy(fit: PhilosophyFit, locale: Locale): PhilosophyFit {
  if (locale === "en") return fit;
  return {
    ...fit,
    constraints: fit.constraints.map((constraint) => {
      const rule = PHILOSOPHY_RULES.find((entry) => entry.invariant === constraint.invariant);
      return rule === undefined ? constraint : { invariant: rule.vi.invariant, note: rule.vi.note };
    }),
  };
}

const BASIS = {
  fingerprint: { en: "same error fingerprint", vi: "cùng dấu vân lỗi" },
  duplicate: { en: "nearly the same title and description", vi: "tiêu đề và mô tả gần như trùng" },
  similar: { en: "similar title and description", vi: "tiêu đề và mô tả tương tự" },
} as const;

/** Related issues as a person reads them on the host's card, the basis of each match in their language. */
export function localiseRelated(related: readonly FeedbackRelated[], locale: Locale): FeedbackRelated[] {
  if (locale === "en") return [...related];
  return related.map((entry) => {
    const basis = Object.values(BASIS).find((known) => known.en === entry.basis);
    return basis === undefined ? entry : { ...entry, basis: basis.vi };
  });
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
      basis: fingerprintMatch ? BASIS.fingerprint.en : score >= DUPLICATE_SCORE ? BASIS.duplicate.en : BASIS.similar.en,
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

/**
 * The issue title: the person's own when they gave one, else the start of their description, prefixed by kind. A
 * sentence's capital is lowered to follow the prefix; an acronym's ("API key") is not.
 */
export function reportTitle(kind: FeedbackKind, request: Pick<FeedbackRequest, "title" | "description">): string {
  const prefix = kind === "bug" ? "bug: " : "feat: ";
  const own = excerpt(request.title ?? request.description, 120);
  const stripped = own.replace(/^(?:bug|feat|feature)\s*:\s*/iu, "");
  return `${prefix}${stripped.replace(/^\p{Lu}(?=\p{Ll})/u, (first) => first.toLowerCase())}`;
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

/**
 * GitHub's own new-issue page, prefilled with the same redacted title and body, cut to fit a URL. Cut between
 * characters, never inside one: half an emoji cannot be encoded into a URL at all.
 */
export function manualIssueUrl(repository: string, title: string, body: string, labels: readonly string[]): string {
  const base = `https://github.com/${repository}/issues/new`;
  const query = (text: string): string =>
    `?title=${encodeURIComponent(wellFormed(title))}&labels=${encodeURIComponent(labels.join(","))}&body=${encodeURIComponent(text)}`;
  const full = wellFormed(body);
  let text = full;
  while (text.length > 0 && (base + query(text)).length > 7800) text = cutText(text, Math.floor(text.length * 0.8));
  return base + query(text === full ? full : `${text}\n\n…`);
}

import { z } from "zod";

import { instantSchema } from "./primitives.ts";

/**
 * Product feedback: a bug report or a feature request, filed from the conversation (#510).
 *
 * Every way in — `/report`, a sentence to Clark, voice, and the host-owned Feedback Composer — reaches one host-owned
 * service, which owns what is shared, how it is redacted, where it is published and what is claimed about it. A model
 * may compose the person's words into sections; it never supplies diagnostics, issue state, blockers or success.
 *
 * Where a report goes is not anybody's input: ClarkCant's own repository, named here in the shipped code, so a model,
 * a widget or a pasted link cannot point a report — or the GitHub token that files it — at another repository.
 */
export const FEEDBACK_REPOSITORY = "digitopvn/clarkcant";

export const FEEDBACK_KINDS = ["bug", "feature"] as const;
export const feedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;

/** Where the person asked from. Recorded on the report and shown as its input mode; it never changes what is done. */
export const FEEDBACK_SOURCES = ["slash", "chat", "voice", "composer"] as const;
export const feedbackSourceSchema = z.enum(FEEDBACK_SOURCES);
export type FeedbackSource = z.infer<typeof feedbackSourceSchema>;

/** A report's own id, minted by the node: `rpt_` and the node's id characters. */
export const feedbackReportIdSchema = z.string().regex(/^rpt_[A-Za-z0-9_-]{1,60}$/u);

/**
 * The hidden marker a published issue or comment carries, so the report can be found again by what it says rather than
 * by a response that may never have arrived. HTML comments are not rendered by GitHub, so nobody reads it as text.
 */
export function feedbackMarker(reportId: string): string {
  return `<!-- clark-report:${reportId} -->`;
}

/** The report id a body's marker names, or `undefined` when it carries none. */
export function readFeedbackMarker(body: string): string | undefined {
  const match = /<!-- clark-report:(rpt_[A-Za-z0-9_-]{1,60}) -->/u.exec(body);
  return match?.[1];
}

const textField = (max: number) => z.string().trim().min(1).max(max);

/**
 * What the person said about a bug, section by section, when they said it. Every field is optional because a section
 * nobody spoke to is left out of the issue rather than filled in: a reproduction nobody gave is "not known yet".
 */
export const bugDetailsSchema = z.strictObject({
  actual: textField(2000).optional(),
  expected: textField(2000).optional(),
  reproduction: textField(4000).optional(),
  frequency: textField(500).optional(),
  impact: textField(1000).optional(),
});

/** The same for a feature request: the problem and the outcome first, a proposed implementation only as a direction. */
export const featureDetailsSchema = z.strictObject({
  problem: textField(2000).optional(),
  outcome: textField(2000).optional(),
  example: textField(2000).optional(),
  proposal: textField(2000).optional(),
  nonGoals: textField(1000).optional(),
  acceptance: textField(2000).optional(),
  /** Clark's reasoning on whether a stronger model, runtime or provider could replace the implementation later. */
  replaceability: textField(1500).optional(),
});

/** A model's own reading of a feature's fit with the product philosophy. The host keeps the stricter of it and its own. */
export const PHILOSOPHY_VERDICTS = ["aligned", "aligned-with-constraints", "material-conflict"] as const;
export const philosophyVerdictSchema = z.enum(PHILOSOPHY_VERDICTS);
export type PhilosophyVerdict = z.infer<typeof philosophyVerdictSchema>;

/**
 * What a surface asks the service to prepare.
 *
 * `evidence` is only what the person supplied or explicitly selected for this report; nothing reaches it by default.
 * `error` is the failure the report is about, as the person or the conversation saw it: the host keeps a bounded,
 * redacted message and a fingerprint of it, never a log.
 */
export const feedbackRequestSchema = z.strictObject({
  kind: feedbackKindSchema,
  description: textField(4000),
  title: textField(200).optional(),
  source: feedbackSourceSchema,
  includeDiagnostics: z.boolean().default(true),
  subsystem: textField(80).optional(),
  bug: bugDetailsSchema.optional(),
  feature: featureDetailsSchema.optional(),
  evidence: z.array(textField(2000)).max(5).optional(),
  error: z.strictObject({ code: textField(120).optional(), message: textField(2000) }).optional(),
  philosophy: z.strictObject({ verdict: philosophyVerdictSchema, note: textField(1000).optional() }).optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export type FeedbackRequestInput = z.input<typeof feedbackRequestSchema>;

/**
 * The facts the node already knows and may share by default. Nothing here is typed by the person, and nothing here
 * names them: no transcript, prompt, file, environment variable, raw log, home path or credential.
 */
export const safeDiagnosticsSchema = z.strictObject({
  clarkVersion: z.string().min(1).max(40),
  os: z.string().min(1).max(80),
  arch: z.string().min(1).max(20),
  runtime: z.string().min(1).max(60),
  locale: z.enum(["vi", "en"]),
  inputMode: feedbackSourceSchema,
  provider: z.string().min(1).max(80).optional(),
  model: z.string().min(1).max(120).optional(),
  subsystem: z.string().min(1).max(80).optional(),
  errorCode: z.string().min(1).max(120).optional(),
  /** Redacted and cut to a bounded excerpt before it is kept. */
  errorMessage: z.string().min(1).max(300).optional(),
  /** Twelve hex characters of a digest of the normalised error, so a repeat of the same failure can be matched. */
  errorFingerprint: z.string().regex(/^[a-f0-9]{12}$/u).optional(),
  capturedAt: instantSchema,
});
export type SafeDiagnostics = z.infer<typeof safeDiagnosticsSchema>;

/** One diagnostic as a person reads it in "what will be shared". */
export const diagnosticLineSchema = z.strictObject({ label: z.string().min(1).max(60), value: z.string().min(1).max(300) });
export type DiagnosticLine = z.infer<typeof diagnosticLineSchema>;

export const philosophyFitSchema = z.strictObject({
  verdict: philosophyVerdictSchema,
  constraints: z.array(z.strictObject({ invariant: z.string().min(1).max(200), note: z.string().min(1).max(600) })).max(8),
  /** The model's own note, redacted, when one was given. */
  assessment: z.string().min(1).max(1000).optional(),
});
export type PhilosophyFit = z.infer<typeof philosophyFitSchema>;

/** An issue as GitHub reported it when it was read: never a number nobody read. */
export const feedbackIssueRefSchema = z.strictObject({
  number: z.int().positive(),
  title: z.string().min(1).max(300),
  state: z.enum(["open", "closed"]),
  url: z.url(),
});
export type FeedbackIssueRef = z.infer<typeof feedbackIssueRefSchema>;

export const feedbackRelatedSchema = z.strictObject({
  issue: feedbackIssueRefSchema,
  relation: z.enum(["duplicate", "related"]),
  /** How the match was made, in words: "same error fingerprint", "similar title and description". */
  basis: z.string().min(1).max(120),
});
export type FeedbackRelated = z.infer<typeof feedbackRelatedSchema>;

export const FEEDBACK_STATUSES = ["draft", "publishing", "unknown", "published", "failed"] as const;
export const feedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

/**
 * A report ready to publish: the redacted title and body exactly as they will be sent, what was shared, how it fits
 * the product, and what was found already filed. `duplicateOf` is set only for an open issue matched with high
 * confidence; the report then adds to that issue instead of opening another.
 */
export const feedbackDraftSchema = z.strictObject({
  reportId: feedbackReportIdSchema,
  kind: feedbackKindSchema,
  source: feedbackSourceSchema,
  repository: z.string().min(3).max(140),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(60_000),
  /** Requested labels; GitHub keeps them only for an account allowed to label. */
  labels: z.array(z.string().min(1).max(50)).max(5),
  diagnostics: safeDiagnosticsSchema.optional(),
  philosophy: philosophyFitSchema.optional(),
  related: z.array(feedbackRelatedSchema).max(10),
  /** `checked` when GitHub answered the search; `unavailable` with the reason when it did not. */
  relatedSearch: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("checked") }),
    z.strictObject({ state: z.literal("unavailable"), reason: z.string().min(1).max(300) }),
  ]),
  duplicateOf: feedbackIssueRefSchema.optional(),
  /** The comment that would be added to `duplicateOf`, redacted, when there is one. */
  occurrence: z.string().min(1).max(20_000).optional(),
  createdAt: instantSchema,
});
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>;

/**
 * Where a report stands after a publish was asked for. Each state says only what is known:
 *
 *   - `published` — GitHub was read back and holds the issue or comment carrying this report's marker;
 *   - `unknown` — sent, and no answer this node can trust yet; it is found again by its marker, never sent twice.
 *     With `inconclusive`, checking cannot settle it (GitHub's list runs past what is read, or the record of the
 *     attempt is gone): the person gets the links to look for themselves and may send it anyway, knowing it may file
 *     twice; the node never sends it again on its own;
 *   - `failed` — GitHub refused it, it never left, or GitHub's own list shows the unanswered attempt never arrived;
 *     `retryable` says whether sending it again can help;
 *   - `needs-access` — this node has no GitHub token it may use for reports; nothing was sent;
 *   - `refused` — the execution policy refuses external writes on this node; nothing was sent.
 *
 * There is no "waiting for approval": only the person's own press on the host's card publishes a report, and that
 * press is the decision.
 */
export const feedbackPublicationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("published"),
    reportId: feedbackReportIdSchema,
    mode: z.enum(["created", "commented"]),
    issue: feedbackIssueRefSchema,
    commentUrl: z.url().optional(),
    confirmedAt: instantSchema,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reportId: feedbackReportIdSchema,
    reason: z.string().min(1).max(600),
    inconclusive: z
      .strictObject({
        /** No later than the attempt: what the person filed on GitHub from this moment on may be this report. */
        since: instantSchema,
        /** GitHub's own list of what the person filed (or commented on) since then, to look for it themselves. */
        searchUrl: z.url().max(2000),
        /** Where to file it by hand: GitHub's prefilled new-issue page, or the issue a comment would go on. */
        manualUrl: z.url().max(8000),
      })
      .optional(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    reportId: feedbackReportIdSchema,
    reason: z.string().min(1).max(600),
    retryable: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("needs-access"),
    reportId: feedbackReportIdSchema,
    reason: z.string().min(1).max(600),
    /** GitHub's own new-issue page, prefilled with the same redacted title and body, for the person to file by hand. */
    manualUrl: z.url().max(8000),
  }),
  z.strictObject({ status: z.literal("refused"), reportId: feedbackReportIdSchema, reason: z.string().min(1).max(600) }),
]);
export type FeedbackPublication = z.infer<typeof feedbackPublicationSchema>;

/**
 * Why Clark may or may not offer "Do you want me to handle this issue now?".
 *
 * An eligibility decision, not a button: `eligible: true` is the only state in which an offer may be drawn, and it is
 * re-checked immediately before any handling starts. `handling-unavailable` is this build's own answer — the canonical
 * background execution backend and the `dev` release contract it needs do not exist yet — and it is reported with the
 * issues that track them rather than hidden behind a control that cannot work.
 */
export const HANDLING_INELIGIBLE_CODES = [
  "unreadable",
  "wrong-repository",
  "issue-closed",
  "epic",
  "assigned",
  "in-progress",
  "open-pull-request",
  "active-clark-work",
  "blocked",
  "external-gate",
  "philosophy-conflict",
  "handling-unavailable",
] as const;

export const issueMentionSchema = z.strictObject({
  number: z.int().positive(),
  title: z.string().min(1).max(300).optional(),
  url: z.url().optional(),
});
export type IssueMention = z.infer<typeof issueMentionSchema>;

export const handlingEligibilitySchema = z.discriminatedUnion("eligible", [
  z.strictObject({ eligible: z.literal(true), reason: z.string().min(1).max(600), issue: feedbackIssueRefSchema }),
  z.strictObject({
    eligible: z.literal(false),
    code: z.enum(HANDLING_INELIGIBLE_CODES),
    reason: z.string().min(1).max(600),
    blockers: z.array(issueMentionSchema).max(10),
    /** An epic is planned and split into child work rather than fixed in one change. */
    suggestion: z.literal("plan-split").optional(),
  }),
]);
export type HandlingEligibility = z.infer<typeof handlingEligibilitySchema>;

/**
 * The work handling an issue would need before it can be offered at all: the canonical durable execution backend
 * (#402) and the `dev` branch and release contract a pull request targets (#508). Named once, so the reason a person
 * reads and the issues it links cannot disagree.
 */
export const HANDLING_PREREQUISITES: readonly IssueMention[] = [
  { number: 402, url: "https://github.com/digitopvn/clarkcant/issues/402" },
  { number: 508, url: "https://github.com/digitopvn/clarkcant/issues/508" },
];

/**
 * The host-owned card a report lives in, in the conversation.
 *
 *   - `compose` is the Feedback Composer: Bug or Feature, the person's words, whether safe diagnostics go with it and
 *     exactly which, and Create issue. Summoned by a bare `/report`, by asking, or by Clark; never a screen of its own.
 *     When Clark or `/report bug …` already prepared the report, the card carries it (`reportId`, `title`, `preview`):
 *     the exact redacted issue that Create issue would file, which is the only way that report is filed.
 *   - `result` is what a publish came to, written when it happened: the issue, what was shared, what was found already
 *     filed, and whether Clark may offer to handle it. Messages are immutable, so trying again writes a new card, and
 *     `answers` names the card whose press it answers, so that card reads as used after a reload.
 */
export const feedbackCardSchema = z.strictObject({
  type: z.literal("feedback-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  stage: z.enum(["compose", "result"]),
  repository: z.string().min(3).max(140),
  kind: feedbackKindSchema.optional(),
  /** `compose`: the words to start from, when the person already said some. */
  description: z.string().min(1).max(4000).optional(),
  /** What safe diagnostics would be (compose) or were (result) shared. Empty when none are. */
  diagnostics: z.array(diagnosticLineSchema).max(16),
  /** The report it is about: the prepared one (`compose`) or the published one (`result`). */
  reportId: feedbackReportIdSchema.optional(),
  title: z.string().min(1).max(256).optional(),
  /** `compose`, prepared: exactly what Create issue would send — the body, or the comment on the duplicate it found. */
  preview: z
    .strictObject({
      body: z.string().min(1).max(60_000),
      duplicateOf: feedbackIssueRefSchema.optional(),
      searchUnavailable: z.string().min(1).max(300).optional(),
    })
    .optional(),
  /** `result`: the card whose press this answers. */
  answers: z.string().min(1).max(128).optional(),
  publication: feedbackPublicationSchema.optional(),
  related: z.array(feedbackRelatedSchema).max(10).optional(),
  philosophy: philosophyFitSchema.optional(),
  eligibility: handlingEligibilitySchema.optional(),
  updatedAt: instantSchema,
});
export type FeedbackCard = z.infer<typeof feedbackCardSchema>;

/** `POST /feedback/reports`: prepare a report. `conversationId` names where it was asked from, when it was. */
export const feedbackPrepareRequestSchema = z.strictObject({
  request: feedbackRequestSchema,
  conversationId: z.string().min(1).max(128).optional(),
});

/**
 * `POST /feedback/reports/:reportId/publish`, the person's press: publish it (`send`, the default), only find out what
 * an earlier send came to (`check`, which never sends), or send a report whose outcome cannot be found out anyway
 * (`send-anyway`, accepted only for an inconclusive `unknown`, knowing it may file twice). It writes the result card
 * into this conversation; `answers` names the card pressed.
 */
export const FEEDBACK_PUBLISH_INTENTS = ["send", "check", "send-anyway"] as const;
export type FeedbackPublishIntent = (typeof FEEDBACK_PUBLISH_INTENTS)[number];
export const feedbackPublishRequestSchema = z.strictObject({
  conversationId: z.string().min(1).max(128),
  intent: z.enum(FEEDBACK_PUBLISH_INTENTS).default("send"),
  answers: z.string().min(1).max(128).optional(),
});

/** What `POST /feedback/reports` answers: the draft exactly as it would be filed, and its diagnostics as a person reads them. */
export const feedbackPrepareResponseSchema = z.object({
  draft: feedbackDraftSchema,
  diagnostics: z.array(diagnosticLineSchema).max(16),
});
export type FeedbackPrepareResponse = z.infer<typeof feedbackPrepareResponseSchema>;

/**
 * What `POST /feedback/reports/:reportId/publish` answers, besides the conversation's timeline with the result card in
 * it: where the report stands, and whether Clark may offer to handle the issue it landed in.
 */
export const feedbackPublishResponseSchema = z.object({
  publication: feedbackPublicationSchema,
  eligibility: handlingEligibilitySchema.optional(),
  messageId: z.string().min(1),
});
export type FeedbackPublishResponse = z.infer<typeof feedbackPublishResponseSchema>;

import { z } from "zod";

import { instantSchema, type Instant } from "./primitives.ts";

/**
 * What the host is waiting for.
 *
 * Approval, a clarifying question and a request for a credential are the same kind of event: the node has
 * stopped and is waiting for a person, and the agent is not the one who can answer. They were three
 * separate mechanisms — an approval card with its own route, a question the model paraphrased into text,
 * and a credential form — which meant three code paths, three ideas of "waiting", and a voice session that
 * only understood the first one.
 *
 * `PendingInteraction` is that idea written down once. The rule that comes with it: the turn that raised
 * the interaction **ends** and settles. Nothing holds a provider call, an SDK session or an HTTP stream
 * open while a person thinks — the answer arrives later as a new turn. That is what makes a question cost
 * the same whether it is answered in two seconds or two days.
 */
export const interactionKindSchema = z.enum(["approval", "question", "credential"]);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

/**
 * The four ways of asking, chosen because they are the four a voice can answer.
 *
 * The list is deliberately closed and small. A form with twelve fields reads well and speaks terribly, and
 * every extra kind would need its own rendering in every surface, its own spoken interpretation, and its
 * own validation. `text` is the escape hatch when none of the structured shapes fit, and it is the one
 * that costs the most to answer out loud.
 */
export const questionKindSchema = z.enum(["text", "single-choice", "multi-choice", "confirm"]);
export type QuestionKind = z.infer<typeof questionKindSchema>;

export const questionOptionSchema = z.object({
  /** Stable within one question; what an answer carries and what a voice matches against. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const interactionStatusSchema = z.enum(["waiting", "answered", "cancelled", "expired"]);
export type InteractionStatus = z.infer<typeof interactionStatusSchema>;

/** The answer to a question, normalised. Exactly one shape per kind, so a reader never has to guess. */
export interface QuestionAnswer {
  kind: QuestionKind;
  /** For `text`: what the person wrote, verbatim. */
  text?: string;
  /** For `single-choice`: the one option. For `multi-choice`: every chosen option, in the order offered. */
  optionIds?: string[];
  /** For `confirm`. */
  confirmed?: boolean;
  /** True when the answer came from speech rather than from a click, so a surface can say which it was. */
  viaVoice?: boolean;
}

export interface QuestionInteraction {
  kind: "question";
  interactionId: string;
  conversationId: string;
  questionId: string;
  questionType: QuestionKind;
  /** Shown on screen. Written by the agent, bounded by the tool schema. */
  prompt: string;
  options: QuestionOption[];
  /** Whether an answer outside `options` is accepted. Only meaningful for the choice kinds. */
  allowOther: boolean;
  status: InteractionStatus;
  createdAt: Instant;
  expiresAt?: Instant;
}

/** An approval the node is waiting on. The shape the approval route already has. */
export interface ApprovalInteraction {
  kind: "approval";
  interactionId: string;
  conversationId: string;
  approvalId: string;
  operationDescription: string;
  operationDigest: string;
  effectCategory: string;
  status: InteractionStatus;
  createdAt: Instant;
  expiresAt?: Instant;
}

export interface CredentialInteraction {
  kind: "credential";
  interactionId: string;
  conversationId: string;
  name: string;
  label: string;
  description: string;
  status: InteractionStatus;
  createdAt: Instant;
  expiresAt?: Instant;
}

export type PendingInteraction = ApprovalInteraction | QuestionInteraction | CredentialInteraction;

/**
 * The tool an agent calls to ask.
 *
 * `voicePrompt` is accepted but almost never needed: the host can say a structured question out loud
 * better than an agent can, because it can see the options. Keeping the field means an agent that has a
 * genuinely better spoken phrasing can use it, without every agent maintaining two versions of the same
 * sentence — which is what happens when the only way to speak well is to write it twice.
 */
export const askUserQuestionSchema = z.object({
  question: z.string().min(1).max(500),
  kind: questionKindSchema,
  options: z.array(questionOptionSchema).max(8).optional(),
  allowOther: z.boolean().optional(),
  voicePrompt: z.string().max(500).optional(),
});
export type AskUserQuestionInput = z.infer<typeof askUserQuestionSchema>;

/** The longest an answer may be before it stops being an answer and starts being a document. */
export const ANSWER_TEXT_LIMIT = 2_000;

/**
 * Say the question out loud, from the structure rather than from a second copy of the words.
 *
 * Built here rather than by the agent so that the spoken form cannot drift from what is on screen: a
 * `single-choice` whose options changed would otherwise be read out in its old wording.
 */
export function voicePromptFor(interaction: {
  prompt: string;
  questionType: QuestionKind;
  options: readonly QuestionOption[];
  voicePrompt?: string;
}): string {
  if (interaction.voicePrompt !== undefined && interaction.voicePrompt.trim() !== "") {
    return interaction.voicePrompt.trim();
  }
  const labels = interaction.options.map((option) => option.label);
  const list =
    labels.length === 0
      ? ""
      : labels.length === 1
        ? labels[0]!
        : `${labels.slice(0, -1).join(", ")} hay ${labels.at(-1)!}`;
  switch (interaction.questionType) {
    case "confirm":
      return `${interaction.prompt} Đồng ý hay không?`;
    case "single-choice":
      return list === "" ? interaction.prompt : `${interaction.prompt} ${list}?`;
    case "multi-choice":
      return list === "" ? interaction.prompt : `${interaction.prompt} Có thể chọn nhiều: ${list}.`;
    default:
      return interaction.prompt;
  }
}

export type AnswerResult = { ok: true; answer: QuestionAnswer } | { ok: false; message: string };

/**
 * Check an answer against the question it answers.
 *
 * Refusals name what was wrong, because this is read by whoever or whatever sent the answer: a voice
 * interpretation that picked a label nobody offered has to be able to say so and try again, rather than
 * storing something the question never allowed.
 */
export function normalizeAnswer(
  interaction: { questionType: QuestionKind; options: readonly QuestionOption[]; allowOther: boolean },
  raw: { text?: unknown; optionIds?: unknown; confirmed?: unknown; viaVoice?: boolean },
): AnswerResult {
  const viaVoice = raw.viaVoice === true;
  const offered = new Set(interaction.options.map((option) => option.id));

  if (interaction.questionType === "text") {
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (text === "") return { ok: false, message: "Câu trả lời đang trống." };
    if (text.length > ANSWER_TEXT_LIMIT) {
      return { ok: false, message: `Câu trả lời dài hơn ${ANSWER_TEXT_LIMIT} ký tự.` };
    }
    return { ok: true, answer: { kind: "text", text, ...(viaVoice ? { viaVoice } : {}) } };
  }

  if (interaction.questionType === "confirm") {
    if (typeof raw.confirmed !== "boolean") {
      return { ok: false, message: "Câu hỏi này cần một câu trả lời đồng ý hoặc không đồng ý." };
    }
    return { ok: true, answer: { kind: "confirm", confirmed: raw.confirmed, ...(viaVoice ? { viaVoice } : {}) } };
  }

  const ids = Array.isArray(raw.optionIds) ? raw.optionIds.filter((id): id is string => typeof id === "string") : [];
  const unknown = ids.filter((id) => !offered.has(id));
  if (unknown.length > 0) {
    return { ok: false, message: `Không có lựa chọn nào tên ${unknown.join(", ")} trong câu hỏi này.` };
  }
  if (interaction.questionType === "single-choice") {
    if (ids.length !== 1) return { ok: false, message: "Câu hỏi này chỉ nhận đúng một lựa chọn." };
    return { ok: true, answer: { kind: "single-choice", optionIds: ids, ...(viaVoice ? { viaVoice } : {}) } };
  }
  if (ids.length === 0) {
    if (!interaction.allowOther) return { ok: false, message: "Câu hỏi này cần ít nhất một lựa chọn." };
    // `allowOther` with nothing chosen is the "none of these" answer, and it is still an answer.
    return { ok: true, answer: { kind: "multi-choice", optionIds: [], ...(viaVoice ? { viaVoice } : {}) } };
  }
  return { ok: true, answer: { kind: "multi-choice", optionIds: ids, ...(viaVoice ? { viaVoice } : {}) } };
}

/**
 * The answer, as a turn the model can read.
 *
 * Deliberately not "the user clicked option 2". The model has to continue a task, and the fact it needs is
 * the choice itself, in the same words the person saw — with the question's own text alongside it so that
 * an answer arriving ten minutes later still says what it answers.
 */
export function answerNote(
  interaction: { questionId: string; prompt: string; options: readonly QuestionOption[] },
  answer: QuestionAnswer,
): string {
  const label = (id: string): string => interaction.options.find((option) => option.id === id)?.label ?? id;
  let said: string;
  if (answer.kind === "confirm") said = answer.confirmed === true ? "Đồng ý" : "Không đồng ý";
  else if (answer.kind === "text") said = answer.text ?? "";
  else {
    const ids = answer.optionIds ?? [];
    said = ids.length === 0 ? "Không chọn lựa chọn nào" : ids.map(label).join(", ");
  }
  return `Trả lời cho câu hỏi ${interaction.questionId} (“${interaction.prompt}”): ${said}.`;
}

/** Whether an interaction still wants an answer. The one predicate every surface shares. */
export function isWaiting(interaction: { status: InteractionStatus; expiresAt?: Instant }, now: Instant): boolean {
  if (interaction.status !== "waiting") return false;
  if (interaction.expiresAt === undefined) return true;
  return interaction.expiresAt > now;
}

export const interactionStatusUpdateSchema = z.object({
  interactionId: z.string().min(1),
  status: interactionStatusSchema,
  at: instantSchema,
});

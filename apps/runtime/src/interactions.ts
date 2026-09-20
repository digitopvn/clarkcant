import {
  type AskUserQuestionInput,
  type Instant,
  type MessageBlock,
  type QuestionAnswer,
  type QuestionInteraction,
  type QuestionOption,
  askUserQuestionSchema,
  answerNote,
  isWaiting,
  normalizeAnswer,
  voicePromptFor,
} from "@clarkcant/contracts";

/**
 * The one thing the node can be waiting for a person to answer.
 *
 * A question is not a permission dialog and not a form. It is what the host raises when the work is
 * under-specified — which project, which environment, which of three equally valid readings — and its whole
 * design follows from one rule: **the turn that asked ends**. Nothing here waits for a person. The tool that
 * raises a question returns, the turn settles, and the answer arrives later as a new turn. That is what makes
 * a question cost the same whether it is answered in two seconds or two days, and it is the reason this
 * module has no subscription, no timeout loop and no open provider call.
 *
 * Durable state is the transcript itself, exactly as it is for an approval. The card is a `question-card`
 * block with `status: "waiting"`, and an answer appends a `tool-activity` block named `ask_user_question`
 * carrying `args.questionId` — the same shape the command receipt uses for `approvalId`. Messages are
 * immutable, so "answered" is derived by looking for that record rather than by editing the card, which also
 * means an answer survives a restart without a table of its own.
 */

/** How long a question stays open. Long enough to answer after lunch, short enough not to rot on screen. */
export const QUESTION_TTL_MS = 15 * 60_000;

/**
 * Questions that ask for a secret, refused without asking a model.
 *
 * The boundary this protects is the reason `request_secret` exists: an answer to `ask_user_question` becomes a
 * conversation message, and a conversation message goes to the provider, so a key typed into this card would
 * be a key sent to a model. The check is a regex rather than a decision because it has to hold even when the
 * policy layer is unavailable — a deterministic refusal is the only kind that can.
 */
const SECRET_ASKING =
  /(api[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|bearer\s|password|passphrase|mật\s*khẩu|mat\s*khau|private[\s_-]?key|client[\s_-]?secret|seed\s*phrase)/i;

export const SECRET_REQUEST_MESSAGE =
  "This question appears to request a secret. Use request_secret instead.";

export interface InteractionDeps {
  conversationId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** The conversation's blocks, in order. The transcript is the state. */
  blocks: () => readonly MessageBlock[];
  /** Append blocks to this conversation. One call per event, so the timeline stays a sequence. */
  append: (input: { at: Instant; blocks: MessageBlock[] }) => void;
}

export type CreateQuestionResult =
  | { ok: true; interaction: QuestionInteraction; block: MessageBlock }
  | { ok: false; code: "INVALID_QUESTION" | "SECRET_REQUEST"; message: string };

/**
 * Raise a question, or refuse to.
 *
 * The refusals are the interesting half. A malformed question is refused before a card exists, because a card
 * is a promise that answering it means something. A question that asks for a secret is refused with the name
 * of the tool that can actually do that job.
 */
export function createQuestion(deps: InteractionDeps, raw: unknown): CreateQuestionResult {
  const parsed = askUserQuestionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_QUESTION", message: "Câu hỏi không hợp lệ: cần `question` và `kind`." };
  }
  const input: AskUserQuestionInput = parsed.data;

  const asksForSecret = `${input.question} ${(input.options ?? []).map((option) => option.label).join(" ")}`;
  if (SECRET_ASKING.test(asksForSecret)) {
    return { ok: false, code: "SECRET_REQUEST", message: SECRET_REQUEST_MESSAGE };
  }

  const options: QuestionOption[] = (input.options ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  }));
  if (input.kind !== "text" && input.kind !== "confirm" && options.length === 0) {
    return {
      ok: false,
      code: "INVALID_QUESTION",
      message: `Câu hỏi kiểu ${input.kind} cần ít nhất một lựa chọn.`,
    };
  }
  if (input.kind === "text" && options.length > 0) {
    return { ok: false, code: "INVALID_QUESTION", message: "Câu hỏi kiểu text không nhận danh sách lựa chọn." };
  }

  const at = deps.now();
  const questionId = deps.newId("q");
  const interaction: QuestionInteraction = {
    kind: "question",
    interactionId: deps.newId("intr"),
    conversationId: deps.conversationId,
    questionId,
    questionType: input.kind,
    prompt: input.question,
    options,
    allowOther: input.allowOther === true,
    status: "waiting",
    createdAt: at,
    expiresAt: new Date(Date.parse(at) + QUESTION_TTL_MS).toISOString() as Instant,
  };

  const block: MessageBlock = {
    type: "question-card",
    owner: "host",
    questionId,
    prompt: interaction.prompt,
    questionType: interaction.questionType,
    options: interaction.options,
    allowOther: interaction.allowOther,
    // Said now, from the options that are actually offered, so the spoken form cannot drift from the screen.
    voicePrompt: voicePromptFor({ ...interaction, ...(input.voicePrompt === undefined ? {} : { voicePrompt: input.voicePrompt }) }),
    status: "waiting",
    createdAt: at,
    ...(interaction.expiresAt === undefined ? {} : { expiresAt: interaction.expiresAt }),
  };

  deps.append({ at, blocks: [block] });
  return { ok: true, interaction, block };
}

/** A question card back into the interaction it stands for, so a surface reads one shape. */
export function interactionFromBlock(block: MessageBlock, conversationId: string): QuestionInteraction | undefined {
  if (block.type !== "question-card") return undefined;
  return {
    kind: "question",
    interactionId: `intr_${block.questionId}`,
    conversationId,
    questionId: block.questionId,
    questionType: block.questionType,
    prompt: block.prompt,
    options: block.options,
    allowOther: block.allowOther,
    status: block.status,
    createdAt: block.createdAt,
    ...(block.expiresAt === undefined ? {} : { expiresAt: block.expiresAt }),
  };
}

/** The question ids that already have an answer on record, from the transcripts's own tool records. */
function answeredIds(blocks: readonly MessageBlock[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "tool-activity" || block.name !== "ask_user_question") continue;
    const id = block.args.questionId;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

/**
 * What this conversation is still waiting on.
 *
 * Derived rather than stored: a card is waiting when it was written waiting, its deadline has not passed, and
 * no answer record follows it. Rebuilding this from the transcript on every read is affordable at this size
 * and removes the failure mode that matters — a status row that disagrees with the timeline a person is
 * looking at.
 */
export function pendingForConversation(deps: InteractionDeps): QuestionInteraction[] {
  const blocks = deps.blocks();
  const answered = answeredIds(blocks);
  const now = deps.now();
  const pending: QuestionInteraction[] = [];
  for (const block of blocks) {
    const interaction = interactionFromBlock(block, deps.conversationId);
    if (interaction === undefined || answered.has(interaction.questionId)) continue;
    if (!isWaiting({ status: interaction.status, ...(interaction.expiresAt === undefined ? {} : { expiresAt: interaction.expiresAt }) }, now)) {
      continue;
    }
    pending.push(interaction);
  }
  return pending;
}

export function interactionFor(deps: InteractionDeps, questionId: string): QuestionInteraction | undefined {
  for (const block of deps.blocks()) {
    if (block.type === "question-card" && block.questionId === questionId) {
      return interactionFromBlock(block, deps.conversationId);
    }
  }
  return undefined;
}

export type AnswerQuestionResult =
  | { ok: true; note: string; blocks: MessageBlock[] }
  | { ok: false; code: "QUESTION_NOT_FOUND" | "QUESTION_CLOSED" | "INVALID_ANSWER"; message: string };

/**
 * Record an answer, and write the two blocks it becomes.
 *
 * Two blocks rather than one, because a person and a model need different things from the same event. The
 * person sees the answer as the question's answer. The model needs it as a turn it can continue from, which is
 * what `answerNote` builds, and the tool record is what makes the answer findable later — the same reason a
 * command's receipt carries its `approvalId`.
 *
 * Refusing an answer that does not fit its question is the point of `normalizeAnswer`: a voice interpretation
 * that heard an option nobody offered has to be told, not stored.
 */
export function answerQuestion(
  deps: InteractionDeps,
  questionId: string,
  raw: { text?: unknown; optionIds?: unknown; confirmed?: unknown; viaVoice?: boolean },
): AnswerQuestionResult {
  const interaction = interactionFor(deps, questionId);
  if (interaction === undefined) {
    return { ok: false, code: "QUESTION_NOT_FOUND", message: "Không có câu hỏi nào với id đó trong hội thoại này." };
  }

  const existing = answeredIds(deps.blocks());
  if (existing.has(questionId)) {
    return { ok: false, code: "QUESTION_CLOSED", message: "Câu hỏi này đã được trả lời rồi." };
  }
  const at = deps.now();
  if (!isWaiting({ status: interaction.status, ...(interaction.expiresAt === undefined ? {} : { expiresAt: interaction.expiresAt }) }, at)) {
    return { ok: false, code: "QUESTION_CLOSED", message: "Câu hỏi này đã hết hạn." };
  }

  const normalized = normalizeAnswer(interaction, raw);
  if (!normalized.ok) return { ok: false, code: "INVALID_ANSWER", message: normalized.message };
  const answer: QuestionAnswer = normalized.answer;

  const note = answerNote(interaction, answer);
  const blocks: MessageBlock[] = [
    {
      type: "tool-activity",
      toolCallId: deps.newId("call"),
      name: "ask_user_question",
      label: `Trả lời: ${interaction.prompt}`,
      status: "done",
      args: {
        questionId,
        decision: "answered",
        kind: answer.kind,
        ...(answer.text === undefined ? {} : { text: answer.text }),
        ...(answer.optionIds === undefined ? {} : { optionIds: answer.optionIds }),
        ...(answer.confirmed === undefined ? {} : { confirmed: answer.confirmed }),
        ...(answer.viaVoice === true ? { viaVoice: true } : {}),
      },
      result: note,
      startedAt: interaction.createdAt,
      endedAt: at,
    },
  ];
  // One block, not two. The record is what makes the answer findable and what stops the card reading as
  // waiting; the message a person sees is the turn the caller starts from this note, and writing it here as
  // well would put the same sentence in the transcript twice.
  deps.append({ at, blocks });
  return { ok: true, note, blocks };
}

/**
 * Give up on a question.
 *
 * A cancelled question is not an answered one, and the record says so: the tool-activity block is written
 * with `decision: "cancelled"` so that `pendingForConversation` stops returning it while the transcript keeps
 * the fact that it was asked and dropped.
 */
export function cancelQuestion(deps: InteractionDeps, questionId: string, reason = "Người dùng đã bỏ qua câu hỏi này."): boolean {
  const interaction = interactionFor(deps, questionId);
  if (interaction === undefined) return false;
  if (answeredIds(deps.blocks()).has(questionId)) return false;
  const at = deps.now();
  deps.append({
    at,
    blocks: [
      {
        type: "tool-activity",
        toolCallId: deps.newId("call"),
        name: "ask_user_question",
        label: `Bỏ qua: ${interaction.prompt}`,
        status: "done",
        args: { questionId, decision: "cancelled" },
        result: reason,
        startedAt: interaction.createdAt,
        endedAt: at,
      },
    ],
  });
  return true;
}

/**
 * Close the questions whose deadline has passed, and say which ones they were.
 *
 * Expiry is lazy — computed when somebody looks — because the alternative is a timer that has to survive a
 * restart to be correct, and a question that expired while the node was down is exactly the case a timer
 * cannot cover.
 */
export function expireQuestions(deps: InteractionDeps): string[] {
  const at = deps.now();
  const answered = answeredIds(deps.blocks());
  const expired: string[] = [];
  // Scanned from the cards rather than through `pendingForConversation`, and that is not a detail: the pending
  // list is defined by *not* being expired, so asking it which questions are expired can only ever return none.
  for (const block of deps.blocks()) {
    const interaction = interactionFromBlock(block, deps.conversationId);
    if (interaction === undefined || interaction.status !== "waiting") continue;
    if (answered.has(interaction.questionId)) continue;
    if (interaction.expiresAt !== undefined && interaction.expiresAt <= at) expired.push(interaction.questionId);
  }
  for (const questionId of expired) {
    deps.append({
      at,
      blocks: [
        {
          type: "tool-activity",
          toolCallId: deps.newId("call"),
          name: "ask_user_question",
          label: "Câu hỏi đã hết hạn",
          status: "failed",
          args: { questionId, decision: "expired" },
          result: "Câu hỏi hết hạn mà không có câu trả lời.",
          startedAt: at,
          endedAt: at,
        },
      ],
    });
  }
  return expired;
}

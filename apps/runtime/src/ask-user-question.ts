import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { type InteractionDeps, SECRET_REQUEST_MESSAGE, createQuestion } from "./interactions.ts";

/**
 * Asking the user something, as the model may do it.
 *
 * The tool's whole behaviour is one sentence long: it writes a card and returns. It does not wait, subscribe,
 * poll or hold anything open — a turn that asked a question is *over*, and the answer arrives as a new turn
 * with the note the manager builds. That is not a limitation of this implementation; it is the design, because
 * the alternative is an open provider call and an HTTP stream parked on a person's decision, which is what
 * makes a question cost a call per minute it goes unanswered.
 *
 * It also refuses one whole category of question. A secret typed into this card would become a conversation
 * message and would travel to the provider, so the refusal is deterministic and names the tool that can do the
 * job properly (`request_secret`), rather than leaving the model to guess why it was declined.
 */
export function createAskUserQuestionTool(interactions: InteractionDeps): ToolDefinition {
  return {
    name: "ask_user_question",
    label: "Hỏi người dùng một câu",
    description:
      "Ask the user one question and end your turn. Use it when the work is genuinely under-specified — " +
      "several projects could be meant, or a choice changes what happens next — and not to ask permission: " +
      "your operation runs or is refused without this. Prefer `single-choice` with concrete options over " +
      "free text, because the person may answer out loud and options are what a voice can match. This call " +
      "returns immediately and the answer arrives later as a new turn, so do not claim you already have it. " +
      "Never ask for a secret here; a secret must not enter the conversation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question", "kind"],
      properties: {
        question: { type: "string", description: "The question, in the user's language, one sentence." },
        kind: {
          type: "string",
          enum: ["text", "single-choice", "multi-choice", "confirm"],
          description: "text: free answer. single-choice: exactly one option. multi-choice: any number. confirm: yes or no.",
        },
        options: {
          type: "array",
          description: "For the choice kinds: what can be chosen. Two to five concrete options reads best.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label"],
            properties: {
              id: { type: "string", description: "Short stable id, e.g. production." },
              label: { type: "string", description: "What the person sees and can say out loud." },
              description: { type: "string", description: "One line of detail, when the label is not enough." },
            },
          },
        },
        allowOther: { type: "boolean", description: "Whether an answer outside the options is accepted." },
        voicePrompt: { type: "string", description: "Only if you have a better spoken wording than the host's." },
      },
    },
    promptSnippet: "ask_user_question — ask the user to choose; your turn ends and they answer in a new one",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostBlocks?: Record<string, unknown>[] }> => {
      const created = createQuestion(interactions, params);
      if (!created.ok) {
        // Refused in the same turn, so the model can correct itself instead of the person finding out that
        // their answer had nowhere to go. The secret refusal is the one message that must travel verbatim.
        return { text: created.code === "SECRET_REQUEST" ? SECRET_REQUEST_MESSAGE : created.message };
      }

      return {
        text:
          "Câu hỏi đã được hiển thị cho người dùng và lượt này kết thúc ở đây. Câu trả lời sẽ tới ở lượt sau — " +
          "đừng đoán câu trả lời, và đừng nói là bạn đã có nó.",
        // SAFETY: the block was built against the message-block union in `createQuestion`; the adapter's shape
        // is deliberately loose because it must not depend on contracts, and the node validates every block
        // before it reaches a transcript.
        hostBlocks: [created.block as unknown as Record<string, unknown>],
      };
    },
  };
}

/**
 * Turning a spoken sentence into a widget action.
 *
 * ## The id always comes from the view
 *
 * A sentence selects among the actions the focused instance **already offers**; it never produces one. The binding id
 * that eventually gets invoked is read off the semantic view the node was sent, so a person cannot say a word and
 * cause an action the widget never published. This is the difference between voice control and a command language, and
 * it is the whole reason this resolver exists rather than the sentence being handed to a model.
 *
 * ## Why the labels and not an operation
 *
 * The plan for this phase expected the resolver to map a sentence to a `view` operation and return an action proposal.
 * The contract does not support that: an action proposal carries an `operation`, and the actions a semantic view offers
 * carry a binding id and a **label** with no operation at all. So the label is what the words are matched against -
 * which is also the only honest thing to match, because the label is the part a person can see and the part they would
 * say out loud.
 *
 * ## Nothing is guessed
 *
 * A sentence that matches no offered label is refused with a sentence, not routed to a model and not matched loosely.
 * The narrow table below exists only for the phrasings a person actually uses for the actions that exist today
 * (a period change in a calendar surface); anything outside it is refused, and being refused is a complete answer.
 */

import { type SemanticView } from "@clarkcant/contracts";
import { normaliseIntentText } from "@clarkcant/core";

/**
 * How a person might say a label, and what the words mean by it.
 *
 * Grounded in the labels this application actually publishes rather than invented ones: the overview surface offers
 * `period.change` under the label "Đổi khoảng thời gian", and that operation requires `period: "week" | "month"`.
 * So a phrasing carries the argument it implies - saying "xem theo tháng" is a period change *and* which period - while
 * saying only the label implies none, and the widget's own contract then answers that it needs one. That is the honest
 * split: this file knows what words mean, and the widget knows what its operations require.
 */
const PHRASINGS: readonly {
  label: string;
  phrases: readonly { matches: readonly string[]; args: Record<string, unknown> }[];
}[] = [
  {
    label: "doi khoang thoi gian",
    phrases: [
      { matches: ["tuan nay", "xem theo tuan", "theo tuan", "week"], args: { period: "week" } },
      { matches: ["thang nay", "xem theo thang", "theo thang", "month"], args: { period: "month" } },
    ],
  },
];

export interface VoiceWidgetAction {
  /** Read off the focused instance's own actions. Never invented, and never taken from the sentence. */
  actionBindingId: string;
  /** The label the person matched, so the read-back can name what is about to happen. */
  label: string;
  /** Whether the widget says this action needs a person's explicit approval. */
  requiresApproval: boolean;
  /**
   * What the words implied, which the widget's own contract then validates.
   *
   * Empty when the person named the action without saying what it should do. That is not an error here: whether the
   * operation needs an argument is the widget's business, and its refusal names what it wanted.
   */
  args: Record<string, unknown>;
}

export type VoiceWidgetActionResolution =
  | { ok: true; action: VoiceWidgetAction }
  | { ok: false; say: string };

/**
 * Two different refusals, kept different on purpose. "This widget offers nothing" and "I did not understand
 * which of the things it offers you meant" are different facts about the world, and answering both with one
 * sentence made them indistinguishable in a transcript - which is exactly what happened when this was built:
 * the parity journey failed and the single shared sentence could not say which branch had refused it.
 */
const NO_ACTION_SAY = (offered: readonly string[]): string =>
  `Tôi chưa rõ bạn muốn làm gì với widget đang mở. Nó đang có: ${offered.join(", ")}.`;

/** The widget is open and has nothing to offer, so no sentence could have matched. */
const NO_OFFERED_ACTION_SAY = "Widget đang mở không có hành động nào để tôi làm.";

export const NO_FOCUSED_SURFACE_SAY =
  "Hiện không có widget nào đang mở, nên tôi chưa có hành động nào để làm.";

/**
 * Match a sentence to one of the actions this instance offers.
 *
 * Longest label first, so a widget that offers both "Kỳ trước" and "Về kỳ trước" gets the more specific one. The
 * comparison drops tone marks, because transcription is inconsistent about them and the label is a display string
 * rather than a protocol value.
 */
export function resolveVoiceWidgetAction(input: {
  utterance: string;
  focused: SemanticView | undefined;
}): VoiceWidgetActionResolution {
  const focused = input.focused;
  if (focused === undefined) return { ok: false, say: NO_FOCUSED_SURFACE_SAY };
  if (focused.availableActions.length === 0) return { ok: false, say: NO_OFFERED_ACTION_SAY };

  const said = normaliseIntentText(input.utterance);
  if (said === "") return { ok: false, say: offeredSay(focused) };

  const offered = [...focused.availableActions].sort((a, b) => b.label.length - a.label.length);
  for (const candidate of offered) {
    const matched = matchLabel(said, candidate.label);
    if (matched !== undefined) {
      return {
        ok: true,
        action: {
          actionBindingId: candidate.actionBindingId,
          label: candidate.label,
          requiresApproval: candidate.requiresApproval,
          args: matched.args,
        },
      };
    }
  }

  return { ok: false, say: offeredSay(focused) };
}

/**
 * The refusal that names what the widget does offer, rather than only saying that nothing matched.
 *
 * A person who is refused learns what they could have said instead; and a test that fails on this sentence
 * carries the offered labels in its own output, which is how the labels a view really publishes were read
 * here rather than assumed from the composition template.
 */
function offeredSay(focused: SemanticView): string {
  return NO_ACTION_SAY(focused.availableActions.map((action) => action.label));
}

/**
 * What the sentence means by one of the labels this instance offers, or nothing.
 *
 * A phrasing's arguments come with it: "xem theo tháng" is a period change and says which period, so both travel
 * together rather than the argument being reconstructed later from the same words.
 */
function matchLabel(said: string, label: string): { args: Record<string, unknown> } | undefined {
  const bareLabel = normaliseIntentText(label);
  if (bareLabel === "") return undefined;
  if (said === bareLabel || said.includes(bareLabel)) return { args: {} };

  const entry = PHRASINGS.find((phrasing) => phrasing.label === bareLabel);
  for (const phrase of entry?.phrases ?? []) {
    if (phrase.matches.some((match) => said === match || said.includes(match))) return { args: phrase.args };
  }
  return undefined;
}

/** The sentence read back before a spoken widget action runs. */
export function describeVoiceWidgetAction(action: VoiceWidgetAction): string {
  return action.requiresApproval
    ? `Tôi hiểu là bạn muốn ${action.label}. Hành động này cần bạn xác nhận. Bạn xác nhận chứ?`
    : `Tôi ${action.label} nhé.`;
}

/**
 * What running a spoken widget action did.
 *
 * The node answers with the instance and the revision it landed on, because the page has to update the same state a
 * click would have updated - and it can only do that from the node's own account of what changed.
 */
export type VoiceWidgetRun =
  | { ok: true; instanceId: string; revision: number; say: string }
  | { ok: false; say: string };

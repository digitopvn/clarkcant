/**
 * The answer of a spoken turn, accumulated for the surface that is showing it.
 *
 * `answer` promises its caller the text **so far**, because the voice surface replaces what it shows with each update
 * instead of appending. A streaming turn reports **fragments**, and the gap between those two is silent: forwarding a
 * fragment as if it were the whole answer sends one fragment per frame, and the surface replaces one with the next.
 * Measured on a real session, the frames carried "M", "ình", " ch", "ư" …, so the reply appeared not to stream at all.
 *
 * Exported and tested on its own because the caller is the entry point, which no test drives. A test of the consumer's
 * side cannot catch this: it passes the text so far itself, which is the promise rather than the producer.
 */
export function accumulateAnswerText(onText: (text: string) => void): (event: { type: string; text?: string }) => void {
  let soFar = "";
  return (event) => {
    // Only text. Reasoning and tool events belong to the conversation, which is refreshed when the turn ends.
    if (event.type !== "text-delta" || typeof event.text !== "string") return;
    soFar += event.text;
    onText(soFar);
  };
}

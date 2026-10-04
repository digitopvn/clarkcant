/**
 * Whether a stored block is the model's own record of a `run_command` call that the node already answered with a
 * receipt earlier in the same message.
 *
 * When a command runs straight away, the node writes its receipt — the folder, the reason, the output and the exit
 * status that verified it — and then the model's call is recorded with the same command and the same output. Drawn
 * together they read as two commands run back to back. The receipt is the one that says what happened, so the echo
 * is left out; nothing is lost, because everything it carries is in the receipt above it. A call the node did not
 * answer (one still waiting for approval, or one that never ran) has no receipt and is always drawn.
 */
export function echoesCommandReceipt(blocks: readonly Record<string, unknown>[], index: number): boolean {
  const block = blocks[index];
  if (block === undefined || block.type !== "tool-activity" || block.name !== "run_command") return false;
  const args = argsOf(block);
  if (typeof args.decision === "string" || typeof args.command !== "string") return false;
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const candidate = blocks[earlier];
    if (candidate === undefined || candidate.type !== "tool-activity" || candidate.name !== "run_command") continue;
    const receipt = argsOf(candidate);
    // Only the receipt directly before this call answers it: an older run of the same command is its own step.
    return typeof receipt.decision === "string" && receipt.command === args.command;
  }
  return false;
}

function argsOf(block: Record<string, unknown>): Record<string, unknown> {
  return typeof block.args === "object" && block.args !== null ? (block.args as Record<string, unknown>) : {};
}

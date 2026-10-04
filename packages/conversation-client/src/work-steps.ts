/**
 * Folding a run of working steps into one line.
 *
 * A turn that reads files, runs commands and reasons in between can leave twenty receipts above its answer, and the
 * answer is what the person asked for. A run of steps long enough to crowd it is drawn as one line that opens onto
 * every step, in the order they happened; a short run stays as it is, because folding two lines saves nothing and
 * costs a click.
 *
 * Pure, so the rule is testable without a renderer: which items are steps is the caller's to say.
 */

/** Fewer steps than this are shown as they are. */
export const MIN_FOLDED_STEPS = 3;

export type WorkRun<T> =
  | { kind: "item"; index: number; item: T }
  | { kind: "steps"; entries: { index: number; item: T }[]; count: number };

/**
 * Split `items` into single items and folded runs of steps, keeping their order.
 *
 * `isStep` says which items belong to a run; `counts` says which of those are a step of their own rather than a note
 * on the step before it (a check under a command), so the number on the line is the number of things that were done.
 */
export function foldWorkSteps<T>(
  items: readonly T[],
  isStep: (item: T, index: number) => boolean,
  counts: (item: T) => boolean = () => true,
  min: number = MIN_FOLDED_STEPS,
): WorkRun<T>[] {
  const out: WorkRun<T>[] = [];
  let run: { index: number; item: T }[] = [];

  const flush = (): void => {
    const count = run.filter((entry) => counts(entry.item)).length;
    if (count >= min) out.push({ kind: "steps", entries: run, count });
    else for (const entry of run) out.push({ kind: "item", ...entry });
    run = [];
  };

  items.forEach((item, index) => {
    if (isStep(item, index)) {
      run.push({ index, item });
      return;
    }
    flush();
    out.push({ kind: "item", index, item });
  });
  flush();
  return out;
}

/** The stored block types that are the agent working rather than speaking to the person. */
export function isWorkBlock(block: Record<string, unknown>): boolean {
  return block.type === "tool-activity" || block.type === "reasoning" || block.type === "evidence";
}

/** A check under a step is part of that step, not one more thing done. */
export function countsAsStep(block: Record<string, unknown>): boolean {
  return block.type !== "evidence";
}

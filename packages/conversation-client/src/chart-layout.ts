/**
 * Layout decisions for the catalog's SVG charts.
 *
 * Kept apart from the components so the arithmetic is checked by the Node test config: a chart that draws
 * labels on top of each other, or a scale whose top gridline sits below the tallest bar, is wrong in a way
 * no type can catch and only a screenshot would otherwise show.
 */

/** Width a category label needs before a neighbour may start, in CSS pixels at the chart's label size. */
export const MIN_LABEL_SLOT = 44;

/**
 * Show every `stride`-th category label.
 *
 * A fixed step per label is what made a five-week chart unreadable at a narrow width: every label was drawn,
 * each on top of the next. Thinning keeps the first label and spaces the rest evenly, so the reader can still
 * anchor the axis; the omitted values stay available in the point titles and the table alternative.
 */
export function labelStride(count: number, plotWidth: number, minSlot = MIN_LABEL_SLOT): number {
  if (count <= 1 || plotWidth <= 0) return 1;
  const slot = plotWidth / count;
  return Math.max(1, Math.ceil(minSlot / slot));
}

/**
 * Gridline values from zero to a round number at or above `max`.
 *
 * Round steps (1, 2 or 5 times a power of ten) because a gridline at 41 tells the reader nothing a gridline
 * at 40 would not, and the top line is never below the largest value, so no mark rises out of the scale.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / power;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * power;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toFixed(10)));
  return ticks;
}

/** A tick value as the axis prints it: short, and without float noise. */
export function formatTick(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (Math.abs(value) >= 10_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Number(value.toFixed(2)));
}

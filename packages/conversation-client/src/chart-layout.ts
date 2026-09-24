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

/**
 * Gridline values covering `min` to `max`, both widened to a round step, always including zero.
 *
 * A series that dips below zero gets gridlines below zero as well, so the zero line is drawn where zero is rather
 * than the lowest value standing in for it.
 */
export function niceRange(min: number, max: number, target = 4): number[] {
  const low = Number.isFinite(min) ? Math.min(min, 0) : 0;
  const high = Number.isFinite(max) ? Math.max(max, 0) : 0;
  if (low === 0) return niceTicks(high, target);
  const rough = (high - low) / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / power;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * power;
  const first = Math.floor(low / step) * step;
  const last = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Number(value.toFixed(10)) || 0);
  return ticks;
}

/**
 * Tick labels for one axis, printed with a shared unit and as many decimals as the step needs.
 *
 * Formatting the ticks together is what keeps them readable: each on its own, a 0.001 step rounded every label to
 * "0", and 5000 printed in full beside "10k".
 */
export function formatTicks(ticks: number[]): string[] {
  const largest = Math.max(0, ...ticks.map((tick) => Math.abs(tick)));
  const [unit, suffix] = largest >= 1_000_000 ? [1_000_000, "M"] : largest >= 10_000 ? [1_000, "k"] : [1, ""];
  const step = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) / unit : 0;
  const decimals = step > 0 ? Math.min(Math.max(0, -Math.floor(Math.log10(step))), 6) : 2;
  return ticks.map((tick) => {
    const scaled = Number((tick / unit).toFixed(decimals));
    return scaled === 0 ? "0" : `${scaled}${suffix}`;
  });
}

/** One plotted value and the category it belongs to, kept together so a missing value cannot shift the labels. */
export interface ChartPoint {
  label: string;
  value: number;
}

/**
 * The plottable points of one series.
 *
 * A row whose value is missing, null, blank or not a number is left out along with its label: filtering the values
 * alone moved every later value under the previous row's label, and `Number(null)` drew a gap as a real zero.
 */
export function chartPoints(
  rows: Record<string, unknown>[],
  key: string,
  labelOf: (row: Record<string, unknown>) => string,
): ChartPoint[] {
  const points: ChartPoint[] = [];
  for (const row of rows) {
    const raw = row[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (Number.isFinite(value)) points.push({ label: labelOf(row), value });
  }
  return points;
}

export const CHART_HEIGHT = 180;
/** Room for the value axis on the left and the category labels underneath. */
export const CHART_PAD = { left: 36, right: 12, top: 18, bottom: 24 } as const;

export interface ChartGeometry {
  width: number;
  plotWidth: number;
  plotHeight: number;
  ticks: number[];
  /** Where the value zero sits; the axis line is drawn here, and bars grow from it. */
  zero: number;
  scaleY: (value: number) => number;
}

export function chartGeometry(width: number, values: number[]): ChartGeometry {
  const ticks = niceRange(Math.min(...values, 0), Math.max(...values, 0));
  const bottom = ticks[0] ?? 0;
  const top = ticks.at(-1) ?? 1;
  const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const scaleY = (value: number): number =>
    CHART_PAD.top + plotHeight - ((value - bottom) / Math.max(top - bottom, 1e-9)) * plotHeight;
  return {
    width,
    plotWidth: Math.max(width - CHART_PAD.left - CHART_PAD.right, 1),
    plotHeight,
    ticks,
    zero: scaleY(0),
    scaleY,
  };
}

/**
 * Whether the value label at `index` is drawn.
 *
 * Every `stride`-th label, and always the last so the latest value is readable. When the last one falls between two
 * stride positions it takes the place of the stride label before it, which would otherwise sit less than a slot away.
 */
export function valueLabelShown(index: number, count: number, stride: number): boolean {
  const last = count - 1;
  if (index === last) return true;
  return index % stride === 0 && last - index >= stride;
}

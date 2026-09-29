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

/**
 * The frame of a chart `width` pixels wide: the plot area and the value scale.
 *
 * The value ticks default to a range from zero; a chart whose values are not measured from zero (a scatter plot) passes
 * its own, from `niceSpan`.
 */
export function chartGeometry(width: number, values: number[], ticks: number[] = niceRange(Math.min(...values, 0), Math.max(...values, 0))): ChartGeometry {
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
    // A scale that does not reach zero draws its axis along its lowest gridline, not outside the plot.
    zero: scaleY(bottom <= 0 && top >= 0 ? 0 : bottom),
    scaleY,
  };
}

/** A round step (1, 2 or 5 times a power of ten) of about `span / target`. */
function niceStep(span: number, target: number): number {
  const rough = span / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / power;
  return (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * power;
}

/**
 * Gridline values covering `min` to `max` with a round step, without reaching for zero.
 *
 * For a number line whose values are not measured from zero, the x axis of a scatter plot or its y axis: points
 * between 3.4 and 4.6 squeezed into the top fifth of a scale from zero would read as one blob. A single value is given a
 * step either side, so it is drawn inside the plot rather than on its edge.
 */
export function niceSpan(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (high === low) {
    const pad = low === 0 ? 1 : Math.abs(low) / 10;
    low -= pad;
    high += pad;
  }
  const step = niceStep(high - low, target);
  const first = Math.floor(low / step) * step;
  const last = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Number(value.toFixed(10)) || 0);
  return ticks;
}

/** A map from `domain` onto `range`; a domain of one value maps to the middle of the range. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** One band of a stacked area: the series drawn from `lower` up to `upper`, index by index. */
export interface StackedBand {
  lower: number[];
  upper: number[];
}

/**
 * The bands of a stacked area, each series on top of the ones before it.
 *
 * A value that is not a number adds nothing, so a gap never pulls the bands above it down to zero. The node refuses
 * negative values on a stacked area, because a band cannot be stacked below the one it sits on.
 */
export function stackBands(series: readonly (readonly number[])[]): StackedBand[] {
  const length = Math.max(0, ...series.map((values) => values.length));
  let running = Array.from({ length }, () => 0);
  return series.map((values) => {
    const lower = running;
    const upper = lower.map((base, index) => {
      const value = values[index];
      return value !== undefined && Number.isFinite(value) ? base + value : base;
    });
    running = upper;
    return { lower, upper };
  });
}

/**
 * The shape of each series' points, in series order.
 *
 * A series is told apart by its shape and its line pattern as well as its tone, so a reader who cannot tell the tones
 * apart, or a print in grey, still sees which points belong together.
 */
export const MARKER_SHAPES = ["circle", "square", "triangle", "diamond", "cross", "triangle-down", "plus", "ring"] as const;
export type MarkerShape = (typeof MARKER_SHAPES)[number];

/** The line pattern of each series, in series order: solid first, then dashes a reader can tell apart. */
export const SERIES_DASHES = ["", "7 4", "2 3", "9 3 2 3", "1 5", "12 4", "5 2 1 2", "3 6"] as const;

export function markerShape(seriesIndex: number): MarkerShape {
  return MARKER_SHAPES[seriesIndex % MARKER_SHAPES.length] ?? "circle";
}

export function seriesDash(seriesIndex: number): string {
  return SERIES_DASHES[seriesIndex % SERIES_DASHES.length] ?? "";
}

/** An SVG path for a point of `shape` centred on (`cx`, `cy`), about `r` from centre to edge. */
export function markerPath(shape: MarkerShape, cx: number, cy: number, r: number): string {
  const n = (value: number): string => String(Number(value.toFixed(2)));
  const circle = (radius: number): string =>
    `M ${n(cx - radius)} ${n(cy)} a ${n(radius)} ${n(radius)} 0 1 0 ${n(radius * 2)} 0 a ${n(radius)} ${n(radius)} 0 1 0 ${n(-radius * 2)} 0 Z`;
  switch (shape) {
    case "circle":
      return circle(r);
    case "ring":
      return `${circle(r)} ${circle(r * 0.45)}`;
    case "square":
      return `M ${n(cx - r * 0.85)} ${n(cy - r * 0.85)} H ${n(cx + r * 0.85)} V ${n(cy + r * 0.85)} H ${n(cx - r * 0.85)} Z`;
    case "triangle":
      return `M ${n(cx)} ${n(cy - r * 1.1)} L ${n(cx + r)} ${n(cy + r * 0.75)} L ${n(cx - r)} ${n(cy + r * 0.75)} Z`;
    case "triangle-down":
      return `M ${n(cx)} ${n(cy + r * 1.1)} L ${n(cx + r)} ${n(cy - r * 0.75)} L ${n(cx - r)} ${n(cy - r * 0.75)} Z`;
    case "diamond":
      return `M ${n(cx)} ${n(cy - r * 1.15)} L ${n(cx + r * 1.15)} ${n(cy)} L ${n(cx)} ${n(cy + r * 1.15)} L ${n(cx - r * 1.15)} ${n(cy)} Z`;
    case "cross": {
      const a = r * 0.9;
      const w = r * 0.35;
      return (
        `M ${n(cx - a)} ${n(cy - a + w)} L ${n(cx - a + w)} ${n(cy - a)} L ${n(cx)} ${n(cy - w)} L ${n(cx + a - w)} ${n(cy - a)} ` +
        `L ${n(cx + a)} ${n(cy - a + w)} L ${n(cx + w)} ${n(cy)} L ${n(cx + a)} ${n(cy + a - w)} L ${n(cx + a - w)} ${n(cy + a)} ` +
        `L ${n(cx)} ${n(cy + w)} L ${n(cx - a + w)} ${n(cy + a)} L ${n(cx - a)} ${n(cy + a - w)} L ${n(cx - w)} ${n(cy)} Z`
      );
    }
    case "plus": {
      const a = r * 1.05;
      const w = r * 0.38;
      return (
        `M ${n(cx - w)} ${n(cy - a)} H ${n(cx + w)} V ${n(cy - w)} H ${n(cx + a)} V ${n(cy + w)} H ${n(cx + w)} V ${n(cy + a)} ` +
        `H ${n(cx - w)} V ${n(cy + w)} H ${n(cx - a)} V ${n(cy - w)} H ${n(cx - w)} Z`
      );
    }
  }
}

/** Where a chart's keyboard focus is: a point of a series, by row index. */
export interface PointCursor {
  series: number;
  index: number;
}

/**
 * The order the arrow keys walk a series' points in: by x, then by row.
 *
 * An area's rows already rise along x. A scatter's rows can come in any order, and walking them by row made the right
 * arrow jump back and forth across the plot.
 */
export function pointOrder(xs: readonly (number | string)[]): number[] {
  const indices = xs.map((_, index) => index);
  if (!xs.every((x) => typeof x === "number")) return indices;
  return indices.sort((a, b) => (xs[a] as number) - (xs[b] as number) || a - b);
}

/**
 * Where a key moves the focus among a chart's points, or `undefined` when the key is not one the chart handles.
 *
 * Left and right walk the focused series in `order`, Home and End jump to its ends, and up and down move to the same row
 * of the previous or next shown series. The focus never leaves the chart and never lands on a hidden series.
 */
export function movePointCursor(
  key: string,
  cursor: PointCursor,
  shownSeries: readonly number[],
  order: readonly number[],
): PointCursor | undefined {
  if (order.length === 0 || shownSeries.length === 0) return undefined;
  const position = Math.max(0, order.indexOf(cursor.index));
  const seriesAt = Math.max(0, shownSeries.indexOf(cursor.series));
  const series = shownSeries[seriesAt] ?? shownSeries[0] ?? 0;
  const at = (next: number): PointCursor => ({ series, index: order[Math.min(Math.max(next, 0), order.length - 1)] ?? 0 });
  switch (key) {
    case "ArrowRight":
      return at(position + 1);
    case "ArrowLeft":
      return at(position - 1);
    case "Home":
      return at(0);
    case "End":
      return at(order.length - 1);
    case "ArrowUp":
      return { series: shownSeries[Math.max(seriesAt - 1, 0)] ?? series, index: cursor.index };
    case "ArrowDown":
      return { series: shownSeries[Math.min(seriesAt + 1, shownSeries.length - 1)] ?? series, index: cursor.index };
    default:
      return undefined;
  }
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

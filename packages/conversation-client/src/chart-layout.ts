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
  return tickRun(0, max, target) ?? [0, max];
}

/** The most gridlines one axis draws. A step that would need more is not drawn as ticks at all. */
export const MAX_TICKS = 50;

/** A round step (1, 2 or 5 times a power of ten) of about `span / target`; not finite when `span` is too small to divide. */
function niceStep(span: number, target: number): number {
  const rough = span / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / power;
  return (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * power;
}

/**
 * Round-stepped ticks from at or below `low` to at or above `high`, or `undefined` when no usable step exists.
 *
 * Each tick is its index times the step, never the previous tick plus the step: adding a step smaller than the gap
 * between two neighbouring doubles leaves the value where it was, and a loop waiting for it to pass the top never ended.
 * The count is known before a tick is made and is held to `MAX_TICKS`, and a tick is rounded to 15 significant digits,
 * relative to its own size, so a tiny scale keeps its values and a large one loses only float noise.
 */
function tickRun(low: number, high: number, target: number): number[] | undefined {
  const step = niceStep(high - low, target);
  if (!Number.isFinite(step) || step <= 0) return undefined;
  const firstIndex = Math.floor(low / step);
  const count = Math.ceil(high / step) - firstIndex;
  if (!Number.isFinite(count) || count < 1 || count > MAX_TICKS) return undefined;
  const ticks: number[] = [];
  // `|| 0` turns -0 into 0, so the zero line is labelled "0".
  for (let index = 0; index <= count; index += 1) ticks.push(Number(((firstIndex + index) * step).toPrecision(15)) || 0);
  // A round step past the largest double overflows the outer tick; the ends themselves still fit.
  return ticks.every((tick) => Number.isFinite(tick)) ? ticks : undefined;
}

/** The two ends as ticks when no round step fits them, or a unit range when they are not two different numbers. */
function endsOnly(low: number, high: number): number[] {
  return Number.isFinite(low) && Number.isFinite(high) && low < high ? [low, high] : [0, 1];
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
  return tickRun(low, high, target) ?? endsOnly(low, high);
}

/**
 * Tick labels for one axis, printed with a shared unit and as many decimals as the step needs.
 *
 * Formatting the ticks together is what keeps them readable: each on its own, a 0.001 step rounded every label to
 * "0", and 5000 printed in full beside "10k".
 */
export function formatTicks(ticks: number[]): string[] {
  const largest = Math.max(0, ...ticks.map((tick) => Math.abs(tick)));
  const gap = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) : 0;
  const [unit, suffix] =
    largest >= 1e12 ? [1e12, "T"] : largest >= 1e9 ? [1e9, "B"] : largest >= 1e6 ? [1e6, "M"] : largest >= 1e4 ? [1e3, "k"] : [1, ""];
  const step = gap / unit;
  // Past what a T reads well at, or where the step needs more than six decimals of the unit, a label is a number with
  // an exponent and as many significant digits as the step needs: fixed decimals printed every tick of a 1e-12 scale
  // as "0", and every tick of 1T to 1T + 16 as "1T".
  if (largest >= 1e15 || (step > 0 && step < 1e-6)) {
    const digits = gap > 0 && largest > 0 ? Math.min(Math.max(0, Math.floor(Math.log10(largest)) - Math.floor(Math.log10(gap))), 14) : 2;
    return ticks.map((tick) => (tick === 0 ? "0" : withExponent(tick, digits)));
  }
  const decimals = step > 0 ? stepDecimals(step) : 2;
  return ticks.map((tick) => {
    const scaled = Number((tick / unit).toFixed(decimals));
    return scaled === 0 ? "0" : `${scaled}${suffix}`;
  });
}

/** The fewest decimals, up to six, that print `step` as it is: a 2.5T step is "2.5T", never rounded to "3T". */
function stepDecimals(step: number): number {
  let decimals = Math.min(Math.max(0, -Math.floor(Math.log10(step))), 6);
  while (decimals < 6 && Math.abs(Number(step.toFixed(decimals)) - step) > step * 1e-9) decimals += 1;
  return decimals;
}

/** `value` as "1.25e-12": its significant digits and a power of ten, without trailing zeros or a plus sign. */
function withExponent(value: number, digits: number): string {
  const [mantissa = "0", power = "0"] = value.toExponential(digits).split("e");
  return `${String(Number(mantissa))}e${String(Number(power))}`;
}

/**
 * The series a line chart draws when nothing chose one: the props' first named series, then the sample chart's `runs`
 * when its unit says it counts runs (in either language) and the rows have that column, then the first numeric column.
 *
 * The column has to exist: a unit that merely mentions runs ("test runs") over rows keyed otherwise would draw nothing.
 */
export function defaultLineSeries(props: Record<string, unknown>, rows: readonly Record<string, unknown>[]): string {
  if (Array.isArray(props.series) && props.series.length > 0) return String(props.series[0]);
  const first = rows[0] ?? {};
  const countsRuns = typeof props.unit === "string" && (props.unit.includes("lần") || props.unit.includes("runs"));
  if (countsRuns && typeof first.runs === "number") return "runs";
  return Object.keys(first).find((key) => typeof first[key] === "number") ?? "value";
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

/** How wide one character of a tick label is drawn: 11px tabular digits, with room to spare. */
const TICK_CHAR_WIDTH = 7;
/** The space between a value label and the plot it labels. */
export const TICK_GAP = 6;

/**
 * How far the plot starts from the left: the usual pad, or as much as the widest value label needs, so a label such as
 * "-250.5M" or "1.25e-12" is drawn whole rather than cut off at the edge. It never takes more than two fifths of the
 * chart, so the plot keeps its room.
 */
export function plotLeft(labels: readonly string[], width: number): number {
  const widest = Math.max(0, ...labels.map((label) => label.length));
  const needed = Math.ceil(widest * TICK_CHAR_WIDTH) + TICK_GAP + 2;
  return Math.max(CHART_PAD.left, Math.min(needed, Math.floor(width * 0.4)));
}

export interface ChartGeometry {
  width: number;
  /** Where the plot starts: `plotLeft` of the value labels. */
  left: number;
  plotWidth: number;
  plotHeight: number;
  ticks: number[];
  /** The value labels, one per tick, as `formatTicks` prints them. */
  labels: string[];
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
    CHART_PAD.top + plotHeight - ((value - bottom) / (top > bottom ? top - bottom : 1)) * plotHeight;
  const labels = formatTicks(ticks);
  const left = plotLeft(labels, width);
  return {
    width,
    left,
    plotWidth: Math.max(width - left - CHART_PAD.right, 1),
    plotHeight,
    ticks,
    labels,
    // A scale that does not reach zero draws its axis along its lowest gridline, not outside the plot.
    zero: scaleY(bottom <= 0 && top >= 0 ? 0 : bottom),
    scaleY,
  };
}


/**
 * Gridline values covering `min` to `max` with a round step, without reaching for zero.
 *
 * For a number line whose values are not measured from zero, the x axis of a scatter plot or its y axis: points
 * between 3.4 and 4.6 squeezed into the top fifth of a scale from zero would read as one blob. A single value, or values
 * so close that no round step tells them apart (0.3 and 0.1 + 0.2), is given a tenth of itself either side, so it is
 * drawn inside the plot rather than on its edge.
 */
export function niceSpan(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (sameValue(low, high)) {
    const middle = low + (high - low) / 2;
    const pad = Math.abs(middle) > TINY ? Math.abs(middle) / 10 : 1;
    low = middle - pad;
    high = middle + pad;
  }
  return tickRun(low, high, target) ?? endsOnly(low, high);
}

/** Two values this close, relative to their size, are one value on an axis: no round step tells them apart. */
const SAME_VALUE = 1e-9;
/** Below this, a magnitude is zero for an axis: dividing it by a tick count underflows. */
const TINY = 1e-300;

function sameValue(low: number, high: number): boolean {
  return high - low <= Math.max(Math.max(Math.abs(low), Math.abs(high)) * SAME_VALUE, TINY);
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

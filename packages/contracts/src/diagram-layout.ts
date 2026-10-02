import type { Diagram, DiagramNode, DiagramShape } from "./diagram-view.ts";

/**
 * Where each node and edge of a diagram is drawn.
 *
 * One pure function the node and the page both run, so the node can refuse a diagram it could not lay out and the page
 * draws exactly what was checked. It is deterministic — every tie falls back to the order the props gave — and bounded:
 * at most 60 nodes and 120 edges come in, each step is at most quadratic in those, and the number of ordering passes is
 * fixed, so a hostile graph costs a few milliseconds rather than stalling either side. No measurement of rendered text
 * is used: a label is wrapped by character count, so the same props give the same positions on every machine.
 */

/** The height of one line of label text, in the units positions are given in. */
export const DIAGRAM_LINE_HEIGHT = 18;
const PADDING = 24;
const SIBLING_GAP = 28;
/** Room between layers for an edge; a gap an edge label sits in is widened to hold the label. */
const LAYER_GAP: Record<Diagram["direction"], number> = { TB: 64, LR: 96 };
/** How wide a bend point of a long edge is when laid out beside the nodes of a layer it crosses. */
const BEND_SIZE = 20;
/** How far apart, across the flow, two edges joining the same two nodes are drawn. */
const PARALLEL_OFFSET = 10;
/** Fixed ordering passes: enough to untangle a bounded graph, and a known cost whatever the graph. */
const ORDERING_PASSES = 8;

interface ShapeMetrics {
  /** Characters per wrapped line. */
  perLine: number;
  size: (lines: number) => { width: number; height: number };
}

const SHAPES: Record<DiagramShape, ShapeMetrics> = {
  box: { perLine: 20, size: (lines) => ({ width: 168, height: Math.max(48, lines * DIAGRAM_LINE_HEIGHT + 24) }) },
  round: { perLine: 20, size: (lines) => ({ width: 168, height: Math.max(48, lines * DIAGRAM_LINE_HEIGHT + 24) }) },
  diamond: { perLine: 14, size: (lines) => ({ width: 200, height: Math.max(84, lines * DIAGRAM_LINE_HEIGHT + 56) }) },
  circle: {
    perLine: 11,
    size: (lines) => {
      const diameter = Math.max(96, lines * DIAGRAM_LINE_HEIGHT + 44);
      return { width: diameter, height: diameter };
    },
  },
};

/**
 * A label broken into lines of at most `perLine` characters, at spaces where it can be.
 *
 * Counted in code points, so a Vietnamese letter with its marks or an emoji is one character, and a word longer than a
 * line is cut where the line ends rather than overflowing the shape.
 */
export function wrapDiagramLabel(label: string, perLine: number): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  for (const word of label.split(/\s+/u).filter((part) => part !== "")) {
    const characters = Array.from(word);
    if (current.length > 0 && current.length + 1 + characters.length <= perLine) {
      current.push(" ", ...characters);
      continue;
    }
    if (current.length > 0) lines.push(current.join(""));
    current = [];
    for (let start = 0; start < characters.length; start += perLine) {
      const chunk = characters.slice(start, start + perLine);
      if (chunk.length === perLine && start + perLine < characters.length) lines.push(chunk.join(""));
      else current = chunk;
    }
  }
  if (current.length > 0) lines.push(current.join(""));
  return lines.length === 0 ? [""] : lines;
}

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface PlacedDiagramNode {
  id: string;
  shape: DiagramShape;
  /** Top-left corner and size of the shape's box. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The label, wrapped. */
  lines: string[];
  /** The group, drawn as a smaller line above the label, when the node has one. */
  groupLine?: string;
  /** The layer it sits in, counted along the diagram's direction, and its place across that layer. */
  layer: number;
  order: number;
}

export interface PlacedDiagramEdge {
  index: number;
  from: string;
  to: string;
  /** From the `from` node's border to the `to` node's border, through a bend for each layer a long edge crosses. */
  points: DiagramPoint[];
  /** Where its label is centred, when it has one. */
  labelAt?: DiagramPoint;
}

export interface DiagramLayout {
  width: number;
  height: number;
  /** In the order the props gave them. */
  nodes: PlacedDiagramNode[];
  edges: PlacedDiagramEdge[];
  /** The node ids of each layer, in their order across it: what keyboard movement within a layer follows. */
  layers: string[][];
}

interface Vertex {
  /** Index into the diagram's nodes, or -1 for a bend of a long edge. */
  node: number;
  layer: number;
  along: number;
  cross: number;
  /** Centre across the layer, once placed. */
  center: number;
}

function sized(node: DiagramNode, direction: Diagram["direction"]) {
  const metrics = SHAPES[node.shape];
  const lines = wrapDiagramLabel(node.label, metrics.perLine);
  const groupLine = node.group === undefined ? undefined : wrapDiagramLabel(node.group, metrics.perLine)[0];
  const { width, height } = metrics.size(lines.length + (groupLine === undefined ? 0 : 1));
  return { lines, groupLine, width, height, along: direction === "TB" ? height : width, cross: direction === "TB" ? width : height };
}

/** Each node's layer in the layered layout, after reversing the edges that close a cycle, and which edges those are. */
function layering(diagram: Diagram): { layer: number[]; reversed: Set<number> } {
  const count = diagram.nodes.length;
  const indexOf = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const outgoing: { edge: number; to: number }[][] = diagram.nodes.map(() => []);
  for (const edge of diagram.edges) outgoing[indexOf.get(edge.from) ?? 0]?.push({ edge: edge.index, to: indexOf.get(edge.to) ?? 0 });

  // A depth-first walk in props order; an edge back to a node still on the walk closes a cycle and is laid out reversed.
  const reversed = new Set<number>();
  const mark = new Array<number>(count).fill(0);
  const visit = (at: number): void => {
    mark[at] = 1;
    for (const { edge, to } of outgoing[at] ?? []) {
      if (mark[to] === 1) reversed.add(edge);
      else if (mark[to] === 0) visit(to);
    }
    mark[at] = 2;
  };
  for (let index = 0; index < count; index += 1) if (mark[index] === 0) visit(index);

  // Longest path from the sources, taking the lowest-indexed ready node each time so the result never depends on a queue.
  const below: number[][] = diagram.nodes.map(() => []);
  const waiting = new Array<number>(count).fill(0);
  for (const edge of diagram.edges) {
    const from = indexOf.get(edge.from) ?? 0;
    const to = indexOf.get(edge.to) ?? 0;
    const [upper, lower] = reversed.has(edge.index) ? [to, from] : [from, to];
    below[upper]?.push(lower);
    waiting[lower] = (waiting[lower] ?? 0) + 1;
  }
  const layer = new Array<number>(count).fill(0);
  const done = new Array<boolean>(count).fill(false);
  for (let placed = 0; placed < count; placed += 1) {
    const next = waiting.findIndex((left, index) => left === 0 && !done[index]);
    if (next < 0) break;
    done[next] = true;
    for (const lower of below[next] ?? []) {
      layer[lower] = Math.max(layer[lower] ?? 0, (layer[next] ?? 0) + 1);
      waiting[lower] = (waiting[lower] ?? 1) - 1;
    }
  }
  return { layer, reversed };
}

/** Centres across each layer: every layer centred on the widest, its vertices side by side in their order. */
function placeAcross(layers: Vertex[][]): number {
  const widths = layers.map((vertices) => vertices.reduce((sum, vertex) => sum + vertex.cross, 0) + SIBLING_GAP * Math.max(0, vertices.length - 1));
  const widest = Math.max(0, ...widths);
  layers.forEach((vertices, index) => {
    let at = PADDING + ((widest - (widths[index] ?? 0)) / 2);
    for (const vertex of vertices) {
      vertex.center = Math.round(at + vertex.cross / 2);
      at += vertex.cross + SIBLING_GAP;
    }
  });
  return widest;
}

/**
 * How much room an edge label takes along the flow, with a margin on each side: its height when layers stack top to
 * bottom, its width when they run left to right. The width is counted from characters, as the page draws the box.
 */
export function diagramEdgeLabelWidth(label: string): number {
  return Array.from(label).length * 7 + 12;
}
const EDGE_LABEL_HEIGHT = 20;
const EDGE_LABEL_MARGIN = 8;

/** Where each layer starts along the diagram, and how thick it is: the thickest node in it. `gaps[i]` follows layer i. */
function placeAlong(layers: Vertex[][], gaps: number[]): { start: number[]; thickness: number[]; length: number } {
  const thickness = layers.map((vertices) => Math.max(BEND_SIZE, ...vertices.filter((vertex) => vertex.node >= 0).map((vertex) => vertex.along)));
  const start: number[] = [];
  let at = PADDING;
  thickness.forEach((size, index) => {
    start.push(at);
    at += size + (index + 1 < thickness.length ? (gaps[index] ?? 0) : 0);
  });
  return { start, thickness, length: layers.length === 0 ? 0 : at - PADDING };
}

function finish(
  diagram: Diagram,
  layers: Vertex[][],
  sizes: ReturnType<typeof sized>[],
  chains: { edge: number; vertices: Vertex[]; reversed: boolean }[],
): DiagramLayout {
  const tb = diagram.direction === "TB";
  // A label sits in the gap after the upper end of its edge's middle segment; that gap is widened to hold it whole, so a
  // node never covers it.
  const labelled = chains.map(({ edge, vertices, reversed }) => {
    const label = diagram.edges[edge]?.label;
    if (label === undefined) return undefined;
    const middle = Math.max(0, Math.floor((vertices.length - 1) / 2));
    const upper = reversed ? vertices.length - 2 - middle : middle;
    return { upper, room: (tb ? EDGE_LABEL_HEIGHT : diagramEdgeLabelWidth(label)) + EDGE_LABEL_MARGIN * 2 };
  });
  const gaps = layers.map(() => LAYER_GAP[diagram.direction]);
  chains.forEach(({ vertices }, index) => {
    const placed = labelled[index];
    const layer = placed === undefined ? undefined : vertices[Math.max(0, placed.upper)]?.layer;
    if (placed !== undefined && layer !== undefined) gaps[layer] = Math.max(gaps[layer] ?? 0, placed.room);
  });
  const widest = placeAcross(layers);
  const along = placeAlong(layers, gaps);
  const byNode = new Map<number, Vertex>();
  for (const vertices of layers) for (const vertex of vertices) if (vertex.node >= 0) byNode.set(vertex.node, vertex);

  const point = (alongAt: number, crossAt: number): DiagramPoint => (tb ? { x: crossAt, y: alongAt } : { x: alongAt, y: crossAt });
  const alongCenter = (vertex: Vertex): number => Math.round((along.start[vertex.layer] ?? 0) + (along.thickness[vertex.layer] ?? 0) / 2);

  const nodes: PlacedDiagramNode[] = diagram.nodes.map((node, index) => {
    const vertex = byNode.get(index);
    const size = sizes[index];
    if (vertex === undefined || size === undefined) throw new Error("every node has a vertex");
    const center = point(alongCenter(vertex), vertex.center);
    const order = (layers[vertex.layer] ?? []).filter((candidate) => candidate.node >= 0).indexOf(vertex);
    return {
      id: node.id,
      shape: node.shape,
      x: Math.round(center.x - size.width / 2),
      y: Math.round(center.y - size.height / 2),
      width: size.width,
      height: size.height,
      lines: size.lines,
      ...(size.groupLine === undefined ? {} : { groupLine: size.groupLine }),
      layer: vertex.layer,
      order,
    };
  });

  // Edges joining the same two nodes — one each way, or several without a direction — are drawn apart, not on one line.
  const seen = new Map<string, number>();
  const edges: PlacedDiagramEdge[] = chains.map(({ edge, vertices, reversed }, chainIndex) => {
    const first = vertices[0];
    const last = vertices.at(-1);
    if (first === undefined || last === undefined) throw new Error("every edge has two ends");
    const source = diagram.edges[edge];
    if (source === undefined) throw new Error("every chain is an edge");
    const pair = [source.from, source.to].sort().join("\u0000");
    const repeat = seen.get(pair) ?? 0;
    seen.set(pair, repeat + 1);
    const offset = repeat === 0 ? 0 : (repeat % 2 === 1 ? 1 : -1) * PARALLEL_OFFSET * Math.ceil(repeat / 2);
    const half = (vertex: Vertex): number => vertex.along / 2;
    // Leaves the upper node at its far side and enters the lower one at its near side, through each bend's centre.
    const points = [
      point(alongCenter(first) + half(first), first.center + offset),
      ...vertices.slice(1, -1).map((vertex) => point(alongCenter(vertex), vertex.center + offset)),
      point(alongCenter(last) - half(last), last.center + offset),
    ];
    if (reversed) points.reverse();
    const placed = labelled[chainIndex];
    let labelAt: DiagramPoint | undefined;
    if (placed !== undefined) {
      // Centred in its gap along the flow, where the middle segment crosses that line.
      const upper = vertices[Math.max(0, placed.upper)];
      const lower = vertices[Math.max(0, placed.upper) + 1] ?? upper;
      if (upper !== undefined && lower !== undefined) {
        const gapStart = (along.start[upper.layer] ?? 0) + (along.thickness[upper.layer] ?? 0);
        const gapCenter = gapStart + (gaps[upper.layer] ?? 0) / 2;
        const from = point(upper === first ? alongCenter(first) + half(first) : alongCenter(upper), upper.center + offset);
        const to = point(lower === last ? alongCenter(last) - half(last) : alongCenter(lower), lower.center + offset);
        const [fromAlong, fromCross, toAlong, toCross] = tb ? [from.y, from.x, to.y, to.x] : [from.x, from.y, to.x, to.y];
        const t = toAlong === fromAlong ? 0.5 : Math.min(1, Math.max(0, (gapCenter - fromAlong) / (toAlong - fromAlong)));
        labelAt = point(Math.round(fromAlong + (toAlong - fromAlong) * t), Math.round(fromCross + (toCross - fromCross) * t));
      }
    }
    return { index: edge, from: source.from, to: source.to, points, ...(labelAt === undefined ? {} : { labelAt }) };
  });

  const across = widest + PADDING * 2;
  const lengthwise = along.length + PADDING * 2;
  return {
    width: Math.max(1, tb ? across : lengthwise),
    height: Math.max(1, tb ? lengthwise : across),
    nodes,
    edges,
    layers: layers.map((vertices) => vertices.filter((vertex) => vertex.node >= 0).map((vertex) => diagram.nodes[vertex.node]?.id ?? "")),
  };
}

function layered(diagram: Diagram, sizes: ReturnType<typeof sized>[]): DiagramLayout {
  const { layer, reversed } = layering(diagram);
  const indexOf = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const depth = Math.max(-1, ...layer) + 1;
  const layers: Vertex[][] = Array.from({ length: depth }, () => []);
  const real: Vertex[] = diagram.nodes.map((_, index) => {
    const size = sizes[index];
    const vertex: Vertex = { node: index, layer: layer[index] ?? 0, along: size?.along ?? 0, cross: size?.cross ?? 0, center: 0 };
    layers[vertex.layer]?.push(vertex);
    return vertex;
  });

  // A long edge gets a bend in every layer it crosses, so it is ordered with the nodes there instead of cutting through them.
  const upperOf = new Map<Vertex, Vertex[]>();
  const lowerOf = new Map<Vertex, Vertex[]>();
  const link = (upper: Vertex, lower: Vertex): void => {
    upperOf.set(lower, [...(upperOf.get(lower) ?? []), upper]);
    lowerOf.set(upper, [...(lowerOf.get(upper) ?? []), lower]);
  };
  const chains = diagram.edges.map((edge) => {
    const isReversed = reversed.has(edge.index);
    const from = real[indexOf.get(edge.from) ?? 0];
    const to = real[indexOf.get(edge.to) ?? 0];
    if (from === undefined || to === undefined) throw new Error("every edge joins two nodes");
    const [upper, lower] = isReversed ? [to, from] : [from, to];
    const vertices: Vertex[] = [upper];
    for (let at = upper.layer + 1; at < lower.layer; at += 1) {
      const bend: Vertex = { node: -1, layer: at, along: 0, cross: BEND_SIZE, center: 0 };
      layers[at]?.push(bend);
      vertices.push(bend);
    }
    vertices.push(lower);
    for (let at = 1; at < vertices.length; at += 1) {
      const above = vertices[at - 1];
      const below = vertices[at];
      if (above !== undefined && below !== undefined) link(above, below);
    }
    return { edge: edge.index, vertices, reversed: isReversed };
  });

  // Barycentre ordering, down then up, a fixed number of times. A vertex with no neighbour on the side being read keeps
  // its place, and the sort is stable, so equal weights keep the order they had.
  for (let pass = 0; pass < ORDERING_PASSES; pass += 1) {
    const down = pass % 2 === 0;
    const sequence = down ? layers.map((_, index) => index).slice(1) : layers.map((_, index) => index).slice(0, -1).reverse();
    for (const at of sequence) {
      const vertices = layers[at] ?? [];
      const neighbourLayer = layers[down ? at - 1 : at + 1] ?? [];
      const position = new Map(neighbourLayer.map((vertex, index) => [vertex, index]));
      const weight = new Map(
        vertices.map((vertex, index) => {
          const neighbours = (down ? upperOf.get(vertex) : lowerOf.get(vertex)) ?? [];
          if (neighbours.length === 0) return [vertex, index];
          return [vertex, neighbours.reduce((sum, neighbour) => sum + (position.get(neighbour) ?? 0), 0) / neighbours.length];
        }),
      );
      vertices.sort((left, right) => (weight.get(left) ?? 0) - (weight.get(right) ?? 0));
    }
  }
  return finish(diagram, layers, sizes, chains);
}

function tree(diagram: Diagram, sizes: ReturnType<typeof sized>[]): DiagramLayout {
  const indexOf = new Map(diagram.nodes.map((node, index) => [node.id, index]));
  const children: number[][] = diagram.nodes.map(() => []);
  const hasParent = new Array<boolean>(diagram.nodes.length).fill(false);
  for (const edge of diagram.edges) {
    const from = indexOf.get(edge.from) ?? 0;
    const to = indexOf.get(edge.to) ?? 0;
    children[from]?.push(to);
    hasParent[to] = true;
  }
  const roots = diagram.nodes.map((_, index) => index).filter((index) => hasParent[index] !== true);
  const depthOf = new Array<number>(diagram.nodes.length).fill(0);
  const extent = new Array<number>(diagram.nodes.length).fill(0);
  // How much room a subtree needs across: its own node, or its children side by side, whichever is wider.
  const measure = (at: number, depth: number): number => {
    depthOf[at] = depth;
    const kids = children[at] ?? [];
    const kidsWidth = kids.reduce((sum, kid) => sum + measure(kid, depth + 1), 0) + SIBLING_GAP * Math.max(0, kids.length - 1);
    extent[at] = Math.max(sizes[at]?.cross ?? 0, kidsWidth);
    return extent[at] ?? 0;
  };
  for (const root of roots) measure(root, 0);

  const vertices: Vertex[] = diagram.nodes.map((_, index) => ({
    node: index,
    layer: depthOf[index] ?? 0,
    along: sizes[index]?.along ?? 0,
    cross: sizes[index]?.cross ?? 0,
    center: 0,
  }));
  // Each subtree centred in the room it measured, its children side by side within that room.
  const centers = new Array<number>(diagram.nodes.length).fill(0);
  const place = (at: number, start: number): void => {
    const center = start + (extent[at] ?? 0) / 2;
    centers[at] = center;
    const kids = children[at] ?? [];
    const kidsWidth = kids.reduce((sum, kid) => sum + (extent[kid] ?? 0), 0) + SIBLING_GAP * Math.max(0, kids.length - 1);
    let from = center - kidsWidth / 2;
    for (const kid of kids) {
      place(kid, from);
      from += (extent[kid] ?? 0) + SIBLING_GAP;
    }
  };
  let start = PADDING;
  for (const root of roots) {
    place(root, start);
    start += (extent[root] ?? 0) + SIBLING_GAP;
  }

  const depth = Math.max(-1, ...depthOf) + 1;
  const layers: Vertex[][] = Array.from({ length: depth }, () => []);
  for (const vertex of vertices) layers[vertex.layer]?.push(vertex);
  for (const row of layers) row.sort((left, right) => (centers[left.node] ?? 0) - (centers[right.node] ?? 0));
  const chains = diagram.edges.map((edge) => {
    const from = vertices[indexOf.get(edge.from) ?? 0];
    const to = vertices[indexOf.get(edge.to) ?? 0];
    if (from === undefined || to === undefined) throw new Error("every edge joins two nodes");
    return { edge: edge.index, vertices: [from, to], reversed: false };
  });
  const layout = finish(diagram, layers, sizes, chains);
  // `finish` centres layers side by side; a tree keeps the centres it measured, so a child stays under its parent.
  const tb = diagram.direction === "TB";
  const shift = (index: number): number => Math.round(centers[index] ?? 0) - (vertices[index]?.center ?? 0);
  const nodes = layout.nodes.map((node, index) => (tb ? { ...node, x: node.x + shift(index) } : { ...node, y: node.y + shift(index) }));
  const edges = layout.edges.map((edge) => {
    const from = indexOf.get(edge.from) ?? 0;
    const to = indexOf.get(edge.to) ?? 0;
    const [a, b] = edge.points;
    if (a === undefined || b === undefined) return edge;
    const points = tb
      ? [{ x: a.x + shift(from), y: a.y }, { x: b.x + shift(to), y: b.y }]
      : [{ x: a.x, y: a.y + shift(from) }, { x: b.x, y: b.y + shift(to) }];
    if (edge.labelAt === undefined) return { ...edge, points };
    // The label keeps its place along the flow, in the middle of its gap, and moves across with the line it labels.
    const [start, end] = points as [DiagramPoint, DiagramPoint];
    const t = tb ? (end.y === start.y ? 0.5 : (edge.labelAt.y - start.y) / (end.y - start.y)) : end.x === start.x ? 0.5 : (edge.labelAt.x - start.x) / (end.x - start.x);
    const labelAt = tb
      ? { x: Math.round(start.x + (end.x - start.x) * t), y: edge.labelAt.y }
      : { x: edge.labelAt.x, y: Math.round(start.y + (end.y - start.y) * t) };
    return { ...edge, points, labelAt };
  });
  const across = Math.max(0, start - SIBLING_GAP - PADDING) + PADDING * 2;
  return {
    ...layout,
    width: tb ? Math.max(1, across) : layout.width,
    height: tb ? layout.height : Math.max(1, across),
    nodes,
    edges,
  };
}

/** Lay a checked diagram out. Same diagram, same numbers, on the node and on the page. */
export function layoutDiagram(diagram: Diagram): DiagramLayout {
  const sizes = diagram.nodes.map((node) => sized(node, diagram.direction));
  return diagram.layout === "tree" ? tree(diagram, sizes) : layered(diagram, sizes);
}

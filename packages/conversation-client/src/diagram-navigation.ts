import { type Diagram, type DiagramLayout, diagramNeighbours } from "@clarkcant/contracts";

/**
 * Where a key moves focus in a drawn diagram, or `undefined` when it does not move it.
 *
 * Moving follows the edges rather than the picture: the key pointing along the flow (Down top to bottom, Right left to
 * right) goes to a node an edge leads to, the opposite key to a node an edge comes from, and an edge with no direction
 * counts both ways. When several nodes qualify, the one nearest across the flow is chosen, ties going to the earlier node
 * in the props, so the same key from the same node always lands on the same node. The two keys across the flow step to
 * the neighbouring node in the same layer, which is how a person reaches the other targets; Home and End go to the first
 * and the last node of the props.
 */
export function diagramKeyTarget(key: string, diagram: Diagram, layout: DiagramLayout, fromId: string): string | undefined {
  const tb = diagram.direction === "TB";
  const forwardKey = tb ? "ArrowDown" : "ArrowRight";
  const backwardKey = tb ? "ArrowUp" : "ArrowLeft";
  const beforeKey = tb ? "ArrowLeft" : "ArrowUp";
  const afterKey = tb ? "ArrowRight" : "ArrowDown";
  if (key === "Home") return diagram.nodes[0]?.id;
  if (key === "End") return diagram.nodes.at(-1)?.id;
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));
  const from = placed.get(fromId);
  if (from === undefined) return undefined;

  if (key === beforeKey || key === afterKey) {
    const layer = layout.layers[from.layer] ?? [];
    return layer[layer.indexOf(fromId) + (key === afterKey ? 1 : -1)];
  }
  if (key !== forwardKey && key !== backwardKey) return undefined;

  const neighbours = diagramNeighbours(diagram, fromId);
  const candidates = [...(key === forwardKey ? neighbours.next : neighbours.previous), ...neighbours.linked];
  const across = (id: string): number => {
    const node = placed.get(id);
    if (node === undefined) return Number.POSITIVE_INFINITY;
    return tb ? node.x + node.width / 2 : node.y + node.height / 2;
  };
  const here = across(fromId);
  let best: { id: string; distance: number; index: number } | undefined;
  for (const candidate of candidates) {
    const distance = Math.abs(across(candidate.id) - here);
    if (best === undefined || distance < best.distance || (distance === best.distance && candidate.index < best.index)) {
      best = { id: candidate.id, distance, index: candidate.index };
    }
  }
  return best?.id;
}

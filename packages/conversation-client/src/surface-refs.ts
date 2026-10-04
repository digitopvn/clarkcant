/**
 * Whether a stored block is a reference to a widget instance that a surface block in the same message already draws.
 *
 * A sample recipe answers with the surface it drew and a reference to the same instance, so the node can find the
 * instance from the message. The reference's text is what to show when the instance cannot be drawn, and the surface
 * has its own text for that; drawn together, the widget appeared with its catalog description printed under it, in
 * English, as if it were part of the reply. A reference to an instance no surface in the message names is always drawn.
 */
export function repeatsDrawnSurface(blocks: readonly Record<string, unknown>[], index: number): boolean {
  const block = blocks[index];
  if (block === undefined || block.type !== "widget-ref" || typeof block.instanceId !== "string") return false;
  return blocks.some((candidate) => {
    if (candidate.type !== "surface") return false;
    const snapshot = typeof candidate.snapshot === "object" && candidate.snapshot !== null ? (candidate.snapshot as Record<string, unknown>) : {};
    return snapshot.instanceId === block.instanceId;
  });
}

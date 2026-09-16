import { type ReactElement, isValidElement } from "react";

/**
 * Helpers for testing block renderers.
 *
 * Not a spec file, so vitest does not collect it. The renderers are called as plain functions —
 * they return `ReactElement`, which is an ordinary object — so a tree can be walked without a DOM.
 * Walking the real tree is a stronger check than asserting against a mock, because it fails when a
 * prop stops reaching the element that draws it.
 */

/** Every element in the tree carrying the given prop. */
export function findAll(node: unknown, prop: string): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (!isValidElement(current)) return;
    const element = current as ReactElement<Record<string, unknown>>;
    if (prop in element.props) found.push(element);
    walk(element.props.children);
  };
  walk(node);
  return found;
}

/** All visible text under a node, so an assertion can be about what a reader would see. */
export function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<Record<string, unknown>>;
  return textOf(element.props.children);
}

/** A block whose owner is not the host, which every host card must refuse. */
export function nonHost(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, owner: "widget" };
}

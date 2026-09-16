import { type ReactElement, isValidElement } from "react";

import { describe, expect, it } from "vitest";

import { SettingsRow, ToolRow } from "../src/SettingsPanel.tsx";

/**
 * Settings rows and capability rows.
 *
 * Called as plain functions, like the task-card tests: they return `ReactElement`, which is an
 * ordinary object, so the tree can be walked without a DOM.
 *
 * The assertions here are about the two things a settings screen is most tempted to smooth over:
 * a capability that is not usable being shown as though it were, and a limitation being hidden in
 * a tooltip that most people never hover.
 */

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<Record<string, unknown>>;
  return textOf(element.props.children);
}

function findAll(node: unknown, prop: string): ReactElement<Record<string, unknown>>[] {
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

describe("a capability row", () => {
  it("says it is usable in a word, not only in a colour", () => {
    const element = ToolRow({ toolRef: "project.code.change@1", summary: "Sửa mã nguồn", usable: true });
    expect(textOf(element)).toContain("dùng được");
  });

  it("says it is not usable, and gives the reason", () => {
    const element = ToolRow({
      toolRef: "project.code.change@1",
      summary: "Sửa mã nguồn",
      usable: false,
      blockedReason: "chưa worker nào nạp pack này trên node",
    });
    const text = textOf(element);
    expect(text).toContain("chưa dùng được");
    // The reason is rendered, not hidden. A blocked gate is reported as blocked — the blueprint's
    // rule — and a state without its reason is not a report.
    expect(text).toContain("chưa worker nào nạp pack này trên node");
    expect(findAll(element, "data-blocked-reason")).toHaveLength(1);
  });

  it("carries the reference and the usable flag as attributes", () => {
    const element = ToolRow({ toolRef: "x@1", summary: "s", usable: false }) as ReactElement<
      Record<string, unknown>
    >;
    expect(element.props["data-tool-ref"]).toBe("x@1");
    expect(element.props["data-usable"]).toBe(false);
  });

  it("does not invent a reason when there is none", () => {
    const element = ToolRow({ toolRef: "x@1", summary: "s", usable: true });
    expect(findAll(element, "data-blocked-reason")).toHaveLength(0);
    expect(textOf(element)).not.toContain("undefined");
  });
});

describe("a settings row", () => {
  it("renders its description rather than hiding it in a tooltip", () => {
    const element = SettingsRow({ label: "Trần một lượt", description: "Lượt vượt trần sẽ bị dừng." });
    expect(textOf(element)).toContain("Lượt vượt trần sẽ bị dừng.");
    // A `title` attribute would pass a naive text check while being invisible until hover.
    expect((element as ReactElement<Record<string, unknown>>).props.title).toBeUndefined();
  });

  it("marks its state so a limitation can be styled as one", () => {
    const blocked = SettingsRow({ label: "Giọng nói", state: "blocked" }) as ReactElement<
      Record<string, unknown>
    >;
    expect(blocked.props["data-state"]).toBe("blocked");
    expect((SettingsRow({ label: "A" }) as ReactElement<Record<string, unknown>>).props["data-state"]).toBe("ok");
  });
});

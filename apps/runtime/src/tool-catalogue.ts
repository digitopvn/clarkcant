import type { AppIntentLocale } from "@clarkcant/contracts";

import { hostText } from "./host-text.ts";

/**
 * The tools this node offers, for an interface that has to be able to say so.
 *
 * The catalogue is published by whoever builds the tools rather than rebuilt on demand, because building them needs
 * the search index, the project finder and the approval wiring: a route that built its own copy would be a second
 * source of truth for what this node can do, and the first thing to drift.
 *
 * A registry rather than a parameter threaded through the gateway, because the gateway is built before the tools are
 * and a tool that is registered after the fact is still a tool this node has.
 */
export interface ToolCatalogueEntry {
  name: string;
  label: string;
  description: string;
}

/** The tools the pi agent carries on its own, before any extension it loads. */
export const PI_BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

let catalogue: readonly ToolCatalogueEntry[] = [];

/** Published once at boot, by whoever builds this node's tools. */
export function registerNodeTools(tools: readonly ToolCatalogueEntry[]): void {
  catalogue = [...tools];
}

/**
 * What this harness offers right now.
 *
 * Empty before boot and after a failed boot, which is the truth: a node whose tools were never built has none to
 * offer, and an interface that invented a list would be describing a node that is not running.
 */
export function nodeToolCatalogue(): readonly ToolCatalogueEntry[] {
  return catalogue;
}

/**
 * The Tools tab as a person reads it, in their interface language (Vietnamese when none is named).
 *
 * A tool's label is the host's word for it: one of this node's own tools is named in the language the row its call
 * leaves is named in (`HostText.toolLabel`), and a tool the host has no words for keeps the label it was defined with.
 * A description is what the model is told and stays as it is; the agent's built-ins are described by the host, so
 * theirs follow the language too.
 */
export function toolsTab(locale: AppIntentLocale = "vi"): {
  self: ToolCatalogueEntry[];
  agent: ToolCatalogueEntry[];
  agentNote: string;
} {
  const text = hostText(locale);
  return {
    self: catalogue.map((tool) => ({ ...tool, label: text.toolLabel(tool.name, tool.label) })),
    agent: PI_BUILTIN_TOOL_NAMES.map((name) => ({ name, ...text.toolsTab.agentTools[name] })),
    agentNote: text.toolsTab.agentNote,
  };
}

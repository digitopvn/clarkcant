import {
  describeSemanticDoc,
  normalizeSemanticDoc,
  SEMANTIC_LIMITS,
  semanticDelta,
  semanticProposalSchema,
  uiContextNote,
  type SemanticProposal,
  type WidgetSemanticDoc,
} from "@clarkcant/contracts";

export const SEMANTIC_PUBLISH_CHURN_LIMIT = 4;
export const SEMANTIC_PUBLISH_CHURN_WINDOW_MS = 1_000;

export interface SemanticInspection {
  doc: WidgetSemanticDoc;
  revision: number;
  clippedOrDropped: string[];
  delta: string[];
  contextNote: string;
  inspectUi: string;
  churnWarning: boolean;
}

export function semanticDocWithinLimits(doc: WidgetSemanticDoc): boolean {
  const valuesFit = Object.values(doc.values).every((value) =>
    typeof value === "string"
      ? value.length <= SEMANTIC_LIMITS.string
      : !Array.isArray(value) ||
        (value.length <= SEMANTIC_LIMITS.list && value.every((entry) => entry.length <= SEMANTIC_LIMITS.listEntry)),
  );
  const actionsFit = doc.availableActions.every((action) => action.label.length <= SEMANTIC_LIMITS.string);
  return (
    Object.keys(doc.values).length <= SEMANTIC_LIMITS.values &&
    valuesFit &&
    doc.summary.length <= SEMANTIC_LIMITS.summary &&
    (doc.title?.length ?? 0) <= SEMANTIC_LIMITS.string &&
    doc.selectedIds.length <= SEMANTIC_LIMITS.selectedIds &&
    doc.availableActions.length <= SEMANTIC_LIMITS.actions &&
    actionsFit &&
    Buffer.byteLength(JSON.stringify(doc), "utf8") <= SEMANTIC_LIMITS.bytes
  );
}

function clippedOrDropped(proposal: SemanticProposal, doc: WidgetSemanticDoc): string[] {
  const fields: string[] = [];
  if (doc.summary !== proposal.summary) fields.push("summary");

  const values = proposal.values ?? {};
  for (const [key, value] of Object.entries(values)) {
    const normalized = doc.values[key];
    if (normalized === undefined) fields.push("values." + key + " (dropped)");
    else if (JSON.stringify(normalized) !== JSON.stringify(value)) fields.push("values." + key + " (cleaned or clipped)");
  }

  if (JSON.stringify(doc.selectedIds) !== JSON.stringify(proposal.selectedIds ?? [])) {
    fields.push("selectedIds (cleaned or clipped)");
  }
  return fields;
}

export function inspectSemanticProposal(input: {
  definitionId: string;
  rawProposal: unknown;
  previous?: { doc: WidgetSemanticDoc; revision: number };
  revision: number;
  recentPublishTimes: readonly number[];
  now: number;
}): { ok: true; inspection: SemanticInspection; recentPublishTimes: number[] } | { ok: false; problems: string[] } {
  const parsed = semanticProposalSchema.safeParse(input.rawProposal);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => (issue.path.join(".") || "proposal") + ": " + issue.message),
    };
  }

  const doc = normalizeSemanticDoc({
    instanceId: "dev-instance",
    definitionId: input.definitionId,
    summary: parsed.data.summary,
    ...(parsed.data.values === undefined ? {} : { values: parsed.data.values }),
    ...(parsed.data.selectedIds === undefined ? {} : { selectedIds: parsed.data.selectedIds }),
    source: "frame",
    freshness: "sample",
  });
  const previous = input.previous;
  const context = uiContextNote([
    {
      doc,
      revision: input.revision,
      ...(previous === undefined ? {} : { seen: previous }),
    },
  ]);
  const recentPublishTimes = [
    ...input.recentPublishTimes.filter((time) => input.now - time < SEMANTIC_PUBLISH_CHURN_WINDOW_MS),
    input.now,
  ];

  return {
    ok: true,
    recentPublishTimes,
    inspection: {
      doc,
      revision: input.revision,
      clippedOrDropped: clippedOrDropped(parsed.data, doc),
      delta: previous === undefined ? [] : semanticDelta(previous.doc, doc),
      contextNote: context.text,
      inspectUi: describeSemanticDoc(doc).join("\n"),
      churnWarning: recentPublishTimes.length > SEMANTIC_PUBLISH_CHURN_LIMIT,
    },
  };
}

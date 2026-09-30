/**
 * The calendar's one view binding, made when a calendar is placed and given to a calendar placed before it had one.
 *
 * A calendar writes its view — month, week or agenda, the day and the event selected — through `calendar.view`, a view
 * operation the node checks against the rows it holds. Calendars placed before the calendar had views were placed with
 * no binding at all, so their view switcher would move the screen while nothing was saved and the node kept describing
 * the month. Those calendars are upgraded where the node already reads an older widget in its current shape — the
 * timeline — by giving them the same binding placement gives a new one: same operation, same dataset, same read-only
 * effect, owned by the node that owns the calendar. Nothing else about the instance changes, and no database migration
 * is involved: the binding is an ordinary row, written once, the first time the calendar is read.
 */

import {
  type ActionBinding,
  type WidgetInstance,
  CALENDAR_VIEW_OPERATION,
  compileActionBinding,
} from "@clarkcant/contracts";
import { type WidgetDeps, getActionBinding, getInstance, saveActionBindingWithinTransaction } from "@clarkcant/core";
import { CALENDAR } from "@clarkcant/data-canvas";
import { transaction } from "@clarkcant/storage";

/** The binding a calendar's view switcher, days and events write through. */
export function calendarViewBinding(
  deps: WidgetDeps,
  input: { instanceId: string; definitionRef: { id: string; version: string; packageDigest: string }; datasetRef: string },
): ActionBinding {
  const compiled = compileActionBinding({
    bindingId: deps.newId("act"),
    instance: {
      instanceId: input.instanceId,
      ownerNodeId: deps.nodeId,
      definitionRef: input.definitionRef,
      actionBindingRevision: 1,
    },
    packageGeneration: input.definitionRef.packageDigest,
    label: "Calendar view",
    proposal: { kind: "view", operation: CALENDAR_VIEW_OPERATION, args: {} },
    inputSchema: { type: "object" },
    allowedDataRefs: [input.datasetRef],
    fixedConstraints: {},
    // A view operation reads and re-renders; it writes nothing outside the node's own state.
    effectCategory: "read",
    requiresApproval: false,
    limits: {},
    bindingDigest: `sha256:${CALENDAR_VIEW_OPERATION}:${input.instanceId}`,
    at: deps.now(),
    knownCapabilities: new Set(),
  });
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.binding;
}

function hasViewBinding(deps: WidgetDeps, instance: WidgetInstance): boolean {
  return instance.actionBindingIds.some((bindingId) => {
    const proposal = getActionBinding(deps, bindingId)?.proposal;
    return proposal?.kind === "view" && proposal.operation === CALENDAR_VIEW_OPERATION;
  });
}

/**
 * The calendar with its view binding, given one when it was placed without.
 *
 * Only a standalone calendar this node owns, over a dataset it names, is upgraded; any other instance is returned as it
 * is. The check and the write are one transaction, so two pages reading the same calendar at once give it one binding.
 */
export function withCalendarViewBinding(deps: WidgetDeps, instance: WidgetInstance): WidgetInstance {
  if (instance.definitionRef.id !== CALENDAR.id || instance.ownerNodeId !== deps.nodeId) return instance;
  const datasetRef = instance.props.datasetRef;
  if (typeof datasetRef !== "string" || datasetRef === "") return instance;
  if (hasViewBinding(deps, instance)) return instance;
  return transaction(deps.db, () => {
    const current = getInstance(deps, instance.instanceId);
    if (current === undefined || hasViewBinding(deps, current)) return current ?? instance;
    saveActionBindingWithinTransaction(
      deps,
      calendarViewBinding(deps, { instanceId: current.instanceId, definitionRef: current.definitionRef, datasetRef }),
    );
    return getInstance(deps, current.instanceId) ?? current;
  });
}

import { createHash } from "node:crypto";

import type { ActResult } from "@clarkcant/browser-playwright";
import { type AutomationAction, type CapabilityRef, type EffectRecord, advanceEffect } from "@clarkcant/contracts";
import { markEffectUnknown, prepareEffect } from "@clarkcant/core";
import { effectsForTask, transaction, upsertEffect } from "@clarkcant/storage";

import { unknownEffectsNotice } from "./effect-notices.ts";
import { tryRecordNodeNotice } from "./notices.ts";
import type { NodeServices } from "./services.ts";

/**
 * A consequential browser action, written into the task's effect ledger around the driver's own report.
 *
 * A submit, a payment, a send: the driver marks these `consequential`, and a click that timed out on one may have landed
 * (the driver says `unknown`, never `failed`, for exactly that reason). The driver alone keeps that answer in memory for
 * as long as its page lives; the ledger keeps it for the task. So the effect is written down as handed off before the
 * driver acts, and settled on what the driver reported:
 *
 *   - `applied` confirms it, `failed` and `refused` say it did not happen;
 *   - `unknown` (a timeout) marks it unknown, which moves the task to `uncertain` in the same write, and leaves one
 *     notice in the inbox under the task's own key — the same notice, with the same "It took effect" / "It did not take
 *     effect" answer, a command that timed out leaves.
 *
 * Once a task has an unknown effect, no later consequential action or click of it is handed to the driver: whether the
 * first one landed decides whether the second would do it twice. A non-consequential action (navigate, read, type) is passed
 * straight through — unless the driver reports it sent something all the same (a button a script turned into a
 * submission): that effect is written down after the fact, with the same settlement and the same notice, because an
 * effect nobody classified still happened outside.
 *
 * The task broker (`task-browser.ts`) is the production caller: every click and fill a task's worker asks for goes
 * through here.
 */
export interface BrowserActor {
  act(action: AutomationAction, options: { approvalGranted: boolean }): Promise<ActResult>;
}

export interface BrowserEffectLedger {
  services: Pick<NodeServices, "runtime" | "conductor">;
  taskId: string;
  runId?: string;
}

/** The capability a browser action is carried out under, which is how the effect ledger names it. */
export const BROWSER_CAPABILITY = "browser.playwright@1" as CapabilityRef;

/** The action as a person recognises it in a notice: what it did, to what, where. Never the typed value. */
function browserIntent(action: AutomationAction): string {
  const target = typeof action.arguments.elementRef === "string" ? ` ${action.arguments.elementRef}` : "";
  const url = typeof action.arguments.url === "string" ? ` ${action.arguments.url}` : "";
  return `browser ${action.operation}${target}${url} — ${action.targetId}`.slice(0, 2000);
}

/** The exact operation, so the ledger can tell this action from another one; the typed value is hashed, not stored. */
export function browserDigest(action: AutomationAction): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ targetId: action.targetId, operation: action.operation, arguments: action.arguments }))
    .digest("hex");
  return `sha256:${hash}`;
}

function refused(message: string): ActResult {
  return { status: "refused", verification: "not-applicable", message, requiresReobservation: false };
}

function openBrowserEffect(ledger: BrowserEffectLedger, action: AutomationAction, described?: string): EffectRecord {
  const deps = ledger.services.conductor;
  return transaction(deps.db, () => {
    const prepared = prepareEffect(deps, {
      taskId: ledger.taskId,
      ...(ledger.runId === undefined ? {} : { runId: ledger.runId }),
      executorNodeId: deps.nodeId,
      category: "external-write",
      capabilityRef: BROWSER_CAPABILITY,
      intent: described === undefined ? browserIntent(action) : `${described} — ${action.targetId}`.slice(0, 2000),
      operationDigest: browserDigest(action),
      externalSupportsDedup: false,
    });
    const submitted = advanceEffect(prepared, { to: "submitted", at: deps.now() });
    if (!submitted.ok) throw new Error(submitted.message);
    upsertEffect(deps.db, submitted.effect);
    return submitted.effect;
  });
}

/**
 * Settle the effect on the driver's report. An unknown one is marked through the task machine (the task turns
 * `uncertain` with it); when the task cannot take that event — it is already uncertain — the row is still moved, and
 * the notice is recorded either way: deduplicated by the task's key, so a second unknown effect of the same task is
 * counted in that one notice rather than announced again.
 */
function settleBrowserEffect(ledger: BrowserEffectLedger, effect: EffectRecord, result: ActResult | undefined): void {
  const deps = ledger.services.conductor;
  try {
    const at = deps.now();
    if (result === undefined || result.status === "unknown") {
      const reason =
        result === undefined ? "the browser driver failed before it reported an outcome" : result.message.slice(0, 1000);
      if (!markEffectUnknown(deps, effect.effectId, reason).ok) {
        const moved = advanceEffect(effect, { to: "unknown", at, reason });
        if (moved.ok) upsertEffect(deps.db, moved.effect);
      }
      const notice = unknownEffectsNotice(deps.db, ledger.taskId, at);
      if (notice !== undefined) tryRecordNodeNotice(ledger.services, notice);
      return;
    }
    const moved = advanceEffect(
      effect,
      result.status === "applied"
        ? { to: "confirmed", at, evidence: `the browser reported it applied (${result.verification})` }
        : { to: "failed", at, evidence: `the browser reported it ${result.status}: ${result.message}`.slice(0, 1000) },
    );
    if (moved.ok) upsertEffect(deps.db, moved.effect);
  } catch (cause) {
    process.stderr.write(
      `effect ledger: could not settle ${effect.effectId} (${cause instanceof Error ? cause.message : String(cause)})\n`,
    );
  }
}

export async function actWithLedger(
  ledger: BrowserEffectLedger,
  driver: BrowserActor,
  action: AutomationAction,
  options: {
    approvalGranted: boolean;
    /** What the action is in the words a person recognises — "browser click “Send” on example.com/form". */
    describe?: string;
  },
): Promise<ActResult> {
  const act = { approvalGranted: options.approvalGranted };
  // A click nobody classified can still send something, so while an earlier action's outcome is unknown no click is
  // handed over at all; reading, filling in and opening a page stay possible, so the task can still look.
  if (action.consequential || action.operation === "click") {
    const unknown = effectsForTask(ledger.services.conductor.db, ledger.taskId).find((earlier) => earlier.state === "unknown");
    if (unknown !== undefined) {
      const earlier = unknown.intent.split(" — ")[0] ?? unknown.intent;
      return refused(
        `not run: an earlier action of this task ("${earlier}") may or may not have taken effect, and nothing on this ` +
          `node can tell which; another action that sends something could do the same thing twice`,
      );
    }
  }
  if (!action.consequential) {
    const result = await driver.act(action, act);
    if (result.sentEffect === true) {
      // Nobody classified it, and it sent something anyway: the ledger still has to hold it, settled on what came back.
      // The click already happened, so a ledger that cannot be written is said, never turned into the click's result.
      try {
        settleBrowserEffect(ledger, openBrowserEffect(ledger, action, options.describe), result);
      } catch (cause) {
        process.stderr.write(
          `effect ledger: could not record a browser action of task ${ledger.taskId} after the fact (${cause instanceof Error ? cause.message : String(cause)})\n`,
        );
      }
    }
    return result;
  }

  const effect = openBrowserEffect(ledger, action, options.describe);
  let result: ActResult | undefined;
  try {
    result = await driver.act(action, act);
    return result;
  } finally {
    settleBrowserEffect(ledger, effect, result);
  }
}

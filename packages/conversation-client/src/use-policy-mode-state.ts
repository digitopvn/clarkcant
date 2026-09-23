import { useCallback, useEffect, useState } from "react";

import { executionModeSchema, type ExecutionMode } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";

/** What a node with nothing read yet, or an unreadable answer, is treated as: the product default. */
const DEFAULT_POLICY_MODE: ExecutionMode = "autonomous";

export interface PolicyModeState {
  /** `autonomous | guarded | ask`, published on the shell as `data-policy-mode` (DESIGN.md §4). */
  policyMode: ExecutionMode;
  /**
   * Re-reads the mode from the node.
   *
   * `ControlSettings`'s `ExecutionPolicySettings` writes the canonical policy through `PUT /autonomy`
   * rather than through this preference, and `execution.mode` is the node's own projection of that
   * write (see the comment on `ExecutionPolicySettings`). This surface has no push channel for it, so
   * a save there calls this the same way a save in `ExperienceSettings` calls `onOrbChange`.
   */
  refresh: () => void;
}

/**
 * `execution.mode`, as the root shell publishes it, rather than a value a component re-derives from
 * unrelated DOM state.
 *
 * A component that wants to know whether the node asks before acting should read `data-policy-mode`
 * off the shell instead of guessing from, say, whether an approval card happens to be open.
 */
export function usePolicyModeState(client: GatewayClient): PolicyModeState {
  const [policyMode, setPolicyMode] = useState<ExecutionMode>(DEFAULT_POLICY_MODE);

  const read = useCallback(() => {
    let cancelled = false;
    void client
      .preferences()
      .then((answer) => {
        if (cancelled) return;
        const entry = answer.preferences.find((preference) => preference.key === "execution.mode");
        const parsed = executionModeSchema.safeParse(entry?.value);
        setPolicyMode(parsed.success ? parsed.data : DEFAULT_POLICY_MODE);
      })
      .catch(() => {
        // An unreadable node is treated as the default rather than left in whatever mode was last known:
        // a stale "guarded" badge after a node goes away would claim a judgment layer that may no longer run.
        if (!cancelled) setPolicyMode(DEFAULT_POLICY_MODE);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => read(), [read]);

  return { policyMode, refresh: read };
}

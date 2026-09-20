import { useCallback, useEffect, useState } from "react";

import type { RegisteredPreference } from "@clarkcant/contracts";

import type { GatewayClient } from "../../api.ts";

/**
 * The registered preferences, read and written through the gateway.
 *
 * One reader for every settings tab, so no tab invents its own key, its own default, or its own idea of
 * when a change takes effect. The node is the authority on all three: it answers with the keys it declares,
 * the value each one has (or its declared default, marked as a default), and the moment a change applies.
 *
 * Two rules the shape enforces:
 *
 *   - **A default is shown as a default.** `isDefault` travels with the value, so a control can render the
 *     state the product would actually use without presenting it as a choice somebody made.
 *   - **Nothing is optimistically updated.** The stored value that comes back is what the control shows. A
 *     surface that painted the new value before the node accepted it would show a setting that does not
 *     exist, and the refusal would arrive after the user had moved on.
 */

export interface PreferenceStatus {
  key: string;
  tone: "ok" | "error";
  message: string;
}

export interface PreferencesHandle {
  /** Undefined until the node answers. An empty array means the node declares none. */
  preferences: RegisteredPreference[] | undefined;
  /** Set when the list could not be read at all, which is a different state from an empty list. */
  problem: string | undefined;
  /** The key being written right now, so one control can show that it is the one in flight. */
  pending: string | undefined;
  status: PreferenceStatus | undefined;
  /** The whole record, for a caller that wants `applies` or `isDefault` as well as the value. */
  preference: (key: string) => RegisteredPreference | undefined;
  /** A string value, or the fallback. Never a guess at what an unreadable value meant. */
  text: (key: string, fallback: string) => string;
  /** A boolean value, or the fallback. */
  flag: (key: string, fallback: boolean) => boolean;
  /** An object value, for a patch-shaped preference such as the orb's. */
  record: (key: string) => Record<string, unknown> | undefined;
  write: (key: string, value: unknown) => void;
  /** Undo the last write, which is how a control offers "back to what it was". */
  undo: (key: string) => void;
  /**
   * Return a preference to its declared default, however many writes it took to get away from it.
   *
   * Distinct from `undo`, which steps back exactly one write. A control labelled "reset" means the default,
   * and a preference somebody edited four times would otherwise need four presses — which is not what the
   * word promises. Implemented as repeated undo rather than as a second write of the default, because writing
   * the default would store it as a choice: the surface would then show a value the user picked rather than
   * the state of having never picked one.
   */
  reset: (key: string) => void;
  reload: () => void;
}

/**
 * When a change is actually in effect, in words.
 *
 * The point of the preference registry declaring this is that the surface can say it instead of implying
 * that something already running changed underneath the reader.
 */
const APPLIES_LABEL: Record<string, string> = {
  immediate: "áp dụng ngay",
  "next-turn": "áp dụng từ lượt kế tiếp",
  "next-session": "áp dụng cho phiên mới",
  "next-voice-session": "áp dụng cho phiên thoại kế tiếp",
  "desktop-restart": "áp dụng sau khi mở lại app",
};

export function usePreferences(client: GatewayClient, open: boolean): PreferencesHandle {
  const [preferences, setPreferences] = useState<RegisteredPreference[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<PreferenceStatus | undefined>(undefined);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .preferences()
      .then((answer) => {
        if (cancelled) return;
        setPreferences(answer.preferences);
        setProblem(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Reported rather than left empty: a node that cannot answer and a node that declares no
        // preferences look identical otherwise, and only one of them is worth acting on.
        setProblem(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, generation]);

  const preference = useCallback(
    (key: string): RegisteredPreference | undefined =>
      preferences?.find((candidate) => candidate.key === key),
    [preferences],
  );

  const text = useCallback(
    (key: string, fallback: string): string => {
      const value = preference(key)?.value;
      return typeof value === "string" ? value : fallback;
    },
    [preference],
  );

  const flag = useCallback(
    (key: string, fallback: boolean): boolean => {
      const value = preference(key)?.value;
      return typeof value === "boolean" ? value : fallback;
    },
    [preference],
  );

  const record = useCallback(
    (key: string): Record<string, unknown> | undefined => {
      const value = preference(key)?.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      return value as Record<string, unknown>;
    },
    [preference],
  );

  /**
   * Write one preference, then show what the node stored.
   *
   * The refusal message comes from the node and names the field rather than the value, which is what makes it
   * safe to render beside the control that was wrong.
   */
  const write = useCallback(
    (key: string, value: unknown): void => {
      setPending(key);
      setStatus(undefined);
      client
        .writePreference(key, value)
        .then((answer) => {
          setPreferences((current) => {
            if (current === undefined) return current;
            return current.map((entry) => (entry.key === key ? answer.preference : entry));
          });
          setStatus({
            key,
            tone: "ok",
            message: `Đã lưu — ${APPLIES_LABEL[answer.preference.applies] ?? answer.preference.applies}.`,
          });
        })
        .catch((cause: unknown) => {
          setStatus({
            key,
            tone: "error",
            message: cause instanceof Error ? cause.message : "Không lưu được lựa chọn này.",
          });
        })
        .finally(() => {
          setPending((current) => (current === key ? undefined : current));
        });
    },
    [client],
  );

  const undo = useCallback(
    (key: string): void => {
      setPending(key);
      setStatus(undefined);
      client
        .undoPreference(key)
        .then((answer) => {
          setPreferences((current) => {
            if (current === undefined) return current;
            return current.map((entry) => (entry.key === key ? answer.preference : entry));
          });
          setStatus({
            key,
            tone: "ok",
            // Both outcomes are real answers: a key nobody has written has nothing to undo, and saying so is
            // better than reporting a change that did not happen.
            message: answer.undone ? "Đã trả về giá trị trước đó." : "Chưa từng được đặt, nên không có gì để hoàn tác.",
          });
        })
        .catch((cause: unknown) => {
          setStatus({
            key,
            tone: "error",
            message: cause instanceof Error ? cause.message : "Không hoàn tác được.",
          });
        })
        .finally(() => {
          setPending((current) => (current === key ? undefined : current));
        });
    },
    [client],
  );

  /**
   * How many undo steps a reset will take before giving up.
   *
   * A bound rather than a `while (true)`: each step is a request, and a preference that somehow never reported
   * itself as default would otherwise be an unbounded loop against the node. Eight is far past any real edit
   * history for a settings field.
   */
  const RESET_MAX_STEPS = 8;

  const reset = useCallback(
    (key: string): void => {
      setPending(key);
      setStatus(undefined);
      const step = async (remaining: number): Promise<void> => {
        if (remaining <= 0) {
          setStatus({ key, tone: "error", message: "Không đưa được về mặc định. Thử lại sau." });
          return;
        }
        const answer = await client.undoPreference(key);
        setPreferences((current) => {
          if (current === undefined) return current;
          return current.map((entry) => (entry.key === key ? answer.preference : entry));
        });
        if (answer.preference.isDefault) {
          setStatus({ key, tone: "ok", message: "Đã trở về mặc định." });
          return;
        }
        await step(remaining - 1);
      };
      void step(RESET_MAX_STEPS)
        .catch((cause: unknown) => {
          setStatus({
            key,
            tone: "error",
            message: cause instanceof Error ? cause.message : "Không đặt lại được.",
          });
        })
        .finally(() => {
          setPending((current) => (current === key ? undefined : current));
        });
    },
    [client],
  );

  return {
    preferences,
    problem,
    pending,
    status,
    preference,
    text,
    flag,
    record,
    write,
    undo,
    reset,
    reload: () => setGeneration((current) => current + 1),
  };
}

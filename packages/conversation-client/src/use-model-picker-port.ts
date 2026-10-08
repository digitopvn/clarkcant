import { useCallback, useMemo, useRef, useState } from "react";

import { GatewayError, type GatewayClient } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
import type { ModelChoiceState, ModelChoices, ModelPickerPort } from "./model-picker.tsx";

/**
 * What the model picker reads and does, from one client: the `/model` card, and the step a sign-in offers next — in a
 * `/login` card or in Settings — all choose through here, so a choice is applied one way wherever it is made.
 *
 * The catalogue and the model in use come from the node; the sign-in list may fail on its own, which leaves the
 * catalogue usable with the status unknown rather than guessed. A choice goes through `chooseModel`, the node's own
 * validated path, and only when the person confirmed it in the picker.
 */
export function useModelPickerPort(client: GatewayClient, t: (key: MessageKey) => string): Required<ModelPickerPort> {
  const readModelChoices = useCallback(async (): Promise<ModelChoices> => {
    const [model, auth] = await Promise.all([
      client.model(),
      client.providerAuth().then(
        (answer) => answer.providers,
        () => undefined,
      ),
    ]);
    return { current: model.current, catalogue: model.catalogue, auth };
  }, [client]);
  const subscribeModelChange = useCallback((listener: () => void) => client.onModelChange(listener), [client]);

  const [modelChoice, setModelChoice] = useState<Record<string, ModelChoiceState>>({});
  /** Pickers whose choice is on its way, so a second press — or a double click — sends nothing more. */
  const choosing = useRef(new Set<string>());
  const onModelChoose = useCallback(
    ({ key, provider, id }: { key: string; provider: string; id: string }) => {
      if (choosing.current.has(key)) return;
      choosing.current.add(key);
      const model = `${provider}/${id}`;
      setModelChoice((current) => ({ ...current, [key]: { status: "pending", model } }));
      void client
        .chooseModel({ provider, id })
        .then(
          (answer) => setModelChoice((current) => ({ ...current, [key]: { status: "done", model, applies: answer.applies } })),
          (error: unknown) =>
            setModelChoice((current) => ({
              ...current,
              [key]: {
                status: "failed",
                model,
                // The node's own words for a refusal (a signed-out provider, a model no longer offered), without its code.
                message: error instanceof GatewayError ? error.reason : error instanceof Error ? error.message : t("commandCard.failed"),
              },
            })),
        )
        .finally(() => choosing.current.delete(key));
    },
    [client, t],
  );

  /** What the person chose after a sign-in: the same answer twice is the same answer. */
  const [afterSignIn, setAfterSignIn] = useState<Record<string, "choosing" | "kept">>({});
  const onAfterSignIn = useCallback(
    ({ key, choice }: { key: string; choice: "choosing" | "kept" }) =>
      setAfterSignIn((current) => (current[key] === choice ? current : { ...current, [key]: choice })),
    [],
  );

  return useMemo(
    () => ({ readModelChoices, subscribeModelChange, onModelChoose, modelChoice, afterSignIn, onAfterSignIn }),
    [readModelChoices, subscribeModelChange, onModelChoose, modelChoice, afterSignIn, onAfterSignIn],
  );
}

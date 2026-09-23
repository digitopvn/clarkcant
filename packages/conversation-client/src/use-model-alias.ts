import { useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";

export interface ModelAliasState {
  /**
   * Which model profile the hotkey is on.
   *
   * Undefined means "not read yet", which is different from "no pool": a node with no pool runs
   * the model it was configured with and shows nothing here.
   */
  modelAlias: string | undefined;
  modelNote: string;
}

/**
 * The active model alias, and the Cmd/Ctrl+] hotkey that cycles it.
 *
 * The hotkey lives on the window rather than on the composer, because a model switch is not
 * typing — it has to work while the transcript has focus. `preventDefault` because Cmd/Ctrl+] is
 * a browser shortcut in some layouts and a resize gesture in others, neither of which should
 * happen while somebody is choosing a model. The answer says it applies to a new generation,
 * because a running turn keeps the model it started with.
 *
 * `t` is a parameter rather than `useT()` here: this hook is called directly from `Conversation`'s
 * own body, which renders before `Conversation`'s `<LocaleProvider>` — a child of its return, not
 * an ancestor of it — is mounted, so reading the context internally would throw.
 */
export function useModelAlias(client: GatewayClient, t: (key: MessageKey) => string): ModelAliasState {
  const [modelAlias, setModelAlias] = useState<string | undefined>(undefined);
  const [modelNote, setModelNote] = useState<string>("");

  useEffect(() => {
    client
      .modelPool()
      .then((answer) => setModelAlias(answer.currentAlias))
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "]" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void client
        .cycleModel()
        .then((answer) => {
          setModelAlias(answer.alias);
          setModelNote(t("shell.model.nextGeneration").replace("{alias}", answer.alias));
        })
        .catch((cause: unknown) => setModelNote(cause instanceof Error ? cause.message : String(cause)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [client, t]);

  return { modelAlias, modelNote };
}

import { useCallback, useEffect, useState } from "react";

import { GatewayError, type GatewayClient } from "./api.ts";
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
  /**
   * Moves to the next profile the way the hotkey does, updating the alias and note, and answers with the note.
   *
   * The one way a model switch is made from this page, so an agent's `model.cycle` and the hotkey cannot leave the
   * alias on screen disagreeing with the pool. Rejects with the node's reason when it refused.
   */
  cycleModel: () => Promise<string>;
  /** The same for one configured alias. */
  selectModel: (alias: string) => Promise<string>;
}

/**
 * The hotkey as this machine's keyboard spells it.
 *
 * The handler accepts either modifier, so both spellings are true; showing the one printed on the person's own
 * keyboard is what makes the hint usable. A Windows or Linux user reading "⌘]" has to translate a key they do not
 * have. The platform string is a parameter so the choice is testable without a browser.
 */
export function modelSwitchShortcut(platform: string | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "") ? "⌘]" : "Ctrl+]";
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

  const applySwitch = useCallback(
    async (switched: Promise<{ alias: string }>): Promise<string> => {
      try {
        const answer = await switched;
        const note = t("shell.model.nextGeneration").replace("{alias}", answer.alias);
        setModelAlias(answer.alias);
        setModelNote(note);
        return note;
      } catch (cause) {
        // The node's own sentence, without its error code: this note is read by a person, and the agent is told it too.
        const reason =
          cause instanceof GatewayError && cause.reason !== ""
            ? cause.reason
            : cause instanceof Error
              ? cause.message
              : String(cause);
        setModelNote(reason);
        throw new Error(reason, { cause });
      }
    },
    [t],
  );
  const cycleModel = useCallback(() => applySwitch(client.cycleModel()), [applySwitch, client]);
  const selectModel = useCallback((alias: string) => applySwitch(client.selectModel(alias)), [applySwitch, client]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "]" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      // The note already says what went wrong; there is no one else to tell.
      cycleModel().catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleModel]);

  return { modelAlias, modelNote, cycleModel, selectModel };
}

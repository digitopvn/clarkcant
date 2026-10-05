import { useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";

/** The model the next turn runs, as the node reports it. */
export interface ActiveModel {
  provider: string;
  id: string;
  /** Absent when the node names no thinking level, so sessions use pi's own default. */
  thinkingLevel?: string;
}

/**
 * The model the next turn runs, for the composer's statusline.
 *
 * Read from the node rather than remembered from Settings, because the node is what decides: a pick, the pool hotkey
 * and the environment all end there. Read again whenever this page changes the model and when the window comes back
 * into focus, since another surface (the CLI, a phone) may have changed it meanwhile. `undefined` is "not read yet",
 * `null` is a node with no model, and neither draws a model on the statusline.
 */
export function useActiveModel(client: GatewayClient): ActiveModel | null | undefined {
  const [model, setModel] = useState<ActiveModel | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      client
        .node()
        .then((node) => {
          if (!live) return;
          setModel(
            node.model === null
              ? null
              : {
                  provider: node.model.provider,
                  id: node.model.id,
                  ...(node.model.thinkingLevel === undefined ? {} : { thinkingLevel: node.model.thinkingLevel }),
                },
          );
        })
        // A statusline that cannot be read keeps what it last showed; the conversation itself is unaffected.
        .catch(() => undefined);
    };
    read();
    const stop = client.onModelChange(read);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      stop();
      window.removeEventListener("focus", read);
    };
  }, [client]);

  return model;
}

import { useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";
import { fetchSuggestions } from "./suggestions.ts";
import type { Suggestion } from "@clarkcant/contracts";

/**
 * What the node suggests, which is nothing until it answers and nothing if it cannot.
 *
 * Empty is the ordinary state rather than a failure: the four written chips are the fallback and
 * are drawn whenever this is empty, so a node that is slow, old or unreachable costs the person a
 * suggestion list and never the screen.
 */
export function useDynamicSuggestions(client: GatewayClient): Suggestion[] {
  const [dynamicSuggestions, setDynamicSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchSuggestions(client).then((items) => {
      if (!cancelled) setDynamicSuggestions(items);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return dynamicSuggestions;
}

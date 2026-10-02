import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayClient } from "./api.ts";
import { type ConnectionStatus, type ConnectionWatch, documentVisibility, watchConnection } from "./connection-watch.ts";

export type { ConnectionFailure, ConnectionState, ConnectionStatus } from "./connection-watch.ts";

export interface ConnectionView extends ConnectionStatus {
  /** Checks now instead of waiting out the backoff. */
  checkNow: () => void;
}

/**
 * Whether the gateway answers, checked until it does.
 *
 * "Ready" means the runtime answered; it does not mean a provider credential is configured. A failed check is retried
 * with a capped backoff (see `watchConnection`) so a node that was still starting, or a network blip, does not leave the
 * page offline until a reload. Checking pauses while the page is hidden and stops on unmount, cancelling the request in
 * flight, so a slow reply cannot write into a component that is gone and nothing keeps running in the background.
 */
export function useConnectionStatus(client: GatewayClient): ConnectionView {
  const [status, setStatus] = useState<ConnectionStatus>({ state: "connecting", checking: true, attempts: 0 });
  const watch = useRef<ConnectionWatch | undefined>(undefined);

  useEffect(() => {
    const visibility = typeof document === "undefined" ? undefined : documentVisibility(document);
    const current = watchConnection({
      check: (signal) => client.health({ signal }),
      onChange: setStatus,
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...(visibility === undefined ? {} : { visibility }),
    });
    watch.current = current;
    return () => {
      current.stop();
      if (watch.current === current) watch.current = undefined;
    };
  }, [client]);

  const checkNow = useCallback(() => watch.current?.checkNow(), []);
  return { ...status, checkNow };
}

import { useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";

export type ConnectionState = "connecting" | "ready" | "offline";

/**
 * Whether the gateway answers, checked once.
 *
 * "Ready" means the runtime answered; it does not mean a provider credential is configured. The
 * check runs once so the status reflects reality rather than optimism, and is cancelled on
 * unmount so a slow reply cannot write into a component that is gone.
 */
export function useConnectionStatus(client: GatewayClient): ConnectionState {
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then(() => {
        if (!cancelled) setConnection("ready");
      })
      .catch(() => {
        if (!cancelled) setConnection("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return connection;
}

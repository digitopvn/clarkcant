import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProviderSignInView } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";

/** Often enough that a finished browser sign-in shows within a moment, rarely enough to stay quiet. */
const SIGN_IN_POLL_MS = 1500;

export interface ProviderSignIns {
  /** The sign-ins started from this surface, keyed by the place that started them (a card row, a settings row). */
  signIns: Readonly<Record<string, ProviderSignInView>>;
  /** Starts the provider's own sign-in and follows it under `key`. Rejects when the node refused to start it. */
  start: (key: string, providerId: string, method: "oauth" | "api_key") => Promise<void>;
  /** Follows a sign-in the node answered with, reading it again while the provider is still deciding. */
  follow: (key: string, view: ProviderSignInView) => void;
  answer: (input: { key: string; signInId: string; value: string }) => void;
  cancel: (input: { key: string; signInId: string }) => void;
  /** Removes the credential pi stored for a provider; the model list is told to read itself again. */
  signOut: (providerId: string) => Promise<{ providerId: string; signedOut: boolean }>;
}

/**
 * Signing in to and out of pi's providers, as `/login`, `/logout` and Settings → AI & Routing all do it.
 *
 * One path on purpose: the card in the conversation and the settings row start the same sign-in on the node
 * (`POST /providers/:id/sign-in`), follow it the same way, and hand an answer straight through without keeping it.
 * A sign-in is followed by reading it again while it runs: the provider decides when it moves on — a browser page
 * finishing, a code arriving — so the surface asks rather than guesses. A finished sign-in or sign-out changes what
 * the model picker can offer, so both tell the client's model listeners.
 */
export function useProviderSignIns(client: GatewayClient, onError: (message: string) => void): ProviderSignIns {
  const [signIns, setSignIns] = useState<Record<string, ProviderSignInView>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
    };
  }, []);

  const follow = useCallback(
    (key: string, view: ProviderSignInView) => {
      setSignIns((current) => ({ ...current, [key]: view }));
      const previous = timers.current.get(key);
      if (previous !== undefined) clearTimeout(previous);
      timers.current.delete(key);
      if (view.state !== "running" && view.state !== "waiting") {
        // A provider that is now signed in changes what the model picker can offer.
        if (view.state === "done") client.notifyModelChange();
        return;
      }
      timers.current.set(
        key,
        setTimeout(() => {
          void client.providerSignIn(view.signInId).then(
            (next) => follow(key, next),
            (error: unknown) =>
              setSignIns((current) => ({
                ...current,
                [key]: { ...view, state: "failed", prompt: undefined, error: error instanceof Error ? error.message : String(error) },
              })),
          );
        }, SIGN_IN_POLL_MS),
      );
    },
    [client],
  );

  const start = useCallback(
    async (key: string, providerId: string, method: "oauth" | "api_key") => {
      const view = await client.startProviderSignIn(providerId, method);
      follow(key, view);
    },
    [client, follow],
  );

  const answer = useCallback(
    ({ key, signInId, value }: { key: string; signInId: string; value: string }) => {
      void client.answerProviderSignIn(signInId, value).then(
        (view) => follow(key, view),
        (error: unknown) => onError(error instanceof Error ? error.message : String(error)),
      );
    },
    [client, follow, onError],
  );

  const cancel = useCallback(
    ({ key, signInId }: { key: string; signInId: string }) => {
      void client.cancelProviderSignIn(signInId).then(
        (view) => follow(key, view),
        (error: unknown) => onError(error instanceof Error ? error.message : String(error)),
      );
    },
    [client, follow, onError],
  );

  const signOut = useCallback(
    async (providerId: string) => {
      const result = await client.signOutProvider(providerId);
      client.notifyModelChange();
      return result;
    },
    [client],
  );

  return useMemo(() => ({ signIns, start, follow, answer, cancel, signOut }), [signIns, start, follow, answer, cancel, signOut]);
}

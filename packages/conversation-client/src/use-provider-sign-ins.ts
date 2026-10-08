import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProviderSignInView } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { refusalReason } from "./node-view-refusal.ts";

/** Often enough that a finished browser sign-in shows within a moment, rarely enough to stay quiet. */
const SIGN_IN_POLL_MS = 1500;

export interface ProviderSignIns {
  /** The sign-ins started from this surface, keyed by the place that started them (a card row, a settings row). */
  signIns: Readonly<Record<string, ProviderSignInView>>;
  /** Starts the provider's own sign-in and follows it under `key`. Rejects when the node refused to start it. */
  start: (key: string, providerId: string, method: "oauth" | "api_key") => Promise<void>;
  /** Follows a sign-in the node answered with, reading it again while the provider is still deciding. */
  follow: (key: string, view: ProviderSignInView) => void;
  /**
   * Follows the sign-ins the node is still running, each under the key `keyOf` gives it (none: not this surface's).
   * What a surface does when it opens again, so a sign-in it left is shown rather than resumed unseen by a press.
   */
  reattach: (keyOf: (view: ProviderSignInView) => string | undefined) => void;
  answer: (input: { key: string; signInId: string; value: string }) => void;
  cancel: (input: { key: string; signInId: string }) => void;
  /** Removes the credential pi stored for a provider; the model list is told to read itself again. */
  signOut: (providerId: string) => Promise<{ providerId: string; signedOut: boolean }>;
}

/**
 * What a sign-in, sign-out press settles on, in the same words wherever it was pressed: a `/login` or `/logout` card
 * row and a Settings provider row say the same thing about the same answer.
 */
export type ProviderPressOutcome = { status: "done" | "failed"; message: string };

/** A sign-in that could not start, with the node's own reason and never its code. */
export function signInStartRefused(error: unknown, t: (key: MessageKey) => string): ProviderPressOutcome {
  return { status: "failed", message: fillMessage(t("settings.providers.startFailed"), { reason: refusalReason(error) }) };
}

/** A sign-out the node answered: removed, or nothing to remove. */
export function signOutSettled(result: { signedOut: boolean }, t: (key: MessageKey) => string): ProviderPressOutcome {
  return { status: "done", message: t(result.signedOut ? "commandCard.signOut.done" : "settings.providers.signOutNothing") };
}

/** A sign-out that did not happen: the credential is still there, with the node's reason and never its code. */
export function signOutRefused(error: unknown, t: (key: MessageKey) => string): ProviderPressOutcome {
  return { status: "failed", message: fillMessage(t("settings.providers.signOutFailed"), { reason: refusalReason(error) }) };
}

export type ProviderSignInPort = Pick<
  GatewayClient,
  "startProviderSignIn" | "providerSignIn" | "runningProviderSignIns" | "answerProviderSignIn" | "cancelProviderSignIn" | "notifyModelChange"
>;

type SignInsUpdate = (current: Record<string, ProviderSignInView>) => Record<string, ProviderSignInView>;

function open(view: ProviderSignInView | undefined): boolean {
  return view !== undefined && (view.state === "running" || view.state === "waiting");
}

/**
 * The sign-ins one surface follows, without React: what the hook below wraps, so the timing is testable on its own.
 *
 * Closed once the surface is gone: a read still in flight then lands nowhere and arms no new read, so leaving a
 * Settings tab mid-sign-in stops the polling instead of leaving it running until the provider gives up.
 */
export class ProviderSignInFollower {
  readonly #port: ProviderSignInPort;
  readonly #publish: (update: SignInsUpdate) => void;
  readonly #onError: (message: string) => void;
  readonly #pollMs: number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** What this surface shows under each key, mirrored so a reattach does not replace a sign-in already followed. */
  readonly #shown = new Map<string, ProviderSignInView>();
  #running: Promise<void> | undefined;
  #asking: ((view: ProviderSignInView) => string | undefined)[] = [];
  #closed = false;

  constructor(port: ProviderSignInPort, publish: (update: SignInsUpdate) => void, onError: (message: string) => void, pollMs = SIGN_IN_POLL_MS) {
    this.#port = port;
    this.#publish = publish;
    this.#onError = onError;
    this.#pollMs = pollMs;
  }

  /** Open again after `close` — React runs a surface's effects twice in development. */
  open(): void {
    this.#closed = false;
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #show(key: string, view: ProviderSignInView): void {
    this.#shown.set(key, view);
    this.#publish((current) => ({ ...current, [key]: view }));
  }

  follow(key: string, view: ProviderSignInView): void {
    if (this.#closed) return;
    this.#show(key, view);
    const previous = this.#timers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    this.#timers.delete(key);
    if (!open(view)) {
      // A provider that is now signed in changes what the model picker can offer.
      if (view.state === "done") this.#port.notifyModelChange();
      return;
    }
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        void this.#port.providerSignIn(view.signInId).then(
          (next) => this.follow(key, next),
          (error: unknown) => {
            if (this.#closed) return;
            this.#show(key, { ...view, state: "failed", prompt: undefined, error: refusalReason(error) });
          },
        );
      }, this.#pollMs),
    );
  }

  async start(key: string, providerId: string, method: "oauth" | "api_key"): Promise<void> {
    const view = await this.#port.startProviderSignIn(providerId, method);
    this.follow(key, view);
  }

  /**
   * One read of the node's running sign-ins serves every caller that asks while it is in flight — a conversation's
   * `/login` cards mount together — and each sign-in is shown in one place only: one this surface already shows stays
   * where it is, and otherwise the last place to ask (the newest card) takes it. A node that cannot list them leaves
   * the surface as it was: nothing to show again is not a failure.
   */
  reattach(keyOf: (view: ProviderSignInView) => string | undefined): Promise<void> {
    this.#asking.push(keyOf);
    this.#running ??= this.#port
      .runningProviderSignIns()
      .then(
        ({ signIns }) => signIns,
        () => [],
      )
      .then((views) => {
        const asking = this.#asking.reverse();
        this.#asking = [];
        this.#running = undefined;
        for (const view of views) {
          if ([...this.#shown.values()].some((shown) => shown.signInId === view.signInId && open(shown))) continue;
          for (const keyFor of asking) {
            const key = keyFor(view);
            if (key === undefined || open(this.#shown.get(key))) continue;
            this.follow(key, view);
            break;
          }
        }
      });
    return this.#running;
  }

  answer({ key, signInId, value }: { key: string; signInId: string; value: string }): void {
    void this.#port.answerProviderSignIn(signInId, value).then(
      (view) => this.follow(key, view),
      (error: unknown) => {
        if (!this.#closed) this.#onError(refusalReason(error));
      },
    );
  }

  cancel({ key, signInId }: { key: string; signInId: string }): void {
    void this.#port.cancelProviderSignIn(signInId).then(
      (view) => this.follow(key, view),
      (error: unknown) => {
        if (!this.#closed) this.#onError(refusalReason(error));
      },
    );
  }
}

/**
 * Signing in to and out of pi's providers, as `/login`, `/logout` and Settings → AI & Routing all do it.
 *
 * One path on purpose: the card in the conversation and the settings row start the same sign-in on the node
 * (`POST /providers/:id/sign-in`), follow it the same way, and hand an answer straight through without keeping it.
 * A sign-in is followed by reading it again while it runs: the provider decides when it moves on — a browser page
 * finishing, a code arriving — so the surface asks rather than guesses. A finished sign-in or sign-out changes what
 * the model picker can offer, so both tell the client's model listeners. Reading stops when the surface goes away, and
 * a surface opened again picks up the sign-ins the node still runs (`reattach`).
 */
export function useProviderSignIns(client: GatewayClient, onError: (message: string) => void): ProviderSignIns {
  const [signIns, setSignIns] = useState<Record<string, ProviderSignInView>>({});
  // The latest handler, so a change of wording does not start a new follower and drop what it follows.
  const errorHandler = useRef(onError);
  useEffect(() => {
    errorHandler.current = onError;
  }, [onError]);
  const follower = useMemo(
    () => new ProviderSignInFollower(client, setSignIns, (message) => errorHandler.current(message)),
    [client],
  );
  useEffect(() => {
    follower.open();
    return () => follower.close();
  }, [follower]);

  const follow = useCallback((key: string, view: ProviderSignInView) => follower.follow(key, view), [follower]);
  const start = useCallback(
    (key: string, providerId: string, method: "oauth" | "api_key") => follower.start(key, providerId, method),
    [follower],
  );
  const reattach = useCallback((keyOf: (view: ProviderSignInView) => string | undefined) => void follower.reattach(keyOf), [follower]);
  const answer = useCallback((input: { key: string; signInId: string; value: string }) => follower.answer(input), [follower]);
  const cancel = useCallback((input: { key: string; signInId: string }) => follower.cancel(input), [follower]);

  const signOut = useCallback(
    async (providerId: string) => {
      const result = await client.signOutProvider(providerId);
      client.notifyModelChange();
      return result;
    },
    [client],
  );

  return useMemo(
    () => ({ signIns, start, follow, reattach, answer, cancel, signOut }),
    [signIns, start, follow, reattach, answer, cancel, signOut],
  );
}

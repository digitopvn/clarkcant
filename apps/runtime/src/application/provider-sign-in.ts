import { randomBytes } from "node:crypto";

import type { ProviderSignInView } from "@clarkcant/contracts";
import type { PiAdapter, ProviderSignInEvent, ProviderSignInMethod, ProviderSignInPrompt } from "@clarkcant/pi-adapter";

/** The part of the adapter that signs in to providers: the turn's own, so a sign-in made here is the one turns use. */
export type ProviderAuthPort = Required<Pick<PiAdapter, "providerAuth" | "signIn" | "signOut">>;

/** The adapter's sign-in methods, when it has them; an adapter without accounts has nothing to offer. */
export function providerAuthPort(adapter: PiAdapter): ProviderAuthPort | undefined {
  const { providerAuth, signIn, signOut } = adapter;
  if (providerAuth === undefined || signIn === undefined || signOut === undefined) return undefined;
  return {
    providerAuth: () => providerAuth.call(adapter),
    signIn: (providerId, method, interaction) => signIn.call(adapter, providerId, method, interaction),
    signOut: (providerId) => signOut.call(adapter, providerId),
  };
}

/** How long a sign-in may wait for the person before it is given up. Provider pages expire long before this. */
const SIGN_IN_TTL_MS = 10 * 60_000;
const EVENTS_KEPT = 10;

interface SignIn {
  view: ProviderSignInView;
  controller: AbortController;
  answer?: ((value: string) => void) | undefined;
  /**
   * What the person typed during this sign-in, held only while it runs.
   *
   * A provider may repeat a key in the reason it refuses it, or in a progress line. These are what is taken out of
   * anything the provider says before the card can read it, and they are dropped when the sign-in settles.
   */
  typed: string[];
  expiresAtMs: number;
}

/** Shorter than this, a typed value is a menu choice or a short code, and blanking it would garble ordinary words. */
const REDACTED_FROM_LENGTH = 8;

/** The provider's words with everything the person typed during this sign-in taken out. */
function withoutTyped(signIn: SignIn, text: string): string {
  let out = text;
  for (const value of signIn.typed) out = out.replaceAll(value, "[redacted]");
  return out;
}

export type SignInAnswerOutcome = { ok: true; view: ProviderSignInView } | { ok: false; code: "SIGN_IN_NOT_FOUND" | "NOT_WAITING"; message: string };

/**
 * The sign-ins this node is running, in memory.
 *
 * A sign-in is a conversation between the provider and the person, carried by the card that started it: the provider
 * shows a page or asks for a code, the card shows that, and what the person types comes back here and goes straight to
 * the provider. The view never holds an answer, nor the provider's repetition of one: what was typed is remembered
 * only until the sign-in settles, to take it out of what the provider says back. A sign-in nobody finishes is given
 * up after ten minutes, so a forgotten card does not hold a provider's login open.
 *
 * In memory on purpose: a sign-in is a few minutes of a person at the screen, and a restart ends it the way closing
 * the provider's page would.
 */
export class ProviderSignIns {
  readonly #port: ProviderAuthPort;
  readonly #now: () => number;
  readonly #signIns = new Map<string, SignIn>();

  constructor(port: ProviderAuthPort, now: () => number = Date.now) {
    this.#port = port;
    this.#now = now;
  }

  /** Starts a sign-in, or returns the one already running for this provider, so a second press does not open two. */
  start(providerId: string, method: ProviderSignInMethod): ProviderSignInView {
    this.#sweep();
    for (const running of this.#signIns.values()) {
      if (running.view.providerId === providerId && (running.view.state === "running" || running.view.state === "waiting")) {
        return running.view;
      }
    }
    const signIn: SignIn = {
      view: { signInId: `signin-${randomBytes(8).toString("hex")}`, providerId, method, state: "running", events: [] },
      controller: new AbortController(),
      typed: [],
      expiresAtMs: this.#now() + SIGN_IN_TTL_MS,
    };
    this.#signIns.set(signIn.view.signInId, signIn);
    const { signal } = signIn.controller;
    void this.#port
      .signIn(providerId, method, {
        signal,
        prompt: (prompt) =>
          new Promise<string>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            signIn.answer = resolve;
            this.#update(signIn, { state: "waiting", prompt: promptView(signIn, prompt) });
          }),
        notify: (event) => {
          this.#update(signIn, { events: [...signIn.view.events, eventView(signIn, event)].slice(-EVENTS_KEPT) });
        },
      })
      .then(
        () => this.#settle(signIn, { state: "done" }),
        (cause: unknown) =>
          this.#settle(
            signIn,
            signal.aborted
              ? { state: "cancelled" }
              : { state: "failed", error: withoutTyped(signIn, cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) },
          ),
      );
    return signIn.view;
  }

  view(signInId: string): ProviderSignInView | undefined {
    this.#sweep();
    return this.#signIns.get(signInId)?.view;
  }

  /** Hands the person's answer to the provider. The value goes straight through and is never part of a view. */
  answer(signInId: string, value: string): SignInAnswerOutcome {
    const signIn = this.#signIns.get(signInId);
    if (signIn === undefined) return { ok: false, code: "SIGN_IN_NOT_FOUND", message: "This sign-in has ended; start it again from /login." };
    const answer = signIn.answer;
    if (signIn.view.state !== "waiting" || answer === undefined) {
      return { ok: false, code: "NOT_WAITING", message: "This sign-in is not asking for anything right now." };
    }
    signIn.answer = undefined;
    if (value.length >= REDACTED_FROM_LENGTH && !signIn.typed.includes(value)) signIn.typed.push(value);
    this.#update(signIn, { state: "running" }, true);
    answer(value);
    return { ok: true, view: signIn.view };
  }

  cancel(signInId: string): ProviderSignInView | undefined {
    const signIn = this.#signIns.get(signInId);
    if (signIn === undefined) return undefined;
    if (signIn.view.state === "running" || signIn.view.state === "waiting") {
      signIn.controller.abort(new Error("cancelled"));
      this.#settle(signIn, { state: "cancelled" });
    }
    return signIn.view;
  }

  #update(signIn: SignIn, patch: Partial<ProviderSignInView>, clearPrompt = false): void {
    const next = { ...signIn.view, ...patch };
    if (clearPrompt) delete next.prompt;
    signIn.view = next;
  }

  #settle(signIn: SignIn, patch: Pick<ProviderSignInView, "state"> & { error?: string }): void {
    // A cancel already settled it; the provider's own rejection that follows says nothing new.
    if (signIn.view.state === "done" || signIn.view.state === "failed" || signIn.view.state === "cancelled") return;
    signIn.answer = undefined;
    this.#update(signIn, patch, true);
    signIn.typed = [];
  }

  /** Gives up sign-ins past their time, and forgets settled ones once their card has had time to read the outcome. */
  #sweep(): void {
    const nowMs = this.#now();
    for (const [signInId, signIn] of this.#signIns) {
      if (nowMs < signIn.expiresAtMs) continue;
      if (signIn.view.state === "running" || signIn.view.state === "waiting") {
        signIn.controller.abort(new Error("expired"));
        this.#settle(signIn, { state: "failed", error: "The sign-in waited ten minutes without an answer and was given up." });
        signIn.expiresAtMs = nowMs + 60_000;
      } else {
        this.#signIns.delete(signInId);
      }
    }
  }
}

function promptView(signIn: SignIn, prompt: ProviderSignInPrompt): ProviderSignInView["prompt"] {
  const message = withoutTyped(signIn, prompt.message).slice(0, 2000);
  if (prompt.type === "select") {
    return { type: "select", message, options: prompt.options.slice(0, 30).map((option) => ({ ...option })) };
  }
  return {
    type: prompt.type,
    message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder.slice(0, 200) }),
  };
}

function eventView(signIn: SignIn, event: ProviderSignInEvent): ProviderSignInView["events"][number] {
  if (event.type === "auth_url") {
    return {
      type: "auth_url",
      url: event.url,
      ...(event.instructions === undefined ? {} : { instructions: withoutTyped(signIn, event.instructions).slice(0, 2000) }),
    };
  }
  if (event.type === "device_code") return { type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri };
  return { type: event.type, message: withoutTyped(signIn, event.message).slice(0, 2000) };
}

const registries = new WeakMap<ProviderAuthPort, ProviderSignIns>();

/** The node's one registry for this port, so every route and card sees the same sign-ins. */
export function providerSignInsFor(port: ProviderAuthPort): ProviderSignIns {
  let registry = registries.get(port);
  if (registry === undefined) {
    registry = new ProviderSignIns(port);
    registries.set(port, registry);
  }
  return registry;
}

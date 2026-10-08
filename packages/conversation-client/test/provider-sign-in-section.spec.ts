import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderAuthEntryView, ProviderSignInView } from "@clarkcant/contracts";

import { GatewayError } from "../src/api.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  ProviderSignInList,
  type ProviderSignInListProps,
  providerListingRefused,
  providerSignOutAvailable,
  providerSourceNote,
} from "../src/settings/controls/provider-sign-in-section.tsx";

/**
 * Settings → AI & Routing → Provider sign-in, drawn from what the node said.
 *
 * The repo has no DOM test environment, so pressing and typing are asserted in the browser journey
 * (`apps/web/e2e/provider-sign-in-settings.spec.ts`). What is asserted here is what each state draws: only the ways in
 * pi advertises, where a credential comes from, no sign-out for one pi did not store, and never a typed value.
 */

/** As the static markup writes text: an apostrophe is escaped. */
const en = (key: MessageKey): string => MESSAGES_EN[key].replaceAll("'", "&#x27;");
const vi = (key: MessageKey): string => MESSAGES_VI[key];
const english = (key: MessageKey): string => MESSAGES_EN[key];

const API_KEY_ONLY: ProviderAuthEntryView = { providerId: "keyonly", name: "Key Only", apiKey: true, configured: false };
const OAUTH: ProviderAuthEntryView = {
  providerId: "acct",
  name: "Account Co",
  oauth: { label: "Account Co subscription", subscription: true },
  apiKey: true,
  configured: false,
};
const FROM_ENV: ProviderAuthEntryView = { providerId: "envy", name: "Envy", apiKey: true, configured: true, source: "environment" };
const STORED: ProviderAuthEntryView = { ...OAUTH, providerId: "stored", name: "Stored Co", configured: true, source: "stored" };

const noop = (): void => undefined;
function draw(props: Partial<ProviderSignInListProps>, t = english): string {
  return renderToStaticMarkup(
    createElement(ProviderSignInList, {
      t,
      listing: { status: "ready", providers: [API_KEY_ONLY, OAUTH, FROM_ENV, STORED] },
      signIns: {},
      outcomes: {},
      onRetry: noop,
      onStart: noop,
      onSignOut: noop,
      onAnswer: noop,
      onCancel: noop,
      ...props,
    }),
  );
}

function row(html: string, providerId: string): string {
  const start = html.indexOf(`data-provider-id="${providerId}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

describe("the provider sign-in section", () => {
  it("offers only the ways in pi advertises: no account sign-in for an API-key-only provider", () => {
    const html = draw({});
    const keyOnly = row(html, "keyonly");
    expect(keyOnly).toContain('data-provider-method="api_key"');
    expect(keyOnly).not.toContain('data-provider-method="oauth"');
    const account = row(html, "acct");
    expect(account).toContain('data-provider-method="oauth"');
    expect(account).toContain("Sign in with account");
    expect(account).toContain('data-provider-method="api_key"');
  });

  it("says where each credential comes from, and offers sign-out only for one pi stored", () => {
    const html = draw({});
    const env = row(html, "envy");
    expect(env).toContain(en("settings.providers.badge.signedIn"));
    expect(env).toContain("environment (.env or the shell)");
    expect(env).not.toContain("data-provider-sign-out");
    const stored = row(html, "stored");
    expect(stored).toContain(en("settings.providers.source.stored"));
    expect(stored).toContain("data-provider-sign-out");
    expect(stored).toContain("Replace API key");
    expect(stored).toContain("Sign in again");
    expect(row(html, "keyonly")).toContain(en("settings.providers.badge.signedOut"));
  });

  it("is worded in Vietnamese with full diacritics", () => {
    const html = draw({}, vi);
    expect(html).toContain("Đăng nhập nhà cung cấp");
    expect(row(html, "envy")).toContain("biến môi trường của node");
    expect(row(html, "stored")).toContain("Đăng xuất");
  });

  it("draws loading, an unavailable node, and a failed read with a way to try again", () => {
    expect(draw({ listing: { status: "loading" } })).toContain(en("settings.common.loading"));
    expect(draw({ listing: { status: "unavailable" } })).toContain(en("settings.providers.unavailable"));
    const failed = draw({ listing: { status: "failed", reason: "pi exited" } });
    expect(failed).toContain(en("settings.providers.readFailed"));
    expect(failed).toContain("pi exited");
    expect(failed).toContain(en("settings.providers.retry"));
  });

  it("reads a node without pi as unavailable, and any other refusal as a failure with the node's reason", () => {
    expect(providerListingRefused(new GatewayError(503, "PROVIDER_AUTH_UNAVAILABLE", "no pi"))).toEqual({ status: "unavailable" });
    expect(providerListingRefused(new GatewayError(502, "PROVIDER_AUTH_FAILED", "pi could not list"))).toEqual({
      status: "failed",
      reason: "pi could not list",
    });
  });

  it("follows a running sign-in in the row: a password field for a key, buttons held while it runs", () => {
    const signIn: ProviderSignInView = {
      signInId: "signin-1",
      providerId: "keyonly",
      method: "api_key",
      state: "waiting",
      events: [],
      prompt: { type: "secret", message: "API key" },
    };
    const keyOnly = row(draw({ signIns: { keyonly: signIn } }), "keyonly");
    expect(keyOnly).toContain('type="password"');
    expect(keyOnly).toMatch(/data-provider-method="api_key"[^>]*disabled=""|disabled=""[^>]*data-provider-method="api_key"/u);
  });

  it("shows how a sign-in ended, and a row's failure in the node's words", () => {
    const done: ProviderSignInView = { signInId: "signin-2", providerId: "acct", method: "oauth", state: "done", events: [] };
    const html = draw({
      signIns: { acct: done },
      outcomes: { stored: { status: "failed", message: "Sign-out didn't complete; the credential is still there. pi said no" } },
    });
    expect(row(html, "acct")).toContain(en("commandCard.signIn.done").replace("{provider}", "Account Co"));
    expect(row(html, "stored")).toContain("pi said no");
  });

  it("decides sign-out and the source note from the node's view alone", () => {
    expect(providerSignOutAvailable(STORED)).toBe(true);
    expect(providerSignOutAvailable(FROM_ENV)).toBe(false);
    expect(providerSignOutAvailable({ ...STORED, configured: false })).toBe(false);
    expect(providerSourceNote(OAUTH, english)).toBe("Account Co subscription");
    expect(providerSourceNote({ ...FROM_ENV, source: undefined }, english)).toBe(MESSAGES_EN["settings.providers.source.unknown"]);
  });
});

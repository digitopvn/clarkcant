import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCardBlock } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { ControlSettings } from "../src/settings/ControlSettings.tsx";
import type { PreferencesHandle } from "../src/settings/controls/use-preferences.ts";
import type { GatewayClient } from "../src/api.ts";

/**
 * Who asked, as the person reads it: on an approval card a program's turn caused, on each activity row, and the one
 * control that decides whether such a turn is treated like the person's own. Both languages, because the wording is
 * the feature.
 */

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

function card(origin?: string, decision = "pending"): ReactElement {
  return createElement(ApprovalCardBlock, {
    block: {
      type: "approval-card",
      owner: "host",
      approvalId: "appr_1",
      operationDescription: "Run git push",
      operationDigest: "sha256:abc",
      effectCategory: "external-write",
      decision,
      ...(origin === undefined ? {} : { origin }),
    },
  });
}

describe("an approval card says who asked", () => {
  it("names an AI client over MCP, in English and Vietnamese", () => {
    const en = inLocale("en", card("mcp"));
    expect(en).toContain('data-approval-origin="mcp"');
    expect(en).toContain("Asked by an AI client over MCP");
    expect(inLocale("vi", card("mcp"))).toContain("Do một ứng dụng AI yêu cầu qua MCP");
    expect(inLocale("en", card("cli-api"))).toContain("Asked by a program over the CLI or API");
    expect(inLocale("vi", card("relay"))).toContain("Do một ứng dụng kết nối yêu cầu qua relay");
  });

  it("says nothing for the person's own turn, an unrecorded one, or a value it does not know", () => {
    for (const origin of ["person", undefined, "admin"]) {
      expect(inLocale("en", card(origin))).not.toContain("data-approval-origin");
    }
  });
});

describe("an approval card says what kind of effect it is", () => {
  it("in the words the Control tab uses, not the wire's", () => {
    const en = inLocale("en", card());
    expect(en).toContain('data-effect="external-write"');
    expect(en).toContain(CATALOGS.en["settings.control.category.externalWrite"]);
    expect(en).not.toContain(">external-write<");
    expect(en).not.toContain("operation sha256");
    expect(inLocale("vi", card())).toContain(CATALOGS.vi["settings.control.category.externalWrite"]);
  });
});

describe("an approval card read back from history says what was decided", () => {
  it("in words, and stops asking once it is decided", () => {
    const granted = inLocale("vi", card(undefined, "granted"));
    expect(granted).toContain(CATALOGS.vi["blocks.approval.granted"]);
    expect(granted).not.toContain(">granted<");
    expect(granted).not.toContain(CATALOGS.vi["blocks.approval.onlyYouCanConfirm"]);
    expect(granted).not.toContain(CATALOGS.vi["blocks.approval.needsConfirm"]);
    expect(granted).toContain(CATALOGS.vi["blocks.approval.request"]);
    expect(inLocale("vi", card())).toContain(CATALOGS.vi["blocks.approval.needsConfirm"]);
    expect(inLocale("en", card(undefined, "expired"))).toContain(CATALOGS.en["blocks.approval.expired"]);
    expect(inLocale("en", card(undefined, "denied"))).toContain(CATALOGS.en["blocks.approval.denied"]);
  });
});

describe("the Control tab", () => {
  const prefs = (value?: unknown): PreferencesHandle =>
    ({
      preferences: [],
      problem: undefined,
      pending: undefined,
      status: undefined,
      preference: (key: string) => (key === "execution.machineTurns" && value !== undefined ? { key, value } : undefined),
      text: (_key: string, fallback: string) => fallback,
      flag: (_key: string, fallback: boolean) => fallback,
      record: () => undefined,
      write: () => undefined,
      undo: () => undefined,
    }) as unknown as PreferencesHandle;

  function control(locale: "vi" | "en", value?: unknown): string {
    return inLocale(
      locale,
      createElement(ControlSettings, {
        prefs: prefs(value),
        client: {} as GatewayClient,
        recentEffects: [
          { at: "2026-10-04T03:00:00.000Z", description: "git status", mode: "autonomous", category: "read", origin: "mcp" },
          { at: "2026-10-04T03:01:00.000Z", description: "ls", mode: "autonomous", category: "read" },
        ],
        recentProblem: undefined,
      }),
    );
  }

  it("names who asked on each activity row that recorded it", () => {
    const en = control("en");
    expect(en).toContain('data-effect-origin="mcp"');
    expect(en).toContain("Asked by an AI client over MCP");
    expect(en.match(/data-effect-origin=/g)).toHaveLength(1);
    expect(control("vi")).toContain("Do một ứng dụng AI yêu cầu qua MCP");
  });

  it("offers the stricter choice for a program's turns, with the person's own policy as the default", () => {
    const en = control("en");
    expect(en).toContain('data-machine-turns="true"');
    expect(en).toContain("Requests from other programs");
    expect(en).toContain("Same as me");
    expect(en).toContain("Ask me first");
    expect(control("vi")).toContain("Yêu cầu từ chương trình khác");
    // Nothing stored is the default, the person's own policy; a stored `ask` is shown as chosen.
    expect(en).toMatch(/aria-pressed="true"[^>]*data-segment="as-person"/);
    expect(en).toContain("Follow the same policy as your own messages.");
    const strict = control("en", "ask");
    expect(strict).toMatch(/aria-pressed="true"[^>]*data-segment="ask"/);
    expect(strict).toContain("Ask before writing outside this machine");
  });
});

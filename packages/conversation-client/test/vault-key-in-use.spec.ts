import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NodeReadinessAnswer } from "../src/api.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import {
  type CredentialEntry,
  type CredentialListing,
  type CredentialRowOutcome,
  CredentialRowView,
  CredentialsCard,
  canRemoveCredential,
  credentialBadge,
  credentialSourceLine,
  readSequence,
} from "../src/settings/controls/credentials-manager-section.tsx";

/**
 * Settings → AI & Routing → Credentials, drawn from what the node said.
 *
 * The repo has no DOM test environment, so typing, saving and removing are asserted in the browser journey
 * (`apps/web/e2e/credentials.spec.ts`). What is asserted here is what each state draws: whether a key is connected,
 * which key is in use without either value, a failed read that is never shown as "not connected", and a press that is
 * said once per attempt.
 */

const english = (key: MessageKey): string => MESSAGES_EN[key];
const vietnamese = (key: MessageKey): string => MESSAGES_VI[key];

const TYPESAFE: CredentialEntry = {
  name: "typesafe",
  labelKey: "settings.credentials.typesafe.label",
  purposeKey: "settings.credentials.typesafe.purpose",
};

function ready(answer: NodeReadinessAnswer): CredentialListing {
  return { status: "ready", answer };
}

const FROM_VAULT = ready({ model: true, credentials: ["typesafe"], sources: { typesafe: "vault", gemini: "none" } });
const FROM_ENVIRONMENT = ready({ model: true, credentials: ["typesafe"], sources: { typesafe: "environment" } });
const NONE = ready({ model: true, credentials: [], sources: { typesafe: "none" } });
const OLDER_NODE = ready({ model: true, credentials: ["typesafe"] });

const noop = (): void => undefined;

function drawRow(
  listing: CredentialListing,
  options: { t?: (key: MessageKey) => string; outcome?: CredentialRowOutcome; busy?: boolean } = {},
): string {
  return renderToStaticMarkup(
    createElement(CredentialRowView, {
      t: options.t ?? english,
      entry: TYPESAFE,
      listing,
      draft: "",
      busy: options.busy ?? false,
      outcome: options.outcome,
      onDraft: noop,
      onReplace: noop,
      onRemove: noop,
    }),
  );
}

describe("which key is in use", () => {
  it("says the key saved here is in use when the node reports the vault", () => {
    expect(credentialSourceLine(FROM_VAULT, "typesafe")).toBe("settings.credentials.source.vault");
    const html = drawRow(FROM_VAULT);
    expect(html).toContain('data-credential-source="vault"');
    expect(html).toContain(MESSAGES_EN["settings.credentials.source.vault"]);
  });

  it("says a key from the environment is in use, and that a key saved here would replace it", () => {
    expect(credentialSourceLine(FROM_ENVIRONMENT, "typesafe")).toBe("settings.credentials.source.environment");
    const html = drawRow(FROM_ENVIRONMENT, { t: vietnamese });
    expect(html).toContain('data-credential-source="environment"');
    expect(html).toContain("Đang dùng: khoá từ biến môi trường của node. Khoá lưu ở đây sẽ được dùng thay cho khoá đó.");
  });

  it("says nothing about a source when no key is in use, or when an older node did not report one", () => {
    expect(credentialSourceLine(NONE, "typesafe")).toBeUndefined();
    expect(credentialSourceLine(OLDER_NODE, "typesafe")).toBeUndefined();
    expect(drawRow(NONE)).not.toContain("data-credential-source=");
    expect(drawRow(OLDER_NODE)).not.toContain("data-credential-source=");
  });

  it("keeps the field write-only in every state: a masked draft, never a stored value", () => {
    for (const listing of [FROM_VAULT, FROM_ENVIRONMENT, NONE, OLDER_NODE]) {
      expect(drawRow(listing)).toContain('type="password"');
    }
  });
});

describe("Remove", () => {
  it("is available only when a key is saved here, or when the node did not say", () => {
    expect(canRemoveCredential(FROM_VAULT, "typesafe")).toBe(true);
    expect(canRemoveCredential(OLDER_NODE, "typesafe")).toBe(true);
    // The vault's key wins over the environment's, so an environment key in use means nothing is saved here.
    expect(canRemoveCredential(FROM_ENVIRONMENT, "typesafe")).toBe(false);
    expect(canRemoveCredential(NONE, "typesafe")).toBe(false);
    expect(drawRow(FROM_ENVIRONMENT)).toMatch(/<button type="button" class="cc-chip" disabled=""[^>]*data-credential-remove="typesafe"/);
    expect(drawRow(FROM_VAULT)).not.toMatch(/disabled=""[^>]*data-credential-remove="typesafe"/);
  });

  it("is held while a press is still being answered", () => {
    expect(drawRow(FROM_VAULT, { busy: true })).toMatch(/disabled=""[^>]*data-credential-remove="typesafe"/);
  });
});

describe("connection state", () => {
  it("reads connected and not connected from the node's own list of names", () => {
    expect(credentialBadge(FROM_VAULT, "typesafe")).toEqual({ phase: "success", key: "settings.credentials.status.connected" });
    expect(credentialBadge(NONE, "typesafe")).toEqual({ phase: "needs-action", key: "settings.credentials.status.notConnected" });
    expect(drawRow(FROM_VAULT)).toContain('data-tone="ok"');
    expect(drawRow(NONE)).toContain('data-tone="warn"');
  });

  it("never reads a failed read as not connected: the node may hold the key", () => {
    const failed: CredentialListing = { status: "error" };
    expect(credentialBadge(failed, "typesafe")).toEqual({ phase: "unavailable", key: "settings.credentials.status.unknown" });
    const html = drawRow(failed);
    expect(html).toContain(MESSAGES_EN["settings.credentials.status.unknown"]);
    expect(html).not.toContain(MESSAGES_EN["settings.credentials.status.notConnected"]);
  });

  it("says it is still reading while the first answer is on its way", () => {
    expect(credentialBadge({ status: "loading" }, "typesafe").phase).toBe("loading");
  });
});

describe("a failed read", () => {
  function drawCard(listing: CredentialListing, t = english): string {
    return renderToStaticMarkup(
      createElement(CredentialsCard, {
        t,
        listing,
        entries: [TYPESAFE],
        onCheckAgain: noop,
        renderRow: (entry) => createElement("div", { key: entry.name, "data-row": entry.name }),
      }),
    );
  }

  it("says what failed and offers Check again, in the person's language", () => {
    const html = drawCard({ status: "error" }, vietnamese);
    expect(html).toContain("Không đọc được trạng thái thông tin xác thực. Không có gì bị thay đổi; hãy kiểm tra lại.");
    expect(html).toContain('data-credentials-check-again="true"');
    expect(html).toContain("Kiểm tra lại");
  });

  it("offers nothing to repeat once the node has answered", () => {
    expect(drawCard(FROM_VAULT)).not.toContain("data-credentials-check-again");
    expect(drawCard({ status: "loading" })).not.toContain("data-credentials-check-again");
  });
});

describe("overlapping reads", () => {
  it("applies only the newest read's answer, so a late answer never brings back an earlier state", () => {
    const reads = readSequence();
    const beforeTheSave = reads.begin();
    const afterTheSave = reads.begin();
    // The read started before the save answers last: it is no longer the newest, so it is dropped.
    expect(afterTheSave()).toBe(true);
    expect(beforeTheSave()).toBe(false);
    // A later read supersedes it in turn.
    const checkAgain = reads.begin();
    expect(afterTheSave()).toBe(false);
    expect(checkAgain()).toBe(true);
  });
});

describe("focus", () => {
  it("gives the section and each row a place for focus to land when the pressed control goes away", () => {
    const card = renderToStaticMarkup(
      createElement(CredentialsCard, {
        t: english,
        listing: { status: "error" },
        entries: [],
        onCheckAgain: noop,
        renderRow: () => createElement("div"),
      }),
    );
    expect(card).toMatch(/<section[^>]*data-credentials-section="true"[^>]*tabindex="-1"/);
    expect(drawRow(FROM_VAULT)).toMatch(/<form[^>]*data-credential-row="typesafe"[^>]*tabindex="-1"/);
  });
});

describe("a press on a row", () => {
  it("says what became of the press with its attempt, and a failure says what was kept", () => {
    const failed = drawRow(FROM_VAULT, {
      outcome: { phase: "error", messageKey: "settings.credentials.status.saveFailed", attempt: 2 },
    });
    expect(failed).toContain('data-credential-attempt="2"');
    expect(failed).toContain(MESSAGES_EN["settings.credentials.status.saveFailed"]);
  });

  it("says a removal removed the key saved here, not that the node holds no key", () => {
    // An environment key may still be in use after the saved one is gone; the source line says which.
    expect(MESSAGES_EN["settings.credentials.status.removed"]).toBe("Removed the key saved here.");
    expect(MESSAGES_VI["settings.credentials.status.removed"]).toBe("Đã gỡ khoá đã lưu ở đây.");
  });
});

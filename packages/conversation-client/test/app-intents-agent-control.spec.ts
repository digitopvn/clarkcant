import { describe, expect, it } from "vitest";

import { type AppIntent, type AppIntentDecision } from "@clarkcant/contracts";

import { runAppIntent, type AppIntentHost } from "../src/app-intents.ts";

/**
 * The four host members issue #129 adds: `openVoice`, `showConversation`, `cycleModel` and
 * `selectModel`. Same claim as the rest of `app-intents.spec.ts` — one executor runs a decision
 * whichever source it arrived from — extended to the new kinds a `control_app` tool call and a click
 * both resolve to.
 */

function decisionFor(intent: AppIntent, readBack = "said"): AppIntentDecision {
  return { kind: "intent", intent, requiresConfirmation: false, readBack };
}

function baseHost(overrides: Partial<AppIntentHost> = {}): AppIntentHost {
  return {
    openSettings: () => {},
    goHome: () => {},
    openFilePicker: () => {},
    endVoice: () => {},
    ...overrides,
  };
}

describe("the new app-control kinds, through the one executor", () => {
  it("runs voice.open through host.openVoice when the host provides it", () => {
    let opened = 0;
    const host = baseHost({ openVoice: () => (opened += 1) });
    const run = runAppIntent(decisionFor({ kind: "voice.open" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(opened).toBe(1);
  });

  it("refuses voice.open honestly when the host has no voice surface", () => {
    const run = runAppIntent(decisionFor({ kind: "voice.open" }), baseHost());
    expect(run.ran).toBe(false);
  });

  it("runs nav.conversation through host.showConversation", () => {
    let shown = 0;
    const host = baseHost({ showConversation: () => (shown += 1) });
    const run = runAppIntent(decisionFor({ kind: "nav.conversation" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(shown).toBe(1);
  });

  it("runs inbox.open through host.openInbox, and refuses it honestly on a host with no inbox", () => {
    let opened = 0;
    const run = runAppIntent(decisionFor({ kind: "inbox.open" }), baseHost({ openInbox: () => (opened += 1) }));
    expect(run).toEqual({ ran: true, say: "said" });
    expect(opened).toBe(1);

    const refused = runAppIntent(decisionFor({ kind: "inbox.open" }), baseHost());
    expect(refused.ran).toBe(false);
    expect(refused.say).not.toBe("said");
  });

  it("runs model.cycle through host.cycleModel", () => {
    let cycled = 0;
    const host = baseHost({ cycleModel: () => (cycled += 1) });
    const run = runAppIntent(decisionFor({ kind: "model.cycle" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(cycled).toBe(1);
  });

  it("runs model.select through host.selectModel, carrying the alias", () => {
    const aliases: string[] = [];
    const host = baseHost({ selectModel: (alias) => aliases.push(alias) });
    const run = runAppIntent(decisionFor({ kind: "model.select", modelAlias: "fast" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(aliases).toEqual(["fast"]);
  });

  it("refuses model.select honestly when the host has no model pool", () => {
    const run = runAppIntent(decisionFor({ kind: "model.select", modelAlias: "fast" }), baseHost());
    expect(run.ran).toBe(false);
  });

  it("never runs anything for a decision that is not kind: intent", () => {
    let cycled = 0;
    const host = baseHost({ cycleModel: () => (cycled += 1) });
    const refused: AppIntentDecision = { kind: "refused", say: "no" };
    expect(runAppIntent(refused, host)).toEqual({ ran: false, say: "no" });
    expect(cycled).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { type AppIntent, type AppIntentDecision } from "@clarkcant/contracts";

import { runAppIntent, type AppIntentHost } from "../src/app-intents.ts";

/**
 * The four host members issue #129 adds: `openVoice`, `showConversation`, `cycleModel` and
 * `selectModel`. Same claim as the rest of `app-intents.spec.ts` — one executor runs a decision
 * whichever source it arrived from — extended to the new kinds a `control_app` tool call and a click
 * both resolve to, and to what "ran" has to mean once the agent is told it.
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
  it("runs voice.open through host.openVoice when the host provides it", async () => {
    let opened = 0;
    const host = baseHost({
      openVoice: () => {
        opened += 1;
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "voice.open" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(opened).toBe(1);
  });

  it("refuses voice.open honestly when the host has no voice surface", async () => {
    const run = await runAppIntent(decisionFor({ kind: "voice.open" }), baseHost());
    expect(run.ran).toBe(false);
  });

  it("runs nav.conversation through host.showConversation", async () => {
    let shown = 0;
    const host = baseHost({
      showConversation: () => {
        shown += 1;
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "nav.conversation" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(shown).toBe(1);
  });

  it("runs inbox.open through host.openInbox, and refuses it honestly on a host with no inbox", async () => {
    let opened = 0;
    const run = await runAppIntent(
      decisionFor({ kind: "inbox.open" }),
      baseHost({
        openInbox: () => {
          opened += 1;
        },
      }),
    );
    expect(run).toEqual({ ran: true, say: "said" });
    expect(opened).toBe(1);

    const refused = await runAppIntent(decisionFor({ kind: "inbox.open" }), baseHost());
    expect(refused.ran).toBe(false);
    expect(refused.say).not.toBe("said");
  });

  it("runs model.cycle through host.cycleModel", async () => {
    let cycled = 0;
    const host = baseHost({
      cycleModel: () => {
        cycled += 1;
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "model.cycle" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(cycled).toBe(1);
  });

  it("runs model.select through host.selectModel, carrying the alias", async () => {
    const aliases: string[] = [];
    const host = baseHost({
      selectModel: (alias) => {
        aliases.push(alias);
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "model.select", modelAlias: "fast" }), host);
    expect(run).toEqual({ ran: true, say: "said" });
    expect(aliases).toEqual(["fast"]);
  });

  it("refuses model.select honestly when the host has no model pool", async () => {
    const run = await runAppIntent(decisionFor({ kind: "model.select", modelAlias: "fast" }), baseHost());
    expect(run.ran).toBe(false);
  });

  it("runs orb.select through host.selectOrbProfile, carrying the style, and reports what the host says", async () => {
    const chosen: string[] = [];
    const host = baseHost({
      selectOrbProfile: async (profile) => {
        chosen.push(profile);
        return `Orb: ${profile}`;
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "orb.select", orbProfile: "pearl" }), host);
    expect(run).toEqual({ ran: true, say: "Orb: pearl" });
    expect(chosen).toEqual(["pearl"]);
  });

  it("refuses orb.select honestly when the host has nowhere to save the style", async () => {
    const run = await runAppIntent(decisionFor({ kind: "orb.select", orbProfile: "pearl" }), baseHost());
    expect(run.ran).toBe(false);
    expect(run.say).not.toBe("said");
  });

  it("refuses an orb.select that names no style instead of picking one", async () => {
    let called = 0;
    const host = baseHost({
      selectOrbProfile: () => {
        called += 1;
      },
    });
    const run = await runAppIntent(decisionFor({ kind: "orb.select" }), host);
    expect(run.ran).toBe(false);
    expect(called).toBe(0);
  });

  it("reports a style the node refused to store as not run, with the node's reason", async () => {
    const host = baseHost({
      selectOrbProfile: async () => {
        throw new Error("orb.profile: Invalid option");
      },
    });
    expect(await runAppIntent(decisionFor({ kind: "orb.select", orbProfile: "plasma" }), host)).toEqual({
      ran: false,
      say: "orb.profile: Invalid option",
    });
  });

  it("never runs anything for a decision that is not kind: intent", async () => {
    let cycled = 0;
    const host = baseHost({
      cycleModel: () => {
        cycled += 1;
      },
    });
    const refused: AppIntentDecision = { kind: "refused", say: "no" };
    expect(await runAppIntent(refused, host)).toEqual({ ran: false, say: "no" });
    expect(cycled).toBe(0);
  });
});

describe("ran means done", () => {
  it("does not resolve until an asynchronous host method has finished", async () => {
    let finish: (() => void) | undefined;
    let settled = false;
    const host = baseHost({
      cycleModel: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const running = runAppIntent(decisionFor({ kind: "model.cycle" }), host).then((run) => {
      settled = true;
      return run;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish?.();
    expect(await running).toEqual({ ran: true, say: "said" });
  });

  it("says what the host says happened when it knows better than the read-back", async () => {
    const host = baseHost({ selectModel: async (alias) => `Lượt sau dùng ${alias}.` });
    const run = await runAppIntent(decisionFor({ kind: "model.select", modelAlias: "fast" }), host);
    expect(run).toEqual({ ran: true, say: "Lượt sau dùng fast." });
  });

  it("reports a host method that failed as not run, with its reason", async () => {
    const host = baseHost({
      cycleModel: async () => {
        throw new Error("Pool chỉ có một profile đang bật.");
      },
      openVoice: () => {
        throw new Error("Không tạo được cuộc trò chuyện.");
      },
    });
    expect(await runAppIntent(decisionFor({ kind: "model.cycle" }), host)).toEqual({
      ran: false,
      say: "Pool chỉ có một profile đang bật.",
    });
    expect(await runAppIntent(decisionFor({ kind: "voice.open" }), host)).toEqual({
      ran: false,
      say: "Không tạo được cuộc trò chuyện.",
    });
  });
});

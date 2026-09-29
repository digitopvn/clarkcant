import { describe, expect, it } from "vitest";

import type { OrbProfileName } from "@clarkcant/contracts";

import { MESSAGES_EN } from "../src/i18n/messages.ts";
import type { MessageKey } from "../src/i18n/messages.ts";
import { resolveOrbProfile, type ResolvedOrbProfile } from "../src/orb-profile.ts";
import { selectOrbProfileShown, type OrbSelection } from "../src/use-orb-profile.ts";

/**
 * What the agent is told after it asks for an orb style.
 *
 * The sentence reaches the person as Clark's reply, so it may say the orb changed only when the orb on screen
 * reports the new style. Every path that ends with the old orb still drawn has to come back as a failure that
 * says the style was saved but not shown, not as "done".
 */

const t = (key: MessageKey): string => MESSAGES_EN[key];
const drawn = (name: OrbProfileName): ResolvedOrbProfile => resolveOrbProfile({ profile: name });

function selection(overrides: Partial<OrbSelection> = {}): OrbSelection & { writes: OrbProfileName[] } {
  const writes: OrbProfileName[] = [];
  return {
    writes,
    write: async (profile) => {
      writes.push(profile);
    },
    refresh: async () => drawn("plasma"),
    t,
    ...overrides,
  };
}

describe("selectOrbProfileShown", () => {
  it("says the orb changed once the refreshed orb shows the chosen style", async () => {
    const chosen = selection();
    await expect(selectOrbProfileShown("plasma", chosen)).resolves.toBe("The orb is now in the Plasma style.");
    expect(chosen.writes).toEqual(["plasma"]);
  });

  it("does not ask for the refresh before the write has been stored", async () => {
    const order: string[] = [];
    await selectOrbProfileShown(
      "plasma",
      selection({
        write: async () => {
          await Promise.resolve();
          order.push("write");
        },
        refresh: async () => {
          order.push("refresh");
          return drawn("plasma");
        },
      }),
    );
    expect(order).toEqual(["write", "refresh"]);
  });

  it("fails with the node's reason when the write is refused, and never refreshes", async () => {
    let refreshed = 0;
    const refused = selection({
      write: async () => {
        throw new Error("orb.profile: Invalid option");
      },
      refresh: async () => {
        refreshed += 1;
        return drawn("plasma");
      },
    });
    await expect(selectOrbProfileShown("plasma", refused)).rejects.toThrow("orb.profile: Invalid option");
    expect(refreshed).toBe(0);
  });

  it("fails, saying the style is saved but not shown, when the orb could not re-read it", async () => {
    const unread = selection({
      refresh: async () => {
        throw new Error("node unreachable");
      },
    });
    const failure = selectOrbProfileShown("plasma", unread);
    await expect(failure).rejects.toThrow(/Plasma/u);
    await expect(failure).rejects.toThrow(/node unreachable/u);
    expect(unread.writes).toEqual(["plasma"]);
  });

  it("fails, naming both styles, when the orb on screen shows a different one", async () => {
    const other = selection({ refresh: async () => drawn("clark") });
    await expect(selectOrbProfileShown("plasma", other)).rejects.toThrow(
      "The Plasma style is saved, but the orb on screen shows the Clark style, so I cannot confirm it changed.",
    );
  });
});

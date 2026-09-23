import { describe, expect, it } from "vitest";

import type { InstalledPackageView } from "../src/api.ts";
import { builtInLabel, provenanceKind, provenanceRows, shortDigest } from "../src/package-provenance.ts";
import { MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";

/**
 * The provenance list has to be honest about what a package is, because the one mistake AGENTS.md
 * names is showing a native Pi extension and an isolated widget with the same wording.
 */

/** The Vietnamese catalog lookup, standing in for `useT()` since these are plain-function tests. */
const t = (key: MessageKey): string => MESSAGES_VI[key];

const DIGEST = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function view(overrides: Partial<InstalledPackageView> = {}): InstalledPackageView {
  return {
    packageId: "clark.notes",
    version: "1.2.3",
    digest: DIGEST,
    codeGeneration: "gen-1",
    activatedAt: "2026-09-21T00:00:00.000Z",
    source: { sourceTier: "registry", rationale: "published release", artifactUrl: "https://example.invalid/p.tgz" },
    lane: "isolated-ui",
    ...overrides,
  };
}

const ALL_LANES: InstalledPackageView["lane"][] = ["declarative", "isolated-ui", "service", "trusted-native"];

describe("package provenance", () => {
  it("words every trust lane", () => {
    for (const lane of ALL_LANES) {
      expect(provenanceRows([view({ lane })], t)[0]?.laneLabel, lane).toBeTruthy();
    }
  });

  it("does not word two different lanes the same way", () => {
    // The list exists to keep a native extension and an isolated widget distinguishable. Sharing wording
    // would make the label look informative while carrying no information.
    const labels = ALL_LANES.map((lane) => provenanceRows([view({ lane })], t)[0]?.laneLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("shortens a digest deterministically", () => {
    expect(shortDigest(DIGEST)).toBe("abcdef012345");
    expect(shortDigest(DIGEST)).toBe(shortDigest(DIGEST));
  });

  it("reads a local development package from the source tier the node already reports", () => {
    expect(provenanceKind("local")).toBe("local");
    expect(provenanceKind("path")).toBe("local");
    expect(provenanceKind("dev-link")).toBe("local");
    expect(provenanceKind("registry")).toBe("installed");
    expect(provenanceKind("git")).toBe("installed");
  });

  it("carries the fields the surface shows, and the lane wording from the shared table", () => {
    const [row] = provenanceRows([view()], t);
    expect(row?.packageId).toBe("clark.notes");
    expect(row?.version).toBe("1.2.3");
    expect(row?.digest).toBe("abcdef012345");
    expect(row?.fullDigest).toBe(DIGEST);
    expect(row?.sourceTier).toBe("registry");
    expect(row?.lane).toBe("isolated-ui");
    expect(row?.laneLabel).toBe(provenanceRows([view({ lane: "isolated-ui" })], t)[0]?.laneLabel);
    expect(row?.kind).toBe("installed");
  });

  it("does not carry the artifact URL, so the list cannot become a link farm", () => {
    // artifactUrl is provenance metadata, not something a catalogue list should render or fetch.
    const [row] = provenanceRows([view()], t);
    expect(Object.keys(row ?? {})).not.toContain("artifactUrl");
  });

  it("labels a built-in entry as built in rather than giving it a version it does not have", () => {
    expect(builtInLabel(t)).toContain("dựng sẵn");
  });

  it("preserves order, so the list does not reshuffle between reads", () => {
    const rows = provenanceRows([view({ packageId: "b" }), view({ packageId: "a" })], t);
    expect(rows.map((row) => row.packageId)).toEqual(["b", "a"]);
  });
});

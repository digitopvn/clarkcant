import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { directoryEntrySchema } from "@clarkcant/contracts";

import { installedManifest, installedReach } from "../src/package-resources.ts";

/**
 * Reading an installed package's own manifest for package details, from the directory index the caller read once.
 *
 * The fixture is the egress service the browser journeys install, listed locally, so the manifest read is a real one.
 */

const LOOKUP = { packageId: "com.example.lookup", version: "1.0.0", digest: "sha256:lookup-service-digest" };
const entries = (JSON.parse(readFileSync(join("apps", "web", "e2e", "fixtures", "directory.json"), "utf8")) as unknown[]).map((entry) =>
  directoryEntrySchema.parse(entry),
);

let previousIndex: string | undefined;

beforeEach(() => {
  // No index configured for the process: what is read comes from the index passed in, not from another read.
  previousIndex = process.env["CC_DIRECTORY_INDEX"];
  delete process.env["CC_DIRECTORY_INDEX"];
});

afterEach(() => {
  if (previousIndex !== undefined) process.env["CC_DIRECTORY_INDEX"] = previousIndex;
});

describe("an installed package's manifest", () => {
  it("is read from the index the caller passes, with the reach it declares", () => {
    const manifest = installedManifest(LOOKUP, tmpdir(), { kind: "configured", directory: "fixtures", entries });
    expect(manifest).not.toBe("unreadable");
    if (manifest === "unreadable") return;
    expect(manifest.id).toBe(LOOKUP.packageId);
    expect(installedReach(manifest)?.origins.map((origin) => origin.origin)).toEqual(["http://127.0.0.1:8879"]);
  });

  it("is unreadable without a directory, or for a digest the listing does not name", () => {
    expect(installedManifest(LOOKUP, tmpdir(), { kind: "not-configured", reason: "no directory" })).toBe("unreadable");
    expect(installedManifest({ ...LOOKUP, digest: "sha256:another" }, tmpdir(), { kind: "configured", directory: "fixtures", entries })).toBe("unreadable");
  });
});

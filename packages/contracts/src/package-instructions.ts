import { z } from "zod";

import { absoluteHostPathProblem } from "./host-path.ts";

/**
 * Where a package's conditional instructions apply: the projects the person enabled them for.
 *
 * A package's `instructions` facet (`install.ts`) carries rules in the same contract a project's own
 * `.clarkcant/instructions.json` does (`project-instructions.ts`). Installing the package states none of them. They apply
 * only in a project the person enabled them for, and only while that project is inside a root the person already granted:
 * one entry here per project and package. The person enables one by asking Clark, whose request the execution policy
 * decides, and turns one off the same way or in Settings; nothing a package or a widget says can add an entry.
 * Uninstalling a package removes its entries.
 *
 * A node preference: the paths are this machine's.
 */

export const PACKAGE_INSTRUCTIONS_PREFERENCE = "instructions.packages";

export const PACKAGE_INSTRUCTION_LIMITS = {
  /** Project and package pairs one node keeps. */
  enabled: 64,
  /**
   * Characters of package instructions stated in one turn or one tool result: their own slice of the turn's budget,
   * taken only from what the project's own instructions left, so a package never crowds the project's out.
   */
  turnChars: 2_000,
  /** Characters of one package snippet; a longer one is clipped and says so. */
  snippetChars: 1_500,
} as const;

/** A package id as an entry names it: the manifest's own `id`. */
const packageIdSchema = z.string().min(1).max(160);

/** One project where one package's instructions apply. */
export const packageInstructionsEnablementSchema = z.strictObject({
  /** The project folder, absolute and normalized, as this node spells it. */
  project: z.string().max(4_096).refine((path) => absoluteHostPathProblem(path) === undefined, {
    error: (issue) => `project ${absoluteHostPathProblem(String(issue.input)) ?? "must be an absolute folder path"}`,
  }),
  packageId: packageIdSchema,
});
export type PackageInstructionsEnablement = z.infer<typeof packageInstructionsEnablementSchema>;

/** The enabled pairs, each once. */
export const packageInstructionsPreferenceSchema = z
  .array(packageInstructionsEnablementSchema)
  .max(PACKAGE_INSTRUCTION_LIMITS.enabled)
  .refine(
    (entries) => new Set(entries.map((entry) => `${entry.packageId}\n${entry.project}`)).size === entries.length,
    { error: "lists a project and package pair twice" },
  );
export type PackageInstructionsPreference = z.infer<typeof packageInstructionsPreferenceSchema>;

/** The list with one pair added, or removed; the order of the rest is kept, and a pair already in place is not repeated. */
export function withPackageInstructions(
  entries: readonly PackageInstructionsEnablement[],
  change: PackageInstructionsEnablement & { enabled: boolean },
): PackageInstructionsEnablement[] {
  const rest = entries.filter((entry) => entry.packageId !== change.packageId || entry.project !== change.project);
  return change.enabled ? [...rest, { project: change.project, packageId: change.packageId }] : rest;
}

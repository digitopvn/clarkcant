/**
 * @clarkcant/pi-adapter
 *
 * The only package that imports the Pi SDK. Everything else depends on the
 * `PiAdapter` interface, so an SDK change is an adapter change rather than a
 * refactor of the core.
 *
 * `RealPiAdapter` is typed against the SDK's own declarations. `FakePiAdapter` is a
 * deterministic in-process implementation used by tests and CI, which is what lets
 * the whole application be exercised without a provider account.
 */

export * from "./types.ts";
export {
  PERSONAL_INSTRUCTIONS_HEADING,
  PERSONAL_INSTRUCTIONS_MAX_CHARS,
  composePersonalInstructions,
  hasPersonalInstructions,
  type PersonalInstructionsInput,
} from "./personal-instructions.ts";
export { providerErrorReason } from "./provider-error.ts";
export { DEFAULT_FAKE_SKILLS, FakePiAdapter, fakeSkillRevision, type FakeSkill, type ScriptedTurn } from "./fake.ts";
export {
  RealPiAdapter,
  READ_ONLY_TOOLS,
  REQUIRED_SDK_EXPORTS,
  mapPiEvent,
  sdkVersion,
  unsupportedCapability,
  type CompatibilityLock,
  type RealPiAdapterOptions,
} from "./real.ts";
export {
  canonicalRoots,
  createScopedFsTools,
  resolveInsideRoots,
  SCOPED_FS_LIMITS,
  SCOPED_FS_TOOL_NAMES,
  type ApprovedRoot,
  type CanonicalRoots,
  type InsideRoots,
  type RefusedRoot,
} from "./scoped-fs.ts";
export {
  readTranscriptFrom,
  redactSessionFile,
  transcriptSize,
  type RedactionResult,
  type TranscriptEntry,
  type TranscriptRead,
} from "./session-file.ts";
export {
  applyEnvFile,
  DEFAULT_MODEL_BUDGET,
  DEFAULT_WORKER_BUDGET,
  keyVariableFor,
  modelBudgetFromEnv,
  modelFromEnv,
  parseEnvFile,
  PROVIDER_KEY_VARIABLES,
  workerBudgetFromEnv,
  type EnvFileResult,
  type ModelBudget,
  type ModelSelection,
} from "./env-file.ts";

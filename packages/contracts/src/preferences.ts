/**
 * The preferences this product actually has.
 *
 * A registry rather than a free-form key/value store. The settings surface and the runtime both
 * read the same choices, and neither may invent a key the other does not know: a write to an
 * unregistered key is refused instead of stored, because a stored value nothing reads is a
 * setting that silently does nothing.
 *
 * Four properties are deliberate:
 *
 *   - **Scope belongs to the key, not to the caller.** A node-scoped choice cannot be written as a
 *     global one, so a request cannot widen a device preference into an account-wide default.
 *   - **Bounds live here.** The orb's clamps are the same numbers the settings UI offers and the
 *     renderer enforces, so a slider cannot express a value the shader would then ignore.
 *   - **`applies` is declared, not inferred.** The surface can say "next voice session" instead of
 *     implying a session already speaking changed voice underneath the user.
 *   - **Nothing here is credential material.** Secrets have their own store and their own routes,
 *     and the settings API returns only what this module declares.
 */

import { z } from "zod";

import { GUARD_CLASSES, guardClassSchema, jevUnavailablePolicySchema } from "./execution.ts";
import { effectCategorySchema, instantSchema } from "./primitives.ts";

/** Where a preference lives. A key declares one, and a write cannot choose another. */
export const preferenceScopeNameSchema = z.enum(["global", "node", "conversation"]);
export type PreferenceScopeName = z.infer<typeof preferenceScopeNameSchema>;

/**
 * When a change is actually in effect.
 *
 * `next-turn` exists because an instruction added to the system prompt reaches the model on the
 * next turn, which is neither "now" nor "when the session is recreated".
 */
export const preferenceAppliesSchema = z.enum([
  "immediate",
  "next-turn",
  "next-session",
  "next-voice-session",
  "desktop-restart",
]);
export type PreferenceApplies = z.infer<typeof preferenceAppliesSchema>;

interface NumericBound {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

const bounded = (bound: NumericBound) => z.number().min(bound.min).max(bound.max);

/**
 * What the orb's personalization is allowed to reach.
 *
 * Wide enough that the presets are visibly different from one another and narrow enough that no
 * stored combination can ask for a runaway simulation or a strobe. Every default is the value the
 * shipped orb already used, so a profile that omits a field renders exactly as the unpersonalized
 * orb did, and a profile written by an older release keeps rendering instead of failing.
 */
export const ORB_OPTICAL_BOUNDS = {
  /** Fraction of the half-height the orb occupies. */
  radius: { min: 0.3, max: 1, default: 0.72 },
  /** Brightness of the band inside the glass. */
  exposure: { min: 0.4, max: 6, default: 2 },
  /** Per-channel separation along the band, which is what fringes its edges. */
  chromatic: { min: 0, max: 1.5, default: 0.42 },
  /** Strength of the light the orb casts around itself. */
  glow: { min: 0, max: 1.5, default: 0.3 },
  /** Strength of the upper-left sheen on the shell. */
  sheen: { min: 0, max: 1.5, default: 0.28 },
} as const satisfies Record<string, NumericBound>;

/** Animation rate. Zero is a still orb, which is a legitimate choice and not a broken one. */
export const ORB_MOTION_BOUNDS = {
  speed: { min: 0, max: 3, default: 1.23 },
} as const satisfies Record<string, NumericBound>;

/**
 * The shell's spring, and how strongly it answers a pointer.
 *
 * An underdamped spring is what makes the orb ring rather than settle, so both constants are
 * exposed. The clamps keep the ringing visible as jelly instead of as a glitch, and the pointer
 * gain has a ceiling because a reaction stronger than the input reads as the orb being grabbed.
 */
export const ORB_PHYSICS_BOUNDS = {
  stiffness: { min: 40, max: 180, default: 90 },
  damping: { min: 4, max: 24, default: 7.5 },
  wobbleGain: { min: 0, max: 1, default: 1 },
  pointerResponse: { min: 0, max: 1.5, default: 1 },
} as const satisfies Record<string, NumericBound>;

/**
 * The named colour channels the shader has.
 *
 * Names rather than shader source: a stored preference selects a channel and cannot introduce
 * code. The list is asserted against the renderer's own palette in the orb tests, so it cannot
 * drift into names the shader never reads.
 */
export const ORB_PALETTE_CHANNELS = [
  "canvas",
  "glowColor",
  "highlight",
  "shellInner",
  "shellMid",
  "shellEdge",
  "sheenColor",
  "colorA",
  "colorB",
  "colorC",
  "colorD",
] as const;
export type OrbPaletteChannel = (typeof ORB_PALETTE_CHANNELS)[number];

/** Linear RGB in the shader's own space, so no conversion happens at the boundary. */
export const orbColorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

const paletteShape = Object.fromEntries(
  ORB_PALETTE_CHANNELS.map((channel) => [channel, orbColorSchema.optional()]),
) as Record<OrbPaletteChannel, z.ZodOptional<typeof orbColorSchema>>;

export const orbPalettePreferenceSchema = z.strictObject(paletteShape);

export const orbOpticalPreferenceSchema = z.strictObject({
  radius: bounded(ORB_OPTICAL_BOUNDS.radius).optional(),
  exposure: bounded(ORB_OPTICAL_BOUNDS.exposure).optional(),
  chromatic: bounded(ORB_OPTICAL_BOUNDS.chromatic).optional(),
  glow: bounded(ORB_OPTICAL_BOUNDS.glow).optional(),
  sheen: bounded(ORB_OPTICAL_BOUNDS.sheen).optional(),
});

export const orbMotionPreferenceSchema = z.strictObject({
  speed: bounded(ORB_MOTION_BOUNDS.speed).optional(),
});

export const orbPhysicsPreferenceSchema = z.strictObject({
  stiffness: bounded(ORB_PHYSICS_BOUNDS.stiffness).optional(),
  damping: bounded(ORB_PHYSICS_BOUNDS.damping).optional(),
  wobbleGain: bounded(ORB_PHYSICS_BOUNDS.wobbleGain).optional(),
  pointerResponse: bounded(ORB_PHYSICS_BOUNDS.pointerResponse).optional(),
});

/**
 * A personalized orb, in the four groups the settings surface offers.
 *
 * Every field is optional: the stored value is a patch over the preset, not a full description, so
 * a preset that gains a channel later does not require rewriting every stored profile.
 */
export const orbCustomPreferenceSchema = z.strictObject({
  palette: orbPalettePreferenceSchema.optional(),
  optical: orbOpticalPreferenceSchema.optional(),
  motion: orbMotionPreferenceSchema.optional(),
  physics: orbPhysicsPreferenceSchema.optional(),
});
export type OrbCustomPreference = z.infer<typeof orbCustomPreferenceSchema>;

/** The orb's named profiles. `custom` is the one whose bounded patch is read from `orb.custom`. */
export const orbProfileSchema = z.enum(["clark", "calm", "jelly", "glass", "custom"]);
export type OrbProfileName = z.infer<typeof orbProfileSchema>;

/**
 * How effects are decided.
 *
 * Declared here because the settings surface, the resolver and the audit trail must agree on the
 * spelling; `decideExecution` in core takes this type rather than defining a second one.
 */
export const executionModeSchema = z.enum(["autonomous", "guarded", "ask"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

/**
 * One user rule about one effect category.
 *
 * A rule may make a category stricter or looser than the mode's default, and `deny` exists so a
 * user can refuse a category outright. It cannot express "anything, anywhere": the category list
 * is closed, and the hard consent boundaries — OS, OAuth, browser, vendor — are enforced outside
 * this table, so no rule can widen them.
 */
export const executionRuleSchema = z.strictObject({
  effectCategory: effectCategorySchema,
  decision: z.enum(["execute", "ask", "deny"]),
});
export type ExecutionRule = z.infer<typeof executionRuleSchema>;

export const executionRulesPreferenceSchema = z.array(executionRuleSchema).max(24);

/**
 * The one refusal no category table can express.
 *
 * `deny` was one of the four values of the legacy execution policy, and on this node it meant "every
 * effect category is refused". Written as an enumeration of categories it would have been a snapshot:
 * the category list is closed at seven values today, so a build that adds an eighth would have no rule
 * for it and the refusal would fail open exactly where it was meant to hold. `prohibition` is the same
 * decision with a closed structure — none, or all — so it cannot be outgrown.
 *
 * Read above the hard consent boundaries, deliberately: "never" is the user's own decision about their
 * machine, and a consent screen an application can put in front of them is not the user taking it back.
 */
export const executionProhibitionSchema = z.enum(["none", "all"]);
export type ExecutionProhibition = z.infer<typeof executionProhibitionSchema>;

/**
 * How the judgment layer is configured. Never what it answered.
 *
 * `classes` is the authority for "is the judgment layer consulted for this effect", which is a different
 * question from `mode`'s "who is asked": a class that is not here runs unjudged, and a class that is here
 * can still come back `allow`. It is named `classes` rather than `guardedClasses` on purpose — one word
 * for two questions is how a reader ends up believing the mode called "guarded" is driven by this list.
 *
 * `allow`, `deny`, `constrain` and `clarify` are its answers and are nowhere in here: they are decisions
 * about one operation, and a stored answer would become a permission the next one inherits.
 */
export const executionGuardrailsSchema = z.object({
  enabled: z.boolean(),
  /** Free text handed to the judgment layer as policy. It can only narrow what the host already allowed. */
  instructions: z.string().max(4_000),
  classes: z.array(guardClassSchema).max(16),
  whenUnavailable: jevUnavailablePolicySchema,
});
export type ExecutionGuardrails = z.infer<typeof executionGuardrailsSchema>;

/**
 * The one execution policy.
 *
 * Four axes, and each answers a question the others cannot:
 *
 *   - `mode` — who is asked when an effect is allowed to happen at all;
 *   - `prohibition` — whether any effect happens on this node, above every other rule;
 *   - `rules` — the user's own per-category decisions;
 *   - `guardrails` — whether a judgment layer may narrow an effect that the above allowed.
 *
 * Held in one document rather than spread over three preferences because the settings surface, the
 * resolver and the audit trail have to agree on it, and because a policy that is assembled from three
 * reads is a policy that can be observed half-changed.
 */
export const executionPolicyConfigSchema = z.object({
  mode: executionModeSchema,
  prohibition: executionProhibitionSchema,
  rules: executionRulesPreferenceSchema,
  guardrails: executionGuardrailsSchema,
});
export type ExecutionPolicyConfig = z.infer<typeof executionPolicyConfigSchema>;

/**
 * What a node with nothing stored runs: Autonomous, with the judgment layer on.
 *
 * `autonomous` and not `guarded`, because that is the recorded product default (DESIGN.md §1.3, §5.3 and
 * AGENTS.md): a user's own instruction is enough, and the layer that can narrow it stays switched on.
 * The legacy constants that say `guarded` describe the legacy vocabulary only and are never consulted
 * for a node that stored neither family.
 */
export const DEFAULT_EXECUTION_POLICY_CONFIG: ExecutionPolicyConfig = {
  mode: "autonomous",
  prohibition: "none",
  rules: [],
  guardrails: {
    enabled: true,
    instructions: "",
    classes: GUARD_CLASSES.filter((guardClass) => guardClass !== "reads"),
    whenUnavailable: "allow",
  },
};

/** One stored rule, or nothing. The rule list is filtered entry by entry, like the switches were. */
function parseStoredRules(value: unknown): ExecutionRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = executionRulesPreferenceSchema.safeParse(value);
  // The common case: a list this node's own writer produced, kept exactly as it is.
  if (parsed.success) return parsed.data;
  /*
   * A list that is wrong somewhere. Dropping the whole list would drop the refusals in it, which is the one
   * way this function could widen what the user chose; keeping the entries that parse costs only the entry
   * that did not. First entry per category wins, because that is what the resolver's `find` reads.
   */
  const kept: ExecutionRule[] = [];
  for (const entry of value) {
    const rule = executionRuleSchema.safeParse(entry);
    if (!rule.success) continue;
    if (kept.some((candidate) => candidate.effectCategory === rule.data.effectCategory)) continue;
    kept.push(rule.data);
  }
  return kept;
}

/**
 * Read a stored policy, field by field, including the fields inside `guardrails`.
 *
 * Field-wise and not all-or-nothing, for the reason the legacy settings parser gives: a document written
 * before a field existed is the normal case after an upgrade, and refusing the whole document would
 * silently reset a policy the user chose. The nesting makes this sharper rather than softer — a stored
 * `instructions` a newer build rejects must cost the instructions and nothing else. A parser that treated
 * `guardrails` as one leaf would reset the mode along with it, which is a widening produced by a typo.
 */
export function parseExecutionPolicyConfig(value: unknown): ExecutionPolicyConfig {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const guardrailSource =
    typeof source.guardrails === "object" && source.guardrails !== null
      ? (source.guardrails as Record<string, unknown>)
      : {};
  const defaults = DEFAULT_EXECUTION_POLICY_CONFIG;

  const mode = executionModeSchema.safeParse(source.mode);
  const prohibition = executionProhibitionSchema.safeParse(source.prohibition);
  const rules = parseStoredRules(source.rules);
  const enabled = z.boolean().safeParse(guardrailSource.enabled);
  const unavailable = jevUnavailablePolicySchema.safeParse(guardrailSource.whenUnavailable);
  const classes = Array.isArray(guardrailSource.classes)
    ? guardrailSource.classes.filter((entry) => guardClassSchema.safeParse(entry).success)
    : [...defaults.guardrails.classes];

  return {
    mode: mode.success ? mode.data : defaults.mode,
    prohibition: prohibition.success ? prohibition.data : defaults.prohibition,
    rules: rules ?? [...defaults.rules],
    guardrails: {
      enabled: enabled.success ? enabled.data : defaults.guardrails.enabled,
      instructions:
        typeof guardrailSource.instructions === "string"
          ? guardrailSource.instructions.slice(0, 4_000)
          : defaults.guardrails.instructions,
      classes: classes as ExecutionPolicyConfig["guardrails"]["classes"],
      whenUnavailable: unavailable.success ? unavailable.data : defaults.guardrails.whenUnavailable,
    },
  };
}

/** Which model a background turn uses when it is not the one the conversation is on. */
export const backgroundRoutingSchema = z.enum(["auto", "same", "fast", "cheap", "quality"]);
export type BackgroundRouting = z.infer<typeof backgroundRoutingSchema>;

/** Provider-qualified model references, in the order the user wants them offered. */
export const modelFavoritesPreferenceSchema = z.array(z.string().trim().min(1).max(200)).max(12);

/**
 * What the user wants Clark to know about them, beyond the product's own instructions.
 *
 * The bound is the whole safety story of the text field: it is a section inside the system prompt,
 * never a replacement for it, so it cannot be used to delete the tool or security instructions
 * that precede it.
 *
 * The number is exported rather than written twice, because the settings field shows the count against
 * it: a control that reported a different limit from the one the node enforces would refuse a value the
 * user had been told was acceptable.
 */
export const PERSONAL_INSTRUCTIONS_MAX_CHARS = 2_000;

export const personalInstructionsPreferenceSchema = z.strictObject({
  enabled: z.boolean(),
  text: z.string().max(PERSONAL_INSTRUCTIONS_MAX_CHARS),
});
export type PersonalInstructionsPreference = z.infer<typeof personalInstructionsPreferenceSchema>;

/**
 * A provider id, as the voice adapter names itself. Never a credential.
 *
 * `null` is a real state: no provider has been chosen, so whichever one is configured answers with
 * its own default. An empty string would look like an id and read as one.
 */
export const voiceProviderPreferenceSchema = z.string().trim().min(1).max(120).nullable();

/** A voice id offered by the selected provider's own capabilities, or `null` for its default. */
export const voiceNamePreferenceSchema = z.string().trim().min(1).max(120).nullable();

/**
 * The wake listener's own state.
 *
 * `detectorId` names a local detector the platform provides. The toggle exists so the state is
 * visible; a platform with no acceptable local detector ships the toggle unavailable with a reason
 * rather than falling back to sending ambient audio to a provider.
 */
export const voiceWakePreferenceSchema = z.strictObject({
  enabled: z.boolean(),
  detectorId: z.string().trim().min(1).max(120),
});
export type VoiceWakePreference = z.infer<typeof voiceWakePreferenceSchema>;

/**
 * How many background requests one node runs at once.
 *
 * Three choices rather than a number field: the useful question is "one at a time, a few, or more", and a free
 * number invites a value the machine cannot carry. The main conversation turn is never counted against it.
 */
export const backgroundLimitSchema = z.union([z.literal(1), z.literal(3), z.literal(5)]);
export type BackgroundLimit = z.infer<typeof backgroundLimitSchema>;

/** The window presentations this application has. */
export const windowModeSchema = z.enum(["normal", "expanded", "compact", "orb"]);
export type WindowMode = z.infer<typeof windowModeSchema>;

/**
 * The groups an OS/web notification can belong to, in the product's own words.
 *
 * A closed list rather than the notice categories or waiting-item kinds directly: a person turns off
 * "background results", not `category: "result"`, and the mapping from the wire vocabulary to these four
 * is a client concern (`groupForNotice` in `@clarkcant/conversation-client`) precisely because it is a
 * UX grouping, not a wire contract. `otherDevices` exists ahead of its own producer (§6.7 "Chưa ship"):
 * the notice shape already carries `originNodeId` for a paired node, and a preference the write path
 * refuses today would be a worse upgrade than a toggle that has nothing to control yet.
 */
export const inboxNotificationGroupSchema = z.enum(["waitingApprovals", "backgroundResults", "updates", "otherDevices"]);
export type InboxNotificationGroup = z.infer<typeof inboxNotificationGroupSchema>;
export const INBOX_NOTIFICATION_GROUPS = inboxNotificationGroupSchema.options;

/** A clock reading as a person types it into a time field: zero-padded hours and minutes, local time. */
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a 24-hour HH:MM time");

/**
 * What decides whether one poll raises an OS or a web notification.
 *
 * `os` and `web` are separate switches because they are separate consent stories: `os` is host-owned and
 * Electron's own notification permission (an OS boundary this preference does not lift, only enables asking
 * for) while `web` may only ever become `true` after `Notification.requestPermission()` itself answered
 * `granted` — the write path accepts either value, but the settings surface is the one place that is allowed
 * to set `web: true`, and only from that explicit toggle.
 */
export const inboxNotificationsPreferenceSchema = z.strictObject({
  groups: z.strictObject({
    waitingApprovals: z.boolean(),
    backgroundResults: z.boolean(),
    updates: z.boolean(),
    otherDevices: z.boolean(),
  }),
  os: z.boolean(),
  web: z.boolean(),
  quietHours: z.strictObject({
    enabled: z.boolean(),
    start: timeOfDaySchema,
    end: timeOfDaySchema,
  }),
});
export type InboxNotificationsPreference = z.infer<typeof inboxNotificationsPreferenceSchema>;

/**
 * What a node with nothing stored uses: every group on, OS notifications on, web off until granted, and no
 * quiet hours. OS defaults on because it is what closes the gap #171 reports — an approval expiring unseen
 * while the window has no focus — and Electron's own permission prompt is the boundary that still gates it
 * on the platforms that have one. `web` defaults off because turning it on is itself the consent action.
 */
export const DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE: InboxNotificationsPreference = {
  groups: { waitingApprovals: true, backgroundResults: true, updates: true, otherDevices: true },
  os: true,
  web: false,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
};

/**
 * One registered preference.
 *
 * Loose generics on purpose: the registry holds heterogeneous values, and a caller that wants the
 * typed value parses it with `schema` rather than casting what it read.
 */
export interface PreferenceDefinition {
  readonly key: string;
  readonly scope: PreferenceScopeName;
  readonly applies: PreferenceApplies;
  /** What the value is when the user has never set it. Reported with `isDefault`, never as a choice. */
  readonly default: unknown;
  readonly schema: z.ZodType;
  /**
   * Applied before validation, and only to a shape it recognizes.
   *
   * Normalizing here rather than in each caller is what keeps two write paths from storing the
   * same choice in two spellings. It never repairs an invalid value: `undefined` means "this is
   * not the shape I clean", and the caller passes the original input to the schema so the refusal
   * names the field the user got wrong instead of a normalization that silently did nothing.
   */
  readonly normalize?: (value: unknown) => object | undefined;
}

/** Trim-only. A user's own wording is theirs; this removes only what they cannot see. */
const normalizePersonalInstructions = (
  value: unknown,
): PersonalInstructionsPreference | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean" || typeof record.text !== "string") return undefined;
  return { enabled: record.enabled, text: record.text.trim() };
};

/**
 * Trims and de-duplicates favourites, keeping the user's order.
 *
 * Order is the meaning of this preference, so it is preserved; only an entry that is already
 * present is dropped. An entry that could not be a model reference at all is left for the schema
 * to refuse, rather than being quietly removed from a list the user typed.
 */
const normalizeModelFavorites = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string" && entry.trim() !== "")) return undefined;
  const seen = new Set<string>();
  const trimmed: string[] = [];
  for (const entry of value as string[]) {
    const reference = entry.trim();
    if (seen.has(reference)) continue;
    seen.add(reference);
    trimmed.push(reference);
  }
  return trimmed;
};

/**
 * Every preference this product has, in the order the settings surface groups them.
 *
 * Declaration order is the read order: the API answers in this sequence so a client renders
 * Experience before Developer without re-sorting a list whose meaning is its grouping.
 */
export const PREFERENCE_REGISTRY = {
  "experience.theme": {
    key: "experience.theme",
    scope: "global",
    applies: "immediate",
    default: "system",
    schema: z.enum(["system", "light", "dark"]),
  },
  "experience.motion": {
    key: "experience.motion",
    scope: "global",
    applies: "immediate",
    default: "system",
    schema: z.enum(["system", "full", "reduced"]),
  },
  "experience.language": {
    key: "experience.language",
    scope: "global",
    applies: "immediate",
    default: "vi",
    schema: z.enum(["vi", "en"]),
  },
  "experience.density": {
    key: "experience.density",
    scope: "global",
    applies: "immediate",
    default: "comfortable",
    schema: z.enum(["comfortable", "compact"]),
  },
  "orb.profile": {
    key: "orb.profile",
    scope: "global",
    applies: "immediate",
    default: "clark",
    schema: orbProfileSchema,
  },
  "orb.custom": {
    key: "orb.custom",
    scope: "global",
    applies: "immediate",
    default: {},
    schema: orbCustomPreferenceSchema,
  },
  "execution.mode": {
    key: "execution.mode",
    scope: "global",
    applies: "immediate",
    default: "autonomous",
    schema: executionModeSchema,
  },
  "execution.rules": {
    key: "execution.rules",
    scope: "global",
    applies: "immediate",
    default: [],
    schema: executionRulesPreferenceSchema,
  },
  "execution.policy": {
    key: "execution.policy",
    scope: "global",
    applies: "immediate",
    default: DEFAULT_EXECUTION_POLICY_CONFIG,
    schema: executionPolicyConfigSchema,
  },
  "execution.backgroundLimit": {
    key: "execution.backgroundLimit",
    // Per node: how much work runs at once is a fact about the machine running it, not about the account.
    scope: "node",
    applies: "immediate",
    default: 3,
    schema: backgroundLimitSchema,
  },
  "ai.modelFavorites": {
    key: "ai.modelFavorites",
    scope: "global",
    applies: "immediate",
    default: [],
    schema: modelFavoritesPreferenceSchema,
    normalize: normalizeModelFavorites,
  },
  "ai.backgroundRouting": {
    key: "ai.backgroundRouting",
    scope: "global",
    applies: "next-session",
    default: "auto",
    schema: backgroundRoutingSchema,
  },
  "ai.personalInstructions": {
    key: "ai.personalInstructions",
    scope: "global",
    applies: "next-turn",
    default: { enabled: false, text: "" },
    schema: personalInstructionsPreferenceSchema,
    normalize: normalizePersonalInstructions,
  },
  "voice.provider": {
    key: "voice.provider",
    scope: "node",
    applies: "next-voice-session",
    default: null,
    schema: voiceProviderPreferenceSchema,
  },
  "voice.voiceName": {
    key: "voice.voiceName",
    scope: "node",
    applies: "next-voice-session",
    default: null,
    schema: voiceNamePreferenceSchema,
  },
  "voice.wake": {
    key: "voice.wake",
    scope: "node",
    applies: "immediate",
    default: { enabled: false, detectorId: "none" },
    schema: voiceWakePreferenceSchema,
  },
  "desktop.startMode": {
    key: "desktop.startMode",
    scope: "node",
    applies: "desktop-restart",
    default: "normal",
    schema: windowModeSchema,
  },
  "desktop.rememberBounds": {
    key: "desktop.rememberBounds",
    scope: "node",
    applies: "immediate",
    default: true,
    schema: z.boolean(),
  },
  "inbox.notifications": {
    key: "inbox.notifications",
    scope: "node",
    applies: "immediate",
    default: DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
    schema: inboxNotificationsPreferenceSchema,
  },
} as const satisfies Record<string, PreferenceDefinition>;

export type PreferenceKey = keyof typeof PREFERENCE_REGISTRY;

/** Registered keys, in declaration order. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = Object.keys(PREFERENCE_REGISTRY) as PreferenceKey[];

/**
 * The definition for a key, or nothing.
 *
 * Nothing rather than a default: the caller's next move for an unknown key is to refuse the
 * request, and a synthesized definition would turn a typo into an accepted write.
 */
export function preferenceDefinition(key: string): PreferenceDefinition | undefined {
  return (PREFERENCE_REGISTRY as Record<string, PreferenceDefinition>)[key];
}

/**
 * What the settings API reports about one registered preference.
 *
 * A wire shape, so it is declared here and validated by whoever reads it rather than reconstructed
 * on the client from a store that could change. `value` stays unvalidated on purpose: the shape is
 * the key's own schema, and a reader that wants the typed value looks the definition up.
 *
 * `isDefault` is the honesty of the whole response: a preference nobody has set is answered with
 * the default the product would use, marked as a default, so a surface cannot render it as a choice
 * the user made.
 */
export const registeredPreferenceSchema = z.strictObject({
  key: z.string().min(1),
  scope: preferenceScopeNameSchema,
  applies: preferenceAppliesSchema,
  value: z.unknown(),
  isDefault: z.boolean(),
  /** Zero means this key has never been written. */
  revision: z.number().int().min(0),
  updatedAt: instantSchema.nullable(),
});
export type RegisteredPreference = z.infer<typeof registeredPreferenceSchema>;

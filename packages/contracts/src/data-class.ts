import { z } from "zod";

import { SECRET_SHAPES } from "./redaction.ts";

/**
 * How sensitive a piece of data is, and which classes a model may be sent.
 *
 * One vocabulary for every boundary data crosses: a grant names the classes a delegation may carry, an artifact offer
 * names its own, and the context planner (#433) labels each block it could put in front of a model. Ordered: a class
 * permits everything below it only when a list says so — permission is always an explicit list, never "up to".
 */
export const dataClassSchema = z.enum(["public", "internal", "confidential", "secret"]);
export type DataClass = z.infer<typeof dataClassSchema>;

/** Least to most sensitive. */
export const DATA_CLASSES: readonly DataClass[] = dataClassSchema.options;

/** Where a model runs, as the person describes it: the default classes it may receive follow from this. */
export const trustClassSchema = z.enum(["local", "first-party", "approved-third-party", "untrusted"]);
export type TrustClass = z.infer<typeof trustClassSchema>;

/**
 * The classes a model of each trust class may receive when its profile names no list of its own.
 *
 * Only a model on this machine is sent credential-shaped text. A third party, approved or first-party, is sent up to
 * `confidential`; an untrusted one only what is public.
 */
const TRUST_CEILING: Readonly<Record<TrustClass, readonly DataClass[]>> = {
  local: ["public", "internal", "confidential", "secret"],
  "first-party": ["public", "internal", "confidential"],
  "approved-third-party": ["public", "internal", "confidential"],
  untrusted: ["public"],
};

/** What a profile that says nothing about data may receive: everything but credential-shaped text. */
export const DEFAULT_ALLOWED_DATA_CLASSES: readonly DataClass[] = TRUST_CEILING["approved-third-party"];

/**
 * The classes Jev, the selector, may be shown. It is a third-party service that only ever ranks, so it is offered what
 * a person's own conversation is made of and nothing more sensitive: a confidential or secret candidate keeps its
 * deterministic place instead.
 */
export const SELECTOR_DATA_CLASSES: readonly DataClass[] = ["public", "internal"];

export function dataClassRank(value: DataClass): number {
  return DATA_CLASSES.indexOf(value);
}

/** The most sensitive of some classes; `public` for none. */
export function maxDataClass(values: Iterable<DataClass>): DataClass {
  let max: DataClass = "public";
  for (const value of values) if (dataClassRank(value) > dataClassRank(max)) max = value;
  return max;
}

/**
 * What a model profile may receive.
 *
 * Its own list and its trust class only ever narrow each other: a list that names `secret` on an untrusted profile is
 * still only `public`. With neither, the default above.
 */
export function allowedDataClassesFor(profile: {
  allowedDataClasses?: readonly DataClass[] | undefined;
  trustClass?: TrustClass | undefined;
}): readonly DataClass[] {
  const ceiling = profile.trustClass === undefined ? undefined : TRUST_CEILING[profile.trustClass];
  const listed = profile.allowedDataClasses;
  if (listed === undefined) return ceiling ?? DEFAULT_ALLOWED_DATA_CLASSES;
  const base = ceiling ?? DATA_CLASSES;
  return DATA_CLASSES.filter((value) => listed.includes(value) && base.includes(value));
}

/** The classes every list permits: what a model matched by several profiles may receive. */
export function intersectDataClasses(lists: readonly (readonly DataClass[])[]): readonly DataClass[] {
  if (lists.length === 0) return DEFAULT_ALLOWED_DATA_CLASSES;
  return DATA_CLASSES.filter((value) => lists.every((list) => list.includes(value)));
}

/** Shapes that are a credential: text carrying one is `secret`. */
const CREDENTIAL_SHAPES = new Set([
  "jwt",
  "bearer",
  "private-key",
  "aws-access-key",
  "github-token",
  "google-api-key",
  "url-credentials",
  "prefixed-token",
  "named-secret",
]);

/** Prefixes real tokens are issued with: a value after one of these is judged more leniently than after a plain word. */
const ISSUED_PREFIX = /^(?:sk|pk|rk|ghp|gho|npm|xox[baprs])$/i;

/**
 * Whether a `prefixed-token` match is a token rather than an identifier.
 *
 * The redactor's shape matches `token_refresh_worker_2` and `api_v2_handler_migration_0012` as readily as a key, which
 * is a fair trade when replacing text and a poor one when classifying it: a class decides where work may be routed. A
 * token is a long run of letters and digits; an identifier is words joined by separators.
 */
function looksIssued(match: string): boolean {
  const split = /^([A-Za-z]+)[-_](.+)$/.exec(match);
  if (split === null) return false;
  const prefix = split[1] ?? "";
  const value = split[2] ?? "";
  const mixed = /[A-Za-z]/.test(value) && /\d/.test(value);
  if (!mixed) return false;
  const longestRun = Math.max(...value.split(/[-_.]/).map((run) => run.length));
  // `sk-live-4f9a…`, `xoxb-1234567890-…`: an issued prefix, a long value, and a long unbroken run in it.
  if (ISSUED_PREFIX.test(prefix)) return value.length >= 16 && longestRun >= 10;
  // After a plain word (`api`, `key`, `token`, `secret`), only one unbroken run of letters and digits is a token.
  return /^[A-Za-z0-9]{16,}$/.test(value);
}

/**
 * Whether a `named-secret` match carries a value rather than a type or a reference: `password: string` and
 * `api_key: process.env.API_KEY` are code, `password = "hunter22"` is not.
 */
function looksAssigned(match: string): boolean {
  const value = /[:=]\s*["']?(.+)$/.exec(match)?.[1] ?? "";
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(value)) return false;
  return /\d/.test(value) || /[:=]\s*["']/.test(match) || value.length >= 16;
}
/** Shapes that identify a person or their machine: text carrying one is `confidential`. */
const PERSONAL_SHAPES = new Set(["email", "phone", "home-path", "windows-path"]);

/**
 * The class of a text, from its shapes alone.
 *
 * Deterministic and cheap, so it can run on every candidate before anything is ranked or sent. Long hex and base64 runs
 * are left `internal`: a commit hash or a digest is the everyday material of a coding conversation, and calling it a
 * secret would withhold half of one. Anything a person or Clark wrote is at least `internal`; nothing is derived
 * `public`.
 */
export function dataClassOfText(text: string): DataClass {
  let found: DataClass = "internal";
  for (const shape of SECRET_SHAPES) {
    const credential = CREDENTIAL_SHAPES.has(shape.label);
    if (!credential && (!PERSONAL_SHAPES.has(shape.label) || found === "confidential")) continue;
    const matches = text.match(new RegExp(shape.pattern.source, shape.pattern.flags)) ?? [];
    const hit =
      shape.label === "prefixed-token"
        ? matches.some(looksIssued)
        : shape.label === "named-secret"
          ? matches.some(looksAssigned)
          : matches.length > 0;
    if (!hit) continue;
    if (credential) return "secret";
    found = "confidential";
  }
  return found;
}

/** A rough token count: four characters a token, the same assumption the cache-economics harness prints. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

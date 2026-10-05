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
  "sendgrid-key",
  "basic-auth",
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
 * `api_key: process.env.API_KEY` are code, `password = "hunter22"` is not. The redaction shape already passes over a
 * call chain (`z.string().min(8)`), a type name and a template placeholder; a member reference is ruled out here,
 * where a miss costs a routing choice rather than a credential.
 */
function looksAssigned(match: string): boolean {
  const value = /[:=]\s*["']?(.+)$/.exec(match)?.[1] ?? "";
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)+[;)\]]*$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\(|\$\{|\{\{|^</.test(value)) return false;
  if (isPlaceholderValue(value)) return false;
  return /\d/.test(value) || /[:=]\s*["']/.test(match) || value.length >= 16;
}

/** Words that stand in for a credential in examples and templates, compared without separators or case. */
const PLACEHOLDER_WORDS = new Set([
  "example",
  "sample",
  "dummy",
  "fake",
  "test",
  "placeholder",
  "changeme",
  "changeit",
  "secret",
  "password",
  "passwd",
  "token",
  "apikey",
  "redacted",
  "todo",
  "tbd",
  "none",
  "null",
  "empty",
]);

/**
 * Whether a credential-shaped value is an obvious placeholder: `your_api_key`, `example`, `changeme`, `YOURTOKENHERE`,
 * `xxxxxxxx`, `********`. Conservative on purpose — a miss here costs a refused turn, a wrong hit costs a credential — so
 * only a value with no digit can be one, and only when it is a known stand-in word, addresses the reader about a generic
 * credential (`your_api_key`, `insert_your_token_here`, `replace_password`), ends in
 * `<key|token|secret|password|value>here`, or is at least four of one repeated mask character. A value that merely
 * starts with `your` (`YourMomsMaidenNameIsSecret`) is a value.
 */
function isPlaceholderValue(raw: string): boolean {
  const value = raw.trim().replace(/^["']|["']$/g, "");
  if (value === "") return true;
  if (/^(.)\1{3,}$/.test(value) && /^[x*.#-]$/i.test(value[0] ?? "")) return true;
  if (/\d/.test(value)) return false;
  const word = value.toLowerCase().replace(/[-_. ]/g, "");
  if (PLACEHOLDER_WORDS.has(word)) return true;
  return (
    /^(?:(?:insert|replace)(?:your)?|your)(?:key|token|secret|password|apikey)(?:here)?$/.test(word) ||
    /(?:key|token|secret|password|value)(?:goes)?here$/.test(word)
  );
}

/**
 * Whether an `Authorization: Basic …` header carries a credential: its value decodes to printable `user:password` text
 * and either side is a real value. A key sent as the user with an empty password counts, and so does a one-letter
 * password. A word that merely follows "Basic" does not decode to that, and is left alone.
 */
function carriesBasicCredentials(match: string): boolean {
  const encoded = /Basic\s+(\S+)$/i.exec(match)?.[1] ?? "";
  let decoded: string;
  try {
    // Read as UTF-8, so a user name or password written with accents is still text; bytes that are not are no credential.
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return false;
  }
  if (decoded === "" || [...decoded].some((char) => char < " " || char === "\u007f")) return false;
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  return !isPlaceholderValue(decoded.slice(0, split)) || !isPlaceholderValue(decoded.slice(split + 1));
}
/** Shapes that identify a person or their machine: text carrying one is `confidential`. */
const PERSONAL_SHAPES = new Set(["email", "phone", "home-path", "windows-path"]);

/** The URL-credentials shape, taken out of a text before an address is looked for in it. */
const URL_CREDENTIALS = new RegExp(
  SECRET_SHAPES.find((shape) => shape.label === "url-credentials")?.pattern.source ?? "(?!)",
  "gi",
);

/**
 * The class of a text, from its shapes alone.
 *
 * Deterministic and cheap, so it can run on every candidate before anything is ranked or sent. Long hex and base64 runs
 * are left `internal`: a commit hash or a digest is the everyday material of a coding conversation, and calling it a
 * secret would withhold half of one. Anything a person or Clark wrote is at least `internal`; nothing is derived
 * `public`.
 */
export function dataClassOfText(text: string): DataClass {
  return maxDataClass(dataClassesOfText(text));
}

/**
 * Every class a text carries, least to most sensitive: `internal` always, plus `confidential` for a personal shape and
 * `secret` for a credential one. The send boundary checks each against a model's list, which may name a more sensitive
 * class without a less sensitive one; the most sensitive alone would admit the other.
 */
export function dataClassesOfText(text: string): readonly DataClass[] {
  const found = new Set<DataClass>(["internal"]);
  for (const shape of SECRET_SHAPES) {
    const credential = CREDENTIAL_SHAPES.has(shape.label);
    const dataClass: DataClass | undefined = credential ? "secret" : PERSONAL_SHAPES.has(shape.label) ? "confidential" : undefined;
    if (dataClass === undefined || found.has(dataClass)) continue;
    // An address is read on the text without its URL credentials, so `postgres://app:password@db.example.com` is a
    // connection string rather than the address `password@db.example.com`.
    const subject = shape.label === "email" ? text.replace(URL_CREDENTIALS, " ") : text;
    const matches = subject.match(new RegExp(shape.pattern.source, shape.pattern.flags)) ?? [];
    const hit =
      shape.label === "prefixed-token"
        ? matches.some(looksIssued)
        : shape.label === "named-secret"
          ? matches.some(looksAssigned)
          : shape.label === "bearer"
            ? matches.some((match) => !isPlaceholderValue(match.replace(/^Bearer\s+/, "")))
            : shape.label === "url-credentials"
              ? matches.some((match) => !isPlaceholderValue(/:([^:@]*)@$/.exec(match)?.[1] ?? ""))
              : shape.label === "basic-auth"
                ? matches.some(carriesBasicCredentials)
                : matches.length > 0;
    if (hit) found.add(dataClass);
  }
  return DATA_CLASSES.filter((value) => found.has(value));
}

/**
 * The classes one provider request carries: each text part classified on its own, plus classes already known for parts
 * whose text is not at hand here (a retrieved bundle labelled when it was built). Empty parts carry nothing. Least to
 * most sensitive, each once.
 *
 * Parts are classified separately rather than joined, so a shape can never be made up of the end of one part and the
 * start of the next.
 */
export function outboundDataClasses(input: {
  texts?: Iterable<string | undefined>;
  classes?: Iterable<DataClass>;
}): readonly DataClass[] {
  const present = new Set<DataClass>(input.classes ?? []);
  for (const text of input.texts ?? []) {
    if (text === undefined || text.trim() === "") continue;
    for (const value of dataClassesOfText(text)) present.add(value);
  }
  return DATA_CLASSES.filter((value) => present.has(value));
}

/** What the send-boundary check answers when nothing may be sent: the code every surface reports it under. */
export const MODEL_DATA_CLASS_UNAVAILABLE = "MODEL_DATA_CLASS_UNAVAILABLE";

/**
 * Whether a request may be sent to a model, and if not, which class stops it.
 *
 * `dataClass` is the most sensitive class the request carries when it may go, and the most sensitive class the model
 * may not receive when it may not: the one a person has to change something about. Never the text.
 */
export type SendBoundaryCheck =
  | { ok: true; dataClass: DataClass }
  | { ok: false; code: typeof MODEL_DATA_CLASS_UNAVAILABLE; dataClass: DataClass; allowed: readonly DataClass[] };

/**
 * The classes the send boundary refuses to send to a model whose list leaves them out. `public` and `internal` are what
 * every conversation is made of: they steer routing and narrow retrieved context, and are never on their own a reason
 * not to send, so a model limited to `public` can still hold an ordinary conversation.
 */
export const ENFORCED_DATA_CLASSES: readonly DataClass[] = ["confidential", "secret"];

/**
 * The send boundary: every enforced class a request carries must be one the receiving model may be sent.
 *
 * The one check every path to a provider uses — a turn after any fallback, a rebuilt or handed-over session, a background
 * run, a dispatched worker and the tool results fed back into a run. Permission is an explicit list (see above), so each
 * enforced class present is checked, not only the most sensitive: a list naming `secret` but not `confidential` does not
 * admit a request carrying both. Deterministic and cheap, so it runs again immediately before a send whatever ran before
 * it.
 */
export function checkSendBoundary(input: {
  allowed: readonly DataClass[];
  texts?: Iterable<string | undefined>;
  classes?: Iterable<DataClass>;
}): SendBoundaryCheck {
  const present = outboundDataClasses(input);
  const refused = present.filter((value) => ENFORCED_DATA_CLASSES.includes(value) && !input.allowed.includes(value));
  if (refused.length === 0) return { ok: true, dataClass: maxDataClass(present) };
  return { ok: false, code: MODEL_DATA_CLASS_UNAVAILABLE, dataClass: maxDataClass(refused), allowed: input.allowed };
}

/** A rough token count: four characters a token, the same assumption the cache-economics harness prints. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

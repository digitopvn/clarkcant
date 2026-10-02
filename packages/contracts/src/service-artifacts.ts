import { z } from "zod";

import { ARTIFACT_LIMITS } from "./artifacts.ts";
import { artifactIdSchema } from "./primitives.ts";

/**
 * Service artifact input: how a package service reads a file a widget holds, without ever holding the file.
 *
 * A service container has no network and sees no host path. When a capability declares `inputArtifacts`, the fields it
 * names carry artifact ids, and the host checks each one before the call is sent: the widget instance that pressed the
 * button must hold a grant on it, its bytes must be sealed, and it must fit the input cap of the resource profile the
 * host granted the package. Only then is the call sent, and only for that call may the service ask for the bytes, a
 * bounded range at a time, by sending `clarkcant/artifacts.read` over the stdio connection the host already speaks MCP
 * on. Every read is authorized again against the same instance and principal, so a grant revoked mid-call stops it.
 *
 * The service never receives an id it was not given in a declared field of a call in flight, a path, or a handle. A
 * manifest cannot raise the cap: it names fields, never sizes, and the size is the granted profile's.
 */

export const SERVICE_ARTIFACTS_VERSION = 1;
/** The request a service sends the host for one range of an input artifact's bytes. */
export const SERVICE_ARTIFACTS_METHOD = "clarkcant/artifacts.read";
/** The experimental capability the host advertises in `initialize` when it answers that request. */
export const SERVICE_ARTIFACTS_CAPABILITY = "clarkcant/artifacts";

/** A top-level argument name, as JSON Schema property names in service input schemas are written. */
const argumentNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { error: "must be an argument name of letters, digits or _" });

/**
 * What a capability declaration may say about the files it reads: the arguments that carry artifact ids. Strict and
 * versioned, so a size or a type list is refused when the manifest is read rather than ignored.
 */
export const inputArtifactsDeclarationSchema = z.strictObject({
  version: z.literal(SERVICE_ARTIFACTS_VERSION),
  fields: z
    .array(argumentNameSchema)
    .min(1)
    .max(4)
    .refine((fields) => new Set(fields).size === fields.length, { error: "names each argument once" }),
});
export type InputArtifactsDeclaration = z.infer<typeof inputArtifactsDeclarationSchema>;

/** One read: a range no longer than one bridge chunk, so a service streams a large file rather than taking it whole. */
export const serviceArtifactReadRequestSchema = z.strictObject({
  version: z.literal(SERVICE_ARTIFACTS_VERSION),
  artifactId: artifactIdSchema,
  offset: z.int().nonnegative(),
  length: z.int().min(1).max(ARTIFACT_LIMITS.chunkBytes),
});
export type ServiceArtifactReadRequest = z.infer<typeof serviceArtifactReadRequestSchema>;

/** What the host answers a read with. The bytes are base64, as every other binary on this connection is. */
export interface ServiceArtifactReadResult {
  artifactId: string;
  offset: number;
  bytes: string;
  eof: boolean;
  sizeBytes: number;
  mimeType: string;
}

/** The limits the host offers in `initialize`, from the granted profile, so a service can refuse work early. */
export interface ServiceArtifactsOffer {
  version: typeof SERVICE_ARTIFACTS_VERSION;
  methods: [typeof SERVICE_ARTIFACTS_METHOD];
  /** The longest range one read may ask for. */
  chunkBytes: number;
  /** The largest input artifact; enforced by the host before the call is sent. */
  maxInputBytes: number;
  /** The longest media input in seconds; only the service can read a duration, so the service enforces it. */
  maxMediaSeconds: number;
  /** The largest file a result may carry back in one answer. */
  maxResultBytes: number;
}

/**
 * JSON-RPC error codes the host answers a read with, in the range JSON-RPC leaves to applications and after the egress
 * codes. Each says what the service can do: fix the request, stop asking for an id it was not given, or give up on a
 * file the host no longer lets this call read (a grant revoked or expired, bytes gone).
 */
export const SERVICE_ARTIFACT_ERROR_CODES = {
  invalid: -32602,
  notAnInput: -32020,
  refused: -32021,
} as const;

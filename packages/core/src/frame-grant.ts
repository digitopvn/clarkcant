import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A grant that lets one frame fetch one document.
 *
 * A widget's document is fetched by the browser as a **navigation**, and a navigation cannot carry an
 * `Authorization` header — which is why the frame route answered 401 to the iframe that was supposed to load from it.
 * The two ways out are to serve package files to anybody who asks, or to put a scoped credential in the URL itself.
 * This is the second: it names one instance, it expires, and it is only accepted for the document that instance is a
 * view of.
 *
 * It is not a session credential and must not become one. The token is derived from the node's own secret, carries no
 * principal, and grants nothing except reading one frame's document — a URL leaks into history and referrers, so what
 * travels in one has to be worth nothing to whoever finds it.
 */

export type FrameGrantCheck =
  | { ok: true; instanceId: string; packageId: string; version: string }
  | { ok: false; code: "GRANT_MALFORMED" | "GRANT_TAMPERED" | "GRANT_EXPIRED"; message: string };

export interface FrameGrantInput {
  instanceId: string;
  /**
   * The one package this grant may read.
   *
   * Named in the grant rather than inferred from the instance at verification time, because the check that matters is
   * "may this URL read these bytes" — and answering it from a lookup would make the grant a general permission to
   * read whatever the instance happens to point at later.
   */
  packageId: string;
  version: string;
  /** The node's own secret. Never travels: only the HMAC over the payload does. */
  secret: string;
  expiresAtMs: number;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintFrameGrant(input: FrameGrantInput): string {
  const payload = base64url(
    JSON.stringify({
      instanceId: input.instanceId,
      packageId: input.packageId,
      version: input.version,
      exp: input.expiresAtMs,
    }),
  );
  return `${payload}.${sign(payload, input.secret)}`;
}

export function verifyFrameGrant(input: { grant: string; secret: string; nowMs: number }): FrameGrantCheck {
  const parts = input.grant.split(".");
  const payload = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || payload === undefined || signature === undefined || payload === "" || signature === "") {
    return { ok: false, code: "GRANT_MALFORMED", message: "that is not a frame grant" };
  }

  /*
   * Compared in constant time, and only after the lengths agree: `timingSafeEqual` throws on a length mismatch, and
   * a check that throws on a malformed signature is a check that can be skipped by one.
   */
  const expected = sign(payload, input.secret);
  const presented = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presented.length !== expectedBytes.length || !timingSafeEqual(presented, expectedBytes)) {
    return { ok: false, code: "GRANT_TAMPERED", message: "that frame grant was not issued by this node" };
  }

  let parsed: { instanceId?: unknown; packageId?: unknown; version?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
  } catch {
    return { ok: false, code: "GRANT_MALFORMED", message: "that frame grant is not readable" };
  }
  if (
    typeof parsed.instanceId !== "string" ||
    typeof parsed.packageId !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    return { ok: false, code: "GRANT_MALFORMED", message: "that frame grant is missing what it has to name" };
  }
  if (parsed.exp <= input.nowMs) {
    return { ok: false, code: "GRANT_EXPIRED", message: "that frame grant has expired" };
  }
  return { ok: true, instanceId: parsed.instanceId, packageId: parsed.packageId, version: parsed.version };
}

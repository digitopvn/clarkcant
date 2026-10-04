/**
 * The sentence a provider's refusal actually says.
 *
 * Pi records a refused turn's error as the provider returned it, which for an HTTP API is usually the status followed by
 * the JSON body: `400 {"type":"error","error":{"type":"invalid_request_error","message":"…"},"request_id":"…"}`. A person
 * reading that has to dig for the one sentence that tells them what to do, so the message inside is lifted out and the
 * status kept in front of it. Anything that is not that shape is passed on unchanged rather than guessed at.
 */
export function providerErrorReason(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "no reason given";
  const text = raw.trim();
  const match = /^(\d{3})?:?\s*(\{[\s\S]*\})$/.exec(text);
  if (match === null) return text;
  const [, status, body] = match;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? "");
  } catch {
    return text;
  }
  const message = messageIn(parsed);
  if (message === undefined) return text;
  return status === undefined ? message : `${message} (HTTP ${status})`;
}

/** `error.message`, or a top-level `message`: the two places providers put the sentence meant for people. */
function messageIn(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { error?: unknown; message?: unknown };
  if (typeof record.error === "object" && record.error !== null) {
    const inner = (record.error as { message?: unknown }).message;
    if (typeof inner === "string" && inner.trim() !== "") return inner.trim();
  }
  if (typeof record.error === "string" && record.error.trim() !== "") return record.error.trim();
  return typeof record.message === "string" && record.message.trim() !== "" ? record.message.trim() : undefined;
}

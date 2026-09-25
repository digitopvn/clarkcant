/**
 * Secret-shaped text.
 *
 * One implementation, used by every path that moves text outwards: the selector's request state, a
 * worker's session transcript on its way to disk, and anything written into an index that outlives
 * the conversation it came from. A second copy of this list would drift from the first, and the
 * copy that drifts is the one that stops redacting.
 *
 * The patterns are deliberately broad. Over-redacting a harmless long word costs a slightly worse
 * prompt; missing a credential costs the credential.
 */

/** Ordered so a specific shape wins over the generic ones that would also match part of it. */
export const SECRET_SHAPES: readonly { label: string; pattern: RegExp }[] = [
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/g },
  { label: "prefixed-token", pattern: /\b(?:sk|pk|rk|ghp|gho|npm|xox[baprs]|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/gi },
  {
    label: "named-secret",
    pattern: /(?:access_token|refresh_token|client_secret|api[_-]?key|password)"?\s*[:=]\s*"?[^"\s,}]{6,}/gi,
  },
  // `/` is a base64 character and a path separator. A run that starts a token may carry it, but a run
  // that continues a path or URL (right after `/`, `.`, `-`, `_` or `~`) is judged one segment at a
  // time: a token inside a path is a segment, while `var/folders/f9/<id>/T/app` joined by its
  // separators is only a long path. A path segment of 32+ characters is still redacted by the next shape.
  { label: "base64", pattern: /(?<![A-Za-z0-9+/._~-])\b[A-Za-z0-9+/]{32,}={0,2}\b/g },
  { label: "base64-segment", pattern: /\b[A-Za-z0-9+]{32,}={0,2}\b/g },
  { label: "hex", pattern: /\b[A-Fa-f0-9]{32,}\b/g },
  {
    label: "home-path",
    // An absolute path under a home directory names the person and their private layout. The whole
    // path is replaced rather than just the user segment: the directories below it are often more
    // revealing than the account name.
    pattern: /(?:\/Users\/|\/home\/|\/private\/var\/)[A-Za-z0-9._\-/]+/g,
  },
  { label: "windows-path", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._\\-]+/g },
  { label: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: "phone", pattern: /\b(?:\+?\d[\s-]?){9,}\b/g },
];

/**
 * Replace every secret-shaped run with `[redacted]`.
 *
 * Returns a string of the same general shape rather than a safe copy: a caller that needs a JSON
 * document to stay JSON should validate it afterwards, which is what the transcript rewrite does.
 */
export function redactSecrets(text: string): string {
  let clean = text;
  for (const shape of SECRET_SHAPES) {
    // Each pattern is used with its own flags; the `g` flag is required and `lastIndex` is reset by
    // constructing the replacement per call rather than by reusing a stateful regex.
    clean = clean.replace(new RegExp(shape.pattern.source, shape.pattern.flags), "[redacted]");
  }
  return clean;
}

/** Which shapes still match. Used to refuse sending something rather than sending it redacted. */
export function findSecretShapes(text: string): string[] {
  const found: string[] = [];
  for (const shape of SECRET_SHAPES) {
    const match = new RegExp(shape.pattern.source, shape.pattern.flags.replace("g", "")).exec(text);
    if (match !== null) found.push(`${shape.label}:${match[0].slice(0, 8)}`);
  }
  return found;
}

/** Whether the text carries anything secret-shaped at all. */
export function containsSecretShape(text: string): boolean {
  return findSecretShapes(text).length > 0;
}

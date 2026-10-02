import { z } from "zod";

/**
 * Why a declared network origin is not one a package may reach, or `undefined` when it is.
 *
 * A declared origin ends up verbatim in the widget document's `connect-src`, so anything that is not exactly one
 * origin is a way to rewrite the policy: `https://a *` widens it to everything, `https://a; report-uri …` adds a
 * directive, and `https://*.a` is a wildcard by another name. The shape check comes first and is deliberately
 * narrower than a URL parser, because `URL` accepts `;` inside a host and the policy separator is exactly `;`.
 *
 * Plain `http:` and `ws:` are refused except on loopback: a widget talking to a remote host in clear text is a
 * request nobody should have to consent to.
 */
export function networkOriginProblem(value: string): string | undefined {
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  const shape = new RegExp(`^(?:https|wss|http|ws)://(?:\\[[0-9a-f:.]+\\]|${label}(?:\\.${label})*)(?::[0-9]{1,5})?$`);
  if (!shape.test(value)) {
    return "must be exactly scheme://host[:port]: no wildcard, path, query, credentials, whitespace or separators";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.origin !== value) return `must be written in its canonical form, ${url.origin}`;
  const encrypted = url.protocol === "https:" || url.protocol === "wss:";
  if (!encrypted && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return "must use https or wss unless it is a loopback address";
  }
  return undefined;
}

/** One origin a package may reach, in the exact form a CSP source expression takes. */
export const networkOriginSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => networkOriginProblem(value) === undefined, {
    error: (issue) => `network origin ${JSON.stringify(issue.input)} ${networkOriginProblem(String(issue.input)) ?? "is invalid"}`,
  });

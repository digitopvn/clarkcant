/**
 * A minimal GitHub REST client for the merge-gate tools, on Node's own `fetch`.
 *
 * The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, or from `gh auth token` on a workstation where the GitHub CLI is
 * signed in. It is only ever sent in the Authorization header to api.github.com, and never printed. `fetchImpl` is a
 * parameter so tests can answer requests without the network.
 */
import { execFileSync } from "node:child_process";

const API = "https://api.github.com";

/** The token to call GitHub with, or null to call it anonymously. */
export function resolveToken(env = process.env) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export class GitHubRequestError extends Error {
  constructor(method, path, status, message) {
    super(`${method} ${path} failed with HTTP ${status}: ${message}`);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

/**
 * @param {{token?: string | null, fetchImpl?: typeof fetch}} [options]
 */
export function createGitHubClient({ token = null, fetchImpl = fetch } = {}) {
  /**
   * @param {string} method
   * @param {string} path a path under the API root, starting with `/`
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    if (!path.startsWith("/")) throw new Error(`GitHub API path must start with "/": ${path}`);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clarkcant-merge-gate",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try { message = JSON.parse(text).message ?? message; } catch { /* the raw text is the best message there is */ }
      throw new GitHubRequestError(method, path, response.status, message);
    }
    return text === "" ? null : JSON.parse(text);
  }

  /**
   * Every item of a list endpoint, following pages of 100 up to `limit` items.
   *
   * @param {string} path
   * @param {{limit?: number}} [options]
   */
  async function paginate(path, { limit = 3000 } = {}) {
    const items = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; items.length < limit; page += 1) {
      const batch = await request("GET", `${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GET ${path} did not return a list`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items.slice(0, limit);
  }

  return { request, paginate };
}

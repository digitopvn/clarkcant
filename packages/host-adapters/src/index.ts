import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Host adapters: credential vault and platform capability probes.
 *
 * The vault is a real encrypted store, not a placeholder. Long-lived credentials
 * must never reach the model, the transcript, or an ordinary renderer, so the only
 * interface exposed is "store a named secret" and "use it inside a callback" — there
 * is deliberately no `getSecret()` that returns a plaintext value to a caller, and
 * therefore nothing for a tool to leak by returning it.
 *
 * AES-256-GCM with a scrypt-derived key. The key lives outside the database, so a
 * stolen database backup is not a credential disclosure; that is why the backup
 * manifest has to state that the key was backed up separately.
 */

export interface VaultBackend {
  put(name: string, value: string): void;
  /** Use a secret without exposing it. The callback's return value is the only output. */
  withSecret<T>(name: string, use: (secret: string) => T): T;
  has(name: string): boolean;
  list(): string[];
  delete(name: string): boolean;
}

interface VaultFile {
  version: 1;
  /** name -> base64(iv).base64(tag).base64(ciphertext) */
  entries: Record<string, string>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/**
 * Encrypted vault on the local filesystem.
 *
 * The salt is stored alongside the file rather than derived from the passphrase, so
 * two nodes with the same passphrase produce different keys and a leaked key from one
 * node is useless against another.
 */
export class FileVaultBackend implements VaultBackend {
  readonly #path: string;
  readonly #saltPath: string;
  #cache: VaultFile | undefined;

  constructor(input: { path: string; passphrase: string }) {
    this.#path = input.path;
    this.#saltPath = `${input.path}.salt`;
    this.#passphrase = input.passphrase;
  }

  readonly #passphrase: string;

  #salt(): Buffer {
    if (existsSync(this.#saltPath)) return readFileSync(this.#saltPath);
    mkdirSync(dirname(this.#saltPath), { recursive: true });
    const salt = randomBytes(16);
    writeFileSync(this.#saltPath, salt);
    chmodSync(this.#saltPath, 0o600);
    return salt;
  }

  #key(): Buffer {
    return deriveKey(this.#passphrase, this.#salt());
  }

  #load(): VaultFile {
    if (this.#cache) return this.#cache;
    if (!existsSync(this.#path)) {
      this.#cache = { version: 1, entries: {} };
      return this.#cache;
    }
    // A corrupt vault must fail loudly rather than be treated as empty: silently
    // starting over would look like "no credentials configured" and quietly discard
    // whatever the user had stored.
    const raw = readFileSync(this.#path, "utf8");
    let parsed: VaultFile;
    try {
      parsed = JSON.parse(raw) as VaultFile;
    } catch (cause) {
      throw new Error(
        `the credential vault at ${this.#path} is not valid JSON and cannot be opened. Refusing to treat it as empty. Restore it from a backup before continuing.`,
        { cause },
      );
    }
    this.#cache = parsed;
    return parsed;
  }

  #flush(): void {
    const data = this.#load();
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(data, null, 2)}\n`);
    // Owner-only. File permissions are not a substitute for encryption, but leaving
    // a vault world-readable is still a mistake.
    chmodSync(this.#path, 0o600);
  }

  put(name: string, value: string): void {
    const data = this.#load();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    data.entries[name] = [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
    this.#flush();
  }

  withSecret<T>(name: string, use: (secret: string) => T): T {
    const encoded = this.#load().entries[name];
    if (encoded === undefined) throw new Error(`vault entry ${name} does not exist`);
    const [ivB64, tagB64, dataB64] = encoded.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error(`vault entry ${name} is malformed`);
    const decipher = createDecipheriv("aes-256-gcm", this.#key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return use(plaintext);
  }

  has(name: string): boolean {
    return this.#load().entries[name] !== undefined;
  }

  list(): string[] {
    return Object.keys(this.#load().entries).sort();
  }

  delete(name: string): boolean {
    const data = this.#load();
    if (data.entries[name] === undefined) return false;
    delete data.entries[name];
    this.#flush();
    return true;
  }
}

/** In-memory vault for tests. Never used for real credentials. */
export class MemoryVaultBackend implements VaultBackend {
  readonly #entries = new Map<string, string>();

  put(name: string, value: string): void {
    this.#entries.set(name, value);
  }

  withSecret<T>(name: string, use: (secret: string) => T): T {
    const value = this.#entries.get(name);
    if (value === undefined) throw new Error(`vault entry ${name} does not exist`);
    return use(value);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  list(): string[] {
    return [...this.#entries.keys()].sort();
  }

  delete(name: string): boolean {
    return this.#entries.delete(name);
  }
}

/**
 * Redact anything credential-shaped from a log line.
 *
 * Logs carry task and node identifiers by design; they must not carry tokens. The
 * pattern list is deliberately broad, because a missed redaction is worse than an
 * over-eager one.
 */
export function redactForLog(input: string): string {
  return input
    // A JWT-shaped three-segment base64url string, anchored on `eyJ` (the base64url of
    // `{"`), which is strong evidence without needing a long minimum length. An
    // over-eager redaction is far cheaper than one missed token.
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted-jwt]")
    .replace(/(sk|pk|ghp|gho|npm|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted-token]")
    .replace(/(access_token|refresh_token|client_secret|api[_-]?key|password)"?\s*[:=]\s*"?[^"\s,}]{6,}/gi, "$1=[redacted]");
}

/* ------------------------------------------------------------------ *
 * Platform capability probes
 * ------------------------------------------------------------------ */

export interface PlatformCapabilities {
  os: "macos" | "linux" | "web";
  /** Whether a display server is present. A headless VPS has none. */
  hasDisplay: boolean;
  accessibilityPermission: "granted" | "denied" | "unknown" | "not-applicable";
  screenCapturePermission: "granted" | "denied" | "unknown" | "not-applicable";
  /** Whether an isolation backend (container or VM) is available for untrusted code. */
  isolationBackend: "container" | "vm" | "none";
}

/**
 * Report what this host can genuinely do.
 *
 * The point of this function is to make "I cannot do that here" a first-class answer.
 * A Linux node without a display must not accept a native-desktop task, and a host
 * without an isolation backend must not accept untrusted native code, even though
 * both are technically able to accept the request.
 */
export function probePlatformCapabilities(env: {
  platform: NodeJS.Platform;
  hasDisplayEnv: boolean;
  containerRuntimeAvailable: boolean;
}): PlatformCapabilities {
  const os = env.platform === "darwin" ? "macos" : env.platform === "linux" ? "linux" : "web";
  return {
    os,
    hasDisplay: os === "macos" ? true : env.hasDisplayEnv,
    // macOS permissions cannot be read without triggering a system prompt, so the
    // honest value is "unknown" until the driver actually tries.
    accessibilityPermission: os === "macos" ? "unknown" : "not-applicable",
    screenCapturePermission: os === "macos" ? "unknown" : "not-applicable",
    isolationBackend: env.containerRuntimeAvailable ? "container" : "none",
  };
}

/**
 * Whether a driver pack may be used on this host.
 *
 * @status-ref host-adapters.platform-capabilities
 * TODO(P3): real macOS TCC permission queries and a rootless-container capability
 * check. The capability shape and the refusal logic are implemented; reading actual
 * permission state needs a signed bundle and a real desktop session.
 */
export function driverUsable(
  capabilities: PlatformCapabilities,
  driver: "browser-playwright" | "computer-macos" | "computer-linux-desktop",
): { usable: true } | { usable: false; reason: string } {
  if (driver === "computer-macos" && capabilities.os !== "macos") {
    return { usable: false, reason: "the macOS native driver cannot run on this host's operating system" };
  }
  if (driver === "computer-linux-desktop" && !capabilities.hasDisplay) {
    return {
      usable: false,
      reason: "no display server is present, so the virtual-desktop driver would have nothing to present",
    };
  }
  if (driver === "computer-macos" && capabilities.accessibilityPermission === "denied") {
    return { usable: false, reason: "Accessibility permission was denied for this application" };
  }
  return { usable: true };
}

import { buildEnvironment, BUILTIN_PROFILES, type ExecutionProfile } from "@clarkcant/execution-supervisor";
import { PROVIDER_KEY_VARIABLES } from "@clarkcant/pi-adapter";

/**
 * What a child process of this node inherits.
 *
 * Filtered by where a variable came from, not by who opened the child. A terminal has two drivers — the model can type
 * into a shell the person opened, and the person can take over a shell the model opened — so "a terminal the person
 * opened may see everything" would hand the model every key the node holds one keystroke later. Redacting output only
 * hides a key from the model's reading; it does not stop `curl -H "Authorization: $KEY" …` from sending it.
 *
 * Two rules, one per kind of child:
 *
 *   - **A terminal** keeps the environment it would have had anyway, minus the names this node put there itself:
 *     what `.env` loaded, the provider keys, and any secret the broker serves from the environment. The shell sources
 *     the person's own rc file, so whatever they export there is back in the shell; the only thing removed is what
 *     they never put in it.
 *   - **A command the model runs** (`run_command`) gets a strict allowlist, plus exactly the secret the broker granted
 *     that one command. Nobody is sitting in front of it, so nothing the command was not given should be reachable.
 */

/**
 * Provider credentials the node reads, by the names it reads them under.
 *
 * Withheld from every child whether or not this node configured them: a key in the environment is a key the node
 * could use, and one the person wanted in a shell is one their rc file puts there.
 */
const NODE_CREDENTIAL_VARIABLES: readonly string[] = [
  ...Object.values(PROVIDER_KEY_VARIABLES),
  "TYPESAFE_API_KEY",
  "GEMINI_API_KEY",
];

/**
 * What a model-run command may see.
 *
 * The session basics a command needs to behave like a command — where programs are, whose home it is, which language
 * and terminal — and nothing that authenticates. `SSH_AUTH_SOCK` is deliberately absent, as it is from every
 * execution profile: a command that needs a credential gets it from the broker, for that command, by name.
 */
export const COMMAND_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "CI",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // Windows needs these to start a shell at all; they name directories, not credentials.
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

/** The build profile's limits with this allowlist: `buildEnvironment` is the one function that forwards by allowlist. */
const COMMAND_PROFILE: ExecutionProfile = {
  ...(BUILTIN_PROFILES.build as ExecutionProfile),
  envAllowlist: [...COMMAND_ENV_ALLOWLIST],
};

const withheldSources: (() => Iterable<string>)[] = [];

/**
 * Register names this node put into its own environment, read each time a child starts.
 *
 * A function rather than a list, because some of the answer changes while the node runs: a secret stored with the
 * `environment` backend after boot is withheld from the next shell without a restart.
 */
export function withholdFromChildren(names: () => Iterable<string>): () => void {
  withheldSources.push(names);
  return () => {
    const index = withheldSources.indexOf(names);
    if (index >= 0) withheldSources.splice(index, 1);
  };
}

/** Every name no child inherits, right now. */
export function withheldVariables(): ReadonlySet<string> {
  const names = new Set<string>(NODE_CREDENTIAL_VARIABLES);
  for (const source of withheldSources) {
    try {
      for (const name of source()) if (name !== "") names.add(name);
    } catch {
      // A source that cannot answer withholds nothing extra; the fixed list above still applies.
    }
  }
  return names;
}

/** A terminal's environment: everything this process has, except what the node itself put there. */
export function terminalEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  withheld: ReadonlySet<string> = withheldVariables(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !withheld.has(key)) env[key] = value;
  }
  return env;
}

/**
 * A model-run command's environment: the allowlist, plus the variables the broker granted this one command.
 *
 * The grant is applied last and is never filtered: it is the one secret this command was cleared to use, and removing
 * it would turn an approved credential into a failure nobody can explain.
 */
export function commandEnvironment(
  granted: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return { ...buildEnvironment(COMMAND_PROFILE, source), ...granted };
}

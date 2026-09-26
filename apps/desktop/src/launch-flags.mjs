/**
 * Launch flag parsing for the desktop shell.
 *
 * Both `--name value` and `--name=value` are read. The second form is not a nicety: Electron exits at startup
 * when an argument that looks like a URL is followed by another switch — its guard against a protocol handler
 * smuggling switches in after a link — so `--renderer-url http://… --data-dir …` never opens a window, and
 * `--renderer-url=http://… --data-dir=…` is the only way to pass a URL and anything after it.
 *
 * Answers undefined when the flag is absent or has no value, so a caller's default applies.
 */
export function readFlag(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      return value === "" ? undefined : value;
    }
    if (argument === `--${name}`) {
      const value = argv[index + 1];
      return value === undefined || value.startsWith("--") ? undefined : value;
    }
  }
  return undefined;
}

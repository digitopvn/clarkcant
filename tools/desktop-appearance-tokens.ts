/**
 * The desktop shell page's copy of the appearance tokens.
 *
 * The desktop window draws the conversation with the web client, so every theme, recipe and effect reaches the
 * normal, expanded, compact and orb modes through the same compiled sheet the browser uses. The shell's own page
 * (`apps/desktop/src/shell.html`, shown when no renderer is given) has no bundler, so it cannot import that sheet: it
 * links a file written from Clark Default's compiled tokens instead, and `shell.css` reads only `--cc-*` names from it.
 * One source, no second theme system - and a test holds the file to what this module writes.
 *
 * Regenerate after a token change with `node tools/desktop-appearance-tokens.ts --write`.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { themeStylesheet } from "../packages/design-tokens/src/index.ts";

/** Where the shell page links the tokens from. */
export const DESKTOP_TOKENS_FILE = fileURLToPath(new URL("../apps/desktop/src/appearance-tokens.css", import.meta.url));

const HEADER = `/*
 * Generated from @clarkcant/design-tokens (Clark Default). Do not edit by hand:
 * run \`node tools/desktop-appearance-tokens.ts --write\` after changing a token.
 */
`;

/** The file's exact contents: Clark Default's compiled sheet, both schemes and reduced motion included. */
export function desktopAppearanceTokens(): string {
  return `${HEADER}${themeStylesheet()}\n`;
}

if (process.argv.includes("--write")) {
  writeFileSync(DESKTOP_TOKENS_FILE, desktopAppearanceTokens(), "utf8");
  process.stdout.write(`wrote ${DESKTOP_TOKENS_FILE}\n`);
}

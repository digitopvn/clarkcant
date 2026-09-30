import { readFileSync } from "node:fs";

import { IDENTITY_VARIABLES } from "@clarkcant/design-tokens";
import { describe, expect, it } from "vitest";

import { DESKTOP_TOKENS_FILE, desktopAppearanceTokens } from "../../../tools/desktop-appearance-tokens.ts";

/**
 * The desktop shell page draws with the same tokens as the web client.
 *
 * The desktop window renders the conversation with the web client, so its modes follow the theme by construction. The
 * shell's own page is the one surface outside that bundle, and these tests are what keep it from becoming a second
 * theme system: its token file is exactly what the design-token compiler writes, and its stylesheet names nothing but
 * those tokens.
 */

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const SHELL_CSS = read("../src/shell.css");
const TOKENS = read("../src/appearance-tokens.css");

/** The stylesheet without its comments, so prose that names a colour does not count as a declaration. */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the desktop shell page's tokens", () => {
  it("are exactly the compiled Clark Default sheet", () => {
    // Regenerate with `node tools/desktop-appearance-tokens.ts --write` when a token changes.
    expect(TOKENS).toBe(desktopAppearanceTokens());
    expect(DESKTOP_TOKENS_FILE.replace(/\\/g, "/")).toMatch(/apps\/desktop\/src\/appearance-tokens\.css$/);
  });

  it("are linked before the shell's stylesheet, from the page's own origin", () => {
    const html = read("../src/shell.html");
    const tokens = html.indexOf('href="appearance-tokens.css"');
    const shell = html.indexOf('href="shell.css"');
    expect(tokens).toBeGreaterThan(-1);
    expect(shell).toBeGreaterThan(tokens);
    // The attribute the compiled sheet selects a scheme by, present before any script runs.
    expect(html).toMatch(/<html [^>]*data-cc-theme="dark"/);
  });

  it("leave the shell stylesheet no colour, radius or custom property of its own", () => {
    const css = declarations(SHELL_CSS);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/i);
    expect(css).not.toMatch(/border-radius:\s*\d/);
    // Declaring a variable here would be a private palette again.
    expect(css).not.toMatch(/(?:^|[;{\s])--[\w-]+\s*:/m);
  });

  it("names only tokens the compiler writes, or identity a theme may set", () => {
    const written = new Set([...TOKENS.matchAll(/(--cc-[\w-]+)\s*:/g)].map((match) => match[1]));
    const identity = new Set<string>(IDENTITY_VARIABLES);
    const named = [...declarations(SHELL_CSS).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1] ?? "");
    expect(named.length).toBeGreaterThan(10);
    for (const name of named) {
      expect(written.has(name) || identity.has(name), name).toBe(true);
    }
    // The protected focus token is what draws the ring.
    expect(SHELL_CSS).toMatch(/:focus-visible\s*\{[^}]*var\(--cc-focus\)/);
  });
});

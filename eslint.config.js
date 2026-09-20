// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.data/**",
      "scripts/**",
      "docs/**",
      "plans/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Node strips types without transforming syntax that has runtime semantics.
      // `enum`, `namespace`, and constructor parameter properties would break
      // direct `node file.ts` execution, so they are banned repo-wide.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "Node type-stripping cannot execute enums. Use a const object + union type.",
        },
        {
          selector: "TSModuleDeclaration",
          message:
            "Node type-stripping cannot execute namespaces. Use explicit modules.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
          // `typeof import("pkg")` is how a dynamically imported module is typed,
          // and unlike a `require()` it has no runtime equivalent to consolidate.
          disallowTypeAnnotations: false,
        },
      ],
      // Stubs must be explicit rather than silently empty.
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // Node scripts and config files run in a Node global scope that the ECMAScript
    // recommended preset does not declare.
    files: ["**/*.mjs", "tools/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        // A Node global since 18, and the only way this process reaches the node it serves: the detached
        // window's relay calls it with the host's own token.
        fetch: "readonly",
      },
    },
  },
  {
    // The desktop renderer runs in a browser context, not Node. It is the one .mjs file in the
    // repository that must not be handed Node globals, and it needs the DOM ones instead.
    files: ["apps/desktop/src/shell.mjs"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
      },
    },
  },
  {
    /*
     * A widget's own scripts, which run in a sandboxed frame rather than in Node or in this app.
     *
     * They are the one kind of JavaScript in this repository that is neither: it is served to a frame, executed by a
     * browser, and written against the DOM. Linting it with Node globals reported every `document` and `window`
     * reference as undefined — which is what a widget is made of.
     */
    files: ["**/widgets/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        setTimeout: "readonly",
        crypto: "readonly",
        CustomEvent: "readonly",
      },
    },
  },
  {
    // The pre-paint theme script is served to the browser as-is from `public/`, so it runs with
    // browser globals and is never bundled. Linting it against the Node globals the other `.js`
    // files get would report every DOM reference as undefined.
    files: ["apps/web/public/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        localStorage: "readonly",
        matchMedia: "readonly",
      },
    },
  },
  {
    // A sandboxed Electron preload script cannot be an ES module, so this file is CommonJS
    // because the runtime requires it, not by preference.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/test/**/*.ts", "**/test/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);

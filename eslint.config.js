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
      },
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

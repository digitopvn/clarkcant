import { defineConfig } from "vitest/config";
import sharedConfig from "./vitest.config.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ["packages/widget-cli/test/dev-host.spec.ts"],
    exclude: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
});

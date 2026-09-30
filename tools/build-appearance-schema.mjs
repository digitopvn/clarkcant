import { writeFileSync } from "node:fs";
import { appearanceSnapshotSchema } from "../packages/contracts/src/themes.ts";

// Electron does not load stripped TypeScript. Generate its read-only boundary from the canonical contract.
writeFileSync(new URL("../apps/desktop/src/appearance-schema.json", import.meta.url),
  `${JSON.stringify(appearanceSnapshotSchema.toJSONSchema(), null, 2)}\n`);

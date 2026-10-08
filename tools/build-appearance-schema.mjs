import { writeFileSync } from "node:fs";
import { appearanceSnapshotSchema } from "../packages/contracts/src/themes.ts";
import { widgetPerformReportSchema, widgetPerformRequestSchema } from "../packages/contracts/src/widget-perform.ts";
import { semanticProposalSchema } from "../packages/contracts/src/widget-semantic.ts";

// Electron does not load stripped TypeScript. Generate its read-only boundaries from the canonical contracts; a test in
// `apps/desktop/test/detached-window.spec.ts` holds each file equal to its contract.
const write = (name, schema) =>
  writeFileSync(new URL(`../apps/desktop/src/${name}`, import.meta.url), `${JSON.stringify(schema.toJSONSchema(), null, 2)}\n`);

write("appearance-schema.json", appearanceSnapshotSchema);
// What a detached window may relay for its frame's `semantic.publish`.
write("semantic-proposal-schema.json", semanticProposalSchema);
// What the conversation may hand the host for a detached instance, and what the detached window may report back.
write("widget-perform-request-schema.json", widgetPerformRequestSchema);
write("widget-perform-report-schema.json", widgetPerformReportSchema);

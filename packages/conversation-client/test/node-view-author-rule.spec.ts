import { readFileSync } from "node:fs";

import {
  attachmentRefSchema,
  composerSuggestionsResponseSchema,
  effectReconcileResponseSchema,
  inboxResponseSchema,
  inboxSummarySchema,
  memoryListSchema,
  memoryRecordSchema,
  noticeOperationResponseSchema,
  noticeSchema,
  suggestionSchema,
  suggestionsResponseSchema,
  widgetDevSessionViewSchema,
} from "@clarkcant/contracts";
import { jobSnapshotWireSchema } from "@clarkcant/widget-sdk";
import { describe, expect, it } from "vitest";

/**
 * The author rule behind reading a node's answers tolerantly: a field this app does not know is dropped only at the top
 * level of a view, so binding state (an approval, a grant, what Clark may reach, an activation, a confirmation) must never
 * be added there, or an older app would drop it with only a note. It goes inside an object, which stays strict.
 *
 * Pinned two ways. Every schema the client reads tolerantly is listed here, so a new tolerant read is reviewed against
 * the rule. And every top-level field of those schemas whose name speaks of binding state is listed with why it is
 * allowed there, so adding one fails until someone decides it may. `docs/open-interfaces.md` ("Reading a node's
 * answers") is the prose of the same list.
 */

const TOLERANT: Record<string, { shape: Record<string, unknown> }> = {
  inboxResponseSchema,
  noticeSchema,
  inboxSummarySchema,
  noticeOperationResponseSchema,
  effectReconcileResponseSchema,
  memoryListSchema,
  memoryRecordSchema,
  suggestionsResponseSchema,
  suggestionSchema,
  composerSuggestionsResponseSchema,
  attachmentRefSchema,
  jobSnapshotWireSchema,
  widgetDevSessionViewSchema,
};

const BINDING_NAME = /approv|grant|permission|capabilit|reach|activation|consent|confirm|digest|token|waiting|decision/i;

/** Each top-level field that sounds binding, and why it may sit where a newer sibling is dropped. */
const ALLOWED: Record<string, string> = {
  "inboxResponseSchema.waiting": "the waiting items are read item by item and strictly; an item with a new field is left out and counted",
  "inboxSummarySchema.waiting": "a count for the header mark; nothing is decided from it",
  "noticeSchema.reachChange": "a strict object: a new field inside it leaves the notice out",
  "noticeOperationResponseSchema.approvalId": "names the approval an update waits for; the person decides it from the inbox's strict waiting item",
  "noticeOperationResponseSchema.pendingCapabilities": "a count the sentence reports; granting happens elsewhere",
  "noticeOperationResponseSchema.deniedCapabilities": "a count the sentence reports; granting happens elsewhere",
  "widgetDevSessionViewSchema.activation": "a strict union: a new field inside it refuses the view",
};

describe("the author rule for a node's views", () => {
  it("lists every schema the client reads tolerantly", () => {
    const source = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const read = new Set([...source.matchAll(/readNodeView(?:List)?\(\s*(\w+)/g)].map((match) => match[1]));
    expect([...read].sort()).toEqual(Object.keys(TOLERANT).sort());
  });

  it("puts no new binding state at the top level of a view read tolerantly", () => {
    const binding = Object.entries(TOLERANT).flatMap(([name, schema]) =>
      Object.keys(schema.shape)
        .filter((field) => BINDING_NAME.test(field))
        .map((field) => `${name}.${field}`),
    );
    expect(binding.sort()).toEqual(Object.keys(ALLOWED).sort());
  });
});

# Browser proof, docs, and delivery

## Context

- Plan: `plan.md`
- Product source: `docs/widget-development.md` and `docs/conformance-traceability.md`
- Official docs: `digitopvn/clarkcant-web` CLI pages in English and Vietnamese

## Requirements

- Exercise semantic publish and event input/output through `clark widget dev` in a browser.
- Cover truncation/dropped fields, update delta, event handler output, and refusal of undeclared/malformed input.
- Update the internal authoring guide in English and Vietnamese and the English conformance ledger.
- Update official web CLI docs in both languages only after the feature PR merges.

## Validation

Run the dev-host browser journey, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, plan validation, and required PR CI including Windows.

## Rollback

Revert the simulator and conformance changes together if the browser journey reveals a mismatch with runtime contracts; preserve existing widget bridge behavior.

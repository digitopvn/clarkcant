# Phase 02 (E): conditional instructions

## Context

Instructions reach a turn today as the person's own instructions (system prompt) and as `/skill` references the person
names. Nothing activates guidance from state, such as "writing under `packages/storage/**` must follow the migration
policy", and nothing keeps such guidance present after a recap or compaction.

## Requirements

- Source: `<project>/.clarkcant/instructions.json` (`{ "rules": [{ "when": {...}, "include": [...], "pin"?: bool }] }`)
  and snippets `<project>/.clarkcant/instructions/<name>.md`. Only projects inside the node's approved roots; names
  `[a-z0-9-]`, no traversal. Bounded: 32 rules, 8 includes per rule, 4,000 characters per snippet, 6,000 per turn.
- Conditions (all present ones must hold): `project`, `path` (glob over the project-relative path), `operation`
  (`read | write | command | test | deploy`), `capability` (tool or capability name), `role`
  (`foreground | background | task`), `skill` (a skill the message references).
- Foreground: state = what the session's tool calls touched (path + operation, bounded) plus referenced skills. At turn
  start, pinned instructions whose condition holds are re-stated every turn; unpinned ones once per session. A tool call
  that newly activates an instruction gets it appended to its result, labelled with its source.
- Task workers: evaluated once at dispatch from the task's roots, its write scope and role `task`; added to the brief.
- Framed as project instructions with their source path, after the person's words, in the brief section; they grant
  nothing. Pass the phase 01 ceiling (an instruction classified above the model's ceiling is withheld).
- `CLARKCANT_CONDITIONAL_INSTRUCTIONS=off` disables all of it.

## Files

- `apps/runtime/src/conditional-instructions.ts` (new) + spec; `model-turn.ts`; `bootstrap/model-bootstrap.ts`;
  `task-dispatch.ts`; `apps/worker/src/index.ts` (brief field).

## Validation

`pnpm exec vitest run apps/runtime/test/conditional-instructions.spec.ts apps/runtime/test/model-turn*.spec.ts apps/worker`.

## Risk and rollback

A cloned repository can carry instructions, the same trust as its `AGENTS.md`; they only shape text and the execution
policy still decides every effect. Rollback: `CLARKCANT_CONDITIONAL_INSTRUCTIONS=off`.

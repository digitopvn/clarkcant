---
title: "Phase 2 — Execution policy resolver (~10h)"
status: done
---

# Phase 2 — Execution policy resolver (~10h)

### Mục tiêu

Làm `Autonomous | Guarded | Ask every time` thành behavior thật ở runtime, không chỉ Settings UI.

### Files

- new: `packages/core/src/execution-policy.ts`
- update: `packages/core/src/index.ts`
- update: `apps/runtime/src/node-tools.ts`
- update: `apps/runtime/src/run-command.ts`
- update: `packages/core/src/widget-service.ts`
- update: install activation/proposal seam
- update: approval host-card copy/tests

### Core contract

```ts
type ExecutionMode = "autonomous" | "guarded" | "ask";

type PolicyDecision =
  | { kind: "execute"; reason: string; audit: true }
  | { kind: "ask"; reason: string; approvalSpec: ApprovalSpec }
  | { kind: "deny"; reason: string };

decideExecution({
  principal,
  explicitUserIntent,
  effectCategory,
  operationDigest,
  mode,
  configuredRules,
  hardBoundary
});
```

### Rules

- local view action never asks.
- Autonomous: explicit user intent may execute effect without second confirmation.
- Guarded: use effect category + user rules.
- Ask: existing approval path.
- Hard OAuth/TCC/browser/vendor boundaries never auto-bypassed.
- Operation digest, binding digest, stale revision, grants, credential locality, deadlines and dedup stay enforced in all modes.
- Every autonomous effect writes audit/activity evidence.
- Do not duplicate resolver logic in tools/widgets/install.

### Refactor `run_command`

Current tool always says “sau khi bạn duyệt”. Change prompt/label dynamically according to policy capability or make tool wording policy-neutral:

> Run one bounded shell command according to the user's execution policy.

Tool execute:
1. resolve cwd + guard;
2. build canonical operation;
3. call policy resolver;
4. execute / produce approval card / deny.

### Tests

Matrix: 3 modes × read/local-write/external-write/destructive × explicit/not-explicit × hard boundary.

Regression: Ask mode produces same approval digest behavior as current code.

---

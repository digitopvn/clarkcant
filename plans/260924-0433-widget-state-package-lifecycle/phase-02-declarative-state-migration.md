# Migration khai báo do host chạy

Trạng thái: chờ.

## Yêu cầu

1. Contract `stateMigrations: [{from, to, ops}]`, `to = from + 1`, op trong tập đóng: `rename {from,to}`, `default {key,value}`, `remove {key}`, `map {key, values}`.
2. Core `compileStateMigrations(definition)` → `StateMigration[]` dùng lại `migrateInstanceStateReported` (một transaction, hỏng thì giữ nguyên row).
3. Live route: `state_version < definition.stateVersion` ⇒ migrate trước khi trả state; hỏng ⇒ `stateStatus: {kind: "migration-failed", …}`, frame mount chỉ đọc, route ghi từ chối `STATE_READ_ONLY`, UI nói dữ liệu được giữ và người dùng có thể quay về bản trước. `state_version > definition.stateVersion` (sau quay về) ⇒ chỉ đọc, không migrate xuống.
4. Kết quả migrate phải qua `stateSchema`; không qua thì coi như migrate hỏng.
5. Conformance `lifecycle.stateMigration`: chạy migration thật trên `fixtures/state-v{N-1}.json`, validate kết quả theo `stateSchema`; `clark widget init` giữ `stateVersion: 0` (không cần fixture).

## Files

`packages/contracts/src/widgets.ts`, `packages/core/src/widget-state.ts`, `apps/runtime/src/routes/conversations.ts`, `packages/widget-cli/src/conformance.ts`, test.

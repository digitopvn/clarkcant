---
phase: 10
title: "Memory record bền vững và tool remember"
status: done
priority: P1
effort: "6h"
dependencies: []
---

# Phase 10: Memory record bền vững và tool `remember`

## Context Links

- Issue #17 §5 "Tab Memory trong Settings" — "một turn ghi nhớ điều gì đó"
- `docs/system-architecture.md` §7.2 — Memory & Search là service dùng chung; corpus là `messages`/summaries + session JSONL
- `docs/scope-lock.md` §Personalization — "không hidden memory"
- `packages/storage/src/migrate.ts:872` — migration 16 `credentials` là bản cuối
- `apps/runtime/src/node-tools.ts:39-75` — `createNodeTools`, `ToolDefinition.execute(params)` **chỉ** nhận params
- `apps/runtime/src/model-turn.ts:450,465` — `extraTools?: () => readonly ToolDefinition[]` **không** có ngữ cảnh lượt; `:579` `turnFor(conversationId, principal)` có `conversationId` trong scope
- `apps/runtime/src/main.ts:378` — nơi dựng `extraTools`
- `packages/contracts/src/redaction.ts` — redaction dùng chung trước khi persist

## Goal

ClarkCant ghi nhớ được một điều trong lúc trò chuyện, điều đã nhớ **nhìn thấy được** kèm nguồn, và xoá
thì nó **không còn được đưa vào lượt sau**. Không tạo store search thứ hai.

## Ranh giới với Memory & Search (ghi vào doc-comment đầu file)

`memory_records` là **bản ghi do người dùng/agent chủ động nhớ**, không phải một index tìm kiếm thứ hai.
Retrieval vẫn là `history_fts`. Xoá một bản ghi memory xoá **đường inject**: bản ghi không còn được chèn
vào ngữ cảnh của lượt sau. Nội dung gốc trong lịch sử hội thoại **vẫn còn**, vì đó là tin nhắn của chính
người dùng và họ nhìn thấy nó trong timeline — giữ lại nó không phải hidden memory. Khác biệt này được
ghi vào docs ở Phase 12 để không ai đọc "xoá" thành "xoá khỏi mọi nơi".

## Files to Create / Modify

- Create: `packages/contracts/src/memory.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/storage/src/migrate.ts` (migration **18** `memory-records`)
- Modify: `packages/storage/src/repositories.ts` (5 hàm memory)
- Create: `apps/runtime/src/memory.ts` (`rememberMemory`, `listMemories`, `deleteMemory`, `memoryBrief`)
- Create: `apps/runtime/test/memory.spec.ts`
- Modify: `apps/runtime/src/node-tools.ts` (tool `remember`, nhận `memory` deps)
- Modify: `apps/runtime/src/model-turn.ts` (đổi chữ ký `extraTools` để mang `conversationId`; chèn brief)
- Modify: `apps/runtime/src/main.ts` (truyền `context.conversationId` vào `createNodeTools`)
- Modify: `apps/runtime/src/gateway.ts` (`GET /memory`, `DELETE /memory/:id`)

## Tests Before (viết trước, phải đỏ)

`apps/runtime/test/memory.spec.ts`:

1. `"a remembered preference is stored with the conversation it came from"` — `conversation_id` khớp.
2. `"a secret in remembered text is redacted before it is persisted"` — đọc **DB thô**, khẳng định giá
   trị gốc không xuất hiện.
3. `"memories are grouped by kind and sorted newest first"`.
4. `"a deleted memory is not returned by the brief for a later turn"` — xoá rồi gọi `memoryBrief`; chuỗi
   đã xoá **không** có trong output.
5. `"deleting a memory twice is not an error"`.
6. `"an empty store produces an empty brief rather than a placeholder line"` — trả `""`.
7. `"the brief is bounded in rows and in characters"` — 60 record → brief ≤ 12 dòng và ≤ 4000 ký tự,
   kèm dòng nói phần bị lược.
8. `"the remember tool refuses an empty or oversized memory"`.
9. `"extraTools is built with the conversation of the turn"` — `model-turn` truyền `conversationId`.
10. `"a memory with a conversation scope is only used in that conversation"`.

## Tasks & Steps

### Task 10.1 — Contract memory

- **Goal**: hình dạng dữ liệu cho một điều đã nhớ.
- **Target files and symbols**: `packages/contracts/src/memory.ts` —
  `memoryKindSchema = z.enum(["preference","project-fact","decision"])`,
  `memoryScopeSchema = z.enum(["node","conversation"])`,
  `memoryRecordSchema` (strictObject: `memoryId`, `kind`, `scope`, `text`, `sourceMessageId?`,
  `sourceConversationId`, `at`), `MEMORY_TEXT_MAX_CHARS = 2000`, `MEMORY_BRIEF_MAX_ROWS = 12`,
  `MEMORY_BRIEF_MAX_CHARS = 4000`.
- **Steps**:
  1. Schema giới hạn độ dài; redaction là việc của runtime.
  2. Export từ `index.ts`.
- **Success criteria**: `pnpm exec tsc -p tsconfig.json` xanh.
- **Verify**: `pnpm exec tsc -p tsconfig.json` exits 0.

### Task 10.2 — Migration 18 và repository

- **Goal**: memory có chỗ ở bền vững; xoá là xoá thật.
- **Target files and symbols**: `packages/storage/src/migrate.ts` (append `version: 18`, `name: "memory-records"`),
  `packages/storage/src/repositories.ts`.
- **Steps**:
  1. `CREATE TABLE memory_records (memory_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL, source_message_id TEXT, kind TEXT NOT NULL, scope TEXT NOT NULL,
     text TEXT NOT NULL, created_at TEXT NOT NULL)` +
     `CREATE INDEX memory_records_principal ON memory_records(principal_id, created_at DESC)`.
  2. Repository: `insertMemoryRecord`, `listMemoryRecords({ principalId, kind?, scope? })`,
     `getMemoryRecord`, `deleteMemoryRecord(db, principalId, memoryId): boolean`,
     `memoryRecordsForBrief(db, principalId, conversationId, limit)`.
  3. **Xoá cứng** (`DELETE`), không soft-delete: một cột `deleted_at` sẽ buộc mọi đường đọc phải nhớ lọc.
- **Success criteria**: `pnpm exec vitest run packages/storage/test/storage.spec.ts` xanh.
- **Verify**: `pnpm exec vitest run packages/storage/test/storage.spec.ts` exits 0.

### Task 10.3 — Runtime memory service

- **Goal**: một chỗ ghi/đọc/xoá, redaction trước persist, brief bị chặn trần.
- **Target files and symbols**: `apps/runtime/src/memory.ts` —
  `rememberMemory(deps, input): MemoryRecord | { refused: string }`,
  `listMemories(deps, principalId)`, `deleteMemory(deps, principalId, memoryId): boolean`,
  `memoryBrief(deps, { principalId, conversationId }): string`.
- **Steps**:
  1. Redaction: dùng đúng hàm trong `packages/contracts/src/redaction.ts`; **không** tự viết regex mới.
  2. `memoryBrief` trả chuỗi bắt đầu `[Điều đã ghi nhớ cho người dùng này]`, mỗi dòng `- (kind) text`;
     rỗng → `""` (không trả khối rỗng).
  3. Trần: tối đa `MEMORY_BRIEF_MAX_ROWS` dòng và `MEMORY_BRIEF_MAX_CHARS` ký tự; phần bị cắt ghi
     `[còn <n> điều đã ghi nhớ khác]`. Đây là chỗ bản trước sai: brief cũ có thể tới 20 × 2000 ký tự mỗi lượt.
  4. Chỉ lấy record `scope: "node"` **hoặc** `scope: "conversation"` khớp conversation hiện tại.
  5. `memoryBrief` đọc DB mỗi lượt, **không** cache trong tiến trình, để một lần xoá có hiệu lực ngay ở
     lượt kế tiếp. Comment nêu lý do.
- **Success criteria**: test 2–7, 10 xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/memory.spec.ts` exits 0.

### Task 10.4 — Tool `remember` và ngữ cảnh lượt

- **Goal**: agent ghi nhớ được, và nguồn của điều đã nhớ đến từ lượt chứ không từ tham số model điền.
- **Target files and symbols**: `apps/runtime/src/node-tools.ts`, `apps/runtime/src/model-turn.ts:450`,
  `apps/runtime/src/main.ts:378`.
- **Steps**:
  1. Đổi `extraTools?: () => readonly ToolDefinition[]` thành
     `extraTools?: (context: { conversationId: string }) => readonly ToolDefinition[]`;
     `readExtraTools()` (dòng ~465) gọi với `{ conversationId }` — biến này có trong scope của
     `turnFor(conversationId, principal)`.
  2. `main.ts:378` nhận `context` và truyền `context.conversationId` vào `createNodeTools`.
  3. `createNodeTools` nhận thêm `memory: { db; principalId; now; conversationId }`; `remember` gọi
     `rememberMemory` với `conversationId` đó. `sourceMessageId` chỉ ghi khi lượt biết id tin nhắn;
     không biết thì để trống và test chỉ khẳng định `conversation_id`.
  4. `apps/runtime/test/node-tools.spec.ts`: danh sách tool có `remember`; thêm test chữ ký mới.
  5. `model-turn.ts`: chèn `memoryBrief` vào ngữ cảnh trước khi gọi adapter, chỉ khi không rỗng — cùng
     cách `attachmentBrief` được ghép ở Phase 3.
- **Success criteria**: test 1, 8, 9 xanh; `node-tools.spec.ts` xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/memory.spec.ts apps/runtime/test/node-tools.spec.ts` exits 0.

### Task 10.5 — Route đọc và xoá

- **Goal**: UI có đường đọc và đường xoá, không cần quyền mới.
- **Target files and symbols**: `apps/runtime/src/gateway.ts` — `GET /memory`, `DELETE /memory/:id`.
- **Steps**:
  1. `GET /memory` → `{ items, counts: { preference, "project-fact", decision } }`; principal từ token.
  2. `DELETE /memory/:id` → 404 `RESOURCE_NOT_FOUND` khi không có **hoặc** không thuộc principal (giống
     nhau, để không dò được); `200 { ok: true, deleted }` khi xoá được.
  3. Không trả `principal_id`; `source_conversation_id` chỉ trả như một id opaque để hiển thị nguồn.
- **Success criteria**: test route xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/memory.spec.ts` exits 0.

## Refactor

Nếu `memoryBrief` cần biết nhiều về định dạng prompt, tách `formatMemoryLine(record)` để test riêng.
Chạy lại **cùng** test.

## Tests After

`"a memory written for one principal is invisible to another"`.

## Regression gate

```bash
pnpm verify
```

## Failure Protocol

Nếu bất kỳ bước Verify nào không đạt đúng điều kiện đã ghi, DỪNG phase này.
Không tự sửa kiểu đoán, không retry mù, không suy luận vòng qua thất bại.
Gọi subagent `kongming` để xin chỉ dẫn bước kế tiếp và truyền:
- phase và task id,
- những gì đã làm (các bước đã chạy),
- đúng lệnh đã chạy và toàn bộ output,
- điều kiện pass mà nó không đạt.
Áp dụng chỉ dẫn của kongming rồi chạy lại bước Verify.
Nếu không gọi được `kongming` trong môi trường này, DỪNG và báo lại đúng bằng chứng thất bại cho
người dùng. Không bao giờ tiếp tục bằng cách tự suy luận.

## Risk Assessment

- **Rủi ro**: memory thành hồ sơ hành vi ngầm. **Giảm thiểu**: chỉ ghi khi người dùng nói điều bền vững
  hoặc agent gọi tool với text người dùng nhìn thấy; mọi bản ghi hiện trong tab Memory kèm nguồn và xoá
  được; không suy diễn từ lịch sử duyệt.
- **Rủi ro**: brief mỗi lượt làm phình prompt. **Giảm thiểu**: trần 12 dòng / 4000 ký tự, có test.
- **Rủi ro**: redaction chạy sau khi đã ghi. **Giảm thiểu**: redact **trước** `insertMemoryRecord`, và
  test đọc DB thô để chứng minh.
- **Rủi ro**: đổi chữ ký `extraTools` làm hỏng caller khác. **Giảm thiểu**: chỉ có hai nơi gọi
  (`main.ts:378` và `main.ts:842`) — cập nhật cả hai, chạy `pnpm verify` ngay sau bước 1.
- **Rủi ro**: migration 18 trùng số với nhánh khác. **Giảm thiểu**: Phase 9 không thêm migration;
  `assertMigrationListIsSane` bắt trùng.

## Security Considerations

- Không lưu secret; redaction bắt buộc, không tuỳ chọn.
- Không trả memory của principal khác (404 giống nhau cho "không có" và "không phải của bạn").
- Xoá là xoá thật khỏi đường inject; ranh giới với lịch sử hội thoại được ghi rõ ở docs Phase 12.

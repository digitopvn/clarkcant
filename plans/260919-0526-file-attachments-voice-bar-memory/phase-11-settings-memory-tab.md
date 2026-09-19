---
phase: 11
title: "Tab Memory trong Settings"
status: pending
priority: P1
effort: "4h"
dependencies: [10]
---

# Phase 11: Tab Memory trong Settings

## Context Links

- Issue #17 §5 "Tab Memory trong Settings"
- `packages/conversation-client/src/SettingsPanel.tsx:53` — `TABS` 4 tab; panel theo `tab === …`
- `packages/conversation-client/test/settings-rows.spec.ts` — mẫu test cho panel
- Phase 10: `GET /memory`, `DELETE /memory/:id`, tool `remember`
- `apps/runtime/src/main.ts:124-127` — `composeFromIntent` (fixture) nhận `{ conversationId, principal, text, messageId, at }`
  và có `services` trong scope, nên nó **gọi được** cùng hàm mà tool `remember` gọi

## Goal

Tab thứ năm `Memory` liệt kê những gì ClarkCant đã nhớ, nhóm theo loại, mỗi mục có nguồn, thời gian và
phạm vi, xoá được; store rỗng thì hiện đúng trạng thái "chưa có gì được ghi nhớ" thay vì bảng trống.

## Chiến lược seed cho journey (quyết định đã chốt)

Không có route `POST /memory` (đúng: memory không phải thứ client tự tạo), nên journey cần một đường
ghi. Chọn: **fixture model gọi đúng hàm mà tool `remember` gọi**. Khi `CC_MODEL_FIXTURE=1` và câu người
dùng khớp `/nhớ rằng|ghi nhớ/i`, fixture trích phần sau dấu hai chấm rồi gọi
`rememberMemory(services..., { kind: "preference", text })` trước khi trả lời.

- Chứng minh được: câu nói → hàm ghi → store → Settings hiển thị → xoá. Tức là toàn bộ đường ống.
- **Không** chứng minh được: việc *model* quyết định gọi tool `remember`. Phần đó ghi là BLOCKED kèm
  điều kiện còn thiếu (provider thật), không nâng thành PASS.
- Không chọn seed bằng SQLite thô: như vậy journey chỉ kiểm UI trên dữ liệu tự tay tạo, và đường ghi
  thật không được chạm tới lần nào.

## Files to Create / Modify

- Modify: `packages/conversation-client/src/SettingsPanel.tsx` (tab thứ năm + panel)
- Create: `packages/conversation-client/src/memory-panel.tsx`
- Create: `packages/conversation-client/src/memory-groups.ts` (helper thuần)
- Create: `packages/conversation-client/test/memory-groups.spec.ts`
- Modify: `packages/conversation-client/src/api.ts` (`listMemories`, `deleteMemory`)
- Modify: `packages/conversation-client/src/styles.ts`
- Modify: `apps/runtime/src/main.ts` (nhánh fixture `nhớ rằng` gọi `rememberMemory`)
- Create: `apps/web/e2e/memory.spec.ts`

## Tests Before (viết trước, phải đỏ)

1. `packages/conversation-client/test/memory-groups.spec.ts`:
   - `"grouping keeps the three kinds in a fixed order and drops empty groups"`.
   - `"an item shows its source, its time and its scope"` — `memoryRow(record)` trả đủ ba trường.
   - `"an empty store produces the empty state, not an empty table"` — `memoryView([])` →
     `{ state: "empty", groups: [] }`.
   - `"a delete in flight marks the row rather than removing it early"` — không xoá lạc quan.
   - `"a failed delete keeps the row and reports the reason"`.
2. `apps/web/e2e/memory.spec.ts`:
   - `"the empty store shows the empty state rather than an empty table"` — dùng `page.route` ép
     `{ items: [], counts: {} }` để không phụ thuộc dữ liệu tích luỹ trong `.data/e2e`.
   - `"a remembered item shows its source and its kind"` — gửi một lượt `nhớ rằng: <token>`; mở
     Settings → Memory; assert mục đó cùng nhãn loại và nguồn.
   - `"deleting an item removes it from the list and from the store"` — sau xoá, `data-memory-count`
     giảm và `GET /memory` (qua `request`) không còn id đó.
   - `"a deleted item is not returned to a later turn"` — khẳng định ở mức **brief** thuộc Phase 10
     (test 4) và ở mức UI ở đây; ghi rõ trong spec rằng nửa prompt đã được chứng minh ở unit test, không
     giả vờ e2e làm việc đó.

## Tasks & Steps

### Task 11.1 — Helper thuần

- **Goal**: logic nhóm/nhãn/trạng thái test được bằng vitest, không cần DOM.
- **Target files and symbols**: `packages/conversation-client/src/memory-groups.ts` —
  `memoryView(records)`, `memoryRow(record)`, `MEMORY_KIND_LABELS`
  (`preference` → "Sở thích", `project-fact` → "Dự án", `decision` → "Quyết định").
- **Steps**:
  1. `timeLabel` tính từ mốc thời gian ("hôm nay"/"hôm qua"/"3 ngày trước"), không hardcode.
  2. `scopeLabel`: `node` → "Mọi cuộc trò chuyện", `conversation` → "Chỉ cuộc trò chuyện này".
  3. `sourceLabel` nêu nguồn từ `sourceMessageId`/`sourceConversationId` (id rút gọn, không nội dung).
- **Success criteria**: 5 test xanh.
- **Verify**: `pnpm exec vitest run packages/conversation-client/test/memory-groups.spec.ts` exits 0.

### Task 11.2 — Client API

- **Goal**: một chỗ gọi hai route memory.
- **Target files and symbols**: `packages/conversation-client/src/api.ts` — `listMemories()`,
  `deleteMemory(memoryId)`.
- **Steps**:
  1. Theo đúng khuôn các method khác trong `GatewayClient`.
  2. Lỗi mạng trả `{ ok: false, reason }`; không throw ra UI.
- **Success criteria**: `pnpm exec tsc -p tsconfig.web.json` xanh.
- **Verify**: `pnpm exec tsc -p tsconfig.web.json` exits 0.

### Task 11.3 — Tab và panel

- **Goal**: tab `Memory` có nội dung thật, theo đúng quy ước "mỗi tab phải có nội dung".
- **Target files and symbols**: `SettingsPanel.tsx` (thêm `{ id: "memory", label: "Memory" }` vào `TABS`
  sau `tools`, và `tab === "memory" && <MemoryPanel client={client} />`), `memory-panel.tsx`.
- **Steps**:
  1. `MemoryPanel` tải khi tab được chọn (không tải lúc mở modal): `useEffect` khi mount.
  2. Bốn trạng thái: `loading` (một dòng, không spinner toàn màn hình), `empty` ("Chưa có gì được ghi
     nhớ"), `ready` (nhóm + mục), `failed` (lý do + nút thử lại).
  3. Mỗi mục: text, nhãn loại, nguồn, thời gian, phạm vi, nút xoá `aria-label="Xoá mục đã ghi nhớ"`.
  4. Xoá: `data-memory-state="deleting"` trên dòng, chờ kết quả rồi mới bỏ khỏi danh sách.
  5. `data-memory-count`, `data-memory-kind`, `data-memory-source` cho journey.
- **Success criteria**: journey 2, 3 xanh.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/memory.spec.ts` exits 0.

### Task 11.4 — Đường ghi trong fixture

- **Goal**: journey chạm đường ghi thật, không cần provider.
- **Target files and symbols**: `apps/runtime/src/main.ts` — nhánh trong `fixtureCompose`.
- **Steps**:
  1. `/nhớ rằng|ghi nhớ/i` → trích text sau `:` hoặc sau cụm từ; gọi `rememberMemory` với
     `{ kind: "preference", scope: "node", conversationId: input.conversationId, principalId: input.principal.principalId }`.
  2. Trả `{ text }` nói đã ghi nhớ; **không** trả block surface.
  3. Ghi comment: fixture gọi **cùng hàm** mà tool `remember` gọi; nó chứng minh đường ống, không chứng
     minh quyết định của model — điều đó cần provider thật và được ghi là BLOCKED.
- **Success criteria**: journey 2 xanh và **đỏ** nếu `rememberMemory` bị gỡ khỏi fixture.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/memory.spec.ts -g "shows its source and its kind"` exits 0.

### Task 11.5 — Evidence

- **Goal**: ảnh cho tab Memory, cả trạng thái rỗng và có dữ liệu.
- **Target files and symbols**: `apps/web/e2e/memory.spec.ts` →
  `plans/reports/evidence/memory-empty-light.png`, `plans/reports/evidence/memory-populated-dark.png`.
- **Steps**:
  1. Chụp sau khi tab đã render xong (có `data-active-tab="memory"`).
  2. Kiểm ảnh không lộ token trước khi tham chiếu trong report.
- **Success criteria**: hai file tồn tại.
- **Verify**: `ls plans/reports/evidence/memory-*.png` liệt kê 2 file.

## Refactor

Nếu `SettingsPanel.tsx` vượt ~900 dòng, tách mỗi panel ra file riêng theo mẫu `ToolLists` sẵn có. Chạy
lại `packages/conversation-client/test/settings-rows.spec.ts` + journey.

## Tests After

`"a delete failure leaves the item visible with its reason"` trong journey.

## Regression gate

```bash
pnpm verify && pnpm test:e2e
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

- **Rủi ro**: tab mới làm panel không vừa màn hình nhỏ. **Giảm thiểu**: cuộn trong `cc-tabpanel` sẵn có;
  journey chạy ở viewport mặc định và một viewport hẹp.
- **Rủi ro**: xoá lạc quan khiến UI nói đã xoá khi chưa. **Giảm thiểu**: `data-memory-state="deleting"`
  và test "a delete in flight marks the row".
- **Rủi ro**: journey phụ thuộc dữ liệu tích luỹ trong `.data/e2e`. **Giảm thiểu**: trạng thái rỗng ép
  bằng `page.route`; test có dữ liệu chỉ assert đúng token nó vừa tạo.

## Security Considerations

- Panel chỉ đọc dữ liệu của principal hiện tại; không có tham số principal từ client.
- Không hiển thị nội dung tin nhắn nguồn; chỉ id rút gọn.
- Xoá không cần xác nhận thêm: đây là dữ liệu người dùng đã nhìn thấy và chủ động xoá.

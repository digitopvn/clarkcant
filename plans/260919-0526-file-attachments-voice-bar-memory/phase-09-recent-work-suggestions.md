---
phase: 9
title: "Gợi ý từ việc gần đây"
status: done
priority: P1
effort: "5h"
dependencies: []
---

# Phase 9: Gợi ý từ việc gần đây

## Context Links

- Issue #17 §4 "Gợi ý khi mở app lần sau"
- `packages/conversation-client/src/Conversation.tsx:85` — mảng tĩnh `SUGGESTIONS`, render ở dòng ~1013
- `packages/storage/src/repositories.ts` — `recentHistory` (~1384), `listActiveTasks` (~471),
  `listPins` (~708), `listProjects` (~1102), `listConversations` (~865), `getConversation` (~846),
  `conversationMetadata` (~789). Đã kiểm: các hàm này ở `repositories.ts`, **không** ở
  `packages/core/src/routing.ts`.
- `docs/scope-lock.md` §Personalization — "không hidden memory"
- `apps/web/e2e/j1.spec.ts` — đang assert `[data-suggestion]` count 4 trên một `.data/e2e` **dùng chung
  và giữ qua nhiều lần chạy**; đây là chỗ dễ vỡ khi gợi ý thành động

## Goal

Màn hình mở app gợi ý việc tiếp theo dựa trên những lần làm việc gần nhất trên node này, mỗi gợi ý có
nhãn nguồn, bấm là chạy thật; store rỗng thì quay lại đúng bốn chip tĩnh hiện có. Không gọi model.

## Files to Create / Modify

- Create: `packages/contracts/src/suggestions.ts` (`suggestionSchema`, `suggestionSourceSchema`)
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/runtime/src/suggestions.ts` (`buildSuggestions`)
- Create: `apps/runtime/test/suggestions.spec.ts`
- Modify: `apps/runtime/src/gateway.ts` (route `GET /suggestions`)
- Create: `packages/conversation-client/src/suggestions.ts` (helper thuần + kiểu)
- Create: `packages/conversation-client/test/suggestions.spec.ts`
- Modify: `packages/conversation-client/src/api.ts` (`fetchSuggestions`)
- Modify: `packages/conversation-client/src/Conversation.tsx` (đọc gợi ý, fallback về `SUGGESTIONS`)
- Modify: `apps/web/e2e/j1.spec.ts` (đổi assert count 4 thành assert theo nguồn dữ liệu, không theo tổng số)
- Create: `apps/web/e2e/suggestions.spec.ts`

## Tests Before (viết trước, phải đỏ)

1. `apps/runtime/test/suggestions.spec.ts`:
   - `"an empty store produces no suggestions rather than placeholder rows"` — `items: []`.
   - `"the most recent conversation becomes the first suggestion, labelled with its own time"`.
   - `"an unfinished task becomes a suggestion that names it"`.
   - `"a pinned instance becomes a suggestion that returns to it"`.
   - `"a suggestion whose conversation was deleted since it was built is dropped"`.
   - `"suggestions are capped and returned in the node's order"` — `limit` mặc định 4.
2. `packages/conversation-client/test/suggestions.spec.ts`:
   - `"an empty list falls back to the four static chips"`.
   - `"a suggestion carries its source label for display"`.
   - `"the rendered order is the server's order"` — client không tự sắp xếp lại.
   - `"a failed fetch falls back to the static chips instead of an empty frame"`.
3. `apps/web/e2e/suggestions.spec.ts`:
   - `"the empty state falls back to the static chips when the node has nothing to suggest"` — dùng
     `page.route("**/suggestions", …)` trả `{ items: [] }`; **không** phụ thuộc trạng thái `.data/e2e`.
   - `"a suggestion from the most recent session is offered with its source label"` — seed qua API rồi
     reload, assert `data-suggestion-source="conversation"` và nhãn nguồn đọc được.
   - `"clicking a suggestion sends it for real"` — bấm rồi assert một message mới xuất hiện trong timeline.

## Tasks & Steps

### Task 9.1 — Contract gợi ý

- **Goal**: hình dạng dữ liệu nhỏ, có nhãn nguồn.
- **Target files and symbols**: `packages/contracts/src/suggestions.ts` —
  `suggestionSourceSchema = z.enum(["conversation","task","pin","project","memory"])`,
  `suggestionSchema` (strictObject: `suggestionId`, `label` ≤ 60, `text` ≤ 500, `source`, `sourceLabel`, `at`, `ref?`).
- **Steps**:
  1. `ref` là opaque: id conversation/task/pin, **không** path.
  2. Export từ `index.ts`.
- **Success criteria**: `pnpm exec tsc -p tsconfig.json` xanh.
- **Verify**: `pnpm exec tsc -p tsconfig.json` exits 0.

### Task 9.2 — Sinh gợi ý ở node

- **Goal**: một hàm thuần đọc store sẵn có, xếp hạng tất định, tối đa 4 gợi ý.
- **Target files and symbols**: `apps/runtime/src/suggestions.ts` —
  `buildSuggestions(deps: { db; principalId; now; limit?: number }): Suggestion[]`.
- **Steps**:
  1. Nguồn theo thứ tự: (a) `listActiveTasks` của conversation gần nhất, (b) `listConversations(db, 5)`,
     (c) `listPins` của conversation gần nhất, (d) `recentHistory({ principalId, limit: 5 })`,
     (e) `listProjects` sắp theo lần dùng gần nhất (**kiểm tên cột thật trong migration 14
     `project-index` trước khi viết code**).
  2. Khử trùng theo `ref`; cắt còn `limit ?? 4`.
  3. `sourceLabel` tính từ `now` và `at`: `"từ phiên hôm qua"`, `"việc còn dang dở"`, `"bạn đã ghim"`,
     `"thư mục dùng gần đây"` — không hardcode "hôm qua" khi mốc là tuần trước.
  4. `text` là câu bấm vào sẽ gửi thật, không phải nhãn trang trí.
  5. **Không** đọc `history_embeddings`, **không** gọi Jev, **không** gọi model: gợi ý phải trả trong
     một lượt đọc DB. Comment nêu lý do (chi phí + không hidden memory).
- **Success criteria**: 6 test xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/suggestions.spec.ts` exits 0.

### Task 9.3 — Route

- **Goal**: client lấy danh sách đã xếp hạng.
- **Target files and symbols**: `apps/runtime/src/gateway.ts` —
  `segments.length === 1 && segments[0] === "suggestions" && request.method === "GET"`.
- **Steps**:
  1. Principal lấy từ token; trả `{ items }`, `200`; store rỗng → `{ items: [] }` (không 404).
  2. `Cache-Control: no-store` — gợi ý phải phản ánh việc vừa làm.
  3. Khi Phase 10 xong: thêm nguồn `memory` (một record `kind: "decision"` chưa xong thành gợi ý).
     Ghi chú này để không phải sửa hai lần, nhưng **không** chặn phase này.
- **Success criteria**: test route xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/suggestions.spec.ts` exits 0.

### Task 9.4 — Client đọc, fallback, và sửa assert dễ vỡ của `j1.spec.ts`

- **Goal**: `SUGGESTIONS` không còn là nguồn chính nhưng vẫn là fallback; suite cũ không vỡ vì dữ liệu tồn.
- **Target files and symbols**: `packages/conversation-client/src/suggestions.ts`,
  `Conversation.tsx` (dòng ~85 giữ mảng, dòng ~1013 đổi nguồn), `api.ts`, `apps/web/e2e/j1.spec.ts`.
- **Steps**:
  1. `fetchSuggestions(client)`; lỗi mạng **không** làm hỏng màn hình → `{ items: [] }` để fallback tiếp quản.
  2. Đổi comment của `SUGGESTIONS` thành "fallback khi node chưa có gì để gợi ý"; giữ nguyên bốn chip.
  3. Render: có dữ liệu → chip động với `data-suggestion-source`; rỗng → bốn chip tĩnh với
     `data-suggestion-static="true"`.
  4. Bấm chip động → gửi `text` như người dùng gõ; chip tĩnh giữ hành vi cũ (cờ `demo`).
  5. `j1.spec.ts`: đổi `expect(count).toBe(4)` thành assert theo `[data-suggestion-static="true"]` khi
     store rỗng (dùng `page.route` để ép `{ items: [] }`), hoặc assert "ít nhất 1 chip và chip đầu có
     nhãn nguồn" khi có dữ liệu. Không để test phụ thuộc số dòng tích luỹ trong `.data/e2e`.
- **Success criteria**: 4 test helper xanh; `j1.spec.ts` xanh trên một `.data/e2e` đã có dữ liệu **và**
  trên một thư mục trắng.
- **Verify**: `pnpm exec vitest run packages/conversation-client/test/suggestions.spec.ts` exits 0.

### Task 9.5 — Journey seed một phiên

- **Goal**: mở app lần sau thấy gợi ý phản ánh phiên gần nhất.
- **Target files and symbols**: `apps/web/e2e/suggestions.spec.ts`.
- **Steps**:
  1. Seed một conversation qua gateway API trực tiếp (`request.post` với token đọc từ
     `.data/e2e/identity.json`).
  2. Reload; assert chip động có `data-suggestion-source="conversation"` và nhãn nguồn nêu mốc thời gian.
  3. Test fallback dùng `page.route` để ép `{ items: [] }` — chạy được ở mọi thứ tự, không phụ thuộc
     thư mục dữ liệu. Ghi lý do trong comment.
- **Success criteria**: 3 journey xanh.
- **Verify**: `pnpm test:e2e -- apps/web/e2e/suggestions.spec.ts` exits 0.

## Refactor

Nếu `buildSuggestions` vượt 200 dòng, tách mỗi nguồn thành `suggestFromX(deps)` trong cùng file, giữ thứ
tự ưu tiên ở một chỗ. Chạy lại **cùng** test.

## Tests After

`"a suggestion never calls a model"` — khẳng định `buildSuggestions` là hàm đồng bộ trả trong cùng tick
và không nhận tham số model/provider nào.

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

- **Rủi ro**: gợi ý thành "hidden memory" (dựng hồ sơ hành vi ngầm). **Giảm thiểu**: mỗi chip có
  `sourceLabel`, bấm là gửi thật, mọi dữ liệu dùng đều nhìn thấy được trong timeline/Settings.
- **Rủi ro**: bốn chip tĩnh bị bỏ quên khi store có một dòng. **Giảm thiểu**: fallback chỉ khi `items`
  rỗng; journey dùng `page.route` để ép trạng thái rỗng thay vì tin vào dữ liệu tích luỹ.
- **Rủi ro**: `listActiveTasks` cần `conversationId` mà lúc mở app chưa có. **Giảm thiểu**: lấy
  conversation gần nhất từ `listConversations` trước; không bịa id.

## Security Considerations

- Không trả path thư mục; project là `ref` opaque.
- Không trả nội dung message; chỉ nhãn và mốc thời gian.
- `Cache-Control: no-store` để gợi ý cũ không bị phục vụ như gợi ý mới.

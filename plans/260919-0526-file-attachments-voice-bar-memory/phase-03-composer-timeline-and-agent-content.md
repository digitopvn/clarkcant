---
phase: 3
title: "Composer, timeline và nội dung tới agent"
status: pending
priority: P1
effort: "7h"
dependencies: [1, 2]
---

# Phase 3: Composer, timeline và nội dung tới agent

## Context Links

- Phase 1–2: contract, module blob, route `/attachments`
- `packages/conversation-client/src/Conversation.tsx:1191` — nút `+` đang `disabled`, dòng 629-690 là `send()`
- `packages/conversation-client/src/api.ts:376` — `sendMessage`; `:735` — `imageObjectUrl` (mẫu lấy byte)
- `packages/core/src/conductor.ts:126-145` — `ModelTurnInput`; `:353-372` — `appendUser` hardcode một block text
- `apps/runtime/src/model-turn.ts:226-229` — `promptForTurn({ text, note })`; `:731` — nơi gọi adapter
- `packages/contracts/src/surfaces.ts:476` — `messageBlockSchema`
- `apps/runtime/src/node-tools.ts` — `createNodeTools` (nơi đăng ký tool cho lượt)

## Goal

Người dùng chọn/kéo-thả/dán được file vào composer, thấy chip tên + dung lượng + trạng thái, xoá được
trước khi gửi; gửi xong thì attachment nằm trong timeline và **vẫn còn sau reload**; nội dung text của
file tới được prompt của lượt **mà không lộ path đĩa**, và ảnh/PDF tới model dưới dạng ref opaque cộng
một tool đọc của node.

## Files to Create / Modify

- Modify: `packages/contracts/src/surfaces.ts` (`attachmentBlockSchema` + đăng ký union)
- Modify: `packages/core/src/conductor.ts` (`UserMessageInput.attachmentRefs`, `appendUser(..., extraBlocks)`)
- Modify: `apps/runtime/src/gateway.ts` (route tin nhắn: kiểm quyền sở hữu `attachmentIds`)
- Modify: `apps/runtime/src/model-turn.ts` (đọc block đã lưu → `attachmentBrief`)
- Modify: `apps/runtime/src/node-tools.ts` (tool `read_attachment`)
- Modify: `packages/pi-adapter/src/fake.ts` (ghi lại prompt — seam test, không phải hành vi)
- Create: `packages/conversation-client/src/attachments.ts`
- Create: `packages/conversation-client/test/attachments.spec.ts`
- Modify: `packages/conversation-client/src/api.ts` (`uploadAttachment`, `attachmentObjectUrl`)
- Modify: `packages/conversation-client/src/Conversation.tsx` (picker, kéo-thả, dán, chip)
- Modify: `packages/conversation-client/src/blocks.tsx` (case `"attachment"`)
- Modify: `packages/conversation-client/src/styles.ts`
- Create: `apps/runtime/test/attachment-in-turn.spec.ts`
- Create: `apps/runtime/test/read-attachment-tool.spec.ts`

## Seam: refs vào lượt (quyết định đã chốt)

Refs đi vào lượt **qua tin nhắn đã lưu**, không qua một trường mới trên `ModelTurnInput`:

1. Route `POST /conversations/:id/messages` nhận thêm `attachmentIds: string[]` (tuỳ chọn).
2. Route kiểm từng id: tồn tại, `principal_id` khớp, `conversation_id` khớp → dựng block
   `{ type: "attachment", attachment: ref }`.
3. `UserMessageInput` thêm `attachmentRefs?: AttachmentRef[]`; `appendUser` nhận thêm `extraBlocks`
   và lưu text block **cộng** các block attachment trong **cùng** một message.
4. `model-turn.ts` đọc các block attachment của tin nhắn người dùng vừa lưu và gọi `attachmentBrief`.

Một nguồn sự thật (tin nhắn đã lưu) nghĩa là timeline sau reload và prompt dùng đúng cùng dữ liệu.

## Tests Before (viết trước, phải đỏ)

1. `packages/conversation-client/test/attachments.spec.ts` (vitest, node env, không render):
   - `"formats a file size in the units a person reads"` — `1536` → `"1.5 KB"`.
   - `"mirrors the server's acceptance rules before an upload is attempted"`.
   - `"a chip can be removed before the message is sent"`.
   - `"a failed upload keeps the chip and its reason"`.
   - `"a pasted file without a name gets one derived from its type"`.
2. `apps/runtime/test/attachment-in-turn.spec.ts`:
   - `"a text attachment's content reaches the model prompt"` — dùng `FakePiAdapter` đã ghi prompt.
   - **`"the prompt for a turn with attachments contains no disk path"`** — khẳng định prompt không chứa
     `dataDir`, không chứa `blob`, và không khớp `/[/\\]/` trong dòng nào có `att_`.
   - `"an image attachment reaches the model as an opaque ref, not as pixels"`.
   - `"the inline budget is shared across attachments in one turn"` — 8 file lớn → tổng text chèn vào
     prompt ≤ `inlineBudgetBytesPerTurn`.
   - `"a stored user message carries one attachment block per attached file"`.
3. `apps/runtime/test/read-attachment-tool.spec.ts`:
   - `"reads a text attachment that belongs to the conversation"`.
   - `"refuses an attachment that belongs to another principal"`.
   - `"refuses an id that is not an attachment id"` — không nhận path, không nhận `../`.
   - `"answers honestly that a binary attachment has no extractor yet"`.

## Tasks & Steps

### Task 3.1 — Block `attachment` trong contract

- **Goal**: timeline vẽ được attachment từ history, không cần state trong RAM.
- **Target files and symbols**: `packages/contracts/src/surfaces.ts` —
  `attachmentBlockSchema = z.strictObject({ type: z.literal("attachment"), attachment: attachmentRefSchema })`,
  thêm vào `messageBlockSchema`, **không** thêm vào `HOST_OWNED_BLOCK_TYPES`.
- **Steps**:
  1. Import `attachmentRefSchema` từ `./attachments.ts`.
  2. Thêm biến thể vào union, giữ `z.discriminatedUnion` (không tạo union lồng).
  3. Test `"an attachment block round-trips through the message schema"` trong
     `packages/contracts/test/contracts.spec.ts`.
- **Success criteria**: `pnpm typecheck` xanh; test contract xanh.
- **Verify**: `pnpm exec vitest run packages/contracts/test/contracts.spec.ts` exits 0.

### Task 3.2 — Refs đi vào tin nhắn đã lưu

- **Goal**: một đường duy nhất đưa refs vào lượt, có kiểm quyền.
- **Target files and symbols**: `packages/core/src/conductor.ts` (`UserMessageInput`, `appendUser`),
  `apps/runtime/src/gateway.ts` (route tin nhắn, cả bản thường và bản stream).
- **Steps**:
  1. `appendUser(deps, conversationId, text, at, extraBlocks: MessageBlock[] = [])` — giữ nguyên chữ ký
     cũ cho mọi caller hiện có; blocks = `[textBlock, ...extraBlocks]`.
  2. `UserMessageInput` thêm `attachmentRefs?: readonly AttachmentRef[]`; `handleUserMessage` map sang
     block `attachment` **sau khi** validate qua `attachmentRefSchema`.
  3. Route tin nhắn: đọc `attachmentIds` (mảng string, ≤ `ATTACHMENT_LIMITS.maxPerMessage`); mỗi id tra
     `getAttachment`, khớp `principal_id` và `conversation_id`; sai → 400 `ATTACHMENT_NOT_AVAILABLE`
     (không nói id nào của ai). Dựng refs rồi truyền vào `UserMessageInput`.
  4. Làm cho **cả** `POST /messages` và `POST /messages/stream` dùng cùng một hàm dựng refs.
- **Success criteria**: test `"a stored user message carries one attachment block per attached file"` xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-in-turn.spec.ts` exits 0.

### Task 3.3 — Prompt của lượt

- **Goal**: model nhận nội dung text, nhận ref opaque, và không bao giờ nhận path.
- **Target files and symbols**: `apps/runtime/src/model-turn.ts` (nơi dựng prompt trước `adapter.prompt`),
  `apps/runtime/src/attachments.ts` (`attachmentBrief`).
- **Steps**:
  1. Trước khi gọi adapter, đọc block `attachment` của tin nhắn người dùng cuối trong lượt; nếu có, tính
     `brief = attachmentBrief({ refs, db, dataDir })`.
  2. Ghép `brief` bằng đúng cách `note` đang được ghép trong `promptForTurn` (thêm một tham số
     `brief?: string`, cùng khuôn `[Hướng dẫn cho lượt này: …]`).
  3. **Không** truyền `dataDir` hay `blobPath` vào bất kỳ chuỗi nào gửi adapter. Nếu cần nội dung nhị phân,
     chỉ nêu `attachmentId` và nói rằng tool `read_attachment` đọc được.
  4. Nếu lượt không có attachment, hành vi y như trước (không thêm khối rỗng).
- **Success criteria**: 4 test đầu của `attachment-in-turn.spec.ts` xanh, gồm test "no disk path".
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-in-turn.spec.ts` exits 0.

### Task 3.4 — Tool `read_attachment`

- **Goal**: ảnh/PDF có một đường đọc do host kiểm soát, không mở đường đọc file tuỳ ý.
- **Target files and symbols**: `apps/runtime/src/node-tools.ts` — tool `read_attachment` trong
  `createNodeTools`, nhận `{ attachmentId }`; `packages/pi-adapter/src/fake.ts` không cần đổi.
- **Steps**:
  1. `createNodeTools` nhận thêm `attachments: { db; dataDir; principalId; conversationId }` (đã có
     `principalId` trong `SessionSearchDeps` — dùng lại thay vì thêm nguồn thứ hai).
  2. `read_attachment`: validate `attachmentId` bằng `attachmentIdSchema`; tra `getAttachment`; khớp
     `principal_id` **và** `conversation_id`; sai → trả text nói không có attachment đó (không phân biệt
     "không tồn tại" với "không phải của bạn").
  3. `kind === "text"` → trả nội dung (giới hạn `inlineBudgetBytesPerTurn`); `kind === "image" | "pdf"`
     → trả text nói rõ node chưa có bộ trích nội dung nhị phân, kèm tên/mime/size. **Không** trả path.
  4. Thêm dòng vào `apps/runtime/test/node-tools.spec.ts`: danh sách tool có `read_attachment`.
- **Success criteria**: 4 test của `read-attachment-tool.spec.ts` xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/read-attachment-tool.spec.ts apps/runtime/test/node-tools.spec.ts` exits 0.

### Task 3.5 — `FakePiAdapter` ghi lại prompt

- **Goal**: có seam để chứng minh "nội dung tới model" mà không cần provider.
- **Target files and symbols**: `packages/pi-adapter/src/fake.ts` — thêm
  `promptsFor(sessionId): readonly string[]` và ghi mỗi prompt trong `run()`.
- **Steps**:
  1. Thêm mảng `#prompts` theo session, push trong `run(sessionId, prompt)`.
  2. `promptsFor` trả bản sao chỉ đọc; session không tồn tại → mảng rỗng (không throw).
  3. Ghi comment: đây là seam của test double, không phải hành vi của adapter thật.
  4. Thêm test vào `packages/pi-adapter/test/pi-adapter.spec.ts`:
     `"the fake records the prompt it was given"`.
- **Success criteria**: test mới xanh; `FakePiAdapter` vẫn thoả `PiAdapter`.
- **Verify**: `pnpm exec vitest run packages/pi-adapter/test/pi-adapter.spec.ts` exits 0.

### Task 3.6 — Helper thuần và client API

- **Goal**: logic chip test được không cần DOM; một chỗ biết cách upload và lấy byte.
- **Target files and symbols**: `packages/conversation-client/src/attachments.ts` —
  `formatFileSize`, `clientAccepts` (gọi lại `validateAttachmentCandidate`, một nguồn luật),
  `attachmentReducer(state, action)`, `toBase64(buffer)`.
  `packages/conversation-client/src/api.ts` — `uploadAttachment`, `attachmentObjectUrl` (bắt chước
  `imageObjectUrl` ở dòng ~735: fetch có bearer → `blob()` → `URL.createObjectURL`).
- **Steps**:
  1. `clientAccepts` chỉ báo trước phần client biết (`usedBytes: 0`); quota là việc của server.
  2. `toBase64` xử lý theo chunk để không tràn stack với file lớn.
  3. `uploadAttachment` map lỗi gateway thành `{ ok: false, code, message }`.
- **Success criteria**: 5 test helper xanh; `pnpm typecheck` xanh; không thêm thư viện.
- **Verify**: `pnpm exec vitest run packages/conversation-client/test/attachments.spec.ts` exits 0.

### Task 3.7 — Composer: picker, kéo-thả, dán, chip

- **Goal**: nút `+` hoạt động thật; mọi cách đưa file vào đi cùng một đường.
- **Target files and symbols**: `packages/conversation-client/src/Conversation.tsx` — bỏ `disabled` và
  `title="Chưa hỗ trợ đính kèm"` (dòng ~1191); thêm `<input type="file" multiple hidden data-attachment-input="true" />`;
  `onDrop`/`onDragOver`/`onPaste` trên `.cc-composer-wrap`; state chip bằng `attachmentReducer`;
  `send()` (dòng 629) nhận thêm `attachmentIds` và truyền qua `sendMessage`/`streamMessage`.
- **Steps**:
  1. Nút `+` mở hộp thoại file, giữ `aria-label="Đính kèm"`.
  2. `onPaste`: đọc `event.clipboardData.files`; tên thiếu → `pasted-<ISO>` + đuôi theo mime.
  3. Mỗi file: `clientAccepts` trước; không đạt → chip `failed` kèm lý do, **không** gọi API.
  4. `conversationId` chưa có (lượt đầu): tạo conversation trước khi upload, dùng đúng đường `send()`
     đang dùng (`client.createConversation`).
  5. Gửi: đính `attachmentIds` của chip `ready`; xoá chip sau khi gửi thành công; chip `failed` **không**
     chặn gửi nhưng hiện lý do.
  6. `data-attachment-chip`, `data-attachment-state`, `data-composer-drop` cho Playwright.
- **Success criteria**: journey Phase 4 chạy được; `pnpm run lint` xanh.
- **Verify**: `pnpm run lint` exits 0 và `grep -c "Chưa hỗ trợ đính kèm" packages/conversation-client/src/Conversation.tsx` in `0`.

### Task 3.8 — Render trong timeline

- **Goal**: attachment hiện trong timeline và sau reload.
- **Target files and symbols**: `packages/conversation-client/src/blocks.tsx` (`renderBlock`, dòng ~914,
  thêm `case "attachment"`), `packages/conversation-client/src/use-image-urls.ts` (mẫu hook).
- **Steps**:
  1. `kind === "image"` → `<figure>` với `<img>` lấy từ `attachmentObjectUrl`, `alt` = tên file, kèm dòng
     tên + dung lượng; lỗi tải → text "Không tải được tệp đính kèm" (không khung rỗng).
  2. `kind === "text" | "pdf"` → card có tên, dung lượng, nút tải.
  3. Đọc từ `message.blocks` như mọi block khác — không thêm state riêng, để reload tự thấy.
  4. Một hook `useAttachmentUrls` theo đúng ba luật của `useImageUrls` (một fetch một URL, chỉ thu hồi
     khi chủ sở hữu mất, URL đến muộn thì thu hồi ngay).
- **Success criteria**: journey Phase 4 xanh.
- **Verify**: `pnpm run lint` exits 0.

## Refactor

Nếu `Conversation.tsx` vượt ~1500 dòng sau Task 3.7, tách composer thành
`packages/conversation-client/src/composer.tsx`. Chạy lại **cùng** test; không đổi `data-*` attribute
mà Playwright đang bám.

## Tests After

`"a failed upload can be retried without losing the other chips"`.

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

- **Rủi ro**: nội dung file là văn bản không tin cậy, có thể chứa chỉ dẫn cho model. **Giảm thiểu**: khối
  văn bản có nhãn rõ và một câu nói nội dung là **dữ liệu**; tool `read_attachment` chỉ đọc attachment
  thuộc đúng conversation + principal, **không** nhận path, nên injection không mở được đường đọc file
  mới. Phase này **không** mở rộng bề mặt của `search_files` đã có; ghi chú này vào report.
- **Rủi ro**: `appendUser` đổi chữ ký làm hỏng caller khác. **Giảm thiểu**: tham số mới có default `[]`;
  chạy `pnpm verify` ngay sau Task 3.2.
- **Rủi ro**: ảnh không tới model dạng pixel (adapter chỉ nhận text). **Giảm thiểu**: ghi rõ trong prompt
  rằng có attachment nhị phân và tool nào đọc được; ghi giới hạn vào docs và report, **không** claim
  model nhìn thấy ảnh.

## Security Considerations

- Prompt không chứa path đĩa — có test riêng khẳng định điều này.
- `read_attachment` kiểm principal + conversation; không có tham số path, không có `..`.
- Tên file đã redact ở server; React tự escape khi render.
- Không nhét nội dung file vào log hay vào event.

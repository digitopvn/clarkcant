---
phase: 1
title: "Contract đính kèm, blob store dùng chung và quota"
status: pending
priority: P1
effort: "6h"
dependencies: []
---

# Phase 1: Contract đính kèm, blob store dùng chung và quota

## Context Links

- Issue: https://github.com/digitopvn/clarkcant/issues/17/ (§1 "Attach files")
- `docs/widgets-and-extensions.md` §8 — "Dataset/attachments qua opaque refs, no arbitrary paths, executable URLs"
- `docs/system-architecture.md` §10 — blob store có quotas
- **Blob store đã tồn tại**: `apps/runtime/src/mini-app-data.ts:576-581` ghi vào `dataDir/blobs` với tên
  content-addressed và `{ mode: 0o600 }`; `apps/runtime/src/gateway.ts:730-734` đọc lại có kiểm
  `isWithinRoot`. Phase này **trích xuất** nó, không dựng cái thứ hai.
- `packages/storage/src/migrate.ts` — 16 bản đã apply, bản cuối `credentials` (dòng 872)
- `apps/runtime/src/path-roots.ts` — `isWithinRoot`

## Goal

Có một contract `AttachmentRefV1`, một module blob dùng chung (đã tách từ đường ảnh hiện có) và một
luật chấp nhận file. Kết thúc phase này: `validateAttachmentCandidate()` từ chối được path tuyệt đối,
URL thực thi, mime thực thi, magic bytes lệch khai báo, file quá ngưỡng và vượt quota; blob ghi xuống
đĩa **đúng như ảnh đang ghi** (content-addressed, mode 0o600).

## Files to Create / Modify

- Create: `packages/contracts/src/attachments.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/runtime/src/blobs.ts` (module blob dùng chung, tách từ `mini-app-data.ts`)
- Modify: `apps/runtime/src/mini-app-data.ts` (dùng `blobs.ts`, bỏ code ghi blob trùng)
- Create: `apps/runtime/src/attachments.ts` (quota + brief + release, dùng `blobs.ts`)
- Modify: `packages/storage/src/migrate.ts` (migration **17** `attachments`)
- Modify: `packages/storage/src/repositories.ts` (5 hàm attachment)
- Create: `packages/contracts/test/attachments.spec.ts`
- Create: `apps/runtime/test/attachments.spec.ts`

## Tests Before (viết trước, phải đỏ)

1. `packages/contracts/test/attachments.spec.ts`
   - `"refuses a filename that is an absolute path"` — `C:\Windows\system.ini`, `/etc/passwd`.
   - `"refuses a filename that is a URL"` — `javascript:alert(1)`, `https://example.com/x.png`, `data:text/html;base64,…`.
   - `"refuses an executable content type regardless of declared size"`.
   - `"accepts an image, a pdf and a markdown file under the ceiling"`.
   - `"refuses a file over the ceiling and names the ceiling"`.
   - `"counts the inline budget for a turn, not per file"` — 8 file lớn vẫn phải ở dưới
     `inlineBudgetBytesPerTurn`.
2. `apps/runtime/test/attachments.spec.ts`
   - `"stores bytes whose digest matches the digest it returns"`.
   - `"a stored blob carries the 0o600 mode the image store already uses"` — đọc `mode & 0o777`.
   - `"refuses to read outside the blob root"` — `blobRef: "../../etc/passwd"`.
   - `"counts usage per principal and refuses over quota"`.
   - `"sniffing refuses a png that is actually a zip"` — magic bytes thắng lời khai.
   - `"sniffing accepts a pdf and a markdown file"`.

## Tasks & Steps

### Task 1.1 — Contract `AttachmentRefV1`

- **Goal**: một schema strict mô tả attachment mà không chở path hay URL thực thi.
- **Target files and symbols**: `packages/contracts/src/attachments.ts` —
  `attachmentIdSchema` (tiền tố `att`, dùng `prefixed` trong `packages/contracts/src/primitives.ts`),
  `attachmentKindSchema` (`"image" | "pdf" | "text"`),
  `attachmentRefSchema` (strictObject: `attachmentId`, `filename`, `mime`, `kind`, `sizeBytes`, `sha256`, `blobRef`),
  `ATTACHMENT_LIMITS` (`maxBytes: 26_214_400`, `maxPerMessage: 8`, `principalQuotaBytes: 1_073_741_824`,
  `inlineBudgetBytesPerTurn: 32_768`),
  `ATTACHMENT_MIME_ALLOWLIST`, `classifyAttachment(input: { mime, filename })`,
  `looksLikePathOrUrl(filename): boolean`,
  `validateAttachmentCandidate(input: { filename, mime, sizeBytes, usedBytes }): { ok: true; kind } | { ok: false; code; message }`,
  type `AttachmentRefusalCode`.
- **Steps**:
  1. `ATTACHMENT_MIME_ALLOWLIST`: `image/png`, `image/jpeg`, `image/webp`, `image/gif`,
     `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/json`.
  2. `classifyAttachment`: mime → kind; mime ngoài allowlist → `undefined`.
  3. `looksLikePathOrUrl`: `true` khi tên chứa `/` hoặc `\`, hoặc khớp `/^[a-zA-Z]:/`, hoặc bắt đầu
     bằng `javascript:`/`data:`/`vbscript:`/`file:`. Export riêng để test trực tiếp.
  4. `validateAttachmentCandidate` theo **thứ tự**: `ATTACHMENT_NAME_NOT_ALLOWED` →
     `ATTACHMENT_TYPE_UNSUPPORTED` → `ATTACHMENT_TOO_LARGE` → `ATTACHMENT_QUOTA_EXCEEDED`. Message
     tiếng Anh và **phải nêu con số** (ngưỡng hoặc quota); client dịch sang câu tiếng Việt.
  5. Tên `principalQuotaBytes` chứ không phải `nodeQuotaBytes`: luật enforce theo **principal**
     (`attachmentUsageForPrincipal`), nên tên phải khớp thứ được enforce.
  6. Export từ `index.ts` (`export * from "./attachments.ts";`).
- **Success criteria**: `pnpm exec vitest run packages/contracts/test/attachments.spec.ts` xanh.
- **Verify**: `pnpm exec vitest run packages/contracts/test/attachments.spec.ts` exits 0 và in `Test Files  1 passed`.

### Task 1.2 — Migration 17 và repository

- **Goal**: attachment có chỗ ở bền vững, gắn conversation và principal.
- **Target files and symbols**: `packages/storage/src/migrate.ts` (append `version: 17`, `name: "attachments"`),
  `packages/storage/src/repositories.ts`.
- **Steps**:
  1. Append vào `MIGRATIONS` **ở cuối mảng**:
     `CREATE TABLE attachments (attachment_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL,
     size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, blob_path TEXT NOT NULL, created_at TEXT NOT NULL)`
     và `CREATE INDEX attachments_conversation ON attachments(conversation_id)`. Không sửa bản 1–16.
  2. Repository: `insertAttachment`, `getAttachment(db, attachmentId)`,
     `listAttachmentsForConversation`, `deleteAttachmentsForConversation(db, conversationId)`
     (trả `{ removed: number; blobPaths: string[] }`), `attachmentUsageForPrincipal(db, principalId)`.
     Xem mẫu cột/kiểu ở `insertLocalImage` và `getLocalImage` để giữ cùng phong cách.
  3. Ghi comment nêu rõ: bảng này **không** cascade vì `conversations` không có `ON DELETE CASCADE`
     (`migrate.ts:168,175,399,442`) và `foreign_keys = ON` (`db.ts:55`); việc xoá theo conversation
     do `releaseConversationAttachments` làm tường minh.
- **Success criteria**: migration chạy được trên DB trắng và trên DB ở version 16.
- **Verify**: `pnpm exec vitest run packages/storage/test/storage.spec.ts apps/runtime/test/identifier-uniqueness.spec.ts` exits 0.

### Task 1.3 — Module blob dùng chung

- **Goal**: **một** chỗ ghi/đọc blob cho cả ảnh mini-app và attachment; không nhân bản digest, không
  quên file mode.
- **Target files and symbols**: `apps/runtime/src/blobs.ts` (mới) —
  `blobsDir(dataDir)`, `writeBlob(input: { dataDir, bytes, extension }): { blobPath, digest }` (giữ
  đúng `writeFileSync(..., { mode: 0o600 })` và tên `<32 hex>.<ext>` như đường ảnh hiện có),
  `readBlob(input: { dataDir, blobPath }): { ok: true; bytes } | { ok: false; code: "BLOB_MISSING" | "BLOB_PATH_ESCAPES_ROOT" }`
  (dùng `resolve` + `isWithinRoot`), `sniffContentType(bytes, declaredMime)`.
- **Steps**:
  1. Chuyển phần ghi blob từ `importLocalImage` (`mini-app-data.ts:576-581`) sang `writeBlob`, giữ
     **nguyên** tên file và mode; `importLocalImage` gọi lại hàm này.
  2. Chuyển `readLocalImage` + nhánh đọc ảnh ở gateway sang `readBlob`, giữ nguyên hành vi
     (`BLOB_MISSING` khi file mất, `BLOB_PATH_ESCAPES_ROOT` khi path thoát root).
  3. `sniffContentType`: giữ `sniffImage` cho ảnh; thêm PDF khi bytes bắt đầu bằng `%PDF-`; nhận text
     khi bytes decode utf-8 được và không chứa byte NUL trong 512 byte đầu. Trả
     `{ ok: true; mime }` hoặc `{ ok: false; code: "ATTACHMENT_TYPE_MISMATCH" | "ATTACHMENT_TYPE_UNSUPPORTED" }`.
  4. Magic bytes **thắng** lời khai: khai `image/png` mà bytes là zip → `ATTACHMENT_TYPE_MISMATCH`.
  5. Chạy lại `apps/web/e2e/mini-app.spec.ts` để chắc đường ảnh không đổi hành vi.
- **Success criteria**: test 2, 3, 5, 6 xanh; journey ảnh hiện có vẫn xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachments.spec.ts` exits 0.

### Task 1.4 — Attachment service: quota, release, brief

- **Goal**: một chỗ quyết định quota và một chỗ đọc nội dung cho prompt.
- **Target files and symbols**: `apps/runtime/src/attachments.ts` —
  `attachmentQuotaDecision({ usedBytes, incomingBytes })`,
  `releaseConversationAttachments({ db, dataDir, conversationId }): { removed: number }`,
  `attachmentBrief(input: { refs, db, dataDir }): string`.
- **Steps**:
  1. `attachmentQuotaDecision` trả `{ ok: true } | { ok: false, code: "ATTACHMENT_QUOTA_EXCEEDED", message }`.
  2. `releaseConversationAttachments`: `deleteAttachmentsForConversation` → xoá file qua `readBlob`-style
     path (chỉ xoá file **trong** `blobsDir`), bỏ qua file đã mất, không throw. Đây là hàm mà
     `retention theo conversation` sẽ dùng khi repo có đường xoá conversation; hôm nay nó có test riêng.
  3. `attachmentBrief` — **hợp đồng quan trọng**: chỉ chứa `attachmentId` (opaque), `filename`, `mime`,
     `sizeBytes`. **Không bao giờ** chứa `dataDir`, `blobPath`, hay bất kỳ dấu phân cách path nào.
     Nội dung text được chèn trong khối có nhãn rõ, tổng không quá `inlineBudgetBytesPerTurn` **cho cả
     lượt** (không phải mỗi file), phần bị cắt ghi `[đã lược bớt sau <n> byte]`.
     Kèm một câu nói rõ nội dung file là **dữ liệu**, không phải chỉ dẫn.
  4. Với `kind === "image" | "pdf"`: chỉ nêu ref + tên + mime + size và nói rằng nội dung nhị phân đọc
     được qua tool `read_attachment` (Phase 3). Không nêu path.
- **Success criteria**: test 4 xanh; test brief ở Phase 3 khẳng định không có path.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachments.spec.ts` exits 0.

## Refactor

Giữ `sniffImage` như một hàm export của `blobs.ts` để `mini-app-data.ts` không còn code riêng. Chạy
lại **cùng** test cũ của mini-app (`apps/runtime/test/mini-app-data.spec.ts`) — refactor này chỉ được
coi là xong khi suite đó vẫn xanh mà không sửa assertion.

## Tests After

`"a blob written for an attachment and one written for an image land in the same directory with the same mode"`.

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

- **Rủi ro**: tách `blobs.ts` làm hỏng đường ảnh mini-app. **Giảm thiểu**: regression gate chạy
  `mini-app-data.spec.ts` và journey ảnh trước khi làm gì khác; refactor không đổi tên file/mode.
- **Rủi ro**: quota tính theo principal trong khi blob nằm trên đĩa → hai nguồn sự thật.
  **Giảm thiểu**: quota là hàm của `SUM(size_bytes)`; `attachmentUsageForPrincipal` là nguồn duy nhất.
- **Rủi ro**: ngân sách inline theo lượt vẫn có thể bị vượt nếu nhiều lượt ngắn. **Giảm thiểu**: đây là
  trần mỗi lượt, đúng thứ được đo; test 8 file lớn khẳng định prompt vẫn dưới budget.

## Security Considerations

- Không nhận path, chỉ nhận ref opaque.
- `blob_path` ở lại trong DB; không trả cho client, không vào prompt.
- Magic bytes quyết định loại; lời khai của client không bao giờ tự đủ.
- Mọi refusal trả mã đọc được, không trả stack.

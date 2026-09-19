---
phase: 2
title: "Route upload/download, header transport và seam server"
status: pending
priority: P1
effort: "5h"
dependencies: [1]
---

# Phase 2: Route upload/download, header transport và seam server

## Context Links

- Phase 1: `packages/contracts/src/attachments.ts`, `apps/runtime/src/blobs.ts`, `apps/runtime/src/attachments.ts`
- `apps/runtime/src/gateway.ts` — `GatewayResponse` **chỉ** có `stream` và `binary` (dòng 91-116);
  token check một chỗ; `readJson` không giới hạn body (dòng ~160)
- `apps/runtime/src/main.ts` — gom body không giới hạn (`chunks.push(chunk)`), tự viết header cho
  `binary` (dòng 649-656), **không export gì** nên không test nào boot được server
- `apps/runtime/test/api.spec.ts` — mẫu gọi `handleRequest` trực tiếp

## Goal

Node nhận byte của một file qua HTTP, trả về `AttachmentRefV1`, phục vụ lại byte đó qua ref opaque với
header an toàn, và từ chối mọi ứng viên không hợp lệ bằng mã đọc được. Trần body và header của đường
này **có test chạm tới thật**, không chỉ nằm trong handler.

## Files to Create / Modify

- Create: `apps/runtime/src/server.ts` (`createNodeServer`, tách từ `main.ts`)
- Modify: `apps/runtime/src/main.ts` (gọi `createNodeServer`; thêm trần body cho `/attachments`)
- Modify: `apps/runtime/src/gateway.ts` (`headers?` trên `binary`; 4 nhánh route attachment)
- Create: `apps/runtime/test/attachment-routes.spec.ts`
- Create: `apps/runtime/test/attachment-server.spec.ts`

## Tests Before (viết trước, phải đỏ)

1. `apps/runtime/test/attachment-routes.spec.ts` (gọi `handleRequest` như `api.spec.ts`):
   - `"stores an uploaded text file and returns an opaque ref"` — `attachmentId` bắt đầu `att_`;
     response **không** chứa chuỗi đường dẫn đĩa.
   - `"the response for an attachment never carries a disk path"` — quét toàn bộ JSON trả về, so với
     `dataDir`.
   - `"refuses a filename that is an absolute path"` — `ATTACHMENT_NAME_NOT_ALLOWED`, 400.
   - `"refuses a filename that carries an executable URL"` — `javascript:` và `https://`.
   - `"refuses an executable content type"` — `application/x-msdownload` → `ATTACHMENT_TYPE_UNSUPPORTED`.
   - `"refuses content whose magic bytes disagree with the declared type"` — khai `image/png`, bytes zip
     → `ATTACHMENT_TYPE_MISMATCH`.
   - `"refuses a file over the ceiling and names the ceiling"` → `ATTACHMENT_TOO_LARGE`.
   - `"refuses an upload that would cross the principal quota"` → `ATTACHMENT_QUOTA_EXCEEDED`.
   - `"refuses an unauthenticated upload"` → 401 `UNAUTHENTICATED`.
   - `"refuses to serve another principal's attachment"` → 404 `RESOURCE_NOT_FOUND`.
   - `"serves the bytes with nosniff and no inline disposition for a pdf"`.
2. `apps/runtime/test/attachment-server.spec.ts` (boot `createNodeServer` trên port 0, `fetch` thật):
   - `"an oversized upload is refused with 413 before it is buffered"` — POST `/attachments` với body
     lớn hơn trần → 413 `PAYLOAD_TOO_LARGE`.
   - `"a large body on another path is handled exactly as before"` — cùng kích thước tới `/command` →
     không phải 413 (đường cũ không đổi hành vi).

## Tasks & Steps

### Task 2.1 — Tách `createNodeServer` để trần body test được

- **Goal**: một hàm boot server thật, test được, và trần body chỉ áp cho `/attachments`.
- **Target files and symbols**: `apps/runtime/src/server.ts` —
  `createNodeServer(input: { services: NodeServices; voice?: VoiceGatewayLike; options: NodeOptions }): Server`,
  `hostOwnedHeaders` (danh sách header transport tự quyết), `bodyLimitForPath(path): number | undefined`.
- **Steps**:
  1. Chuyển khối `createServer((request, response) => {…})` cùng phần ghi response từ `main.ts` sang
     `server.ts`, giữ nguyên hành vi từng nhánh (stream, binary, JSON).
  2. `main.ts` gọi `createNodeServer(...)` rồi `server.listen(...)`; phần boot khác giữ nguyên.
  3. Trong handler `data`: cộng dồn `received += chunk.byteLength`; khi vượt `bodyLimitForPath(url.pathname)`
     thì ngừng gom, trả `413 PAYLOAD_TOO_LARGE` (message nêu trần) và `request.destroy()`.
  4. `bodyLimitForPath` trả `ATTACHMENT_UPLOAD_BODY_LIMIT = 36_700_160` (35 MiB, đủ cho 25 MiB base64)
     **chỉ** cho `/attachments`, `undefined` cho mọi path khác. Comment nêu lý do: đặt trần toàn cục
     trong PR này sẽ đổi hành vi của mọi route khác.
  5. `attachment-server.spec.ts` boot trên `port: 0`, đọc `server.address()` để lấy port thật.
- **Success criteria**: hai test của file server xanh; `pnpm test:e2e` không đổi kết quả.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-server.spec.ts` exits 0.

### Task 2.2 — `headers?` trên `binary`

- **Goal**: route phục vụ file đặt được header an toàn mà không giành quyền với transport.
- **Target files and symbols**: `apps/runtime/src/gateway.ts` — `binary?: { bytes; contentType; headers?: Record<string, string> }`;
  `apps/runtime/src/server.ts` — gộp header, từ chối key host-owned.
- **Steps**:
  1. Trong `server.ts`, sau khi set `content-type`/`content-length`/`cache-control`, gộp
     `result.binary.headers`; nếu một key nằm trong `hostOwnedHeaders` thì **bỏ qua** nó và ghi
     `process.stderr` một dòng nêu tên key bị từ chối (không throw: đây là lỗi lập trình, không phải
     lỗi request).
  2. Giữ nguyên hai header cũ để đường ảnh không đổi.
  3. Test khẳng định `x-content-type-options: nosniff` có mặt trên response attachment và **không** có
     trên response ảnh (đường cũ không bị đổi).
- **Success criteria**: test `"serves the bytes with nosniff …"` xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-routes.spec.ts` exits 0.

### Task 2.3 — `POST /attachments`

- **Goal**: một file vào, một `AttachmentRefV1` ra.
- **Target files và symbols**: `apps/runtime/src/gateway.ts` — nhánh
  `segments.length === 1 && segments[0] === "attachments" && request.method === "POST"`, gọi
  `validateAttachmentCandidate` → `sniffContentType` → `attachmentQuotaDecision` → `writeBlob` → `insertAttachment`.
- **Steps**:
  1. Body: `{ conversationId, filename, mime, contentBase64 }`. Từ chối nếu `contentBase64` không phải
     string; `conversationId` không tồn tại → 404 `RESOURCE_NOT_FOUND` (dùng `getConversation`).
  2. `Buffer.from(content, "base64")`; `sizeBytes` tính **từ byte thật**, không tin trường client khai.
  3. `sniffContentType(bytes, mime)` — magic bytes quyết định; lệch → `ATTACHMENT_TYPE_MISMATCH`.
  4. `validateAttachmentCandidate({ filename, mime: sniffed, sizeBytes, usedBytes: attachmentUsageForPrincipal(...) })`.
  5. `writeBlob({ dataDir, bytes, extension })` → `insertAttachment` với `blob_path`, `conversation_id`,
     `principal_id` **lấy từ token**. Trả `201` với `attachmentRef` (không có `blob_path`).
  6. `filename` chạy qua redactor dùng chung (`packages/contracts/src/redaction.ts`, hàm `redactSecrets`)
     **trước** khi lưu và trước khi trả.
- **Success criteria**: test 1, 3–9 xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-routes.spec.ts` exits 0.

### Task 2.4 — `GET /attachments/:id` và `/attachments/:id/content`

- **Goal**: client lấy metadata và byte mà không cần biết path.
- **Target files and symbols**: hai nhánh trong `apps/runtime/src/gateway.ts`; `readBlob` từ `blobs.ts`.
- **Steps**:
  1. `GET /attachments/:id` → `getAttachment`; `principal_id` phải khớp principal của request; không
     khớp hoặc không có → 404 `RESOURCE_NOT_FOUND` (giống nhau, không phân biệt).
  2. `GET /attachments/:id/content` → `readBlob`. Trả `binary` với `contentType` = mime **đã sniff** khi
     lưu, cộng `headers: { "x-content-type-options": "nosniff" }` và
     `content-disposition: inline; filename="<đã redact>"` **chỉ** cho `image/*` và `text/*`;
     `application/pdf` và mọi loại khác dùng `attachment`.
  3. Blob mất trên đĩa → 410 `BLOB_MISSING` với message nói byte không còn; dòng vẫn ở lại DB.
  4. Không có `text/html` trong allowlist, nên `inline` không bao giờ phục vụ HTML như tài liệu.
- **Success criteria**: test 10 xanh.
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-routes.spec.ts` exits 0.

### Task 2.5 — Retention theo conversation, không thêm route xoá conversation

- **Goal**: luật retention có hàm thật và test thật, **không** kéo theo một thao tác xoá phá huỷ trong
  PR về đính kèm.
- **Target files and symbols**: đã có ở Phase 1 (`releaseConversationAttachments`) — phase này chỉ thêm test.
- **Steps**:
  1. Viết test `"releasing a conversation removes its attachment rows and its blobs"` — seed hai
     attachment trong hai conversation, gọi hàm cho một conversation, khẳng định dòng và file của nó
     biến mất còn của conversation kia nguyên vẹn.
  2. **Không** thêm `DELETE /conversations/:id`. Ghi lý do vào comment cạnh test: `conversations` có 4
     bảng tham chiếu không cascade (`migrate.ts:168,175,399,442`) và `foreign_keys = ON`, nên đường xoá
     conversation là một thay đổi phá huỷ cần phase riêng và chính sách riêng (task đang chạy thì sao).
  3. Ghi việc này vào Phase 12 như một gap có tên, và vào report của Stage A.
- **Success criteria**: test xanh; `grep -c 'DELETE' apps/runtime/src/gateway.ts` **không** tăng so với
  trước phase (không có route xoá mới).
- **Verify**: `pnpm exec vitest run apps/runtime/test/attachment-routes.spec.ts` exits 0 và
  `grep -c 'method === "DELETE"' apps/runtime/src/gateway.ts` in đúng số cũ (4).

## Refactor

Gom bốn nhánh attachment vào `handleAttachmentRoutes(deps, request, segments, at)` như
`handleMiniAppDataRoutes` đang làm. Không đổi hành vi: chạy lại **cùng** test đã có.

## Tests After

`"an attachment name that looks like a secret is redacted before it is stored"`.

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

- **Rủi ro**: tách `createNodeServer` làm đổi hành vi transport (stream, cache-control, CORS).
  **Giảm thiểu**: chuyển nguyên khối, không viết lại; chạy `pnpm test:e2e` ngay sau Task 2.1.
- **Rủi ro**: base64 làm phồng RAM 1.33 lần cho file 25 MB. **Giảm thiểu**: trần body riêng + từ chối
  theo byte thật; ghi giới hạn này vào report, không giả vờ streaming.
- **Rủi ro**: `content-disposition: inline` cho loại sai biến node thành nơi phát tán nội dung.
  **Giảm thiểu**: chỉ `image/*` và `text/*` được `inline`; `text/html` không nằm trong allowlist.

## Security Considerations

- Không trả `blob_path` trong bất kỳ response nào (có test riêng).
- Không log body; lỗi schema nêu tên trường thiếu, không echo giá trị.
- `nosniff` trên mọi response attachment để trình duyệt không tự đoán loại.
- Trần body chỉ áp cho đúng path `/attachments`.

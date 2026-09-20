---
phase: 4
title: "Journey đính kèm và evidence"
status: done
priority: P1
effort: "3h"
dependencies: [3]
---

# Phase 4: Journey đính kèm và evidence

## Context Links

- Phase 3: composer, block `attachment`, `attachmentBrief`, tool `read_attachment`
- `apps/web/e2e/secret-input.spec.ts` — mẫu journey một tính năng mới
- `apps/web/e2e/widget.spec.ts` — mẫu bám `data-*` và ghi evidence PNG
- `playwright.config.ts:33` — `testDir: "./apps/web/e2e"`, chỉ project chromium
- `apps/runtime/src/main.ts:124-127` + `packages/core/src/conductor.ts:433-450` — fixture model chạy
  **trước** lượt model và chỉ nhận `input.text`, nên nó **không** nhìn thấy brief attachment

## Goal

Chứng minh hai nửa của tính năng bằng đúng harness nhìn thấy được chúng: nửa người dùng thấy (chip,
gửi, block đã lưu, reload) bằng Playwright thật; nửa model nhận (nội dung file trong prompt, không có
path) bằng vitest ở seam adapter. Đây là cổng ra của **Stage A**.

## Ranh giới bằng chứng (đọc trước khi viết test)

Fixture `CC_MODEL_FIXTURE=1` chạy `composeFromIntent` trước lượt model; nếu nó trả lời thì lượt model bị
bỏ qua. Vì vậy **không** thể dùng fixture để chứng minh "nội dung file tới model": fixture không bao giờ
thấy prompt. Bằng chứng đó thuộc `apps/runtime/test/attachment-in-turn.spec.ts` (Phase 3 Task 3.3) với
`FakePiAdapter`. Journey trong file này chỉ khẳng định những gì một trình duyệt thật sự quan sát được.

## Files to Create / Modify

- Create: `apps/web/e2e/attachments.spec.ts`
- Create: `plans/reports/evidence/attachment-*.png` (do test sinh, gitignored)

## Tests Before (viết trước, phải đỏ)

`apps/web/e2e/attachments.spec.ts`:

1. `"the attach button is enabled and offers a file input"` — `[data-attachment-input]` tồn tại, nút
   `aria-label="Đính kèm"` không còn `disabled` và không còn `title` nói chưa hỗ trợ.
2. `"two attached files show chips with name, size and state"` — 1 text + 1 ảnh,
   `data-attachment-state="ready"`, chip nêu đúng dung lượng.
3. `"sending stores one attachment block per file in the timeline"` — sau khi gửi, timeline có block
   attachment cho **cả hai** file (đếm `[data-attachment-block]`).
4. `"the attachments are still in the timeline after a reload"` — reload, cuộn, thấy lại cả hai.
5. `"the image attachment renders as an image after reload"` — `<img>` có `naturalWidth > 0`, chứng minh
   byte đi qua `blob:` URL thật chứ không phải khung rỗng.
6. `"an oversized file is refused on the chip with a stated reason"` — buffer > 25 MB →
   `data-attachment-state="failed"` + text nêu ngưỡng.
7. `"a chip can be removed before sending"` — thêm rồi xoá, số chip về 0 và không có block nào được gửi.
8. `"a pasted image becomes a chip"` — dispatch `paste` với `DataTransfer`.
9. `"a declined type is refused before any request is made"` — `.exe`/`application/x-msdownload` → chip
   `failed`; đếm request tới `/attachments` bằng `page.route` và khẳng định **0**.

## Tasks & Steps

### Task 4.1 — Dựng journey và helper file mẫu

- **Goal**: test chạy được cục bộ và trong CI, không phụ thuộc file ngoài repo.
- **Target files and symbols**: `apps/web/e2e/attachments.spec.ts`, hằng số
  `EVIDENCE = join(process.cwd(), "plans", "reports", "evidence")` theo mẫu `apps/web/e2e/voice.spec.ts`.
- **Steps**:
  1. Sinh ảnh PNG 1×1 từ base64 tĩnh trong spec; sinh file `.md` bằng `Buffer.from(...)`.
  2. `setInputFiles` với `{ name, mimeType, buffer }`.
  3. Kéo-thả: `page.dispatchEvent("[data-composer-drop]", "drop", { dataTransfer })` với
     `dataTransfer` tạo qua `page.evaluateHandle`.
  4. Test 9 dùng `page.route("**/attachments", …)` đếm request rồi `unroute`.
- **Success criteria**: 9 test chạy hết (đỏ ở phần chưa có UI là đúng ở bước này).
- **Verify**: `pnpm test:e2e -- apps/web/e2e/attachments.spec.ts` exits non-zero với ≥ 1 test đỏ
  (đây là trạng thái đỏ **mong đợi**; xanh ngay nghĩa là test không kiểm gì).

### Task 4.2 — Evidence PNG

- **Goal**: có ảnh chứng minh UI, đúng quy ước repo.
- **Target files and symbols**: trong spec — `page.screenshot({ path: join(EVIDENCE, "attachment-composer-dark.png") })`
  sau khi có 2 chip; `attachment-timeline-light.png` sau reload (đổi theme bằng đúng đường
  `apps/web/e2e/appearance.spec.ts` đang dùng).
- **Steps**:
  1. `mkdirSync(EVIDENCE, { recursive: true })` như spec khác.
  2. Hai ảnh: một lúc soạn (dark), một sau reload (light) có ảnh render thật.
  3. Mở lại ảnh kiểm không lộ token; **không** `git add -f`.
- **Success criteria**: hai file PNG tồn tại sau khi test xanh.
- **Verify**: `ls plans/reports/evidence/attachment-*.png` liệt kê đúng 2 file.

### Task 4.3 — Nêu giới hạn vào report Stage A

- **Goal**: report của Stage A nói đúng điều đã và chưa chứng minh được.
- **Target files and symbols**: `plans/reports/verification-260919-stage-a-attachments.md`.
- **Steps**:
  1. Ghi rõ: prompt chứa nội dung text **đã** được chứng minh ở seam adapter (nêu tên test); ảnh/PDF tới
     model qua ref opaque + tool `read_attachment` → ghi BLOCKED kèm điều kiện còn thiếu. (Ghi chú thực thi:
     điều kiện đó nay **đã có** — PDF được trích văn bản ở PR #64, ảnh được giao nguyên block ảnh ở PR #66;
     report Stage A đã được đánh dấu tương ứng.)
  2. Ghi rõ: xoá blob theo conversation có hàm + test, nhưng **chưa** có route xoá conversation nên
     retention chưa chạy được từ UI; đây là gap có tên.
- **Success criteria**: report tồn tại, không câu nào nói "đã xong" cho phần BLOCKED.
- **Verify**: `test -f plans/reports/verification-260919-stage-a-attachments.md` exits 0.

## Refactor

Nếu journey vượt 300 dòng, tách phần sinh file mẫu sang `apps/web/e2e/attachment-fixtures.ts`.
Chạy lại **cùng** test.

## Tests After

`"a chip whose upload failed is not sent with the message"`.

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

- **Rủi ro**: file 25 MB trong test làm chậm suite. **Giảm thiểu**: buffer lớn sinh **một lần** trong
  suite; ghi chú chi phí trong comment.
- **Rủi ro**: `pnpm test:e2e -- <path>` vẫn build web. **Giảm thiểu**: chấp nhận; đó là cách duy nhất
  test chạy trên artifact thật.
- **Rủi ro**: dữ liệu e2e nằm ở `.data/e2e` dùng chung giữa các suite, nên test đếm block có thể thấy
  attachment của suite khác. **Giảm thiểu**: mỗi test tạo conversation riêng và chỉ đếm trong
  conversation của mình (`data-conversation` hoặc scoping theo `[data-message-id]` của lượt vừa gửi).

## Security Considerations

- Test không dùng dữ liệu thật; nội dung file là dữ liệu giả có chủ ý.
- Evidence PNG không được chứa token node; kiểm trước khi tham chiếu trong report.

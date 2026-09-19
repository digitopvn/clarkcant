---
title: "Stage A — tệp đính kèm: biên bản kiểm chứng"
status: done
stage: A
---

# Stage A — tệp đính kèm: biên bản kiểm chứng

Phạm vi: issue #17 §1 (tệp đính kèm tới được agent), Phase 1–4 của plan
`260919-0526-file-attachments-voice-bar-memory`.

Nhánh: `mrgoonie/feat-file-attachments-minimal-voice-bar-voice-co`. Commit: `c42db4a`, `7010a4b`,
`5a003bd`, `e98f8f6`, `6e298f6`, và commit journey của Phase 4.

## Điều đã được chứng minh

Mỗi dòng nêu **tên test** và **file**, vì một khẳng định không có tên test là một khẳng định không kiểm
được.

| Điều được khẳng định | Chứng minh ở đâu |
|---|---|
| Luật của contract từ chối path/URL, loại không nằm allowlist, quá trần, quá quota | `packages/contracts/test/attachments.spec.ts` — 12 test |
| Block `attachment` vào union và **bị** từ chối nếu mang `blobPath` | `packages/contracts/test/contracts.spec.ts` — `"a block that carries a disk path instead of a ref is refused"` |
| 4 route `/attachments` trả đúng mã lỗi, và **không** câu trả lời nào chứa đường dẫn đĩa | `apps/runtime/test/attachment-routes.spec.ts` — `"the response for an attachment never carries a disk path"` |
| Trần body 35 MiB áp cho **đúng** `/attachments`, các path khác không đổi | `apps/runtime/test/attachment-server.spec.ts` — `"leaves every other path's behaviour exactly as it was"` |
| Nội dung tệp text **tới** prompt của lượt | `apps/runtime/test/attachment-in-turn.spec.ts` — `"a text attachment's content reaches the model prompt"` |
| Prompt **không** chứa ổ đĩa, gốc filesystem hay thư mục blob | `apps/runtime/test/attachment-in-turn.spec.ts` — `"the prompt for a turn with attachments contains no disk path"` |
| Ảnh tới model dưới dạng ref opaque, không phải pixel | cùng file — `"an image attachment reaches the model as an opaque ref, not as pixels"` |
| Ngân sách inline là của **lượt**, không phải của từng tệp | cùng file — `"the inline budget is shared across attachments in one turn"` |
| Tin nhắn đã lưu mang đúng một block cho mỗi tệp | cùng file — `"a stored user message carries one attachment block per attached file"` |
| Id không tồn tại / của principal khác / của conversation khác đều bị từ chối, và **không** nói id nào | cùng file — mục `authorising the ids a client sends` |
| `read_attachment` đọc được tệp text, cắt đúng trần, từ chối path và `..` | `apps/runtime/test/read-attachment-tool.spec.ts` |
| Tool khai **thật** rằng ảnh/PDF chưa có bộ trích nội dung | cùng file — `"answers honestly that a binary attachment has no extractor yet"` |
| Nút `+` bật, có input file, không còn câu "chưa hỗ trợ" | `apps/web/e2e/attachments.spec.ts` — `"the attach button is enabled and offers a file input"` |
| Hai tệp → hai chip đúng tên và đúng cỡ người đọc | cùng file — `"two attached files show chips with name, size and state"` |
| Gửi xong, timeline có đúng một block cho mỗi tệp | cùng file — `"sending stores one attachment block per file in the timeline"` |
| Tải lại trang, tệp **vẫn** còn trong timeline | cùng file — `"the attachments are still in the timeline after a reload"` |
| Ảnh render thật sau reload (`naturalWidth > 0`) | cùng file — `"the image attachment renders as an image after reload"` |
| Tệp quá lớn bị từ chối ngay trên chip, kèm đúng con số | cùng file — `"an oversized file is refused on the chip with a stated reason"` |
| Loại bị từ chối thì **không** có request nào được gửi | cùng file — `"a declined type is refused before any request is made"` (đếm request bằng `page.route`) |
| Chip xoá được trước khi gửi, và không có block nào được gửi | cùng file — `"a chip can be removed before sending"` |
| Dán ảnh từ clipboard thành chip, tên suy ra từ loại | cùng file — `"a pasted image becomes a chip"` |
| Chip hỏng **không** được gửi kèm, chip đó vẫn ở lại kèm lý do | cùng file — `"a chip whose upload failed is not sent with the message"` |

Ảnh bằng chứng: `plans/reports/evidence/attachment-01-composer-dark.png` (lúc soạn, 2 chip) và
`plans/reports/evidence/attachment-02-timeline-light.png` (sau reload, ảnh render thật). Cả hai do
chính e2e sinh ra, gitignored, đã mở kiểm: không có token của node trong ảnh.

## Điều **chưa** được chứng minh — BLOCKED, kèm điều kiện còn thiếu

1. **Model không nhìn thấy pixel của ảnh/PDF.** Adapter `prompt(sessionId, text)` chỉ nhận text, và node
   chưa có bộ trích nội dung nhị phân. Điều đã làm: prompt nêu id và nói rõ tool nào đọc được, và tool
   `read_attachment` trả lời thật rằng chưa có bộ trích. **Điều kiện còn thiếu:** một bộ trích PDF/ảnh
   (hoặc một lượt model nhận ảnh) cùng một test ở seam adapter. Không được đọc dòng nào ở trên thành
   "model đã đọc được ảnh".
2. **Xoá blob theo conversation chưa chạy được từ UI.** `releaseConversationAttachments` có hàm và có
   test (`apps/runtime/test/attachments.spec.ts`), nhưng node **không có** route xoá conversation: bốn
   bảng tham chiếu `conversations` mà không `ON DELETE CASCADE` và `PRAGMA foreign_keys = ON`, nên xoá
   một conversation cần một chính sách riêng (task đang chạy thì sao?) chứ không phải hệ quả phụ của
   thay đổi về attachment. **Điều kiện còn thiếu:** route xoá + chính sách cho task/công việc đang chạy.
   Đây là gap có tên, không phải bỏ sót.
3. **Không có test nào chứng minh "nội dung tệp tới model" trong trình duyệt**, và điều đó là **cố ý**:
   fixture `CC_MODEL_FIXTURE=1` chạy `composeFromIntent` **trước** lượt model và chỉ nhận `input.text`,
   nên nó không bao giờ thấy prompt. Bằng chứng đó nằm ở seam adapter trong vitest. Không có kết luận nào
   ở đây suy ra từ journey trình duyệt về nội dung prompt.

## Sai lệch so với plan (đã ghi vào `plan.md`)

- `attachmentQuotaDecision` không được viết — luật quota nằm một chỗ trong
  `validateAttachmentCandidate`.
- Đọc magic bytes của ảnh dùng chung `detectImageFormat` trong `blobs.ts` thay vì định nghĩa lần hai.
- `createNodeServer` thêm seam `bodyLimitFor` để trần body test được bằng một con số nhỏ.
- `extraTools` nhận thêm `turn: { conversationId }` để `read_attachment` kiểm được quyền.
- `attachmentRefsForLastUserMessage` nằm trong `apps/runtime/src/attachments.ts` (không phải inline
  trong `main.ts`) để test được; test dùng đúng hàm của node.
- `useImageUrls` rút về `useObjectUrls` dùng chung với `useAttachmentUrls`.
- **Chưa làm, có tên:** tách composer thành `composer.tsx`. `Conversation.tsx` hiện 1594 dòng (ngưỡng
  của plan ~1500). Việc tách thuộc một commit riêng với đúng các `data-*` attribute mà journey Phase 4
  vừa ghim; làm trong cùng commit tính năng sẽ khiến một thay đổi cơ học và một thay đổi hành vi không
  tách được khi review.

## Cổng hồi quy

- `pnpm verify`: xanh — 7 invariant, typecheck, lint, 1099 unit test.
- `pnpm test:e2e`: 10/10 test của `apps/web/e2e/attachments.spec.ts` xanh; toàn suite 47 xanh / **4 đỏ
  có trước**, không thuộc Stage A. Điều kiện còn thiếu của từng test, lấy từ chính thông báo lỗi:
  - `appearance.spec.ts:229` `"the model in use is what the fields show before anybody types"` —
    `locator('[data-search-input=\'model\']')` **không tìm thấy phần tử**. Cần tab Models có ô tìm model
    theo catalogue của node, thuộc settings-tabs phần providers.
  - `onboarding.spec.ts:86` `"shows the name, the tagline and one way in, and does not come back"` —
    sau khi bấm `[data-onboarding-start]`, `[data-onboarding='true']` vẫn còn **1** phần tử: màn hình
    onboarding chưa tự đóng. Thuộc onboarding-v2.
  - `onboarding.spec.ts:110` `"walks the steps it still needs, in order, and never echoes the key"` —
    `[data-onboarding-key='typesafe']` không tìm thấy. Cùng thuộc onboarding-v2.
  - `j1.spec.ts:204` `"a selected passage can be sent to a background session"` — node trả
    `BACKGROUND_REFUSED: node này không có model để chạy việc nền`. Thuộc background worker (Stage B).

  Cả bốn nằm trong danh sách chưa làm của plan. `git diff --stat 7f3127f..HEAD` cho thấy thay đổi của
  Stage A không chạm `SettingsPanel.tsx`, `App.tsx` (onboarding), `selection-toolbar` hay đường chạy nền.
  **Giới hạn của kết luận này:** chưa chạy lại bốn test đó ở commit cơ sở `7f3127f` trong worktree riêng,
  nên "có trước" dựa trên phân tích diff cộng với tên điều kiện còn thiếu ở trên, không phải trên một lần
  chạy đối chứng. Nếu muốn chắc chắn tuyệt đối thì đó là việc phải làm trước khi merge PR Stage A.

## Ghi chú an toàn

- Không prompt nào chứa đường dẫn đĩa; có test riêng khẳng định điều đó, và `read_attachment` không có
  tham số path nên không có gì để thoát ra.
- Tên tệp được redact ở node trước khi lưu và trước khi trả về; React tự escape khi render.
- Nội dung tệp là văn bản không tin cậy: prompt nói rõ đó là **dữ liệu**, không phải chỉ dẫn, và tool đọc
  chỉ đọc được attachment thuộc đúng principal + conversation. Phase này **không** mở rộng bề mặt của
  `search_files`.

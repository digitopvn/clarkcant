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
| Tool đọc **nội dung** của ảnh và PDF, không chỉ nêu tên | cùng file — `"hands a picture over as a picture rather than describing it"` (block ảnh cho SDK, PR #66) và `"reads the text out of a pdf rather than naming it"` (PR #64) |
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

1. **ĐÃ ĐÓNG — không còn là gap.** Ban đầu: model không nhìn thấy nội dung của ảnh/PDF, vì
   `prompt(sessionId, text)` chỉ nhận text và node chưa có bộ trích nội dung nhị phân. Nguyên nhân thật hoá ra
   nằm ở adapter: union nội dung của tool result **có** member ảnh (`{ type: "image", data, mimeType }`), và
   `toSdkTool` gộp mọi kết quả thành một block text. Nay PDF được trích văn bản
   (`apps/runtime/src/pdf-text.ts`, PR #64) và ảnh được giao nguyên block ảnh (PR #66), với test ở cả hai
   seam: `packages/pi-adapter/test/pi-adapter.spec.ts` — "hands the image to the SDK as an image block, not as
   a sentence about one" — và `apps/runtime/test/read-attachment-tool.spec.ts` — "hands a picture over as a
   picture rather than describing it".
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
    `locator('[data-search-input=\'model\']')` **không tìm thấy phần tử**. Node mà e2e boot không cấu
    hình model (nó dùng `CC_MODEL_FIXTURE=1`, fixture thay cả lượt model), và tab Models không render ô
    tìm model trong trạng thái đó. **Không** phải vì thiếu catalogue: `RealPiAdapter.catalogue()` và
    route model đã có trên `7f3127f`. Điều kiện còn thiếu: hoặc node e2e có một model cấu hình, hoặc
    tab Models render trường đó cả khi chưa có model.
  - `onboarding.spec.ts:86` `"shows the name, the tagline and one way in, and does not come back"` —
    sau khi bấm `[data-onboarding-start]`, `[data-onboarding='true']` vẫn còn **1** phần tử: màn hình
    onboarding chưa tự đóng. Thuộc onboarding-v2.
  - `onboarding.spec.ts:110` `"walks the steps it still needs, in order, and never echoes the key"` —
    `[data-onboarding-key='typesafe']` không tìm thấy. Cùng thuộc onboarding-v2.
  - `j1.spec.ts:204` `"a selected passage can be sent to a background session"` — node trả
    `BACKGROUND_REFUSED: node này không có model để chạy việc nền`. Thuộc background worker (Stage B).

  Cả bốn nằm ngoài Stage A. `git diff --stat 7f3127f..HEAD` cho thấy thay đổi của Stage A không chạm
  `SettingsPanel.tsx`, `App.tsx` (onboarding), `selection-toolbar` hay đường chạy nền.

### Chạy đối chứng ở commit cơ sở — "có trước" là số đo, không phải suy luận

Đã chạy lại **đúng ba file đó** ở `7f3127f` trong một worktree riêng (`D:/orca/clarkcant/base-control`),
cài đặt riêng, cùng lệnh (`pnpm exec playwright test apps/web/e2e/appearance.spec.ts
apps/web/e2e/onboarding.spec.ts apps/web/e2e/j1.spec.ts`) và cùng fixture của config:

```
23 passed, 4 failed
```

Bốn test đỏ ở commit cơ sở **trùng đúng** bốn test đỏ trên nhánh, cùng dòng và cùng assertion:
`appearance.spec.ts:229` (`[data-search-input='model']` không có), `j1.spec.ts:204`
(`BACKGROUND_REFUSED`), `onboarding.spec.ts:86` (`[data-onboarding='true']` còn 1 phần tử),
`onboarding.spec.ts:110` (`[data-onboarding-key='typesafe']` không có). Vậy chúng có trước nhánh này và
không do Stage A gây ra.

Nguyên nhân gần của `appearance.spec.ts:229`, đọc từ code: `SettingsPanel.tsx` chỉ render ô đó khi
catalogue provider **không rỗng**, mà catalogue đến từ `services.modelCatalogue()` — chỉ được nối sau
khi boot dựng được model turn. Node của suite này chạy `CC_MODEL_FIXTURE=1` nên tab hiện câu “Node chưa
báo provider nào”. Đây là điều kiện của fixture test, không phải tính năng còn thiếu — **không** sửa
nó trong PR này: sửa một test đỏ không liên quan bên trong diff của một tính năng là trộn hai việc mà
người review không tách được.

### CI có phải cổng chặn không

`.github/workflows/ci.yml` chạy `pnpm run invariants`, `typecheck`, `lint`, `pnpm run test` (unit),
probe Pi SDK và secret scan — **không** chạy `pnpm test:e2e`. Bốn test đỏ ở trên không chặn merge; chúng
cần một quyết định (ai sở hữu, sửa fixture hay sửa kỳ vọng), không phải một cổng.

## Ghi chú an toàn

- Không prompt nào chứa đường dẫn đĩa; có test riêng khẳng định điều đó, và `read_attachment` không có
  tham số path nên không có gì để thoát ra.
- Tên tệp được redact ở node trước khi lưu và trước khi trả về; React tự escape khi render.
- Nội dung tệp là văn bản không tin cậy: prompt nói rõ đó là **dữ liệu**, không phải chỉ dẫn, và tool đọc
  chỉ đọc được attachment thuộc đúng principal + conversation. Phase này **không** mở rộng bề mặt của
  `search_files`.

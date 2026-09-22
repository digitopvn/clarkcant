# Code review — Widget Library / Widget Lab (pending changes)

Phạm vi: `git diff` + file mới trên nhánh `feat-ui-add-widget-library-widget-lab-as-a-live`
(25 file sửa, 14 file/thư mục mới). Review-only; mọi phát hiện dưới đây kèm file:line và bằng chứng.

**Verdict sau khi sửa: 0 Critical, 0 Important. 3 Minor, cả 3 được chấp nhận kèm lý do (bên dưới).**

## C1 (Critical, đã tìm ra và đã sửa) — phrase mới đầu độc bảng `COMMAND_OPENERS`

Tìm bởi `pnpm verify:full`, không phải bởi review tay: `apps/web/e2e/widget.spec.ts:194`
("a gallery widget draws pictures the node actually holds") fail, và error-context cho thấy câu trả lời
là **"Tôi chưa hiểu câu lệnh đó"** — tức app-intent từ chối, chứ không phải model trả lời.

**Cơ chế.** `packages/core/src/app-intents.ts` suy ra `COMMAND_OPENERS` từ **mọi** phrase:
`PHRASES.map((entry) => entry.phrase.split(" ").slice(0, 2).join(" "))`. Phrase tôi thêm
`"thu vien widget"` vì thế đóng góp opener `"thu vien"`, và `"mo thu vien widget"` đóng góp `"mo thu"`.
`isAppCommandShaped` chấp nhận **mọi** câu bắt đầu bằng opener đó, nên `"thư viện ảnh"` (việc thật, phải tới
agent) trở thành command-shaped, không khớp phrase nào, và bị từ chối. `"mở thư viện ảnh"` cũng vậy.

**Sửa tại gốc.** `COMMAND_OPENERS` chỉ suy ra từ phrase không thuộc `widgets.open`/`widgets.show`; bỏ phrase
`"thu vien widget"` (không có động từ mở đầu thì nó không command-shaped, giữ lại là một dòng nói dối trong
bảng). Câu về widget vẫn được shape bằng luật "control verb + noun" vì `"widget"` đã có trong `APP_NOUNS` và
`"mở"`/`"hiện"`/`"show"` có trong `CONTROL_VERBS`. Kèm comment ghi rõ regression này.

**Kiểm chứng.** `pnpm exec vitest run packages/core/test/app-intents-widgets.spec.ts
packages/core/test/app-intents.spec.ts packages/contracts/test/app-intents-widgets.spec.ts` → 35 passed.
`pnpm exec playwright test apps/web/e2e/widget.spec.ts apps/web/e2e/widget-library.spec.ts` → **12 passed**
(gallery 2.9s, không còn timeout).

Bài học: một bảng suy ra từ dữ liệu khác sẽ âm thầm mở rộng phạm vi khi thêm dữ liệu; test E2E có sẵn của
repo là thứ bắt được nó, còn review tay đã bỏ sót.

## Đã kiểm và đạt

- **Không có control giả.** `WidgetPropsForm.tsx:66-71` đánh dấu kiểu phức tạp là *không hỗ trợ* kèm
  giải thích thay vì bỏ qua im lặng; `WidgetPropsForm.tsx:24-35` chỉ commit sau khi `validateProps` (đúng
  hàm host dùng) chấp nhận. `WidgetGallery.tsx:66-70` cho widget media thấy text alternative của chính
  renderer qua `data-widget-preview-deferred`, không mount embed.
- **Không có renderer thứ hai.** Preview gọi `resolveRenderer` production
  (`WidgetPreview.tsx:56` mang `data-widget-preview={definition.id}`); definition thiếu renderer hiện
  `data-widget-preview-missing` kèm lý do. E2E khẳng định từng card hoặc render hoặc nói lý do.
- **Duyệt catalog không gọi bên thứ ba.** E2E `browsing the catalog does not fetch third-party media`
  theo dõi request và khẳng định không có `youtube.com`/`ytimg.com`/`googlevideo.com`/`youtu.be`.
- **Một nguồn cho wording trust lane.** `package-provenance.ts:11-16` là chỗ duy nhất định nghĩa nhãn
  lane; `ExtensionsSettings.tsx` và `InstalledProvenance.tsx` cùng import, và test khẳng định hai lane
  khác nhau không dùng cùng câu chữ (`package-provenance.spec.ts`, "does not word two different lanes the
  same way") — đúng điều AGENTS.md gọi là sai lầm mà danh sách đó tồn tại để chặn.
- **Không nới trust lane.** Không có đường nào cho widget cách ly chạm credential/OS consent; phần
  provenance chỉ đọc metadata node đã báo.
- **Fixture là data.** `fixture-schema.spec.ts` chạy `widgetFixtureSchema` (strict) trên toàn bộ fixture
  và khẳng định một fixture mang payload thực thi bị từ chối — schema này trước đó là code chết.
- **Không rò secret.** `provenanceRows` cố ý không mang `artifactUrl`; test khẳng định điều đó.
- **Không rò node internals vào UI mặc định.** Danh sách gói chỉ có trong thư viện/Lab, không ở màn hình
  hội thoại mặc định.
- **Invariant.** `pnpm run invariants` 8/8 PASS, gồm `browser-entries-avoid-node-builtins` (111 module).

## Minor (được chấp nhận, không chặn ship)

### M1. Ô nhập props commit theo từng phím và revert khi giá trị trung gian không hợp lệ

`packages/conversation-client/src/widget-library/WidgetPropsForm.tsx:84-99`: `onChange` gọi `commit`
mỗi lần gõ; khi `validateProps` từ chối, preview giữ props tốt cuối cùng (hành vi cố ý, ghi ở đầu file)
nhưng `value` của input bind vào `props[field.key]`, nên ô nhập quay về giá trị cũ.

Hệ quả thực tế: với ô số có `minimum: 1`, xoá trắng cho `Number("") === 0` → bị từ chối → ô không xoá
được; muốn đổi phải bôi đen rồi gõ đè. Với chuỗi thì không gặp.

Chấp nhận vì: đây là surface developer-only; hành vi "giữ props tốt cuối" là quyết định có chủ ý và được
ghi trong file; và đường JSON nâng cao (`data-widget-props-raw` + `data-widget-props-apply`) là lối sửa
thay thế đã có, có validate. Không sửa trong PR này để tránh đổi hành vi bàn phím ngay trước khi ship.

### M2. Tie-break của `findWidgetTarget` dựa vào tính ổn định của `Array.prototype.sort`

`packages/core/src/app-intents.ts:328-336`: sort theo độ dài phrase giảm dần rồi lấy match đầu tiên.
Hai widget có alias cùng độ dài (`registry.ts:56,62`: "biểu đồ" là alias của cả `canvas.line@1` và
`canvas.bar@1`) hoà nhau, và kết quả phụ thuộc thứ tự chèn — ổn định trong JS hiện đại nhưng là phụ thuộc
ngầm.

Chấp nhận vì: kết quả tất định trên engine hiện tại, và hành động này chỉ *xem* (mở thư viện ở một widget),
không bao giờ chọn effect. Ghi lại để nếu sau này matcher dùng cho hành động có tác dụng phụ thì phải
tie-break tường minh.

### M3. `widgetTargetsFromCatalog()` dựng lại bảng mỗi lần gọi

`apps/runtime/src/main.ts:125-133` dựng bảng phrase từ `libraryEntries()` mỗi lần `appIntentDepsFor`
chạy. Chấp nhận: vài chục entry, chi phí không đáng kể, và tránh một cache có thể cũ khi catalog đổi.

## Ghi chú về hai quyết định đã thay đổi so với văn bản issue

Không phải phát hiện review mà là scope delta cần người dùng xác nhận (đã ghi ở `plan.md`):

1. Installed/local **không** thành card trong catalog (R4): không route nào expose widget
   definition/fixture/renderer của package, nên chúng được báo như provenance trên danh sách riêng.
2. `clark widget dev --builtin <id>` không được thêm (R8): dev host phục vụ facet entry của package,
   không phải catalog renderer.

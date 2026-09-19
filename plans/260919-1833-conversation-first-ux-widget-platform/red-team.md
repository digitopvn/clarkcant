# Red-team answers

Plan `260919-1833-conversation-first-ux-widget-platform`, mục "Red-team questions bắt buộc trước khi
bắt đầu mỗi Stage". Mỗi stage trả lời những câu thuộc stage đó **trước khi** bắt đầu, và câu trả lời
phải dựa trên code đã ship chứ không dựa trên ý định.

Quy ước: mỗi câu trả lời nêu kết luận trước, rồi tới bằng chứng, rồi tới những chỗ **không** đạt kèm
việc đã sửa. Một câu trả lời chỉ nói "không sao" mà không chỉ ra chỗ đã kiểm thì không tính là trả lời.

---

## Stage D — Phase 9 (JIT onboarding) và Phase 10 (P0 agentic widget catalog)

### Câu 1 — Feature này có đang leak Pi/Jev/node concept lên default UI không?

**Kết luận: có, ba chỗ. Cả ba đã sửa trong cùng change này.** Đây là câu hỏi có kết quả thật, không
phải câu hỏi để tick.

Ba chỗ leak:

1. **Thẻ phiên browser/desktop in ra "Lease epoch"** — một con số giao thức. Tệ hơn, nó do chính
   Phase 10 này thêm vào, kèm một lý lẽ nghe hợp lý ("không thấy epoch thì không biết takeover có hiệu
   lực không"). Lý lẽ đó sai chỗ: thứ người đọc cần biết là **kết quả** — hành động agent đã lên kế
   hoạch đã bị từ chối — và câu đó đã có sẵn trong thông báo. Con số vẫn còn, nhưng là
   `data-control-epoch` cho test đọc, không phải chữ cho người đọc.
2. **Thẻ artifact in `từ <originNodeId>`** — node id thô. Nay là "từ một node khác": cùng thông tin
   hữu ích, không lộ tên nội bộ.
3. **Thẻ task fallback về node id thô** khi node không có label. Nay cũng là "một node khác".

Những chỗ đã đúng và được xác nhận lại:

- Settings theo 6 tab do người dùng đặt tên; Pi internals chỉ còn trong tab Developer (Phase 4).
- Onboarding mới không hỏi node: setup card nói provider/model/key, là ba thứ người dùng sở hữu.
- Thẻ hội thoại hiển thị nội dung, không hiển thị id trừ khi id **là** nội dung (ví dụ task id trong
  thông báo dừng task, nơi người dùng cần nó để đối chiếu).

Điều còn lại chưa làm, nói rõ: các thẻ vẫn hiện **digest** trong khối artifact khi mở lại. Digest là
dữ kiện của node, nhưng nó cũng là thứ duy nhất trả lời được "có đúng file này không", nên nó ở lại;
đây là chỗ một reviewer có thể phản đối và nên phản đối nếu thấy chưa đủ lý do.

### Câu 10 — Một design target chưa implement có bị UI/docs quảng cáo như shipped không?

**Kết luận: UI thì không; có ba khoảng trống được ghi lại thay vì quảng cáo.**

UI không nói dối ở những chỗ đã ship:

- Wake word: không có detector local nào ship, nên toggle **không dùng được và nói rõ lý do** (Phase 8).
- Voice preview: adapter trả `supportsPreview: false` kèm lý do, không có nút giả (Phase 6).
- Phiên desktop: mặc định `needs-permission`, thẻ nói quyền thuộc hệ điều hành và node không tự cấp
  được; không vẽ preview giả (Phase 10).
- `WIDGET_RUNTIME_STATUS` khi đó vẫn là `bridge-codec-implemented-runtime-pending`, tức là nó nói thật là chưa
  có runtime. Phase 11 đã đổi thành `runtime-and-host-session-implemented` (PR #44), và giá trị mới cũng nói rõ
  hai điều **chưa** đúng: chưa có mini-app nào ship, và conversation client chưa mount frame nào.

Ba khoảng trống, ghi lại chứ không quảng cáo:

1. **Artifact chưa có producer thật.** Bảng, route, control đều thật; không có gì trong sản phẩm tạo
   ra artifact, nên đường này chỉ tới được bằng fixture. Đã nêu trong PR #37 và trong commit.
2. **Phiên browser/desktop chưa có launcher thật.** Mô hình quyền (lease, takeover, stop) là thật và
   có test; không có chỗ nào trong sản phẩm **mở** một phiên, nên hiện chỉ fixture tạo được. Đã nêu
   trong PR #39 và #40.
3. **DESIGN.md mô tả target, không mô tả shipped.** AGENTS.md cho phép điều đó, và chưa có câu nào
   trong DESIGN.md được viết như thể Phase 11–13 đã xong.

Hệ quả cho Stage D: stage này đóng được, nhưng hai khoảng trống (1) và (2) là **nợ kỹ thuật có tên**,
không phải chi tiết bỏ qua. Nếu Phase 11–13 ship runtime mà không có producer nào chạm tới ba widget
đó, thì catalog P0 sẽ mãi là thứ chỉ fixture chạm tới.

---

## Stage E — Phase 11 (Widget SDK runtime) và Phase 12 (Widget CLI)

### Câu 9 — Widget author API có thêm quyền generic chỉ vì dev convenience không?

**Trả lời trước khi bắt đầu (contract h), và đây là điều Phase 11–12 sẽ bị soi lại:**

Không, và có ba chỗ dễ trượt mà tôi cam kết giữ:

1. **Không có `invoke` generic.** Frame chỉ gửi được những message **có tên** trong codec đã có, và mỗi
   message đi qua một hàm host validate riêng. Một `{type: "invoke", method, args}` sẽ biến bridge
   thành RPC tới mọi thứ host làm được — đó chính là thứ Phase 12 dễ muốn thêm vì test cho nhanh.
2. **Quyền nằm trong manifest, không nằm trong lời gọi.** Capability phải khai báo trước và được duyệt
   như dữ liệu; runtime không cấp thêm quyền vì widget "cần". Capability simulator trong dev host mô
   phỏng **quyền đã khai báo**, không phải quyền tùy ý.
3. **Dev host không nới quyền so với production.** Cùng codec, cùng sandbox policy; chỉ khác nguồn
   bundle và có inspector. Nếu `npm run dev` cho widget làm được điều mà bản pack không làm được thì
   đó là bug của dev host.

Cách kiểm: test bị từ chối là test ngang hàng với test thành công — forged nonce, sai source window,
message không có trong codec, capability chưa khai báo, và vượt budget đều phải **fail** có tên. Nếu
Phase 11–12 chỉ có test happy path thì câu này coi như chưa trả lời.

---

## Stage F — Phase 13 (Package Marketplace & directory)

### Câu 8 — Marketplace có đang bypass exact digest/generation/rollback không?

**Trả lời trước khi bắt đầu (contract h), và đây là điều Phase 13 sẽ bị soi lại:**

Không, và có bốn chỗ dễ trượt mà tôi cam kết giữ:

1. **Không installer thứ hai.** Mọi nguồn — local path, git exact ref, npm exact version — đều đi qua
   `joinOrCreatePlan` → `advanceInstall` → `activateGeneration` như hiện có. Marketplace chỉ là một
   **nguồn resolve**: nó tạo ra cùng một `InstallPlan`, không tạo ra đường cài riêng.
2. **Digest không được nới.** Một nguồn chỉ được chấp nhận khi resolve ra đúng digest đã công bố.
   "Cài từ marketplace" không phải lý do để bỏ qua kiểm tra digest, và một lần cài không có digest
   phải bị từ chối chứ không phải được mặc định.
3. **Generation/rollback giữ nguyên.** Cài xong vẫn tạo generation mới và vẫn rollback được khi
   healthcheck fail. Marketplace không được phép "cài trực tiếp" để tránh bước stage.
4. **Risk lane được label, không bị trộn.** Isolated UI, tool/service và native Pi extension là ba
   lane khác nhau; UI phải nói rõ lane nào, vì native extension là code chạy cùng tiến trình còn
   isolated widget thì không.

Cách kiểm: test cho một nguồn có digest sai phải **fail**, và test rằng rollback đưa về generation
trước đó. Nếu Phase 13 chỉ có test happy path của install thì câu này coi như chưa trả lời.

---

## Stage G — Phase 14 (polish, accessibility, performance & release gates)

### Câu 10 — Một design target chưa implement có bị UI/docs quảng bá như shipped không?

**Trả lời lại ở đây vì Stage G chính là stage release gate**, và câu trả lời bây giờ khác Stage D ở một chỗ
quan trọng.

Đã đúng:

- UI không tự nhận đã làm điều chưa làm: wake word disable kèm lý do, voice preview báo `supportsPreview:
  false`, phiên desktop mặc định `needs-permission`, danh sách gói nói rõ khi chưa cài gì.
- `docs/widget-development.md` giờ có mục "Trạng thái triển khai" nói thẳng phần nào đã có và phần nào chưa
  (publish, script trong trang của dev host, detach, MCP Apps).
- Ledger chỉ được nâng khi test tồn tại: V12 nêu tên ba test của phase 11 và vẫn giữ MCP Apps là chưa chứng
  minh.

**Chỗ chưa đúng, và đây là phát hiện của chính stage này:** runtime và frame session đã có, conformance đã
chạy được trên package thật — nhưng **conversation client không mount một frame isolated nào cả**. Không có
`sandbox=`, không có `iframe` trong `mini-app-surface.tsx`; surface hiện được vẽ như một `figure` với dữ liệu
đã chụp. Nghĩa là "executable widget platform" đúng ở tầng package và **chưa chạm tới bề mặt người dùng**.

Hệ quả trực tiếp cho Phase 14: ba mục performance của phase — lazy mount widget nặng, offscreen suspend, và
"không duplicate live subscription sau detach" — **không có gì để gắn vào**. Không thể viết test cho một frame
chưa được mount, và viết wiring rồi tự test nó trong cùng một change là cách tự xác nhận mình. Nên chúng được
báo là thiếu, không được đánh dấu xong.

### Câu 4 — Orb personalization có thể gây GPU runaway/unbounded physics/CSS injection không?

Kiểm lại ở stage này:

- Physics bị chặn bởi bộ preset + clamp có test (`orb-profile.spec.ts`), và giá trị lưu là tên preset chứ
  không phải shader source — nên không có đường CSS/GLSL tuỳ ý từ Settings.
- Vòng lặp pointer nằm ngoài React state, và stage này thêm test rằng canvas không bị dựng lại khi pointer
  quét qua (20 lần di chuyển, cùng một element).
- Vòng lặp dừng khi offscreen: `Orb.tsx` dùng `IntersectionObserver`.
- Reduced motion thắng: bộ token `reduced` là bộ riêng, và test khẳng định mọi key của bộ đầy đủ đều có bản
  reduced (một key thiếu sẽ âm thầm giữ nguyên giá trị full-motion).

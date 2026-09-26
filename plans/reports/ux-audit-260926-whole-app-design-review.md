# Audit UI/UX toàn bộ ClarkCant: phân tích và đề xuất cải tiến — 2026-09-26

Phạm vi:
- ứng dụng hội thoại (`apps/web` và `packages/conversation-client`, bản mà Electron nạp);
- các bề mặt phụ: Settings, Inbox, Widget Library/Marketplace, widget chrome;
- nền tảng design system (`packages/design-tokens`, `styles/**`);
- website chính thức `clarkcant.cc` (repo `digitopvn/clarkcant-web`, commit `c72a7ba`).

Chuẩn đối chiếu: `DESIGN.md`, `AGENTS.md`, WCAG 2.2 và các nguồn ở cuối báo cáo.

Báo cáo này nối tiếp audit ngày 24/09 (`ux-audit-260924-clarkcant-polish.md`). 14 lỗi bố cục đã sửa trong lần đó không được lặp lại ở đây: tab cuộn ở 375 px, target 44 px, segmented control, setup card, phím tắt theo nền tảng, font CSP.

## Kết luận

Nền móng của ClarkCant vững:
- Orb là một canvas duy nhất, đi liền mạch từ hero xuống dock.
- Root công bố trạng thái qua `data-agent-state`, `data-input-modality`, `data-policy-mode`.
- Modal có focus trap và trả focus đúng chỗ.
- Secret là write-only.
- Chữ đạt 4.5:1 ở cả hai theme, focus ring đạt từ 6.1:1 trở lên.
- Website trung thực ở thẻ Status.

Vấn đề không nằm ở hướng thiết kế. Nó nằm ở chỗ code đang trôi khỏi các quy tắc mà chính DESIGN.md đặt ra. Có năm nhóm cần xử lý:

1. **Quyền kiểm soát trong chế độ Autonomous chưa có thật.**
   - Không có nút Stop cho lượt đang chạy (C-01).
   - Không gửi được tin mới khi Clark đang bận (C-02).
   - Composer không xoá nội dung sau khi gửi thành công (X-01, một regression mới). Người dùng dễ gửi trùng.
2. **UI chưa trung thực về dữ liệu và kết quả.**
   - Snapshot cũ mang nhãn "vừa đọc" (S-01).
   - Note báo "Đã lưu." khi không có gì được lưu (S-02).
   - Lỗi đọc hiển thị như danh sách trống (S-03, S-10).
   - Website hứa những năng lực mà chính thẻ Status ghi là "Not yet" (W-03).
3. **Motion vi phạm grammar của chính nó.**
   - Bounce chạy trên chữ body và nối chuỗi nhau (F-02, C-18).
   - Tin nhắn "đến" hai lần khi lượt kết thúc (C-04, F-03).
   - Tuỳ chọn "Giảm chuyển động" trong app chỉ tác động lên Orb (F-01).
   - Helper motion dùng chung chưa có caller nào (F-04).
4. **Thuật ngữ nội bộ và tiếng Anh lọt vào UI tiếng Việt mặc định.** Ví dụ: recipe, capability ref, digest, ISO time, "Ready", "Allow — chạy tiếp", tên biến môi trường (X-03, X-05, S-11, S-19, S-24).
5. **Trợ năng còn các lỗ lớn.**
   - Live region đọc từng token (C-03, F-17).
   - Voice overlay không có Escape và không quản lý focus (C-08).
   - Không có rule `forced-colors` nào (F-13).
   - Viền control chỉ đạt 1.16–1.28:1 (F-08).
   - Lựa chọn multi-choice không hiện trạng thái (F-14).

Thống kê: 115 phát hiện, gồm 2 P0, 31 P1, 54 P2 và 28 P3.

| Nhóm | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| Kiểm tra trực tiếp trên trình duyệt (X) | 1 | 2 | 7 | 1 |
| Bề mặt hội thoại (C) | 1 | 7 | 11 | 8 |
| Bề mặt phụ (S) | 0 | 11 | 14 | 5 |
| Design system và trợ năng (F) | 0 | 7 | 10 | 6 |
| Website (W) | 0 | 4 | 12 | 8 |

Thang mức độ:
- **P0**: chặn lời hứa cốt lõi hoặc gây hành động ngoài ý muốn.
- **P1**: sai sự thật, mất dữ liệu, chặn luồng hoặc vi phạm quy tắc cứng của AGENTS.md.
- **P2**: khó hiểu hoặc sai loại control nhưng có đường vòng.
- **P3**: hoàn thiện.

## Phương pháp

- Chạy một node runtime cô lập bằng fixture provider (`CC_VOICE_FIXTURE`, `CC_MODEL_FIXTURE`, `CC_SESSION_FIXTURE`) trên port 8876, với data dir riêng, cộng bản build web qua `vite preview` ở port 4273. Không trỏ vào node dev nào.
- Chụp bằng Playwright (Chromium có sẵn, không chạy `playwright install`):
  - ứng dụng ở 1440×900, 760×900 và 390×844, theme sáng và tối;
  - onboarding, empty state, biểu đồ mẫu, tổng quan, 7 tab Settings, Widget Library, voice overlay và thanh voice thu gọn.
  - website ở 1440×900 và 390×844, sáng, tối và reduced motion; 15 lượt chạy trang.
- Tương phản được tính bằng `contrastRatio` của chính `@clarkcant/design-tokens`. `color-mix(in oklab)` được tính lại, và biến CSS được đối chiếu giữa `themeStylesheet()` và `APP_CSS`.
- Bốn luồng audit chạy song song: hội thoại, bề mặt phụ, nền tảng và website. Mình trực tiếp kiểm tra lại trên trình duyệt những phát hiện có nhãn X.
- Giới hạn:
  - Electron và thiết bị cảm ứng thật chưa được chạy.
  - Screen reader thật (NVDA, VoiceOver) chưa được dùng.
  - Các mục ghi "suy từ code" cần một e2e xác nhận trước khi sửa.

---

## 1. Ưu tiên cao nhất

Mười hai mục nên làm trước, xếp theo tác động lên niềm tin và khả năng dùng:

| # | ID | Mức | Vấn đề | Đề xuất ngắn |
|---|---|---|---|---|
| 1 | X-01 | P0 | Gửi thành công mà composer vẫn giữ nguyên nội dung | Xoá draft khi gửi được chấp nhận; khôi phục khi thất bại; thêm e2e |
| 2 | C-01 | P0 | Không có Stop cho lượt đang chạy trong chế độ Autonomous | Nút gửi biến thành Stop ở cùng vị trí; `AbortSignal` và route interrupt |
| 3 | C-02 | P1 | Enter khi đang bận không làm gì và không báo gì | Cho gửi giữa lượt; node quyết định steer, interrupt hoặc chạy nền, và UI báo kết quả |
| 4 | S-01, S-02, S-03 | P1 | Snapshot mang nhãn "vừa đọc", Note báo "Đã lưu." giả, lỗi đọc hiện như danh sách trống | Tách `snapshot` khỏi `live`; chỉ báo "Đã lưu" khi có kết quả thật; trạng thái ba nhánh có Thử lại |
| 5 | X-02 | P1 | Orb gần như biến mất ở theme sáng (đĩa trắng) | Sửa phép cộng emissive trong shader cho canvas sáng |
| 6 | C-04, F-03 | P1 | Tin nhắn vừa stream biến mất rồi nảy vào lại | Giữ danh tính DOM khi chuyển live→settled; chỉ animate hàng thật sự mới |
| 7 | C-03, F-17 | P1 | Screen reader đọc câu trả lời theo từng mẩu, rồi đọc lại toàn bộ | Bỏ `aria-live` khỏi timeline; `aria-busy` trên hàng live; một vùng status báo hai mốc |
| 8 | F-01, F-02 | P1 | "Giảm chuyển động" chỉ tác động lên Orb; bounce trên chữ body | Đặt `data-cc-reduced-motion` ở root; `cc-enter` dùng easing, 6 px, 280 ms |
| 9 | S-06, S-10 | P1 | Chế độ thực thi và model phải bấm nút Lưu; Escape làm mất thay đổi | Ghi ngay kèm InlineStatus và Undo |
| 10 | X-03, S-11, S-24 | P1 | Thuật ngữ nội bộ trong UI mặc định | Bảng thuật ngữ; đưa ref, digest, id vào "Chi tiết kỹ thuật" |
| 11 | C-08, S-07, S-08 | P1 | Escape và focus sai ở voice, SearchSelect, Widget Library | Escape đóng bề mặt gần nhất; dùng chung hook focus trap |
| 12 | W-01..W-04 | P1 | Website: không có điều hướng mobile, không có CTA cài đặt, hứa quá mức, story không đọc được trên mobile | Xem mục 5 |

---

## 2. Phát hiện kiểm tra trực tiếp (X)

### X-01 · P0 · Composer không xoá nội dung sau khi gửi thành công (regression)

- **Bằng chứng:** Mình nhấn Enter với nội dung "xin chào". Tin nhắn được gửi và Clark trả lời, nhưng composer vẫn chứa "xin chào" ở các mốc 300 ms, 1,5 s và 5 s (ảnh `14-after-enter.png`).
- **Nguyên nhân:**
  - `Conversation.tsx:172` giữ `draft`.
  - `:229` chỉ đặt lại draft trong `onSendFailed`, và `:415` gọi `send(draft)`.
  - Commit `b206271` ("split Conversation.tsx and styles.ts into focused modules", 23/09) đã bỏ lời gọi `setDraft("")` ở cả `send()` lẫn restart.
- **Tác động:**
  - Nhấn Enter lần nữa sẽ gửi trùng. Trong chế độ Autonomous, việc này có thể lặp lại một hành động có tác dụng thật.
  - Restart cũng không xoá draft, nên phiên mới mở ra với câu cũ.
- **Đề xuất:**
  - Xoá draft ngay khi `send` được chấp nhận, và giữ bản gốc để `onSendFailed` khôi phục.
  - Restart cũng xoá draft.
  - Thêm một e2e: gửi xong thì `[data-composer]` rỗng; gửi thất bại thì nội dung được trả lại.

### X-02 · P1 · Orb ở theme sáng thành một đĩa trắng

- **Bằng chứng:** `orb-shader.ts:168` có `body = u_canvas + u_shellEdge * …`, và `:188` cộng `emissive` lên trên. Trên canvas sáng, tổng này bão hoà về trắng. Hiện tượng thấy ở onboarding, empty state, voice overlay và preview trong Settings ở theme sáng. Theme tối hiển thị đúng.
- **Tác động:** Orb là chữ ký của sản phẩm (AGENTS.md), nhưng ở theme sáng nó mất bản sắc.
- **Đề xuất:**
  - Ở theme sáng, đổi phép cộng thành blend nhân hoặc screen có giới hạn, hoặc dùng `u_exposure` riêng cho light.
  - Thêm một test ảnh chụp so sánh độ tương phản giữa Orb và canvas ở cả hai theme.

### X-03 · P1 · Thuật ngữ nội bộ trong UI mặc định

- **Bằng chứng:**
  - Thẻ "Node này chưa có model" dùng các từ recipe, capability và provider.
  - Host card hiện "Recipe quick-play.chart.line" và "sample · sample".
  - Thẻ blocked in task id và node id mà không có bước tiếp theo.
  - Tab Control dùng "Preflight của host", "Jev guardrails", "fail-open", "containment" và "Allow — chạy tiếp".
  - Tab Extensions hiện ref như `project.code.change@1`, thông báo lỗi tiếng Anh, và tiêu đề lặp "CÔNG CỤ / CÔNG CỤ CỦA NODE NÀY".
- **Đề xuất:** Thực hiện cùng S-11, S-19 và S-24. Chi tiết ở mục 3.3.

### X-04 · P2 · Vòng cung Orb mờ đè lên hội thoại phía sau composer

- **Bằng chứng:** Ảnh `06-overview.png`. Orb ở dock rất lớn và bị blur, nên một vòng cung sáng nằm đè lên các dòng chữ cuối.
- **Tác động:** Trái với yêu cầu "ambient effects must remain subtle enough that text readability is always dominant".
- **Đề xuất:** Giới hạn kích thước dock bằng `clamp()` (gộp với C-27), thêm mask gradient phía trên composer, và giảm opacity của phần Orb nằm sau chữ.

### X-05 · P2 · Tiếng Anh và id thô lọt vào UI tiếng Việt

- **Bằng chứng:**
  - `messages-shell.ts:14` dịch "Ready" thành "Ready".
  - Pill done và blocked viết tiếng Anh; preset "Custom".
  - Dưới widget inline có mô tả tiếng Anh ("Line chart over a dataset reference…").
  - Chip lọc của Widget Library là id thô (calendar, cta, filter, media, metrics…).
  - Placeholder là "Never delete git repositories.".
- **Đề xuất:**
  - Mọi chuỗi và mọi enum đều đi qua catalog i18n.
  - Chip lọc dùng nhãn đã dịch.
  - Thêm một test: với mọi khoá, locale VI không được trùng nguyên văn EN, trừ danh sách ngoại lệ như tên riêng.

### X-06 · P2 · Ô tìm kiếm của Widget Library không có style

- **Bằng chứng:** Ảnh `08-widget-library.png`. Ô này dùng style mặc định của trình duyệt, lệch khỏi `.cc-search-select`.
- **Đề xuất:** Dùng chung style trường văn bản đã có.

### X-07 · P2 · Voice: câu fixture hiện hai lần; trạng thái mâu thuẫn

- **Bằng chứng:**
  - Ảnh `10-voice.png`: overlay hiện câu transcript hai lần.
  - Ảnh `11-voice-compact.png`: header ghi "Ready" trong khi thanh voice ghi "Đang nghe".
  - Chỉ nút "Viết thay vì nói" còn nhãn (xem C-26).
- **Đề xuất:**
  - Chỉ ghép câu final vào transcript (gộp với C-17).
  - Khi đang có phiên voice, trạng thái ở header đi theo trạng thái voice, hoặc ẩn đi (gộp với C-27).

### X-08 · P2 · Gợi ý phím tắt đổi model hiện trên mobile

- **Bằng chứng:** Dòng "model: fast Ctrl+] để đổi" vẫn hiện ở 390 px, nơi không có bàn phím.
- **Đề xuất:** Ẩn gợi ý phím tắt khi `pointer: coarse`. Thay bằng model pill bấm được (C-11).

### X-09 · P2 · Gợi ý ở empty state mơ hồ và lặp chữ

- **Bằng chứng:** Chip "Làm gì đó" không nói nó làm gì. Chuỗi "chạy trên dữ liệu mẫu" lặp lại trên từng chip.
- **Đề xuất:** Gộp với C-07: nhãn nói đúng hành động, và thêm một dòng chung "Ba ví dụ dưới đây dùng dữ liệu mẫu". NN/g khuyến nghị prompt dạng chip phải cụ thể và khám phá được.

### X-10 · P2 · Bundle chính 1,07 MB (299 kB gzip)

- **Bằng chứng:** `main-*.js` nặng 1.067 kB (gzip 299 kB). `xterm` 331 kB được tách chunk nhưng vẫn nằm trên đường nạp ban đầu nếu được import tĩnh.
- **Tác động:** Làm chậm lần hiển thị đầu tiên và INP khi khởi động, nhất là trong cửa sổ Electron nhỏ.
- **Đề xuất:**
  - `React.lazy` cho Settings, Widget Library, terminal card (xterm), voice overlay và highlight.js.
  - Đặt budget trong CI, ví dụ main ≤ 500 kB trước gzip.

### X-11 · P3 · Thứ tự Tab khác thứ tự nhìn

- **Bằng chứng:** Tab đi lần lượt mic, send, header, attach, textarea.
- **Đề xuất:** Sắp DOM theo thứ tự header → timeline → attach → textarea → mic → send (hoặc Stop), và không dùng `order` trong CSS để đảo.

---

## 3. Phát hiện theo bề mặt

Chi tiết đầy đủ kèm `file:line` được tóm lại dưới đây. Cột "Đề xuất" chỉ ghi hướng xử lý chính.

### 3.1 Bề mặt hội thoại (C)

| ID | Mức | Vấn đề | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| C-01 | P0 | Không có Stop | `ConversationComposerBar.tsx:166-174`; `use-turn-send.ts:150-182` không truyền `signal`; runtime đã có `control.interrupt` | Nút Stop ở cùng vị trí với nút gửi, dùng helper `press`/`release`; route interrupt; cập nhật `open-interfaces.ts` và docs EN/VI trong cùng PR; giữ phần đã stream kèm nhãn "Đã dừng theo yêu cầu" |
| C-02 | P1 | Enter khi đang bận bị nuốt | `use-turn-send.ts:127`; runtime đã quyết định steer ở `routes/conversations.ts:721-772` | Cho gửi; hiện kết quả `resolution` ngay cạnh composer |
| C-03 | P1 | Live region đọc từng token | `Conversation.tsx:364` | Xem mục 1, dòng 7 |
| C-04 | P1 | Hàng tin nhắn remount và nảy lại | `base.ts:126-137`, `TimelineMessageRow.tsx:51` | `data-enter="fresh"`; giữ key ổn định |
| C-05 | P1 | Lỗi gửi là chuỗi kỹ thuật tiếng Anh, màu muted, không có Retry, làm mất phần đã stream | `ConversationComposerBar.tsx:205-215`, `use-turn-send.ts:190-192` | Hàng lỗi `role="alert"` có icon và `--cc-danger`; map `GatewayError.code` sang i18n; nút **Gửi lại**; giữ phần đã nhận với nhãn "bị ngắt" |
| C-06 | P1 | Chip đính kèm bị layer `voice` đè: mất trạng thái checking và failed | `voice.ts:233-245` đè `composer.ts:39-54` | Tách class `.cc-file-chip`; chữ "Đang kiểm tra…"; failed có ⚠ và **Thử lại** |
| C-07 | P1 | Nhãn chip gợi ý không khớp hành động; bubble EN hiện câu tiếng Việt | `messages-shell.ts:51-54`, `ConversationHeroEmptyState.tsx:29-32` | Nhãn đúng hành động; gửi recipe id thay cho câu tiếng Việt |
| C-08 | P1 | Voice overlay không có Escape hay focus; `aria-modal` vẫn bật khi đã thu gọn | `VoiceOverlay.tsx:361-372` | Mở thì focus vào Mute; Esc thu gọn rồi trả focus; End trả focus về mic; bản thu gọn là `role="region"` |
| C-09 | P2 | Auto-scroll tự tắt khi một khối lớn xuất hiện; không có nút "↓ Tin mới" | `timeline.ts:13` dùng `scroll-behavior: smooth`, `follow-bottom.ts:12` | Cuộn theo chương trình dùng `instant`; thêm nút "↓ Tin mới"; thêm e2e |
| C-10 | P2 | Thẻ "chưa có model" mở sai tab; chip "Chỉ trò chuyện" bấm được dù biết trước sẽ lỗi | `Conversation.tsx:358` | `openSettings("ai")`; thay chip bằng "Chọn model" |
| C-11 | P2 | Statusline mặc định lộ token, cache, tok/s và chi phí | `statusline.ts`, `ConversationComposerBar.tsx:184-211` | Đưa vào Developer; model pill ở header |
| C-12 | P2 | Không có nút primary, không có press state; icon là ký tự `+ ◉ ↑` | `composer.ts:147-153` | Send dạng filled; bộ icon SVG; `motionCss("press")` |
| C-13 | P2 | CTA onboarding trông như chip; thiếu câu về Autonomous; mất focus | `App.tsx:226-274` | CTA primary; câu "Clark làm ngay điều bạn yêu cầu…"; focus composer sau khi bắt đầu |
| C-14 | P2 | Bấm logo restart ngay lập tức, không có guard hay Undo, và voice vẫn ghi vào phiên cũ | `ConversationHeader.tsx:46-56` | Dùng `switchGuard`; mục "Quay lại cuộc trước"; kết thúc voice khi restart |
| C-15 | P2 | Intent notice không có style, đẩy layout, tự ẩn sau 6 s kể cả khi là lỗi | `Conversation.tsx:463-467` | Neo phía trên composer; lỗi không tự ẩn |
| C-16 | P2 | Voice lỗi không có Thử lại; mọi lỗi đều gắn đuôi "đặt GEMINI_API_KEY" | `VoiceOverlay.tsx:408-411` | Nút Thử lại; chỉ gợi ý về key khi refusal là `missing-credential` |
| C-17 | P2 | Trạng thái voice và transcript không được thông báo; Orb là `img` không có tên | `VoiceOverlay.tsx:378-479`, `Orb.tsx:284` | `role="status"` và `role="log"`; Orb trang trí dùng `aria-hidden` |
| C-18 | P2 | Hero và Orb animate `left/top`; bounce nối chuỗi; thời gian viết cứng | `composer.ts:268-271`, `base.ts:130-139` | Dùng `transform`; token `stagger` |
| C-19 | P2 | Thiếu `Cmd/Ctrl+K` và `Cmd/Ctrl+Shift+V`; phím đổi model lệch spec | `use-model-alias.ts` | Thêm phím tắt; thống nhất lại với DESIGN |
| C-20 | P3 | Reduced motion vẫn giữ `animation-delay` | `panels.ts:353-365` | `animation-delay: 0s !important` |
| C-21 | P3 | Focus ring của composer là hình chữ nhật nằm trong viên thuốc | `composer.ts:146` bị `panels.ts:19` thắng | Vẽ ring ở `:focus-within` |
| C-22 | P3 | Glow quay liên tục kể cả khi idle | `composer.ts:96-115` | Chỉ quay khi thinking, tooling hoặc listening |
| C-23 | P3 | Rò rỉ i18n; xưng "tui" và "tôi" lẫn lộn | `ConversationComposerBar.tsx:98,186` | Thêm khoá i18n; chọn một đại từ |
| C-24 | P3 | Màn "chưa có token" không có Orb; copy toàn thuật ngữ dev | `App.tsx:290` | Render `<Orb>`; viết copy theo §14 |
| C-25 | P3 | Dòng model lệch lề trên màn rộng | `composer.ts:172` | `max-width` và `margin: auto` |
| C-26 | P3 | Nút voice dùng `aria-pressed` và `aria-expanded` cùng lúc; emoji 🔇 | `VoiceOverlay.tsx:510-549` | Icon SVG; bọc nhãn trong span |
| C-27 | P3 | Dock 720 px viết cứng; "Ready" luôn hiện | `Conversation.tsx:335` | Token `LAYOUT` với `clamp()`; chỉ hiện khi khác ready |

### 3.2 Bề mặt phụ: Settings, Inbox, Widget Library và widget (S)

| ID | Mức | Vấn đề | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| S-01 | P1 | Snapshot có nhãn "dữ liệu vừa đọc" cạnh thời gian ISO thô | `use-surface-renderer.tsx:26`, `mini-app-surface.tsx:106,151` | Tone trung tính với nhãn "Ảnh chụp · 3 giờ trước" |
| S-02 | P1 | Note báo "Đã lưu." dù không lưu gì | `renderers.tsx:438-510` | Chỉ bật Save khi có action binding thật; chờ kết quả rồi mới báo |
| S-03 | P1 | Lỗi đọc hiện thành "Chưa cài gói nào" | `ExtensionsSettings.tsx:292-311` | Ba trạng thái `loading/error/ready` kèm Thử lại |
| S-04 | P1 | Slider Orb ghi lên node ở mọi sự kiện; "Về mặc định" chỉ lùi một bước | `ExperienceSettings.tsx:129-136,291-295` | Commit khi `pointerup`; reset bằng một lần ghi (cần xác nhận trên trình duyệt) |
| S-05 | P1 | Toggle Instructions ghi đè bản nháp | `AiRoutingSettings.tsx:380,397` | Toggle dùng `draft` hiện tại |
| S-06 | P1 | Chế độ thực thi phải bấm "Lưu policy"; Escape làm mất thay đổi | `ControlSettings.tsx:184-301` | Ghi ngay kèm Undo; chỉ giữ form cho phần nâng cao |
| S-07 | P1 | Escape trong SearchSelect đóng luôn Settings | `search-select.tsx:108-113`, `Modal.tsx:62-96` | `stopPropagation`; thêm e2e |
| S-08 | P1 | Widget Library có `aria-modal` nhưng không bẫy Tab | `WidgetLibrarySurface.tsx:155-167` | Dùng chung hook focus trap |
| S-09 | P1 | Preview tương tác nằm trong `<button>` | `WidgetGallery.tsx:158-178` | Thẻ là `<article>`; preview dùng `inert` |
| S-10 | P1 | Chọn model phải bấm Lưu; lỗi catalogue hiển thị "không có provider" | `AiRoutingSettings.tsx:61-97,289-303` | Tự lưu kèm Undo; nhánh lỗi riêng; thêm `aria-label` |
| S-11 | P1 | Extensions lộ ref, digest, ISO và `id@version`; Grant và Deny trông giống nhau | `ExtensionsSettings.tsx:93-112,218-225,386-391` | Tên thân thiện; `<details>` "Chi tiết kỹ thuật" |
| S-12 | P2 | Không có kiểu danger/primary cho Approve, Deny, Remove, Kill | `inbox-panel.tsx:372-476`, `terminal-card.tsx:582` | `data-emphasis="danger"` |
| S-13 | P2 | Badge credential kẹt ở "Đang đọc…"; Remove bật khi chưa có key | `credentials-manager-section.tsx:371-397` | Nhánh lỗi; chỉ hiện "Thêm key" khi chưa có |
| S-14 | P2 | Xoá memory lỗi thì thay cả danh sách; `aria-label` chung chung | `MemorySettings.tsx:57-61,152` | Báo lỗi tại hàng; nhãn có trích nội dung |
| S-15 | P2 | Inbox lỗi tải không có Thử lại | `inbox-panel.tsx:327-331` | Thêm nút Thử lại |
| S-16 | P2 | WidgetFrame tải không có timeout; lỗi là message giao thức thô | `WidgetFrame.tsx:157-215` | Hết 10 s thì chuyển trạng thái; copy thân thiện |
| S-17 | P2 | Lane native và isolated trông giống nhau; Install không đổi trạng thái; không chống bấm lặp | `blocks.tsx:1857-1934`, `use-block-actions.ts:287-318` | Badge lane có tone và câu mô tả; trạng thái Đang cài / Đã cài / Cập nhật; ref lock |
| S-18 | P2 | Marketplace thiếu compatibility, facet, preview và "Xem mã nguồn" | `blocks.tsx`, `WidgetLibrarySurface.tsx:263` | Hạng mục roadmap |
| S-19 | P2 | ISO và enum thô; "operation {digest}" tiếng Anh | `ControlSettings.tsx:723-729`, `blocks.tsx:766-812` | Helper `formatWhen(locale)` |
| S-20 | P2 | Ma trận 7×4 và 6 guard class hiện ngay ở view mặc định | `ControlSettings.tsx:254-271,660-684` | Gộp vào "Nâng cao" |
| S-21 | P2 | Bốn toggle cùng hiện "Đang lưu…" và gây nhảy layout | `ControlSettings.tsx:509-580` | Chỉ toggle đang ghi mới báo trạng thái |
| S-22 | P2 | Nút "Nghe thử" không có handler | `DevicesVoiceSettings.tsx:209-217` | Nối handler hoặc ẩn |
| S-23 | P2 | "Không có sẵn" và "trống" dùng cùng một câu; mỗi hàng DataTable là một tab stop | `renderers.tsx:218-367` | Hai thông điệp riêng; roving tabindex |
| S-24 | P2 | Copy tiếng Việt lẫn thuật ngữ và tên biến môi trường | `i18n/messages-settings.ts` | Bảng thuật ngữ (mục 4) |
| S-25 | P2 | Control vắng mặt không nêu lý do; nodeId hiện ra | `SettingsPanel.tsx:40-44`, `DevicePairingPanel.tsx:53,69` | Hàng disabled kèm lý do; `<details>` |
| S-26 | P3 | 7 tab so với 6 nhóm; 4 mode so với 3 | `SettingsPanel.tsx:47-60` | Cập nhật DESIGN hoặc gộp tab (câu hỏi mở) |
| S-27 | P3 | `.cc-action` cao 32 px nằm ngoài rule coarse | `voice.ts:257`, `panels.ts:611` | Thêm selector vào rule |
| S-28 | P3 | "Việc nền" và "Việc chạy nền" gần như trùng | `messages-inbox.ts` | Đặt tên theo nguồn |
| S-29 | P3 | Chart dựa vào chuỗi "lần" để đoán đơn vị | `renderers.tsx` | Thêm trường `unitKind` |
| S-30 | P3 | Lối vào Library nằm dưới danh sách; comment đã cũ | `ExtensionsSettings.tsx:69-121` | Đưa lối vào lên đầu |

### 3.3 Design system và trợ năng (F)

Tương phản chữ đạt ở mọi cặp. Bảng tương phản đầy đủ nằm trong phụ lục A.

| ID | Mức | Vấn đề | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| F-01 | P1 | "Giảm chuyển động" chỉ đến được Orb; nhánh scoped thiếu chốt chặn cho animation vô hạn; Orb vẫn vẽ 60 fps | `use-orb-profile.ts:46`, `css.ts:113`, `Orb.tsx:138,193,202` | `data-cc-reduced-motion` trên `.cc-shell`; lặp lại khối `animation: none`; Orb nghe cả profile lẫn `change` |
| F-02 | P1 | Bounce trên chữ body; chip nảy nối chuỗi; 12 px trong 560 ms; press 0.97 và 0.94 | `base.ts:126-139`, `voice.ts:266`, `panels.ts:234` | Easing, 6 px, 280 ms; press 0.98 |
| F-03 | P1 | Hàng settled chạy lại animation vào | `Conversation.tsx:366-378` | Trùng C-04 |
| F-04 | P1 | `motionCss`/`motion` chỉ được gọi trong test; có 20 transition viết tay | `design-tokens/test/motion.spec.ts` | `motionVarCss(kind)`; test chặn transition viết tay |
| F-05 | P2 | Transition `left/top` | `composer.ts:268-271` | Trùng C-18 |
| F-06 | P2 | Thời lượng hard-code; token Orb bị mượn cho caret và spinner | `base.ts:139`, `timeline.ts:68-75,230,244` | Token `stagger`, `blink`, `spin`, `pulse` |
| F-07 | P2 | Orb và waveform của voice vẫn chuyển động khi bật reduced motion | `VoiceOverlay.tsx:385,404` | Orb đứng yên; waveform tĩnh cập nhật khoảng 4 Hz |
| F-08 | P1 | Viền control chỉ đạt 1.16–1.28:1, dưới mức 3:1; `contrast.ts` chỉ đo `border` trên `card` | `contrast.ts:572` | Token `controlBorder` (dark `#686B74`, light `#878A91`); mở rộng `requiredPairs` |
| F-09 | P2 | Chip "checking" đạt 3.27–3.94; calendar count ở theme sáng 4.41; placeholder không được audit | `composer.ts:54`, `panels.ts:199` | Không giảm opacity của chữ; thêm rule `::placeholder` |
| F-10 | P3 | Hai lát donut kề nhau chỉ 1.19:1 | `panels.ts:173-177` | Stroke tách lát; token `chart1..6` |
| F-11 | P1 | Năm biến không được định nghĩa, fallback hex tối làm hỏng theme sáng | `panels.ts:378-390`, `styles.spec.ts:86-98` | Dùng token thật; test bắt `var()` có fallback nhưng biến không tồn tại |
| F-12 | P2 | Bypass token: 29 spacing, 13 shadow, 23 mono stack, 73 object style inline | Bảng F-12 | Thêm `FONT`, `SHADOW`, `RADIUS.field`; class `.cc-flush` |
| F-13 | P2 | Không có rule `forced-colors` nào | grep | Khối `@media (forced-colors: active)` |
| F-14 | P1 | Lựa chọn multi-choice không có trạng thái nhìn thấy và không có trạng thái cho screen reader | `blocks.tsx:651-667` | `aria-pressed`; style selected kèm ✓ |
| F-15 | P3 | Hover và selected trông giống focus | `cards.ts:51`, `panels.ts:91-93` | Hover dùng `controlBorder` |
| F-16 | P2 | Nhiều control nhỏ hơn 24 px; e2e chỉ đo 3 control | `composer.ts:55-58`, `accessibility.spec.ts:67-81` | Token `--cc-target-min`; e2e đo mọi control |
| F-17 | P2 | Live region bao cả reply đang stream | `Conversation.tsx:364,385` | Trùng C-03 |
| F-18 | P2 | Dòng chữ khoảng 95–105 ký tự (ước tính) | `LAYOUT.conversationMaxWidth` | `proseMeasure: 72ch` |
| F-19 | P3 | Thang chữ bị trôi; token display không dùng | `base.ts:27`, `timeline.ts:151` | Dùng token leading; line-height heading 1.35 |
| F-20 | P2 | 16 giá trị z-index literal | `base.ts`, `panels.ts`, `voice.ts` | Thang `Z` và `--cc-z-*` |
| F-21 | P3 | Khai báo chết vì thứ tự layer; fade-out không bao giờ hiện | `base.ts:208,215`, `composer.ts:146` | Dọn rule; transition cả `visibility` |
| F-22 | P3 | `aria-label` tiếng Việt viết cứng | `ConversationComposerBar.tsx:99` | Trùng C-23 |
| F-23 | P3 | Hiệu năng Orb tốt (DPR 2, low-power, IntersectionObserver) | `orb.ts:218,429` | Giữ nguyên; chỉ còn điểm nêu ở F-01 |

Ngoài phạm vi: `apps/desktop/src/shell.css` có bảng màu kiểu GitHub-dark riêng (`--accent: #58a6ff`). Bảng này không nằm trong `THEMES`, nên không được audit tương phản. Đây là nguồn gốc của các fallback ở F-11.

### 3.4 Website clarkcant.cc (W)

Cả 15 lượt chạy trang đều không có lỗi console và không tràn ngang. LCP là chữ (H1). Heading và landmark đúng, có skip link, focus rõ.

| ID | Mức | Vấn đề | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| W-01 | P1 | Mobile không có điều hướng; Docs chỉ vào được từ footer | `base.css:222-225` | Hàng chip cuộn ngang dưới header ở ≤860 px; tối thiểu phải có link Docs |
| W-02 | P1 | Không có CTA cài đặt ở màn hình đầu | `index.html:306-324` nằm ở section 6/7 | Nút primary "Get ClarkCant" trỏ tới `#install`; GitHub là nút phụ |
| W-03 | P1 | Hero, story và plumbing hứa năng lực mà thẻ Status ghi "Not yet" | `index.html:73,122-125,167-168` so với `:287-298`; `scripted-replies.js:31` | Viết theo thì tương lai; nhãn "Where it's going"; pill "Early days · v0.2" |
| W-04 | P1 | Story trên mobile làm mờ đúng đoạn đang đọc (contrast khoảng 1.49:1) | `story-chapters.js:335`, `story.css:137,172` | Đổi `rootMargin` ở ≤900 px; opacity ≥ 0.6; hoặc bỏ sticky |
| W-05 | P2 | Serif display không có subset tiếng Việt (8 glyph rơi về font khác); H1 trang VI là tiếng Anh | CDP `getPlatformFontsForNode`; `vi/docs/index.html:71` | `:lang(vi) { --font-display: … }`; H1 tiếng Việt |
| W-06 | P2 | Docs mất Orb ở header | Các trang docs không link `orb.css` | Chuyển `.orb-mark` vào `base.css` |
| W-07 | P2 | Reduced motion còn 6 transition 500 ms; hero animate `width` và `font-size` | `hero.css:323,333`, `story.css`, `sections.css:391` | Token hoá thời lượng; tắt `rise`; dùng FLIP |
| W-08 | P2 | Nhãn "scripted" nằm dưới màn hình đầu | `index.html:96` | Nhãn ngay trên composer; meta cho từng reply |
| W-09 | P2 | Chữ gradient "want / Can." ở theme sáng chỉ 1.8–2.4:1 | `hero.css:335-344` | Một spectrum riêng cho theme sáng, ≥ 3:1 |
| W-10 | P2 | Plumbing thu gọn là một khối mờ cao khoảng 900 px; AT vẫn đọc nội dung bị ẩn | `sections.css:395-396` | Chỉ hiện 3 hàng kèm mask; `inert` |
| W-11 | P2 | Trạng thái micro không được đọc lên; lỗi chung chung | `index.html:244`, `voice-listen.js:231-233` | `role="status"`; phân nhánh theo `error.name` |
| W-12 | P2 | Google Fonts chặn render và quyết định LCP | `index.html:16-18` | Tự host woff2; preload; fallback metric |
| W-13 | P2 | Thiếu canonical, `og:url`, sitemap (404); link docs tốn một redirect 308 | `index.html:6-14` | Thêm meta; `sitemap.xml`; link không đuôi |
| W-14 | P2 | Docs mở đầu bằng lệnh cần node đang chạy | `docs/index.html:71-89` | Note "Cần node đang chạy, xem Quickstart" hoặc đưa Quickstart lên trước |
| W-15 | P2 | Không có anchor heading, "On this page" hay prev/next | `docs/api.html` | Thêm ba thứ này |
| W-16 | P2 | Lệnh `curl … \| sh` bị cắt, không có dấu hiệu cuộn | `sec-open-source-d-dark.png` | Wrap hoặc mask fade; chừa chỗ cho nút Copy |
| W-17 | P3 | Nút Copy không thông báo cho screen reader | `page-chrome.js:119-134` | `role="status"` ẩn |
| W-18 | P3 | Nhãn "VI" khác accessible name (WCAG 2.5.3) | `docs/index.html:44` | Sửa `aria-label` |
| W-19 | P3 | Nút theme ba trạng thái không nói trạng thái kế tiếp | `notes.json` | Nhãn "Theme: Light. Next: Dark" |
| W-20 | P3 | Target 24–38 px ở 390 px | `notes.json` | Rule `pointer: coarse` 44 px |
| W-21 | P3 | Voice trên mobile có thứ tự nhìn khác thứ tự DOM | `sections.css:432` | Chỉ đưa Orb lên đầu |
| W-22 | P3 | Token motion và màu lệch khỏi sản phẩm | `tokens.css` so với `tokens.ts:212-221` | Sao lại token, kèm ghi chú "mirrored from" |
| W-23 | P3 | Timer ghi "Close it" nhưng không có nút đóng | `focus-timer-widget.js:117` | Sửa copy hoặc thêm nút |
| W-24 | P3 | Mỗi Orb một listener pointer và đọc layout mỗi frame | `mount-orb.js:73-86` | Một listener chung; cache rect |

---

## 4. Đề xuất hệ thống: sửa một lần, dùng cho mọi màn

Nhiều phát hiện có chung một gốc. Làm các mẫu dưới đây một lần thì xử lý được hàng chục mục cùng lúc.

1. **Mẫu "ghi ngay kèm Undo" cho mọi preference đơn** (S-04, S-05, S-06, S-10, S-21).
   - Control ghi ngay, hiện InlineStatus tại chỗ, và cho Undo.
   - Chỉ nhóm cấu hình nhiều trường mới dùng form có nút Lưu.
   - Đây là đúng khuyến nghị toggle của NN/g và quy tắc Settings trong AGENTS.md.
2. **Mẫu "trạng thái trung thực" ba nhánh `loading | error | ready` kèm Thử lại** (S-03, S-10, S-13, S-15, S-16, S-23, C-05, C-16).
   - Không bao giờ ép kết quả lỗi thành danh sách trống.
   - Copy theo công thức của §14: cái gì hỏng, cái gì được giữ, người dùng làm gì tiếp.
3. **Độ tươi dữ liệu có kiểu** (S-01, X-05, S-19).
   - Tách `live | snapshot | cached | sample` ngay trong type.
   - Một helper `formatWhen(locale)` cho mọi mốc thời gian.
4. **Motion đi qua helper** (F-01..F-07, C-04, C-18, C-20, C-22).
   - Thêm `motionVarCss(kind)` và token `stagger/blink/spin/pulse`.
   - Thêm test cấm `transition` viết tay và bounce trên `.cc-row`.
   - Đặt `data-cc-reduced-motion` ở root.
5. **Token mới** (F-08, F-12, F-20, S-12, F-16):
   - `controlBorder` và màu `danger` cho emphasis;
   - thang `Z`;
   - `SHADOW`, `FONT`, `--cc-target-min`, `proseMeasure`.
6. **Hook `useDismissibleLayer`** (C-08, S-07, S-08): một hook gồm focus trap, Escape chỉ đóng lớp gần nhất (`stopPropagation`) và trả focus. Dùng cho Modal, Widget Library, voice và SearchSelect.
7. **Bảng thuật ngữ VI** (X-03, X-05, S-24, C-23): đặt trong `docs/`, kèm một test i18n.

   | Thuật ngữ nội bộ | Nhãn mặc định đề xuất | Ghi chú |
   |---|---|---|
   | effect | hành động có tác động | |
   | capability | quyền | |
   | Allow / Deny | Cho phép / Chặn | |
   | recipe | ví dụ, hoặc mẫu | |
   | preflight | kiểm tra trước khi chạy | |
   | fail-open | vẫn chạy khi không kiểm tra được | |
   | node, task id, digest | không hiện ở view mặc định | chỉ nằm trong "Chi tiết kỹ thuật" |

8. **Chặn hồi quy** bằng test:
   - e2e composer rỗng sau khi gửi (X-01);
   - e2e Escape lồng nhau (S-07);
   - snapshot không mang nhãn live (S-01);
   - kiểm tra `var()` có fallback nhưng biến không tồn tại (F-11);
   - mở rộng `requiredPairs` (F-08);
   - target-size đo mọi control (F-16);
   - budget bundle (X-10).

## 5. Lộ trình đề xuất

Theo AGENTS.md, mỗi đợt là một PR riêng có e2e, và DESIGN.md được cập nhật trong cùng PR nếu một invariant thay đổi.

**Đợt 0: sửa nhanh, rủi ro thấp (1–2 ngày)**
- Lỗi và hành vi:
  - X-01 (regression composer, làm đầu tiên);
  - S-07 (Escape trong SearchSelect);
  - C-20 (bỏ delay khi reduced motion);
  - C-25 (lề dòng model);
  - F-21 (khai báo chết).
- Style và token:
  - F-11 (biến không định nghĩa, kèm test);
  - F-09 (`::placeholder` và chip checking);
  - S-27 (target 32 px).
- Trợ năng và trạng thái:
  - F-14 (`aria-pressed` và style selected);
  - C-26 (nhãn nút voice);
  - S-22 (ẩn nút "Nghe thử").
- i18n: C-23 và F-22 (khoá i18n); X-05 (dịch "Ready" và pill).
- Website: W-06 (Orb ở docs), W-18 (label VI), W-13 (meta và sitemap).

**Đợt A: kiểm soát và trung thực**
- C-01 và C-02: Stop và gửi giữa lượt. Kèm route interrupt, `open-interfaces.ts` và docs EN/VI.
- S-01, S-02, S-03 và S-10 (lỗi đọc): độ tươi dữ liệu và kết quả thật.
- C-05, C-15 và C-16: mẫu lỗi inline kèm Thử lại.
- S-13, S-15, S-16, S-23: trạng thái ba nhánh.
- W-03 và W-08: website bỏ lời hứa quá mức.

**Đợt B: motion và hệ thống hình ảnh**
- F-04 (helper motion).
- Motion cụ thể: F-01, F-02, C-04/F-03, C-18/F-05, F-06, F-07, C-22.
- X-02 (Orb ở theme sáng) và X-04 (vòng cung che chữ).
- Token: F-08 (`controlBorder`), S-12 (danger), F-12, F-20.
- X-10 (tách bundle).
- Website: W-07 và W-22.

**Đợt C: trợ năng**
- Live region, voice và focus: C-03/F-17, C-08, C-17, S-08, S-09.
- Forced colors, target và bảng: F-13, F-16, S-23 (roving tabindex).
- C-09 (auto-scroll, nút "Tin mới") và X-11 (thứ tự Tab).
- Website: W-11, W-17, W-20, W-21.

**Đợt D: copy, IA và progressive disclosure**
- Copy: X-03, S-11, S-19, S-24 (bảng thuật ngữ).
- Settings: S-20 (mục "Nâng cao"), S-06 (mode ghi ngay), S-26 (IA 6 hay 7 tab).
- Hội thoại: C-07 và X-09 (gợi ý), C-10, C-11 (statusline vào Developer), C-13 (onboarding), C-14 (Undo khi restart).
- S-17 và S-18: lane marketplace, compatibility, facet.
- Website: W-01, W-02, W-04, W-05, W-09, W-10, W-12, W-14, W-15, W-16.

Các mục P1 của website (W-01, W-02, W-04) nằm ở repo riêng. Chúng có thể chạy song song với Đợt A mà không đụng tới app.

## 6. Rubric (0–3)

| Tiêu chí | App | Website | Ghi chú |
|---|---|---|---|
| Trung thực (dữ liệu, kết quả, năng lực) | 1 | 2 | S-01, S-02, S-03; W-03 |
| Kiểm soát của người dùng (Stop, Undo, Escape) | 1 | — | C-01, C-02, C-14, S-06 |
| Motion đúng grammar | 1 | 2 | F-01..F-04; W-07 |
| Trợ năng | 2 | 2 | Tương phản chữ tốt; live region, forced-colors và viền control còn yếu |
| Ngôn ngữ và thuật ngữ | 1 | 2 | X-03, S-24; W-05 |
| Nhất quán hệ thống (token, control) | 2 | 2 | F-12, F-20; W-22 |
| Nhận diện (Orb) | 2 | 3 | X-02 ở theme sáng; W-06 ở docs |

## 7. Chưa xác minh

- F-03/C-04 (nhấp nháy khi settle) và F-17/C-03 (đọc từng token) được suy từ code. Cần quay video e2e và thử bằng NVDA và VoiceOver.
- S-04 (slider giật) và S-21 (nhảy layout) được suy từ luồng dữ liệu. Cần Playwright xác nhận.
- F-18 (độ dài dòng) là con số ước tính.
- Chưa chạy Electron trực tiếp, cũng chưa dùng thiết bị cảm ứng thật.

## Câu hỏi còn mở

1. Tuỳ chọn "Giảm chuyển động" trong app có chủ đích chỉ tác động lên Orb không? Nếu đúng, nên đổi nhãn. Nếu không, cần làm F-01.
2. Chế độ "Từ chối tất cả" và tab Memory có phải quyết định sản phẩm không? Nếu có, DESIGN.md cần ghi nhận (S-26).
3. Route dừng lượt foreground (C-01) thay đổi hợp đồng Open interfaces. Đội đã có kế hoạch cho việc này chưa?
4. Clark xưng "tui" hay "tôi" trong tiếng Việt? Locale mặc định có nên đọc `navigator.language` không (C-23)?
5. Statusline hiện token và chi phí có chủ đích dành cho power user không? Nếu có, nên đưa vào Developer (C-11).
6. Tách một token `controlBorder` riêng, hay nâng thẳng `border` lên 3:1? Nâng thẳng sẽ đổi diện mạo "quiet chrome" (F-08).
7. Note trong mini-app có sẽ có action binding thật để lưu không (S-02)?
8. Website:
   - Có làm trang chủ tiếng Việt không?
   - Các cảnh "đích đến" giữ lại kèm nhãn, hay bỏ?
   - Có chấp nhận commit file font để tự host không?
   - Chọn serif nào có hỗ trợ tiếng Việt cho chữ display?

## Phụ lục A: tương phản (tóm tắt)

| Cặp | Dark | Light | Kết quả |
|---|---|---|---|
| text, textMuted, textTertiary trên 5 bề mặt | 4.82–15.08 | 4.68–17.38 | Đạt |
| focus trên 5 bề mặt | 11.56–12.76 | 6.10–6.84 | Đạt |
| onAccent / accent | 8.97 | 5.49 | Đạt |
| **border / 4 bề mặt (viền control)** | **1.16–1.28** | **1.18–1.26** | **Không đạt 3:1** |
| **chip "checking" (opacity .7)** | **3.94** | **3.27** | **Không đạt 4.5:1** |
| **calendar count** | 6.19 | **4.41** | **Không đạt (light)** |
| **donut tone4 / card** | **1.76** | **1.55** | **Không đạt 3:1** |
| Website: chữ gradient "want" | — | **1.82–2.44** | **Không đạt 3:1** |
| Website: chapter story bị mờ (mobile) | ~1.49 | ~1.49 | **Không đạt** |

## Nguồn tham khảo

Chuẩn và trợ năng:
- W3C, [WCAG 2.2](https://www.w3.org/TR/WCAG22/): SC 1.4.11, 2.4.11, 2.5.3, 2.5.8, 4.1.3.
- W3C WAI, [Understanding 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
- W3C WAI, [Understanding 2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum).
- W3C WAI, [ARIA19: role=alert và live region](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19).
- Level Access, [WCAG 2.2 checklist](https://www.levelaccess.com/blog/wcag-2-2-aa-summary-and-checklist-for-website-owners/): target 24×24 px.
- Deque, [2.3.3 Animations from Interactions](https://dequeuniversity.com/resources/wcag2.1/2.3.3-animations-from-interactions).
- Silktide, [WCAG 4.1.3 Status messages](https://silktide.com/accessibility-guide/the-wcag-standard/4-1/compatible/wcag-4-1-3-status-messages/).
- MDN, [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).
- MDN, [forced-colors](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/forced-colors).

Tương tác người và AI:
- Amershi et al., [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf), CHI 2019: 18 guideline, 49 chuyên gia, 20 sản phẩm.
- Google PAIR, [Explainability + Trust](https://pair.withgoogle.com/guidebook-v2/chapter/explainability-trust/).
- Anthropic, [Measuring AI agent autonomy in practice](https://www.anthropic.com/news/measuring-agent-autonomy): khoảng 93% yêu cầu xin quyền được chấp thuận, nên xin xác nhận dày đặc làm giảm sự chú ý.
- Anthropic, [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
- Anthropic, [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude).
- OWASP, [LLM06:2025 Excessive Agency](https://owasp.org/www-project-top-10-for-large-language-model-applications/2_0_vulns/LLM06_ExcessiveAgency.html).
- Google, [Conversation Design: Confirmations](https://developers.google.com/assistant/conversation-design/confirmations).

Hội thoại, settings và marketplace:
- NN/g, [10 Guidelines for AI Chatbots](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/).
- NN/g, [Prompt Controls in GenAI Chatbots](https://www.nngroup.com/articles/prompt-controls-genai/).
- NN/g, [Designing Empty States](https://www.nngroup.com/articles/empty-state-interface-design/).
- NN/g, [Less Chat, More Answer](https://www.nngroup.com/articles/less-chat-more-answer/): 425 lượt tương tác.
- NN/g, [Toggle-Switch Guidelines](https://www.nngroup.com/articles/toggle-switch-guidelines/).
- NN/g, [Progressive Disclosure](https://www.nngroup.com/videos/progressive-disclosure/).
- Microsoft, [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust).
- Google, [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies).
- Raycast, [Security](https://developers.raycast.com/information/security).

Motion và hiệu năng:
- Apple HIG, [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback).
- Apple HIG, [Motion](https://developer.apple.com/design/human-interface-guidelines/motion).
- Material Design 3, [Easing and duration](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs).
- web.dev, [High-performance CSS animations](https://web.dev/articles/animations-guide): chỉ transform và opacity.
- web.dev, [Optimize INP](https://web.dev/articles/optimize-inp): 200 ms là tốt, trên 500 ms là kém.

Tài liệu cho developer:
- [Diátaxis](https://diataxis.fr/).
- Canonical, [Diátaxis case study](https://ubuntu.com/blog/diataxis-a-new-foundation-for-canonical-documentation).
- Raw.Studio, [Stripe developer-first UX](https://raw.studio/blog/how-stripe-uses-4-developer-first-ux-principles-to-drive-massive-adoption/). Đây là nguồn phân tích thứ cấp.

Tài liệu nội bộ: `DESIGN.md`, `AGENTS.md`, `plans/reports/ux-audit-260924-clarkcant-polish.md`.

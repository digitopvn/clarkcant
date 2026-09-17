# Xác minh Phase 6 — release validation và evidence cho mini-app composed surface

- **Loại:** verification
- **Ngày:** 2026-09-17 (Asia/Saigon)
- **Branch:** `feat/jev-mini-app-rendering` (commit Phase 6 ở cuối báo cáo)
- **Kế hoạch:** `plans/260917-0528-jev-mini-app-rendering/plan.md`, phase 6
- **Phạm vi:** đường composed surface trong conversation (Phase 1–5, 7–9, 11) trên node cô lập, không gọi provider trả phí.

## Kết luận

M1 (mini-app trong conversation) đạt release gate **ở phần xác minh được bằng máy**: container + các vùng theo sketch hiển thị thật trong browser, dữ liệu lấy từ record của chính node, snapshot là bundle bất biến, một live owner có lease, double click thành một effect, restart giữ nguyên cả snapshot lẫn live state, unknown definition rơi về text alternative (không blank).

Phần **live provider** (Jev gọi model thật, turn → UI bằng model thật) **BLOCKED** trong môi trường này: thiếu `TYPESAFE_API_KEY`. Không có kết quả nào trong báo cáo này là output của model thật; toàn bộ đường browser chạy bằng composer tất định (`CC_MODEL_FIXTURE=1`) và recipe scripted có sẵn. Điều đó được ghi rõ ở mục "BLOCKED", không được đọc thành pass cho hạng mục live.

## Môi trường và version đóng băng

| Hạng mục | Giá trị |
|---|---|
| Máy | macOS (darwin), Node v24.19.0, `corepack pnpm` 12.4.2 |
| Repo | `/Volumes/GOON/www/digitop/clarkcant` |
| Node e2e | `node_85077e4325d1469f95e18be3`, label `e2e-node`, data dir `.data/e2e/node.sqlite` |
| Ports e2e | node `8876`, web build `4273` (`playwright.config.ts`, không dùng dev server) |
| Migration | version 14 |
| Composition schema | `schemaVersion: 1`; template `overview`; slot thật ghi trong bundle: `metrics`, `filter`, `trend`, `calendar`, `cta` |
| Catalog digest | `sha256:catalog:719` (10 definition: 9 leaf + container `canvas.overview@1`) |
| Model dùng trong evidence | **không có model** — `CC_MODEL_FIXTURE=1`. Node vẫn đọc `.env` và log `model: deepseek/deepseek-v4-flash (turn limit …)`, nhưng đường được test không chạm provider |
| Flag | `CC_VOICE_FIXTURE=1 CC_MODEL_FIXTURE=1`; không đặt `CLARKCANT_JEV_LIVE=1` |

Hai dòng log khởi động của node e2e được dẫn nguyên văn vì chúng là provenance của mọi PNG dưới đây:

```text
overview: FIXTURE composer loaded — overview requests are scripted, and no provider is called for them
voice: FIXTURE provider loaded — audio and transcripts on /voice are scripted, not model output
```

## Lệnh và kết quả

| Lệnh | Kết quả |
|---|---|
| `corepack pnpm verify` | 7/7 invariant + 53 file test, **766 passed / 5 skipped (771)** |
| `corepack pnpm build` | web build pass (`dist/assets/index-*.js` 466.17 kB, gzip 137.13 kB) |
| `corepack pnpm test:e2e` | **20 passed (28.5s)** — gồm 3 journey mới của `apps/web/e2e/mini-app.spec.ts` |

Ba journey mới là ba đường khác nhau, không phải ba ảnh của cùng một màn hình:

1. `renders a composed overview whose figures come from the node's own records` — tạo calendar event bằng API production, hỏi overview, kiểm tra đủ vùng, giá trị KPI khớp API, click ngày → chi tiết sự kiện.
2. `the live view changes while the transcript keeps what it showed` — snapshot inline giữ revision cũ, live đổi kỳ; snapshot chuyển `stale=true` sau khi live lên N+1.
3. `a second surface is refused the live view and says so instead of taking over` — tab thứ hai bị từ chối quyền sở hữu, render read-only kèm lý do, CTA disabled.

## Journey → evidence

## Rework sau audit (2026-09-17)

Audit độc lập chỉ ra ba khoảng trống; cả ba đã đóng và có evidence:

1. **Vùng ảnh chưa từng tới được người dùng** — không template nào có slot `image` và `publishMiniAppData` trả `imageRefs: []`, nên `canvas.image@1` không có đường nào để render dù renderer đã xong. Đã nối end to end và thêm hai test đơn vị (có ảnh / không ảnh) + một assert browser (`naturalWidth`).
2. **CSP chặn ảnh có xác thực** — `img-src 'self' data:` thiếu `blob:`, nên `<img>` trỏ vào blob URL bị chặn. Kiểm chứng vòng đời bytes (upload → `GET /images/:id`) cho thấy node trả **đúng từng byte** (74 byte, sha khớp, `content-type: image/png`), tức lỗi nằm ở policy của trang chứ không ở storage. Đã thêm `blob:` vào `img-src`; `connect-src` giữ nguyên vì client không fetch blob URL.
3. **Accessibility của expanded view** — nay nhận focus khi mở, là `role="region"` có tên, đóng bằng Escape hoặc nút, và host trả focus về control đã mở nó. Journey bàn phím chạy hết trong `mini-app.spec.ts`.

Trong lúc sửa (1) và (2) lộ thêm một lỗi quản lý tài nguyên: transcript và pinned view mỗi bên tự fetch rồi tự `revokeObjectURL`, nên một bên có thể thu hồi URL bên kia đang hiển thị. Đã gom về một chỗ (`packages/conversation-client/src/use-image-urls.ts`), nơi một ảnh có đúng một fetch và URL chỉ được thu hồi khi component sở hữu nó unmount.

| Journey / failure (theo phase-06) | Evidence chạy được | Ghi chú |
|---|---|---|
| Ask overview | `e2e/mini-app.spec.ts` test 1; số liệu KPI so với `GET /datasets/:id` | 6 vùng: metrics, filter, trend, calendar, **image**, cta; `trend` hiện trạng thái thiếu dữ liệu thật khi node chưa có task |
| Week/month và calendar | `e2e/mini-app.spec.ts:71` (chọn ngày, chi tiết event) + `:136` (đổi kỳ ở live) + `mini-app-actions.spec.ts` | Không có provider call mới; đổi kỳ chỉ là revision mới của cùng instance |
| Save/open/expand/pin/unpin | `e2e/j1.spec.ts:116`; `packages/core/test/mini-app-ownership.spec.ts` | Pin trỏ cùng logical instance, unpin giữ dữ liệu |
| Snapshot vs live, kể cả restart | `e2e/mini-app.spec.ts:136` + mục "Restart" dưới đây | Restart là process thật, không phải reload browser |
| Unknown renderer | `e2e/widget.spec.ts:113` — chèn message thật với definition `canvas.quantum@1@9.9.9` | Text alternative hiện, `[data-surface-composition]` = 0, không blank |
| Provider timeout/disabled | `apps/runtime/test/jev-selector.spec.ts` (fallback có `fallbackReason`), `mini-app-compose.spec.ts` (không gọi provider khi template được nêu tên) | Bằng chứng ở tầng unit, không phải browser |
| Missing/deleted source | `packages/core/test/surface-snapshot.spec.ts` (tombstone, giữ text alternative) | Snapshot không đọc lại live |
| Concurrent tabs | `e2e/mini-app.spec.ts:172`; `mini-app-ownership.spec.ts` (lease hết hạn thu hồi được) | Một writer, tab còn lại read-only |
| Security | `mini-app-actions.spec.ts` (sai principal/digest/revision bị từ chối), `e2e/j1.spec.ts:161` (token không vào page) | Token live không xuất hiện trong DTO nào |
| Accessibility | `e2e/mini-app.spec.ts`: "the expanded view is operable and dismissible from the keyboard alone"; `e2e/j1.spec.ts:146`; `appearance.spec.ts` (modal, Escape trả focus) | Journey bàn phím đầy đủ trên chính mini-app: Enter mở expanded → `[data-close-live]` nhận focus → đổi kỳ bằng select → Enter vào ngày lịch → Escape đóng → focus về trigger |

## Evidence PNG

Tất cả nằm trong `plans/reports/evidence/` (gitignored, sinh lại bởi suite). Viewport desktop 1440×900, mobile 390×844; scheme đổi bằng `emulateMedia`.

| File | Route / view mode | Revision | Viewport, scheme | Assertion đi kèm |
|---|---|---|---|---|
| `miniapp-01-overview-desktop-light.png` | conversation, surface inline (snapshot) | snapshot rev 1 | 1440×900, light | 5 vùng + KPI + calendar chip |
| `miniapp-02-live-versus-snapshot.png` | conversation, snapshot inline + live đổi kỳ | snapshot rev 1 / live rev 2 | 1280×720, light | `data-snapshot-stale="true"` |
| `miniapp-03-overview-desktop-dark.png` | như 01 | snapshot rev 1 | 1440×900, dark | cùng assertion của 01 |
| `miniapp-04-overview-mobile-light.png` | như 01 | snapshot rev 1 | 390×844, light | cùng assertion của 01 |
| `miniapp-05-overview-mobile-dark.png` | như 01 | snapshot rev 1 | 390×844, dark | cùng assertion của 01 |
| `miniapp-06-ownership-refused.png` | tab thứ hai, surface pinned read-only | live rev 1 | 1280×720, light | `data-ownership="elsewhere"` + notice |
| `miniapp-07-expanded-keyboard.png` | expanded live view, thao tác bằng bàn phím | live rev 2 (đổi kỳ) | 1280×720, light | `[data-close-live]` focused, chi tiết lịch theo ngày đã chọn |
| `widget-01-table-in-conversation.png` | conversation, widget `canvas.table@1` | — | mặc định | bảng render từ dataset thật |
| `widget-02-unknown-renderer-fallback.png` | conversation, definition không có renderer | — | mặc định | fallback text, không blank |

So với hai sketch: bố cục, thứ tự vùng và hành vi khớp; **không** đánh giá pixel-perfect vì font và dữ liệu khác. Khác biệt có chủ ý: ở 390px surface chiếm toàn bộ bề ngang conversation thay vì panel hẹp — trên điện thoại panel hẹp là bất khả thi, nên ảnh mobile đóng vai "narrow panel". Không ảnh nào chứa token, key hay dữ liệu riêng của user.

## Snapshot vs live qua restart (process thật)

Chạy bằng script có kiểm soát trên data dir riêng (`/tmp/cc-restart`), node khởi động lại thật giữa hai lần đọc:

```text
snapshot before    rev=1 stale=false capturedAt=2026-09-17T10:25:15.986Z bundle=bundle_mu5dvdmq1c06068
action             period=month → revision 2
snapshot after N+1 rev=1 stale=true  capturedAt=2026-09-17T10:25:15.986Z bundle=bundle_mu5dvdmq1c06068
restart node       đọc lại cùng data dir
snapshot restarted rev=1 stale=true  capturedAt=2026-09-17T10:25:15.986Z bundle=bundle_mu5dvdmq1c06068
live after restart rev=2 state={"period":"month"} cùng compositionId
```

Kết luận: snapshot không bị viết lại khi live tiến (cùng `capturedAt`, cùng `bundleRef`, chỉ cột `stale` đổi), và live state sống qua restart. Đây là điều phase-06 yêu cầu ("old value giữ N sau live N+1 và restart") và nó không thể chứng minh bằng unit test.

## Latency (đường tất định, không provider)

Script: `.pi/tmp/measure-latency.ts` (chạy `npx tsx .pi/tmp/measure-latency.ts`), data dir tạm, 200 message.

| Đường | n | p50 | p95 | max |
|---|---|---|---|---|
| Index 1 message | 200 | 0.10 ms | 0.19 ms | 4.83 ms |
| Index 200 message (chạy lại, idempotent) | 1 | — | — | 20.5 ms |
| Search (34 query đã gán nhãn) | 34 | 0.12 ms | 0.70 ms | 1.49 ms |
| Compose overview (không provider) | 20 | 1.20 ms | 4.00 ms | 7.81 ms |
| Project finder, cache ấm | 10 | 0.08 ms | 0.69 ms | 0.69 ms |

Đối chiếu budget 4 s đề xuất: các đường tất định thấp hơn ba bậc độ lớn, nên chúng không phải nguồn rủi ro. Phần chưa đo được là round-trip provider thật, và **đó** là phần budget nhắm tới — vì vậy không có kết luận p95/SLA nào cho đường live ở đây. Quét project finder đầy đủ trên `~` thật (42 project, 20 033 entry) đã đo ở Phase 11: ~1,3 s, không truncate.

## Bug tìm thấy và sửa trong Phase 6

Viết browser test là cách duy nhất chạm được các đường này, và nó tìm ra bảy lỗi thật mà unit test không thấy:

1. `packages/conversation-client/src/Conversation.tsx`: `renderSurface` thiếu `datasets` trong dependency list → bảng luôn hiện "Chưa có dữ liệu để hiển thị" dù API trả 5 dòng (closure giữ state rỗng). Đã thêm dependency + ghi lại lý do.
2. Container `canvas.overview@1` bị kiểm tra **sau** `resolveRenderer` → mọi composed surface rơi vào nhánh fallback text vì container không phải leaf renderer. Đã đảo thứ tự, kèm comment giải thích.
3. `compose-mini-app.ts`: template `overview` không `fixed` renderer cho vùng `calendar` → vùng này **không bao giờ** được chọn, sketch mất lịch. Đã thêm vào `fixed` (vẫn `optional` theo dữ liệu).
4. `packages/core/src/conductor.ts`: nhánh composer cấp một `messageId` cho composer rồi `appendAssistant` cấp id khác → snapshot trỏ vào message không tồn tại, lịch sử mất sạch composed surface. Đã cấp id một lần.
5. `toSurfaceViewFromSnapshot` đánh dấu vùng không cần dữ liệu (`filter`, `cta`) là "missing" → card rỗng thay vì control dùng được. Đã sửa quy tắc: vùng không khai `dataRefs` thì không "missing".
6. Read-only bị chặn quá rộng (tắt luôn view state cục bộ) và quá hẹp (CTA vẫn trông bấm được): nay chỉ chặn kênh `onAction`, state cục bộ vẫn hoạt động, CTA render disabled kèm lý do "Chỉ xem". Trên ảnh `miniapp-06` điều này nhìn thấy được.
7. Client đọc `stale` từ document message (bất biến) thay vì từ row snapshot → inline surface không bao giờ báo cũ. Nay đọc `timeline.snapshots` (và type `Timeline` phía client đã khai `snapshots`, trước đó server gửi mà client không biết).

Ngoài ra `bootNodeServices` đã nhận `composeFromIntent` nhưng không forward vào conductor deps — sửa ở giai đoạn đầu Phase 6.

## BLOCKED

| Hạng mục | Điều kiện còn thiếu | Trạng thái |
|---|---|---|
| Live Jev integration (turn → UI bằng model thật), calibration ≥30 intent | `TYPESAFE_API_KEY` (không có trong `.env` của repo này); `CLARKCANT_JEV_LIVE=1` chưa đặt | `apps/runtime/test/jev-live.spec.ts` và `jev-calibration-live.spec.ts` in BLOCKED nêu tên biến, không skip im lặng |
| Chọn template bởi model thật | như trên | Đường model→tool→compose có test ở tầng unit (`mini-app-compose.spec.ts`) nhưng không phải model thật |
| Provider budget 4 s end-to-end | như trên | Chưa có số; phần tất định đã đo |

Quyết định thay thế: default `search.decider = "rank"` dựa trên số đo lexical 96,8% (Phase 8) và khoảng cách semantic 25%, không dựa trên calibration chưa chạy.

## Deferred, không claim đã xong

- Runtime cho `isolated-app` / `mcp-app` (policy + registry có test, runtime không có trong repo).
- Google Calendar connector (calendar hiện là record local, UI tự nói "chưa đồng bộ với Google Calendar").
- iframe mini-app và CTA dạng "agent làm việc X" (ngoài M1).

## Residual risks

1. Trong production, việc compose phụ thuộc model gọi tool; e2e chỉ chứng minh đường host-composer. Nếu model không gọi, người dùng không thấy surface — nhưng vẫn thấy text, nên hỏng theo hướng an toàn.
2. Node e2e đọc `.env` thật và cấu hình `deepseek/deepseek-v4-flash`. Suite hiện không chạm provider (đã kiểm log), nhưng một test mới gửi câu không khớp fixture/recipe sẽ **gọi provider trả phí**. Nên ghim node e2e vào cấu hình không provider (ví dụ unset `CC_MODEL_PROVIDER`) trong một task sau.
3. Lease live owner là 60 s, client refresh 30 s; tab bị treo quá hạn lease có thể bị tab khác thu hồi — có test recovery ở core, chưa có evidence browser cho tình huống treo thật.
4. `docs/manifest.json` phải được cập nhật hash mỗi lần sửa doc trong manifest; đã làm cho `widgets-and-extensions.md` nhưng đây là bẫy dễ quên.

## Câu hỏi chưa giải quyết

- Threshold confidence 0,85 / margin 0,20 vẫn là đề xuất; cần calibration với key thật để chốt hay chỉnh.
- Có nên chạy node e2e với cấu hình provider-free mặc định (thay vì dựa vào kỷ luật của test) không? Đề xuất: có, và nên làm trước khi mở PR.
- Vùng `image` chưa có trong template `overview` nào; cần một template thật sự dùng ảnh local hay để dành cho phase sau?

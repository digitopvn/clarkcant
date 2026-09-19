# Cập nhật tài liệu — pi runtime, vai trò Jev, memory management

**Ngày:** 2026-09-19 · **Branch:** `main` · **Commit nền đã đọc code:** `7f3127f`
**Yêu cầu:** phân tích kiến trúc codebase và cập nhật tài liệu nội bộ, trọng tâm `pi` agent runtime, vị trí/vai trò của Jev, và memory management.

## 1. Đã sửa gì và vì sao

| File | Thay đổi | Vì sao |
|---|---|---|
| `docs/system-architecture.md` | Thêm **§7.3 Pi runtime: Main Pi, control extension và worker**; §7.2 nay liệt kê đủ **năm** đường dùng Jev (thêm E — tin đến khi đang chạy); §10 thêm ownership của Memory & Search và hai chỗ cố ý không bền vững; §3/§12/§14 đổi provider voice sang Gemini Live; header nói rõ code sở hữu hành vi | Ba mảng được yêu cầu không có chỗ cư trú trong tài liệu, và §7.2 thiếu một đường dùng Jev đã có code |
| `docs/README.md` | Trạng thái "chưa có implementation" → blueprint + code sở hữu hành vi; thứ tự đọc bổ sung mục 9 (Jev selector) và 10 (ADR-001, compatibility lock); Changelog thành mục 11 | Người đọc theo index không bao giờ tới được tài liệu vận hành Jev hay các ADR |
| `docs/scope-lock.md` | Hàng Voice: Gemini Live sau proxy WebSocket phía node | ADR-001 accepted yêu cầu nêu tên Gemini |
| `docs/research-and-decisions.md` | Hàng ánh xạ R29 đổi thành "Voice tách frontend và delegated backend"; thêm ghi chú dưới R29 về provider đã bị thay | Giữ nguồn R29 (nguyên tắc tách frontend/backend vẫn đúng) nhưng không để nó hàm ý GPT-Live |
| `docs/implementation-plan.md` | §P0.6 và §12 (P9) đổi tên provider, trỏ về ADR-001 | Hai dòng này cũng là claim sai sau ADR-001 |
| `docs/conformance-traceability.md` | V17: câu "The WebRTC transport needs a provider account" → mô tả đúng transport (WebSocket qua node tới Gemini Live, browser không giữ credential). **Không đổi status** | ADR-001 nêu đích danh V17 phải được cập nhật |
| `README.md` (gốc) | Số acceptance test 44/4/24 → **64/4/4**; mục "conductor và worker pool" viết lại cho đúng (conductor đã wired, thiếu worker pool); danh sách transport còn thiếu bỏ voice, MCP stdio, Playwright và nêu rõ MCP streamable HTTP | Các con số và claim này trái với ledger và với code |
| `docs/manifest.json` | `status` và `date` viết lại; bytes + sha256 tính lại cho 5 entry | Invariant `docs-manifest-integrity` |

## 2. Bằng chứng cho các claim mới

**Pi runtime (§7.3).** `packages/pi-adapter` là package duy nhất import `@earendil-works/pi-coding-agent` (pin `0.85.1`, khớp `pnpm-lock.yaml`); interface `PiAdapter` ở `packages/pi-adapter/src/types.ts`; hai implementation `RealPiAdapter` và `FakePiAdapter`. Control extension đối chiếu với các box trong `docs/system-architecture.png`: `runtime-candidates.ts`, `session-store.ts` + `session-search.ts`, `model-turn.ts` + `background-sessions.ts`, `project-finder.ts`. Tool công bố lúc boot: `tool-catalogue.ts` (`registerNodeTools`), tool chỉ-đọc `node-tools.ts`. `onSessionFile` và `SessionManager.create(cwd, sessionDir)` ở `packages/pi-adapter/src/real.ts`; `checkResumable` ở `apps/runtime/src/session-store.ts`. Chỗ duy nhất runtime spawn process: `apps/runtime/src/run-command.ts` (grep toàn `apps/runtime/src` chỉ khớp file này).

**Vai trò Jev (§7.2).** `apps/runtime/src/jev-decider.ts` export `decideRuntimeTarget`, `decideProject`, `decideSearchResult`, `decideTurnAction` (`TurnAction = "steer" | "interrupt" | "background"`, gọi từ `apps/runtime/src/gateway.ts` ở nhánh message khi turn đang chạy); `apps/runtime/src/jev-selector.ts` export `selectTemplate`/`selectSections` (gọi từ `compose-mini-app.ts`). Trần 12 candidate và nhánh "một candidate thì không gọi provider" nằm trong từng hàm `decide*`; `askNoul` chỉ được dùng ở `decideSearchResult`.

**Memory management (§10).** `apps/runtime/src/model-turn.ts` (`recapFor`) lấy `messages.slice(-12)` và cắt mỗi dòng còn 400 ký tự; `packages/storage/src/repositories.ts` (`advanceSessionIngestCursor`) chỉ tiến con trỏ; `apps/runtime/src/session-store.ts` kiểm tra path nằm trong thư mục session rồi mới đăng ký và redact ở boundary cuối lượt; `background-sessions.ts` nói rõ trạng thái nằm trong bộ nhớ; telemetry Jev chặn ở 200 dòng (`docs/mini-app/jev-configuration.md`, §Telemetry).

**Voice.** `packages/voice-adapters/src/gemini-live.ts`, `apps/runtime/src/voice-session.ts` (WebSocket `/voice`, proxy phía node), `docs/research/adr-001-gemini-live-provider.md`; bằng chứng live ở `plans/reports/verification-260917-1018-live-audio-roundtrip.md` và đường browser ở `verification-260917-1110-voice-browser-path.md`.

**Con số README.** Đếm trực tiếp từ `docs/conformance-traceability.md`: 64 PASS, 4 BLOCKED, 4 NOT-IMPLEMENTED trên 72 hàng T; 18 hàng V đều PARTIAL. Con số này chỉ đọc cột status của hàng T — phần diễn giải V nêu ở §4 là chuyện khác và không ảnh hưởng ba bucket này. MCP stdio có thật và có test (`packages/mcp-adapters/src/stdio.ts`, `test/stdio.spec.ts`); Playwright driver có thật (`packs/browser-playwright/src/driver.ts` + 3 spec). Capability vẫn đăng ký `installed: false` với `blockedReason: "the pack is declared but no worker has loaded it on this node"` (`apps/runtime/src/services.ts`), và không file nào spawn `apps/worker`.

## 3. Validation

- `pnpm verify`: 7/7 invariant, typecheck, lint, **1015 passed / 7 skipped (78 file chạy, 1 skip)**.
- Kiểm link tương đối: 39 link trong 8 file vừa sửa, 0 broken (`.data/probe/links.mjs`).
- `docs/manifest.json`: round-trip `JSON.stringify(x, null, 2)` khớp byte-for-byte trước khi sửa, nên diff chỉ gồm 5 entry hash + status + date. Kiểm lại bằng `.data/probe/hashdiff.mjs`: đúng **5** entry đổi hash và chúng khớp đúng 5 tài liệu có trong manifest mà tôi sửa. File sửa thứ sáu (`README.md` ở gốc repo) **không phải** entry của manifest — manifest tính đường dẫn tương đối từ `docs/`, nên `README.md` trong đó là `docs/README.md`. `docs/conformance-traceability.md` và chính `docs/manifest.json` cũng ngoài manifest.
- `docs/system-architecture.png` là nguồn sự thật theo AGENTS.md nhưng model hiện tại không đọc được ảnh; tôi trích chữ bằng Windows OCR (`.data/ocr.ps1`) để lấy tên box, rồi đối chiếu với code. Giới hạn: OCR có thể sót chữ nhỏ, và tôi không phát hiện box nào tên Jev trong sơ đồ — nghĩa là §7.2 chi tiết hơn sơ đồ chứ không mâu thuẫn.
- pi-lens báo MD060 (table column style) cho các bảng mới. Toàn bộ bảng khác trong file dùng cùng kiểu pipe compact, repo không có cấu hình markdownlint, nên tôi giữ nguyên kiểu của file.

## 4. Chưa làm, và câu hỏi còn mở

1. **Cột V trong `docs/conformance-traceability.md` vẫn sai ở V01, V03, V11, V12, V14, V16** (ví dụ V12 ghi "The mini-app runtime is not built" trong khi `compose-mini-app.ts` tồn tại). Không sửa vì repo yêu cầu mỗi lần đổi phải có test được nêu tên. Đây là việc riêng, cần chạy test theo từng dòng.
2. **`README.md` §"What actually works"** chưa được soát lại từng dòng; tôi chỉ sửa phần trạng thái và danh sách transport.
3. **`docs/research/*.md` và `docs/system-architecture.png` không nằm trong `docs/manifest.json`**, nên không được invariant hash bảo vệ dù nay đã được trỏ tới như nguồn sự thật từ ba tài liệu. Có nên thêm entry không?
4. **`docs/research/compatibility-lock.md`** được sinh trên darwin/arm64, Node 24.19.0, chưa chạy lại probe trên máy này. File tự nói không sửa tay, nên tôi để nguyên.
5. V17 có thể xứng đáng PASS hơn là PARTIAL, nhưng tôi không đổi status vì chưa đối chiếu từng boundary của V17 với test được nêu tên.

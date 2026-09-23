# Đánh giá toàn diện codebase ClarkCant

**Ngày:** 23/09/2026 · **Nhánh:** `claude/codebase-review-improvements-214882` (ngang `main` tại `9437e35`) · **Phạm vi:** toàn bộ `apps/`, `packages/`, `packs/`, `tools/`, CI, Docker, tài liệu.

## 1. Kết luận

ClarkCant có **nền móng kỹ thuật tốt hơn mức thường thấy ở một bootstrap**: contract được validate lúc runtime, TypeScript strict tối đa, supply-chain policy chặt, ranh giới bảo mật (vault, env allowlist, path confinement, trust lane widget) được viết thành code có test, và sổ conformance trung thực. Đợt consolidation #125 vừa xong đã gỡ được nợ lớn nhất (gateway 3.6k dòng → 237 dòng, một execution policy duy nhất).

Vấn đề chính hiện nay **không nằm ở chất lượng từng module mà ở hình dạng tổng thể**:

1. **Kiến trúc đi trước sản phẩm.** Nhiều primitive (lease, grant, install lifecycle, conductor) đã có, nhưng các hành trình người dùng đầu-cuối tạo ra giá trị (dispatch task cho worker, cài package từ UI, desktop build thật) vẫn chưa chạy.
2. **Nợ kích thước file ở tầng UI và storage.** `Conversation.tsx` là một component duy nhất khoảng 2.200 dòng; `repositories.ts` gom mọi domain vào 2.889 dòng.
3. **Bộ test không chạy xanh trên macOS**, trong khi desktop đầu tiên nhắm macOS. CI chỉ chạy Ubuntu nên không bắt được.
4. **Chi phí quy trình cao.** Khoảng 23% commit là `docs`, và thư mục plans chứa nhiều vòng advisory/review cho mỗi phase.

## 2. Phương pháp và bằng chứng

- Đọc README, `docs/README.md`, `system-architecture.png`, DESIGN.md, AGENTS.md, plan #125 và #128.
- Bốn luồng rà soát song song: runtime, domain packages, UI/UX, chất lượng/tooling. Các kết luận quan trọng được kiểm chứng lại trực tiếp. Hai kết luận của agent đã bị loại vì sai: "thiếu `data-orb-profile`" (thực tế có ở `Orb.tsx:283`) và "fixture-model 41.6k dòng" (thực tế 906 dòng).
- Chạy `pnpm install --frozen-lockfile` và `pnpm verify` trên macOS (Darwin 25.6, máy dev): invariants, typecheck, lint đều xanh. **Test: 2.332 pass, 11 fail, 7 skip / 2.350** trong 56,6 giây.
- Chưa chạy `pnpm test:e2e` và chưa có buổi walkthrough giao diện trực quan, nên phần UI/UX dựa trên code và test e2e hiện có.

Quy mô: khoảng 82k dòng source (runtime 24k, conversation-client 19,5k, core 9,5k, contracts 8,3k, storage 4,8k) và khoảng 50k dòng test.

## 3. Điểm mạnh nên giữ

- **Contract-first:** mọi ranh giới đều qua Zod; `contracts` không phụ thuộc gì, đồ thị package một chiều `contracts → storage → core`, không có vòng lặp.
- **TypeScript nghiêm:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESLint chặn cú pháp Node type-stripping không chạy được.
- **Bảo mật có test:** so sánh token constant-time (`routes/http.ts:73-79`), auth tập trung trong gateway, secret broker chỉ đưa giá trị qua callback và audit theo tên (`secret-broker.ts`), sandbox widget không có `allow-same-origin` và dùng CSP `default-src 'none'` (`widget-host/src/index.ts:169-206`), host-owned block bị từ chối khi đến từ origin khác.
- **Storage an toàn:** prepared statement ở mọi nơi, từ chối transaction lồng nhau, migration forward-only kèm `user_version`.
- **Durability:** idempotency key, effect `unknown` không bao giờ tự retry, backup `VACUUM INTO` có kiểm tra toàn vẹn.
- **Motion helpers mẫu mực:** `design-tokens/src/motion.ts` chỉ animate transform/opacity và có nhánh reduced-motion rõ ràng.
- **Trung thực:** README ghi rõ phần chưa chạy; `implementation-status.ts` (15 implemented, 15 partial, 4 blocked) được `pnpm invariants` đối chiếu với tên test thật.

## 4. Phát hiện

Mức độ: **Cao** nghĩa là ảnh hưởng người dùng, bảo mật hoặc khả năng ship; **TB** là nợ đang làm chậm; **Thấp** là dọn dẹp.

### 4.1 Kiến trúc

| # | Mức | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| A1 | Cao | Chuỗi giá trị lõi chưa khép kín: conductor chạy state machine nhưng không có worker nào nạp capability, `apps/worker` là CLI mà runtime không spawn. Install lifecycle chưa từng chạy đầu-cuối từ trình duyệt. | README mục "What does not work yet"; `packages/core/src/conductor.ts` | Chọn **một vertical slice** ("cài một pack qua chat → task dispatch → worker chạy → kết quả thành widget") và làm cho nó chạy thật trước khi mở thêm primitive mới. |
| A2 | Cao | Lane packed-worker chưa bị giới hạn bởi `projectRoots`. Đây là khoảng hở bảo mật còn mở sau #125, vì Pi session đã bị giới hạn nhưng worker lane thì chưa. | Issue #137 | Ưu tiên trước mọi tính năng worker mới, vì A1 sẽ mở rộng đúng lane này. |
| A3 | TB | Trust boundary của isolated widget còn khoảng hở và hành trình trình duyệt chưa được chứng minh. | Issue #93 | Gộp vào cùng đợt hardening với A2. |
| A4 | TB | `storage/src/repositories.ts` (2.889 dòng) gom commands, outbox/inbox, tasks, effects, approvals, leases, grants, projects, connections, artifacts, pairing vào một module. | `packages/storage/src/repositories.ts` | Tách theo aggregate (`repositories/tasks.ts`, `…/effects.ts`, `…/projects.ts`…), giữ nguyên `index.ts` re-export để không đổi API. |
| A5 | TB | `apps/runtime/src` vẫn phẳng với khoảng 55 file; chỉ routes/application/bootstrap được tách. Các cụm jev-\*, voice-\*, mini-app-\*, session-\*, project-\*, model-\* nằm lẫn nhau. | `ls apps/runtime/src` | Gom theo feature: `features/jev/`, `features/voice/`, `features/mini-app/`, `features/search/`… Chỉ di chuyển file, không đổi behavior; invariants có thể chặn import chéo feature. |
| A6 | TB | Các file lớn còn lại ở runtime/core: `routes/conversations.ts` 1.291, `node-tools.ts` 1.142, `voice-session.ts` 1.052, `model-turn.ts` 997, `widget-service.ts` 1.455. | `wc -l` | Tách dần khi chạm vào, bắt đầu với `routes/conversations.ts` (turn streaming tách khỏi CRUD conversation). |
| A7 | Thấp | `searchProjects` gọi `getProject` trong vòng lặp, tối đa 16 truy vấn theo PK. Hiện chưa đáng kể, nhưng sẽ thành N+1 thật nếu nâng `limit`. | `repositories.ts:1440-1452` | JOIN `project_fts` với `project_index` trong một truy vấn. |
| A8 | Thấp | Test của vault AES-GCM (`host-adapters`) nằm trong `widget-host/test/seams.spec.ts`, còn chính package đó không có thư mục test. | `packages/widget-host/test/seams.spec.ts:63` | Chuyển test về `packages/host-adapters/test/` để dễ tìm. |

### 4.2 Chất lượng, test, hạ tầng

| # | Mức | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| Q1 | Cao | **`pnpm verify` đỏ trên macOS.** 10/11 test fail vì kỳ vọng so với đường dẫn `tmpdir()` chưa canonical (`/var/...`), trong khi code trả về đúng bản canonical `/private/var/...`. Code đúng, test sai. CI chỉ chạy `ubuntu-latest` nên không phát hiện, dù desktop đầu tiên nhắm macOS. | `packages/pi-adapter/test/scoped-fs.spec.ts:94,102,120,148…`, `scoped-fs-canonicalisation.spec.ts:80`, `apps/runtime/test/project-session.confinement.spec.ts:119`, `.github/workflows/ci.yml:19` | Dùng `realpathSync(mkdtempSync(...))` trong fixture; thêm job `macos-latest` cho ít nhất `pi-adapter` và `runtime`. |
| Q2 | TB | `bind-failure.spec.ts` timeout 20 giây trong vitest, cả khi chạy riêng. Chạy tay cùng lệnh thì node thoát sau 1–2 giây với đúng thông báo. Nguyên nhân chưa xác định; nhiều khả năng do khác biệt môi trường giữa worker vitest và shell. | `apps/runtime/test/bind-failure.spec.ts:41` | Điều tra riêng (ghi lại stderr của child khi timeout). |
| Q3 | TB | Docker image chạy bằng **root**, không có `HEALTHCHECK`, và `COPY . .` rồi cài **toàn bộ workspace kể cả devDependencies** (electron, playwright, vitest…) vào image runtime. | `Dockerfile:14-37` | `pnpm deploy --filter <runtime> --prod`, `USER node`, `HEALTHCHECK` gọi `/health`. |
| Q4 | TB | Chi phí quy trình: 86/369 commit là `docs`; mỗi phase kèm advisory, red-team, review, reply; mỗi lần sửa doc phải cập nhật sha256 trong `docs/manifest.json`; AGENTS.md + DESIGN.md khoảng 1.500 dòng nạp vào context agent. | `git log`, `plans/260921-1322-125-*` (25 file) | Giữ các gate tự động; chỉ làm advisory nhiều vòng cho thay đổi rủi ro cao; cân nhắc bỏ hash cho doc thuần văn xuôi; tách DESIGN.md thành phần "hard rules" ngắn và phần "target" tham khảo. |
| Q5 | Thấp | `tools/check-invariants.mjs` 880 dòng trong một file và vẫn đang lớn lên. | `tools/check-invariants.mjs` | Tách thành một module cho mỗi check, có test riêng. |
| Q6 | Thấp | `data-canvas` có status `implemented` nhưng 0 test; `computer-*` 0 test (blocked). | `packs/*/test` | Thêm test schema tối thiểu cho `data-canvas`. |

### 4.3 Tính năng

- **Đang chạy thật:** conversation streaming, tool call thành widget, reasoning widget, attachments, search máy (read-only), memory, suggestions, model pool, execution policy (guarded mặc định), `ask_user_question`, widget library/lab, session preview từ browser thật, backup.
- **Bị chặn bởi yếu tố bên ngoài (đúng là không làm được trong repo):** OAuth/Google Calendar live (#2), Computer Use (#3), voice live (#4), pairing hai host (#5).
- **Chưa chạy dù nằm trong tầm tay của repo:** worker pool và dispatch (A1), install đầu-cuối từ UI, quarantine download và isolated build, MCP streamable-HTTP, desktop shell ngoài IPC bridge, AppIntent thống nhất cho main agent và voice (#129).
- **Đề xuất thứ tự:** A2 → worker và dispatch (A1) → install đầu-cuối từ UI → AppIntent (#129, để voice và text dùng chung đường action như AGENTS.md yêu cầu) → MCP HTTP. Hai PR mở từ 19/09 (#54, #56) nên được merge hoặc đóng để không bị lệch với `main`.

### 4.4 UI và UX

| # | Mức | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| U1 | Cao | `Conversation` là **một function component khoảng 2.200 dòng** với 37 `useState` và 18 `useEffect`. Khi đang stream, mỗi thay đổi state đều render lại toàn bộ cây; timeline không có virtualization. | `packages/conversation-client/src/Conversation.tsx:191` | Tách thành `useConversationStream`, `useComposer`, `useVoice`, `useSurfaces` (reducer và context); tách `Timeline`, `Hero`, `Composer`, `Header`; memo từng message; virtualize khi hội thoại dài. |
| U2 | TB | Ngôn ngữ UI không nhất quán: phần lớn copy là tiếng Việt (`<html lang="vi">`, khoảng 440 chuỗi), nhưng các tab Settings là tiếng Anh ("Experience", "AI & Routing", "Control", "Extensions", "Memory", "Developer"). Không có lớp i18n; copy được hard-code trong component. | `settings/SettingsPanel.tsx:45-58` | Gom copy vào catalog `messages.vi.ts`/`messages.en.ts` với một hàm `t()`; thống nhất nhãn tab. |
| U3 | TB | Thiếu `data-window-mode` và `data-policy-mode` ở root, trong khi DESIGN.md §4 định nghĩa chúng là hợp đồng trạng thái. Hiện chỉ có `data-input-modality` và `data-agent-state`. | `Conversation.tsx:1719-1720`, `DESIGN.md:267-268` | Publish hai attribute này; voice bar/orb mode và chip policy style theo chúng thay vì đoán từ DOM. |
| U4 | TB | Vi phạm quy tắc motion: thời lượng hard-code `80ms linear`/`90ms linear` và animate `height`/`width` (thanh sóng voice, mic level). | `styles.ts:188,1029,1042`; `HERO_CHIP_STAGGER_MS = 90` ở `Conversation.tsx:180` | Dùng token motion; chuyển sang `transform: scaleY/scaleX`. |
| U5 | TB | Credential nằm rải rác: key Gemini nhập trong tab "Devices & Voice", không có mục Credentials thống nhất như DESIGN.md §11.6. | `settings/DevicesVoiceSettings.tsx:96-152` | Một mục Credentials chung (tên, mục đích, trạng thái, replace/remove); các tab khác chỉ link đến đó. |
| U6 | TB | Styling là một chuỗi CSS 1.624 dòng, chỉ có 5 `@media`; e2e chỉ đặt viewport hẹp trong 2/36 spec (mini-app, widget-library). Hành trình hội thoại chính ở màn hẹp chưa được assert, dù AGENTS.md yêu cầu. | `styles.ts:1299-1619`; `apps/web/e2e/` | Tách CSS theo feature, dùng `@layer`; thêm project Playwright viewport 390px chạy các spec lõi. |
| U7 | Thấp | Một số affordance chỉ có `:hover` mà không có `:focus-visible` tương ứng (menu background task, selection menu). | `styles.ts:208,228,620,889…` | Thêm rule `:focus-visible` song song với hover. |
| U8 | Thấp | Các hành trình theo DESIGN.md chưa có e2e: đổi window mode (normal/compact/orb), đổi policy mode và guardrail, selection toolbar, compact voice bar. | `apps/web/e2e/` | Thêm spec cho từng hành trình khi làm feature tương ứng. |

Phía UI đã làm tốt: live region chỉ bao status line thay vì cả timeline, Escape đóng surface và trả focus, không tự cuộn khi người đọc đã cuộn lên (`follow-bottom.ts`), attachment có đủ trạng thái checking/failed/retry, touch target được e2e kiểm, Orb có fallback và nhánh reduced-motion.

## 5. Lộ trình cải tiến đề xuất

**Đợt 1 — ngay (1–3 ngày, rủi ro thấp):**
1. Sửa Q1 (canonical tmpdir trong test) và thêm job CI macOS; điều tra Q2.
2. Sửa Dockerfile (Q3): prod-only, non-root, healthcheck.
3. Dọn motion (U4) và `:focus-visible` (U7).
4. Merge hoặc đóng PR #54, #56.

**Đợt 2 — ngắn hạn (1–2 tuần):**
5. Đóng #137 và #93 (A2, A3).
6. Tách `Conversation.tsx` (U1). Đây là việc có đòn bẩy UX lớn nhất: giảm re-render khi stream, và làm U3/U8 dễ hơn.
7. Thêm `data-window-mode`/`data-policy-mode` (U3), thống nhất ngôn ngữ và lớp i18n tối thiểu (U2), mục Credentials (U5).

**Đợt 3 — trung hạn (vertical slice):**
8. Worker pool và dispatch chạy thật (A1), rồi install đầu-cuối từ UI, rồi AppIntent (#129).
9. Tách `repositories.ts` (A4) và nhóm `apps/runtime/src` theo feature (A5), thực hiện theo từng PR nhỏ không đổi behavior.
10. Giảm chi phí quy trình (Q4): chỉ chạy advisory nhiều vòng cho thay đổi rủi ro cao; tách DESIGN.md thành hard rules và target.

## 6. Câu hỏi chưa giải quyết

1. Nguyên nhân `bind-failure.spec.ts` timeout trong vitest trên macOS mà chạy tay thì không (Q2)?
2. Thị trường mục tiêu có gồm người dùng không nói tiếng Việt không? Câu trả lời quyết định U2 chỉ cần thống nhất nhãn hay phải có i18n đầy đủ.
3. Ưu tiên sản phẩm giữa vertical slice worker/install (A1) và AppIntent/voice (#129): việc nào đi trước?
4. Có chấp nhận nới quy trình (bỏ hash cho doc văn xuôi, giảm vòng advisory) hay đây là yêu cầu compliance cố định?
5. Hai phát hiện từ agent chưa được kiểm chứng: race khi `voice-session.close()` không chờ `wss.close()` (`voice-session.ts:1020-1023`), và việc không giới hạn số candidate trước khi gửi cho Jev (`jev-selector.ts`). Cần xác minh trước khi đưa vào backlog.

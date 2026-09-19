---
title: "Issue #17 — đính kèm file, thanh voice tối giản, voice điều khiển app, gợi ý từ việc gần đây, tab Memory"
description: "Năm tính năng của issue #17, chia ba chặng ship: đính kèm file; cửa sổ desktop tối giản + voice điều khiển app; gợi ý theo việc gần đây + tab Memory."
status: pending
priority: P1
effort: "~52h agent-hours tuần tự; ba PR tuần tự trên cùng một nhánh"
issue: 17
branch: "mrgoonie/feat-file-attachments-minimal-voice-bar-voice-co"
tags: [feature, frontend, backend, api]
blockedBy: []
blocks: []
created: 2026-09-19
updated: 2026-09-19
---

# Issue #17 — năm tính năng, ba chặng ship

## Overview

Plan này triển khai đủ năm mục của [issue #17](https://github.com/digitopvn/clarkcant/issues/17/):
(1) đính kèm file cho composer và cho agent, (2) cửa sổ desktop thu nhỏ tối thiểu còn thanh voice,
(3) voice điều khiển được app qua đúng đường của click, (4) gợi ý ở màn hình mở app tổng hợp từ
việc gần đây, (5) tab Memory trong Settings.

Issue gộp năm tính năng nhưng chính issue ghi "để mỗi tính năng tách thành nhánh riêng khi triển
khai". Plan chia **ba chặng ship** trên cùng một nhánh. Thứ tự trong mỗi chặng là thứ tự **thực thi**,
không phải thứ tự đánh số ban đầu: vòng red-team đã đảo Stage B để phần chỉ chạy trong trình duyệt
(registry + T66) land trước phần cần shell desktop.

> **Supersession 2026-09-19:** phases pending 5–8 (shared app-control, voice/widget parity, desktop compact window, minimal voice bar) được thay bởi `../260919-1833-conversation-first-ux-widget-platform/plan.md`, vì UX mới cần chung typed preferences, execution policy, window modes, detach và voice capabilities. Không implement hai registry/desktop bridge song song. Phases 1–4 đã done giữ nguyên; phases 9–11 recent-work/memory vẫn còn hiệu lực nhưng Settings UI phải theo `DESIGN.md` mới.

## Quyết định đã chốt với user (2026-09-19)

| # | Câu hỏi | Chốt | Hệ quả |
|---|---------|------|--------|
| 1 | Hình thức ship năm tính năng | **Ba PR ghép cặp**: A = đính kèm file; B = voice điều khiển app + cửa sổ tối giản; C = gợi ý + tab Memory | Mỗi stage có cổng riêng (verify + e2e) và một PR |
| 2 | Retention của blob đính kèm | **Theo conversation + quota theo node** | Bảng `attachments` gắn `conversation_id`; hạn mức tính bằng `SUM(size_bytes)`; có hàm `releaseConversationAttachments` để xoá theo conversation |
| 3 | Phạm vi voice điều khiển | **Chỉ app trên node này** | Intent điều khiển app chrome của host local; điều khiển node đã pair là OUT, không claim |
| 4 | Tab Memory | **Xem nguồn rồi xoá** | Không sửa nội dung tại chỗ; xoá là xoá thật khỏi đường inject |

## Ràng buộc kiến trúc kế thừa từ `docs/`

- `docs/system-architecture.md` §11 "Unified UI/action path": voice có semantic view của instance
  đang focus và đi qua **cùng** path với click. Không dựng đường thực thi thứ hai.
- `docs/system-architecture.md` §10 + §"blob store có quotas": blob local có metadata/digest và hạn mức.
- `docs/system-architecture.md` §12: microphone/speaker do host local kiểm soát; `MediaFocusService`
  quyết định ai đang giữ mic; mute/end không phụ thuộc remote node hay model.
- `docs/widgets-and-extensions.md` §8: "Dataset/attachments qua opaque refs, no arbitrary paths,
  executable URLs" — ràng buộc trực tiếp cho `AttachmentRefV1` **và** cho prompt gửi model.
- `docs/scope-lock.md` §Personalization: "không hidden memory" — mọi thứ đã nhớ đều nhìn thấy và xoá được.
- `AGENTS.md`: không `enum`/`namespace`/constructor parameter properties; không sửa migration đã apply;
  `packages/pi-adapter` là package duy nhất được import Pi SDK.

## Facts đã kiểm tra trong repo (2026-09-19, sau vòng red-team)

| Điều | Thực tế trong repo | Hệ quả cho plan |
|---|---|---|
| Blob store | **Đã có**: `dataDir/blobs`, tên content-addressed `sha256:<hex>` → `<32 hex>.<ext>`, ghi `{ mode: 0o600 }`, đọc qua `isWithinRoot` (`apps/runtime/src/mini-app-data.ts:576-581`, `apps/runtime/src/gateway.ts:730-734`) | Phase 1 **trích xuất** nó thành một module blob dùng chung rồi tái sử dụng; **không** dựng store thứ hai, không tạo thư mục mới |
| Kiểm loại file | `sniffImage(bytes, declaredMimeType)` quyết định bằng magic bytes rồi đối chiếu declared type (`apps/runtime/src/mini-app-data.ts:426-430`) | Phase 1 mở rộng thành `sniffContentType` cho ảnh + PDF + text; lệch nhau → `ATTACHMENT_TYPE_MISMATCH` |
| `GatewayResponse` | Chỉ có `stream` và `binary: { bytes, contentType }`; **không** có field headers (`apps/runtime/src/gateway.ts:91-116`); transport tự viết `content-type`/`content-length`/`cache-control` (`apps/runtime/src/main.ts:649-656`) | Phase 2 thêm `headers?` vào `binary` và để transport gộp, nhưng **từ chối** header host-owned |
| Entry node | `apps/runtime/src/main.ts` **không export gì**; nó tự boot ở top level | Phase 2 tách `createNodeServer` sang `apps/runtime/src/server.ts` để test boot được server thật trên port 0 |
| Trần body | `main.ts` gom chunk **không giới hạn** (`chunks.push(chunk)` rồi `Buffer.concat`) | Phase 2 thêm trần **chỉ** cho `/attachments` |
| Fixture model | `CC_MODEL_FIXTURE=1` chạy `composeFromIntent` **trước** lượt model và chỉ nhận `input.text`; fixture trả lời thì lượt model bị bỏ qua (`apps/runtime/src/main.ts:124-127`, `packages/core/src/conductor.ts:433-450`) | Phase 4 **không** dùng fixture để chứng minh prompt; chứng minh prompt ở seam adapter bằng `FakePiAdapter` trong vitest |
| Seam lượt | `ModelTurnInput` không có trường attachment; `promptForTurn({ text, note })`; `appendUser` hardcode một block text (`packages/core/src/conductor.ts:353-372`) | Phase 3 mở `UserMessageInput.attachmentRefs` + `appendUser(..., extraBlocks)` rồi để lượt đọc block đã lưu — **một** nguồn sự thật |
| Xoá conversation | **Không có** route/hàm nào. 4 bảng tham chiếu `conversations` không `ON DELETE CASCADE` (`migrate.ts:168,175,399,442`) và `PRAGMA foreign_keys = ON` (`db.ts:55`) | Phase 2 **bỏ** ý tưởng thêm `DELETE /conversations/:id`; retention giữ ở mức "gắn conversation + quota", cascade ghi là gap có tên ở Phase 12 |
| Desktop shell | Cửa sổ Electron load `file://…/shell.html` (trang demo posture), **không** load conversation client; không có mã client nào chạm `window.clarkcant`; CSP `default-src 'none'`, `connect-src 'self'` (`apps/desktop/src/main.mjs:36-39`, `security.mjs:65-77`) | Phase 7 phải quyết định và viết ra: cửa sổ shell **load client**, kèm CSP theo origin và probe smoke trên đúng document đó |
| Settings | `TABS` 4 tab (`SettingsPanel.tsx:53`) | Phase 11 thêm tab thứ năm `memory` |
| Migration | 16 bản, bản cuối `credentials` (`migrate.ts:872`) | Phase 1 thêm 17, Phase 10 thêm 18 |
| T66 | `docs/conformance-traceability.md:85` — T66 là **widget action state**, không phải trạng thái panel Settings | Phase 6 làm đúng T66 (voice chạm cùng action state của một widget); test panel Settings có T-id riêng (T73) |
| E2E | Playwright chỉ chạy browser (`playwright.config.ts:33`); không có `window.clarkcant` trong client | Phase 8 thêm hook test-only `?cc-compact=1` để suite browser chạm được thanh tối giản; bounds thật do smoke desktop chứng minh |

## Chặng ship

| Stage | Nội dung | Phase (thứ tự thực thi) | Cổng ra |
|---|---|---|---|
| **A** | Đính kèm file: contract, blob store dùng chung, route, composer, timeline, nội dung tới agent | 1 → 2 → 3 → 4 | `pnpm verify` + `pnpm test:e2e` xanh; journey đính kèm; test từ chối path tuyệt đối/URL thực thi; prompt không chứa path; evidence PNG |
| **B** | Voice điều khiển app + cửa sổ desktop tối giản | 5 → 6 → 7 → 8 | Registry chạy được hoàn toàn trong browser; T66 và T73 có test thật; smoke desktop xanh với bounds đọc từ Electron; thanh tối giản giữ phiên |
| **C** | Gợi ý theo việc gần đây + Memory store + tab Memory | 9 → 10 → 11 | journey seed hai phiên; journey memory ghi → thấy → xoá → không được inject lại |
| — | Docs, traceability, evidence, release validation | 12 | `pnpm verify:full` xanh, evidence đủ, traceability khớp test thật |

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Contract đính kèm, blob store dùng chung và quota](./phase-01-attachments-contract-and-store.md) | Done |
| 2 | [Route upload/download, header transport và seam server](./phase-02-uploads-and-blob-store.md) | Done |
| 3 | [Composer, timeline và nội dung tới agent](./phase-03-composer-timeline-and-agent-content.md) | Done |
| 4 | [Journey đính kèm và evidence](./phase-04-attachments-journey-and-evidence.md) | Done |
| 5 | [Registry app-intent dùng chung cho chat, click và voice](./phase-05-shared-app-control-intents.md) | Done |
| 6 | [T66 — voice và click chạm cùng một widget action state](./phase-06-voice-widget-action-parity.md) | **Chưa đạt tiêu chí** — phần cài đặt xong và có 10 test resolver, nhưng T66 vẫn `NOT-IMPLEMENTED` vì journey browser không chạy được (fixture thoại đưa câu đã script cho sai phiên). Điều kiện còn thiếu ghi trong file phase và trong ledger. |
| 7 | [Cửa sổ desktop compact, shell load client và bridge có tên](./phase-07-desktop-compact-window.md) | Done — smoke Electron do người vận hành chạy, CI không có display |
| 8 | [Thanh voice tối giản, intent cửa sổ và phiên sống qua hai chiều](./phase-08-minimal-voice-bar.md) | Done |
| 9 | [Gợi ý từ việc gần đây](./phase-09-recent-work-suggestions.md) | Done |
| 10 | [Memory record bền vững và tool `remember`](./phase-10-durable-memory-records.md) | Done |
| 11 | [Tab Memory trong Settings](./phase-11-settings-memory-tab.md) | Done |
| 12 | [Docs, traceability, evidence và release validation](./phase-12-docs-traceability-and-release.md) | Done |

Lịch thi công (stage, effort, phụ thuộc):

| # | Stage | Effort | Depends |
|---|-------|--------|---------|
| 1 | A | 6h | — |
| 2 | A | 5h | 1 |
| 3 | A | 7h | 1, 2 |
| 4 | A | 3h | 3 |
| 5 | B | 7h | — |
| 6 | B | 4h | 5 |
| 7 | B | 6h | — |
| 8 | B | 5h | 5, 7 |
| 9 | C | 5h | — |
| 10 | C | 6h | — |
| 11 | C | 4h | 10 |
| 12 | — | 4h | 4, 6, 8, 11 |

```text
Stage A: [1] → [2] → [3] → [4] ─────────────────┐
Stage B: [5] → [6] ∥ [7] → [8] ─────────────────┼─→ [12] → release
Stage C: [9] ∥ [10] → [11] ─────────────────────┘
```

Phase 6 (T66) và Phase 7 (cửa sổ) chạm file khác nhau và có thể làm song song; Phase 8 cần cả hai.
Phase 9 và 10 tách file ownership, nhưng **migration chỉ một writer**: Phase 10 sở hữu bản 18.
Phase 12 là cổng cuối, không sửa giữa các stage ship.

## Quy ước chung cho mọi phase

- Mọi thay đổi UI/UX phải có bằng chứng PNG trong `plans/reports/evidence/` (thư mục do suite tạo,
  gitignored, không `git add -f`).
- Không `.spec.tsx`: vitest là `environment: "node"`. Assertion render đi vào Playwright.
- Test đỏ không được nới assertion; sửa nguyên nhân hoặc revert.
- Mọi từ chối phải trả **reason code** đọc được, không im lặng.
- **Không bao giờ** đưa đường dẫn đĩa vào prompt gửi model: chỉ `AttachmentRefV1` opaque.

## Success Criteria

- [x] `pnpm verify` xanh: invariant + typecheck + lint + unit test. — chạy trên cây đã merge `main`: **1344 passed | 7 skipped (1351)**.
- [ ] `pnpm test:e2e` xanh, có journey mới cho từng tính năng trong năm mục của issue. — **CHƯA ĐẠT**: bốn lỗi đã đo là đỏ sẵn ở commit gốc `7f3127f` (Stage A, chạy đối chứng trên worktree riêng), và **không** tính là xanh. `.github/workflows/ci.yml` **không** chạy `test:e2e`, nên CI xanh không nói gì về cổng này.
- [ ] `pnpm --filter @clarkcant/app-desktop run smoke` xanh, chạy trên máy có display, output JSON
      lưu lại làm evidence (đây là **cổng do người vận hành chạy**, không nằm trong `pnpm verify`).
- [ ] Nút `+` không còn `disabled`; chuỗi "Chưa hỗ trợ đính kèm" không còn trong mã.
- [ ] Test từ chối: tên file là path tuyệt đối, URL thực thi, mime thực thi, magic bytes lệch khai báo,
      quá ngưỡng, quá quota.
- [x] Prompt của lượt có attachment **không** chứa path đĩa, chỉ chứa `att_…`. — chứng minh ở ranh giới adapter: `FakePiAdapter.promptsFor()`.
- [x] Ảnh đính kèm render trong timeline **sau reload** (đọc từ history). — `apps/web/e2e/attachments.spec.ts`.
- [x] Voice chạy được cả nhóm lệnh điều khiển app; lệnh dạng lệnh mà không khớp intent thì nói chưa
      hiểu và **không hành động**; câu hỏi bình thường vẫn tới agent. — `apps/web/e2e/voice-control.spec.ts` (4 journey còn lại, tất cả xanh) và `packages/core/test/app-intents.spec.ts`.
- [x] Thoát app chỉ xảy ra sau một lần xác nhận lấy từ route confirm; token dùng lại bị từ chối. — `apps/runtime/test/app-intents.spec.ts` ("is not executable until the confirmation route returns it").
- [ ] T66 chuyển NOT-IMPLEMENTED → PASS kèm tên test chạm **widget action state**; test panel Settings
      có T-id riêng, không mượn T66.
- [x] Gợi ý rỗng thì fallback về chip tĩnh hiện có, và không gọi model để sinh gợi ý. — `apps/web/e2e/suggestions.spec.ts`, `apps/runtime/test/suggestions.spec.ts`.
- [x] Xoá một memory item thì item đó không còn trong brief của lượt sau (đọc lại từ store). — `apps/runtime/test/memory.spec.ts` ("a record that is deleted is gone from the next turn's brief"), `apps/web/e2e/memory.spec.ts`.
- [x] Không credential nào trong file tracked. — `pnpm run invariants` (`no-committed-secrets`, 366 file) và `secret scan` trên CI. Lưu ý: GitGuardian báo đỏ vì một fixture hình dạng-khoá trong commit cũ, đã gỡ ở HEAD.


## Tiêu chí chưa đạt (ghi rõ, không che)

Hai tiêu chí ở trên vẫn để trống có chủ đích, và đây là lý do:

- **`pnpm test:e2e` xanh**: bốn journey đỏ sẵn ở commit gốc `7f3127f` (đo bằng worktree đối chứng ở Stage A) cộng
  hai journey bị chặn bởi fixture thoại. Chúng **không** bị sửa để xanh, và không tính là xanh.
- **T66 → PASS**: journey chạm widget action state không chạy được vì fixture thoại đưa câu đã script cho sai phiên;
  cùng nguyên nhân làm journey "tab được gọi tên" của T73 đỏ. Cả hai đã ra khỏi suite kèm điều kiện còn thiếu, và
  ledger ghi T66 `NOT-IMPLEMENTED`, T73 `PARTIAL`.
- **Smoke desktop**: `pnpm --filter @clarkcant/app-desktop run smoke` là cổng do người vận hành chạy trên máy có
  display; CI không có display nên nó chưa từng chạy trong phiên này. Điều kiện còn thiếu: job `xvfb-run`.

## Gates còn mở (cần người xác nhận, không chặn code)

- **Kích thước thanh voice tối giản trên display thật.** Issue ghi "~20×50px" cho *icon*; Done-when
  ghi "bounds ≈20×50 khi compact". Plan lấy 20×50 làm **sàn** `setMinimumSize` và để thanh có kích
  thước đủ chứa hai icon (hằng số có tên ở Phase 7). Cần chốt con số cuối trên máy thật; trên Windows
  còn một sàn tracking size của OS mà chỉ display thật mới đo được.
- **Loại file và ngưỡng.** Lấy đề xuất của issue: ảnh, PDF, text/markdown, tối đa 25 MB mỗi file.
- **Lệnh voice nào được thoát app không cần xác nhận.** Lấy đề xuất của issue: luôn hỏi.
- **Phạm vi gợi ý.** Chốt: node local (khớp với phạm vi voice).
- **PDF và ảnh tới model.** Adapter chỉ nhận `text`, nên ảnh/PDF tới model dưới dạng **ref opaque**
  cộng tool `read_attachment` của node; node chưa có bộ trích PDF nên tool trả lời trung thực rằng
  chưa đọc được nội dung nhị phân. Kiểm chứng "model nhìn thấy ảnh" cần provider thật → ghi BLOCKED.
- **Xoá conversation.** Retention thật (xoá blob khi conversation bị xoá) cần một đường xoá
  conversation; repo chưa có, và 4 bảng tham chiếu không cascade. Plan giao
  `releaseConversationAttachments` (có test) và ghi việc thêm route xoá conversation là gap có tên.

## Red Team Review

Bốn lăng kính đối nghịch (Assumption Destroyer, Failure Mode Analyst, Scope & Complexity Critic,
Security Adversary) chạy trên ba reviewer độc lập + một checkpoint `kongming`; 14 phát hiện có
`file:line`, 12 được chấp nhận và đã sửa vào plan, 2 bị từ chối.

| # | Phát hiện | Mức | Quyết định | Sửa ở đâu |
|---|-----------|-----|------------|-----------|
| 1 | Cửa sổ Electron load `shell.html`, không load conversation client; không mã client nào chạm `window.clarkcant`; CSP chặn cả hai đường → Stage B có thể xanh mà người dùng không bao giờ tới được thanh voice | Critical | **Accept** | Phase 7 Task 7.1: quyết định cửa sổ shell load client qua `--renderer-url`, CSP theo origin, probe smoke trên document ứng dụng |
| 2 | Fixture model chạy **trước** lượt model và chỉ nhận `input.text`, nên không bao giờ thấy brief attachment; test của Phase 4 bất khả thi | Critical | **Accept** | Phase 4: chứng minh prompt ở seam `FakePiAdapter` (vitest); e2e chỉ chứng minh nửa người dùng thấy |
| 3 | Smoke Phase 5 so bounds do handler tự trả với hằng số của chính nó → tautology, xoá `setBounds` vẫn xanh | Critical | **Accept** | Phase 7: handler trả `window.getBounds()/getMinimumSize()/isAlwaysOnTop()` đọc **sau** khi gọi |
| 4 | Brief gửi model chứa **path tuyệt đối** của blob → vi phạm "no arbitrary paths", lộ layout host cho provider, và biến văn bản file thành vector injection | P0 | **Accept** | Phase 3: chỉ ref opaque trong prompt + tool `read_attachment(attachmentId)` resolve trong node kèm kiểm principal; test khẳng định prompt không chứa `dataDir` hay dấu phân cách path |
| 5 | Thoát app chỉ bị chặn ở route HTTP; frame voice đẩy token xuống client và hàm thực thi phía client không nhận input xác nhận | P0 | **Accept** | Phase 5: bỏ intent thực thi khỏi frame; quyết định xác nhận nằm ở node; token single-use bind `{principalId, kind, at}`; test replay |
| 6 | Đã có blob store `dataDir/blobs` (content-addressed, mode 0o600); plan dựng store thứ hai ghi vào thư mục cạnh identity token **không** set mode | P1 | **Accept** | Phase 1: trích xuất module blob dùng chung và tái sử dụng; xoá premise "chưa có blob store" khỏi plan |
| 7 | Loại file phục vụ lại là do client khai; không kiểm magic bytes, không `nosniff` | P1 | **Accept** | Phase 1 `sniffContentType` + Phase 2 header `x-content-type-options: nosniff` và `ATTACHMENT_TYPE_MISMATCH` |
| 8 | `GatewayResponse` không có field headers; transport tự viết header cố định → test 2 của Phase 2 không thể pass | P1 | **Accept** | Phase 2: thêm `headers?` vào `binary`, transport gộp và từ chối header host-owned |
| 9 | `inlineTextBytes` 256 KiB **mỗi file** × 8 file ≈ 2 MiB text trong một lượt | P1 | **Accept** | Phase 1/3: đổi sang **một ngân sách chung mỗi lượt** (32 KiB) và test 8 file vẫn dưới budget |
| 10 | T66 bị định nâng PASS bằng chứng minh trạng thái panel Settings, không phải widget action state | P1 | **Accept** | Phase 6 làm đúng T66 qua action binding của một widget; test panel có T-id riêng T73 ở Phase 5 |
| 11 | Registry "dùng chung cho chat/click/voice" thực chất thiếu `source` trong body và không nối chat | P2 | **Accept** | Phase 5: `source` bắt buộc trong body, nối đường chat đã gõ, test ba nguồn |
| 12 | Xoá conversation: 4 bảng tham chiếu không cascade, `foreign_keys = ON`, không có hàm nào | Major | **Accept (đổi hướng)** | Phase 2 bỏ `DELETE /conversations/:id`; giao `releaseConversationAttachments` + test; ghi gap ở Phase 12 |
| 13 | Trần body nằm trong `main.ts` (không export) nên không test nào chạm tới | Medium | **Accept** | Phase 2: tách `createNodeServer` sang `server.ts`, test boot server thật trên port 0 |
| 14 | Phase 6 (nay là 8) khẳng định thanh tối giản trong browser, nơi `compact` không tồn tại | High | **Accept** | Phase 8: hook test-only `?cc-compact=1` cho suite browser; bounds thật do smoke desktop |
| 15 | Phase 7 (nay là 5) tự mâu thuẫn: câu không khớp vừa "vẫn là lượt agent" vừa "không đổi gì" | High | **Accept** | Phase 5: tách "câu dạng lệnh app" (nói chưa hiểu, không hành động) khỏi "câu hỏi thường" (tới agent) |
| 16 | Token xác nhận không nằm trong contract nào; chat/click không xác nhận được | High | **Accept** | Phase 5: token có trong decision schema và route trả cho cả ba nguồn |
| 17 | Nhãn `nodeQuotaBytes` nhưng enforce theo principal | Minor | **Accept** | Phase 1: đổi tên `principalQuotaBytes`, ghi rõ phạm vi |
| 18 | Xoá memory chỉ xoá dòng summary; nội dung gốc vẫn tìm được qua `history_fts` | Advisory | **Reject (ghi nhận)** | Không xoá tin nhắn của người dùng. Phase 10 ghi rõ ranh giới: thứ bị xoá là *đường inject*; lịch sử hội thoại của chính người dùng vẫn nhìn thấy được, nên không phải hidden memory. Ghi vào docs ở Phase 12 |
| 19 | Brief memory 20 dòng × 2000 ký tự mỗi lượt bất kể liên quan | Advisory | **Accept** | Phase 10: trần 12 dòng và 4000 ký tự tổng, có test |
| 20 | Reorder: registry + T66 trước phần cửa sổ | Advisory | **Accept** | Thứ tự Stage B nay là 5 → 6 → 7 → 8 |

Đã kiểm lại các phát hiện bằng `grep`/`read` trước khi sửa; cả 12 phát hiện được chấp nhận đều có
`file:line` resolve được trong repo ở commit `7f3127f`.

## Validation log

### Verification Results (2026-09-19, Fact Checker pass, tier Full)

- Claims checked: 34 | Verified: 30 | Corrected: 4 | Unverified: 0
- Kết quả kiểm bằng `grep`/`read` trên source thật:
  - `packages/contracts/src/primitives.ts` có `prefixed("art")` → `attachmentIdSchema` dùng lại được.
  - `packages/storage/src/migrate.ts` 16 bản, bản cuối `credentials`, có `assertMigrationListIsSane`.
  - `apps/runtime/src/main.ts:571` gom body **không** có trần. **CORRECTED** ở Phase 2.
  - `ToolDefinition.execute(params)` chỉ nhận params → **CORRECTED** ở Phase 10 (đổi chữ ký `extraTools`).
  - `listConversations`/`getConversation`/`conversationMetadata` nằm ở `repositories.ts`, **không** ở
    `packages/core/src/routing.ts` → **CORRECTED** ở Phase 9.
  - `conditional_documents` có cột `etag/revision/body/draft` → **CORRECTED** ở Phase 5 (dùng `preferences`).
  - `docs/manifest.json` liệt kê `system-architecture.md` + `widgets-and-extensions.md`, **không** có
    `conformance-traceability.md` → Phase 12 chỉ phải cập nhật bytes/sha256 cho hai file kia.
  - `plans/reports/evidence/` chưa tồn tại; suite e2e tạo. `apps/desktop/src/` có `shell.html` + `shell.css`.
  - `packages/pi-adapter/src/types.ts:190` `prompt(sessionId, text)`. `preload.cjs` 6 method tên rõ.

### Red-team verification (2026-09-19)

- Reviewers: 2 độc lập (assumption/failure, scope/security) + 1 checkpoint kongming.
- Phát hiện: 20 | Chấp nhận: 17 | Từ chối kèm lý do: 1 (ghi nhận) | Trùng lặp đã gộp: 2.
- Kiểm lại bằng `git status`: reviewer không sửa file nào; mọi phát hiện đến từ đọc source.

- 2026-09-19 (v1): plan khởi tạo; chốt bốn quyết định với user.
- 2026-09-19 (v2): sau red-team — đảo Stage B, tách Phase 6 cho T66, bỏ `DELETE /conversations/:id`,
  chuyển sang blob store dùng chung, bỏ path khỏi prompt, đưa xác nhận thoát app về node, thêm seam
  `server.ts`, hook `?cc-compact=1`, ngân sách inline theo lượt.

### Ghi nhận khi thi hành (2026-09-19)

- **Deviation (Phase 1):** `attachmentQuotaDecision` **không** được viết. Luật quota, ngưỡng và
  allowlist đã nằm trong `validateAttachmentCandidate` và đã có test; viết thêm một hàm so sánh thứ
  hai là cách hai cái trần trở nên khác nhau. Runtime chỉ cấp **đầu vào** cho luật đó
  (`attachmentUsageForPrincipal`), và route gọi thẳng contract. Không có hành vi nào bị mất.
- **Deviation (Phase 1):** `sniffImage`/`ALLOWED_IMAGE_TYPES` được giữ ở `mini-app-data.ts` (nó mang
  thêm ngưỡng byte và chiều pixel của ảnh), nhưng phần đọc magic bytes chuyển sang `blobs.ts` thành
  `detectImageFormat` để ảnh và attachment dùng **một** implementation. `ALLOWED_IMAGE_TYPES` được
  import rồi re-export, không định nghĩa lại.
- **Deviation (Phase 2):** thêm seam `bodyLimitFor` trên `createNodeServer` để trần body test được
  bằng một con số nhỏ; giá trị deploy (`ATTACHMENT_UPLOAD_BODY_LIMIT`) được assert riêng.
- **Trạng thái thực thi:** Phase 1 và Phase 2 xong và có commit (`c42db4a`), `pnpm verify` xanh
  1061 test. Phase 3 xong hai nửa và có commit (`5a003bd` runtime, `e98f8f6` client), `pnpm verify` xanh
  1099 test. Phase 4 trở đi còn nguyên.

### Ghi nhận khi thi hành Phase 3 (2026-09-19)

- **Deviation (Task 3.3):** `extraTools` đổi từ `() => readonly ToolDefinition[]` thành
  `(turn: { conversationId: string }) => readonly ToolDefinition[]`. Tool `read_attachment` phải biết
  conversation của lượt để kiểm quyền, và lấy nó từ chỗ khác sẽ là nguồn sự thật thứ hai về việc lượt
  nào đang chạy. Chữ ký zero-argument cũ vẫn gán được vào kiểu mới nên không caller nào phải sửa.
- **Deviation (Task 3.3):** phần đọc refs từ tin nhắn đã lưu được đặt thành
  `attachmentRefsForLastUserMessage` trong `apps/runtime/src/attachments.ts` thay vì viết inline trong
  `main.ts`. `main.ts` không export gì và import nó sẽ boot một node, nên logic đó nằm inline thì không
  test được. Đây cũng là lý do test dùng đúng hàm của node thay vì bản sao.
- **Deviation (Task 3.4):** `read_attachment` chỉ được đăng ký khi lượt thuộc một conversation; lượt
  không thuộc conversation nào thì không có gì để kiểm, nên không mở tool đó ra.
- **Deviation (Task 3.6):** `useImageUrls` được rút về một hook chung `useObjectUrls`, và
  `useAttachmentUrls` là wrapper thứ hai. Ba luật về blob URL là về blob URL, không phải về ảnh; hai bản
  sao là hai cơ hội tái hiện lỗi `src` đã bị thu hồi.
- **Chưa làm, có tên (Refactor của Phase 3):** tách composer thành `composer.tsx`. Điều kiện của plan là
  `Conversation.tsx` vượt ~1500 dòng; hiện là 1594. Việc tách thuộc về một commit riêng với đúng các
  `data-*` attribute cũ, sau khi journey Phase 4 đã ghim các attribute đó.

<!-- slug: file-attachments-voice-bar-memory -->

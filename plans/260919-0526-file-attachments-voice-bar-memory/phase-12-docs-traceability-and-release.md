---
phase: 12
title: "Docs, traceability, evidence và release validation"
status: pending
priority: P1
effort: "4h"
dependencies: [4, 6, 8, 11]
---

# Phase 12: Docs, traceability, evidence và release validation

## Context Links

- Issue #17 §"Acceptance Criteria (chung)" và §"Plan & Phases"
- `docs/conformance-traceability.md` — bảng T-id/V-id, được `pnpm invariants` kiểm
- `docs/manifest.json` — chỉ hai file `system-architecture.md` và `widgets-and-extensions.md` nằm trong
  manifest; `conformance-traceability.md` **không** nằm trong manifest (đã kiểm)
- `docs/widgets-and-extensions.md` §4.1 — mục "Trạng thái triển khai (2026-09-17)"
- `AGENTS.md` — docs viết bằng tiếng Việt có dấu

## Goal

Docs khớp với những gì thật sự làm; traceability chỉ nâng trạng thái khi có test thật; evidence đủ;
các gap **có tên** được ghi lại thay vì bị bỏ quên; `pnpm verify:full` xanh trước khi ship.

## Gaps phải ghi thành tên (không được im lặng)

| Gap | Vì sao chưa làm | Điều kiện để làm |
|---|---|---|
| Chưa có route xoá conversation | 4 bảng tham chiếu `conversations` không cascade, `foreign_keys = ON`; xoá là thao tác phá huỷ cần phase riêng | `releaseConversationAttachments` đã có và đã test; cần chính sách cho task đang chạy |
| Node chưa trích được nội dung PDF/ảnh cho model | `PiAdapter.prompt(sessionId, text)` chỉ nhận text; không có bộ trích trong repo | Adapter nhận content part, hoặc thêm bộ trích; kiểm bằng provider thật |
| Smoke desktop không chạy trong CI | Cần display; CI hiện không có | Thêm job `xvfb-run` hoặc một display ảo khác |
| Token node tới renderer qua bridge | Client vốn cần bearer token trong trang (đường web hiện dùng `?token=`); bridge bỏ được argv và browser history nhưng chưa phải token phiên có scope | Phát token phiên ngắn hạn từ node |
| Model tự quyết định gọi `remember` chưa được kiểm | Fixture gọi đúng hàm, không phải model | Provider thật trong một lần chạy opt-in |

## Files to Create / Modify

- Modify: `docs/conformance-traceability.md` (T66 đã đổi ở Phase 6, T73 đã thêm ở Phase 5; phase này
  cập nhật V01/V16/V17 và phần "Scope items")
- Modify: `docs/widgets-and-extensions.md` §4.1 (attachment + memory + các gap ở bảng trên)
- Modify: `docs/system-architecture.md` §10 (blob store dùng chung, quota theo principal, ranh giới của memory)
- Modify: `docs/manifest.json` (**chỉ** hai file trên)
- Modify: `README.md` nếu nó mô tả composer/settings (kiểm trước khi sửa)
- Create: `plans/reports/verification-260919-issue-17-stage-a.md`
- Create: `plans/reports/verification-260919-issue-17-stage-b.md`
- Create: `plans/reports/verification-260919-issue-17-stage-c.md`

## Tests Before

Không có test mới ở phase này: đây là phase chứng từ. "Test" của phase là các lệnh trong `## Regression
gate` và các cổng dưới đây.

## Tasks & Steps

### Task 12.1 — Traceability đúng sự thật

- **Goal**: bảng T/V phản ánh test thật, không nâng trạng thái bằng "schema tồn tại".
- **Target files and symbols**: `docs/conformance-traceability.md`.
- **Steps**:
  1. Kiểm T66 (đã sửa ở Phase 6): Evidence phải nêu **đúng tên test** chạy được —
     `pnpm test:e2e -g "a spoken command and the same click reach one widget action state"` phải tìm
     thấy ≥ 1 test.
  2. Kiểm T73 (đã thêm ở Phase 5): tên test panel Settings tồn tại và chạy được.
  3. V01 "Conversation client": nêu composer đính kèm + journey mới; vẫn giữ `PARTIAL` cho tới khi
     desktop host và voice đều thật.
  4. V16 "Onboarding/personalisation": thêm gợi ý theo việc gần đây như phần đã có test.
  5. V17 "Live voice": thêm nhóm lệnh app-intent và widget action parity; giữ nguyên ghi chú WebRTC cần
     provider account.
  6. Nếu việc thêm T-id mới làm `pnpm invariants` đỏ (ví dụ danh sách T-id bị kiểm ở nơi khác), **bỏ**
     và ghi vào report thay vì nới luật.
- **Success criteria**: `pnpm run invariants` xanh; không dòng nào nâng trạng thái mà không có tên test.
- **Verify**: `pnpm run invariants` exits 0.

### Task 12.2 — Docs mô tả đúng, gồm cả giới hạn

- **Goal**: tài liệu không hứa quá phần đã làm, và hai ranh giới khó hiểu được viết ra.
- **Target files and symbols**: `docs/widgets-and-extensions.md` §4.1, `docs/system-architecture.md` §10,
  `docs/manifest.json`.
- **Steps**:
  1. §4.1 "Đã có, kèm test": attachment (ref opaque, blob dùng chung content-addressed mode 0o600, quota
     theo principal, magic bytes quyết định loại, `read_attachment` là tool của host).
  2. §4.1 "Chưa có": ghi đúng ba dòng đầu của bảng gap ở trên (PDF/ảnh extractor, xoá conversation,
     smoke trong CI) — nêu điều kiện còn thiếu.
  3. Memory: bảng `memory_records` **không** phải index tìm kiếm thứ hai; xoá một memory xoá **đường
     inject** vào lượt sau, còn tin nhắn gốc của người dùng vẫn nằm trong lịch sử hội thoại và vẫn nhìn
     thấy được — nên không phải hidden memory. Viết rõ câu này, vì đây là chỗ dễ bị đọc sai.
  4. Ghi rõ `?cc-compact=1` là đường **test-only** để suite browser chạm được thanh tối giản, không phải
     tính năng.
  5. Cập nhật `docs/manifest.json` cho **đúng hai** file đã sửa: lấy `bytes` và `sha256` mới
     (`sha256sum`/`shasum -a 256` + `wc -c`), sửa entry tương ứng.
- **Success criteria**: `pnpm run invariants` xanh.
- **Verify**: `pnpm run invariants` exits 0.

### Task 12.3 — Evidence

- **Goal**: mỗi thay đổi UI có ảnh, đúng quy ước repo.
- **Target files and symbols**: `plans/reports/evidence/*.png` (thư mục do suite tạo, gitignored).
- **Steps**:
  1. Bảng đối chiếu: `attachment-composer-dark.png`, `attachment-timeline-light.png`,
     `memory-empty-light.png`, `memory-populated-dark.png`, `voice-bar-dark.png`.
  2. Bounds của cửa sổ compact chứng minh bằng **output JSON của smoke**, không bằng ảnh, vì CI không có
     display; dán phần `checks` liên quan vào report Stage B.
  3. Chạy lại e2e để sinh ảnh; không `git add -f`.
- **Success criteria**: các file có mặt; mỗi ảnh được report tham chiếu đúng tên.
- **Verify**: `ls plans/reports/evidence/attachment-*.png plans/reports/evidence/memory-*.png plans/reports/evidence/voice-bar-*.png` không lỗi.

### Task 12.4 — Report từng stage với con số thật

- **Goal**: mỗi stage có report riêng, mọi con số khớp output thật của lệnh đã chạy.
- **Target files and symbols**: ba file trong `plans/reports/`.
- **Steps**:
  1. Với mỗi stage: chạy `pnpm verify` và `pnpm test:e2e` **tại thời điểm stage đó**, ghi đúng số test.
  2. Stage B: chạy thêm `pnpm --filter @clarkcant/app-desktop run smoke` và dán `failed: []` cùng bounds
     quan sát được; nói rõ đây là cổng do người vận hành chạy.
  3. Mỗi report có mục "Đã kiểm" và mục "Chưa kiểm được", lấy từ bảng gap ở trên, có điều kiện còn thiếu.
  4. Không chép số của stage khác; mỗi report là một lần chạy.
- **Success criteria**: ba report tồn tại; số trong đó khớp lệnh đã chạy.
- **Verify**: `ls plans/reports/verification-260919-issue-17-stage-*.md` liệt kê 3 file.

### Task 12.5 — Release validation

- **Goal**: một lần chạy sạch cho toàn bộ, sau khi mọi thay đổi đã dừng.
- **Target files and symbols**: `plans/reports/verification-260919-issue-17-release.md`.
- **Steps**:
  1. Chạy `pnpm verify:full` (invariant + typecheck + lint + unit + e2e) và ghi kết quả.
  2. Chạy `pnpm --filter @clarkcant/app-desktop run smoke` nếu máy có display; nếu không, ghi BLOCKED
     kèm điều kiện.
  3. Kiểm lại từng Success Criteria của `plan.md` và tick kèm con trỏ bằng chứng; tiêu chí nào không
     đạt thì để trống và ghi lý do, **không** tick cho đủ.
  4. Nếu bất kỳ lệnh nào đỏ: STOP theo Failure Protocol, không nộp report như thể đã xanh.
- **Success criteria**: report tồn tại; `pnpm verify:full` xanh.
- **Verify**: `pnpm verify:full` exits 0.

## Refactor

Không refactor ở phase này. Nếu phát hiện cần refactor, ghi vào report và để lại cho một phase riêng,
vì đây là cổng cuối trước khi ship.

## Tests After

Không thêm test mới. Nếu một acceptance criterion của issue không có test, ghi vào report là gap chứ
không tạo test hình thức.

## Regression gate

```bash
pnpm verify:full
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

- **Rủi ro**: sửa `docs/manifest.json` sai làm `pnpm invariants` đỏ. **Giảm thiểu**: chạy
  `pnpm run invariants` ngay sau mỗi lần sửa file trong manifest.
- **Rủi ro**: nâng trạng thái traceability cao hơn bằng chứng. **Giảm thiểu**: mỗi dòng phải nêu tên test
  chạy được; không chạy được thì để nguyên trạng thái cũ.
- **Rủi ro**: report chép số cũ sau khi có thay đổi. **Giảm thiểu**: chạy lệnh **sau** khi mọi thay đổi
  đã dừng, và mỗi stage có report riêng.

## Security Considerations

- Report không chứa token, key, hay nội dung file người dùng.
- Evidence PNG không được chứa token node; kiểm bằng cách mở ảnh trước khi tham chiếu trong report.

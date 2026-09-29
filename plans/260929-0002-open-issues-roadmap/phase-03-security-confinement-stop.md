---
phase: 3
title: "Bảo mật: #137 và Stop một turn đang chạy"
status: done
issues: [137]
new_issues: ["P0: dừng một turn đang chạy"]
---

# Phase 03 — Bảo mật: #137 và Stop một turn đang chạy

## Bối cảnh

- #137 mới được sửa một nửa: `apps/worker/src/tools.ts` đã confine. Còn lại:
  - `apps/runtime/src/pack-load.ts:118` truyền `projectRoots: []`;
  - `model-turn.ts:788,904` cũng truyền `[]`;
  - `packages/pi-adapter/src/real.ts:423-460` bật `READ_ONLY_TOOLS` theo `process.cwd()` khi root rỗng;
  - `task-dispatch.ts:332` giao `projects.roots()` của cả node cho task.
- Audit trong #188 báo P0 "không có Stop cho một turn đang chạy". Chưa có issue và chưa kiểm chứng trên `main`.

## Yêu cầu

- Root rỗng phải fail closed: không có built-in tool nào đọc `cwd` khi lane không có root. Mỗi lane
  (pack-load probe, hai call site trong model-turn, task-dispatch) phải có root được định nghĩa rõ, hoặc không có
  file tool nào.
- Task được điều phối chỉ nhận root của chính task. Chỉ chuẩn bị các giao diện mà #197 phase 1 cần để thay
  bằng resource theo task; không làm trước #197 phase 1.
- Có test hồi quy cho từng lane, chứng minh một đường dẫn ngoài root bị từ chối.
- Stop: trước hết tái hiện lỗi trên `main`. Nếu lỗi có thật, tạo issue mới và làm theo `DESIGN.md`: Stop luôn
  truy cập được bằng pointer, bàn phím và voice; hủy turn thật (abort signal tới Pi session); hiển thị trạng thái
  đã dừng và những gì được giữ lại. Nếu lỗi không có, ghi bằng chứng vào #188 hoặc vào report.

## File

`packages/pi-adapter/src/real.ts`, `apps/runtime/src/{pack-load,model-turn,task-dispatch}.ts` cùng test; cho Stop
là `apps/web` (composer và conversation) và runtime turn cancellation. Chỉ `packages/pi-adapter` được import Pi SDK.

## Kiểm chứng

Unit test cho từng lane. `pnpm verify`. Với Stop: Playwright E2E (bắt đầu turn dài → Stop → không còn token hay
tool call nào sau đó) và `pnpm verify:full`. `pnpm invariants`.

## Rủi ro và rollback

Fail-closed có thể làm hỏng một lane vốn cần đọc file. Test mọi lane, và báo rõ lỗi "không có root" thay vì
lặng lẽ không làm gì. Rollback: revert PR. Không nới lỏng confinement để test pass.

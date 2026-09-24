# Phase 5 — Hợp nhất, kiểm chứng, PR

1. Sau khi #175 merge: đặt lại nhánh `claude/sleepy-mccarthy-ys493l` từ `origin/main`, đưa các commit follow-up sang.
2. Hợp nhất nhánh của phase 2–4, giải xung đột ở `runtime-bootstrap.ts`, `notices.ts`, contract hộp thư.
3. `pnpm verify`, rồi `pnpm test:e2e` với env provider bị bỏ.
4. Cập nhật DESIGN §6.7 (mục "chưa ship"), `docs/system-architecture.md` §7.5.1, manifest.
5. PR nháp với body trong thư mục plan; không dùng từ khoá đóng issue cạnh số issue.

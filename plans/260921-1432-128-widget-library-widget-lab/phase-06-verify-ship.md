# Kiểm chứng, review, ship và merge

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

Đây là phase giao hàng: chạy toàn bộ gate của repo, hoàn tất E2E journey còn thiếu, cập nhật tài liệu, review, tạo PR, review/fix PR, gắn nhãn, merge và theo dõi CI. `pnpm verify` là định nghĩa done cho code không phải journey; `pnpm verify:full` là bắt buộc trước khi báo hoàn tất thay đổi UI/journey.

Sở hữu file phase này: `apps/web/e2e/widget-library.spec.ts` (mới), `docs/widget-development.md`, `docs/widgets-and-extensions.md`, `docs/manifest.json` (bytes + sha256), `DESIGN.md` (chỉ khi đổi invariant UX), các file plan (đánh dấu `status: completed` khi ship).

## Ma trận test (TDD)

Bổ sung `apps/web/e2e/widget-library.spec.ts` với các journey bắt buộc của issue:

1. **Mở từ Settings**: Settings → Extensions → `Browse` ⇒ catalog live hiện ra (`data-widget-library-mode="browse"`).
2. **Hội thoại vẫn mounted**: tạo state hội thoại quan sát được (gửi recipe scripted, không cần provider), mở library, đóng, xác nhận nội dung và pin còn nguyên.
3. **Renderer thật**: mở lần lượt `canvas.table@1`, `canvas.line@1`, `canvas.calendar@1`, `canvas.note@1`, `canvas.gallery@1` **ở detail view** và assert đúng `data-widget-role` của renderer production, đồng thời assert **không** có `data-widget-preview-missing`. Với `canvas.table@1` và `canvas.line@1` còn phải assert **không** có `data-widget-unavailable`, để chứng minh fixture đã bind dataset thật chứ không chỉ đi qua nhánh unavailable (finding #2).
3b. **Browse không gọi bên thứ ba** (finding #3): khi ở browse grid, assert không có request nào tới domain YouTube/media và không có `<iframe>`/`<video>` nào được mount; chỉ detail view mới mount.
4. **Developer controls**: đổi viewport, fixture, reduced-motion, theme cho `canvas.table@1` và `canvas.line@1`; assert thuộc tính thật đổi.
5. **Bàn phím**: chỉ dùng bàn phím để mở, điều hướng, chọn widget, vào inspector, đóng; assert focus trở về nút đã mở.
6. **App-intent parity**: typed command `"mở thư viện widget"` và click `Browse` cho cùng `data-widget-library-mode`; `"hiện widget lịch"` mở đúng `canvas.calendar@1`.

Trước khi chạy E2E phải giải phóng port 8876 và 4273 (server sót từ lần chạy trước làm health check của Playwright đạt nhầm và `--strictPort` fail).

## Thực hiện

1. Thêm E2E journey ở trên, dùng helper/pattern sẵn có của `apps/web/e2e/widget.spec.ts` (đọc token từ `.data/e2e/identity.json`, không hard-code credential).
2. `docs/widget-development.md`: thêm mục Widget Library/Widget Lab (entry points, catalog chuẩn, hợp đồng fixture, hội tụ với `clark widget dev`, khác biệt sandbox, giới hạn preview isolated), cập nhật mục "Trạng thái triển khai".
3. `docs/widgets-and-extensions.md`: cập nhật chỗ nói về family/fixture gate nếu câu chữ thay đổi theo catalog chuẩn.
4. `DESIGN.md`: chỉ thêm mục mô tả Widget Library như utility surface mở từ Settings/chat/voice, ghi rõ hội thoại vẫn mounted và focus được trả lại. Không mô tả hành vi chưa ship như đã ship.
5. `docs/manifest.json`: cập nhật `bytes` và `sha256` cho mọi file docs đã sửa; chạy `pnpm run invariants` để nó chỉ ra entry còn stale.
6. `pnpm verify`; sau đó `pnpm verify:full`.
7. `/ak:code-review --pending`; sửa hết Critical/Important; chạy lại kiểm chứng liên quan sau mỗi lần sửa.
8. `/ak:ship official` ⇒ PR vào `main`; ghi lại số PR.
9. `/ak:review-pr <pr> --fix --reply` cho tới khi finding xử lý xong và check terminal xanh.
10. Gắn `ready to ship stable` cho issue #128 và PR; gỡ `ready to cook` và `in progress`.
11. Merge theo convention/branch protection (ưu tiên `gh pr merge --auto` khi check còn pending); theo dõi CI của merge commit; nếu lỗi deterministic và sửa được trong repo thì tạo nhánh fix từ `main`, `/ak:fix --auto`, ship ở chế độ official, review, merge, theo dõi lại; dừng khi CI xanh, blocker ngoài được ghi nhận, hoặc cùng blocker lặp 3 lần.
12. Đóng plan index khi merge (`ak plan close`), ghi báo cáo vào `plans/reports/`.

## Kiểm chứng

- `pnpm verify` exit 0: invariants, typecheck, lint, Vitest toàn bộ.
- `pnpm verify:full` exit 0: gồm `pnpm test:e2e`.
- `pnpm run invariants` không còn entry manifest stale.
- E2E ở cả bề rộng hẹp (320 px) và desktop thường; đường bàn phím; đường reduced-motion.
- Kiểm tra thủ công theo "UI definition of done" của AGENTS.md: không control giả, không snapshot tự nhận là live, không echo secret, focus trở lại sau khi đóng.
- PR: review xong, check terminal xanh, nhãn đúng.
- Sau merge: CI của merge commit xanh (hoặc blocker ngoài được ghi rõ kèm bằng chứng).

## Rủi ro và rollback

- Thay đổi lớn một PR: nếu review phát hiện vấn đề kiến trúc, ưu tiên revert phần gây tranh cãi thay vì mở rộng scope; không thêm phase mới ngoài issue.
- E2E flake do port bị chiếm: luôn giải phóng 8876/4273 trước khi chạy và không dùng lại server của session khác.
- Không `git add -f` ảnh evidence (đã gitignore) và không tự ý rewrite lịch sử.
- Rollback: revert PR trên `main`; không có migration DB nên không cần rollback dữ liệu.

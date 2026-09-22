# Code review — giá trị của cờ không phải đối số vị trí (#141)

- **Ngày:** 2026-09-22
- **Branch:** `fix-cli-positional-argument`, 1 commit, dựa trên `origin/main` (`286b1d9`)
- **Issue:** digitopvn/clarkcant#141
- **Trạng thái:** sẵn sàng ship; không có finding Critical hoặc Important

## Phạm vi

`packages/widget-cli/src/cli.ts` suy ra thư mục làm việc bằng "đối số đầu tiên không bắt đầu bằng `--`". Cách đó bỏ
qua **cờ** nhưng không bỏ qua **giá trị của cờ**, nên:

```
clark widget dev --port 4000     → dir = "4000"
clark widget init --template form → dir = "form"
```

Người dùng gõ đúng cú pháp trong `usage()` và nhận lỗi về một thư mục họ chưa từng nhắc tới. Lỗi có từ trước; phát
hiện khi làm #133, nơi `--builtin` chỉ thoát được vì chế độ builtin không đọc `dir`.

## Thay đổi

Một commit, hai file:

- `FLAGS_WITH_VALUES` khai báo **một chỗ** những cờ có giá trị (`--template`, `--frames`, `--port`, `--builtin`).
  Lý do không phải cho gọn: **hai nơi phải đồng ý với nhau** — `flag()` đọc giá trị sau tên cờ, còn `positional()`
  phải bước qua đúng giá trị đó. Bug tồn tại chính vì chỉ một trong hai biết.
- `positional(args)` duyệt tuần tự: gặp cờ thì nhảy qua, gặp cờ có giá trị thì nhảy qua cả giá trị, gặp thứ khác
  thì trả về. Được export vì `WIDGET_COMMANDS` cũng đã được export cho test, một pattern có sẵn trong file này.

`positional` trả `undefined` khi không có đối số vị trí, và **ý nghĩa của `undefined` do caller quyết định** —
`dev` lấy thư mục hiện tại, còn lệnh cần thư mục thì từ chối. Giữ quyết định đó ở caller là có chủ ý: nhét
`process.cwd()` vào trong helper sẽ là một lựa chọn chính sách nằm trong hàm thuần tuý.

## Bằng chứng kiểm chứng

- `pnpm verify:full` exit **0**: invariants **9/9**, typecheck, eslint, **2248 unit passed / 7 skipped**
  (185 file), browser suite **127 passed / 1 skipped / 0 failed**.
- `packages/widget-cli/test/cli-usage.spec.ts`: **9 passed** (trước là 5), gồm 4 test mới:
  - mọi cờ có giá trị đều không bị đọc thành thư mục;
  - thư mục vẫn được đọc đúng khi đứng trước **hoặc** sau cờ;
  - cờ thiếu giá trị không ăn tên cờ kế tiếp;
  - **test đầu-cuối qua lệnh thật**: `init --template form` scaffold vào thư mục hiện tại và **không** tạo thư mục
    tên `form` (khẳng định là absent, để cách đọc cũ không quay lại mà không ai biết).
- **Xác nhận đúng tiêu chí của issue bằng CLI thật:**
  ```text
  clark widget dev --port 4399
  → Error: no widget facet is declared in /home/orca/orca/workspaces/clarkcant/feat-ui-add-widget-library-widget-lab-as-a-live
  ```
  Tức nó nêu **thư mục làm việc**, không phải `4399`.

## Finding còn lại (Minor, đã chấp nhận)

- **M1 — chỉ hỗ trợ dạng `--flag value`.** Dạng `--port=4000` không được `flag()` hỗ trợ hôm nay, nên `positional`
  cũng không cần xử lý; nếu sau này thêm dạng đó thì `FLAGS_WITH_VALUES` vẫn là chỗ duy nhất phải sửa để hai bên
  không lệch lại.
- **M2 — cờ lặp lại.** `flag()` dùng `indexOf` nên lấy lần xuất hiện **đầu**; `positional` bước qua giá trị của
  mọi lần xuất hiện. Với input dị dạng như `dev --port 1 --port 2 x`, hai bên vẫn nhất quán về đối số vị trí
  (`x`), chỉ giá trị cờ là lấy lần đầu — giữ nguyên hành vi cũ, không phải thứ PR này quyết định.

## Việc chưa làm

- Không sửa `usage()`: nó đã đúng, chính cách **đọc** mới là thứ sai.
- Không đổi `WIDGET_COMMANDS` thành nơi khai báo cờ. Đó sẽ là bước tiếp theo hợp lý (một bảng khai báo cờ thay vì
  một mảng tên), nhưng nó là refactor bề mặt CLI chứ không phải điều kiện để sửa bug này, và PR này giữ đúng
  phạm vi issue.

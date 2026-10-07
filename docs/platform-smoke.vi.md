# Smoke chỉ chạy được trên macOS

> [English](platform-smoke.md) (mặc định) · Tiếng Việt

Tài liệu này tồn tại vì ba thứ trong dự án **không kiểm được trên máy Windows đã dùng để phát triển**, và cách xử lý
đúng là nói ra chứ không phải im lặng bỏ qua. Không có mục nào ở đây được ghi là "đã pass".

**Điều kiện còn thiếu: một máy macOS có màn hình thật (và một người ngồi trước nó để trả lời hộp thoại của hệ
điều hành).** Không có runner macOS trong repo này.

## Ba thứ không kiểm được ở nơi khác

1. **TCC (quyền riêng tư của macOS).** Quyền ghi màn hình và micro do hệ điều hành sở hữu, và hộp thoại xin quyền
   chỉ xuất hiện trên macOS. Trên Windows, node báo `needs-permission` — đúng, nhưng đó là *cùng một trạng thái* được
   tạo bởi một hệ điều hành khác, nên nó không chứng minh được đường macOS.
2. **Window bounds trên macOS.** `electron . --smoke-test` đọc `getBounds()` và `getMinimumSize()` từ cửa sổ thật.
   Windows có tracking floor riêng của nó; macOS (NSWindow) có cái khác, nên con số 20×50 trong
   `COMPACT_MIN_SIZE` chỉ được xác nhận trên Windows cho tới khi có người chạy trên macOS.
3. **Wake-word detector local.** Bản ship hiện tại **không có** detector nào, và toggle trong Settings không dùng
   được kèm lý do (phase 8). Nếu một ngày có detector dùng AVFoundation/on-device thì nó cũng chỉ chạy được trên
   macOS, nên đây là chỗ phải kiểm lại — hiện tại không có gì để kiểm, và đó là lý do nó nằm trong danh sách này chứ
   không phải trong một test bị skip.

## Lệnh cho người vận hành macOS

```bash
# 1. Cài đặt
corepack enable
pnpm install

# 2. Smoke của desktop shell — mong đợi: exit 0 và JSON có "failed": []
pnpm --filter @clarkcant/app-desktop run smoke

# 3. Node chạy thật, để nhìn cửa sổ
node apps/runtime/src/main.ts --data-dir ./.data --label macos-smoke

# 4. Bộ e2e đầy đủ (cần port trống)
pnpm test:e2e

# 5. Toàn bộ cổng kiểm tra
pnpm verify:full
```

Hai chỗ cần bàn tay người, vì chúng là hộp thoại của hệ điều hành:

```bash
# 6. Phiên desktop: mở một phiên điều khiển màn hình, rồi bật quyền cho ClarkCant
#    System Settings → Privacy & Security → Screen Recording → ClarkCant → bật
#    Sau đó chạy lại (2) và xác nhận phiên chuyển từ "needs-permission" sang "available".
#    Card phải nói rõ quyền thuộc hệ điều hành, và node không tự cấp được.

# 7. Voice: bật micro cho ClarkCant
#    System Settings → Privacy & Security → Microphone → ClarkCant → bật
#    Rồi chạy: pnpm exec playwright test apps/web/e2e/voice.spec.ts
```

## Khi có kết quả

Ghi lại vào PR hoặc vào mục này: phiên bản macOS, phiên bản Electron, output JSON của smoke, và bounds mà
`getMinimumSize()` trả về. Nếu `COMPACT_MIN_SIZE` sai trên macOS thì đó là một finding, và sửa nó là việc của một
change riêng — không phải chỉnh con số cho vừa máy.

## Windows: một lần dừng bảo đảm được gì

Mục này không phải smoke thủ công. Nó chạy trên runner Windows của CI, và được ghi ở đây vì bảo đảm trên Windows khác
với macOS và Linux.

- **Trên macOS và Linux,** lệnh dừng gửi tín hiệu cho cả process group của lệnh. Group đó gồm cả tiến trình con mà
  shell khởi chạy sau lúc dừng.
- **Trên Windows,** lệnh dừng chạy `taskkill /T /F`, và lệnh này kết thúc cây tiến trình của lệnh như nó đang có lúc
  đó. Khi shell đã thoát, những tiến trình nó để lại vẫn còn chạy cũng được tìm ra và kết thúc. Chúng được tìm theo pid
  cha và theo thời điểm tạo nằm trong khoảng shell còn sống. Vì vậy khi một shim `.cmd` (các wrapper `gh` và `pnpm`)
  khởi chạy lệnh của nó ngay sau lần kill, lệnh đó vẫn bị dừng.
  - Khoảng sống đó tính từ lúc shell được ghi nhận là bắt đầu đến lúc nó được ghi nhận là thoát, không kéo tới lúc
    dừng. Vì vậy một tiến trình về sau dùng lại pid của shell, cùng mọi thứ nó khởi chạy, không bao giờ bị kết thúc.
    Khi lúc thoát không được ghi nhận thì không tìm gì cả.
  - `apps/runtime/test/process-tree.spec.ts` kiểm điều này trên Windows: "stopping a command a .cmd shim started, on
    Windows".
- **Điều Windows không bảo đảm.** Một tiến trình mà chính tiến trình cha của nó đã thoát trước lần tìm đó thì không
  còn mối liên kết sống nào về lệnh, và không được tìm thấy. Ví dụ là tiến trình cháu của một shim mà tiến trình con
  của shim đã thoát trước. Một Job Object sẽ tới được nó, nhưng Node không tạo được Job Object nếu không có native
  addon.

## Service container trên macOS và Windows: được phủ bằng smoke nền tảng thủ công

Service của một package chỉ chạy bên trong một Linux container (`apps/runtime/src/service-container.ts`). CI kiểm
ranh giới đó trong container thật trên Linux với ba engine: Docker rootful (job `verify`), Docker rootless
(`service container (rootless docker)`) và Podman rootless (`service container (rootless podman)`). Cùng bộ test đó
cũng chạy trên runner macOS và Windows của CI, nhưng ở đó nó không tìm thấy engine nào nên skip các test chạy container
thật. Vì vậy trên hai hệ điều hành này, các engine được **phủ bằng smoke nền tảng thủ công**, không phải bằng CI.

**Vì sao không chạy trong CI.** Docker Desktop và Podman machine đều chạy Linux container bên trong một máy ảo Linux.
Runner macOS do GitHub cung cấp chạy trên Apple silicon và không có ảo hóa lồng nhau, nên máy ảo đó không khởi động
được. Docker trên runner Windows do GitHub cung cấp chỉ chạy Windows container, còn WSL 2, thứ cả hai engine dùng trên
Windows, cần ảo hóa lồng nhau mà runner đó không có. Không dùng runner tự host cho việc này.

**Điều kiện còn thiếu: một máy macOS hoặc Windows đã cài Docker Desktop hoặc Podman machine.**

Chạy bộ test một lần cho mỗi engine. Mỗi lúc chỉ được có một engine trả lời. Node thử Docker trước Podman, nên hãy
thoát Docker Desktop trước khi chạy với Podman.

```bash
# Một lần: cài đặt
corepack enable
pnpm install

# Docker Desktop. Trên Windows, chuyển nó sang Linux containers trước.
docker version --format '{{.Server.Os}}'     # mong đợi: linux
pnpm exec vitest run --reporter=verbose apps/runtime/test/service-container-engine.spec.ts apps/runtime/test/service-container.spec.ts

# Podman machine, khi Docker Desktop đã thoát
podman machine init                          # một lần
podman machine start
podman info --format '{{.Host.Security.Rootless}}'   # mong đợi: true
docker version                               # mong đợi: lỗi, để node tìm thấy Podman
CC_EXPECT_ROOTLESS_PODMAN=1 pnpm exec vitest run --reporter=verbose apps/runtime/test/service-container-engine.spec.ts apps/runtime/test/service-container.spec.ts
```

Trên Windows PowerShell, đặt biến trước lệnh cuối bằng `$env:CC_EXPECT_ROOTLESS_PODMAN = "1"`, và xóa nó sau đó bằng
`Remove-Item Env:CC_EXPECT_ROOTLESS_PODMAN`.

Mong đợi: mọi test trong "a service container on a real engine", "a service's provider key on a real engine" và "the
media render package's service on a real engine" đều pass. Chỉ hai test giới hạn tài nguyên được phép bị skip, và chỉ
khi engine báo rằng nó không áp dụng giới hạn; hãy ghi lại test nào. Ở lần chạy với Podman,
`CC_EXPECT_ROOTLESS_PODMAN=1` sẽ khiến bộ test thất bại nếu Podman không báo rằng các giới hạn được áp dụng.

Trên hai hệ điều hành này, chính lần chạy đó là phép kiểm tra duy nhất cho những chỗ container có thể ghi: probe yêu
cầu `/run`, `/var/tmp` và `/dev` là chỉ-đọc, `/dev/shm` không tồn tại (Docker) hoặc chỉ-đọc (Podman), `/tmp` và thư mục
riêng là hai mount duy nhất ghi được, và không thứ gì ghi vào `/tmp` chạy được. Test media render đọc log driver mà
engine ghi cho service đang chạy và yêu cầu nó là `none`. Podman machine nhận các cờ này (`--log-driver none`,
`--read-only-tmpfs=false`) qua client từ xa, thứ mà CI không chạy tới.

Ghi lại vào PR hoặc vào mục này: hệ điều hành và phiên bản của nó, engine và phiên bản của engine, cùng output verbose
của bộ test. Một lỗi là một finding cho change riêng của nó. Đừng chỉnh test cho vừa máy.

## Cửa sổ trên Linux: X11, Wayland gốc và Hyprland

Các chế độ cửa sổ (normal, expanded, compact, orb), ghim, focus, thu nhỏ và toàn màn hình đều đi qua một bộ điều khiển
ngữ nghĩa trong desktop shell (`apps/desktop/src/window-controller.mjs`). Shell chọn backend theo phiên desktop
(`apps/desktop/src/window-session.mjs`) và báo lựa chọn đó trong `desktop:getStatus` qua `window.backend`,
`window.session` và `window.backendReason`. Mỗi câu trả lời về cửa sổ còn liệt kê những phần đã yêu cầu hệ thống cửa
sổ làm (`applied`) và những phần phiên này không làm được (`unsupported`), nên client không bao giờ hiển thị kích thước,
vị trí hay ghim chưa hề xảy ra.

Mỗi loại phiên Linux hiện được gì:

- **X11 và XWayland** (một phiên Wayland chạy với `--ozone-platform=x11`): cùng hình học Electron như macOS và
  Windows. Ứng dụng đặt kích thước, vị trí cửa sổ và giữ nó luôn ở trên. CI chạy smoke desktop dưới Xvfb, nên đây là
  đường Linux duy nhất có kiểm thử tự động. Dưới XWayland, compositor vẫn có thể ghi đè vị trí hoặc thứ tự xếp chồng;
  điều đó chưa được đo.
- **Wayland gốc**, mặc định của Electron từ bản 38 khi phiên là Wayland: compositor quyết định cửa sổ nằm ở đâu, và
  không có giao thức chuẩn nào cho ứng dụng giữ cửa sổ của mình trên các cửa sổ khác. Shell vẫn gửi đầy đủ vị trí và
  kích thước, nhưng chỉ kích thước có tác dụng. Mọi câu trả lời về chế độ đều ghi `position` là không hỗ trợ. Yêu cầu
  ghim bị từ chối kèm lý do đó và không bao giờ được gửi đi, và thanh điều khiển cửa sổ ẩn nút ghim. Một compositor xếp lát (tiling) cũng có thể bỏ qua kích thước của cửa sổ đang xếp lát; câu trả lời
  báo kích thước cửa sổ thực sự có.
- **Hyprland**: có một adapter (`apps/desktop/src/hyprland-window-controller.mjs`) ánh xạ các chế độ sang dispatcher
  của Hyprland qua socket yêu cầu của nó. Compact và orb cho cửa sổ nổi (floating) ở kích thước của chúng, orb còn ghim
  cửa sổ (hiện trên mọi workspace), và expanded phóng to tối đa. Ghim cho cửa sổ nổi rồi ghim. Thu nhỏ bị từ chối, vì
  Hyprland không có trạng thái thu nhỏ. **Adapter này chưa được kiểm chứng: nó có unit test với một socket giả, và chưa
  ai chạy nó trên một phiên Hyprland hay Omarchy thật.** Vì vậy nó tắt theo mặc định. Nó chỉ chạy khi được yêu cầu bằng
  `--window-backend hyprland` hoặc `CLARKCANT_WINDOW_BACKEND=hyprland`, và chỉ khi `HYPRLAND_INSTANCE_SIGNATURE` chỉ
  tới một Hyprland đang chạy. Lỗi IPC đầu tiên trả cửa sổ về cho hình học Electron (với các giới hạn Wayland gốc ở trên)
  trong suốt phần còn lại của phiên, và các câu trả lời sau đó mang `degradedFrom`.

**Điều kiện còn thiếu: một máy Linux chạy Hyprland (ví dụ Omarchy) có màn hình thật.** Để kiểm adapter ở đó:

```bash
corepack enable
pnpm install
# 1. Smoke của shell trên backend mặc định. Mong đợi: exit 0 và "failed": []; dưới Wayland gốc, mục kiểm tra ghim là
#    "a pin this desktop cannot honour is refused".
pnpm --filter @clarkcant/app-desktop run smoke
# 2. Một cửa sổ thật dưới backend Hyprland; stderr sẽ nói nếu nó bỏ Hyprland giữa chừng.
CLARKCANT_WINDOW_BACKEND=hyprland pnpm dev:desktop
# 3. Dùng các nút compact, ghim và toàn màn hình trên dải điều khiển cửa sổ. Với chế độ orb và expanded, mở công cụ
#    nhà phát triển (Ctrl+Shift+I) rồi chạy: await window.clarkcant.setWindowMode("orb"), sau đó "expanded" và "normal".
#    Sau mỗi bước, ở terminal thứ hai, đọc xem Hyprland báo gì về cửa sổ:
hyprctl clients -j | jq '.[] | select(.title == "clarkcant") | {floating, pinned, fullscreen, at, size}'
```

Ghi vào PR hoặc vào mục này: phiên bản Hyprland (`hyprctl version`), phiên bản Electron, JSON của smoke, và với mỗi chế
độ là mục tương ứng trong `hyprctl clients`. Một chỗ không khớp là một phát hiện cho thay đổi riêng của nó.

## Vì sao không có test bị skip

Một test `skip` trên máy này sẽ khiến bộ kiểm tra nói "xanh" trong khi thứ nó định kiểm chưa từng chạy. Thứ đúng
là: không có test nào tồn tại cho ba mục macOS trong phần "Ba thứ không kiểm được ở nơi khác", và tài liệu này nói rõ
điều kiện còn thiếu cùng cách chạy chúng ở nơi chạy được. Bộ test service container là ngoại lệ đã nêu ở trên: nó có
tồn tại, chạy trong CI ở mọi nơi có engine trả lời, và chỉ skip ở nơi không có engine nào, điều mà lần chạy thủ công
trong phần "Service container trên macOS và Windows" phủ.

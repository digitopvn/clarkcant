# Phát hành

> [English](releases.md) · Tiếng Việt

Cách ClarkCant đánh phiên bản, lập kế hoạch và mô tả một bản phát hành. Trang này nói về hợp đồng phát hành (#508,
bước 0), workflow lập kế hoạch và cổng chất lượng, và khả năng changelog. **Hiện chưa có gì được phát hành.** Đóng
gói, ký số, phát hành và bộ tự cập nhật là các bước sau, liệt kê ở mục [Chưa xây dựng](#chưa-xây-dựng).

Khi trang này tóm tắt, nguồn do máy sở hữu mới là chuẩn:

- quy tắc: [`tools/release/release-config.mjs`](../tools/release/release-config.mjs)
- lập kế hoạch: [`tools/release/plan.mjs`](../tools/release/plan.mjs)
- đóng dấu phiên bản: [`tools/release/clark-version.mjs`](../tools/release/clark-version.mjs)
- workflow: [`.github/workflows/release.yml`](../.github/workflows/release.yml)
- hợp đồng dữ liệu ghi chú phát hành: [`packages/contracts/src/release-notes.ts`](../packages/contracts/src/release-notes.ts)

## Một phiên bản Clark

Phiên bản trong `package.json` ở gốc là phiên bản Clark. Mọi ứng dụng trong `apps/` (runtime, desktop, web, CLI,
worker) mang cùng phiên bản đó. Bản ghi phát hành mà runtime nhúng kèm (`apps/runtime/release-notes.json`) cũng vậy.
Invariant `clark-version-single-source` (`pnpm invariants`) báo lỗi khi bất kỳ chỗ nào lệch nhau.

Thư viện trong `packages/` và pack trong `packs/` không nằm trong danh sách này. Chúng là mã nguồn workspace, được
resolve theo đường dẫn. Bộ công cụ widget có dòng phát hành riêng (`release-widget-tooling.yml`).

Bản build phát hành đóng dấu phiên bản đã lên kế hoạch vào từng tệp trên (`tools/release/stamp.mjs`). Dấu này không
bao giờ được commit ngược lại: tag mới là bản ghi của một phiên bản đã phát hành. Cây mã đã commit giữ phiên bản của
baseline gần nhất và kênh `source`.

## Phiên bản từ Conventional Commits

semantic-release quyết định phiên bản dựa trên các commit kể từ bản phát hành gần nhất trên nhánh. Không có chỗ nào
tính phiên bản bằng tay.

| Commit | Phát hành |
|---|---|
| Footer `BREAKING CHANGE:`, hoặc `!` sau type/scope | major |
| `feat` | minor |
| `fix`, `perf` | patch |
| `build`: thay đổi thứ được phát hành (bundler, Electron, đóng gói, phụ thuộc lúc chạy) | patch |
| `refactor`: mã được phát hành có thay đổi, nên Clark đã cài luôn chạy đúng những byte mà một phiên bản gọi tên | patch |
| `revert` một commit đã phát hành thuộc type có phát hành (`feat`, `fix`, `perf`, `build`, `refactor`, `revert`, hoặc mọi type có scope `dist`) | patch (revert một thay đổi breaking cũng là breaking và cần `!`) |
| `revert` một commit không phát hành (`docs`, `test`, `chore`, `ci`, `style`), hoặc có header không phải Conventional Commit | không gì cả |
| `revert` một commit trong cùng khoảng chưa phát hành | không gì cả: cặp commit triệt tiêu nhau |
| `docs`, `test`, `chore`, `ci`, `style` | không |
| mọi type có scope `dist`, ví dụ `chore(dist): …` | patch: cách đánh dấu một type vốn không phát hành là có ảnh hưởng tới bản phát hành; ghi chú liệt kê nó ở mục Distribution |

Khi một khoảng có nhiều commit phát hành, mức cao nhất thắng. Một khoảng không có commit phát hành nào thì không lên
kế hoạch gì, và workflow vẫn thành công mà không phát hành.

## Kênh

| Nhánh | Kênh | Phiên bản | Tag |
|---|---|---|---|
| `main` | stable | `1.4.0` | `v1.4.0` |
| `dev` | beta | `1.5.0-beta.1`, `1.5.0-beta.2`, … | `v1.5.0-beta.1` |

Bản beta không bao giờ tới kênh stable. Merge `dev` vào `main` sẽ phát hành phiên bản stable.

## Dữ liệu ghi chú phát hành

Mỗi bản phát hành có một bản ghi (`releaseNotesSchema`). Bản ghi gồm:

- phiên bản, kênh và ngày;
- phiên bản trước đó;
- khoảng commit (`from` không bao gồm, `to` có bao gồm);
- ghi chú markdown được sinh tự động;
- các mục, mỗi commit phát hành một mục, chia nhóm breaking, tính năng, sửa lỗi và khác;
- số mục bị lược bớt;
- tóm tắt artifact.

Tóm tắt artifact để trống cho tới khi có các bước build có ký số: một bản ghi không bao giờ liệt kê tệp chưa được phát
hành. Bản ghi có giới hạn: tối đa 100 mục mỗi bản phát hành, 40.000 ký tự ghi chú, và 20 bản phát hành mỗi bản build.

Mỗi bản build nhúng lịch sử mà nó thuộc về (`releaseHistorySchema`): phiên bản và kênh của chính nó, rồi các bản phát
hành, mới nhất trước. Lịch sử kết thúc ở **baseline**: `0.2.1`, lịch sử mã nguồn trước bản phát hành đầu tiên. Baseline
được ghi rõ là lịch sử, không bao giờ là một bản đã phát hành. Bản ghi đã commit được sinh từ lịch sử git thật bằng
`node tools/release/history.mjs --seed <commit>`.

## Changelog trong Clark

Runtime có một khả năng changelog duy nhất (`apps/runtime/src/application/changelog.ts`). Nó đọc bản ghi nhúng kèm, nên
dùng được khi không có mạng. Mọi cách hỏi đều tới nó:

- **Hội thoại:** “Clark có gì mới?”, “what changed since 1.4?”. Model gọi `show_changelog`, và host ghi lại
  `changelog-card`. Model có thể tóm tắt các mục bằng ngôn ngữ của người dùng. Model không thể bịa ra mục nào: thẻ do
  host sở hữu, và model đọc các mục như dữ liệu.
- **Lệnh gạch chéo:** `/changelog`, hoặc `/changelog 1.4` để xem những gì có sau 1.4.
- **Cài đặt:** Trải nghiệm → Phiên bản & có gì mới.
- **Giao diện mở:** `GET /changelog?since=1.4` ([giao diện mở](open-interfaces.vi.md)).

Màn hình này cho thấy phiên bản và kênh đang cài cùng ghi chú chuẩn. Nó không có nút Cập nhật, trạng thái cập nhật hay
bộ chọn kênh, vì chưa có dịch vụ cập nhật.

**Bản chạy từ mã nguồn.** Bản ghi nhúng được ghi khi một bản phát hành được lên kế hoạch, và phần đóng dấu không bao
giờ được commit ngược lại, nên bản ghi đã commit luôn dừng ở baseline. Thay vào đó, bản checkout tự cập nhật từ git của
chính nó: `node tools/release/history.mjs --source` dựng lại bản ghi của mọi bản phát hành đã công bố có tag
`v<version>` với tới được từ `HEAD`, bằng đúng bộ phân tích cú pháp, bộ phân tích commit và bộ sinh ghi chú mà bản build
phát hành dùng, rồi ghi vào `apps/runtime/release-notes.local.json` (bị git bỏ qua, nên `git pull` không bao giờ xung
đột với nó). Onboarding (`node tools/setup.mjs`) chạy lệnh này sau khi cài phụ thuộc, nên `git pull` rồi chạy onboarding
sẽ mang về ghi chú của các bản phát hành mà lần pull đã tải; khởi động lại node để đọc chúng.

- Runtime chỉ đọc bản ghi dựng lại trên kênh `source`, chỉ khi nó đúng hợp đồng, và chỉ khi nó nêu cùng phiên bản build
  với bản ghi đã commit. Nó thêm các bản phát hành; nó không bao giờ đổi phiên bản đang cài. Nó cũng chỉ được đọc khi bản
  checkout vẫn còn chứa bản phát hành mới nhất mà nó liệt kê (commit của bản phát hành đó là `HEAD` hoặc tổ tiên của
  `HEAD`, theo `git merge-base --is-ancestor`), nên bản checkout bị lùi về trước một bản phát hành mà không chạy lại
  onboarding sẽ hiển thị bản ghi đã commit. Mọi trường hợp khác dùng bản ghi đã commit.
- Bản ghi dựng lại bị git bỏ qua, nên `git status` không bao giờ hiện nó; onboarding dựng lại nó từ chính các tag của bản
  checkout, và xoá nó sẽ đưa Clark về bản ghi đã commit.
- Các commit sau tag mới nhất với tới được không phải một bản phát hành và không được liệt kê. Lịch sử theo kênh beta khi
  bản phát hành mới nhất với tới được là bản prerelease.
- Không có gì được dựng lại, và bản ghi đã commit được dùng, khi công cụ phát hành không cài được, cây thư mục không phải
  bản checkout git, không nạp được hợp đồng ghi chú phát hành, hoặc bản checkout là bản nông (`git clone --depth`) hay
  thiếu tag baseline. Lệnh nói rõ trường hợp nào và cách sửa (`git fetch --unshallow --tags`, `git fetch --tags`), và
  xoá bản ghi dựng lại trước đó. Các trình cài đặt clone với `--filter=blob:none`, giữ lịch sử và tag nhưng chỉ tải nội
  dung tệp cho cây đang checkout.
- Image Docker chỉ mang bản ghi dựng lại nếu nó được ghi trước khi dựng image: image không có lịch sử git, và onboarding
  Docker không cài công cụ phát hành trên máy chủ.

Với kênh `source`, thẻ, `/changelog` và model đều nêu commit và ngày mà ghi chú dừng lại (`notesCover` trong view: commit
cuối của bản phát hành mới nhất được liệt kê), và nói rằng bản checkout có thể có thay đổi mới hơn không được liệt kê.
Khi bản ghi mới nhất vẫn là baseline, liên kết có nhãn "Toàn bộ lịch sử thay đổi" và mở lịch sử commit tính đến commit
đó, vì chưa có bản phát hành nào.

## Workflow phát hành

`.github/workflows/release.yml` chạy khi push lên `main` và `dev`, và khi chạy tay. Nó không chạy trên pull request,
nên cổng merge (`.github/required-checks.json`) không đổi.

- **plan** checkout toàn bộ lịch sử cùng tag và chạy test của công cụ phát hành. Sau đó nó chạy semantic-release ở chế
  độ dry-run, chỉ nạp commit analyzer và notes generator. Nó ghi ra:
  - các output `release`, `version`, `tag`, `channel`, `prerelease`, `previous-version`, `range-from` và `range-to`;
  - phần tóm tắt của job;
  - artifact `release-plan` (`plan.json`, `notes.md`).
- **quality gate** chỉ chạy khi kế hoạch có phát hành. Nó đóng dấu phiên bản và lịch sử đã lên kế hoạch vào bản
  checkout của mình, rồi chạy `pnpm run verify`.

Không job nào có quyền ghi, environment hay secret, và không job nào tạo tag hay bản phát hành.

Công cụ phát hành là một dự án pnpm tách biệt trong `tools/release/`, với lockfile riêng được pin chính xác. Để chạy
ở máy local:

```sh
corepack pnpm --dir tools/release install --frozen-lockfile
corepack pnpm --dir tools/release test
node tools/release/plan.mjs --out release-plan   # cần tag baseline
```

## Trước bản phát hành đầu tiên

Maintainer làm những việc này một lần, sau khi hợp đồng phát hành được merge:

1. Gắn tag baseline lên commit mà bản ghi nhúng kèm được dựng tới:
   `git tag -a v0.2.1 806c39686b2b531a4671f519e7d8072041b2a494 -m "baseline: history before the first release"`,
   rồi `git push origin v0.2.1`. Thiếu tag này, job plan báo lỗi kèm hướng dẫn đó thay vì lên kế hoạch `1.0.0`.
2. Tạo `dev` từ `main` và gắn ruleset giống `main`: chỉ qua pull request, cấm force push, cấm xoá.
3. Cấu hình các environment ký số khi đã có thông tin xác thực ([ký phát hành](release-signing.vi.md)).

## Chưa xây dựng

| Bước | Nội dung | Bị chặn bởi |
|---|---|---|
| 1 | Spike đóng gói: Windows MSIX hay Squirrel, bundle macOS, Linux/Omarchy | Quyết định: [ADR-004](research/adr-004-desktop-packaging.vi.md) (đề xuất), #193 cho Omarchy |
| 2 | Ma trận build, ký số, xác minh và phát hành; checksum; GitHub Release; feed của kênh | Bước 1; thông tin xác thực để ký ([ký phát hành](release-signing.vi.md)) |
| 3 | UpdateService và staging | Bước 1 |
| 4 | Supervisor, bộ lập kế hoạch kích hoạt, khởi chạy sạch lần sau | Bước 3 |
| 5 | Migration, kiểm tra sức khoẻ, rollback | Bước 4 |
| 6 | Tính liên tục Durable qua lần kích hoạt | #402 |
| 7 | Trạng thái cập nhật, nút Cập nhật, bộ chọn kênh trong màn hình changelog và Cài đặt | Bước 3 |
| 8 | Smoke trên nền tảng đã cài có ký số và chèn lỗi | Bước 2–5; môi trường Windows/macOS/Omarchy thật |

# Hội tụ dev-host và provenance installed/local

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Ngữ cảnh và sở hữu

`packages/widget-cli/src/dev-shell.ts` giữ `DEV_VIEWPORTS`, `VIEWPORT_WIDTHS`, `DevTheme` và reducer preview; `dev-host.ts` phục vụ shell đó với sandbox opaque-origin. `packages/conversation-client/src/api.ts` đã có `InstalledPackageView` và `client.packages()`; `packages/contracts/src/install.ts` giữ metadata cài đặt. Settings hiện đã có `InstalledPackagesSection` trong `ExtensionsSettings.tsx`.

Sở hữu file phase này: `packages/widget-cli/src/dev-shell.ts`, `packages/widget-cli/src/dev-host.ts`, `packages/widget-cli/src/cli.ts`, `packages/widget-catalog/src/provenance.ts` (mới), `packages/conversation-client/src/widget-library/WidgetProvenance.tsx` (mới), `packages/conversation-client/src/api.ts` (chỉ đọc), test `packages/widget-cli/test/dev-host.spec.ts`.

## Quyết định thiết kế

- **Một** từ vựng preview: `@clarkcant/widget-catalog/preview` là nguồn duy nhất cho danh sách viewport, bề rộng, theme và chuyển trạng thái. `dev-shell.ts` re-export lại đúng các tên cũ (`DEV_VIEWPORTS`, `VIEWPORT_WIDTHS`) để test và consumer hiện có không đổi, nhưng thân hàm chỉ còn là lời gọi vào module chung. Không có hai bản logic.
- Fixture dùng chung: `clark widget dev` nhận fixture của definition built-in từ `@clarkcant/widget-catalog` (`clark widget dev --builtin canvas.table@1 --fixture empty`), nên author thấy cùng bộ fixture như trong Lab. Khác biệt do runtime/sandbox (opaque origin, không có bearer token, không có gateway) được nêu rõ trong output của dev host chứ không giấu.
- Provenance: `source` nằm trên entry. Built-in đến từ registry; installed merge từ `client.packages()`; `local` chỉ khi metadata khẳng định là local development package. Nhãn hiển thị tách bạch: "Built-in", "Installed package", "Local development package".
- Với entry `renderer !== "catalog"` (isolated-app / mcp-app): developer mode hiển thị provenance đầy đủ và trạng thái trung thực "preview cần isolated host" kèm tên lý do; **không** dựng preview giả và **không** hiển thị chúng trong browse mode như thể render được. Remote directory browsing chỉ để lại chỗ nối trong API, không implement.

## Ma trận test (TDD)

1. `packages/widget-catalog/test/preview.spec.ts` (mở rộng phase 1): danh sách viewport/bề rộng/theme là nguồn duy nhất; reducer như phase 1.
2. `packages/widget-cli/test/dev-host.spec.ts` (mở rộng): chạy dev host với fixture built-in; `state().fixture` nhận đúng id fixture từ catalog; viewport/theme/reduced-motion hành xử **giống hệt** reducer chung (test so sánh trực tiếp hai kết quả); sandbox vẫn là opaque origin (`allow-same-origin` vắng mặt) - bảo vệ bất biến bảo mật.
3. `packages/widget-catalog/test/provenance.spec.ts`: entry built-in có `source: "builtin"`; hàm merge installed tạo entry `source: "installed"` với `packageVersion`/`sourceRef`/`digest`/`trustLane` khi có; thiếu metadata thì vẫn tạo entry nhưng đánh dấu `metadataIncomplete: true`; entry isolated không bị đưa vào tập renderable của browse mode; **không** field nào chứa secret (assert không có khoá `token`/`secret`/`authorization`).
4. `packages/conversation-client/test/widget-library.spec.ts` (mở rộng): browse chỉ hiện entry renderable; developer hiện entry isolated với nhãn trung thực và không renderer giả.

## Thực hiện

1. `packages/widget-catalog/src/provenance.ts`: `mergeInstalledEntries(builtin, installed)` + kiểu `ProvenanceInfo`; dùng `InstalledPackageView` dạng cấu trúc tối thiểu (chỉ khai báo field cần, không import client).
2. `packages/widget-cli/src/dev-shell.ts`: xoá định nghĩa cục bộ, import từ `@clarkcant/widget-catalog/preview`, giữ re-export.
3. `packages/widget-cli/src/cli.ts`: cờ `--builtin <definitionId>` và `--fixture <id>` lấy fixture từ catalog; thông báo rõ khác biệt sandbox/gateway.
4. `packages/widget-catalog/package.json`: thêm dependency cho widget-cli; cập nhật `packages/widget-cli/package.json`.
5. `WidgetProvenance.tsx`: hiển thị nguồn gốc, version, digest (rút gọn), trust lane; với native Pi extension dùng **cách gọi tên khác** với isolated widget theo AGENTS.md (extension chạy cạnh host ở mức tiến trình vs widget opaque-origin).
6. Cập nhật `WidgetGallery.tsx`/`WidgetDetail.tsx` để hiển thị provenance và lọc `Installed`/`Local` trong dải family.

## Kiểm chứng

- `pnpm exec vitest run packages/widget-catalog/test packages/widget-cli/test packages/conversation-client/test` exit 0.
- `pnpm run invariants` exit 0 (không phá ràng buộc exact-pinned và package metadata).
- Kiểm tra thủ công: `node packages/widget-cli/src/cli.ts dev --builtin canvas.table@1 --fixture empty` chạy và báo đúng khác biệt so với Lab.
- Không có token/gateway URL/conversation id nào bị truyền vào preview hoặc dev host.

## Rủi ro và rollback

- Hợp nhất hai bản reducer có thể làm lệch hành vi cũ của dev host; test so sánh trực tiếp hai đường là điều kiện chấp nhận.
- `client.packages()` là async và có thể lỗi: browse mode phải vẫn hoạt động chỉ với built-in, installed là phần bổ sung có trạng thái lỗi riêng.
- Không được để provenance vô tình render secret; digest chỉ hiển thị rút gọn và không dùng làm credential.
- Rollback: revert về reducer cục bộ trong `dev-shell.ts` và bỏ merge installed entries; browse với built-in không phụ thuộc phase này.

### Ghi chú triển khai: hội tụ đến đâu và khác ở đâu

**Đã hội tụ (một nguồn duy nhất):**

- Từ vựng theme: `dev-shell.ts` re-export `PREVIEW_THEMES` từ `@clarkcant/widget-catalog/preview` thay vì giữ bảng riêng.
- Ba luật chuyển trạng thái `fixture` / `theme` / `reduced-motion`: dev shell uỷ quyền cho `applyPreviewAction`, nên luật "giá trị không hợp lệ thì giữ nguyên" chỉ có một chỗ cài đặt.
- Test `packages/widget-cli/test/dev-shell-convergence.spec.ts` so sánh trực tiếp hai cài đặt, nên lệch nhau sẽ fail ở đây chứ không phải chờ ai đó mở hai cửa sổ rồi so mắt.

**Khác có chủ ý (đã ghi lại, không giấu):**

- **Từ vựng viewport.** Dev host dùng `narrow-320 | conversation | compact | expanded` với bề rộng 320/480/720/1024 để xem một package độc lập, gồm cả bề rộng desktop; Widget Lab dùng bề rộng hội thoại. Test cuối trong `dev-shell-convergence.spec.ts` ghim sự khác biệt này.
- **Hai loại fixture khác nhau về bản chất, không phải hai bản sao.** `widgetFixtureSchema` trong `@clarkcant/contracts` mô tả một fixture của catalog (`{id, label, props, state?, dataset?, mode?}`), còn `fixtures/*.json` của một package là **props trần**; `readPackage` đọc chúng và `conformance.ts` kiểm chúng bằng props schema của chính widget. Gộp hai thứ này lại sẽ là ép hai artifact khác nhau vào một schema, nên không làm.
- **`clark widget dev --builtin <id>` không được thêm** (R8): dev host phục vụ facet entry của một package, không phải catalog renderer. Điều này có nghĩa "dev host và Lab hành xử giống nhau với cùng widget + fixture" chỉ đúng ở tầng *ngữ nghĩa preview* (theme, fixture, reduced motion), không phải ở tầng *nguồn widget*.

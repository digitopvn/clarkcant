---
phase: A
title: "Manifest chuẩn v2 cùng tương thích v1"
status: in-progress
issues: [198, 220]
---

# Phase A — manifest chuẩn v2 cùng tương thích v1

## Bối cảnh

Trước phase này có hai manifest không khớp nhau:

- `packages/core/src/widget-package.ts` `manifestSchema` (v1, chỉ có facet `widget`) là manifest mà `clark widget` sinh
  ra và `readPackage` đọc.
- `packages/contracts/src/install.ts` `packageManifestSchema` là "contract", nhưng chỉ test và
  `capability-host.validateManifest` dùng. Không có `schemaVersion`, facet không có `id`, và không mô tả được service.

`docs/widgets-and-extensions.md` §11 thì cho facet ở dạng object, và `hostApi` là một range dạng chuỗi.

## Quyết định

- `packageManifestSchema` trong contracts là manifest chuẩn duy nhất, với `schemaVersion: 2`.
- Facet là discriminated union theo `kind`, và mỗi kind gắn với đúng một lane:
  - `ui` ↔ `isolated-ui`;
  - `tools` ↔ `service`, kèm `protocol: "mcp-stdio"` và danh sách `capabilities` khai báo trước;
  - `skills`, `prompts`, `themes`, `setup` ↔ `declarative`;
  - `driver`, `voice` ↔ `service` hoặc `trusted-native`.
- `manifestProblems` kiểm các quy tắc liên trường:
  - trùng id;
  - `entry` hoặc `definition` nằm ngoài package, hoặc là URL;
  - capability không nằm dưới package id;
  - trùng tool hoặc trùng capability.
- V1 chỉ được chuẩn hoá khi đọc (`upgradeWidgetManifestV1`) và không bao giờ bị ghi lại, vì consent gắn với digest.
  Sau khi chuẩn hoá, manifest v1 phải qua đúng các kiểm tra của v2. Giá trị không hợp lệ thì báo lỗi, không sửa.
- Khi cài, risk tier được tính thêm từ facet của manifest đã verify digest, nên chỉ có thể nâng lên, không hạ xuống.
- `clark widget init` sinh manifest v2 và id dạng slug, để service facet thêm vào sau vẫn đặt tên capability được.
- `clark widget publish` lấy facet và lane của directory entry trực tiếp từ manifest, và bắt buộc phải có `publisher`.

## File

- `packages/contracts/src/install.ts`
- `packages/core/src/widget-package.ts`
- `packages/capability-host/src/index.ts`
- `packages/widget-cli/src/cli.ts`
- `apps/runtime/src/application/package-install.ts`
- Test:
  - `packages/core/test/package-manifest.spec.ts` (mới)
  - `packages/core/test/widget-document.spec.ts`
  - `packages/widget-cli/test/conformance.spec.ts`
- Docs: `docs/widget-development{,.vi}.md` §4 và `docs/widgets-and-extensions{,.vi}.md` §11

## Kiểm chứng

- Unit test cho:
  - lane theo kind;
  - `manifestProblems`, gồm path escape viết theo nhiều cách và capability giả danh;
  - đọc v1 → v2;
  - v1 không hợp lệ bị báo lỗi;
  - v1 có definition nằm ngoài package bị từ chối;
  - `schemaVersion` lạ bị từ chối.
- Test widget-cli:
  - init sinh v2 hợp lệ;
  - publish một package có facet `tools` thì liệt kê `ui` và `tools`, với risk tier `service`.
- Mọi fixture v1 và mọi test runtime hiện có vẫn xanh.
- Ví dụ manifest trong docs parse được bằng `packageManifestSchema` và không có problem.
- `pnpm verify`.

## Rủi ro

- Package v1 đã cài mà có giá trị lỏng (version không theo semver, platform lạ, capability ref sai) giờ bị báo là
  unreadable. Repo không có package nào như vậy, và báo lỗi rõ ràng tốt hơn sửa ngầm.

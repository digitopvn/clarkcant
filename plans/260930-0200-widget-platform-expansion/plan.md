---
title: "#200 và phần còn lại của #198: tách widget platform thành sub-issue có thứ tự"
status: in-progress
created: 2026-09-30
issues: [200, 198, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 327, 328, 329, 332, 333, 334, 335]
related: [195, 226, 280, 281, 282, 283]
---

# Mở rộng widget platform (#200) và phần widget còn lại của #198

Nguồn: epic [#200](https://github.com/digitopvn/clarkcant/issues/200) (mục "Status and split (2026-09-30)" vừa thêm
vào cuối body), issue [#198](https://github.com/digitopvn/clarkcant/issues/198) mục P1 còn thiếu và P2, và phase 10 của
[lộ trình](../260929-0002-open-issues-roadmap/phase-10-widget-platform-expansion.md).

## Kết quả cần đạt

- Mỗi milestone còn lại của #200 (M1, M2, M4, M7) và mỗi mini app tham chiếu là một sub-issue, một PR.
- Phần trước đây "chưa tách" nay có chủ: template `connected-app` và DoD mục 6 là #332 (fake connector, chờ #316),
  chạy thật với tài khoản SaaS là #333 (gate ngoài); mô phỏng dev-host là #334 (service readiness, offline/degraded)
  và #335 (semantic inspector, composition events).
- M3, M5, M6 đã xong qua #220/#221, #224–#226, #195; bằng chứng ghi trong body #200. Phần M3 chưa làm (credential,
  egress) chuyển sang #316; template `clark widget init` chuyển sang các mini app.
- #198 P1 còn thiếu (timeline, tree, kanban, semantic state media) và P2 (map, diagram, media) có sub-issue riêng; chỉ
  phần thật sự cần dịch vụ ngoài mới bị gate.
- Semantic state media là issue riêng #329, không gộp vào #324: đây là mục P1 trên widget sẵn có, không bị chặn,
  còn #324 chờ #313. #324 dùng lại helper trạng thái phát của #329.
- Phần chạy thật với provider ngoài tách thành issue `blocked,external-gate` (#321, #323, #333); phần trong repo dùng fake
  provider hoặc fake tile server.

## Không làm

- Không viết code, không mở PR trong plan này.

## Ràng buộc chung (AGENTS.md)

- Widget không tin cậy không nhận secret thô, IPC Electron chung, cookie host hay quyền chạy tool tuỳ ý.
- Một đường capability chuẩn (`invokeCapability`) cho widget, agent, voice, MCP, CLI; Jev/policy quyết định leo thang.
- Service giữ `--network none`; egress và credential đi qua broker của host (#316).
- Map không tải tile từ host tuỳ ý; diagram không chạy script, không HTML Mermaid thô; media là ArtifactRef hoặc URL
  do node tải theo content policy. CSP của trang giữ nguyên.
- pnpm, dependency pin cứng; migration đã áp dụng là bất biến; docs EN/VI và docs chính thức ở `clarkcant-web`.

## Phase

| Phase | Trạng thái | Phụ thuộc | Chi tiết |
| --- | --- | --- | --- |
| 01 Primitive nền tảng và mini app (#200) | chờ | — | [phase-01-widget-platform-primitives-and-apps.md](phase-01-widget-platform-primitives-and-apps.md) |
| 02 Widget còn lại của #198: P1 timeline, tree, kanban, media semantic; P2 map, diagram, media | chờ | #282, #283 merge; #324 cần #313 và #329 | [phase-02-198-remaining-widgets.md](phase-02-198-remaining-widgets.md) |

Hai phase chạy song song được, trừ các điểm chung trong mục "Ghi chú xung đột file".

## Trạng thái

- #334 đã đóng qua PR #375; #335 đã đóng qua PR #376. Tài liệu chính thức EN/VI được cập nhật và deploy qua web PR #65.
- #315 là bước kế tiếp trước #316 vì #316 phụ thuộc JobRef và concurrency/background execution của #315.

## Thứ tự đề xuất

| Bước | Issue | Phụ thuộc | Song song an toàn với | Vùng dễ chạm |
| --- | --- | --- | --- | --- |
| 1 | #313 M1 ArtifactRef broker | — | #314 | `apps/runtime/src/{blobs,attachments,artifact-transfer}.ts`, route artifact mới, `packages/contracts` (artifact ref), `packages/storage` (migration mới), `packages/widget-sdk`, `packages/widget-host/src/session.ts`, `apps/desktop/src/main.mjs` (picker, Save As), `renderers.tsx` (thẻ file cho `canvas.file@1`) |
| 1 | #314 M2 executor invoke/agent/workflow | — | #313 | `apps/runtime/src/application/{action-bindings,widget-actions,capability-invoke}.ts`, `packages/contracts/src/widgets.ts` |
| 2 | #315 M4 JobRef | #313; cần #314 | #317, #318 | `apps/runtime/src/{work-supervisor,work-journal,work-recovery}.ts`, `packages/contracts/src/tasks.ts`, `widget-sdk`, `widget-host`, MCP progress/cancel, migration mới |
| 2 | #317 App A: text editor | #313, #314 | #318, #315, #316 | `examples/` (package mới), `packages/widget-cli` (template `pure-ui`), E2E trong `apps/web/e2e` |
| 2 | #318 App B: spreadsheet | #313, #314 | #317, #315, #316 | `examples/` (package mới), E2E trong `apps/web/e2e` |
| 3 | #316 M7 resource profile, token broker | #315; cần #314 | #317, #318 | `apps/runtime/src/{secret-broker,service-host,service-container}.ts`, `application/credential-vault.ts`, `packages/integration-sdk`, `widget-sdk`, `widget-host`, migration mới |
| 4 | #319 App C: AI image (fake provider) | #313, #314, #315, #316 | #320 | `examples/` (package + service fixture), `widget-cli` (template `ai-generator`, `ui-with-service`) |
| 4 | #320 App D: media render | #313, #315, #316; cần #314 | #319 | `examples/` (package + service fixture), `widget-cli` (template `media-tool`) |
| 4 | #332 Connected app: template `connected-app`, fake connector, app tham chiếu | #316; cần #314 | #319, #320 | `packages/widget-cli/src/cli.ts` (template), `examples/` (package mới), fake OAuth + fake SaaS trong `apps/web/e2e/fixtures`, `packages/integration-sdk`, `application/credential-vault.ts`, broker của #316, schema yêu cầu connection trong `packages/contracts` |
| 5 | #321 Chạy image thật (`external-gate`) | #319, #316 | #333 | Không có code mới dự kiến; bằng chứng chạy thật |
| 5 | #333 Connected app với tài khoản SaaS thật (`external-gate`) | #332, #316 | #321 | Không có code mới dự kiến; cấu hình OAuth client trên node, bằng chứng chạy thật (liên quan #2) |
| bất kỳ | #334 Dev host: service readiness, offline/degraded | — | #313, #314 (rebase nhẹ) | `packages/widget-cli/src/{dev-host,dev-shell,conformance}.ts`, bridge của `packages/widget-host`, contract readiness dùng chung |
| bất kỳ | #335 Dev host: semantic inspector, composition events | — | #313, #314 (rebase nhẹ) | `packages/widget-cli/src/{dev-host,dev-shell,conformance}.ts`, dùng `packages/contracts/src/{widget-semantic,composition-graph}.ts` |

Nhánh #198 (P1 trước P2). Mọi issue bắt đầu sau khi #282 và #283 merge, vì cùng anchor trong `renderers.tsx`,
`registry.ts`, `fixtures.ts`, `view-catalog.ts`; trong nhánh này đi tuần tự hoặc rebase nhỏ:

| Bước | Issue | Phụ thuộc | Song song an toàn với | Vùng dễ chạm |
| --- | --- | --- | --- | --- |
| A | #326 O timeline hoạt động | #282, #283 merge | nhánh #200 (trừ #313 ở `renderers.tsx`) | contract timeline mới trong `packages/contracts`, `widget-catalog/src/{registry,fixtures}.ts`, `apps/runtime/src/{view-catalog,compose-layout,widget-semantic}.ts`, `composition-graph.ts` (sự kiện `timeline.select`), `renderers.tsx` |
| B | #327 P tree/hierarchy | #326 (tuần tự, cùng anchor) | như A | cùng các file catalog như A, sự kiện `tree.select`/`tree.toggle` |
| C | #328 Q kanban board | #327 (tuần tự); dùng binding `invoke` sẵn có, dùng limit/cancel của #314 nếu đã có | như A | cùng các file catalog như A, sự kiện `board.move`, đường `invokeCapability` cho thay đổi ngoài widget |
| D | #329 R semantic state media | #328 (tuần tự) | như A | phần media của `renderers.tsx` (`LocalImage`, `Gallery`, `Carousel`, `LocalVideo`, `YouTubeEmbed`), `widget-semantic.ts`, state schema và migration state trong registry, helper trạng thái phát dùng chung |
| E | #322 L map offline + tile policy | #329 (tuần tự) | như A | contract map, các file catalog, route tile mới, `secret-broker.ts`, `renderers.tsx`, asset basemap |
| F | #325 M diagram không chạy script | #322 (tuần tự) | như A | cùng các file catalog, parser Mermaid subset mới trong `packages/contracts` hoặc runtime |
| G | #323 tile thật (`external-gate`) | #322 | — | Chỉ cấu hình tile policy và bằng chứng |
| H | #324 N audio + document preview | #313, #329; sau #325 | — | `packages/contracts/src/attachments.ts` (MIME audio), `apps/runtime/src/pdf-text.ts`, route media fetch, các file catalog, `renderers.tsx`, helper phát của #329 |

## Ghi chú xung đột file

- #313, #315, #316 cùng sửa `widget-sdk`, `widget-host` và thêm migration storage, nên đi tuần tự.
- #313 sửa `renderers.tsx` (thẻ file); #326–#329, #322, #325, #324 cũng sửa file này. Rebase nhỏ hoặc đi sau #313.
- #326, #327, #328, #329, #322, #325, #324 cùng anchor catalog; làm tuần tự theo bảng hoặc rebase nhỏ. Thứ tự A–F có thể đổi nếu cần, nhưng #324 luôn sau #329 và #313.
- #334, #335 và phần dev-host của #313, #315, #316 cùng sửa `dev-shell.ts`/`dev-host.ts`; đi tuần tự hoặc rebase nhẹ.
  #334/#335 nhỏ, không bị chặn, nên làm sớm.
- Các mini app chủ yếu thêm package mới trong `examples/`, ít xung đột; template trong `widget-cli` có thể chạm nhau
  giữa #317, #319, #320, #332.

## Tiêu chí hoàn tất

- Mọi sub-issue đóng qua PR có unit test, E2E, docs EN/VI, `pnpm verify` / `pnpm verify:full` / `pnpm invariants`.
- Docs chính thức cập nhật ở `digitopvn/clarkcant-web` sau mỗi merge, hoặc có issue `ai-handle` thay thế.
- #200 đóng khi #313–#320, #332, #334, #335 xong; #321 và #333 có thể còn mở vì gate ngoài.
- #198 đóng khi #326–#329, #322, #324, #325 (và #323 nếu gate mở) xong; mọi mục P1 và P2 của #198 giờ đều có issue.

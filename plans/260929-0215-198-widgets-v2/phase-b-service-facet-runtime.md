---
phase: B
title: "Service facet chạy trong container và đăng ký capability có kiểu"
status: in-progress
issues: [221, 198]
---

# Phase B — service facet chạy trong container

## Bối cảnh

Manifest v2 (#220, PR #227) đã khai báo `tools` facet: `isolation: "service"`, `protocol: "mcp-stdio"`, `entry`, và
`capabilities[] { tool, ref, summary, effectCategory }` với `ref` nằm trong namespace của package. Host mới chỉ đọc và
liệt kê, chưa chạy service. `StdioMcpTransport` (`packages/mcp-adapters/src/stdio.ts`) đã có nhưng chưa có caller
production. `invokeMiniAppAction` trả `UNSUPPORTED_ACTION` cho mọi binding không phải `view`.

Quyết định của chủ sản phẩm (#221, issuecomment-5881990499): service facet **bắt buộc chạy trong container**; không có
engine thì không chạy, không có fallback process-only. Quyết định này thay khuyến nghị process-only trong
`plans/reports/kongming-260929-0215-service-facet-runtime.md`; các phần còn lại của báo cáo vẫn áp dụng.

## Yêu cầu

Container (`apps/runtime/src/service-container.ts`):

- Engine: Docker hoặc Podman, dò bằng lệnh `version` thật như `container-engine.ts`. Engine phải chạy được image Linux
  (Docker trên Windows ở chế độ Windows container không đạt, và được báo đúng lý do).
- `docker run -i --rm` với `--network none`, `--read-only`, `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, `--cpus`, `--tmpfs /tmp`, user không phải root,
  package root mount read-only tại `/pkg`, một thư mục dữ liệu riêng mount tại `/data`, nhãn
  `clarkcant.node=<nodeId>` để dọn container mồ côi khi boot.
- Image Node chính thức, pin theo digest.
- Chỉ nói chuyện qua MCP trên stdio; không mở cổng nào.

Service host (`apps/runtime/src/service-host.ts`):

- Khởi động theo generation đang active có `tools` facet, lúc boot và sau install, uninstall, restore, rollback.
- Không có engine: không chạy; capability đăng ký `loaded: false` với lý do "needs Docker or Podman".
- Handshake → `tools/list` → đối chiếu với khai báo. Tool khai báo mà service không có thì `loaded: false` kèm lý do.
  Tool service có mà không khai báo thì không bao giờ được đăng ký.
- Readiness: `installed` = generation active; `loaded` = đã handshake và có tool; `authenticated` = true (chưa có
  connection); `authorized` = ref thuộc `grantedCapabilities`; `healthy` = process sống và `ping` trả lời.
- Effect category = mức mạnh hơn giữa khai báo và annotation của tool.
- Crash: đánh dấu không healthy ngay, restart với backoff 1s→60s, tối đa 5 lần trong 10 phút rồi dừng hẳn kèm lý do.
- Dừng: đóng stdin, `docker kill` theo tên, `stopTree` cho process CLI; `closeAll()` khi node dừng và khi dừng khẩn cấp.

Một đường gọi (`apps/runtime/src/application/capability-invoke.ts` `invokeCapability`):

- `invocationPreflight` → kiểm tra args theo `inputSchema` của tool (`z.fromJSONSchema`) → `decideExecution` theo
  effect category → `deny` từ chối; `ask` tạo approval và trả `APPROVAL_REQUIRED`; `execute` ghi
  `recordEffectExecution` rồi gọi service.
- Caller: binding `invoke` của widget (qua `invokeWidgetAction`, voice cũng vào đây), và model tool
  `invoke_capability` của main agent.
- Từ chối: capability không phải `svc` cục bộ của node này, generation của binding không còn active.

UI:

- Service lỗi thì widget vẫn đọc được; binding `invoke` hiển thị disabled kèm lý do thật từ registry.

## Ngoài phạm vi (ghi rõ là deferred)

- Credential broker cho connector trong service.
- VM containment; engine khác Docker/Podman.
- Gọi capability trên node khác.
- Model tự đặt widget của package đã cài kèm binding `invoke`: thuộc #223 (phase D).

## File

- `packages/mcp-adapters/src/stdio.ts` (onExit, ping, windowsHide)
- `apps/runtime/src/service-container.ts`, `service-host.ts`, `application/capability-invoke.ts`
- `packages/core/src/widget-service.ts`, `apps/runtime/src/application/widget-actions.ts`
- `apps/runtime/src/node-tools.ts`, `main.ts`, `services.ts`
- Fixture E2E: package có UI facet và service facet
- Docs: `docs/widgets-and-extensions{,.vi}.md`, `docs/system-architecture{,.vi}.md`,
  `docs/conformance-traceability.md`, `clarkcant-web`

## Kiểm chứng

- Unit: tham số `docker run`, đối chiếu tool, readiness, backoff, `invokeCapability` (deny/ask/execute, args sai).
- Integration với Docker thật khi máy có engine; khi không có thì test khẳng định nhánh "needs Docker or Podman".
- E2E: widget gọi service, agent gọi cùng capability, voice gọi qua cùng binding; kill container thì widget vẫn đọc
  được và nút disabled kèm lý do.
- `pnpm verify`, `pnpm verify:full`, CI xanh cả Windows.

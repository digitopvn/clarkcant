---
title: "#198 Widgets v2: manifest hợp nhất, service facet và catalog P0"
status: in-progress
created: 2026-09-29
issues: [198]
related: [195, 200, 201, 209, 210]
---

# #198 Widgets v2: manifest hợp nhất, service facet và catalog P0

Nguồn: issue [#198](https://github.com/digitopvn/clarkcant/issues/198), phase 04 của
[lộ trình](../260929-0002-open-issues-roadmap/plan.md). Phần P1/P2 của #198 thuộc phase 10 và nằm ngoài plan này.

## Kết quả cần đạt

Sau plan này:

- Một package ClarkCant được mô tả bằng một manifest chuẩn duy nhất và có thể mang nhiều facet (UI cô lập, service/tool,
  skill, …).
- Service facet chạy dưới supervisor, đăng ký capability có kiểu trong Capability Registry, và được gọi qua một đường
  host duy nhất, dùng chung cho UI, main agent và voice.
- Catalog mặc định có thêm các primitive P0: Table đủ hợp đồng, Action tổng quát, layout, input/choice/search/form/list,
  và một state/event graph khai báo do host sở hữu.

## Ràng buộc

- Giữ nguyên trust lane: host-owned, trusted built-in, declarative composition, isolated executable. Widget không tin
  cậy không nhận secret, IPC hay quyền tự duyệt. UI không gọi service trực tiếp; mọi lời gọi đi qua ActionBinding hoặc
  Capability Registry.
- Package đã cài theo manifest cũ (`schemaVersion: 1`) vẫn chạy, và có test cho đường chuyển đổi.
- Migration storage là bất biến: chỉ thêm migration mới. Số migration hiện tại là 26.
- Không có control giả. Binding chưa thực thi được thì hiển thị disabled kèm lý do thật.
- Bộ từ vựng của model phải bị chặn (bounded): độ sâu và số node có giới hạn, không có payload thực thi, chỉ dùng
  definition đã biết, digest được pin.
- Đa nền tảng: service facet phải chạy trên Windows, macOS và Linux.
- Mỗi PR: `pnpm verify` xanh, E2E cho journey UI, docs EN và VI trong repo, docs `clarkcant-web` khi thay đổi hiển thị
  với người dùng.

## Ngoài phạm vi

- P1/P2 của #198 (status, artifact, chart, calendar, timeline, map, …): thuộc phase 10.
- Credential broker cho connector bên ngoài chạy trong service facet: chỉ ghi rõ là deferred, chưa implement.
- Containment bằng VM cho service facet. Service facet chạy trong container Docker/Podman (quyết định của chủ sản phẩm
  trên #221); không có engine thì không chạy, không có fallback process-only.
- Việc tiêm semantic state vào main agent: thuộc #195 (phase 05). Plan này chỉ công bố state graph ở dạng #195 dùng lại được.

## Các phase (mỗi phase là một sub-issue và một PR)

| # | Phase | Phụ thuộc | Trạng thái |
|---|---|---|---|
| A | [Manifest chuẩn v2 cùng tương thích v1](phase-a-canonical-manifest.md) | — | done (#220, PR #227) |
| B | [Service facet runtime và capability](phase-b-service-facet-runtime.md) | A | done (#221, PR #234) |
| C | [Hợp đồng đầy đủ của `canvas.table@1`](phase-c-table-contract.md) | — | done (#222, PR #228) |
| D | [Action tổng quát `canvas.action@1`](phase-d-generic-action.md) | B (với invoke) | done (#223) |
| E | [Layout primitive và cây composition có giới hạn](phase-e-layout-composition-tree.md) | — | done (#224) |
| F | [Primitive input, choice, search, form và list](phase-f-input-primitives.md) | E | pending |
| G | [State/event graph của composition](phase-g-composition-state-graph.md) | E, F | pending |

A và C độc lập với nhau, có thể làm song song. E, F và G nối tiếp nhau.

## Truy vết acceptance của #198 → phase

| Acceptance | Phase |
|---|---|
| Mini App CRUD, dashboard, search, form và status phổ biến compose được mà không cần UI tuỳ biến | C, E, F, G |
| Số widget built-in có giới hạn và không phụ thuộc domain | C–G (≈10 primitive mới) |
| Descriptor và renderer khớp nhau | C (table); các primitive mới có test coverage renderer ↔ descriptor |
| Action UI render mọi binding hợp lệ mà không cần biết cách binding được thực thi | D |
| Widget chia sẻ state qua graph khai báo do host sở hữu | G |
| Package ship được cả isolated UI lẫn service/tool facet | A, B |
| Service facet đăng ký capability có kiểu | B |
| Main agent, voice và UI gọi cùng một capability | B, D |
| UI không gọi được service cùng cấp qua localhost | B (service chạy qua stdio, không mở cổng; CSP của frame không có origin của service) |
| Credential do Clark broker, không nằm trong props/state | B (env allowlist; không truyền secret), D |
| Một manifest chuẩn cho package đa facet | A |
| Install/update/uninstall xử lý vòng đời theo facet | A, B |
| Service lỗi thì UI vẫn đọc được, kèm trạng thái degraded/offline | B, D |
| Metadata marketplace quảng bá đúng facet và risk lane | A (`riskLaneFor` đọc manifest chuẩn) |

## Rủi ro

- Service facet là code bên thứ ba chạy trên node. Mức containment phải được nêu trung thực, và quy tắc chặn phải thống
  nhất với `execution-supervisor` ("process-only thì không đủ cho code không tin cậy"). Xem phase B và báo cáo
  `plans/reports/kongming-260929-0215-service-facet-runtime.md`.
- Thay đổi hợp đồng public (manifest, composition spec) phải được version hoá.
- Bộ từ vựng của model lớn dần: giữ mô tả ngắn và có giới hạn để không làm hỏng prompt cache.

---
title: Lộ trình ưu tiên và hoàn thiện mọi issue mở không bị gate
status: in-progress
created: 2026-09-29
branch: claude/clarkcant-issues-priority-7d4f7d
issues: [93, 129, 137, 169, 170, 171, 172, 173, 174, 190, 192, 195, 196, 197, 198, 200, 201, 210]
---

# Lộ trình ưu tiên và hoàn thiện mọi issue mở không bị gate

## Outcome contract (KHOÁ — đã duyệt 2026-09-29)

- **Kết quả:** mọi issue mở không bị gate bên ngoài của `digitopvn/clarkcant` được triển khai, merge vào `main`
  và đóng kèm bằng chứng. Mỗi issue gated vẫn mở và có comment ghi chính xác prerequisite còn thiếu.
- **Trong phạm vi:** xem bảng truy vết. Thứ tự ưu tiên: bảo mật trước.
- **Ngoài phạm vi:** #2, #3, #4, #5, #193, #194, #199, #209, cùng mọi live journey cần tài khoản, phần cứng
  hoặc host bên ngoài.
- **Nghiệm thu:** mỗi issue đóng phải có PR merged, CI xanh (kể cả `verify (windows-latest, node 24)`),
  `pnpm verify` pass (và `pnpm verify:full` cùng E2E liên quan cho UI journey), acceptance của issue được đối
  chiếu từng mục trong comment đóng, và docs `clarkcant-web` (EN và VI) đã merge hoặc có issue fallback `ai-handle`.
- **Ràng buộc:** AGENTS.md (triết lý sản phẩm, pnpm, không enum hay namespace, migration bất biến, chỉ
  `packages/pi-adapter` import Pi SDK). Conventional commits, không AI attribution. Không làm yếu test. Gặp xung
  đột với triết lý sản phẩm thì dừng hỏi.
- **Thay thế được phép:**
  1. Issue bị gate một phần (#129 phần voice audio thật, #170 cross-host proof, #197 live journey, #210
     phase E; mở rộng 2026-09-29: producer của #172 cho OAuth hết hạn (#2) và pairing (#5), #201 M6 marketplace
     (#194), app sinh ảnh của #200 (provider key), click notification Electron có GUI của #171 nếu Playwright
     Electron không test được): tách phần bị gate thành sub-issue `blocked,external-gate`, rồi đóng issue gốc
     khi phần in-repo đạt acceptance.
  2. #206 và #207 được hợp nhất, hoặc đóng PR trùng lặp.
- **Quyền:** merge PR khi CI xanh, đóng issue đã xong, sửa ruleset `main`, tạo issue và sub-issue.
- **Người quyết định:** user.

## Quyết định user đã chốt (2026-09-29)

- #192: agent chọn 4–6 preset, giữ preference toàn cục `orb.profile`. Tự viết lại shader nếu giấy phép ShaderCN
  không cho chép.
- #188: merge report vào `plans/reports/`. P0 Stop được làm ở phase 03. Các finding khác chỉ được ghi lại, không
  trở thành scope mới.
- Phần gated của #171, #172, #200 và #201: áp dụng thay thế số 1 (đã mở rộng).
- #170: nếu HTTP pairing không đủ, tạo issue riêng (lý do, cách giải quyết, điều cần từ user) và tiếp tục, không dừng hỏi.

## Nguồn

- Scout: `plans/reports/scout-260929-0002-open-issues.md` (27 issue, 5 PR, `main` @ `1d11a5e`).
- #191 đã đóng bởi PR #208 (merged 2026-09-29).

## Vòng lặp chuẩn cho mỗi issue (áp dụng ở mọi phase)

1. Đọc lại issue, comment mới, và doc domain theo AGENTS.md (progressive disclosure).
2. Với issue cỡ L/XL: tạo plan con `plans/{date}-{issue}-{slug}/` qua `ak:issue-to-plan` hoặc `ak:plan`, rồi
   validate bằng `ak plan validate`. Với epic: tạo sub-issue cho từng phase hoặc milestone, liên kết với epic.
3. Tạo branch từ `main` mới nhất, triển khai, chạy test hẹp trước, sau đó `pnpm verify` (thêm `pnpm verify:full`
   nếu chạm UI journey).
4. Tạo PR có body không chứa closing keyword, theo invariant `pr-bodies-close-nothing`; issue được đóng thủ công
   kèm bằng chứng. Chạy review (`ak:code-review` hoặc `ak:review-pr`) và sửa các finding nghiêm trọng.
5. Merge khi mọi required check xanh. Nếu thay đổi nhìn thấy được với người dùng, mở và merge PR docs trên
   `digitopvn/clarkcant-web` (EN và VI).
6. Comment đóng issue: đối chiếu từng acceptance, link PR và docs. Cập nhật issue liên quan nếu giả định thay đổi.
7. Nếu cập nhật trạng thái conformance thì sửa `docs/conformance-traceability.md` (chỉ tiếng Anh).

## Phases

| # | Phase | Tier | Phụ thuộc | Trạng thái |
|---|---|---|---|---|
| 01 | [Gỡ kẹt merge gate và land PR mở](phase-01-unblock-merge-gate.md) | 0 | — | done |
| 02 | [Kiểm chứng và đóng issue đã xong](phase-02-close-done-issues.md) | 0 | 01 | done |
| 03 | [Bảo mật: #137 và Stop một turn đang chạy](phase-03-security-confinement-stop.md) | 1 | 01 | done |
| 04 | [#198 lõi: manifest hợp nhất, service facet, catalog P0](phase-04-widgets-v2-core.md) | 2 | 03 | done (A–G; #198 còn P1/P2 ở phase 10) |
| 05 | [#195 semantic state của widget](phase-05-widget-semantic-state.md) | 2 | 04 (hợp đồng composition) | done (#195) |
| 06 | [#197 phase 1–2: provenance, resource theo task, Signal/Intent](phase-06-reactive-automation-core.md) | 2 | 03 | done (#240 #245, #241 #247) |
| 07 | [#210 A–D cùng #196 phase 1–2: hợp đồng reference chung](phase-07-composer-refs-actionable-inbox.md) | 2 | 01 | done (#210 A–D đóng, E tách #255; #196 phase 1–2 qua #258; [kế hoạch con](../260929-2100-210-composer-references/plan.md)) |
| 08 | [#196 phase 3–5, #170, #172 phần còn lại](phase-08-inbox-completion.md) | 3 | 06, 07 | in progress (#172 đóng; #170 đóng qua #276, tiêu chí 2 tách #274; #196 phase 4 qua #272, #268; còn #196 phase 3, 5) |
| 09 | [#192 cá nhân hoá Orb](phase-09-orb-personalization.md) | 3 | 01 | done (#192 qua #271; #269 qua #278) |
| 10 | [#198 P1/P2 và #200 (đã khử trùng lặp)](phase-10-widget-platform-expansion.md) | 4 | 04, 05 | pending |
| 11 | [#197 phase 3–5 (fixture, tách live journey)](phase-11-reactive-automation-adapters.md) | 4 | 06 | done (#242 #249, #243 #252, #244 #254); follow-up: #251 (PR #260), #246 (PR #261), #248 (polling theo lịch), #253; #250 gated |
| 12 | [#201 nền tảng theme](phase-12-theme-platform.md) | 4 | 04, 09 | pending |
| 13 | [Đối soát cuối và bàn giao](phase-13-final-reconciliation.md) | — | tất cả | pending |

Có thể chạy song song khi quyền sở hữu file tách bạch: 05 ∥ 06 ∥ 07 ∥ 09 sau 04 hoặc 03. Không chạy song song
hai phase cùng thêm migration storage; phải xếp hàng migration theo thứ tự merge.

## Bảng truy vết contract

| Phase | Hạng mục contract | Tín hiệu nghiệm thu | Sự thật / giả định / prereq / quyết định user |
|---|---|---|---|
| 01 | Tier 0: gỡ kẹt check Windows, land #205, #206/#207, xử lý #188, đóng #190 | Ruleset không còn deadlock; #205 và #207 merged; #190 đóng | **Sự thật:** ruleset 24128511 yêu cầu Windows check mà chỉ #207 có; #207 đang conflict. **Đã chốt:** merge report #188, P0 Stop sang phase 03 |
| 02 | Đóng #93, #169, #171, #173, #174; #129 (thay thế 1) | Comment đối chiếu acceptance; sub-issue voice gated cho #129 | **Sự thật:** các commit đã land (scout §2). **Giả định:** #171 cần kiểm tra click Electron bằng tay; agent chỉ ghi nhận hạn chế, không bịa kết quả |
| 03 | Tier 1: #137; issue mới cho P0 Stop | Test hồi quy chứng minh root rỗng fail closed; Stop dừng turn thật (E2E) | **Sự thật:** `real.ts:423-460` bật read tool theo `cwd` khi root rỗng. **Giả định:** P0 Stop chưa kiểm chứng trên main |
| 04 | Tier 2: #198 lõi | Một manifest đa facet; service facet chạy được; catalog P0 có test | **Sự thật:** `widget-package.ts` vẫn `kind: z.literal("widget")` |
| 05 | Tier 2: #195 | Suffix-only injection giữ prompt cache; `inspect_ui` có test | Migration mới (bất biến) |
| 06 | Tier 2: #197 phase 1–2 | Worker nhận resource theo task (thay root toàn node); matcher tất định có test | Chồng lấn #137, nên làm sau 03 |
| 07 | Tier 2: #210 A–D, #196 phase 1–2 | Một `ComposerReference` dùng chung; popover a11y; notice có subject và action | **Prereq:** #210 phase E tách sub-issue (thay thế 1) |
| 08 | Tier 3: #196 phase 3–5, #170, #172 | Action retry, update và snooze hoạt động; notice từ node khác (hai node trên một máy); producer còn lại | **Đã chốt:** producer phụ thuộc #2 và #5 tách sub-issue gated |
| 09 | Tier 3: #192 | Preset, preview trong Settings, reduced-motion và WebGL fallback | **Đã chốt:** agent chọn 4–6 preset, lưu toàn cục; kiểm tra giấy phép ShaderCN |
| 10 | Tier 4: #198 P1/P2, #200 | Milestone của #200 có sub-issue; mini app tham chiếu | **Đã chốt:** phần chạy thật của app sinh ảnh tách sub-issue gated |
| 11 | Tier 4: #197 phase 3–5 (thay thế 1) | GitHub adapter chạy với fixture hoặc polling; live journey tách sub-issue gated | Phase 5 (NodeLink peer signal) dùng pairing HTTP cục bộ |
| 12 | Tier 4: #201 | Theme M1–M5, M7; M6 marketplace | **Đã chốt:** M6 tách sub-issue gated (#194 ngoài phạm vi) |
| 13 | Đóng mọi issue trong phạm vi; comment trên issue gated | Mọi issue trong phạm vi đã đóng kèm bằng chứng; mỗi issue gated có comment prerequisite | — |

## Rủi ro chung

- Plan con cho từng epic có thể phát hiện quyết định sản phẩm mới. Khi đó áp dụng scope guard và dừng hỏi user.
- Migration storage chồng nhau giữa 04, 05, 08, 12: xếp hàng số migration theo thứ tự merge và rebase trước khi merge.
- CI Windows có thể lộ lỗi nền tảng mới. Sửa nguyên nhân, không skip test.

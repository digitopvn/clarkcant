---
handoff-version: 1
generated: 2026-10-01T19:49:10+07:00
generator: ak-handoff@2.1.0
focus: "Tiếp tục goal open issues trên cùng máy, từ các worktree đã commit và push"
workspace: D:/www/digitop/clarkcant
branch: codex/handoff-261001-1946
---

# HANDOFF: tiếp tục open issues trên cùng máy

## Mission and current status

**User chốt: tiếp tục trên chính máy Windows này, không chuyển máy. Giữ và tái sử dụng các worktree dưới đây.** Yêu cầu cuối là tạo handoff, commit và push phần việc hiện tại; dừng triển khai thêm để bàn giao. Goal gốc vẫn chưa hoàn thành: triển khai, kiểm chứng, merge và đóng mọi issue không bị gate bên ngoài trong `digitopvn/clarkcant`.

Đã quan sát trên GitHub ngày 2026-10-01: không có PR mở ở `clarkcant` hoặc `clarkcant-web`. Các PR product #360–#362, #364–#365, #367–#368, #371–#373, #375–#376 đã merged. Docs web #58–#65 đã merged. #299, #300, #302, #327, #328, #334 và #335 không còn trong danh sách issue mở.

Đang làm #315 tại **`D:/wt315`**. Đã có implementation checkpoint, chưa có PR và chưa đủ acceptance. #329 tại **`D:/wt329`** còn dở, bị quyết định CSP ở #374 chặn phần video. Không đóng hai issue này chỉ vì code đã commit/push.

Thứ tự tiếp tục: hoàn thiện #315, rồi #316; tiếp #317–#320 và #332 theo dependency. Các widget #322, #324, #325 vẫn mở; #324 tái sử dụng playback coalescer của #329 nên phải đối soát #329/#374 trước. Epic #198/#200/#201 chỉ đóng khi các phần trong phạm vi được đối chiếu đầy đủ. Giữ các gate đã được user chấp nhận; không biến việc đòi account, hardware, provider hoặc host thứ hai thành bằng chứng fixture.

## Scope and guardrails

Workspace điều phối: `D:/www/digitop/clarkcant`. Worktree thực thi chính: `D:/wt315`. Shell: PowerShell; timezone: Asia/Saigon; trao đổi với user bằng tiếng Việt, code/commit bằng tiếng Anh.

- User đã cho phép triển khai end-to-end, tạo PR, merge khi required CI xanh, đóng issue kèm acceptance evidence và hoàn thiện official docs EN/VI. Không hỏi lại quyền đã có; quyết định sản phẩm mới còn thiếu vẫn cần người quyết định.
- Các AGENTS.md user gửi ngày 2026-10-01 thay thế bản user gửi trước. Đọc lại bản đang áp dụng, `README.md`, `DESIGN.md`, docs domain và `REVIEW.md` trước khi tiếp tục. Dùng pnpm/Corepack, không npm/yarn; exact pin; không enum/namespace; chỉ pi-adapter import Pi SDK.
- Không sửa migration đã áp dụng. Backup DB trước mọi thay đổi schema/data thật. Không commit credential, dotenv, private key, dữ liệu cá nhân hoặc force-add generated evidence.
- Code đi qua branch/PR. Commit này là checkpoint để tiếp nối, không phải release hoặc bằng chứng đã ship. Không merge các nhánh archive nguyên khối vào main.
- Giữ host policy, effect ledger, provenance và Stop. JobRef là pointer, không phải quyền truy cập. Không cho widget/AI tự duyệt privileged action.
- Khi feature làm official docs stale, tạo issue `ai-handle` ở `digitopvn/clarkcant-web` có link PR, kể cả khi tự làm docs; duy trì cả EN/VI. Outcome contract của goal yêu cầu docs merged hoặc fallback issue đúng điều kiện.
- Không gỡ worktree hoặc xoá báo cáo trong bước bàn giao. Không đụng worktree của phiên khác dưới `D:/orca/...`, các worktree Claude không thuộc roadmap hoặc `clarkcant-web-table-export`.

## Current state

GitHub product `main` quan sát bằng `git ls-remote`: `121816699eef3b930f0c40245c4cc30126bfb29d`. Official-web `main`: `4e031dd98a35aeba75313d071342fea33a11c9b6`.

**Các đường dẫn dưới đây là worktree thật còn tồn tại trên máy này. Không clone lại và không tạo bản làm việc trùng.** Nhánh archive mới được tạo để lưu các file trước đó chưa track; HEAD có thể cũ hơn main và không phải nơi bắt đầu feature mới.

| Worktree tuyệt đối | Nhánh đang checkout | HEAD checkpoint | Vai trò |
|---|---|---|---|
| `D:/www/digitop/clarkcant` | `codex/handoff-261001-1946` | `39c55868` trước commit handoff này | Handoff canonical và báo cáo chẩn đoán model; gốc trước bàn giao là `fix/desktop-dev-window` @ `be7f6e3a` |
| `D:/wt315` | `codex/315-job-ref` | `ac0fe0d5146336e0315b326a889cc7f78f755782` | **Worktree tiếp tục triển khai #315**; base main `12181669` |
| `D:/wt329` | `codex/handoff-261001-1946-329` | `f510adee0182e1a17908032467b36f59b7a931f9` | Code/docs #329, plan và evidence logs; giải quyết #374 trước video closeout |
| `D:/www/digitop/clarkcant/.claude/worktrees/clarkcant-issues-priority-7d4f7d` | `codex/handoff-261001-1946-roadmap` | `82900db757d9561ebe3e0940aa8262bac3e8c9ac` | Roadmap gốc, handoff cũ, closure/review logs, agent memory và tiện ích; trước đó detached @ `93426ada` |
| `D:/wt299` | `codex/handoff-261001-1946-299` | `e96cbff3359e216601602aa2dd61d607ac41fdb4` | Báo cáo/verification của feature đã land |
| `D:/wt300` | `codex/handoff-261001-1946-300` | `6e9f191e8f21ee157687be19e6b9f031f96505de` | Báo cáo/verification Theme Lab đã land |
| `D:/wt302` | `codex/handoff-261001-1946-302` | `a43725ed4a6977b508cd455db8264776316bd540` | Báo cáo/reference theme đã land |
| `D:/wt327` | `codex/327-tree-view` | `23931eaf` | Tree đã land; chỉ còn generated evidence local |
| `D:/wt328` | `codex/328-kanban-board` | `dfa0a839` | Kanban đã land; chỉ còn generated evidence local |
| `D:/wt334` | `codex/334-dev-host-service-simulator` | `9b0e4336` | Dev-host simulator đã land |
| `D:/wt335` | `codex/335-dev-host-semantic-composition` | `081f9668` | Dev-host semantic/composition đã land |
| `D:/wt343` | `feat/343-conversation-delete` | `2caefcd8` | Conversation deletion đã land |
| `D:/wt356` | `fix/356-workflow-deadline-race` | `7006e690` | Fix đã land |
| `D:/wt358` | `fix/358-marketplace-meta-spacing` | `c1f68191` | Fix đã land |
| `D:/wt359` | `fix/359-calendar-week-phone-tap` | `0840c3ef` | Fix đã land |
| `D:/wt363` | `codex/363-browser-profile-cleanup` | `56fdb263` | Fix đã land |

Official docs checkout: `D:/www/digitop/clarkcant-web`, nhánh `main`, local HEAD `455054fc` cũ hơn remote; fetch trước khi dùng. Worktree docs hiện có, đều clean lúc kiểm tra: `D:/web299`, `D:/web300`, `D:/web302`, `D:/web327`, `D:/web328`, `D:/web343`, `D:/webdocs69`. Chưa có docs worktree dành cho #315.

Intentional local modifications: yes trước checkpoint, đã commit vào các nhánh tương ứng. `D:/wt315` clean sau hai commit. Các nhánh archive đã giữ file không phải evidence; trạng thái còn `?? plans/reports/evidence/` là generated output cố ý không commit. Các file trong evidence cũng không bị xoá, nên vẫn có trên máy này. Không mang runtime databases, node_modules hoặc credentials vào Git.

## Decisions and rationale

- Reuse JobRef + #313 artifact broker + #314 capability invocation, WorkSupervisor và MCP progress/cancellation; không tạo queue scheduler, paired jobs hoặc resource profile trong #315. #316 sở hữu resource/token policy.
- Durable job gắn principal, instance, binding, package generation, capability và conversation. Sau restart, open job chuyển failed/may-have-run; không tự chạy lại effect.
- Tách “chưa gửi, chưa chạy” khỏi “đã gửi nhưng không xác nhận kết quả” để effect ledger và lời báo Stop không nói sai.
- Chỉ lưu result bytes thực từ MCP thành ArtifactRefs. Không fetch resource links/URI/path mà service trả về. Tái sử dụng quota, MIME validation và grant của artifact broker.
- #329 giữ nguyên CSP theo issue gốc. Chromium từ chối blob video vì thiếu media-src; quyết định cho phép blob media hay giải pháp khác phải được chốt ở #374, không tự thay đổi invariant.
- User đã đổi yêu cầu từ chuyển máy sang tiếp tục **cùng máy**. Giữ các worktree, ghi rõ path/branch. Commit/push lưu trữ trạng thái, không merge công việc chưa hoàn tất.

## Work performed

#315 code commit: `1a1e2929` (`feat(runtime): checkpoint durable package jobs and widget bridge`). Plan commit: `ac0fe0d5`. Các file chính nằm tại `D:/wt315`:

- Contracts: `packages/contracts/src/jobs.ts`, service execution declaration `job@1`, primitive/export; storage migration 40 và `repositories/jobs.ts`.
- Runtime: `job-host.ts`, `job-result-artifacts.ts`, `routes/jobs.ts`, capability/widget invocation, bootstrap, supervisor, emergency Stop và shutdown.
- MCP: progress token matching/validation, cancellation và chuẩn hoá result text/image/audio/resource bytes trong adapters. URI không trở thành quyền fetch.
- Widget SDK/host/client: jobs@1 get/cancel/subscribe, polling có giới hạn và dispose, trusted frame callback, gateway client. Handler lỗi broker trả câu cố định để không tiết lộ host error.
- Tests: job contracts/store/host/artifact bytes, SDK subscriptions/dispose, MCP result files và các hồi quy action/service/Stop.
- Sửa job service default timeout thành ceiling 30 phút; synchronous call giữ ceiling 60 giây. Route job thêm owner, binding.instanceId và capability matching.
- Thêm `settleApprovedInvokeJob` tại `packages/core/src/widget-service.ts` ngay trước khi user chuyển sang handoff. **Helper chưa được nối vào approved-capability flow.** Đây là bước dở, không phải approval flow đã hoạt động.

#329 checkpoint: code `bcacdfff`, docs/records `f510adee`. Không triển khai thêm #329 trong đoạn bàn giao; giữ nguyên code/docs đã có tại worktree và báo cáo gate #374.

Archive roadmap: code/test phụ trợ `9f7f55c5`, records `82900db7`. `packages/conversation-client/test/calendar-layout.spec.ts`, `.claude/agent-memory/` và `shot-web-*.tmp.mjs` được giữ trên archive theo yêu cầu commit hết; không coi chúng là feature cần cherry-pick vào main.

Đã kiểm tra dirty files qua mọi worktree, chọn scope roadmap của phiên này, quét credential patterns với kết quả không có candidate, rồi commit code và records riêng. Các worktree website không có thay đổi cần commit. Không bắt đầu server mới; kiểm tra process chỉ thấy Raycast và Codex runtimes, không có dev/test process của phiên cần dừng.

0 redactions applied. Các báo cáo không chứa credential được chọn để lưu; evidence binary và dữ liệu runtime nằm ngoài phạm vi commit.

## Verification

| Check | Command / source | Outcome | Khi |
|---|---|---|---|
| #315 focused regression | `corepack pnpm exec vitest run apps/runtime/test/job-result-artifacts.spec.ts apps/runtime/test/job-host.spec.ts packages/storage/test/jobs.spec.ts packages/mcp-adapters/test/stdio.spec.ts apps/runtime/test/action-widget.spec.ts apps/runtime/test/service-host.spec.ts apps/runtime/test/stop-and-audit.spec.ts packages/widget-sdk/test/runtime.spec.ts packages/contracts/test/jobs.spec.ts` tại `D:/wt315` | **162 tests / 9 files passed**; cảnh báo disk-full là test failure-path chủ ý | 2026-10-01 19:47 Asia/Saigon |
| #315 typecheck | `corepack pnpm run typecheck` tại `D:/wt315` | Exit 0, cả Node và web configs | Cùng cây mã vừa commit |
| #315 plan | `ak plan validate plans/20261001-315-job-ref` | Passed | Bàn giao |
| #315 diff | `git diff --check` | Passed | Trước checkpoint |
| #329 trước bàn giao | `plans/20261001-329-media-semantic-state/reports/329-local-video-csp-blocker.md` tại `D:/wt329` | Báo cáo ghi verify 5,004 tests và verify:full 352 browser tests pass; **video pause journey không được chứng minh** | Evidence của phiên trước, không chạy lại trong bước lưu trữ |
| GitHub live state | gh issues/PR lists, git ls-remote | Không có PR mở; product/web remote main như phần Current state | Bàn giao |

Not run trên #315: full `pnpm verify`, lint, `pnpm verify:full`, job browser E2E, invariants và required CI. Feature còn thiếu các phần dưới đây; không gọi focused tests/typecheck là acceptance hoàn chỉnh. Logs archive giữ cả lần fail lẫn lần pass cũ; không suy luận cây code hiện tại từ một log ngẫu nhiên.

## Open risks and blockers

- Type: unfinished implementation. Owner: successor agent. Impact: approval payload/digest chưa mang jobOrigin; `runApprovedCapability` chưa khôi phục origin và đang coi job outcome là chưa chạy. Phải bind cả origin vào digest, kiểm tra lại binding, mở/settle canonical effect ledger và nối helper để invocation cũ trả cùng JobRef sau approval. Thêm tests forged/stale/approved job.
- Type: security/contract gap. Owner: successor agent. Impact: route ownership đã tăng cường nhưng thiếu tests gateway cross-principal/instance/binding/generation/capability. Job admission origin vẫn cần validation ngay tại shared invoke boundary.
- Type: robustness. Owner: successor agent. Impact: host `.then(...).finally(...)` chưa có terminal catch khi DB finish throws; phải bảo toàn recoverable state và tránh unhandled rejection. Notice hiện còn chung chung, chưa nêu tên kết quả đầy đủ.
- Type: long-running budget. Owner: successor agent. Impact: job polling có thể chạm frame `maxMessages` 200; cần bucket riêng như artifacts. Widget binding deadline có thể còn 60 giây dù service job ceiling là 30 phút; kiểm tra default thực tế, giữ limit user cấu hình rõ ràng.
- Type: missing integration. Owner: successor agent. Impact: dev-host job simulation, conversation deletion guard/cleanup, emergency Stop job tests, browser progress/remount/cancel/artifact/restart journeys và internal/official docs chưa hoàn tất.
- Type: policy inconsistency. Owner: successor agent. Impact: draft `machine-surfaces.ts` chặn POST cancel job theo person-only trong khi AGENTS yêu cầu Stop còn sẵn ở machine surfaces. Rà lại threat model và canonical Stop; không nhân đôi stack.
- Type: SDK hardening. Owner: successor agent. Impact: subscribe phải validate ref ngay; đồng bộ progress bounds; cân nhắc dedupe snapshots và giới hạn listeners. Không dùng retry vô hạn để che invalid refs.
- Type: product decision. Owner: user ở #374. Impact: #329 local-video journey và closeout chưa đạt; không âm thầm đổi CSP hay tuyên bố full browser coverage.
- Type: stale coordination. Owner: successor agent. Impact: roadmap archive còn nói theme M5/M7 và tree/kanban chưa xong dù GitHub đã đóng; cập nhật plan theo live evidence ở bước tiếp tục, không theo handoff cũ.

## Exact next actions

1. **First safe step** — trên máy này, đọc tài liệu này rồi chạy `git -C D:/wt315 status --short`, `git -C D:/wt315 log -2 --oneline` và `git -C D:/www/digitop/clarkcant worktree list`. Xác minh #315 ở `ac0fe0d5`, nhánh `codex/315-job-ref`; không tiếp tục feature trong root handoff branch hoặc roadmap archive.
2. `Set-Location D:/wt315`. Đọc lại `plans/20261001-315-job-ref/plan.md` và ba phase files, issue #315/comments, docs widget/open-interface, DESIGN và review policy. Fetch origin; nếu rebase/cây mã thay đổi, chạy lại checks thích hợp. Không tạo worktree #315 thứ hai.
3. Hoàn thiện approved job origin/digest/ledger/invocation recovery với focused tests; review error/race/ownership, polling budget và timeout gaps liệt kê ở trên.
4. Hoàn thiện dev-host simulation, conversation lifecycle/Stop, result notices, gateway auth tests, actual browser journeys và public discovery/OpenAPI cho route mới. Update internal EN/VI docs, manifest/checks và conformance claims theo evidence thật.
5. Áp dụng implementation/review skill đang cài; nếu cook yêu cầu simplifier theo kích thước diff thì chạy đúng điều kiện. Validate plan, run verify/invariants/verify:full, tạo product PR không dùng closing keyword, chờ required CI kể cả Windows rồi merge khi đủ gate.
6. Tạo issue `ai-handle` và docs PR EN/VI trong `clarkcant-web` có link product PR, verify/merge theo policy, kiểm tra deployment. Đóng #315 bằng comment đối chiếu từng acceptance; cập nhật #200 và roadmap.
7. Tiếp #316 và dependent reference apps. Nếu quay lại media, dùng `D:/wt329` với nhánh archive đã ghi, đối soát base/main và #374 trước; không reset hoặc cherry-pick archive nguyên khối. Đóng các epic chỉ theo dependency/evidence.

## Source pointers

- Handoff canonical: `D:/www/digitop/clarkcant/plans/reports/handoff-261001-1949-open-issues-local-worktrees.md` trên `codex/handoff-261001-1946`.
- Plan #315: `D:/wt315/plans/20261001-315-job-ref/plan.md`; runtime source: `D:/wt315/apps/runtime/src/application/capability-invoke.ts`, `D:/wt315/apps/runtime/src/application/widget-actions.ts`, `D:/wt315/apps/runtime/src/job-host.ts` và `D:/wt315/apps/runtime/src/routes/jobs.ts`.
- Roadmap: `D:/www/digitop/clarkcant/.claude/worktrees/clarkcant-issues-priority-7d4f7d/plans/260929-0002-open-issues-roadmap/plan.md`; expansion plan: `plans/260930-0200-widget-platform-expansion/plan.md` cùng worktree.
- Handoff cũ (chỉ là lịch sử, đã stale): `D:/www/digitop/clarkcant/.claude/worktrees/clarkcant-issues-priority-7d4f7d/plans/reports/handoff-260930-1143-open-issues-roadmap.md`.
- Media plan/gate: `D:/wt329/plans/20261001-329-media-semantic-state/plan.md`, `D:/wt329/plans/20261001-329-media-semantic-state/reports/329-local-video-csp-blocker.md`.
- Issues: https://github.com/digitopvn/clarkcant/issues/315 ; https://github.com/digitopvn/clarkcant/issues/316 ; https://github.com/digitopvn/clarkcant/issues/329 ; https://github.com/digitopvn/clarkcant/issues/374 ; https://github.com/digitopvn/clarkcant/issues/200 .
- Repositories: https://github.com/digitopvn/clarkcant ; https://github.com/digitopvn/clarkcant-web .
- MCP primary specs đã đối chiếu: https://modelcontextprotocol.io/specification/2025-06-18/server/tools và https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress .

Unresolved: #315 chưa đạt acceptance; #329 còn quyết định CSP #374. Không có câu hỏi phê duyệt commit/push đang chờ user.

---
phase: 1
title: "Ngữ nghĩa thực thi: provenance, resource theo task, lệnh qua broker cho worker"
status: done
issues: [197]
---

# Phase 01 — Ngữ nghĩa thực thi

## Bối cảnh (đã đọc từ code)

- `packages/core/src/execution-policy.ts`: `ExecutionQuestion.explicitUserIntent: boolean`. Autonomous chỉ hỏi
  category rủi ro khi cờ này `false`. Mọi đường production đều truyền `true` (`node-tools.ts` run_command,
  `task-dispatch.ts` gate, widget action, install).
- `apps/runtime/src/task-dispatch.ts:332` giao `deps.projectRoots()` (toàn bộ root của node) cho mọi task. #137 đã chặn
  root rỗng và root không thuộc node, nhưng chưa có resource riêng của task.
- `apps/worker` chạy một Pi session trong process con (`worker-process.ts`, stdio không có IPC). Worker chỉ có
  `read_project_file`, `list_project_files`, `write_project_file`. Không có đường chạy lệnh nào.
- `packs/project-work/src/worktree.ts` có sẵn identity, kiểm tra HEAD/common-dir, từ chối cây bẩn. Riêng
  `suggestedWorktreePath` đặt worktree *bên trong* repo của người dùng, nên không dùng hàm này.

## Thiết kế

1. **Provenance.** `packages/contracts` thêm `intentOriginSchema`:
   - `interactive{principalId}`;
   - `persistent{principalId, intentId, triggerSignalId, allowedCategories}`;
   - `delegated{principalId, peerNodeId, delegationId}`;
   - `system{reason}`.

   `TaskRecord` thêm `origin?` và `resources?`. Migration mới thêm hai cột JSON vào `tasks`. Task cũ không có cột
   này thì được đọc là `interactive`, đúng như hành vi hiện nay.
2. **Policy.** `ExecutionQuestion.explicitUserIntent` được thay bằng `intent: ExecutionIntent`:
   - `interactive` và `delegated` là ý định rõ ràng;
   - `persistent` chỉ rõ ràng với các category có trong `allowedCategories`; category rủi ro nằm ngoài danh sách
     thì hỏi, với lý do "ngoài phạm vi đã giao cho automation";
   - `system` không phải ý định của người dùng.

   Mọi call site và test được đổi sang trường mới, không để lại song song hai trường.
3. **Resource theo task.** `taskResourceSchema` có hai dạng:
   - `{kind:"folder", path, access:"read"|"write"}`;
   - `{kind:"repository", path}` (không có `access`: repository luôn được làm việc trong worktree riêng của task, nên luôn ghi được ở đó và không bao giờ ghi vào cây của người dùng).

   Dispatcher dựng root cho worker như sau:
   - task có `resources` thì chỉ dùng các resource đó; mỗi resource vẫn phải nằm trong vùng node sở hữu;
   - `repository` chạy trong worktree node quản lý:
     - kiểm tra identity bằng `readRepoIdentity`;
     - tạo `git worktree add -b clarkcant/task-<id> <dataDir>/worktrees/<taskId> HEAD`;
     - worker chỉ nhận đúng worktree đó;
   - task không có resource mà origin là `interactive` thì giữ hành vi cũ (root của node);
   - origin khác mà không nêu resource thì bị từ chối trước khi worker khởi động.
4. **Lệnh qua broker.**
   - `worker-process.ts` mở thêm kênh `ipc`.
   - Worker đăng ký tool `run_command` (capability `project.command.run@1`, khai báo trong `packs/project-work`),
     tool này gửi yêu cầu lên host.
   - Host xử lý bằng `createWorkerCommandBroker`, dùng lại đúng các bước của run_command:
     - `preflightCommand` với resource chỉ gồm root của task;
     - `decideExecution` với intent lấy từ origin của task;
     - `decideGuardrailForCommand` (Jev);
     - `runCommand`;
     - audit và effect ledger.
   - Nếu policy trả `ask`, lệnh không chạy. Worker nhận câu trả lời nói rõ điều đó, và evidence ghi lại.
   - Stop task thì dừng cả lệnh host đang chạy cho task đó.
   - Không có `bash` thô trong worker.

## File

- `packages/contracts/src/task.ts` (hoặc nơi `TaskRecord` sống), `index.ts`
- `packages/storage/src/migrate.ts`, repository task
- `packages/core/src/execution-policy.ts`, `task-service.ts`, cùng các test policy
- `apps/runtime/src/task-dispatch.ts`, `worker-process.ts`, `worker-command-broker.ts` (mới),
  `bootstrap/runtime-bootstrap.ts`, `node-tools.ts`
- `apps/worker/src/tools.ts`, `main.ts`
- `packs/project-work/src/index.ts`, `managed-worktree.ts` (mới)

## Kiểm chứng

- Policy: bảng quyết định cho bốn loại origin trong ba chế độ; persistent ngoài phạm vi thì hỏi.
- Dispatch:
  - task persistent không có resource thì bị từ chối, và worker không khởi động;
  - task có resource `folder` thì worker chỉ nhận đúng folder đó;
  - task có resource `repository` thì worker nhận worktree mới, còn cây của người dùng không đổi.
- Broker:
  - lệnh ngoài root của task bị từ chối;
  - `ask` thì không chạy;
  - lệnh được phép thì chạy và có audit;
  - Stop task thì dừng lệnh đang chạy;
  - worker process thật (fake adapter, script) gọi `run_command` qua IPC.
- `pnpm verify`, `pnpm invariants`.

## Kết quả

- Test: `worker-command-broker.spec.ts` (11), `task-dispatch-scoped.spec.ts` (7, gồm worker process thật gọi `run_command` qua IPC và commit trên nhánh của task), `managed-worktree.spec.ts` (6), `execution-policy.spec.ts` (bảng intent), `worker.spec.ts` (tool `run_command`).
- Lệnh thoát khác 0 là tool call thất bại, không phải evidence.
- Chưa làm: lượt dọn worktree sót lại lúc boot. Worktree được đặt tên theo task và được dùng lại khi task chạy lại, nên chuyển sang phase 04 (hành trình code) nơi task sống qua restart.

## Rủi ro

- IPC trên Windows: dùng `stdio: [..., "ipc"]` của Node, được hỗ trợ trên cả ba OS.
- Worktree còn sót lại khi crash: được đặt trong `dataDir/worktrees`, có tên theo task, và được dọn khi task kết thúc
  hoặc bằng lượt dọn lúc boot.

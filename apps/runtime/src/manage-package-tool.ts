import { type TurnOrigin, nowInstant } from "@clarkcant/contracts";
import { listInstalledPackages, listRestorablePackages } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { listPendingCapabilityApprovals, type PackageInstallDeps } from "./application/package-install.ts";
import { changePackageAndConnection } from "./application/package-change.ts";
import {
  type PackageInstructionsDeps,
  type PackageInstructionsRequestOutcome,
  packageInstructionsStatus,
  requestPackageInstructions,
} from "./application/package-instructions.ts";
import type { PackageChange, PackageChangeOutcome } from "./application/package-lifecycle.ts";
import type { PackageConnectionBroker } from "./package-connections.ts";

/**
 * Uninstalling, restoring and rolling back a package from the conversation.
 *
 * The same `changePackage` the Settings buttons call, so "gỡ bảng việc đi" said or typed and a click on **Gỡ** are one
 * action with one answer and one audit record — the only difference is `source`, which is what lets a mode that asks
 * every time tell a sentence from a click. `list` is there so the model can name a package by the id the node knows
 * rather than guess one from what the person said.
 *
 * `enable_instructions` and `disable_instructions` turn a package's conditional instructions on or off for one project,
 * the same preference Settings shows. Whether Clark's request runs, becomes the host's approval card, or is refused is
 * the execution policy's decision; the package itself has no say.
 */

export interface ManagePackageToolDeps {
  packages: PackageInstallDeps;
  /** Told when a package is uninstalled, so the account it was connected to goes with it, as from Settings. */
  connections?: Pick<PackageConnectionBroker, "forget"> | undefined;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
  /** Who asked for the turn, read at call time like `channel`, and handed to the execution policy. Absent is the person. */
  origin?: () => TurnOrigin | undefined;
  /** Where package instructions are read and turned on or off; absent, the instruction actions are not offered. */
  instructions?: () => PackageInstructionsDeps;
}

const ACTIONS = ["list", "uninstall", "restore", "rollback", "enable_instructions", "disable_instructions"] as const;

/** What the model is told about a package instructions change. Never a claim beyond what the node did. */
export function describePackageInstructionsOutcome(outcome: PackageInstructionsRequestOutcome): string {
  switch (outcome.kind) {
    case "done":
      return `${outcome.receipt}. Người dùng tắt lại được trong Cài đặt → Tiện ích & widget.`;
    case "approval-required":
      return (
        `Đã gửi thẻ duyệt: ${outcome.approval.operationDescription}. Chưa có gì thay đổi — người dùng phải bấm duyệt trên ` +
        "thẻ, và tui không thể tự duyệt. Đừng nói là đã xong."
      );
    case "refused":
      return `Chưa thay đổi gì: ${outcome.message} (${outcome.code}).`;
  }
}

function describeInstructions(deps: PackageInstructionsDeps): string {
  const statuses = packageInstructionsStatus(deps);
  if (statuses.length === 0) return "";
  return `Gói có hướng dẫn dự án: ${statuses
    .map((entry) => {
      const where = entry.projects.length === 0 ? "chưa bật cho dự án nào" : `đang bật cho ${entry.projects.join(", ")}`;
      const broken = entry.problems.length === 0 ? "" : `; lỗi: ${entry.problems.join("; ")}`;
      return `${entry.packageId} (${entry.name} ${entry.version}) ${where}${broken}`;
    })
    .join("; ")}.`;
}

/** What the model is told, in the product's language, for each outcome. Never a claim beyond what the node did. */
export function describePackageChange(outcome: PackageChangeOutcome): string {
  if (outcome.kind === "refused") return `Chưa thay đổi gì: ${outcome.message} (${outcome.code}).`;
  const restart = outcome.restartNeeded ? " Gói có mã native của Pi, nên thay đổi có hiệu lực sau khi khởi động lại Pi." : "";
  const kept = outcome.statesKept === 0 ? "" : ` Dữ liệu của ${String(outcome.statesKept)} widget vẫn được giữ.`;
  switch (outcome.action) {
    case "uninstall":
      return (
        `Đã gỡ ${outcome.packageId} ${outcome.previousVersion ?? ""}. ` +
        `${String(outcome.instancesOffline)} widget chuyển sang ngoại tuyến và hiển thị bản văn bản.${kept} ` +
        `Có thể khôi phục trong Cài đặt → Tiện ích & widget.${restart}`
      );
    case "restore":
      return `Đã khôi phục ${outcome.packageId} ${outcome.activeVersion ?? ""}; ${String(outcome.instancesRestored)} widget hoạt động lại.${kept}${restart}`;
    case "rollback":
      return `Đã quay ${outcome.packageId} về ${outcome.activeVersion ?? ""} (từ ${outcome.previousVersion ?? ""}). Dữ liệu widget giữ nguyên; nếu dữ liệu do bản mới hơn ghi, widget mở ở chế độ chỉ đọc.${restart}`;
  }
}

function describeList(deps: PackageInstallDeps): string {
  const core = {
    db: deps.runtime.db,
    nodeId: deps.runtime.identity.nodeId,
    now: nowInstant,
    newId: deps.conductor.newId,
  };
  const installed = listInstalledPackages(core);
  const restorable = listRestorablePackages(core);
  const approvals = listPendingCapabilityApprovals(deps);
  const lines = [
    installed.length === 0
      ? "Chưa cài gói nào."
      : `Đang cài: ${installed
          .map((entry) => `${entry.packageId} ${entry.version}${entry.previousVersion === undefined ? "" : ` (có thể quay về ${entry.previousVersion})`}`)
          .join("; ")}.`,
    ...(restorable.length === 0
      ? []
      : [`Đã gỡ, có thể khôi phục: ${restorable.map((entry) => `${entry.packageId} ${entry.version}`).join("; ")}.`]),
    // Named so the model can point there; answering them is the person's, in host-owned Settings, never this tool's.
    ...(approvals.length === 0
      ? []
      : [
          `Quyền đang chờ người dùng duyệt trong Cài đặt → Tiện ích & widget (công cụ này không duyệt được): ${approvals
            .map((entry) => `${entry.ref} cho ${entry.packageId} ${entry.version}`)
            .join("; ")}.`,
        ]),
  ];
  return lines.join(" ");
}

export function createManagePackageTool(deps: ManagePackageToolDeps): ToolDefinition {
  return {
    name: "manage_package",
    label: "Quản lý gói tiện ích",
    description:
      "List the widget/extension packages installed on this node, or uninstall, restore or roll back one of them " +
      "when the user asks. Uninstall keeps the widgets' saved data and history and can be undone with restore; " +
      "rollback returns to the version that was active before. Call list first unless you already know the exact " +
      "packageId. The execution policy may require the user to confirm in Settings instead; the result says so. " +
      "enable_instructions turns an installed package's project instructions on for one project folder (an absolute " +
      "path inside a folder the user already granted), and disable_instructions turns them off; only when the user asks. " +
      "Those rules are then stated when work touches that project, after the project's own instructions, and grant " +
      "nothing. The execution policy decides: it may run, put an approval card in the conversation that only the user " +
      "can approve, or be refused; the result says which.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "What to do." },
        packageId: { type: "string", description: "Required for every action except list: the package id from list." },
        project: {
          type: "string",
          description: "For enable_instructions and disable_instructions: the project folder, as an absolute path.",
        },
      },
    },
    promptSnippet: "manage_package — list, uninstall, restore or roll back an installed widget/extension package, or turn its project instructions on or off",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const action = typeof params.action === "string" ? params.action : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { text: `"${action}" không phải hành động hợp lệ; dùng ${ACTIONS.join(", ")}.` };
      }
      const instructions = deps.instructions?.();
      if (action === "list") {
        const list = describeList(deps.packages);
        const extra = instructions === undefined ? "" : describeInstructions(instructions);
        return { text: extra === "" ? list : `${list} ${extra}` };
      }
      const packageId = typeof params.packageId === "string" ? params.packageId.trim() : "";
      if (packageId === "") return { text: "Cần packageId; gọi action list để lấy đúng id." };
      const origin = deps.origin?.();
      if (action === "enable_instructions" || action === "disable_instructions") {
        if (instructions === undefined) return { text: "Node này không bật hướng dẫn từ gói." };
        const project = typeof params.project === "string" ? params.project.trim() : "";
        if (project === "") return { text: "Cần project: đường dẫn tuyệt đối của thư mục dự án." };
        const outcome = requestPackageInstructions(instructions, {
          packageId,
          project,
          enabled: action === "enable_instructions",
          source: deps.channel() === "voice" ? "voice" : "agent",
          ...(origin === undefined ? {} : { origin }),
          ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
        });
        return {
          text: describePackageInstructionsOutcome(outcome),
          ...(outcome.kind === "approval-required" ? { hostCard: outcome.card } : {}),
        };
      }
      const outcome = await changePackageAndConnection(deps.packages, deps.connections, {
        ...(origin === undefined ? {} : { origin }),
        action: action as PackageChange,
        packageId,
        source: deps.channel() === "voice" ? "voice" : "agent",
        ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
      });
      return { text: describePackageChange(outcome) };
    },
  };
}

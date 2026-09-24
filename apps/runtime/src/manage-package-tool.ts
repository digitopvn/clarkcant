import { nowInstant } from "@clarkcant/contracts";
import { listInstalledPackages, listRestorablePackages } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import type { PackageInstallDeps } from "./application/package-install.ts";
import { changePackage, type PackageChange, type PackageChangeOutcome } from "./application/package-lifecycle.ts";

/**
 * Uninstalling, restoring and rolling back a package from the conversation.
 *
 * The same `changePackage` the Settings buttons call, so "gỡ bảng việc đi" said or typed and a click on **Gỡ** are one
 * action with one answer and one audit record — the only difference is `source`, which is what lets a mode that asks
 * every time tell a sentence from a click. `list` is there so the model can name a package by the id the node knows
 * rather than guess one from what the person said.
 */

export interface ManagePackageToolDeps {
  packages: PackageInstallDeps;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
}

const ACTIONS = ["list", "uninstall", "restore", "rollback"] as const;

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
  const lines = [
    installed.length === 0
      ? "Chưa cài gói nào."
      : `Đang cài: ${installed
          .map((entry) => `${entry.packageId} ${entry.version}${entry.previousVersion === undefined ? "" : ` (có thể quay về ${entry.previousVersion})`}`)
          .join("; ")}.`,
    ...(restorable.length === 0
      ? []
      : [`Đã gỡ, có thể khôi phục: ${restorable.map((entry) => `${entry.packageId} ${entry.version}`).join("; ")}.`]),
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
      "packageId. The execution policy may require the user to confirm in Settings instead; the result says so.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "What to do." },
        packageId: { type: "string", description: "Required for every action except list: the package id from list." },
      },
    },
    promptSnippet: "manage_package — list, uninstall, restore or roll back an installed widget/extension package",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const action = typeof params.action === "string" ? params.action : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { text: `"${action}" không phải hành động hợp lệ; dùng list, uninstall, restore hoặc rollback.` };
      }
      if (action === "list") return { text: describeList(deps.packages) };
      const packageId = typeof params.packageId === "string" ? params.packageId.trim() : "";
      if (packageId === "") return { text: "Cần packageId; gọi action list để lấy đúng id." };
      const outcome = changePackage(deps.packages, {
        action: action as PackageChange,
        packageId,
        source: deps.channel() === "voice" ? "voice" : "agent",
        ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId }),
      });
      return { text: describePackageChange(outcome) };
    },
  };
}

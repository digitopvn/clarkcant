import { getCapability } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import {
  type CapabilityInvokeDeps,
  type CapabilityInvokeOutcome,
  invokeCapability,
} from "./application/capability-invoke.ts";

/**
 * Calling an installed package's service capability from the conversation.
 *
 * The same `invokeCapability` a widget button and a spoken command reach, so "thêm ghi chú mua sữa" typed to the agent
 * and a click on the notes widget's **Thêm** are one action with one answer: the registry, the capability's own input
 * schema and the execution policy decide both. `list` is there so the model names a capability by the ref the node
 * registered rather than one guessed from what the person said, and sees why one that is off is off.
 */

export interface InvokeCapabilityToolDeps {
  /** Read at call time: the service host is assigned after the tool list is built, and services come and go. */
  deps: () => CapabilityInvokeDeps;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
}

const ACTIONS = ["list", "invoke"] as const;

function describeList(deps: CapabilityInvokeDeps): string {
  const services = deps.serviceHost?.status() ?? [];
  const lines: string[] = [];
  for (const service of services) {
    for (const ref of service.refs) {
      const descriptor = getCapability({ db: deps.db, nodeId: deps.nodeId }, ref, deps.nodeId);
      if (descriptor === undefined) {
        lines.push(`- ${ref} (${service.packageId}): chưa đăng ký — ${service.reason ?? "service đang khởi động"}`);
        continue;
      }
      const { readiness } = descriptor;
      const usable = readiness.installed && readiness.loaded && readiness.authorized && readiness.healthy;
      const schema = descriptor.inputSchema === undefined ? "" : ` input: ${JSON.stringify(descriptor.inputSchema).slice(0, 400)}`;
      lines.push(
        `- ${ref} — ${descriptor.summary} [${descriptor.effectCategory}] ` +
          (usable ? `sẵn sàng.${schema}` : `không dùng được: ${readiness.blockedReason ?? "service chưa sẵn sàng"}`),
      );
    }
  }
  return lines.length === 0
    ? "Node này chưa có capability nào do service của gói đã cài cung cấp."
    : `Capability do service của các gói đã cài cung cấp:\n${lines.join("\n")}`;
}

/** What the model is told for each outcome. Never a claim beyond what the node did. */
export function describeCapabilityOutcome(outcome: CapabilityInvokeOutcome): string {
  switch (outcome.kind) {
    case "done":
      return `Đã gọi ${outcome.ref}. Kết quả thật từ service:\n${outcome.output}`;
    case "approval-required":
      return (
        `Đã gửi yêu cầu duyệt để gọi ${outcome.card.operationDescription}. Chưa có gì chạy — người dùng phải bấm ` +
        `duyệt trên thẻ, và tui không thể tự duyệt. Đừng nói là đã xong.`
      );
    case "refused":
      return `Không gọi được: ${outcome.message} (${outcome.code}). Không có gì được chạy.`;
  }
}

export function createInvokeCapabilityTool(input: InvokeCapabilityToolDeps): ToolDefinition {
  return {
    name: "invoke_capability",
    label: "Gọi capability của gói",
    description:
      "Call a capability that an installed widget/extension package's service provides on this node, such as adding " +
      "a note to a notes package. Call list first unless you already know the exact ref; it shows each capability's " +
      "input schema and whether it can run now. The execution policy may put an approval card in the conversation " +
      "instead of running it; the result says so, and you cannot approve it yourself.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "list, or invoke one capability." },
        ref: { type: "string", description: "Required for invoke: the capability ref from list." },
        args: { type: "object", description: "For invoke: the input, matching the capability's input schema." },
      },
    },
    promptSnippet: "invoke_capability — list or call capabilities that installed packages' services provide",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const action = typeof params.action === "string" ? params.action : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { text: `"${action}" không phải hành động hợp lệ; dùng list hoặc invoke.` };
      }
      const deps = input.deps();
      if (action === "list") return { text: describeList(deps) };
      const ref = typeof params.ref === "string" ? params.ref.trim() : "";
      if (ref === "") return { text: "Cần ref; gọi action list để lấy đúng ref." };
      const args =
        params.args !== null && typeof params.args === "object" && !Array.isArray(params.args)
          ? (params.args as Record<string, unknown>)
          : {};
      const outcome = await invokeCapability(deps, {
        ref,
        args,
        source: input.channel() === "voice" ? "voice" : "agent",
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      return {
        text: describeCapabilityOutcome(outcome),
        ...(outcome.kind === "approval-required" ? { hostCard: outcome.card as unknown as Record<string, unknown> } : {}),
      };
    },
  };
}

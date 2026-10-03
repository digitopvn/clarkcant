import { getCapability } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import {
  type CapabilityInvokeDeps,
  type CapabilityInvokeOutcome,
  invokeCapability,
} from "./application/capability-invoke.ts";
import {
  type CapabilityBindingTarget,
  type WidgetActionServices,
  conversationCapabilityBindings,
} from "./application/widget-actions.ts";
import { pressWidgetBinding } from "./widget-perform-tool.ts";

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
  /**
   * The node's widget-action services, read at call time. A long-running (job) capability is started through one of
   * this conversation's widget bindings to it, which is what follows the job; without these, such a call is refused.
   */
  widgets?: () => WidgetActionServices;
}

const ACTIONS = ["list", "invoke"] as const;

/**
 * Start a job capability by pressing a widget binding to it in this conversation.
 *
 * A package job belongs to the widget binding that started it: that widget shows its progress and result, and only it
 * may read or stop it. So Clark does not start an orphan job; it presses the binding, through the same gate, input
 * check, rate limit, policy and ledger a click goes through. When more than one binding could take it — on several
 * widgets, or several buttons of one widget — the model is asked to name one by `instanceId` and `actionBindingId`
 * rather than the node guessing.
 */
const LISTED_TARGETS = 10;

function listTargets(targets: readonly CapabilityBindingTarget[]): string {
  return targets
    .slice(0, LISTED_TARGETS)
    .map((target) => `- instanceId ${target.instanceId}, actionBindingId ${target.actionBindingId}: nút “${target.label}”`)
    .join("\n");
}

async function startJobThroughWidget(
  services: WidgetActionServices,
  call: {
    conversationId: string;
    ref: string;
    args: Record<string, unknown>;
    instanceId?: string;
    actionBindingId?: string;
    source: "voice" | "agent";
  },
): Promise<string> {
  const all = conversationCapabilityBindings(services, call.conversationId, call.ref);
  const targets = all.filter(
    (target) =>
      (call.instanceId === undefined || target.instanceId === call.instanceId) &&
      (call.actionBindingId === undefined || target.actionBindingId === call.actionBindingId),
  );
  if (targets.length === 0) {
    if (all.length === 0) {
      return `Không gọi được: ${call.ref} là việc chạy lâu và phải được bắt đầu từ một widget có nút gọi nó, mà cuộc trò chuyện này chưa có widget nào như vậy. Không có gì được chạy.`;
    }
    const named = [
      ...(call.instanceId === undefined ? [] : [`instanceId ${call.instanceId}`]),
      ...(call.actionBindingId === undefined ? [] : [`actionBindingId ${call.actionBindingId}`]),
    ].join(", ");
    return `Không gọi được: không có nút nào gọi ${call.ref} khớp ${named} trong cuộc trò chuyện này. Các nút có:\n${listTargets(all)}\nKhông có gì được chạy.`;
  }
  if (targets.length > 1) {
    return `Có nhiều nút gọi được ${call.ref}; gọi lại với instanceId và actionBindingId của nút người dùng muốn:\n${listTargets(targets)}\nChưa có gì được chạy.`;
  }
  const [target] = targets as [CapabilityBindingTarget];
  // The same dispatch `perform_widget_action` uses: the node's own cursor, a fresh invocation, Clark as the source.
  const pressed = await pressWidgetBinding(services, {
    conversationId: call.conversationId,
    instanceId: target.instanceId,
    actionBindingId: target.actionBindingId,
    input: call.args,
    source: call.source,
  });
  if (pressed.kind === "gone") return `Không gọi được: nút “${target.label}” không còn trên widget đó. Không có gì được chạy.`;
  const result = pressed.result;
  if (!result.ok) {
    const mayHaveRun = result.detail?.outcome === "uncertain";
    return mayHaveRun
      ? `“${target.label}” đã được gửi đi nhưng chưa rõ đã chạy hay chưa: ${result.message} (${result.code}). Đừng gọi lại trước khi người dùng xác nhận.`
      : `Không gọi được qua nút “${target.label}”: ${result.message} (${result.code}). Không có gì được chạy.`;
  }
  if (result.body.outcome === "approval-required") {
    return `Đã gửi yêu cầu duyệt cho “${target.label}”. Chưa có gì chạy — người dùng phải bấm duyệt trên thẻ, và tui không thể tự duyệt. Đừng nói là đã xong.`;
  }
  if (result.body.outcome === "job") {
    const jobId = (result.body.job as { jobId?: string } | undefined)?.jobId ?? "";
    return (
      `Đã bắt đầu job ${jobId} cho ${call.ref} qua nút “${target.label}” của widget ${target.instanceId}. Job mới chỉ bắt đầu, ` +
      "chưa xong: widget đó hiện tiến độ và kết quả, và cuộc trò chuyện sẽ báo khi job kết thúc. Đừng nói là đã có kết quả."
    );
  }
  const output = typeof result.body.output === "string" ? `\n${result.body.output}` : "";
  return `Đã gọi ${call.ref} qua nút “${target.label}”. Kết quả thật từ service:${output}`;
}

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
    case "job":
      return `Đã bắt đầu job ${outcome.job.jobId} cho ${outcome.ref}. Job tiếp tục chạy sau khi lời gọi này trả về; dùng widget đã bắt đầu nó để xem tiến độ.`;
    case "approval-required":
      return (
        `Đã gửi yêu cầu duyệt để gọi ${outcome.card.operationDescription}. Chưa có gì chạy — người dùng phải bấm ` +
        `duyệt trên thẻ, và tui không thể tự duyệt. Đừng nói là đã xong.`
      );
    case "refused":
      // Sent and then failed is not the same as never sent: the service may have done part of it.
      return outcome.sent
        ? `Gọi ${outcome.code === "SERVICE_TOOL_FAILED" ? "bị service báo lỗi" : "không nhận được trả lời"}: ${outcome.message} (${outcome.code}). ` +
            "Yêu cầu đã tới service nên có thể nó đã chạy một phần — kiểm tra lại (ví dụ gọi list) trước khi gọi lại."
        : `Không gọi được: ${outcome.message} (${outcome.code}). Không có gì được chạy.`;
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
      "instead of running it; the result says so, and you cannot approve it yourself. A long-running (job) capability " +
      "starts from a widget in this conversation that offers it, which then shows its progress and result; it has only " +
      "started when this returns.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "list, or invoke one capability." },
        ref: { type: "string", description: "Required for invoke: the capability ref from list." },
        args: { type: "object", description: "For invoke: the input, matching the capability's input schema." },
        instanceId: {
          type: "string",
          description:
            "For invoke of a long-running (job) capability, when several widgets in this conversation can start it: the widget to start it from.",
        },
        actionBindingId: {
          type: "string",
          description:
            "For invoke of a long-running (job) capability, when several buttons can start it (also on one widget): the button to press, by the id the ambiguity answer lists.",
        },
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
      const source = input.channel() === "voice" ? "voice" : "agent";
      const widgets = input.widgets?.();
      if (deps.serviceHost?.execution?.(ref)?.kind === "job" && widgets !== undefined && input.conversationId !== undefined) {
        const named = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
        const instanceId = named(params.instanceId);
        const actionBindingId = named(params.actionBindingId);
        return {
          text: await startJobThroughWidget(widgets, {
            conversationId: input.conversationId,
            ref,
            args,
            source,
            ...(instanceId === undefined ? {} : { instanceId }),
            ...(actionBindingId === undefined ? {} : { actionBindingId }),
          }),
        };
      }
      const outcome = await invokeCapability(deps, {
        ref,
        args,
        source,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      return {
        text: describeCapabilityOutcome(outcome),
        ...(outcome.kind === "approval-required" ? { hostCard: outcome.card as unknown as Record<string, unknown> } : {}),
      };
    },
  };
}

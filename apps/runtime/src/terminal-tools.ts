import { decideExecution, guardrailCovers, recordEffectExecution } from "@clarkcant/core";
import { nowInstant } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { decideGuardrailForCommand, type CommandToolDeps } from "./node-tools.ts";
import { preflightCommand, type CommandEnvelope } from "./preflight.ts";
import { commandDigest } from "./run-command.ts";
import type { TerminalCommandRecord, TerminalInfo, TerminalRegistry } from "./terminal-sessions.ts";

/**
 * The agent's side of the terminal: open one in the conversation, type a command into it, read what it printed.
 *
 * A command the agent types goes through the same gates `run_command` does — the host's preflight, the execution
 * policy, the guardrail — because a keystroke into a shell is exactly as effectful as a child process. What differs
 * is what "ask" means here: the command is **put on the prompt and not run**. The person sees the exact line in
 * their own terminal, and pressing Enter is the confirmation; nothing needs a second approval surface for it.
 *
 * What a person types themselves is theirs and passes through none of this.
 */

/** The card that puts a terminal into the conversation. */
export function terminalCard(
  newId: (prefix: string) => string,
  info: Pick<TerminalInfo, "terminalId" | "title" | "cwd">,
  extra: { prefill?: string; ran?: string },
): Record<string, unknown> {
  return {
    type: "terminal-session-card",
    owner: "host",
    cardId: newId("card"),
    terminalId: info.terminalId,
    title: info.title.slice(0, 300),
    cwd: info.cwd.slice(0, 1000),
    ...(extra.prefill === undefined ? {} : { prefill: extra.prefill.slice(0, 2000) }),
    ...(extra.ran === undefined ? {} : { ran: extra.ran.slice(0, 2000) }),
    createdAt: nowInstant(),
  };
}

/** How much of a command's output the model is handed: the end, where the result is. */
const OUTPUT_FOR_MODEL = 8_000;

export function describeRecord(record: TerminalCommandRecord): string {
  const output = record.output.length > OUTPUT_FOR_MODEL ? record.output.slice(-OUTPUT_FOR_MODEL) : record.output;
  const cut = record.truncated || record.output.length > OUTPUT_FOR_MODEL ? " (chỉ phần cuối)" : "";
  const status =
    record.endedAt === undefined
      ? "đang chạy"
      : record.exitCode === null
        ? "đã xong, shell không báo exit code"
        : `exit ${String(record.exitCode)}`;
  return `$ ${record.command ?? "(không rõ lệnh)"} — ${status}\n\nOutput${cut}:\n${output === "" ? "(không in gì)" : output}`;
}

type Gate =
  | { kind: "refuse"; text: string }
  | { kind: "prefill"; envelope: CommandEnvelope }
  | { kind: "execute"; envelope: CommandEnvelope; record: () => void };

/**
 * Decide what happens to one command the agent wants to type, in the directory the terminal runs in.
 *
 * The same order as `run_command`: the host's preflight first, then the resolver, then the guardrail on anything the
 * switches cover. A guardrail question has no card here — the agent carries it back as text — because the terminal
 * is already a surface the person can act in.
 */
async function gateCommand(
  deps: CommandToolDeps,
  input: { command: string; cwd: string; why: string; conversationId?: string },
): Promise<Gate> {
  const preflight = preflightCommand({
    command: input.command,
    cwd: input.cwd,
    resources: deps.resources(),
    fallbackCwd: deps.fallbackCwd(),
  });
  if (!preflight.ok) return { kind: "refuse", text: preflight.message };
  if (preflight.envelope.kind !== "command") return { kind: "refuse", text: "Chỉ gõ được lệnh shell vào terminal." };
  const policy = deps.autonomy();
  const envelope = preflight.envelope;
  const decision = decideExecution({
    policy,
    action: { kind: "effect", category: envelope.effectCategory, operationDigest: commandDigest(envelope.command, envelope.cwd) },
    // As in `run_command`: the turn exists because the user acted. It lifts nothing a rule or a hard boundary denies.
    explicitUserIntent: true,
  });
  if (decision.kind === "deny") {
    return {
      kind: "refuse",
      text: `Node này không chạy lệnh này: ${decision.reason}. Không có gì được gõ vào terminal. Người dùng đổi lại trong Settings → Control nếu muốn.`,
    };
  }
  let guarded = envelope;
  if (guardrailCovers(policy, envelope)) {
    const judgment = await decideGuardrailForCommand(deps, { policy, envelope, why: input.why });
    if (judgment.kind === "refuse") {
      deps.audit?.({ summary: judgment.text, outcome: "refused" });
      return { kind: "refuse", text: judgment.text };
    }
    if (judgment.kind === "ask") return { kind: "refuse", text: `${judgment.question} Hỏi người dùng rồi đề xuất lại. Chưa có gì được gõ.` };
    guarded = judgment.envelope;
  }
  if (decision.kind === "ask") return { kind: "prefill", envelope: guarded };
  return {
    kind: "execute",
    envelope: guarded,
    record: () => {
      const effectAudit = deps.effectAudit?.();
      if (effectAudit === undefined) return;
      recordEffectExecution(effectAudit.deps, {
        principalId: effectAudit.principalId,
        mode: policy.mode,
        decision,
        category: guarded.effectCategory,
        operationDigest: commandDigest(guarded.command, guarded.cwd),
        ...(effectAudit.conversationId === undefined ? {} : { conversationId: effectAudit.conversationId }),
        description: `terminal: ${guarded.command} — ${guarded.cwd}`,
      });
    },
  };
}

function auditOutcome(record: TerminalCommandRecord): "done" | "failed" {
  return record.exitCode === 0 ? "done" : "failed";
}

export function createTerminalTools(
  input: CommandToolDeps & {
    terminals: TerminalRegistry;
    newCardId: (prefix: string) => string;
    conversationId?: string;
    resolveFolder?: (intent: string) => Promise<
      { status: "resolved"; cwd: string; relPath: string } | { status: "ask"; message: string; options: readonly string[] }
    >;
  },
): ToolDefinition[] {
  const unavailable = async (): Promise<string | undefined> => {
    const availability = await input.terminals.availability();
    return availability.ok ? undefined : `Không mở được terminal trên node này: ${availability.reason}`;
  };

  const open: ToolDefinition = {
    name: "terminal_open",
    label: "Mở terminal",
    description:
      "Open an interactive terminal (a real shell) inside the conversation, in a working directory. The user can type " +
      "in it and use full-screen programs. Optionally put a command on its prompt: with `run: true` it is run when " +
      "this node's execution policy allows it, otherwise it is only prefilled and the user presses Enter. Use this " +
      "when the user wants a terminal, a shell, or to watch/interact with a command; use run_command for a one-shot " +
      "command whose output you only need to read.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "An exact directory, when you know it." },
        where: { type: "string", description: "Where to open it, in your own words; sent to the project finder." },
        title: { type: "string", description: "A short title for the card." },
        command: { type: "string", description: "A command to put on the prompt." },
        run: { type: "boolean", description: "Run `command` instead of only prefilling it. Defaults to false." },
        why: { type: "string", description: "One sentence: what the command is for." },
      },
    },
    promptSnippet: "terminal_open — open a real interactive terminal in the conversation, optionally prefilling or running a command",
    execute: async (params: Record<string, unknown>) => {
      const reason = await unavailable();
      if (reason !== undefined) return { text: reason };
      let cwd = typeof params.cwd === "string" && params.cwd.trim() !== "" ? params.cwd.trim() : undefined;
      const where = typeof params.where === "string" ? params.where.trim() : "";
      if (cwd === undefined && where !== "" && input.resolveFolder !== undefined) {
        const found = await input.resolveFolder(where);
        if (found.status === "ask") {
          const options = found.options.length === 0 ? "" : ` Có thể là: ${found.options.join(", ")}.`;
          return { text: `${found.message}${options} Hỏi người dùng muốn mở ở đâu rồi gọi lại.` };
        }
        cwd = found.cwd;
      }
      cwd ??= input.fallbackCwd();
      const command = typeof params.command === "string" ? params.command.replace(/[\r\n]+/gu, " ").trim() : "";
      const why = typeof params.why === "string" ? params.why.trim() : "";
      const wantsRun = params.run === true && command !== "";

      let gate: Exclude<Gate, { kind: "refuse" }> | undefined;
      if (command !== "") {
        const decided = await gateCommand(input, { command, cwd, why });
        if (decided.kind === "refuse") return { text: decided.text };
        gate = decided;
        cwd = decided.envelope.cwd;
      }

      const title = typeof params.title === "string" && params.title.trim() !== "" ? params.title.trim() : undefined;
      const opened = await input.terminals.open({
        cwd,
        ...(title === undefined ? {} : { title }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      if (!opened.ok) return { text: `Không mở được terminal: ${opened.reason}` };
      const info = opened.info;

      if (gate === undefined) {
        return {
          text: `Đã mở terminal ${info.terminalId} (${info.shell}) trong ${info.cwd}. Người dùng thấy nó trong hội thoại và có thể gõ ngay.`,
          hostBlocks: [terminalCard(input.newCardId, info, {})],
        };
      }

      if (!wantsRun || gate.kind === "prefill") {
        // Prefill waits for the first prompt, so the line lands on the prompt rather than in the rc file's output.
        await input.terminals.ready(info.terminalId);
        const filled = input.terminals.prefill(info.terminalId, gate.envelope.command);
        const policyNote =
          wantsRun && gate.kind === "prefill"
            ? " Chính sách thực thi của node yêu cầu người dùng xác nhận, nên lệnh chỉ được điền sẵn: người dùng nhấn Enter để chạy. Đừng nói là đã chạy."
            : " Lệnh chỉ được điền sẵn, chưa chạy: người dùng nhấn Enter nếu muốn chạy.";
        return {
          text: filled.ok
            ? `Đã mở terminal ${info.terminalId} trong ${info.cwd} và điền sẵn \`${gate.envelope.command}\`.${policyNote}`
            : `Đã mở terminal ${info.terminalId} trong ${info.cwd} nhưng không điền sẵn được lệnh: ${filled.reason}`,
          hostBlocks: [terminalCard(input.newCardId, info, filled.ok ? { prefill: gate.envelope.command } : {})],
        };
      }

      gate.record();
      const result = await input.terminals.run(info.terminalId, gate.envelope.command, { waitMs: 30_000 });
      const card = terminalCard(input.newCardId, info, { ran: gate.envelope.command });
      if (result.status === "finished") {
        input.audit?.({ summary: `terminal: ${gate.envelope.command}`, outcome: auditOutcome(result.record), ref: info.terminalId });
        return { text: `Đã mở terminal ${info.terminalId} trong ${info.cwd} và chạy lệnh.\n\n${describeRecord(result.record)}`, hostBlocks: [card] };
      }
      if (result.status === "running") {
        return {
          text:
            `Đã mở terminal ${info.terminalId} trong ${info.cwd} và lệnh vẫn đang chạy sau 30 giây. Người dùng xem trực tiếp trong thẻ; ` +
            `gọi terminal_read để xem kết quả sau.\n\n${describeRecord(result.record)}`,
          hostBlocks: [card],
        };
      }
      return { text: `Đã mở terminal ${info.terminalId} nhưng không chạy được lệnh (terminal ${result.status === "busy" ? "đang bận" : "đã đóng"}).`, hostBlocks: [card] };
    },
  };

  const run: ToolDefinition = {
    name: "terminal_run",
    label: "Chạy lệnh trong terminal",
    description:
      "Type a command into an open terminal and press Enter, then wait for it to finish (up to `waitSeconds`) and " +
      "return its output and exit code. Whether it runs or is only prefilled for the user depends on this node's " +
      "execution policy, and the result says which. Refused while another command is running in that terminal. For " +
      "a full-screen program, prefer terminal_open with a prefilled command and let the user drive it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["terminalId", "command"],
      properties: {
        terminalId: { type: "string" },
        command: { type: "string", description: "One command line." },
        why: { type: "string" },
        waitSeconds: { type: "number", description: "How long to wait for it to finish. Default 30, max 120." },
      },
    },
    promptSnippet: "terminal_run — run one command in an open terminal and read its output",
    execute: async (params: Record<string, unknown>) => {
      const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
      const info = input.terminals.get(terminalId);
      if (info === undefined || info.status !== "running") return { text: `Không có terminal ${terminalId} đang chạy. Gọi terminal_read để xem danh sách.` };
      const command = typeof params.command === "string" ? params.command.replace(/[\r\n]+/gu, " ").trim() : "";
      if (command === "") return { text: "Cần một lệnh để chạy." };
      if (info.running !== null) {
        return { text: `Terminal ${terminalId} đang chạy \`${info.running.command ?? "một lệnh"}\`. Chờ nó xong (terminal_read) rồi chạy lệnh mới.` };
      }
      const why = typeof params.why === "string" ? params.why.trim() : "";
      const gate = await gateCommand(input, { command, cwd: info.cwd, why });
      if (gate.kind === "refuse") return { text: gate.text };
      if (gate.envelope.cwd !== info.cwd) {
        return { text: `Guardrail yêu cầu chạy trong ${gate.envelope.cwd}, khác thư mục của terminal này. Không có gì được gõ; dùng run_command hoặc mở terminal ở đó.` };
      }
      if (gate.kind === "prefill") {
        const filled = input.terminals.prefill(terminalId, gate.envelope.command);
        return {
          text: filled.ok
            ? `Chính sách thực thi của node yêu cầu người dùng xác nhận, nên \`${gate.envelope.command}\` chỉ được điền sẵn trong terminal ${terminalId}. Người dùng nhấn Enter để chạy. Đừng nói là đã chạy.`
            : `Không điền sẵn được: ${filled.reason}`,
        };
      }
      gate.record();
      const waitSeconds = typeof params.waitSeconds === "number" ? Math.max(1, Math.min(120, params.waitSeconds)) : 30;
      const result = await input.terminals.run(terminalId, gate.envelope.command, { waitMs: waitSeconds * 1000 });
      if (result.status === "finished") {
        input.audit?.({ summary: `terminal: ${gate.envelope.command}`, outcome: auditOutcome(result.record), ref: terminalId });
        return { text: describeRecord(result.record) };
      }
      if (result.status === "running") {
        return { text: `Lệnh vẫn đang chạy sau ${String(waitSeconds)} giây; gọi terminal_read để xem tiếp.\n\n${describeRecord(result.record)}` };
      }
      if (result.status === "busy") return { text: `Terminal đang chạy \`${result.running.command ?? "một lệnh"}\`. Không có gì được gõ.` };
      return { text: "Terminal đã đóng. Không có gì được gõ." };
    },
  };

  const read: ToolDefinition = {
    name: "terminal_read",
    label: "Xem terminal",
    description:
      "Without `terminalId`: list the terminals on this node, with what each is running. With `terminalId`: the last " +
      "commands run in it (typed by the user or by you), their exit codes and output. Read-only.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { terminalId: { type: "string" } },
    },
    promptSnippet: "terminal_read — list terminals, or read the recent commands and output of one",
    execute: async (params: Record<string, unknown>) => {
      const terminalId = typeof params.terminalId === "string" ? params.terminalId : "";
      if (terminalId === "") {
        const reason = await unavailable();
        const list = input.terminals.list();
        if (list.length === 0) return { text: reason ?? "Chưa có terminal nào." };
        return {
          text: list
            .map(
              (info) =>
                `${info.terminalId} — ${info.title} — ${info.cwd} — ${info.status === "exited" ? `đã kết thúc (exit ${String(info.exitCode)})` : info.running === null ? "ở prompt" : `đang chạy: ${info.running.command ?? "(không rõ lệnh)"}`}`,
            )
            .join("\n"),
        };
      }
      const info = input.terminals.get(terminalId);
      if (info === undefined) return { text: `Không có terminal ${terminalId}.` };
      const records = input.terminals.commands(terminalId).slice(-5);
      const header = `${info.terminalId} — ${info.cwd} — ${info.status === "exited" ? "đã kết thúc" : "đang chạy"}${info.integration === "none" ? " — shell này không báo điểm bắt đầu/kết thúc lệnh, nên exit code không có" : ""}`;
      if (records.length === 0) return { text: `${header}\nChưa có lệnh nào được chạy.` };
      return { text: [header, ...records.map(describeRecord)].join("\n\n---\n\n") };
    },
  };

  return [open, run, read];
}

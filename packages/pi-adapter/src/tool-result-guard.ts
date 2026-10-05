import type { ToolDefinition, ToolResultGuard } from "./types.ts";

/**
 * A tool whose result, and whose failure's message, passes the host's guard before the model reads it.
 *
 * One wrapper for every tool a session is handed — the host's, and the scoped filesystem tools the adapter binds itself —
 * so there is a single path from a tool to the model, and it is the one the guard sits on. The tool still runs; only what
 * the model is sent of it changes. A withheld result is replaced whole: its image, and anything else it carried for the
 * model, goes with it.
 */
export function guardToolResult(tool: ToolDefinition, guard: ToolResultGuard | undefined): ToolDefinition {
  if (guard === undefined) return tool;
  return {
    ...tool,
    execute: async (params: Record<string, unknown>) => {
      let result: Awaited<ReturnType<ToolDefinition["execute"]>>;
      try {
        result = await tool.execute(params);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const decision = guard({ tool: tool.name, text: message });
        // A failure's message reaches the model as the call's result, so it is held to the same guard.
        throw decision.withheld ? new Error(decision.text) : cause;
      }
      const decision = guard({ tool: tool.name, text: result.text });
      return decision.withheld ? { text: decision.text } : result;
    },
  };
}

import type { ToolDefinition, ToolResultGuard } from "./types.ts";

/**
 * A tool whose result, and whose failure's message, passes the host's guard before the model reads it.
 *
 * One wrapper for every tool a session is handed — the host's, and the scoped filesystem tools the adapter binds itself —
 * so there is a single path from a tool to the model, and it is the one the guard sits on. The tool still runs; only what
 * the model is sent of it changes. A withheld result is replaced whole: its image, its structured value, and anything
 * else it carried for the model, goes with it.
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
      let structured: string | undefined;
      if (result.structuredContent !== undefined) {
        try {
          structured = JSON.stringify(result.structuredContent);
        } catch {
          // A value that cannot be written as JSON cannot be classified either, so it is not passed on.
          const { structuredContent: _unclassifiable, ...rest } = result;
          result = rest;
        }
      }
      // The structured value is classified with the text, as one string, so it can never pass where the text alone would.
      const decision = guard({ tool: tool.name, text: structured === undefined ? result.text : `${result.text}\n${structured}` });
      return decision.withheld ? { text: decision.text } : result;
    },
  };
}

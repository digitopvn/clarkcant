/**
 * Whether a piece of machine-discovered text may be loaded into a session: `source` names where it came from (a file
 * path, or a kind and a name) and `text` is what would reach the model. `false` leaves it out.
 */
export type ContextGuard = (input: { source: string; text: string }) => boolean;

/** The loader options this module fills in; the SDK's own types are wider, and only these members are touched. */
export interface ContextGuardOverrides {
  agentsFilesOverride: (base: { agentsFiles: { path: string; content: string }[] }) => {
    agentsFiles: { path: string; content: string }[];
  };
  systemPromptOverride: (base: string | undefined) => string | undefined;
  appendSystemPromptOverride: (base: string[]) => string[];
  skillsOverride: <T extends { skills: { name: string; description: string }[] }>(base: T) => T;
  promptsOverride: <T extends { prompts: { name: string; description: string; content: string }[] }>(base: T) => T;
}

/**
 * The resource loader's overrides, each holding what the SDK discovered on the machine to the host's guard before a
 * session's system prompt (or a prompt template a message expands) is built from it.
 *
 * Context files (`AGENTS.md`, `CLAUDE.md`), a `SYSTEM.md` or `APPEND_SYSTEM.md`, a skill's name and description and a
 * prompt template's text are all sent to the model, and none of them is part of a message the host checked: this is
 * where they are checked. Whatever fails is left out whole — a replaced `SYSTEM.md` falls back to the SDK's own prompt —
 * and the rest loads as it would have.
 */
export function contextGuardOverrides(guard: ContextGuard): ContextGuardOverrides {
  const allowed = (source: string, text: string): boolean => {
    try {
      return guard({ source, text });
    } catch {
      // A guard that cannot decide does not let the text through.
      return false;
    }
  };
  return {
    agentsFilesOverride: (base) => ({
      agentsFiles: base.agentsFiles.filter((file) => allowed(file.path, file.content)),
    }),
    systemPromptOverride: (base) => (base === undefined || allowed("system-prompt", base) ? base : undefined),
    appendSystemPromptOverride: (base) => base.filter((text) => allowed("append-system-prompt", text)),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => allowed(`skill:${skill.name}`, `${skill.name}\n${skill.description}`)),
    }),
    promptsOverride: (base) => ({
      ...base,
      prompts: base.prompts.filter((prompt) =>
        allowed(`prompt:${prompt.name}`, `${prompt.name}\n${prompt.description}\n${prompt.content}`),
      ),
    }),
  };
}

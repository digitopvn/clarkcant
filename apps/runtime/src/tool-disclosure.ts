import { type DecideDeps, decideToolFamily } from "./jev-decider.ts";

/**
 * Progressive tool disclosure: which of the conversation's tools a turn is offered.
 *
 * Off by default. Every tool's schema is part of the system prompt, so fewer tools is fewer tokens per turn — but a
 * changed tool set is a changed prompt prefix, and the provider's prompt cache is keyed on that prefix. A per-turn
 * tool set that narrows and widens freely pays a cache write on almost every turn, which can cost more than the
 * schemas it saved. So within one session the set only grows: it starts with what the first message needs and adds a
 * family when a later message needs it. A fresh session starts narrow again. `context-economics.spec.ts` measures
 * this against offering everything.
 *
 * Narrowing never touches authority. The adapter only activates tools the session was created with, so nothing here
 * can offer a tool the conversation did not already have.
 */

export type ToolDisclosureMode = "all" | "progressive";

/** `progressive` only when asked for by exactly that name; a typo must not change what the model is offered. */
export function toolDisclosureFromEnv(env: NodeJS.ProcessEnv = process.env): ToolDisclosureMode {
  return env.CLARKCANT_TOOL_DISCLOSURE?.trim().toLowerCase() === "progressive" ? "progressive" : "all";
}

/**
 * Tools every turn keeps: asking the person, remembering, reading history and attachments, and showing a view.
 *
 * These are how a turn recovers from having been offered too little — it can ask, or look back — and showing a view is
 * how Clark answers at all, so none of them is ever narrowed away.
 */
export const CORE_TOOLS: readonly string[] = [
  "ask_user",
  "ask_user_question",
  "request_secret",
  "remember",
  "search_history",
  "read_attachment",
  "show_view",
];

export interface ToolFamily {
  tools: readonly string[];
  /** Words (diacritics folded, lower case) that suggest a message needs this family. */
  hints: readonly string[];
  /** One line for the selector, when it is asked. */
  about: string;
}

/**
 * The families a conversation's tools fall into.
 *
 * Inclusion is cheap and exclusion is a wrong answer, so the hints are generous: a short Vietnamese syllable that is
 * sometimes about something else still switches its family on. A tool in no family is always offered.
 */
export const TOOL_FAMILIES: Readonly<Record<string, ToolFamily>> = {
  projects: {
    tools: ["find_project", "search_files", "search_directory"],
    hints: ["project", "du an", "repo", "repository", "file", "files", "tep", "thu muc", "folder", "directory", "code", "ma nguon", "source"],
    about: "finding a project, files or folders on this machine",
  },
  terminal: {
    tools: ["run_command", "terminal_open", "terminal_run", "terminal_read"],
    hints: [
      "run", "chay", "lenh", "command", "terminal", "shell", "git", "npm", "pnpm", "build", "test", "install", "cai dat",
      "script", "deploy", "log", "logs",
    ],
    about: "running commands and terminals",
  },
  work: {
    tools: ["list_work", "stop_work", "start_browser_task", "find_runtime"],
    hints: [
      "task", "tasks", "viec", "cong viec", "background", "chay nen", "stop", "dung", "huy", "cancel", "browser",
      "trinh duyet", "website", "web", "trang", "runtime", "worker", "dang chay", "running",
    ],
    about: "background work: listing, stopping or starting tasks and browser tasks",
  },
  interface: {
    tools: ["control_app", "inspect_ui", "set_map_tiles"],
    hints: [
      "giao dien", "cai dat", "settings", "setting", "theme", "mo", "open", "man hinh", "screen", "ui", "nut", "button",
      "ban do", "map", "tile", "tiles", "widget", "che do", "dark", "light", "toi", "sang",
    ],
    about: "operating the app itself: settings, theme, screens, widgets on screen, map tiles",
  },
  packages: {
    tools: ["manage_package", "invoke_capability"],
    hints: [
      "package", "packages", "goi", "extension", "marketplace", "capability", "plugin", "skill", "go cai",
      "uninstall", "update", "cap nhat",
    ],
    about: "installing, updating or running packages and their capabilities",
  },
  automation: {
    tools: ["create_automation", "list_automations", "update_automation", "allow_peer_tasks", "list_peers"],
    hints: [
      "automation", "tu dong", "lich", "schedule", "hang ngay", "moi ngay", "hang tuan", "daily", "weekly", "every",
      "nhac", "remind", "peer", "may khac", "thiet bi khac", "cron",
    ],
    about: "scheduled automations and other machines allowed to send tasks",
  },
  inbox: {
    tools: ["read_inbox", "act_on_notice"],
    hints: ["inbox", "thong bao", "notice", "notification", "hop thu", "approval", "duyet", "phe duyet", "cho duyet"],
    about: "the inbox: notices waiting for the person and acting on them",
  },
};

const FAMILY_OF = new Map<string, string>(
  Object.entries(TOOL_FAMILIES).flatMap(([family, entry]) => entry.tools.map((tool) => [tool, family] as const)),
);

/** The family a tool belongs to, or undefined for a tool that is always offered. */
export function familyOf(tool: string): string | undefined {
  return CORE_TOOLS.includes(tool) ? undefined : FAMILY_OF.get(tool);
}

function fold(text: string): string {
  return ` ${text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** The families a message's own words point at, by whole-word match. */
export function hintedFamilies(text: string): Set<string> {
  const folded = fold(text);
  const families = new Set<string>();
  for (const [family, entry] of Object.entries(TOOL_FAMILIES)) {
    if (entry.hints.some((hint) => folded.includes(` ${hint} `))) families.add(family);
  }
  return families;
}

export interface ToolDisclosurePlan {
  /** The names to activate, or undefined to leave the session's tools as they are. */
  active: readonly string[] | undefined;
  families: readonly string[];
  reason: "all" | "hinted" | "selector" | "no-hint" | "unchanged";
}

/**
 * The tools for one turn.
 *
 * `current` is what the session offers now, undefined for everything (a session starts with everything, and a
 * progressive plan narrows it on its first turn). Families used on the last turn stay on, which is also what the
 * grow-only rule implies. When the message hints at nothing, the selector may name one family if an operator opted in;
 * otherwise, and whenever the selector does not decide, the turn is offered everything — a wrong guess there would
 * cost a turn, which is worse than the tokens.
 */
export async function planToolDisclosure(input: {
  mode: ToolDisclosureMode;
  registered: readonly string[];
  current: readonly string[] | undefined;
  text: string;
  usedLastTurn: readonly string[];
  decider?: DecideDeps;
}): Promise<ToolDisclosurePlan> {
  if (input.mode === "all") return { active: undefined, families: [], reason: "all" };

  const families = hintedFamilies(input.text);
  for (const tool of input.usedLastTurn) {
    const family = familyOf(tool);
    if (family !== undefined) families.add(family);
  }
  for (const tool of input.current ?? []) {
    const family = familyOf(tool);
    if (family !== undefined) families.add(family);
  }

  let reason: ToolDisclosurePlan["reason"] = "hinted";
  const present = new Set(input.registered.map(familyOf).filter((family): family is string => family !== undefined));
  if (![...families].some((family) => present.has(family)) && input.current === undefined) {
    // Nothing points anywhere and nothing is narrowed yet: the selector may name a family, else everything stays.
    const offered = Object.fromEntries([...present].map((family) => [family, TOOL_FAMILIES[family]?.about ?? family]));
    const decided =
      input.decider === undefined || present.size < 2
        ? undefined
        : await decideToolFamily(input.decider, { text: input.text, families: offered }).catch(() => undefined);
    if (decided?.status !== "chosen") return { active: [...input.registered], families: [...present], reason: "no-hint" };
    families.add(decided.family);
    reason = "selector";
  }

  const active = input.registered.filter((tool) => {
    const family = familyOf(tool);
    return family === undefined || families.has(family);
  });
  const unchanged =
    input.current !== undefined && active.length === input.current.length && active.every((tool) => input.current?.includes(tool));
  return {
    active: unchanged ? undefined : active,
    families: [...families].filter((family) => present.has(family)).sort(),
    reason: unchanged ? "unchanged" : reason,
  };
}

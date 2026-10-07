import { readdirSync } from "node:fs";

import {
  type ComposerReference,
  type ComposerReferenceSuggestion,
  type ComposerSuggestion,
  type ComposerSuggestionsResponse,
  type ComposerTrigger,
  SKILL_TOKEN_PREFIX,
  SLASH_COMMANDS,
  nowInstant,
  projectRelativePathSchema,
} from "@clarkcant/contracts";
import { type ProjectRecord, getConversation, listConversations, listProjects, messagesSince } from "@clarkcant/storage";

import { type ReferenceServices, insideProject, referenceIdentity } from "./composer-references.ts";
import { SYSTEM_IGNORES, verifyProject } from "./project-finder.ts";
import { textOfMessage } from "./session-search.ts";
import { nodeWork } from "./work-supervisor.ts";
import { preferredAppIntentLocale } from "./app-intents.ts";
import { slashCommandNote } from "./application/slash-commands.ts";

/**
 * What the composer offers after `/` or `@`.
 *
 * Deterministic and local: every row comes from something this node already holds (pi's skills, the project index,
 * the service host, the conversations, the work it is running), ranked by a rule a person can predict. Nothing is
 * searched on the model's behalf and nothing is read beyond one directory listing when a path is being typed.
 *
 * A row is what was true when it was listed. The node checks the reference again when the message is sent
 * (`composer-references.ts`), so a row that went stale while the picker was open is refused by name, not trusted.
 */

/** Rows the picker shows at once: enough to choose from, few enough to read. */
export const COMPOSER_SUGGESTIONS_MAX = 8;

const LABEL_MAX = 120;
/** A conversation named by its first message is named by the start of it: a label, not a transcript. */
const OPENING_LABEL_MAX = 60;
/**
 * The title the clients give a conversation they open, before anything is known about it.
 *
 * Every conversation has it, so as a label it names none of them; the first thing the person said does.
 */
const PLACEHOLDER_TITLES = new Set(["conversation"]);

/** Folded for matching: case, and the diacritics a person may or may not type ("du an" finds "dự án"). */
export function foldForMatch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").replace(/đ/gu, "d").replace(/Đ/gu, "D").toLowerCase();
}

interface Candidate {
  suggestion: ComposerSuggestion;
  /** The words the query is matched against. */
  match: string;
  /** Position in a most-recent-first list, when the source has one. */
  recency?: number;
  /** Which kind of thing it is, in the order kinds are listed; one source's recency says nothing about another's. */
  group?: number;
}

/**
 * Exact, then prefix, then substring; within each, by kind, then the recently used first, then the order the source
 * gave.
 *
 * With no query every candidate is a match, so opening the picker shows recent things rather than nothing, and each
 * kind gets its share of the rows: a node with fifty conversations still offers its projects, and a node with many
 * commands still offers its skills.
 */
export function rankCandidates<T extends { match: string; recency?: number; group?: number }>(
  candidates: readonly T[],
  query: string,
  limit = COMPOSER_SUGGESTIONS_MAX,
): T[] {
  const folded = foldForMatch(query.trim());
  const tiered = candidates.flatMap((candidate, order) => {
    const label = foldForMatch(candidate.match);
    const tier = folded === "" ? 0 : label === folded ? 0 : label.startsWith(folded) ? 1 : label.includes(folded) ? 2 : -1;
    return tier < 0 ? [] : [{ candidate, tier, order }];
  });
  tiered.sort(
    (left, right) =>
      left.tier - right.tier ||
      (left.candidate.group ?? 0) - (right.candidate.group ?? 0) ||
      (left.candidate.recency ?? Number.MAX_SAFE_INTEGER) - (right.candidate.recency ?? Number.MAX_SAFE_INTEGER) ||
      left.order - right.order,
  );
  if (folded !== "") return tiered.slice(0, limit).map((entry) => entry.candidate);

  // Round by round, the next of each kind, until the rows are full; shown grouped, in the order ranked above.
  const kinds = new Map<number, typeof tiered>();
  for (const entry of tiered) {
    const group = entry.candidate.group ?? 0;
    kinds.set(group, [...(kinds.get(group) ?? []), entry]);
  }
  const kept = new Set<(typeof tiered)[number]>();
  for (let round = 0; kept.size < limit; round += 1) {
    const next = [...kinds.values()].flatMap((entries) => {
      const entry = entries[round];
      return entry === undefined ? [] : [entry];
    });
    if (next.length === 0) break;
    for (const entry of next.slice(0, limit - kept.size)) kept.add(entry);
  }
  return tiered.filter((entry) => kept.has(entry)).map((entry) => entry.candidate);
}

/** What a conversation is called in the picker: its title, or the start of what the person first said in it. */
export function conversationLabel(db: ReferenceServices["runtime"]["db"], conversationId: string, title: string | undefined): string {
  const named = clip(title ?? "", LABEL_MAX);
  if (named !== "" && !PLACEHOLDER_TITLES.has(named.toLowerCase())) return named;
  const opening = messagesSince(db, conversationId, 0, 10).find((message) => message.role === "user");
  return opening === undefined ? "" : clip(textOfMessage(opening), OPENING_LABEL_MAX);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function row(ref: ComposerReference, extra: { note?: string | undefined; disabledReason?: string | undefined } = {}): ComposerReferenceSuggestion {
  return {
    key: `${referenceIdentity(ref)}`.slice(0, 300),
    trigger: ref.kind === "skill" ? "/" : "@",
    kind: ref.kind,
    label: ref.label,
    ...(extra.note === undefined || extra.note === "" ? {} : { note: clip(extra.note, 200) }),
    ...(extra.disabledReason === undefined ? {} : { disabledReason: extra.disabledReason }),
    ref,
  };
}

const SKILL_SOURCE: Record<string, string> = { personal: "Cá nhân", project: "Dự án", package: "Gói" };
const PROJECT_KIND: Record<string, string> = { code: "mã nguồn", docs: "tài liệu", media: "media", generic: "thư mục" };
const WORK_STATE: Record<string, string> = {
  queued: "đang chờ",
  running: "đang chạy",
  done: "đã xong",
  failed: "thất bại",
  stopped: "đã dừng",
  interrupted: "bị gián đoạn",
};

export async function composerSuggestions(
  services: ReferenceServices,
  input: { trigger: ComposerTrigger; query: string; conversationId?: string | undefined },
  sources: readonly MentionSource[] = MENTION_SOURCES,
): Promise<ComposerSuggestionsResponse> {
  const suggestions =
    input.trigger === "/"
      ? await skillSuggestions(services, input.query)
      : input.query.includes("/")
        ? pathSuggestions(services, input.query)
        : mentionSuggestions(services, input.query, { currentConversationId: input.conversationId }, sources);
  return { trigger: input.trigger, query: input.query, suggestions };
}

async function skillSuggestions(services: ReferenceServices, query: string): Promise<ComposerSuggestion[]> {
  const skills = services.skills === undefined ? [] : await services.skills.list();
  const locale = preferredAppIntentLocale(
    { db: services.runtime.db, now: () => nowInstant() },
    services.runtime.identity.ownerPrincipalId,
  );
  // The node's own commands first, then pi's skills: a command is answered here, a skill is something the turn uses.
  // Two kinds, so a bare slash gives each its share of the rows: the person's own skills stay as findable as the
  // built-in commands however many commands there are, and a share one kind cannot fill goes to the other.
  const commands: Candidate[] = SLASH_COMMANDS.map((command, index) => ({
    match: command,
    group: 0,
    recency: index,
    suggestion: {
      key: `command:${command}`,
      trigger: "/",
      kind: "command",
      label: command,
      note: slashCommandNote(command, locale),
      command,
    },
  }));
  const candidates: Candidate[] = skills
    .filter((skill) => skill.name.length <= LABEL_MAX)
    .map((skill) => ({
      match: skill.name,
      group: 1,
      suggestion: row(
        { kind: "skill", skillId: skill.name, source: skill.source, revision: skill.revision, label: skill.name },
        { note: `${SKILL_SOURCE[skill.source] ?? skill.source} · ${skill.description}` },
      ),
    }));
  // `/skill:<name>` names a skill and never a command, so after `skill:` only skills are offered, matched by the rest.
  const qualified = SKILL_TOKEN_PREFIX.slice(1);
  if (query.toLowerCase().startsWith(qualified)) {
    return rankCandidates(candidates, query.slice(qualified.length)).map((candidate) => candidate.suggestion);
  }
  return rankCandidates([...commands, ...candidates], query).map((candidate) => candidate.suggestion);
}

/**
 * One kind of thing the at-sign picker offers.
 *
 * The picker asks every source in turn and ranks their rows together, so another kind — a paired Clark's sessions,
 * once they can be listed (#255) — is one more source, not another branch here. A source lists only what this node
 * already holds; whether a chosen row still stands is decided again when the message is sent.
 */
export interface MentionSource {
  candidates(services: ReferenceServices, context: MentionContext): MentionCandidate[];
  /**
   * Why a row about to be shown cannot be chosen, if it cannot.
   *
   * Asked only of the rows that will be shown: checking every project on disk on each keystroke would make typing
   * slower the more a person works, and a row that is shown and cannot be chosen says why.
   */
  unavailable?(services: ReferenceServices, suggestion: ComposerReferenceSuggestion): string | undefined;
}

export interface MentionContext {
  /** The conversation being written in, which is not offered as a reference to itself. */
  currentConversationId?: string | undefined;
}

export type MentionCandidate = Omit<Candidate, "group" | "suggestion"> & { suggestion: ComposerReferenceSuggestion };

const projectSource: MentionSource = {
  candidates(services) {
    return listProjects(services.runtime.db, services.projects.nodeId, 200).flatMap((project, index) =>
      project.name.length > LABEL_MAX
        ? []
        : [
            {
              match: project.name,
              ...(project.lastUsedAt === undefined ? {} : { recency: index }),
              suggestion: row({ kind: "project", projectId: project.projectId, label: project.name }, { note: PROJECT_KIND[project.kind] }),
            },
          ],
    );
  },
  unavailable(services, suggestion) {
    if (suggestion.ref.kind !== "project") return undefined;
    const verified = verifyProject(services.projects, suggestion.ref.projectId);
    if (verified.ok || verified.code === "LEASED") return undefined;
    return verified.code === "OUTSIDE_APPROVED_ROOTS"
      ? "Không còn nằm trong thư mục được phép."
      : verified.code === "PATH_MISSING"
        ? "Thư mục không còn trên đĩa."
        : "Không còn trong danh sách dự án.";
  },
};

/**
 * A service is offered with its state only: nothing it was configured with, and nothing it would answer.
 *
 * It is named by the id its package gave it; the key it is referenced by also names the package generation running
 * it, which means nothing to a person and changes with every update.
 */
const serviceSource: MentionSource = {
  candidates(services) {
    return (services.serviceHost?.status() ?? []).flatMap((service) => {
      const label = service.key.slice(service.key.indexOf("#") + 1);
      return label === "" || label.length > LABEL_MAX
        ? []
        : [
            {
              match: label,
              suggestion: row(
                { kind: "mcp-server", serviceKey: service.key, label },
                { note: service.state === "running" ? "dịch vụ đang chạy" : service.state === "failed" ? "dịch vụ đang lỗi" : "dịch vụ chưa chạy" },
              ),
            },
          ];
    });
  },
};

const conversationSource: MentionSource = {
  candidates(services, context) {
    const { db } = services.runtime;
    return listConversations(db, 50).flatMap((conversationId, index) => {
      if (conversationId === context.currentConversationId) return [];
      const label = conversationLabel(db, conversationId, getConversation(db, conversationId)?.title);
      // A conversation with neither a title nor a word from the person has nothing to be found by, and "untitled"
      // eight times is noise.
      if (label === "") return [];
      return [{ match: label, recency: index, suggestion: row({ kind: "conversation", conversationId, label }, { note: "hội thoại" }) }];
    });
  },
};

const workSource: MentionSource = {
  candidates(services) {
    const work = [...(services.work ?? (() => nodeWork().list({ includeFinished: true })))()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
    return work.flatMap((entry, index) => {
      const label = clip(entry.title, LABEL_MAX);
      if (label === "") return [];
      return [
        {
          match: label,
          recency: index,
          suggestion: row({ kind: "background-work", workId: entry.workId, label }, { note: `việc nền, ${WORK_STATE[entry.state] ?? entry.state}` }),
        },
      ];
    });
  },
};

/** The at-sign picker's sources, in the order their rows are grouped. */
export const MENTION_SOURCES: readonly MentionSource[] = [projectSource, serviceSource, conversationSource, workSource];

/** Every source's rows, ranked together, with the ones that cannot be chosen saying why. */
function mentionSuggestions(
  services: ReferenceServices,
  query: string,
  context: MentionContext,
  sources: readonly MentionSource[],
): ComposerSuggestion[] {
  const candidates: (MentionCandidate & { group: number })[] = sources.flatMap((source, group) =>
    source.candidates(services, context).map((candidate) => ({ ...candidate, group })),
  );
  return rankCandidates(candidates, query).map((candidate) => {
    const reason = sources[candidate.group ?? 0]?.unavailable?.(services, candidate.suggestion);
    return reason === undefined ? candidate.suggestion : { ...candidate.suggestion, disabledReason: reason };
  });
}
/**
 * `@<project>/<path>`: one directory of one project, listed once.
 *
 * The project is named by its indexed name, the most recently used one when two share it. The directory part must be
 * a clean project-relative path and must still resolve inside the project after symlinks; the last segment is a
 * prefix filter. Nothing is read recursively: a person drills down one directory at a time.
 */
function pathSuggestions(services: ReferenceServices, query: string): ComposerSuggestion[] {
  const slash = query.indexOf("/");
  const projectName = foldForMatch(query.slice(0, slash));
  const rest = query.slice(slash + 1);
  const cut = rest.lastIndexOf("/");
  const directory = cut < 0 ? "" : rest.slice(0, cut);
  const partial = cut < 0 ? rest : rest.slice(cut + 1);
  if (directory !== "" && !projectRelativePathSchema.safeParse(directory).success) return [];

  const project: ProjectRecord | undefined = listProjects(services.runtime.db, services.projects.nodeId, 200).find(
    (candidate) => foldForMatch(candidate.name) === projectName,
  );
  if (project === undefined) return [];
  const verified = verifyProject(services.projects, project.projectId);
  if (!verified.ok && verified.code !== "LEASED") return [];

  let listingPath = project.path;
  if (directory !== "") {
    const inside = insideProject(project.path, directory);
    if (!inside.ok || !inside.isDirectory) return [];
    listingPath = inside.realPath;
  }

  let entries;
  try {
    entries = readdirSync(listingPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const ignored = new Set([...SYSTEM_IGNORES, ".git"]);
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
    const label = `${project.name}/${path}`;
    if (label.length > LABEL_MAX || !projectRelativePathSchema.safeParse(path).success) continue;
    // A link is followed to find what it is, and dropped when it leads out of the project.
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      const inside = insideProject(project.path, path);
      if (!inside.ok) continue;
      isDirectory = inside.isDirectory;
    } else if (!isDirectory && !entry.isFile()) {
      continue;
    }
    candidates.push({
      match: entry.name,
      suggestion: row(
        isDirectory
          ? { kind: "folder", projectId: project.projectId, path, label }
          : { kind: "file", projectId: project.projectId, path, label },
        { note: isDirectory ? "thư mục" : "tệp" },
      ),
    });
  }
  // Folders first, then by name, so the order is the same on every platform whatever the directory returned.
  candidates.sort(
    (left, right) =>
      Number(right.suggestion.kind === "folder") - Number(left.suggestion.kind === "folder") ||
      left.match.localeCompare(right.match),
  );
  // A prefix filter on the last segment, as a path is typed; the ranking's substring tier is not wanted here.
  const prefix = foldForMatch(partial);
  return rankCandidates(
    candidates.filter((candidate) => foldForMatch(candidate.match).startsWith(prefix)),
    "",
  ).map((candidate) => candidate.suggestion);
}

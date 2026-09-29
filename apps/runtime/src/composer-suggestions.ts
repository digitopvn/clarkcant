import { readdirSync } from "node:fs";

import {
  type ComposerReference,
  type ComposerSuggestion,
  type ComposerSuggestionsResponse,
  type ComposerTrigger,
  projectRelativePathSchema,
} from "@clarkcant/contracts";
import { type ProjectRecord, getConversation, listConversations, listProjects } from "@clarkcant/storage";

import { type ReferenceServices, insideProject, referenceIdentity } from "./composer-references.ts";
import { SYSTEM_IGNORES, verifyProject } from "./project-finder.ts";
import { nodeWork } from "./work-supervisor.ts";

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
}

/**
 * Exact, then prefix, then substring; within each, the recently used first, then the order the source gave.
 *
 * With no query every candidate is kept, so opening the picker shows the recent things rather than nothing.
 */
export function rankCandidates<T extends { match: string; recency?: number }>(
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
      (left.candidate.recency ?? Number.MAX_SAFE_INTEGER) - (right.candidate.recency ?? Number.MAX_SAFE_INTEGER) ||
      left.order - right.order,
  );
  return tiered.slice(0, limit).map((entry) => entry.candidate);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function row(ref: ComposerReference, extra: { note?: string | undefined; disabledReason?: string | undefined } = {}): ComposerSuggestion {
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
): Promise<ComposerSuggestionsResponse> {
  const suggestions =
    input.trigger === "/"
      ? await skillSuggestions(services, input.query)
      : input.query.includes("/")
        ? pathSuggestions(services, input.query)
        : mentionSuggestions(services, input.query, input.conversationId);
  return { trigger: input.trigger, query: input.query, suggestions };
}

async function skillSuggestions(services: ReferenceServices, query: string): Promise<ComposerSuggestion[]> {
  const skills = services.skills === undefined ? [] : await services.skills.list();
  const candidates: Candidate[] = skills
    .filter((skill) => skill.name.length <= LABEL_MAX)
    .map((skill) => ({
      match: skill.name,
      suggestion: row(
        { kind: "skill", skillId: skill.name, source: skill.source, revision: skill.revision, label: skill.name },
        { note: `${SKILL_SOURCE[skill.source] ?? skill.source} · ${skill.description}` },
      ),
    }));
  return rankCandidates(candidates, query).map((candidate) => candidate.suggestion);
}

/**
 * Projects, services, conversations and background work, ranked together.
 *
 * Only the rows that will be shown are checked on disk: verifying every indexed project on each keystroke would make
 * typing slower the more a person works, and a row that is shown and cannot be chosen says why.
 */
function mentionSuggestions(
  services: ReferenceServices,
  query: string,
  currentConversationId: string | undefined,
): ComposerSuggestion[] {
  const { db } = services.runtime;
  const candidates: Candidate[] = [];

  listProjects(db, services.projects.nodeId, 200).forEach((project, index) => {
    if (project.name.length > LABEL_MAX) return;
    candidates.push({
      match: project.name,
      ...(project.lastUsedAt === undefined ? {} : { recency: index }),
      suggestion: row({ kind: "project", projectId: project.projectId, label: project.name }, { note: PROJECT_KIND[project.kind] }),
    });
  });

  for (const service of services.serviceHost?.status() ?? []) {
    if (service.key.length > LABEL_MAX) continue;
    candidates.push({
      match: service.key,
      suggestion: row(
        { kind: "mcp-server", serviceKey: service.key, label: service.key },
        { note: service.state === "running" ? "dịch vụ đang chạy" : service.state === "failed" ? "dịch vụ đang lỗi" : "dịch vụ chưa chạy" },
      ),
    });
  }

  listConversations(db, 50).forEach((conversationId, index) => {
    if (conversationId === currentConversationId) return;
    const conversation = getConversation(db, conversationId);
    const label = clip(conversation?.title ?? "", LABEL_MAX);
    // A conversation with no title has nothing a person would type to find it, and "untitled" eight times is noise.
    if (label === "") return;
    candidates.push({
      match: label,
      recency: index,
      suggestion: row({ kind: "conversation", conversationId, label }, { note: "hội thoại" }),
    });
  });

  const work = [...(services.work ?? (() => nodeWork().list({ includeFinished: true })))()].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  work.forEach((entry, index) => {
    const label = clip(entry.title, LABEL_MAX);
    if (label === "") return;
    candidates.push({
      match: label,
      recency: index,
      suggestion: row({ kind: "background-work", workId: entry.workId, label }, { note: `việc nền, ${WORK_STATE[entry.state] ?? entry.state}` }),
    });
  });

  return rankCandidates(candidates, query).map((candidate) => {
    const ref = candidate.suggestion.ref;
    if (ref.kind !== "project") return candidate.suggestion;
    const verified = verifyProject(services.projects, ref.projectId);
    if (verified.ok || verified.code === "LEASED") return candidate.suggestion;
    return {
      ...candidate.suggestion,
      disabledReason:
        verified.code === "OUTSIDE_APPROVED_ROOTS"
          ? "Không còn nằm trong thư mục được phép."
          : verified.code === "PATH_MISSING"
            ? "Thư mục không còn trên đĩa."
            : "Không còn trong danh sách dự án.",
    };
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

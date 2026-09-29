import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type ComposerReference,
  type ReferenceBlock,
  composerReferencesSchema,
  referenceBlockSchema,
  referenceToken,
} from "@clarkcant/contracts";
import type { PiSkill, PiSkillBody } from "@clarkcant/pi-adapter";
import { type Database, getConversation, getProject, listNotifications, messagesSince } from "@clarkcant/storage";

import { isWithinRoot } from "./path-roots.ts";
import { type ProjectFinderDeps, relativePaths, verifyProject } from "./project-finder.ts";
import type { ServiceHost } from "./service-host.ts";
import { type WorkView, nodeWork } from "./work-supervisor.ts";

/**
 * What a message points at, checked when it is sent and briefed when it is answered.
 *
 * The composer offers references from what was true when the picker opened. This module is the node deciding what
 * they mean now: every reference is looked up again, and one that no longer holds is refused by name rather than
 * quietly dropped or replaced by something that happens to share its label. A message either carries everything it
 * named or is not sent, because a turn that silently lost the skill it was asked to follow answers a different request.
 *
 * A reference is a pointer, not a grant. Nothing here reads a file for the model, opens a conversation or calls a
 * service: the brief says what was named and where, and whatever the turn then does goes through the tools and the
 * policy it would have gone through anyway.
 */

/** The skills this node's pi installation offers, read through the adapter the model turn holds. */
export interface SkillCatalog {
  list(): Promise<readonly PiSkill[]>;
  body(name: string, revision: string): Promise<PiSkillBody>;
}

export interface ReferenceServices {
  runtime: { db: Database; identity: { ownerPrincipalId: string } };
  projects: ProjectFinderDeps;
  skills?: SkillCatalog | undefined;
  serviceHost?: Pick<ServiceHost, "status"> | undefined;
  /** The work the node is running or ran; the node's own supervisor unless a test gives its own. */
  work?: (() => readonly WorkView[]) | undefined;
}

export type ReferenceResolution = { ok: true; blocks: ReferenceBlock[] } | { ok: false; message: string };

/** How much skill text one turn may carry, across every skill it names. */
export const SKILL_BRIEF_BUDGET_CHARS = 32_000;

const WORK_STATE: Record<WorkView["state"], string> = {
  queued: "đang chờ",
  running: "đang chạy",
  done: "đã xong",
  failed: "thất bại",
  stopped: "đã dừng",
  interrupted: "bị gián đoạn",
};

/**
 * Check the references a message carries, in the order they were given.
 *
 * `undefined` is no references at all, which is every message sent before this existed. Anything else must be the
 * versioned shape: a newer shape is refused rather than read as far as this node understands it. The same thing named
 * twice is one reference.
 */
export async function resolveComposerReferences(
  services: ReferenceServices,
  input: { value: unknown },
): Promise<ReferenceResolution> {
  if (input.value === undefined) return { ok: true, blocks: [] };
  const parsed = composerReferencesSchema.safeParse(input.value);
  if (!parsed.success) {
    return { ok: false, message: "Tham chiếu trong tin nhắn không đúng dạng: cần { version: 1, items } với tối đa 8 mục." };
  }

  const blocks: ReferenceBlock[] = [];
  const seen = new Set<string>();
  for (const reference of parsed.data.items) {
    const identity = referenceIdentity(reference);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const checked = await checkReference(services, reference);
    if (!checked.ok) return checked;
    blocks.push(checked.block);
  }
  return { ok: true, blocks };
}

/** What makes two references the same thing, whatever label each was chosen under. */
export function referenceIdentity(reference: ComposerReference): string {
  switch (reference.kind) {
    case "skill":
      return `skill:${reference.source}:${reference.skillId}`;
    case "project":
      return `project:${reference.projectId}`;
    case "file":
    case "folder":
      return `${reference.kind}:${reference.projectId}:${reference.path}`;
    case "mcp-server":
      return `mcp-server:${reference.serviceKey}`;
    case "conversation":
      return `conversation:${reference.conversationId}`;
    case "background-work":
      return `background-work:${reference.workId}`;
    case "notice":
      return `notice:${reference.noticeId}`;
  }
}

async function checkReference(
  services: ReferenceServices,
  reference: ComposerReference,
): Promise<{ ok: true; block: ReferenceBlock } | { ok: false; message: string }> {
  const token = referenceToken(reference);
  const refuse = (sentence: string) => ({ ok: false as const, message: `${token}: ${sentence}` });
  const accept = (note?: string) => ({
    ok: true as const,
    block: { type: "reference" as const, reference, ...(note === undefined ? {} : { note: note.slice(0, 300) }) },
  });

  switch (reference.kind) {
    case "skill": {
      const skills = services.skills === undefined ? [] : await services.skills.list();
      const skill = skills.find((candidate) => candidate.name === reference.skillId && candidate.source === reference.source);
      if (skill === undefined) return refuse("kỹ năng này không còn trên máy này. Bỏ nó khỏi tin nhắn rồi gửi lại.");
      if (skill.revision !== reference.revision) {
        return refuse("kỹ năng này đã được sửa sau khi bạn chọn. Chọn lại để dùng bản mới.");
      }
      return accept();
    }
    case "project": {
      const project = checkProject(services.projects, reference.projectId);
      return project.ok ? accept(project.kind) : refuse(project.sentence);
    }
    case "file":
    case "folder": {
      const project = checkProject(services.projects, reference.projectId);
      if (!project.ok) return refuse(project.sentence);
      const inside = insideProject(project.path, reference.path);
      if (!inside.ok) return refuse(inside.sentence);
      if (reference.kind === "file" && !inside.isFile) return refuse("đây không còn là một tệp.");
      if (reference.kind === "folder" && !inside.isDirectory) return refuse("đây không còn là một thư mục.");
      return accept(reference.kind === "file" ? describeSize(inside.size) : undefined);
    }
    case "mcp-server": {
      const service = services.serviceHost?.status().find((entry) => entry.key === reference.serviceKey);
      if (service === undefined) return refuse("dịch vụ này không còn được cài trên máy này.");
      return accept(service.state === "running" ? "đang chạy" : service.state === "failed" ? "đang lỗi" : "chưa chạy");
    }
    case "conversation":
      return getConversation(services.runtime.db, reference.conversationId) === undefined
        ? refuse("hội thoại này không còn tồn tại.")
        : accept();
    case "background-work": {
      const work = (services.work ?? defaultWork)().find((entry) => entry.workId === reference.workId);
      return work === undefined ? refuse("việc này không còn trong danh sách việc nền.") : accept(WORK_STATE[work.state]);
    }
    case "notice": {
      const notice = listNotifications(services.runtime.db, services.runtime.identity.ownerPrincipalId, 200).find(
        (entry) => entry.noticeId === reference.noticeId,
      );
      return notice === undefined ? refuse("thông báo này đã được ẩn hoặc không còn.") : accept(notice.title);
    }
  }
}

function defaultWork(): readonly WorkView[] {
  return nodeWork().list({ includeFinished: true });
}

const PROJECT_KIND: Record<string, string> = { code: "mã nguồn", docs: "tài liệu", media: "media", generic: "thư mục" };

/**
 * A project a reference may point into. A lease held by another writer does not refuse it: naming a directory is not
 * writing to it, and whatever writes there later is checked when it does.
 */
function checkProject(
  deps: ProjectFinderDeps,
  projectId: string,
): { ok: true; path: string; kind: string } | { ok: false; sentence: string } {
  const verified = verifyProject(deps, projectId);
  if (verified.ok) return { ok: true, path: verified.project.path, kind: PROJECT_KIND[verified.project.kind] ?? "thư mục" };
  switch (verified.code) {
    case "LEASED": {
      // Reported only after the project was found inside an approved root and on disk, so those checks already hold.
      const project = getProject(deps.db, projectId);
      return project === undefined
        ? { ok: false, sentence: "dự án này không còn trong danh sách của máy này." }
        : { ok: true, path: project.path, kind: PROJECT_KIND[project.kind] ?? "thư mục" };
    }
    case "PROJECT_UNKNOWN":
      return { ok: false, sentence: "dự án này không còn trong danh sách của máy này." };
    case "OUTSIDE_APPROVED_ROOTS":
      return { ok: false, sentence: "dự án này không còn nằm trong thư mục được phép." };
    case "PATH_MISSING":
      return { ok: false, sentence: "thư mục của dự án này không còn trên đĩa." };
  }
}

/**
 * Where a project-relative path really is, if it is still inside the project.
 *
 * The contract has already refused `..`, absolute paths and drives; this resolves symlinks as well, because a link can
 * leave the project without any segment saying so. Both sides are resolved, so a project that is itself reached
 * through a link still contains its own files.
 */
export function insideProject(
  projectPath: string,
  relativePath: string,
):
  | { ok: true; realPath: string; isFile: boolean; isDirectory: boolean; size: number }
  | { ok: false; sentence: string } {
  let projectReal: string;
  let targetReal: string;
  try {
    projectReal = realpathSync(projectPath);
    targetReal = realpathSync(join(projectPath, ...relativePath.split("/")));
  } catch {
    return { ok: false, sentence: "không còn tồn tại." };
  }
  if (!isWithinRoot(projectReal, targetReal)) return { ok: false, sentence: "trỏ ra ngoài dự án của nó." };
  try {
    const stat = statSync(targetReal);
    return { ok: true, realPath: targetReal, isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size };
  } catch {
    return { ok: false, sentence: "không còn tồn tại." };
  }
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The references the message being answered carries, read back from the row it was stored as.
 *
 * The same reading the timeline does, for the reason attachments are read this way: the prompt and the conversation
 * then agree on what was named, including when the conversation is reopened later.
 */
export function referencesForLastUserMessage(input: { db: Database; conversationId: string }): ReferenceBlock[] {
  const records = messagesSince(input.db, input.conversationId, 0, 40);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || record.role !== "user") continue;
    return record.blocks.flatMap((block) => {
      if (block.type !== "reference") return [];
      const parsed = referenceBlockSchema.safeParse(block);
      return parsed.success ? [parsed.data] : [];
    });
  }
  return [];
}

/**
 * The reference section of a turn's prompt.
 *
 * A skill's instructions are included the way pi itself includes a skill named with `/skill:`, inside a `<skill>`
 * element, but without its location: the model needs the words, and a path in a prompt is a path in a log. Every
 * other kind is one line naming what it is and the id the existing tools take, so the turn can act on it without the
 * node having acted first. A path is given relative to the approved root that holds it, as `find_project` gives it.
 */
export async function referenceBrief(input: {
  blocks: readonly ReferenceBlock[];
  projects: ProjectFinderDeps;
  skillBody: (name: string, revision: string) => Promise<PiSkillBody>;
}): Promise<string> {
  if (input.blocks.length === 0) return "";
  const lines: string[] = [
    "[Tham chiếu trong lượt này]",
    "Người dùng chỉ vào những thứ dưới đây. Tham chiếu là con trỏ, không phải quyền: muốn đọc, chạy hay thay đổi gì " +
      "thì vẫn dùng công cụ sẵn có và đi qua chính sách như mọi lượt khác.",
  ];
  const skills: string[] = [];
  let remaining = SKILL_BRIEF_BUDGET_CHARS;

  for (const { reference, note } of input.blocks) {
    const suffix = note === undefined ? "" : ` (${note})`;
    switch (reference.kind) {
      case "skill": {
        const body = await input.skillBody(reference.skillId, reference.revision);
        if (!body.ok) {
          lines.push(`- Kỹ năng /${reference.skillId}: đã thay đổi hoặc bị gỡ sau khi gửi, nên không được chèn.`);
          break;
        }
        const text = body.body.length <= remaining ? body.body : `${body.body.slice(0, Math.max(0, remaining))}\n[…đã cắt bớt]`;
        remaining -= Math.min(body.body.length, remaining);
        lines.push(`- Kỹ năng /${reference.skillId}: làm theo chỉ dẫn trong khối <skill> bên dưới cho yêu cầu này.`);
        skills.push(`<skill name="${reference.skillId}">\n${text}\n</skill>`);
        break;
      }
      case "project": {
        const place = projectPlace(input.projects, reference.projectId);
        lines.push(`- Dự án "${reference.label}"${suffix} — projectId ${reference.projectId}${place === undefined ? "" : `, thư mục ${place}`}`);
        break;
      }
      case "file":
      case "folder": {
        const place = projectPlace(input.projects, reference.projectId);
        const where = place === undefined ? reference.path : place === "." ? reference.path : `${place}/${reference.path}`;
        lines.push(
          `- ${reference.kind === "file" ? "Tệp" : "Thư mục"} "${reference.label}"${suffix} — đường dẫn ${where} ` +
            `(trong dự án projectId ${reference.projectId})`,
        );
        break;
      }
      case "mcp-server":
        lines.push(`- Dịch vụ MCP "${reference.label}"${suffix} — serviceKey ${reference.serviceKey}`);
        break;
      case "conversation":
        lines.push(`- Hội thoại "${reference.label}" — conversationId ${reference.conversationId}`);
        break;
      case "background-work":
        lines.push(`- Việc nền "${reference.label}"${suffix} — workId ${reference.workId}`);
        break;
      case "notice":
        lines.push(`- Thông báo "${reference.label}"${suffix} — noticeId ${reference.noticeId}`);
        break;
    }
  }
  return [...lines, ...skills].join("\n");
}

function projectPlace(deps: ProjectFinderDeps, projectId: string): string | undefined {
  const project = checkProject(deps, projectId);
  return project.ok ? relativePaths(deps, project.path) : undefined;
}

import { suggestionIdSchema, type Suggestion } from "@clarkcant/contracts";
import {
  listActiveTasks,
  listConversations,
  listMemoryRecords,
  listPins,
  listProjects,
  type Database,
} from "@clarkcant/storage";

/**
 * What to offer somebody who has just opened the app.
 *
 * One pass over records the node already has, ranked deterministically, capped at four. No embeddings, no model
 * call, no second store: a suggestion list is a reading of what is already there, so it can be served in the
 * time one query takes and it cannot remember anything the person cannot also go and read. That is the same rule
 * the Memory tab follows - everything remembered is visible.
 *
 * Every suggestion is a sentence pressing it will send. A label that is not the text is a chip that lies about
 * what it does, which is why `text` is built here and not by the caller.
 */

/** The records this reads. `nodeId` is here because projects are the node's, not the conversation's. */
export interface SuggestionDeps {
  db: Database;
  nodeId: string;
  /** The instant the suggestions are being offered. Injected, so the recency words below are testable. */
  now: () => string;
  /** How many to offer. Four by default: a first screen, not a menu. */
  limit?: number;
  /**
   * Whose memories may be offered.
   *
   * The Memory tab lists these same records, which is what makes offering one safe: a suggestion may only point at
   * something the person can also go and read, and delete.
   */
  principalId: string;
}

/** A suggestion's id is derived from what it points at, so the same offer keeps the same name. */
function idFor(source: string, ref: string): Suggestion["suggestionId"] {
  return suggestionIdSchema.parse(`sug_${source}_${ref.replace(/[^a-z0-9]/gi, "").toLowerCase()}`);
}

/** Cut a string to a budget without leaving half a word. */
function trim(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * How long ago something was, in words.
 *
 * Computed from the instant rather than written down, because "hôm qua" on a record from last week is a lie the
 * person can check - and one that would make the label worthless rather than merely imprecise.
 */
function recencyLabel(at: string, now: string): string {
  const then = Date.parse(at);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return "gần đây";
  const days = Math.floor((current - then) / 86_400_000);
  if (days <= 0) return "hôm nay";
  if (days === 1) return "hôm qua";
  if (days <= 7) return "trong tuần này";
  return "trước đó";
}

/** What a "continue this" offer puts in front of the task's goal. */
const CONTINUE_PREFIX = "Tiếp tục việc: ";

/** A goal without any number of continue prefixes in front of it; the goal itself if that would leave nothing. */
export function withoutContinuePrefix(goal: string): string {
  let rest = goal.trim();
  while (rest.startsWith(CONTINUE_PREFIX.trim())) rest = rest.slice(CONTINUE_PREFIX.trim().length).trim();
  return rest === "" ? goal.trim() : rest;
}

export function buildSuggestions(deps: SuggestionDeps): Suggestion[] {
  const limit = deps.limit ?? 4;
  const now = deps.now();
  const offered: Suggestion[] = [];
  const seenRefs = new Set<string>();

  const offer = (input: {
    label: string;
    text: string;
    source: Suggestion["source"];
    sourceLabel: string;
    at: string;
    ref?: string;
  }): void => {
    if (offered.length >= limit) return;
    // One offer per thing. Two chips pointing at the same task would be one chip and a wasted row.
    if (input.ref !== undefined) {
      if (seenRefs.has(input.ref)) return;
      seenRefs.add(input.ref);
    }
    offered.push({
      suggestionId: idFor(input.source, input.ref ?? input.text),
      label: trim(input.label, 60),
      text: trim(input.text, 500),
      source: input.source,
      sourceLabel: trim(input.sourceLabel, 80),
      at: input.at as Suggestion["at"],
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    });
  };

  const conversations = listConversations(deps.db, 5);
  const latest = conversations[0];

  if (latest !== undefined) {
    // (a) Work left unfinished, which is the most useful thing to offer and the only one that says what for.
    //
    // The goal is read without the prefix this offer adds. Pressing the chip sends its text as a new turn, and
    // that turn's task keeps the text verbatim as its goal, so without this each round trip stacked one more
    // "Tiếp tục việc: " in front and the chip filled with the prefix instead of the work.
    // Goals that come out the same after that are one piece of work and get one chip.
    const seenGoals = new Set<string>();
    for (const task of listActiveTasks(deps.db, latest)) {
      const goal = withoutContinuePrefix(task.goal);
      if (seenGoals.has(goal)) continue;
      seenGoals.add(goal);
      offer({
        label: goal,
        text: `${CONTINUE_PREFIX}${goal}`,
        source: "task",
        sourceLabel: `việc còn dang dở, ${recencyLabel(task.updatedAt, now)}`,
        at: task.updatedAt,
        ref: task.taskId,
      });
    }

    // (b) Something that was pinned, because pinning is an explicit "keep this".
    const newestPin = listPins(deps.db, latest)[0];
    if (newestPin !== undefined) {
      offer({
        label: "Mở lại widget đã ghim",
        text: "Mở lại widget mà tôi đã ghim trong phiên gần nhất",
        source: "pin",
        sourceLabel: `bạn đã ghim, ${recencyLabel(newestPin.createdAt, now)}`,
        at: newestPin.createdAt,
        ref: newestPin.pinId,
      });
    }

    // (c) The session itself. No time word here on purpose: the list of conversations carries no instant, and a
    // label that guessed one would be the one thing this file exists to avoid.
    offer({
      label: "Mở lại phiên gần nhất",
      text: "Cho tui xem lại phiên làm việc gần nhất",
      source: "conversation",
      sourceLabel: "phiên gần nhất",
      at: now,
      ref: latest,
    });
  }

  // (d) Something already written down. Reading the same table the Memory tab reads is the point: an offer that
  // pointed at something the person could not open would be the hidden memory this feature exists to avoid.
  const newestMemory = listMemoryRecords(deps.db, { principalId: deps.principalId })[0];
  if (newestMemory !== undefined) {
    offer({
      label: `Nhớ lại: ${newestMemory.text}`,
      text: `Cho tui xem lại điều đã ghi nhớ: ${newestMemory.text}`,
      source: "memory",
      sourceLabel: `bạn đã ghi nhớ, ${recencyLabel(newestMemory.at, now)}`,
      at: newestMemory.at,
      ref: newestMemory.memoryId,
    });
  }

  // (e) Directories used recently. `listProjects` is already ordered by last use, and the record carries the name.
  for (const project of listProjects(deps.db, deps.nodeId, 5)) {
    offer({
      label: `Mở dự án ${project.name}`,
      text: `Mở dự án ${project.name}`,
      source: "project",
      sourceLabel: "thư mục dùng gần đây",
      at: now,
      ref: project.projectId,
    });
  }

  return offered;
}

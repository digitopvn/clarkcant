import { type AppIntentLocale, suggestionIdSchema, type Suggestion } from "@clarkcant/contracts";
import {
  listActiveTasks,
  listConversations,
  listMemoryRecords,
  listPins,
  listProjects,
  type Database,
} from "@clarkcant/storage";

import { CONTINUE_PREFIXES, type HostText, hostText } from "./host-text.ts";

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
 *
 * The words are the host's, in the person's interface language (`language`, Vietnamese when none is named): the chip,
 * the sentence it sends and the line under it are written in the same language, so a chip never sends a sentence in
 * another language than the one it shows.
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
  /** The language the chips are written in; Vietnamese when none is named. */
  language?: AppIntentLocale;
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
function recencyLabel(at: string, now: string, words: HostText["suggestions"]["recency"]): string {
  const then = Date.parse(at);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return words.unknown;
  const days = Math.floor((current - then) / 86_400_000);
  if (days <= 0) return words.today;
  if (days === 1) return words.yesterday;
  if (days <= 7) return words.thisWeek;
  return words.earlier;
}

/**
 * A goal without any number of continue prefixes in front of it, in either language.
 *
 * A goal that is nothing but prefixes comes back as one bare prefix, not as itself, so feeding the offer's text
 * back in as the next goal settles instead of growing by a prefix each round trip.
 */
export function withoutContinuePrefix(goal: string): string {
  let rest = goal.trim();
  let last: string | undefined;
  for (;;) {
    const bare = CONTINUE_PREFIXES.map((prefix) => prefix.trim()).find((prefix) => rest.startsWith(prefix));
    if (bare === undefined) break;
    last = bare;
    rest = rest.slice(bare.length).trim();
  }
  return rest === "" && last !== undefined ? last : rest;
}

export function buildSuggestions(deps: SuggestionDeps): Suggestion[] {
  const limit = deps.limit ?? 4;
  const now = deps.now();
  const say = hostText(deps.language).suggestions;
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
    // continue prefix in front and the chip filled with the prefix instead of the work.
    // Goals that come out the same after that are one piece of work and get one chip.
    const seenGoals = new Set<string>();
    for (const task of listActiveTasks(deps.db, latest)) {
      const goal = withoutContinuePrefix(task.goal);
      if (seenGoals.has(goal)) continue;
      seenGoals.add(goal);
      offer({
        label: goal,
        text: `${say.continuePrefix}${goal}`,
        source: "task",
        sourceLabel: say.unfinishedSource(recencyLabel(task.updatedAt, now, say.recency)),
        at: task.updatedAt,
        ref: task.taskId,
      });
    }

    // (b) Something that was pinned, because pinning is an explicit "keep this".
    const newestPin = listPins(deps.db, latest)[0];
    if (newestPin !== undefined) {
      offer({
        label: say.pinnedLabel,
        text: say.pinnedText,
        source: "pin",
        sourceLabel: say.pinnedSource(recencyLabel(newestPin.createdAt, now, say.recency)),
        at: newestPin.createdAt,
        ref: newestPin.pinId,
      });
    }

    // (c) The session itself. No time word here on purpose: the list of conversations carries no instant, and a
    // label that guessed one would be the one thing this file exists to avoid.
    offer({
      label: say.latestLabel,
      text: say.latestText,
      source: "conversation",
      sourceLabel: say.latestSource,
      at: now,
      ref: latest,
    });
  }

  // (d) Something already written down. Reading the same table the Memory tab reads is the point: an offer that
  // pointed at something the person could not open would be the hidden memory this feature exists to avoid.
  const newestMemory = listMemoryRecords(deps.db, { principalId: deps.principalId })[0];
  if (newestMemory !== undefined) {
    offer({
      label: say.memoryLabel(newestMemory.text),
      text: say.memoryText(newestMemory.text),
      source: "memory",
      sourceLabel: say.memorySource(recencyLabel(newestMemory.at, now, say.recency)),
      at: newestMemory.at,
      ref: newestMemory.memoryId,
    });
  }

  // (e) Directories used recently. `listProjects` is already ordered by last use, and the record carries the name. The
  // index also holds every folder a scan found and nobody has opened — a games cache once filled this screen — so only
  // a folder that was actually used is offered under "used recently".
  for (const project of listProjects(deps.db, deps.nodeId, 5).filter((entry) => entry.lastUsedAt !== undefined)) {
    offer({
      label: say.projectLabel(project.name),
      text: say.projectText(project.name),
      source: "project",
      sourceLabel: say.projectSource,
      at: now,
      ref: project.projectId,
    });
  }

  return offered;
}

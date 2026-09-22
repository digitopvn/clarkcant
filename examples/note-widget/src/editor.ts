/**
 * Note editor session, over the widget lifecycle store.
 *
 * The flow the fixture exists to prove is build -> preview -> approve -> persist, and the part
 * that is usually skipped is what happens when the persist step loses. Nothing here reimplements
 * drafts: `@clarkcant/core` owns the revision check and the conflict rule, and this file is the
 * sequence an editor performs against it.
 *
 * Because a note is the simplest possible widget, it is also the clearest place to see the rule
 * that a refused save is not a lost save.
 */

import {
  commitDraft,
  discardDraft,
  readInstanceState,
  saveDraft,
  type LifecycleDeps,
  type SaveOutcome,
} from "@clarkcant/core";

/**
 * The package's one copy of the label, on the module the registry's evidence tests exercise: what is
 * implemented here is the revision-checked draft flow (`implemented-draft-flow`). The package-level gap -
 * the isolated build that would produce a shippable bundle - is named in the registry entry
 * `example.note-widget`, not restated as a second constant.
 */
export const NOTE_WIDGET_STATUS = "implemented-draft-flow";

export interface NoteSession {
  instanceId: string;
  /** Identifies this editing surface, so a second one cannot take the draft from it. */
  editorToken: string;
  /** The revision this editor loaded. Everything it saves is checked against it. */
  revision: number;
}

/** What the user would see, including whether what they see is saved. */
export interface NotePreview {
  text: string;
  /** The text as committed, which differs from `text` while there is unsaved work. */
  committedText: string;
  revision: number;
  unsaved: boolean;
  /** Present when this surface is looking at another surface's unsaved work. */
  heldByAnotherSurface: string | undefined;
}

export type NoteOutcome =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict"; message: string; currentText: string; draftKept: true }
  | { ok: false; reason: "held"; message: string; heldBy: string; draftKept: true };

/** Open the editor against an instance. The revision is read, not assumed. */
export function openNote(
  deps: LifecycleDeps,
  input: { instanceId: string; editorToken: string },
): NoteSession {
  const state = readInstanceState(deps, input.instanceId);
  if (!state) throw new Error(`note ${input.instanceId} has no state; create the instance first`);
  return {
    instanceId: input.instanceId,
    editorToken: input.editorToken,
    revision: state.revision,
  };
}

function textOf(body: Record<string, unknown>): string {
  const value = body.body;
  return typeof value === "string" ? value : "";
}

/** Translate a store outcome into what the editor should say to the user. */
function toNoteOutcome(outcome: SaveOutcome): NoteOutcome {
  if (outcome.ok) return { ok: true, revision: outcome.revision };
  if (outcome.code === "CONFLICT") {
    return {
      ok: false,
      reason: "conflict",
      message:
        "Someone saved a newer version while you were typing. Your text has been kept, and the newer text is shown so you can decide.",
      currentText: textOf(outcome.currentBody),
      draftKept: true,
    };
  }
  return {
    ok: false,
    reason: "held",
    message: outcome.message,
    heldBy: outcome.heldBy,
    draftKept: true,
  };
}

/** Save what the user has typed so far. Never commits. */
export function typeNote(deps: LifecycleDeps, session: NoteSession, text: string): NoteOutcome {
  return toNoteOutcome(
    saveDraft(deps, {
      instanceId: session.instanceId,
      body: { body: text },
      expectedRevision: session.revision,
      editorToken: session.editorToken,
    }),
  );
}

/**
 * What the editor renders.
 *
 * The draft is shown when this surface owns it, and the committed text is shown when another
 * surface does, because presenting someone else's in-progress text as the user's own edits would
 * be a lie about whose work is on screen.
 */
export function previewNote(deps: LifecycleDeps, session: NoteSession): NotePreview {
  const state = readInstanceState(deps, session.instanceId);
  if (!state) throw new Error(`note ${session.instanceId} has no state`);

  const committedText = textOf(state.body);
  const draftIsMine = state.draft !== undefined && state.draftEditor === session.editorToken;
  const heldByAnotherSurface =
    state.draft !== undefined && state.draftEditor !== session.editorToken
      ? state.draftEditor
      : undefined;

  return {
    text: draftIsMine ? textOf(state.draft ?? {}) : committedText,
    committedText,
    revision: state.revision,
    unsaved: state.draft !== undefined,
    heldByAnotherSurface,
  };
}

/** Accept the draft as the note's content. */
export function approveNote(deps: LifecycleDeps, session: NoteSession): NoteOutcome {
  return toNoteOutcome(
    commitDraft(deps, {
      instanceId: session.instanceId,
      expectedRevision: session.revision,
      editorToken: session.editorToken,
    }),
  );
}

/** Throw the draft away. Only the surface holding it may do this. */
export function abandonNote(deps: LifecycleDeps, session: NoteSession): { discarded: boolean; refused?: string } {
  return discardDraft(deps, { instanceId: session.instanceId, editorToken: session.editorToken });
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";

import { COMPOSER_REFERENCES_MAX, type ComposerReference, type ComposerSuggestion, referenceToken } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { type ActiveTrigger, activeTrigger, liveReferences, replaceToken, withoutToken } from "./composer-trigger.ts";

/** A reference the person chose, keyed by the row it came from so choosing the same thing twice keeps one. */
export interface ChosenReference {
  key: string;
  ref: ComposerReference;
}

export interface ComposerReferencesState {
  /** Whether the picker is showing. */
  open: boolean;
  trigger: ActiveTrigger | undefined;
  suggestions: readonly ComposerSuggestion[];
  /** Waiting on the node for the rows of what was just typed. */
  loading: boolean;
  /** The node's own sentence when the rows could not be read. */
  failed: string | undefined;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Every reference chosen since the last send, whether or not its token is still in the draft. */
  chosen: readonly ChosenReference[];
  /** The ones the draft still carries, which are the chips and what a send takes. */
  live: readonly ChosenReference[];
  /** Whether the message already carries as many references as it can. */
  full: boolean;
  /** Called with the textarea after every change and caret move. */
  track: (input: HTMLTextAreaElement) => void;
  /** Focus left the textarea: the picker belongs to the caret, and there is none. */
  leave: () => void;
  setComposing: (composing: boolean) => void;
  /** The picker's keys. Answers whether it used the key, so the composer does not also send on that Enter. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** `pick` adds the row as a reference; `open` goes into a project or folder to choose something inside it. */
  choose: (index: number, how: "pick" | "open") => void;
  remove: (key: string) => void;
  /**
   * Adds a reference from outside the picker — "Add to context" on a notice — at the end of the draft, where the person
   * continues typing. Answers `full` when the message already carries as many references as it can.
   */
  insert: (key: string, ref: ComposerReference) => "added" | "already" | "full";
  /** After a send the node accepted: the chosen references belonged to that message. */
  clear: () => void;
}

export interface ComposerReferencesDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  draft: string;
  setDraft: (draft: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
}

/** Long enough to skip the keystrokes in the middle of a word, short enough that the list keeps up with typing. */
const DEBOUNCE_MS = 80;

/**
 * The composer's `/` and `@` picker.
 *
 * The rows come from the node, which alone knows what is on this machine; the draft stays the composer's. Choosing a
 * row writes its token into the draft and remembers what it stands for, and a reference lives exactly as long as its
 * token does, so deleting `@clarkcant` from the text is how a person takes the project back out.
 */
export function useComposerReferences({
  client,
  conversationId,
  draft,
  setDraft,
  input,
}: ComposerReferencesDeps): ComposerReferencesState {
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  /** The trigger the person closed with Escape, which stays closed until another one is typed. */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const [suggestions, setSuggestions] = useState<readonly ComposerSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [chosen, setChosen] = useState<readonly ChosenReference[]>([]);
  /** Which request's answer may still be drawn: an answer to an older query is dropped rather than flashed. */
  const sequence = useRef(0);

  const trigger = useMemo(() => activeTrigger(draft, caret), [draft, caret]);
  const triggerKey = trigger === undefined ? undefined : `${trigger.start}:${trigger.trigger}`;
  const open = trigger !== undefined && !composing && triggerKey !== dismissed;
  const live = useMemo(() => liveReferences(draft, chosen), [draft, chosen]);
  const full = live.length >= COMPOSER_REFERENCES_MAX;

  // A picker opened somewhere else starts empty, rather than showing the last one's rows until the node answers.
  useEffect(() => {
    setSuggestions([]);
    setFailed(undefined);
  }, [triggerKey]);

  const query = trigger?.query;
  const kind = trigger?.trigger;
  useEffect(() => {
    if (!open || kind === undefined || query === undefined) {
      sequence.current += 1;
      setLoading(false);
      return;
    }
    const mine = ++sequence.current;
    setLoading(true);
    const timer = setTimeout(() => {
      client
        .composerSuggestions({ trigger: kind, query, conversationId })
        .then((response) => {
          if (sequence.current !== mine) return;
          setSuggestions(response.suggestions);
          setFailed(undefined);
          setActiveIndex(0);
        })
        .catch((cause: unknown) => {
          if (sequence.current !== mine) return;
          setSuggestions([]);
          setFailed(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (sequence.current === mine) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [client, conversationId, kind, open, query]);

  const track = useCallback((element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart === element.selectionEnd ? element.selectionStart : -1);
  }, []);

  /**
   * Where the caret goes once the draft a row wrote is on screen.
   *
   * Placed in a layout effect, right after React writes the value and before the next key is handled. A frame later
   * is too late: whatever the person typed in between lands where they typed it, and then the caret jumps back and
   * the rest of the word is written in front of it.
   */
  const pendingCaret = useRef<{ draft: string; caret: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    const element = input.current;
    if (pending === undefined || element === null) return;
    pendingCaret.current = undefined;
    // Only for the text the row wrote: once the person has typed past it, the caret is theirs.
    if (element.value !== pending.draft) return;
    element.focus();
    element.setSelectionRange(pending.caret, pending.caret);
  }, [draft, caret, input]);

  /** Writes the new draft and puts the caret where the person would continue typing. */
  const write = useCallback(
    (next: { draft: string; caret: number }) => {
      pendingCaret.current = next;
      setDraft(next.draft);
      setCaret(next.caret);
    },
    [setDraft],
  );

  const choose = useCallback(
    (index: number, how: "pick" | "open") => {
      const row = suggestions[index];
      if (trigger === undefined || row === undefined || row.disabledReason !== undefined) return;
      const opens = how === "open" && (row.kind === "project" || row.kind === "folder");
      if (opens) {
        write(replaceToken(draft, trigger, `@${row.label}/`));
        return;
      }
      if (full && !chosen.some((entry) => entry.key === row.key)) return;
      write(replaceToken(draft, trigger, referenceToken(row.ref)));
      setChosen((current) =>
        current.some((entry) => entry.key === row.key) ? current : [...current, { key: row.key, ref: row.ref }],
      );
    },
    [chosen, draft, full, suggestions, trigger, write],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // An input method is still composing the word: its Enter and arrows belong to it.
      if (!open || composing || event.nativeEvent.isComposing) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        // The composer's own Escape stops a reply; closing the picker is the whole of this one.
        event.stopPropagation();
        setDismissed(triggerKey);
        return true;
      }
      if (suggestions.length === 0) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + step + suggestions.length) % suggestions.length);
        return true;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        choose(activeIndex, event.key === "Tab" ? "open" : "pick");
        return true;
      }
      return false;
    },
    [activeIndex, choose, composing, open, suggestions.length, triggerKey],
  );

  const remove = useCallback(
    (key: string) => {
      const entry = chosen.find((candidate) => candidate.key === key);
      if (entry === undefined) return;
      setChosen((current) => current.filter((candidate) => candidate.key !== key));
      setDraft(withoutToken(draft, referenceToken(entry.ref)));
    },
    [chosen, draft, setDraft],
  );

  const insert = useCallback(
    (key: string, ref: ComposerReference): "added" | "already" | "full" => {
      const token = referenceToken(ref);
      const end = (text: string) => ({ draft: text, caret: text.length });
      if (live.some((entry) => entry.key === key)) {
        write(end(draft));
        return "already";
      }
      if (full) return "full";
      const before = draft === "" || /\s$/.test(draft) ? draft : `${draft} `;
      write(end(`${before}${token} `));
      setChosen((current) => [...current.filter((entry) => entry.key !== key), { key, ref }]);
      return "added";
    },
    [draft, full, live, write],
  );

  const clear = useCallback(() => setChosen([]), []);
  const leave = useCallback(() => setCaret(-1), []);

  return {
    open,
    trigger,
    suggestions: open ? suggestions : [],
    loading,
    failed,
    activeIndex,
    setActiveIndex,
    chosen,
    live,
    full,
    track,
    leave,
    setComposing,
    onKeyDown,
    choose,
    remove,
    insert,
    clear,
  };
}

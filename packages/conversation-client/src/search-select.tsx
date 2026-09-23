import { type ReactElement, useMemo, useState } from "react";

import { useT } from "./i18n/locale-context.tsx";

/** One choice in the list. */
export interface SearchSelectOption {
  readonly value: string;
  /** What is shown and searched over. Usually the same as the value. */
  readonly label: string;
  /** Shown faintly after the label, for something that narrows a choice without being part of it. */
  readonly note?: string;
}

export interface SearchSelectProps {
  /** Names the field in the DOM, so a test and a reader can tell the two apart. */
  name: string;
  options: readonly SearchSelectOption[];
  value: string;
  placeholder?: string;
  /** Called when a choice is made, and never while somebody is typing: a half-typed word is not a choice. */
  onChange: (value: string) => void;
  /** What the list says when the typing matches nothing. */
  emptyNote?: string;
}

/**
 * How many options are rendered at once.
 *
 * The provider list here is short and the model list is not - one provider on this machine offers several hundred - and
 * rendering all of them to hide almost all of them is work nobody sees. The typing is what narrows the list; this is
 * only a ceiling on what a DOM has to hold.
 */
export const SEARCH_SELECT_MAX_OPTIONS = 60;

/** The options matching what has been typed, bounded. Its own function because it is the part worth testing. */
export function matchingOptions(
  options: readonly SearchSelectOption[],
  query: string,
): readonly SearchSelectOption[] {
  const wanted = query.trim().toLowerCase();
  const matched =
    wanted === ""
      ? options
      : options.filter(
          (option) =>
            option.label.toLowerCase().includes(wanted) ||
            (option.note ?? "").toLowerCase().includes(wanted),
        );
  return matched.slice(0, SEARCH_SELECT_MAX_OPTIONS);
}

/**
 * A field that opens a list of choices and can be typed into.
 *
 * Not a native `select`: a list of several hundred is a scroll bar with no way to search it. Not an `input list` either,
 * which is what this replaced - the browser decides there whether to filter, whether to show an arrow and what the list
 * looks like, and different browsers answer differently, so the field looked unlike a dropdown on the machine it was
 * built on. What is left is the part they agree on: type to narrow, arrows to move, Enter to choose.
 *
 * Typing does not change the value. The node is given a choice it can run or refuses it, so a half-typed provider is not
 * a decision, and treating it as one would let the fields show a pair that does not exist.
 */
export function SearchSelect({
  name,
  options,
  value,
  placeholder,
  onChange,
  emptyNote,
}: SearchSelectProps): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matched = useMemo(() => matchingOptions(options, query), [options, query]);
  const shown = open ? query : value;

  const choose = (option: SearchSelectOption): void => {
    onChange(option.value);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="cc-search-select" data-search-select={name} data-open={open ? "true" : "false"}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`cc-search-list-${name}`}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        data-search-input={name}
        value={shown}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Closing restores what was there: an abandoned search is not an edit of the setting.
            setOpen(false);
            setQuery("");
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current) => Math.min(Math.max(current + step, 0), Math.max(matched.length - 1, 0)));
            return;
          }
          if (event.key === "Enter") {
            const option = matched[active];
            if (open && option !== undefined) {
              event.preventDefault();
              choose(option);
            }
          }
        }}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
      />
      {!open ? null : (
        <ul className="cc-search-list" id={`cc-search-list-${name}`} role="listbox">
          {matched.length === 0 ? (
            <li className="cc-search-empty" data-search-empty={name}>
              {emptyNote ?? t("settings.searchSelect.noMatches")}
            </li>
          ) : (
            matched.map((option, index) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                data-search-option={option.value}
                data-active={index === active ? "true" : "false"}
                // Mouse-down rather than click: the input's blur would close the list before a click landed on it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span>{option.label}</span>
                {option.note === undefined ? null : <em>{option.note}</em>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

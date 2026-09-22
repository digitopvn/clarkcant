/**
 * Where a checked-in PR body uses a closing keyword beside an issue reference.
 *
 * A sentence that says a change does *not* close an issue still contains the keyword next to the reference, and
 * GitHub's parser reads the pair rather than the sentence: this program's own PR bodies closed #93 and #125 that
 * way while each of them stated the opposite. The bodies are committed as a `pr-*-body.md` file in a plan
 * directory, so the mistake is catchable before the PR is ever created.
 *
 * GitHub matches a keyword only when the reference follows it on the same line, optionally after a colon, so that
 * is what this module reports: a reference on the following line closes nothing, and a sentence that merely names
 * an issue number is not this check's subject. The keyword is matched as a whole word, which is why "closing" and
 * "unclosed" do not match — neither does GitHub act on them.
 *
 * This lives outside check-invariants.mjs so the matching can be tested on its own.
 */

/** `close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`, then an issue reference. */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\b[ \t]*:?[ \t]*#(\d+)/giu;

/**
 * Every place in `text` where a closing keyword sits beside an issue reference.
 *
 * @param {string} text the whole body of one file
 * @returns {{line: number, keyword: string, reference: number, matched: string}[]}
 */
export function closingKeywordMatches(text) {
  const matches = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(CLOSING_KEYWORD)) {
      matches.push({
        line: index + 1,
        keyword: match[0].match(/[A-Za-z]+/u)?.[0] ?? "",
        reference: Number(match[1]),
        matched: match[0],
      });
    }
  }
  return matches;
}

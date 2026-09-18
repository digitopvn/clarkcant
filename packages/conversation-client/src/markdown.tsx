import hljs from "highlight.js/lib/common";
import { Lexer, type Token, type Tokens } from "marked";
import { type ReactElement, type ReactNode, useMemo } from "react";

/**
 * Markdown, rendered as React elements.
 *
 * The prose never becomes HTML. Every element in a message except highlighted code is built by React
 * from a token, so a model that writes `<img onerror=...>` gets a paragraph containing that text
 * rather than an element that runs. That is the whole reason for not calling `marked.parse` and
 * putting its string into the page: the reply is untrusted input, and the only sanitizer that cannot
 * be forgotten is the one where the HTML never exists.
 *
 * Code is the one exception, and it is safe for a different reason: `highlight.js` escapes the code
 * it is given before wrapping it in spans, so the HTML it returns contains nothing the input could
 * have contributed except text. `markdown.spec.tsx` asserts that with a script tag inside a fence.
 *
 * `breaks` is on because a message typed into a textarea is written with real newlines, and a single
 * newline in markdown would otherwise be joined into one paragraph — a regression the user would see
 * as "the app ate my line breaks".
 */

const LEXER_OPTIONS = { gfm: true, breaks: true } as const;

/** Schemes a link may carry. Anything else — `javascript:`, `data:` — is rendered as text. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function safeHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    return SAFE_SCHEMES.has(url.protocol) ? href : undefined;
  } catch {
    // A relative link has no scheme and is only meaningful inside a document tree this app does not
    // have, so it is text like any other unparseable target.
    return undefined;
  }
}

function inline(tokens: readonly Token[] | undefined, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  (tokens ?? []).forEach((token, index) => {
    const key = `${keyPrefix}-${index}`;
    nodes.push(inlineNode(token, key));
  });
  return nodes;
}

function inlineNode(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "text": {
      const text = (token as Tokens.Text).text;
      // A text token can still carry newlines even with `breaks`, so they are honoured here as well.
      return text.includes("\n") ? splitLines(text, key) : text;
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong":
      return <strong key={key}>{inline((token as Tokens.Strong).tokens, key)}</strong>;
    case "em":
      return <em key={key}>{inline((token as Tokens.Em).tokens, key)}</em>;
    case "del":
      return <del key={key}>{inline((token as Tokens.Del).tokens, key)}</del>;
    case "codespan":
      return (
        <code key={key} className="cc-md-inline-code">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case "br":
      return <br key={key} />;
    case "link": {
      const link = token as Tokens.Link;
      const href = safeHref(link.href);
      return href === undefined ? (
        <span key={key}>{inline(link.tokens, key)}</span>
      ) : (
        // `noopener`/`noreferrer` because a link in a reply leaves the app: without them the opened
        // page can navigate the window it came from.
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {inline(link.tokens, key)}
        </a>
      );
    }
    case "image": {
      // Deliberately not an `<img>`. A remote image in a reply is a request to a third party that
      // tells them the user read the message, and nothing in this interface ever asked for that.
      const image = token as Tokens.Image;
      const href = safeHref(image.href);
      return href === undefined ? (
        <span key={key}>{image.text}</span>
      ) : (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {image.text}
        </a>
      );
    }
    default: {
      const raw = (token as { raw?: unknown }).raw;
      return typeof raw === "string" ? raw : "";
    }
  }
}

function splitLines(text: string, key: string): ReactNode[] {
  const parts = text.split("\n");
  return parts.flatMap((part, index) =>
    index === parts.length - 1 ? [part] : [part, <br key={`${key}-br-${index}`} />],
  );
}

function list(token: Tokens.List, key: string): ReactElement {
  const ordered = token.ordered;
  const items = token.items.map((item, index) => (
    // Task list items carry their state on the token rather than in the text, so the glyph comes from
    // here: a checklist drawn as `[x]` text would be a list of characters that only looks like one.
    <li key={`${key}-li-${index}`} data-task={item.task ? String(item.checked === true) : undefined}>
      {item.task ? (
        <span className="cc-md-check" aria-hidden="true">
          {item.checked === true ? "✓" : "◯"}
        </span>
      ) : null}
      {item.tokens.map((inner, innerIndex) =>
        inner.type === "text" ? (
          inline(((inner as Tokens.Text).tokens ?? [inner]) as Token[], `${key}-${index}-${innerIndex}`)
        ) : (
          <div key={`${key}-${index}-${innerIndex}`}>{block(inner, `${key}-${index}-${innerIndex}`)}</div>
        ),
      )}
    </li>
  ));
  return ordered ? (
    <ol key={key} className="cc-md-list" start={token.start === "" ? undefined : token.start}>
      {items}
    </ol>
  ) : (
    <ul key={key} className="cc-md-list">
      {items}
    </ul>
  );
}

/**
 * Turn highlight.js output into React elements.
 *
 * This exists so that no HTML string is ever handed to the DOM. The alternative —
 * `dangerouslySetInnerHTML` with the highlighter's output — is what every example does, and it puts a
 * string built from a model's reply into the page: safe today only because highlight.js happens to
 * escape what it is given, and one dependency upgrade away from not being. Parsing the markup back
 * into elements means the reply's text is text again before it is rendered.
 *
 * Two details of the highlighter's real output are load-bearing, and both were found by a test rather
 * than by reading its documentation: a span's class attribute can carry more than one class
 * (`hljs-title function_` for a function name), and any character outside a recognised span must be
 * kept verbatim — dropping an angle bracket here prints code that is not the code.
 */
const HIGHLIGHT_TOKEN = /<span class="(hljs-[^"]*)">|<\/span>/g;

export function highlightNodes(html: string): ReactNode[] {
  const root: ReactNode[] = [];
  // One entry per open span, innermost last; text goes into whichever is currently innermost.
  const stack: { classes: string; children: ReactNode[] }[] = [];
  const current = (): ReactNode[] => (stack.length === 0 ? root : stack[stack.length - 1]!.children);
  let sequence = 0;
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text !== "") current().push(unescapeHtml(text));
  };

  /** Close one span, in place: the children array was pushed into its parent and becomes an element. */
  const close = (): void => {
    const node = stack.pop();
    if (node === undefined) return;
    const parent = current();
    const index = parent.lastIndexOf(node.children);
    const element = (
      // The index rather than the class name, because a sibling can have the same class and React
      // requires keys to be unique among siblings.
      <span key={`hl-${sequence++}`} className={node.classes}>
        {node.children.length === 1 ? node.children[0] : node.children}
      </span>
    );
    if (index >= 0) parent[index] = element;
    else parent.push(element);
  };

  for (const match of html.matchAll(HIGHLIGHT_TOKEN)) {
    pushText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const classes = match[1];
    if (classes !== undefined) {
      const node = { classes, children: [] as ReactNode[] };
      current().push(node.children);
      stack.push(node);
    } else {
      close();
    }
  }
  pushText(html.slice(cursor));

  // A span the highlighter opened and did not close. It does not happen, and the cost of assuming it
  // cannot is a stray array in the tree, so the innermost spans are closed the same way.
  while (stack.length > 0) close();
  return root;
}

/** The entities highlight.js escapes. Anything else is left exactly as it arrived. */
function unescapeHtml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function block(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      const content = inline(heading.tokens, key);
      // The level is kept as authored: a reply that uses a heading is using it to structure its own
      // text, and rewriting the levels would misrepresent that structure to a screen reader. The clamp
      // is for a depth outside 1..6, which markdown permits and HTML does not.
      const tags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
      const Tag = tags[Math.min(Math.max(heading.depth, 1), 6) - 1] ?? "h6";
      return <Tag key={key}>{content}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{inline((token as Tokens.Paragraph).tokens, key)}</p>;
    case "text": {
      const text = token as Tokens.Text;
      return <p key={key}>{inline(text.tokens ?? [text], key)}</p>;
    }
    case "code": {
      const code = token as Tokens.Code;
      return <CodeBlock key={key} code={code.text} {...(code.lang === undefined ? {} : { language: code.lang })} />;
    }
    case "blockquote":
      return <blockquote key={key}>{blocks((token as Tokens.Blockquote).tokens, key)}</blockquote>;
    case "list":
      return list(token as Tokens.List, key);
    case "hr":
      return <hr key={key} />;
    case "table": {
      const table = token as Tokens.Table;
      return (
        <div key={key} className="cc-md-table-wrap">
          <table className="cc-md-table">
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={`${key}-h-${index}`} data-align={cell.align ?? undefined}>
                    {inline(cell.tokens, `${key}-h-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={`${key}-r-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-r-${rowIndex}-c-${cellIndex}`} data-align={cell.align ?? undefined}>
                      {inline(cell.tokens, `${key}-r-${rowIndex}-c-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "html":
      // Rendered as literal text on purpose. See the note at the top of this file: a reply is
      // untrusted input, and the cheapest correct response to markup in it is to show the markup.
      return (
        <p key={key} className="cc-md-literal">
          {(token as Tokens.HTML).text}
        </p>
      );
    default: {
      const raw = (token as { raw?: unknown }).raw;
      return typeof raw === "string" && raw !== "" ? <p key={key}>{raw}</p> : null;
    }
  }
}

function blocks(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => block(token, `${keyPrefix}-${index}`));
}

export function Markdown({ text }: { text: string }): ReactElement {
  // Memoised on the text: a reply is re-rendered on every keystroke in the composer, and lexing a
  // whole message per keystroke is work that produces the same tree.
  const tokens = useMemo(() => Lexer.lex(text, LEXER_OPTIONS), [text]);
  return (
    <div className="cc-md" data-markdown="true">
      {markdownFromTokens(tokens)}
    </div>
  );
}

/**
 * The element tree for a message.
 *
 * Separate from the component, and hook-free, so the mapping from markdown to elements can be asserted
 * directly — including the property that matters most here, which is that nothing in the tree is an
 * HTML injection point.
 */
export function markdownFromTokens(tokens: readonly Token[]): ReactNode[] {
  return blocks(tokens, "md");
}

/** Markdown for a string, without a component. Used by the tests and by any caller that owns its own memo. */
export function markdownTree(text: string): ReactNode[] {
  return markdownFromTokens(Lexer.lex(text, LEXER_OPTIONS));
}

/**
 * A fenced code block's contents: the language that will actually be used, and the tokens for it.
 *
 * Pure and separate from the component so the two decisions in here can be tested without rendering:
 * an unknown language is not a failure but a reason to show plain code, and the header says `text`
 * rather than guessing at a language the highlighter does not have.
 */
export function highlightedCode(
  code: string,
  language?: string,
): { language: string; nodes: ReactNode[] | undefined } {
  const resolved = language !== undefined && hljs.getLanguage(language) !== undefined ? language : undefined;
  if (resolved === undefined) return { language: "text", nodes: undefined };
  return {
    language: resolved,
    nodes: highlightNodes(hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value),
  };
}

/**
 * A fenced code block, with its language in a header and its tokens coloured.
 *
 * An unknown or missing language is not an error: the block renders as plain code, which is what a
 * reply full of shell output or an invented language name should get.
 */
export function CodeBlock({ code, language, label }: { code: string; language?: string; label?: string }): ReactElement {
  const highlighted = useMemo(() => highlightedCode(code, language), [code, language]);

  return (
    <div className="cc-code" data-code-lang={highlighted.language}>
      <div className="cc-code-head">
        <span>{label ?? highlighted.language}</span>
      </div>
      <pre className="cc-code-body">
        {highlighted.nodes === undefined ? <code>{code}</code> : <code>{highlighted.nodes}</code>}
      </pre>
    </div>
  );
}

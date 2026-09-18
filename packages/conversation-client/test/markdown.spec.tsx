import hljs from "highlight.js/lib/common";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { highlightNodes, highlightedCode, markdownTree } from "../src/markdown.tsx";

/**
 * Markdown rendering, from the side that matters.
 *
 * A reply is untrusted input, so the property worth asserting is not "bold becomes <strong>" — it is
 * that nothing a reply contains can become an element this app did not choose. Every hostile case
 * below is written as "no element of this type exists", because that is the claim the renderer makes.
 *
 * The tree is inspected directly rather than rendered: React elements are plain objects, and this
 * suite runs in Node with no DOM on purpose (see `vitest.config.ts`). Rendering belongs to the browser
 * suite, which takes the screenshot.
 */

/** Every element in a tree, flattened, including nested children and arrays. */
function elements(nodes: ReactNode): ReactElement[] {
  const found: ReactElement[] = [];
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child as ReactNode);
      return;
    }
    if (!isValidElement(node)) return;
    found.push(node);
    visit((node.props as { children?: ReactNode }).children);
  };
  visit(nodes);
  return found;
}

function typesOf(nodes: ReactNode): string[] {
  return elements(nodes).map((element) =>
    typeof element.type === "string" ? element.type : ((element.type as { name?: string }).name ?? "component"),
  );
}

/** All text in a tree, joined. */
function textOf(nodes: ReactNode): string {
  let text = "";
  const visit = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child as ReactNode);
      return;
    }
    if (typeof node === "string" || typeof node === "number") {
      text += String(node);
      return;
    }
    if (isValidElement(node)) visit((node.props as { children?: ReactNode }).children);
  };
  visit(nodes);
  return text;
}

describe("a message becomes elements, not markup", () => {
  it("renders the structures a reply actually uses", () => {
    const tree = markdownTree("# Title\n\nSome **bold** and *soft* text with `code`.\n\n- one\n- two\n\n> quoted\n\n---\n");

    expect(typesOf(tree)).toContain("h1");
    expect(typesOf(tree)).toContain("strong");
    expect(typesOf(tree)).toContain("em");
    expect(typesOf(tree)).toContain("ul");
    expect(typesOf(tree)).toContain("blockquote");
    expect(typesOf(tree)).toContain("hr");
    expect(textOf(tree)).toContain("Title");
    expect(textOf(tree)).toContain("one");
  });

  it("colours a fenced block and hands the language to the renderer", () => {
    const tree = markdownTree("```ts\nconst answer = 42;\n```\n");
    const block = elements(tree).find((element) => (element.type as { name?: string }).name === "CodeBlock");
    expect(block).toBeDefined();
    // The lexer hands over the code without the newline that closed the fence.
    expect(block?.props).toMatchObject({ code: "const answer = 42;", language: "ts" });
  });

  it("leaves no HTML injection point anywhere in the tree", () => {
    // The assertion the whole design of this file exists for: whatever a reply contains, the tree
    // holds no property that puts a string into the DOM as markup.
    for (const text of [
      "# Title\n\n```ts\nconst x = 1;\n```\n",
      "<img src=x onerror=alert(1)>\n",
      '<script>alert("x")</script>\n',
      "a <b>bold attempt</b> b\n",
      "| a | b |\n|---|---|\n| 1 | 2 |\n",
    ]) {
      for (const element of elements(markdownTree(text))) {
        expect(Object.keys(element.props as object)).not.toContain("dangerouslySetInnerHTML");
      }
    }
  });

  it("shows raw HTML in a reply as text", () => {
    const tree = markdownTree('<script>alert("x")</script>\n');
    expect(typesOf(tree)).not.toContain("script");
    expect(textOf(tree)).toContain('<script>alert("x")</script>');
  });

  it("refuses a link that is not a link", () => {
    const hostile = markdownTree("[click me](javascript:alert(1))\n");
    expect(typesOf(hostile)).not.toContain("a");
    expect(textOf(hostile)).toContain("click me");

    const ordinary = markdownTree("[docs](https://example.com/x)\n");
    const anchor = elements(ordinary).find((element) => element.type === "a");
    expect(anchor?.props).toMatchObject({ href: "https://example.com/x", rel: "noopener noreferrer", target: "_blank" });
  });

  it("does not fetch a remote image a reply points at", () => {
    // An `<img>` in a reply is a request to a third party that tells them the user read the message.
    const tree = markdownTree("![a picture](https://tracker.example.com/pixel.png)\n");
    expect(typesOf(tree)).not.toContain("img");
    expect(textOf(tree)).toContain("a picture");
  });

  it("keeps the newlines of a message typed into a field", () => {
    // A textarea writes real newlines, and markdown would join them into one paragraph.
    const tree = markdownTree("first line\nsecond line\n");
    expect(typesOf(tree)).toContain("br");
    expect(textOf(tree)).toContain("first linesecond line");
  });

  it("renders a table with its cells", () => {
    const tree = markdownTree("| Name | Value |\n|---|---:|\n| a | 1 |\n");
    expect(typesOf(tree)).toContain("table");
    expect(typesOf(tree)).toContain("th");
    expect(textOf(tree)).toContain("Name");
    expect(textOf(tree)).toContain("1");
  });

  it("renders a fence the model has not closed yet, which is what streaming looks like", () => {
    const tree = markdownTree("Here is the fix:\n\n```ts\nconst partial = ");
    const block = elements(tree).find((element) => (element.type as { name?: string }).name === "CodeBlock");
    expect(block?.props).toMatchObject({ code: "const partial = " });
    expect(textOf(tree)).toContain("Here is the fix:");
  });
});

describe("highlighted code becomes elements", () => {
  it("keeps the spans and the text of a real highlight", () => {
    const html = hljs.highlight("const answer = 42; // note", { language: "typescript" }).value;
    const nodes = highlightNodes(html);
    const classes = elements(nodes).map((element) => (element.props as { className?: string }).className);

    expect(classes).toContain("hljs-keyword");
    expect(classes).toContain("hljs-number");
    expect(textOf(nodes)).toBe("const answer = 42; // note");
  });

  it("handles nesting, which is what a function declaration produces", () => {
    const html = hljs.highlight("function f() { return 1; }", { language: "javascript" }).value;
    const nodes = highlightNodes(html);
    // The highlighter nests `hljs-title` inside `hljs-function`; a flat parse would lose one of them.
    expect(typesOf(nodes)).toContain("span");
    expect(textOf(nodes)).toBe("function f() { return 1; }");
  });

  it("unescapes what the highlighter escaped, so the code reads as it was written", () => {
    const html = hljs.highlight('if (a < b && c > "d") {}', { language: "typescript" }).value;
    expect(textOf(highlightNodes(html))).toBe('if (a < b && c > "d") {}');
  });

  it("keeps markup that is not a span as literal text", () => {
    // The parser is strict on purpose: a surprise in the highlighter's output shows up as characters
    // rather than as an element.
    const nodes = highlightNodes('<b>bold</b> plain');
    expect(typesOf(nodes)).toEqual([]);
    expect(textOf(nodes)).toBe("<b>bold</b> plain");
  });

  it("renders code with no known language as plain code", () => {
    expect(highlightedCode("SELECT 1;", "nosuchlanguage")).toEqual({ language: "text", nodes: undefined });
    expect(highlightedCode("SELECT 1;")).toEqual({ language: "text", nodes: undefined });
    // And a language it does have comes back with tokens rather than as plain text.
    const known = highlightedCode("SELECT 1;", "sql");
    expect(known.language).toBe("sql");
    expect(known.nodes).toBeDefined();
  });
});

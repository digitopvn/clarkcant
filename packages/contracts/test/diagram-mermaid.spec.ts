import { describe, expect, it } from "vitest";

import { MAX_MERMAID_SOURCE, diagramProblems, diagramPropsFromInput, parseMermaidFlowchart } from "../src/index.ts";

function problem(source: string): string {
  const read = parseMermaidFlowchart(source);
  if (read.ok) throw new Error(`expected a refusal for ${source}`);
  return read.problems.join(" ");
}

describe("the Mermaid flowchart subset", () => {
  it("reads nodes, the four shapes, link kinds and labels into the diagram model", () => {
    const read = parseMermaidFlowchart(
      [
        "%% a comment",
        "flowchart LR",
        "  accTitle: Release",
        "  plan(Plan) --> build[Build]",
        "  build -->|ok| check{Tests pass?}",
        "  check -- no --> build",
        '  check ---> ship(("Ship [now]"))',
        "  ship --- docs; docs <--> plan",
      ].join("\r\n"),
    );
    expect(read).toEqual({
      ok: true,
      props: {
        title: "Release",
        direction: "LR",
        nodes: [
          { id: "plan", label: "Plan", shape: "round" },
          { id: "build", label: "Build" },
          { id: "check", label: "Tests pass?", shape: "diamond" },
          { id: "ship", label: "Ship [now]", shape: "circle" },
          { id: "docs", label: "docs" },
        ],
        edges: [
          { from: "plan", to: "build" },
          { from: "build", to: "check", label: "ok" },
          { from: "check", to: "build", label: "no" },
          { from: "check", to: "ship" },
          { from: "ship", to: "docs", direction: "none" },
          { from: "docs", to: "plan", direction: "both" },
        ],
      },
    });
    if (read.ok) expect(diagramProblems(read.props)).toEqual([]);
  });

  it("maps one level of subgraph to groups and TD and graph to the same model", () => {
    const read = parseMermaidFlowchart("graph TD\nsubgraph ci [Continuous integration]\n  a[Build] --> b[Test]\nend\nb --> c[Ship]");
    expect(read.ok && read.props).toMatchObject({
      direction: "TB",
      nodes: [
        { id: "a", group: "Continuous integration" },
        { id: "b", group: "Continuous integration" },
        { id: "c", label: "Ship" },
      ],
    });
    expect(read.ok && read.props.nodes[2]).not.toHaveProperty("group");
  });

  it.each([
    ["an HTML label", 'flowchart TB\na["<b>bold</b>"]', /HTML/u],
    ["an unquoted HTML label", "flowchart TB\na[<img src=x onerror=alert(1)>]", /HTML/u],
    ["an entity code", "flowchart TB\na[#quot;hi#quot;]", /entity/u],
    ["a Markdown string", 'flowchart TB\na["`**bold**`"]', /Markdown/u],
    ["an icon", "flowchart TB\na[fa:fa-car Car]", /icon/u],
    ["a click callback", "flowchart TB\na --> b\nclick a callback", /"click" is not read/u],
    ["a click link", 'flowchart TB\na --> b\nclick a "https://example.com"', /"click" is not read/u],
    ["an href", 'flowchart TB\nhref a "https://example.com"', /"href" is not read/u],
    ["an init directive", "%%{init: {'theme':'dark'}}%%\nflowchart TB\na --> b", /directives are not read/u],
    ["an init directive inside", "flowchart TB\n%%{init: {'securityLevel':'loose'}}%%\na --> b", /directives are not read/u],
    ["front matter", "---\ntitle: x\n---\nflowchart TB\na --> b", /front matter/u],
    ["a style", "flowchart TB\na --> b\nstyle a fill:#f9f", /"style" is not read/u],
    ["a classDef", "flowchart TB\nclassDef red fill:#f00", /"classDef" is not read/u],
    ["a class", "flowchart TB\na --> b\nclass a red", /"class" is not read/u],
    ["a ::: class", "flowchart TB\na:::red --> b", /::: applies a CSS class/u],
    ["a linkStyle", "flowchart TB\na --> b\nlinkStyle 0 stroke:#f00", /"linkStyle" is not read/u],
    ["a sequence diagram", "sequenceDiagram\nAlice->>Bob: hi", /"sequenceDiagram" is not a flowchart/u],
    ["a class diagram", "classDiagram\nA <|-- B", /"classDiagram" is not a flowchart/u],
    ["a renderer variant", "flowchart-elk TB\na --> b", /"flowchart-elk" is not a flowchart/u],
    ["a thick link", "flowchart TB\na ==> b", /not read; only -->/u],
    ["a dotted link", "flowchart TB\na -.-> b", /not read; only -->/u],
    ["a circle end", "flowchart TB\na --o b", /not read; only -->/u],
    ["a cross end", "flowchart TB\na --x b", /not read; only -->/u],
    ["an unsupported shape", "flowchart TB\na[[Sub]] --> b", /only \[box\]/u],
    ["a hexagon", "flowchart TB\na{{Hex}}", /only \[box\]/u],
    ["an expanded shape", "flowchart TB\na@{ shape: cyl }", /only \[box\]/u],
    ["an & chain", "flowchart TB\na & b --> c", /& joins/u],
    ["a nested subgraph", "flowchart TB\nsubgraph one\nsubgraph two\na\nend\nend", /one level/u],
    ["a subgraph direction", "flowchart TB\nsubgraph one\ndirection LR\na\nend", /"direction" is not read/u],
    ["a link to a subgraph", "flowchart TB\nsubgraph one\na\nend\nb --> one", /links to a subgraph/u],
    ["an unclosed subgraph", "flowchart TB\nsubgraph one\na", /never closed/u],
    ["a right-to-left direction", "flowchart RL\na --> b", /RL is not drawn/u],
    ["two labels for one node", "flowchart TB\na[One] --> b\na[Two]", /two different labels/u],
    ["an empty source", "%% only a comment", /the source is empty/u],
  ])("refuses %s", (_name, source, expected) => {
    expect(problem(source)).toMatch(expected);
  });

  it("names the line a refusal comes from", () => {
    expect(problem("flowchart TB\na --> b\nclick a call()")).toMatch(/^mermaid line 3: /u);
  });

  it("refuses hidden characters and oversized sources before reading them", () => {
    expect(problem("flowchart TB\na[A‮B]")).toMatch(/U\+202E/u);
    expect(problem(`flowchart TB\n${"a --> b\n".repeat(MAX_MERMAID_SOURCE)}`)).toMatch(/at most 8000 are read/u);
    expect(problem(`flowchart TB${"\n".repeat(401)}`)).toMatch(/at most 400 are read/u);
    expect(parseMermaidFlowchart(42)).toEqual({ ok: false, problems: ["mermaid is the flowchart's source text"] });
  });

  it("turns { mermaid } props into the model and refuses a source given with a model", () => {
    expect(diagramPropsFromInput({ nodes: [] })).toEqual({ ok: true, props: { nodes: [] } });
    expect(diagramPropsFromInput({ mermaid: "flowchart TB\na --> b", title: "Two", layout: "tree" })).toEqual({
      ok: true,
      props: { title: "Two", layout: "tree", direction: "TB", nodes: [{ id: "a", label: "a" }, { id: "b", label: "b" }], edges: [{ from: "a", to: "b" }] },
    });
    const both = diagramPropsFromInput({ mermaid: "flowchart TB\na", nodes: [] });
    expect(both.ok).toBe(false);
    expect(!both.ok && both.problems[0]).toMatch(/not both: drop nodes/u);
  });
});

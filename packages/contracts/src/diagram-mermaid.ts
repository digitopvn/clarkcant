import { hiddenCharacterProblem } from "./text-rules.ts";

/**
 * A subset of Mermaid's flowchart syntax, read on the host into the diagram model.
 *
 * Mermaid's own renderer is never loaded: it builds HTML labels, runs `click` callbacks, applies `%%{init}%%`
 * configuration and styles, and fetches icons, which is everything a model-supplied diagram must not do. Instead the host
 * reads the plain part of the syntax — nodes, their four shapes, links and their labels, one level of `subgraph` as a
 * group — into the same props a diagram is drawn from, and refuses everything else by name rather than dropping it, so a
 * diagram is never drawn differently from what was written. The source itself is never stored.
 */

export const MAX_MERMAID_SOURCE = 8000;
export const MAX_MERMAID_LINES = 400;

/** What a flowchart becomes: the props of `canvas.diagram@1`, before `diagramProblems` checks them. */
export interface MermaidDiagramProps {
  title?: string;
  layout?: "layered" | "tree";
  direction: "TB" | "LR";
  nodes: { id: string; label: string; shape?: "round" | "diamond" | "circle"; group?: string }[];
  edges: { from: string; to: string; label?: string; direction?: "both" | "none" }[];
}

export type MermaidReading = { ok: true; props: MermaidDiagramProps } | { ok: false; problems: string[] };

/** Statements Mermaid runs, styles or links with; none of them describes a node or an edge. */
const FORBIDDEN_STATEMENTS = new Map<string, string>([
  ["click", "a click runs a callback or opens a link"],
  ["href", "a link opens a page"],
  ["call", "a call runs a callback"],
  ["style", "a style is raw CSS"],
  ["classdef", "a class definition is raw CSS"],
  ["class", "a class applies raw CSS"],
  ["linkstyle", "a link style is raw CSS"],
  ["direction", "a subgraph's own direction is not drawn"],
]);

const ID = /^[A-Za-z0-9_]+/u;
const PLAIN_LINK = "only -->, --- and <--> links are read";

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

/** A label as plain text, or why it is not one: no HTML, entity codes, Markdown strings or icons. */
function plainLabel(raw: string, what: string): string {
  let text = raw.trim();
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) refuse(`${what} opens a quote it does not close`);
    text = text.slice(1, -1).trim();
    if (text.startsWith("`")) refuse(`${what} is a Markdown string; labels are plain text`);
  }
  if (text.includes('"')) refuse(`${what} has a quote inside it; quote the whole label once`);
  if (/<\/?[A-Za-z!]/u.test(text)) refuse(`${what} holds HTML; labels are plain text`);
  if (/[&#][A-Za-z0-9]+;/u.test(text)) refuse(`${what} holds an entity code; write the character itself`);
  if (/\bfab?:fa-/u.test(text)) refuse(`${what} names an icon; icons are not drawn`);
  return text;
}

/** Split a line into statements at `;` outside quotes, brackets and link labels. */
function statements(line: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let piped = false;
  let depth = 0;
  let current = "";
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === "|") piped = !piped;
    else if (!quoted && "[({".includes(character)) depth += 1;
    else if (!quoted && "])}".includes(character)) depth = Math.max(0, depth - 1);
    if (character === ";" && !quoted && !piped && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

interface NodeShape {
  open: string;
  close: string;
  shape?: "round" | "diamond" | "circle";
}

/** The four shapes read, longest opening first so `((` is a circle and not a round node holding `(`. */
const SHAPES: NodeShape[] = [
  { open: "((", close: "))", shape: "circle" },
  { open: "[", close: "]" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
];

/** Openings Mermaid reads as another shape; each is refused instead of being drawn as one of the four. */
const OTHER_SHAPES = ["(((", "([", "[[", "[(", "[/", "[\\", "{{", ">", "@{"];

interface ReadNode {
  id: string;
  label?: string;
  shape?: "round" | "diamond" | "circle";
  /** Index just past the node in the statement. */
  end: number;
}

function readNode(text: string, at: number): ReadNode {
  const rest = text.slice(at);
  const id = ID.exec(rest)?.[0];
  if (id === undefined) refuse(`expected a node id (letters, digits and _) at "${rest.slice(0, 20)}"`);
  let end = at + id.length;
  const after = text.slice(end);
  if (after.startsWith(":::")) refuse("::: applies a CSS class; classes are not read");
  const other = OTHER_SHAPES.find((open) => after.startsWith(open));
  if (other !== undefined) refuse(`node ${id} uses the shape "${other}"; only [box], (round), {diamond} and ((circle)) are read`);
  const shape = SHAPES.find((candidate) => after.startsWith(candidate.open));
  if (shape === undefined) return { id, end };
  const inner = after.slice(shape.open.length);
  // A quoted label runs to its closing quote, so a bracket inside the quotes does not end it.
  const closeAt = inner.trimStart().startsWith('"')
    ? inner.indexOf(shape.close, inner.indexOf('"', inner.indexOf('"') + 1) + 1)
    : inner.indexOf(shape.close);
  if (closeAt < 0) refuse(`node ${id} opens "${shape.open}" and never closes it with "${shape.close}"`);
  const label = plainLabel(inner.slice(0, closeAt), `the label of ${id}`);
  if (label === "") refuse(`node ${id} has an empty label`);
  end += shape.open.length + closeAt + shape.close.length;
  return { id, label, ...(shape.shape === undefined ? {} : { shape: shape.shape }), end };
}

interface ReadLink {
  direction?: "both" | "none";
  label?: string;
  end: number;
}

function readLink(text: string, at: number): ReadLink {
  const rest = text.slice(at);
  // Thick, dotted and invisible links, and circle or cross ends, are other kinds of link than the three drawn.
  if (/^(?:==|-\.|~~~|[ox]--|<?-{2,}[ox](?:[\s|]|$))/u.test(rest)) refuse(`the link "${rest.slice(0, 5).trim()}" is not read; ${PLAIN_LINK}`);
  // `-- text -->` and `<-- text -->`: a label written inside the link.
  const inline = /^(<)?--\s+(.+?)\s+(-{2,}>|-{3,})/u.exec(rest);
  const plain = /^(<)?(-{2,}>|-{3,})/u.exec(rest);
  const matched = inline ?? plain;
  if (matched === null) refuse(`expected a link at "${rest.slice(0, 20)}"; ${PLAIN_LINK}`);
  const both = matched[1] === "<";
  const arrow = inline === null ? (matched[2] ?? "") : (matched[3] ?? "");
  const pointed = arrow.endsWith(">");
  if (both && !pointed) refuse(`the link "${matched[0]}" points back but not forward; ${PLAIN_LINK}`);
  let end = at + matched[0].length;
  // Mermaid reads `---o` and `-->x` as circle and cross ends, so a node whose id starts with o or x needs a space first.
  if (/^[ox]/u.test(text.slice(end))) {
    refuse(`the link "${text.slice(at, end + 1)}" is not read; ${PLAIN_LINK} (put a space before a node id starting with o or x)`);
  }
  let label = inline === null ? undefined : plainLabel(inline[2] ?? "", "a link label");
  const piped = text.slice(end);
  if (piped.startsWith("|")) {
    if (label !== undefined) refuse("a link has two labels");
    const close = piped.indexOf("|", 1);
    if (close < 0) refuse("a link label opens | and never closes it");
    label = plainLabel(piped.slice(1, close), "a link label");
    end += close + 1;
  }
  const direction = both ? "both" : pointed ? undefined : "none";
  return { ...(direction === undefined ? {} : { direction }), ...(label === undefined || label === "" ? {} : { label }), end };
}

function skipSpace(text: string, at: number): number {
  let next = at;
  while (next < text.length && /\s/u.test(text[next] ?? "")) next += 1;
  return next;
}

function header(line: string): "TB" | "LR" {
  const [keyword = "", direction, ...extra] = line.replace(/;\s*$/u, "").trim().split(/\s+/u);
  if (keyword !== "flowchart" && keyword !== "graph") {
    refuse(`"${keyword.slice(0, 40)}" is not a flowchart; only flowchart and graph diagrams are read`);
  }
  if (extra.length > 0) refuse(`the header has more than a direction: "${line.slice(0, 60)}"`);
  if (direction === undefined || direction === "TB" || direction === "TD") return "TB";
  if (direction === "LR") return "LR";
  if (direction === "RL" || direction === "BT") refuse(`the direction ${direction} is not drawn; use TB or LR`);
  return refuse(`"${direction.slice(0, 20)}" is not a direction; use TB or LR`);
}

/** Read a Mermaid flowchart into diagram props, or say, by line, what in it is not read. */
export function parseMermaidFlowchart(source: unknown): MermaidReading {
  if (typeof source !== "string") return { ok: false, problems: ["mermaid is the flowchart's source text"] };
  if (source.length > MAX_MERMAID_SOURCE) {
    return { ok: false, problems: [`the mermaid source is ${String(source.length)} characters; at most ${String(MAX_MERMAID_SOURCE)} are read`] };
  }
  const normalized = source.replace(/\r\n?/gu, "\n");
  const hidden = hiddenCharacterProblem(normalized, { lineBreaks: true });
  if (hidden !== undefined) return { ok: false, problems: [`the mermaid source ${hidden}`] };
  const lines = normalized.split("\n");
  if (lines.length > MAX_MERMAID_LINES) {
    return { ok: false, problems: [`the mermaid source has ${String(lines.length)} lines; at most ${String(MAX_MERMAID_LINES)} are read`] };
  }

  const nodes = new Map<string, { id: string; label?: string; shape?: "round" | "diamond" | "circle"; group?: string }>();
  const edges: MermaidDiagramProps["edges"] = [];
  const subgraphIds = new Set<string>();
  let direction: "TB" | "LR" | undefined;
  let title: string | undefined;
  let group: string | undefined;
  let lineNumber = 0;

  const meet = (found: ReadNode): void => {
    if (subgraphIds.has(found.id)) refuse(`${found.id} is a subgraph; links to a subgraph are not read`);
    const known = nodes.get(found.id);
    if (known === undefined) {
      nodes.set(found.id, {
        id: found.id,
        ...(found.label === undefined ? {} : { label: found.label }),
        ...(found.shape === undefined ? {} : { shape: found.shape }),
        ...(group === undefined ? {} : { group }),
      });
      return;
    }
    if (found.label === undefined) return;
    if (known.label !== undefined && (known.label !== found.label || known.shape !== found.shape)) {
      refuse(`node ${found.id} is given two different labels or shapes`);
    }
    known.label = found.label;
    if (found.shape !== undefined) known.shape = found.shape;
  };

  try {
    for (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed.startsWith("%%{")) refuse("%%{ }%% configures Mermaid's renderer; directives are not read");
      if (trimmed.startsWith("%%")) continue;
      let parts = statements(trimmed);
      if (direction === undefined) {
        if (trimmed === "---") refuse("front matter configures Mermaid's renderer; it is not read");
        direction = header(parts[0] ?? "");
        parts = parts.slice(1);
      }
      for (const statement of parts) {
        const keyword = /^[A-Za-z]+/u.exec(statement)?.[0] ?? "";
        const lowered = keyword.toLowerCase();
        const afterKeyword = statement.slice(keyword.length);
        const isKeyword = afterKeyword === "" || /^\s/u.test(afterKeyword) || afterKeyword.startsWith(":");
        if (isKeyword && FORBIDDEN_STATEMENTS.has(lowered)) refuse(`"${keyword}" is not read: ${FORBIDDEN_STATEMENTS.get(lowered) ?? ""}`);
        if (keyword === "accTitle" && afterKeyword.trimStart().startsWith(":")) {
          title = plainLabel(afterKeyword.trimStart().slice(1), "the title");
          continue;
        }
        if (keyword === "accDescr") {
          if (!afterKeyword.trimStart().startsWith(":")) refuse("a multi-line accDescr is not read; write it on one line with accDescr:");
          continue;
        }
        if (keyword === "subgraph" && isKeyword) {
          if (group !== undefined) refuse("a subgraph inside a subgraph is not read; groups are one level");
          const body = afterKeyword.trim();
          // `subgraph id [Title]`, `subgraph id`, or `subgraph Title`: the title is what a reader sees as the group.
          const titled = /^([A-Za-z0-9_]+)\s*\[(.*)\]$/u.exec(body);
          let name: string;
          if (titled !== null) {
            name = plainLabel(titled[2] ?? "", `the title of subgraph ${titled[1] ?? ""}`);
            subgraphIds.add(titled[1] ?? "");
          } else {
            if (body.includes("[")) refuse("a subgraph title opens [ and never closes it");
            name = plainLabel(body, "a subgraph title");
            if (ID.exec(body)?.[0] === body) subgraphIds.add(body);
          }
          if (name === "") refuse("a subgraph needs a title");
          group = name;
          continue;
        }
        if (keyword === "end" && isKeyword && afterKeyword.trim() === "") {
          if (group === undefined) refuse("end closes no subgraph");
          group = undefined;
          continue;
        }
        let at = 0;
        let from = readNode(statement, at);
        meet(from);
        at = skipSpace(statement, from.end);
        while (at < statement.length) {
          if (statement[at] === "&") refuse("& joins several nodes in one link; write each link on its own");
          const link = readLink(statement, at);
          at = skipSpace(statement, link.end);
          const to = readNode(statement, at);
          meet(to);
          edges.push({
            from: from.id,
            to: to.id,
            ...(link.label === undefined ? {} : { label: link.label }),
            ...(link.direction === undefined ? {} : { direction: link.direction }),
          });
          from = to;
          at = skipSpace(statement, to.end);
        }
      }
    }
    lineNumber = 0;
    if (direction === undefined) refuse("the source is empty; start it with flowchart TB or flowchart LR");
    if (group !== undefined) refuse(`subgraph ${group} is never closed with end`);
  } catch (error) {
    if (error instanceof Refusal) {
      const where = lineNumber === 0 ? "mermaid" : `mermaid line ${String(lineNumber)}`;
      return { ok: false, problems: [`${where}: ${error.message}`] };
    }
    throw error;
  }

  for (const id of subgraphIds) if (nodes.has(id)) return { ok: false, problems: [`mermaid: ${id} is both a node and a subgraph`] };
  return {
    ok: true,
    props: {
      ...(title === undefined || title === "" ? {} : { title }),
      direction: direction ?? "TB",
      nodes: [...nodes.values()].map((node) => ({ ...node, label: node.label ?? node.id })),
      edges,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The diagram props a `show_view` asked for: the model as given, or the model read from its `mermaid` source.
 *
 * `{ mermaid, title?, layout? }` is the only other form: a source and a model together would leave it unclear which one is
 * drawn, so that is refused rather than one silently winning.
 */
export function diagramPropsFromInput(input: unknown): { ok: true; props: unknown } | { ok: false; problems: string[] } {
  if (!record(input) || !("mermaid" in input)) return { ok: true, props: input };
  const extra = Object.keys(input).filter((key) => key !== "mermaid" && key !== "title" && key !== "layout");
  if (extra.length > 0) {
    return { ok: false, problems: [`a diagram is given as mermaid or as nodes and edges, not both: drop ${extra.slice(0, 5).join(", ")}`] };
  }
  const read = parseMermaidFlowchart(input.mermaid);
  if (!read.ok) return read;
  return {
    ok: true,
    props: {
      ...read.props,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.layout === undefined ? {} : { layout: input.layout }),
    },
  };
}

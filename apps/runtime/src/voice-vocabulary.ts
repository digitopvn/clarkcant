import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ConversationId, RecognitionContext } from "@clarkcant/contracts";
import { latestMessages, listProjects } from "@clarkcant/storage";
import { type VocabularySources, buildRecognitionContext, vocabularyFromText } from "@clarkcant/voice-adapters";

import type { SpeechLocale } from "./application/action-speech.ts";
import { textOfMessage } from "./session-search.ts";
import type { NodeServices } from "./services.ts";

/**
 * The words this node expects to hear, gathered when a voice session opens.
 *
 * Everything is read here, on the node, and only the ranked, bounded and redacted term list leaves it - as the
 * vocabulary a recognizer is given. That list does include terms extracted from the conversation (identifiers, paths,
 * branch names and issue numbers it mentions); the conversation's sentences themselves are never sent, and an absolute
 * project path is never a term.
 *
 * Every source is best effort and bounded in time: a voice session that waited on a slow skill catalogue would be a
 * session that does not start, and a vocabulary missing one source is still a better vocabulary than none.
 */

/** How many recent messages rank the vocabulary. */
const RECENT_MESSAGES = 40;
/** How many projects contribute their names. */
const PROJECTS = 12;
/** How many indexed projects are looked through for the one the conversation is about. */
const PROJECTS_SEARCHED = 200;
/** A name shorter than this is too common a word to say which project a conversation is about. */
const MIN_PROJECT_NAME = 3;
/** Dependencies taken from the active project's manifest. */
const MANIFEST_DEPENDENCIES = 40;
/** A manifest larger than this is not read: it is not a hand-written package.json. */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** One slow source does not hold a session open longer than this. */
const SOURCE_TIMEOUT_MS = 1000;

export interface VoiceVocabularyInput {
  conversationId: ConversationId | undefined;
  locale: SpeechLocale;
}

/** The session vocabulary. Never rejects: a source that fails is left out, and the glossary alone is a valid context. */
export async function voiceRecognitionContext(services: NodeServices, input: VoiceVocabularyInput): Promise<RecognitionContext> {
  const { db, identity } = services.runtime;
  const indexed = safely(() => listProjects(db, identity.nodeId, PROJECTS_SEARCHED), []);
  const recentText =
    input.conversationId === undefined
      ? []
      : safely(() => latestMessages(db, input.conversationId as string, RECENT_MESSAGES), [])
          .map((message) => textOfMessage(message))
          .filter((text) => text !== "")
          .reverse();
  const active = conversationProject(indexed, recentText);
  const projects = [...(active === undefined ? [] : [active]), ...indexed.filter((project) => project !== active)].slice(0, PROJECTS);
  const [manifest, branch, skills, extensions] = await Promise.all([
    active === undefined ? Promise.resolve(undefined) : bounded(readManifest(active.path)),
    active === undefined ? Promise.resolve(undefined) : bounded(readBranch(active.path)),
    services.skills === undefined ? Promise.resolve(undefined) : bounded(services.skills.list()),
    services.extensions === undefined ? Promise.resolve(undefined) : bounded(services.extensions()),
  ]);
  const model = safely(() => services.currentModel?.(), undefined);
  const mentioned = vocabularyFromText(recentText);

  const sources: VocabularySources = {
    repositories: projects.flatMap((project) => [project.name, ...project.aliases]),
    packages: manifest ?? [],
    paths: mentioned.paths ?? [],
    branches: [...(branch === undefined ? [] : [branch]), ...(mentioned.branches ?? [])],
    symbols: mentioned.symbols ?? [],
    issues: mentioned.issues ?? [],
    tools: [...(skills ?? []).map((skill) => skill.name), ...(extensions ?? []).map((extension) => extension.name)],
    models: model === undefined ? [] : [model.id],
    providers: model === undefined ? [] : [model.provider],
    recentText,
  };
  return buildRecognitionContext(sources, { languageHints: languageHintsFor(input.locale) });
}

/**
 * The project this conversation is about: the one it named most recently, by name or alias.
 *
 * A conversation is not bound to a project in storage, so its own words are the evidence. Without a mention there is
 * no active project, and no manifest or branch is read: the node's most recently used project may belong to a
 * different conversation entirely, and its dependencies would bias recognition towards the wrong words.
 */
export function conversationProject<Project extends { name: string; aliases: readonly string[] }>(
  projects: readonly Project[],
  recentText: readonly string[],
): Project | undefined {
  const named = projects.map((project) => ({
    project,
    patterns: [project.name, ...project.aliases]
      .map((name) => name.trim())
      .filter((name) => name.length >= MIN_PROJECT_NAME)
      .map((name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-])`, "iu")),
  }));
  for (let index = recentText.length - 1; index >= 0; index -= 1) {
    const text = recentText[index]!;
    const found = named.find((entry) => entry.patterns.some((pattern) => pattern.test(text)));
    if (found !== undefined) return found.project;
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The person's language first, English second: the sentences are theirs, the identifiers are mostly English. */
export function languageHintsFor(locale: SpeechLocale): string[] {
  return locale === "en" ? ["en-US", "vi-VN"] : ["vi-VN", "en-US"];
}

/** The package name and its dependency names, from the project's own manifest. */
async function readManifest(projectPath: string): Promise<string[]> {
  const file = join(projectPath, "package.json");
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return [];
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return [];
  const manifest = parsed as Record<string, unknown>;
  const names: string[] = [];
  if (typeof manifest["name"] === "string") names.push(manifest["name"]);
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = manifest[field];
    if (typeof deps === "object" && deps !== null) names.push(...Object.keys(deps));
  }
  return names.slice(0, MANIFEST_DEPENDENCIES);
}

/** The checked-out branch, from `.git/HEAD`, following a worktree's `gitdir:` pointer. */
async function readBranch(projectPath: string): Promise<string | undefined> {
  const dotGit = join(projectPath, ".git");
  const info = await stat(dotGit);
  let gitDir = dotGit;
  if (info.isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8"));
    if (pointer?.[1] === undefined) return undefined;
    gitDir = resolve(projectPath, pointer[1].trim());
  }
  const head = await readFile(join(gitDir, "HEAD"), "utf8");
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return ref?.[1]?.trim();
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** A source that fails or is slow contributes nothing rather than failing the session. */
async function bounded<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolveLate) => {
        timer = setTimeout(() => resolveLate(undefined), SOURCE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

import type { Instant } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { type ReleaseHistoryRead, changelogCard, describeChangelog, readChangelog } from "./application/changelog.ts";

export interface ShowChangelogToolDeps {
  newId: (prefix: string) => string;
  now: () => Instant;
  /** The release record to read; the one embedded with this build unless a test hands another. */
  load?: () => ReleaseHistoryRead;
}

/**
 * "Clark có gì mới?", "what changed since 1.4?" — answered from the release notes embedded with this build.
 *
 * The same capability `/changelog`, Settings and `GET /changelog` read (`application/changelog.ts`). The person sees
 * the host-owned card built from the record; the model reads the same entries as data and may summarise them, but has
 * nothing to add: the card is not its to write, and the text it reads says the list is the whole record.
 */
export function createShowChangelogTool(deps: ShowChangelogToolDeps): ToolDefinition {
  return {
    name: "show_changelog",
    label: "Xem có gì mới",
    description:
      "Show what this version of Clark changed, from the canonical release notes embedded with the build, as a card " +
      "in the conversation. Use it when the user asks what is new in Clark, what changed, which version is installed, " +
      "or what changed since a version (pass `since`, such as \"1.4\"). Works offline. Summarise only the entries it " +
      "returns; never invent a change, version or date. It cannot update Clark or change the release channel.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: {
          type: "string",
          maxLength: 40,
          description: "Only the releases after this version, such as \"1.4\" or \"1.4.2\". Omit for every recorded release.",
        },
      },
    },
    promptSnippet: "show_changelog — what this version of Clark changed, from the release notes it shipped with",
    execute: async (params): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const since = typeof params.since === "string" ? params.since : undefined;
      const answer = readChangelog({ since }, deps.load);
      if (!answer.ok) {
        return answer.code === "invalid-version"
          ? { text: `${answer.message}. Ask which version the user means, or call show_changelog without since.` }
          : { text: `The release notes could not be read: ${answer.message}. Say so; do not describe changes from memory.` };
      }
      return {
        text: describeChangelog(answer.view),
        hostCard: changelogCard(answer.view, { cardId: deps.newId("card"), at: deps.now() }),
      };
    },
  };
}

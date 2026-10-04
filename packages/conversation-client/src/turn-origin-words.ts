import type { MessageKey } from "./i18n/messages.ts";

/**
 * Who asked for an effect, in the person's language.
 *
 * The host records a turn's origin when it accepts the message — the person at the composer or by voice, an AI
 * client over MCP, a relay, a program over the CLI or API, an automation, or another node — and an approval card or
 * an activity row carries it as data. Anything that is not one of those is left unworded rather than guessed at.
 */
export function askedByKey(origin: unknown): MessageKey | undefined {
  switch (origin) {
    case "person":
      return "turnOrigin.askedBy.person";
    case "mcp":
      return "turnOrigin.askedBy.mcp";
    case "relay":
      return "turnOrigin.askedBy.relay";
    case "cli-api":
      return "turnOrigin.askedBy.cliApi";
    case "automation":
      return "turnOrigin.askedBy.automation";
    case "peer":
      return "turnOrigin.askedBy.peer";
    default:
      return undefined;
  }
}

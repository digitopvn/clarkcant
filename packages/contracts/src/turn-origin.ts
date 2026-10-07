import { z } from "zod";

/**
 * Who asked for a turn, recorded when the node accepted the message.
 *
 * - `person`: the person themselves, typing into this node's page composer, speaking, or pressing a host control.
 * - `mcp`: an AI client, through the MCP `ask_clark` tool.
 * - `relay`: a program on the WebSocket API's `request` frame.
 * - `cli-api`: a program calling the HTTP API directly — `clarkcant`, or anything else that holds the token and does
 *   not mark itself as the composer.
 * - `automation`: one of the person's automations firing on its schedule or trigger.
 * - `peer`: another node the person paired, handing work over.
 * - `channel`: a message on an external messaging channel bound to the conversation (Telegram, Discord, ...), accepted
 *   by the host's channel intake. Who wrote it is the message's `authorPrincipalId`, not the origin.
 *
 * The node derives it from what it already knows about the request — the surface mark its own relays set, and which
 * code path accepted the message — and never from anything a client puts in a body. MCP and the WebSocket relay build
 * their own request headers, so a client on either cannot claim to be the person on that surface. A program that holds the
 * node's token and calls the HTTP API directly is trusted like the page: it can send the composer's mark and be recorded
 * as the person, so this is a record of the path a message took, not proof of who typed it.
 *
 * Recorded, not acted on by default: the execution policy treats every origin exactly like the person unless the
 * person opts into asking for machine-surface turns (`ExecutionPolicyConfig.machineTurns`).
 */
export const TURN_ORIGINS = ["person", "mcp", "relay", "cli-api", "automation", "peer", "channel"] as const;
export const turnOriginSchema = z.enum(TURN_ORIGINS);
export type TurnOrigin = z.infer<typeof turnOriginSchema>;

/** The origins that are a program on one of the node's machine surfaces rather than the person or their own setup. */
export const MACHINE_SURFACE_ORIGINS: readonly TurnOrigin[] = ["mcp", "relay", "cli-api"];

export function isMachineSurfaceOrigin(origin: TurnOrigin | undefined): boolean {
  return origin !== undefined && MACHINE_SURFACE_ORIGINS.includes(origin);
}

/**
 * The origin of a message posted over HTTP, read from the gateway's surface mark (`x-clarkcant-surface`).
 *
 * The composer's mark is the only way to `person` on this path; MCP and the relay overwrite the header with their own
 * name before the request reaches the route, and anything unmarked — `clarkcant`, a script — is `cli-api`. A list of
 * values, or a value this does not know, is `cli-api` too: never the person.
 */
export function turnOriginOfSurfaceMark(mark: string | string[] | undefined): TurnOrigin {
  if (mark === "composer") return "person";
  if (mark === "mcp") return "mcp";
  if (mark === "relay") return "relay";
  return "cli-api";
}

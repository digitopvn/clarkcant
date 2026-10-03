import { MAP_TILE_SECRET_CONSUMER } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import {
  type MapTilePolicyRequestDeps,
  type MapTilePolicyRequestOutcome,
  type MapTilePolicyStatus,
  mapTilePolicyStatus,
  requestMapTilePolicy,
} from "./application/map-tile-policy.ts";

/**
 * Turning the maps' provider tiles on or off from the conversation.
 *
 * The same `writeMapTilePolicy` Settings writes through (`application/map-tile-policy.ts`). Naming a provider always
 * becomes a host-owned approval card the person decides; turning tiles off follows the execution policy. The key is
 * never a parameter: the person gives it through `request_secret` with consumer `maps:tiles`, and this tool names it by
 * the secret's name only.
 */

export interface MapTilesToolDeps {
  /** Read at call time: the clock and the policy are the node's at the moment of the call. */
  deps: () => MapTilePolicyRequestDeps;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
}

const ACTIONS = ["status", "set", "clear"] as const;

export function describeMapTileStatus(status: MapTilePolicyStatus): string {
  const policy = status.policy;
  if (policy === null) return "Bản đồ đang chỉ dùng nền ngoại tuyến: chưa đặt nhà cung cấp ô bản đồ nào.";
  const key = policy.credential === undefined
    ? "không dùng khóa"
    : status.keyUsable === true
      ? `khóa ${policy.credential.secret} đã được lưu cho ${MAP_TILE_SECRET_CONSUMER}`
      : `khóa ${policy.credential.secret} chưa dùng được (${status.keyProblem ?? "chưa có"}) nên bản đồ vẫn chỉ dùng nền ngoại tuyến; ` +
        `nhờ người dùng nhập khóa bằng request_secret với consumer ${MAP_TILE_SECRET_CONSUMER} và tên ${policy.credential.secret}`;
  return `Ô bản đồ lấy từ ${policy.origin} (${policy.attribution}, zoom tối đa ${String(policy.maxZoom)}); ${key}.`;
}

export function describeMapTileOutcome(outcome: MapTilePolicyRequestOutcome): string {
  switch (outcome.kind) {
    case "done":
      return `Đã tắt ô bản đồ. ${describeMapTileStatus(outcome.status)}`;
    case "approval-required":
      return (
        `Đã gửi thẻ duyệt: ${outcome.approval.operationDescription}. Chưa có gì thay đổi — người dùng phải bấm duyệt trên ` +
        "thẻ, và tui không thể tự duyệt. Đừng nói là đã xong."
      );
    case "refused":
      return `Không đổi được chính sách ô bản đồ: ${outcome.message} (${outcome.code}). Không có gì thay đổi.`;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function createMapTilesTool(input: MapTilesToolDeps): ToolDefinition {
  return {
    name: "set_map_tiles",
    label: "Ô bản đồ",
    description:
      "Show, turn on or turn off provider map tiles for the maps on this node. Without a provider, maps draw only the " +
      "offline basemap. set names one tile provider: its https origin, a path template with {z}, {x} and {y}, the " +
      "attribution the provider requires, its maximum zoom, and optionally the name of a secret holding its key with " +
      "the header or query parameter it goes in. Never ask for or pass the key itself: ask the user for it with " +
      `request_secret, consumer ${MAP_TILE_SECRET_CONSUMER}, and pass only the secret's name here. set always puts an ` +
      "approval card in the conversation that only the user can approve; clear turns tiles off, and the execution " +
      "policy may ask first. The result says what happened.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "status, set a provider, or clear (tiles off)." },
        origin: { type: "string", description: "For set: the provider's origin, e.g. https://tiles.example.com (http only for a loopback address)." },
        template: { type: "string", description: "For set: the tile path on that origin, e.g. /styles/basic/{z}/{x}/{y}.png" },
        attribution: { type: "string", description: "For set: the attribution text the provider requires on the map." },
        maxZoom: { type: "integer", minimum: 0, maximum: 19, description: "For set: the provider's highest zoom." },
        keySecret: { type: "string", description: "For set, optional: the name of the secret holding the provider's key (lower-case)." },
        keyHeader: { type: "string", description: "With keySecret: the HTTP header the key goes in. Give this or keyQuery." },
        keyQuery: { type: "string", description: "With keySecret: the query parameter the key goes in. Give this or keyHeader." },
      },
    },
    promptSnippet: "set_map_tiles — show, turn on (with the user's approval) or turn off provider map tiles",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const action = typeof params.action === "string" ? params.action : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { text: `"${action}" không phải hành động hợp lệ; dùng status, set hoặc clear.` };
      }
      const deps = input.deps();
      if (action === "status") return { text: describeMapTileStatus(mapTilePolicyStatus(deps, deps.principalId)) };
      const source = input.channel() === "voice" ? "voice" : "agent";
      const secret = text(params.keySecret);
      const header = text(params.keyHeader);
      const query = text(params.keyQuery);
      const value = action === "clear"
        ? null
        : {
            origin: text(params.origin) ?? "",
            template: text(params.template) ?? "",
            attribution: text(params.attribution) ?? "",
            maxZoom: params.maxZoom,
            ...(secret === undefined
              ? {}
              : { credential: { secret, ...(header === undefined ? {} : { header }), ...(query === undefined ? {} : { query }) } }),
          };
      const outcome = requestMapTilePolicy(deps, {
        value,
        source,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      });
      return {
        text: describeMapTileOutcome(outcome),
        ...(outcome.kind === "approval-required" ? { hostCard: outcome.card } : {}),
      };
    },
  };
}

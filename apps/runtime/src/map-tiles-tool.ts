import { MAP_TILE_SECRET_NAME } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import {
  type MapTilePolicyRequestDeps,
  type MapTilePolicyRequestOutcome,
  type MapTilePolicyStatus,
  describeMapTileReceipt,
  mapTilePolicyStatus,
  requestMapTilePolicy,
} from "./application/map-tile-policy.ts";

/**
 * Turning the maps' provider tiles on or off from the conversation.
 *
 * The same `writeMapTilePolicy` Settings writes through (`application/map-tile-policy.ts`), decided by the execution
 * policy like any other effect. The key is never a parameter, and neither is the secret it lives in: it is the host's
 * own `maps:tiles`, which only the person enters, in Settings, bound to the origin they enter it for. Clark says only
 * whether the provider needs a key and where it goes; a provider at another origin than the key's runs without it.
 */

export interface MapTilesToolDeps {
  /** Read at call time: the clock and the policy are the node's at the moment of the call. */
  deps: () => MapTilePolicyRequestDeps;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
}

const ACTIONS = ["status", "set", "clear"] as const;

const ENTER_KEY = "nhờ người dùng nhập khóa trong Cài đặt → Tiện ích → Ô bản đồ (tui không nhận và không chuyển được khóa)";

export function describeMapTileStatus(status: MapTilePolicyStatus): string {
  const policy = status.policy;
  const saved = status.savedKey === null
    ? "Chưa có khóa ô bản đồ nào được lưu."
    : `Khóa ô bản đồ đã lưu ${status.savedKey.origin === undefined ? "không gắn với nguồn nào" : `chỉ được gửi tới ${status.savedKey.origin}`}.`;
  if (policy === null) return `Bản đồ đang chỉ dùng nền ngoại tuyến: chưa đặt nhà cung cấp ô bản đồ nào. ${saved}`;
  const key = policy.credential === undefined
    ? "không dùng khóa"
    : status.keyUsable === true
      ? `khóa đã lưu được gửi tới ${policy.origin}`
      : `khóa chưa dùng được (${status.keyProblem ?? "chưa có"}) nên bản đồ vẫn chỉ dùng nền ngoại tuyến; ${ENTER_KEY}`;
  return `Ô bản đồ lấy từ ${policy.origin} (${policy.attribution}, zoom tối đa ${String(policy.maxZoom)}); ${key}. ${saved}`;
}

export function describeMapTileOutcome(outcome: MapTilePolicyRequestOutcome): string {
  switch (outcome.kind) {
    case "done":
      return (
        `${describeMapTileReceipt(outcome.policy, outcome.status)}. ${describeMapTileStatus(outcome.status)} ` +
        "Người dùng hoàn tác được bằng nút Hoàn tác trong Cài đặt → Tiện ích → Ô bản đồ."
      );
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
      "attribution the provider requires, its maximum zoom, and, when the provider needs a key, the header or query " +
      "parameter the key goes in. Never ask for, pass or put the key itself anywhere, including in the template: the " +
      "user enters it in Settings → Extensions → Map tiles, which binds it to that provider's origin, and the node sends " +
      "it only there. A provider you set at another origin runs without the key until the user enters it again there. " +
      "set and clear follow the node's execution policy: they may run at once (the user can undo them in Settings), put " +
      "an approval card in the conversation that only the user can approve, or be refused. The result says which.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...ACTIONS], description: "status, set a provider, or clear (tiles off)." },
        origin: { type: "string", description: "For set: the provider's origin, e.g. https://tiles.example.com (http only for a loopback address)." },
        template: { type: "string", description: "For set: the tile path on that origin, e.g. /styles/basic/{z}/{x}/{y}.png — never with a key in it." },
        attribution: { type: "string", description: "For set: the attribution text the provider requires on the map." },
        maxZoom: { type: "integer", minimum: 0, maximum: 19, description: "For set: the provider's highest zoom." },
        keyHeader: { type: "string", description: "For set, when the provider needs a key: the HTTP header it goes in. Give this or keyQuery." },
        keyQuery: { type: "string", description: "For set, when the provider needs a key: the query parameter it goes in. Give this or keyHeader." },
      },
    },
    promptSnippet: "set_map_tiles — show, turn on or turn off provider map tiles (the key is entered by the user in Settings)",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const action = typeof params.action === "string" ? params.action : "";
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { text: `"${action}" không phải hành động hợp lệ; dùng status, set hoặc clear.` };
      }
      const deps = input.deps();
      if (action === "status") return { text: describeMapTileStatus(mapTilePolicyStatus(deps, deps.principalId)) };
      const source = input.channel() === "voice" ? "voice" : "agent";
      const header = text(params.keyHeader);
      const query = text(params.keyQuery);
      const value = action === "clear"
        ? null
        : {
            origin: text(params.origin) ?? "",
            template: text(params.template) ?? "",
            attribution: text(params.attribution) ?? "",
            maxZoom: params.maxZoom,
            // The secret is always the host's own; the model only says where the key goes.
            ...(header === undefined && query === undefined
              ? {}
              : { credential: { secret: MAP_TILE_SECRET_NAME, ...(header === undefined ? {} : { header }), ...(query === undefined ? {} : { query }) } }),
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

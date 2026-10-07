import {
  canonicalReach,
  declaredReachIsEmpty,
  entryFitsHost,
  platformForHost,
  type DirectoryEntry,
  type Platform,
} from "@clarkcant/contracts";
import {
  HOST_API_VERSION,
  originOf,
  readDirectory,
  refreshDirectory,
  searchDirectory,
  unreadFieldsOf,
  type DirectoryConfig,
  type DirectoryIndexState,
  type DirectorySourceStatus,
  type FeedRefreshOptions,
} from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { localContentDigest } from "./application/package-install.ts";
import { fitHead, fitTail } from "./card-text.ts";
import { isNewerVersion } from "./update-checks.ts";

/**
 * Searching the package directory — every configured source at once.
 *
 * The producer for the marketplace-results card, and the reason that card is host-owned: a result asserts a digest
 * and a risk lane, and a model that could mint one could draw a listing that looks verified while pointing at bytes
 * nobody has hashed.
 *
 * The tool is a *finder*, never an installer. It hands back sources, and installing one goes through the same
 * resolver, digest check and generation swap as a path typed by hand. Search is how you find a source, not how you
 * authorise one; nothing a listing says grants a permission, and the agent cannot grant one either.
 *
 * One tool for searching and for a package's details (`packageId`), rather than a second "details" tool: both read the
 * same composed directory and return the same host-owned card, so the agent, the card and a voice request can never
 * disagree about what a listing says.
 *
 * Deterministic: the same sources and the same query give the same rows in the same order. Rows that cannot run on
 * this host (platform or host API) are left out and counted, so a listing that cannot run is not offered as one that
 * can. "No directory configured", "a source could not be consulted" and "nothing matched" are reported as the
 * different things they are.
 */

/** How old a remote copy may be before a search fetches it again. */
export const SEARCH_REFRESH_AGE_MS = 15 * 60_000;

export interface SearchDirectoryToolInput {
  directory: DirectoryConfig;
  newId: (prefix: string) => string;
  /** How remote sources are refreshed before a search; a test passes a fake fetch. */
  refresh?: FeedRefreshOptions;
  /** The host results are filtered for. Defaults to this process's platform and `HOST_API_VERSION`. */
  host?: { platform: Platform | undefined; hostApi: number };
}

/**
 * The content digest of a listing's files on this machine, as the card shows it, for the Install button to send back.
 * Nothing for a git or npm listing, whose fetch checks the published digest, or for a path that cannot be digested now
 * (unreadable, linked, or past the size bounds `localContentDigest` keeps a search to — it lists ten rows by default):
 * the install then digests the files itself and refuses such a path by name.
 */
function listedContentDigest(entry: DirectoryEntry): { contentDigest?: string } {
  const local = localContentDigest(entry);
  return local?.ok === true ? { contentDigest: local.digest } : {};
}

/** The card's bounds for the echoed query, the directory's name and a source's reason (`marketplaceResultsBlockSchema`). */
const CARD_QUERY_MAX = 200;
const CARD_DIRECTORY_MAX = 300;
const CARD_REASON_MAX = 500;
const CARD_SOURCES_MAX = 16;
/** The most versions a details answer lists: the card's own row bound. */
const DETAILS_MAX = 50;

/** The sources that did not fully answer, as the card's notes. */
function sourceNotes(sources: readonly DirectorySourceStatus[] | undefined) {
  return (sources ?? [])
    .filter((status) => status.state !== "ready")
    .slice(0, CARD_SOURCES_MAX)
    .map((status) => ({
      kind: status.origin.kind,
      label: fitTail(status.origin.label, CARD_DIRECTORY_MAX),
      state: status.state as Exclude<DirectorySourceStatus["state"], "ready">,
      ...(status.fetchedAt === undefined ? {} : { fetchedAt: status.fetchedAt.slice(0, 40) }),
      ...(status.reason === undefined || status.reason === "" ? {} : { reason: fitHead(status.reason, CARD_REASON_MAX) }),
    }));
}

/** Words for a source state, in the tool's reply. */
const STATE_WORDS: Record<DirectorySourceStatus["state"], string> = {
  ready: "sẵn sàng",
  stale: "đang dùng bản đã tải trước",
  "not-fetched": "chưa tải",
  unreachable: "không kết nối được",
  unsupported: "không có directory feed",
  unreadable: "không đọc được",
};

function sourceSentence(sources: readonly DirectorySourceStatus[] | undefined): string {
  const notes = (sources ?? []).filter((status) => status.state !== "ready");
  if (notes.length === 0) return "";
  return ` Nguồn chưa trả lời đầy đủ: ${notes
    .map((status) => `${status.origin.label} (${STATE_WORDS[status.state]}${status.reason === undefined ? "" : `: ${status.reason}`})`)
    .join("; ")}.`;
}

/** One listing's details as words, for the agent to relay: every claim the listing makes, labelled as a claim. */
function detailLine(state: DirectoryIndexState, entry: DirectoryEntry): string {
  const origin = originOf(state, entry);
  const source =
    entry.source.kind === "npm"
      ? `npm ${entry.source.name}@${entry.source.version}`
      : entry.source.kind === "git"
        ? `git ${entry.source.url}#${entry.source.ref}`
        : `local ${entry.source.path}`;
  const reach = entry.declaredReach === undefined || declaredReachIsEmpty(entry.declaredReach) ? "không" : JSON.stringify(canonicalReach(entry.declaredReach));
  return [
    `- ${entry.displayName} ${entry.version} (${entry.packageId})`,
    `  nguồn: ${source}; digest: ${entry.digest}; làn rủi ro: ${entry.riskTier}`,
    `  nhà phát hành: ${entry.publisher.id}; giấy phép: ${entry.publisher.license}; mã nguồn: ${entry.publisher.sourceUrl}`,
    `  quyền yêu cầu (theo listing): ${entry.permissionsSummary.length === 0 ? "không" : entry.permissionsSummary.join(", ")}`,
    `  phạm vi truy cập khai báo: ${reach}`,
    `  nền tảng: ${entry.platforms.join(", ")}; host API: ${String(entry.hostApi.min)}–${String(entry.hostApi.max)}; kích thước: ${String(entry.sizeBytes)} byte`,
    ...(origin === undefined ? [] : [`  liệt kê bởi: ${origin.label}`]),
  ].join("\n");
}

export function createSearchDirectoryTool(input: SearchDirectoryToolInput): ToolDefinition {
  return {
    name: "search_directory",
    label: "Tìm gói trong directory",
    description:
      "Search every configured package directory (the person's index file, marketplaces they added, and the ClarkCant " +
      "Marketplace) for a widget or package to install, or pass packageId to get every listed version of one package " +
      "with its full listing details. Each result carries its source, version, digest, risk lane and which directory " +
      "listed it; listings that cannot run on this host are left out. Listings are claims, not permissions: installing " +
      "one still goes through the normal install path, which verifies the digest and asks for consent where policy " +
      "requires. A directory that could not be consulted is reported as such, which is not the same as finding nothing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for. An empty string browses the directory." },
        packageId: {
          type: "string",
          description: "An exact package id. When given, lists every version of that package with its full details.",
        },
      },
    },
    promptSnippet: "search_directory — find a package in the directories (or one package's details), then install it by its source",
    execute: async (params: Record<string, unknown>): Promise<{ text: string; hostCard?: Record<string, unknown> }> => {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const packageId = typeof params.packageId === "string" && params.packageId.trim() !== "" ? params.packageId.trim() : undefined;
      // A search is the person asking: the remote sources that are due are fetched now, within their own bounds.
      await refreshDirectory(input.directory, { maxAgeMs: SEARCH_REFRESH_AGE_MS, ...input.refresh });
      const state = readDirectory(input.directory);
      if (state.kind === "not-configured") return { text: state.reason };
      if (state.kind === "unreadable") return { text: `Không đọc được directory: ${state.reason}` };

      const host = input.host ?? { platform: platformForHost(process.platform, process.arch), hostApi: HOST_API_VERSION };
      const installable = state.entries.filter(
        (entry) => entry.digest.trim() !== "" && (packageId === undefined || entry.packageId === packageId),
      );
      const fitting =
        host.platform === undefined
          ? installable
          : installable.filter((entry) => entryFitsHost({ entry, hostApi: host.hostApi, platform: host.platform as Platform }).ok);
      const hidden = installable.length - fitting.length;

      const results =
        packageId === undefined
          ? searchDirectory({ entries: fitting, query })
          : [...fitting]
              // Newest first; ties keep the source order, so the same directory gives the same answer twice.
              .sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0))
              .slice(0, DETAILS_MAX);
      // A listing with fields this node does not read is shown without them, and said so on its row and here.
      const partlyRead = results.filter((entry) => unreadFieldsOf(state, entry) !== undefined).length;
      const subject = packageId === undefined ? `khớp “${query}”` : `có mã ${packageId}`;
      const text =
        (results.length === 0
          ? `Không có gói nào trong ${state.directory} ${subject}.`
          : `Tìm thấy ${results.length} gói trong ${state.directory}.`) +
        (packageId === undefined || results.length === 0
          ? ""
          : `\n${results.map((entry) => detailLine(state, entry)).join("\n")}\nĐây là thông tin listing tự khai báo; khi cài, Clark kiểm tra digest và manifest thật của gói.`) +
        (hidden === 0 ? "" : ` ${hidden} gói bị ẩn vì không chạy được trên máy này (nền tảng hoặc host API).`) +
        (partlyRead === 0
          ? ""
          : ` ${partlyRead} gói có thông tin mà bản Clark này không đọc được; thẻ kết quả ghi rõ, và bản Clark mới hơn sẽ hiện đủ.`) +
        sourceSentence(state.sources);
      const notes = sourceNotes(state.sources);
      return {
        text,
        // The conductor drops a host card that fails its contract, so every value here fits it: the query and the
        // directory name are shortened, and every row field already has the same or a tighter bound in the directory
        // entry, `version` included (`directoryVersionSchema`); a listing whose version is longer is refused when read.
        hostCard: {
          type: "marketplace-results",
          owner: "host",
          cardId: input.newId("market"),
          query: fitHead(packageId ?? query, CARD_QUERY_MAX),
          directory: fitTail(state.directory, CARD_DIRECTORY_MAX),
          results: results.map((entry) => {
            // The names of what the listing says that this node does not read, never their values.
            const unreadFields = unreadFieldsOf(state, entry);
            // Named per row only when several sources share the card; with one, the card's title already names it.
            const origin = (state.sources?.length ?? 0) > 1 ? originOf(state, entry) : undefined;
            return {
              packageId: entry.packageId,
              version: entry.version,
              displayName: entry.displayName,
              description: entry.description,
              source: entry.source,
              digest: entry.digest,
              // A path on this machine is shown with the content of its files now; Install is refused if they changed since.
              ...listedContentDigest(entry),
              riskTier: entry.riskTier,
              ...(entry.widgetAppearance === undefined ? {} : { widgetAppearance: entry.widgetAppearance }),
              // What installing lets it reach, shown before the Install press; the install refuses an artifact that differs.
              ...(entry.declaredReach === undefined || declaredReachIsEmpty(entry.declaredReach)
                ? {}
                : { declaredReach: canonicalReach(entry.declaredReach) }),
              ...(unreadFields === undefined ? {} : { unreadFields }),
              // A directory entry may repeat a kind; the card lists each once, which also keeps it within its bound.
              facets: [...new Set(entry.facets)],
              platforms: [...new Set(entry.platforms)],
              ...(origin === undefined ? {} : { origin: { kind: origin.kind, label: fitTail(origin.label, CARD_DIRECTORY_MAX) } }),
            };
          }),
          ...(notes.length === 0 ? {} : { sources: notes }),
        },
      };
    },
  };
}

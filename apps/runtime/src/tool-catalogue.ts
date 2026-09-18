/**
 * The tools this node offers, for an interface that has to be able to say so.
 *
 * The catalogue is published by whoever builds the tools rather than rebuilt on demand, because building them needs
 * the search index, the project finder and the approval wiring: a route that built its own copy would be a second
 * source of truth for what this node can do, and the first thing to drift.
 *
 * A registry rather than a parameter threaded through the gateway, because the gateway is built before the tools are
 * and a tool that is registered after the fact is still a tool this node has.
 */
export interface ToolCatalogueEntry {
  name: string;
  label: string;
  description: string;
}

/** The tools the pi agent carries on its own, before any extension it loads. */
export const PI_BUILTIN_TOOLS: readonly ToolCatalogueEntry[] = [
  { name: "read", label: "Đọc tệp", description: "Đọc nội dung một tệp trong thư mục làm việc." },
  { name: "write", label: "Ghi tệp", description: "Tạo hoặc thay thế một tệp." },
  { name: "edit", label: "Sửa tệp", description: "Thay một đoạn chính xác trong tệp." },
  { name: "bash", label: "Chạy lệnh", description: "Chạy một lệnh shell trong thư mục làm việc." },
];

let catalogue: readonly ToolCatalogueEntry[] = [];

/** Published once at boot, by whoever builds this node's tools. */
export function registerNodeTools(tools: readonly ToolCatalogueEntry[]): void {
  catalogue = [...tools];
}

/**
 * What this harness offers right now.
 *
 * Empty before boot and after a failed boot, which is the truth: a node whose tools were never built has none to
 * offer, and an interface that invented a list would be describing a node that is not running.
 */
export function nodeToolCatalogue(): readonly ToolCatalogueEntry[] {
  return catalogue;
}

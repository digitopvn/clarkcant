import {
  type TableColumn,
  foldTableText,
  normalizeTableColumns,
  tableView,
  toCsv,
} from "@clarkcant/contracts";
import { getInstance } from "@clarkcant/core";
import { TABLE } from "@clarkcant/data-canvas";
import { getDatasetForPrincipal } from "@clarkcant/storage";

import { type NodeServices } from "../services.ts";
import { type GatewayResponse, fail } from "./http.ts";

/**
 * A table's CSV export, written by the node.
 *
 * The request carries a view (sort, search, filters, which columns) and nothing else. The rows come from the
 * dataset the instance's own `props.datasetRef` names, read for the instance's owner, and the view is applied by
 * the same `tableView` the page ran, so the file holds exactly the rows the person was looking at. A dataset id in
 * the request, or a list of rows, would let a page put anything in a file the node hands back as the table's; there
 * is no field for either.
 *
 * Every cell a spreadsheet would run as a formula is defused by `toCsv`, because the file leaves the conversation
 * and is opened by a program that does not know the text came from a dataset.
 */

export interface TableExportInput {
  instanceId: string;
  principalId: string;
  body: Record<string, unknown>;
}

// A UTF-8 byte order mark, so a spreadsheet opens Vietnamese text as UTF-8 rather than guessing a code page.
const BOM = String.fromCharCode(0xfeff);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An ASCII file name from the table's title, so the header needs no encoding and cannot be broken out of. */
export function tableExportFilename(title: unknown): string {
  const slug = foldTableText(typeof title === "string" ? title : "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80)
    .replaceAll(/-+$/g, "");
  return `${slug === "" ? "table" : slug}.csv`;
}

/** The body's shape, checked before any of it is used. A field of the wrong type is refused, not ignored. */
function malformed(body: Record<string, unknown>): string | undefined {
  if (body.sort !== undefined && body.sort !== null && !isRecord(body.sort)) return "`sort` must be an object";
  if (body.query !== undefined && typeof body.query !== "string") return "`query` must be a string";
  if (body.filters !== undefined && !isRecord(body.filters)) return "`filters` must be an object";
  if (body.columns !== undefined && !(Array.isArray(body.columns) && body.columns.every((key) => typeof key === "string"))) {
    return "`columns` must be a list of column keys";
  }
  return undefined;
}

/**
 * The columns the file has: the instance's own, narrowed and reordered by the request's keys when it names any the
 * table shows. A key the table does not show is ignored, so a request cannot export a field the table hides.
 */
function exportColumns(own: TableColumn[], requested: unknown): TableColumn[] {
  if (!Array.isArray(requested)) return own;
  const byKey = new Map(own.map((column) => [column.key, column]));
  const picked: TableColumn[] = [];
  for (const key of requested) {
    const column = typeof key === "string" ? byKey.get(key) : undefined;
    if (column !== undefined && !picked.includes(column)) picked.push(column);
  }
  return picked.length === 0 ? own : picked;
}

export function exportTableCsv(services: Pick<NodeServices, "runtime" | "conductor">, input: TableExportInput): GatewayResponse {
  const problem = malformed(input.body);
  if (problem !== undefined) return fail(400, "INVALID_SCHEMA", problem);

  const instance = getInstance(services.conductor, input.instanceId);
  if (instance === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
  if (instance.ownerPrincipalId !== input.principalId) {
    return fail(403, "NOT_AUTHORIZED", "that instance belongs to another principal");
  }
  if (instance.definitionRef.id !== TABLE.id) {
    return fail(409, "NOT_A_TABLE", "only a table can be exported as CSV");
  }

  const datasetRef = instance.props.datasetRef;
  const dataset =
    typeof datasetRef === "string" ? getDatasetForPrincipal(services.runtime.db, datasetRef, input.principalId) : undefined;
  if (dataset === undefined) {
    return fail(404, "DATASET_UNAVAILABLE", "the table's dataset is not available on this node, so there is nothing to export");
  }
  const document = dataset.document;
  const rows: unknown[] = isRecord(document) && Array.isArray(document.rows) ? document.rows : [];

  // The rows are chosen over the table's own columns, exactly as the page chose them: searching and sorting see every
  // column the table shows. The requested keys only decide which of those columns the file carries.
  const own = normalizeTableColumns(instance.props.columns, rows);
  const view = tableView(rows, {
    columns: own,
    rowIdField: instance.props.rowIdField,
    sort: input.body.sort,
    query: input.body.query,
    filters: input.body.filters,
  });
  const csv = `${BOM}${toCsv(exportColumns(view.columns, input.body.columns), view.rows.map((entry) => entry.row))}`;

  return {
    status: 200,
    body: null,
    binary: {
      bytes: new TextEncoder().encode(csv),
      contentType: "text/csv; charset=utf-8",
      cache: "no-store",
      headers: {
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${tableExportFilename(instance.props.title)}"`,
        // The web client runs on another origin and names the download from this header, so it must be readable there.
        "access-control-expose-headers": "content-disposition",
      },
    },
  };
}

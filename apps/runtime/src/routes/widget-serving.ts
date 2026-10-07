import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { DirectoryEntry } from "@clarkcant/contracts";
import {
  activeGenerations,
  installedDirectoryEntries,
  notInstalledAsListedMessage,
  readPackage,
  readPackageFile,
  resolveFrameAncestors,
  widgetDocument,
  widgetDocumentPolicy,
} from "@clarkcant/core";
import type { Database } from "@clarkcant/storage";

import { type GatewayRequest, type GatewayResponse, fail } from "./http.ts";
import { readNodeDirectory } from "../application/widget-dev-store.ts";

/**
 * A package's files, reached through a frame grant.
 *
 * The same files as the package routes and the same injection, reached by a path that carries the grant:
 * everything the document then loads inherits it, and the grant names the one package it may read, so this is not
 * a way to browse what is installed. That is why the grant is a parameter rather than something this module looks
 * up — the gateway verifies it before the token check, and this only serves what the verified grant names.
 */
export interface WidgetServingRouteDeps {
  request: GatewayRequest;
  segments: string[];
  /** The grant that was presented and verified, or `undefined` when none was. */
  grant: { packageId: string; version: string } | undefined;
  /** Where the node keeps what it installed: a local package is served from the snapshot its generation records. */
  runtime: { db: Database; identity: { nodeId: string }; dataDir: string };
}

/**
 * The frame family. `undefined` means the request is not one of these routes.
 */
export function handleWidgetServingRoutes(deps: WidgetServingRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  const { grant } = deps;
  if (grant === undefined) return undefined;
  if (!(request.method === "GET" && segments.length >= 3 && segments[0] === "frame")) return undefined;

  const index = readNodeDirectory(deps.runtime.dataDir);
  if (index.kind !== "configured") {
    return fail(409, index.kind === "not-configured" ? "NO_DIRECTORY" : "DIRECTORY_UNREADABLE", index.reason);
  }
  /*
   * A local package an active generation installed is served from that generation's snapshot, never from its path. A
   * listing that no longer names what that generation installed is withheld rather than read from the path, and is
   * refused the way the files route refuses it.
   */
  const installed = installedDirectoryEntries(
    index.entries,
    activeGenerations({ db: deps.runtime.db, nodeId: deps.runtime.identity.nodeId }),
    join(deps.runtime.dataDir, "package-cache"),
  );
  const names = (candidate: DirectoryEntry) => candidate.packageId === grant.packageId && candidate.version === grant.version;
  const entry = installed.entries.find(names);
  if (entry === undefined) {
    if (installed.withheld.some((held) => names(held.entry))) {
      return fail(409, "NOT_INSTALLED", notInstalledAsListedMessage(grant.packageId, grant.version));
    }
    return fail(404, "NOT_IN_DIRECTORY", "the package this grant names is no longer in the directory");
  }
  const file = readPackageFile({ entry, relativePath: segments.slice(2).join("/") });
  if (!file.ok) {
    return fail(
      file.code === "FILE_NOT_FOUND" ? 404 : file.code === "FILE_OUTSIDE_PACKAGE" ? 403 : 409,
      file.code,
      file.message,
    );
  }
  if (file.contentType.startsWith("text/html")) {
    // Checked at startup too; this refuses to serve if the variable was changed to something invalid since.
    const frameAncestors = resolveFrameAncestors(process.env["CC_APP_ORIGIN"]);
    if (!frameAncestors.ok) {
      return fail(500, frameAncestors.code, frameAncestors.message);
    }
    const nonce = randomUUID().replaceAll("-", "");
    // Same rule as the bearer-authenticated package route: `connect-src` reflects what this package's own
    // manifest declared, not the frame grant's request. `readPackageFile` above only succeeds for a
    // `kind: "local"` entry, so `entry.source` is a local source by the time this line runs.
    const allowedOrigins =
      entry.source.kind === "local" ? (readPackage(entry.source.path).manifest.permissions?.networkOrigins ?? []) : [];
    const document = widgetDocument({
      html: file.bytes.toString("utf8"),
      nonce,
      allowedOrigins,
    });
    return {
      status: 200,
      body: null,
      binary: {
        bytes: Buffer.from(document, "utf8"),
        contentType: file.contentType,
        headers: {
          "content-security-policy": widgetDocumentPolicy({ frameAncestors: frameAncestors.sources, nonce, allowedOrigins }),
        },
      },
    };
  }
  return { status: 200, body: null, binary: { bytes: file.bytes, contentType: file.contentType } };
}

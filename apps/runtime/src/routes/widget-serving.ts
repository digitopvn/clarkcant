import { randomUUID } from "node:crypto";

import {
  directoryIndexPath,
  readDirectoryIndex,
  readPackage,
  readPackageFile,
  resolveAppOrigin,
  widgetDocument,
  widgetDocumentPolicy,
} from "@clarkcant/core";

import { type GatewayRequest, type GatewayResponse, fail } from "./http.ts";

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
}

/**
 * The frame family. `undefined` means the request is not one of these routes.
 */
export function handleWidgetServingRoutes(deps: WidgetServingRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  const { grant } = deps;
  if (grant === undefined) return undefined;
  if (!(request.method === "GET" && segments.length >= 3 && segments[0] === "frame")) return undefined;

  const index = readDirectoryIndex(directoryIndexPath(process.env));
  if (index.kind !== "configured") {
    return fail(409, index.kind === "not-configured" ? "NO_DIRECTORY" : "DIRECTORY_UNREADABLE", index.reason);
  }
  const entry = index.entries.find(
    (candidate) => candidate.packageId === grant.packageId && candidate.version === grant.version,
  );
  if (entry === undefined) {
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
    const appOriginOutcome = resolveAppOrigin({
      configured: process.env["CC_APP_ORIGIN"],
      hostHeader: request.headers["host"],
    });
    if (!appOriginOutcome.ok) {
      return fail(500, appOriginOutcome.code, appOriginOutcome.message);
    }
    const nonce = randomUUID().replaceAll("-", "");
    // Same rule as the bearer-authenticated package route: `connect-src` reflects what this package's own
    // manifest declared, not the frame grant's request. `readPackageFile` above only succeeds for a
    // `kind: "local"` entry, so `entry.source` is a local source by the time this line runs.
    const allowedOrigins =
      entry.source.kind === "local" ? (readPackage(entry.source.path).manifest.permissions?.networkOrigins ?? []) : [];
    const document = widgetDocument({
      html: file.bytes.toString("utf8"),
      appOrigin: appOriginOutcome.origin,
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
          "content-security-policy": widgetDocumentPolicy({ appOrigin: appOriginOutcome.origin, nonce, allowedOrigins }),
        },
      },
    };
  }
  return { status: 200, body: null, binary: { bytes: file.bytes, contentType: file.contentType } };
}

import { randomUUID } from "node:crypto";

import { nowInstant } from "@clarkcant/contracts";
import {
  INSTALL_VERIFICATION,
  directoryIndexPath,
  installedWidgets,
  listInstalledPackages,
  readDirectoryIndex,
  readPackageFile,
  widgetDocument,
  widgetDocumentPolicy,
} from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

import { installPackage } from "../application/package-install.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The package family: what is installed, the widget definitions a directory lists, installing one, and
 * serving a package's own files to a widget frame.
 *
 * The route owns the HTTP: parsing the install body, mapping the application's result to a status and
 * a response shape, and the headers a served file travels with. The install flow itself is in
 * `application/package-install.ts`.
 */
export interface PackageRouteDeps {
  services: {
    runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
    conductor: { newId: (prefix: string) => string };
  };
  request: GatewayRequest;
  segments: string[];
}

export function handlePackageRoutes(deps: PackageRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  const { runtime } = deps.services;
  const services = deps.services;
  /*
   * What is installed on this node.
   *
   * Read from the active generation, so a rollback is reflected here without anything in this route knowing about
   * it — and a superseded generation is not listed, because a package that was replaced is not present.
   */
  if (segments.length === 1 && segments[0] === "packages" && request.method === "GET") {
    return json(200, {
      packages: listInstalledPackages({
        db: runtime.db,
        nodeId: runtime.identity.nodeId,
        now: nowInstant,
        newId: services.conductor.newId,
      }),
    });
  }

  /*
   * The widget definitions of the packages installed here.
   *
   * The library can only show a widget whose definition it can read, and this node can only read a package whose
   * bytes it holds. So the answer is per package, and "cannot read this one" is a real answer rather than an
   * empty list: a git or npm entry names bytes nobody here has, and a package the configured directory does not
   * list cannot be located at all. "Declares no widgets" and "cannot tell" are different facts, and a response
   * that merged them would be claiming a package is empty.
   *
   * What comes back is data — definitions and fixtures. No package contributes a renderer, so the caller decides
   * which of these it can actually draw.
   */
  if (segments.length === 2 && segments[0] === "packages" && segments[1] === "widgets" && request.method === "GET") {
    const installed = listInstalledPackages({
      db: runtime.db,
      nodeId: runtime.identity.nodeId,
      now: nowInstant,
      newId: services.conductor.newId,
    });
    const index = readDirectoryIndex(directoryIndexPath(process.env));

    return json(200, {
      packages: installed.map((entry) => {
        if (index.kind !== "configured") {
          return {
            packageId: entry.packageId,
            version: entry.version,
            ok: false,
            code: "NO_DIRECTORY",
            message: index.reason,
          };
        }
        /*
         * A locally installed package records the path as its id and "0.0.0-local" as its version, because the
         * resolver's answer for a source with no published identity is the path itself. So id-and-version alone
         * cannot find it again, and without this fallback every package installed from disk would report "not in
         * the directory" forever. The fallback is narrow on purpose: it only matches a local entry whose path is
         * exactly the recorded id, so it cannot pick up an unrelated entry.
         */
        const listed =
          index.entries.find(
            (candidate) => candidate.packageId === entry.packageId && candidate.version === entry.version,
          ) ??
          index.entries.find(
            (candidate) => candidate.source.kind === "local" && candidate.source.path === entry.packageId,
          );
        if (listed === undefined) {
          return {
            packageId: entry.packageId,
            version: entry.version,
            ok: false,
            code: "NOT_IN_DIRECTORY",
            message: `${entry.packageId}@${entry.version} is not in the directory, so this node cannot locate its files`,
          };
        }
        /*
         * The declared identity, not the recorded one. A local install records the path as its id, so reporting that
         * would put a filesystem path where a package name belongs - and the path is where the bytes are, not what
         * the package is called. The directory entry is the package's own answer, and it is the name the person saw
         * when they installed it.
         */
        const read = installedWidgets({
          packageId: listed.packageId,
          version: listed.version,
          source: listed.source,
        });
        return read.ok
          ? {
              packageId: listed.packageId,
              version: listed.version,
              ok: true,
              widgets: read.widgets,
              problems: read.problems,
            }
          : {
              packageId: listed.packageId,
              version: listed.version,
              ok: false,
              code: read.code,
              message: read.message,
            };
      }),
    });
  }

  /*
   * Installing a package a directory listed.
   *
   * The route parses the request and maps the answer; what an install is, and in what order it decides,
   * lives in `application/package-install.ts`.
   */
  if (segments.length === 2 && segments[0] === "packages" && segments[1] === "install" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const packageId = typeof parsed.value.packageId === "string" ? parsed.value.packageId : "";
    const version = typeof parsed.value.version === "string" ? parsed.value.version : "";
    if (packageId === "" || version === "") {
      return fail(400, "INVALID_SCHEMA", "an install request needs the package id and the version it is installing");
    }
    const outcome = installPackage(
      { runtime, conductor: services.conductor },
      {
        packageId,
        version,
        ...(typeof parsed.value.localDigest === "string" ? { localDigest: parsed.value.localDigest } : {}),
        ...(Array.isArray(parsed.value.requestedCapabilityRefs)
          ? {
              requestedCapabilityRefs: parsed.value.requestedCapabilityRefs.filter(
                (reference): reference is string => typeof reference === "string",
              ),
            }
          : {}),
        ...(Array.isArray(parsed.value.grantedCapabilities)
          ? {
              grantedCapabilities: parsed.value.grantedCapabilities.filter(
                (reference): reference is string => typeof reference === "string",
              ),
            }
          : {}),
      },
    );
    if (outcome.kind === "refused") return fail(outcome.status, outcome.code, outcome.message);
    if (outcome.kind === "approval-required") {
      // 202 rather than an error: nothing failed, and the approval is the next step rather than a refusal.
      return json(202, { code: "APPROVAL_REQUIRED", message: outcome.message, approvalId: outcome.approvalId });
    }
    return json(200, {
      installed: { packageId: outcome.packageId, version: outcome.version },
      generationId: outcome.generationId,
      state: outcome.state,
      /*
       * What was actually verified, in the response rather than left to be assumed. This node does not fetch or run
       * the artifact, so "active" here means the plan it activated was bound to a published digest — not that the
       * package is known to work.
       */
      verified: INSTALL_VERIFICATION,
      /*
       * The frozen build input, and what it covers. `artifact-only` is stated rather than left out: this node
       * pinned the artifact and the build inputs, and the package's own dependency tree is not something it could
       * read without the bytes. Nothing frozen is reported as absent, which is a different statement again.
       */
      lock: outcome.lock,
    });
  }

  /*
   * A package's own files, for a widget frame to load.
   *
   * The frame is an opaque origin, so everything it runs has to be fetched by URL, and this is the only route that
   * turns a package's bytes into one. It serves a package the node can read on disk and nothing else: a git or npm
   * entry names bytes nobody here has, and proxying those would be a different and much larger thing.
   */
  if (
    segments.length >= 5 &&
    segments[0] === "packages" &&
    segments[3] === "files" &&
    request.method === "GET"
  ) {
    const packageId = segments[1] ?? "";
    const version = segments[2] ?? "";
    const index = readDirectoryIndex(directoryIndexPath(process.env));
    if (index.kind !== "configured") {
      return fail(
        409,
        index.kind === "not-configured" ? "NO_DIRECTORY" : "DIRECTORY_UNREADABLE",
        index.reason,
      );
    }
    const entry = index.entries.find(
      (candidate) => candidate.packageId === packageId && candidate.version === version,
    );
    if (entry === undefined) {
      return fail(404, "NOT_IN_DIRECTORY", `${packageId}@${version} is not in the directory`);
    }

    const file = readPackageFile({ entry, relativePath: segments.slice(4).join("/") });
    if (!file.ok) {
      return fail(
        file.code === "FILE_NOT_FOUND" ? 404 : file.code === "FILE_OUTSIDE_PACKAGE" ? 403 : 409,
        file.code,
        file.message,
      );
    }
    /*
     * An HTML entry is served as a widget document: the author's markup plus the bootstrap that gives it a bridge,
     * under a policy that says what it may reach. Everything else is served as it is, because a stylesheet or an image
     * has no bootstrap to add and no policy of its own.
     *
     * The document must be served from this path rather than from a host-owned route, because the widget's own
     * relative imports (`./main.js`) resolve against the URL it was fetched from. Serving the entry anywhere else
     * would break every relative reference in it.
     */
    if (file.contentType.startsWith("text/html")) {
      const nonce = randomUUID().replaceAll("-", "");
      const appOrigin = process.env["CC_APP_ORIGIN"] ?? `http://${request.headers["host"] ?? "127.0.0.1"}`;
      const document = widgetDocument({
        html: file.bytes.toString("utf8"),
        appOrigin,
        nonce,
      });
      return {
        status: 200,
        body: null,
        binary: {
          bytes: Buffer.from(document, "utf8"),
          contentType: file.contentType,
          headers: { "content-security-policy": widgetDocumentPolicy({ appOrigin, nonce }) },
        },
      };
    }

    return { status: 200, body: null, binary: { bytes: file.bytes, contentType: file.contentType } };
  }
  return undefined;
}

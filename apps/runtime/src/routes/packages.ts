import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { PERSON_ONLY_REFUSAL, nowInstant } from "@clarkcant/contracts";
import {
  INSTALL_VERIFICATION,
  activeGeneration,
  installedWidgets,
  listInstalledPackages,
  listRestorablePackages,
  readPackage,
  readPackageFile,
  resolveFrameAncestors,
  resolveLocalSource,
  widgetDocument,
  widgetDocumentPolicy,
} from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

import {
  decideInstallCapabilityApproval,
  installPackage,
  listPendingCapabilityApprovals,
  packageInstallDepsOf,
} from "../application/package-install.ts";
import { decideInstallApproval, isInstallApproval } from "../application/install-approval.ts";
import { changePackageAndConnection } from "../application/package-change.ts";
import { installedConnection, installedManifest, installedReach, packageResourceGrant, packageResourcesView } from "../package-resources.ts";
import type { PackageConnectionBroker } from "../package-connections.ts";
import { resourceProfilePolicy, type ServiceHost } from "../service-host.ts";
import { type GatewayRequest, type GatewayResponse, SURFACE_HEADER, fail, json, readJson } from "./http.ts";
import { readNodeDirectory } from "../application/widget-dev-store.ts";

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
    serviceHost?: (Pick<ServiceHost, "reconcile"> & Partial<Pick<ServiceHost, "resourceGrant">>) | undefined;
    /** Told when a package's code goes, so the tokens its frames hold go with it. */
    browserTokens?: { endPackage(packageId: string): Promise<number> } | undefined;
    /** Status for listings, and told when a package goes, so its account connection goes with it. */
    connections?: Pick<PackageConnectionBroker, "status" | "forget"> | undefined;
  };
  request: GatewayRequest;
  segments: string[];
}

/**
 * Whether the node's own relay or MCP server forwarded this call. Both already refuse a person-only route by path
 * (`isPersonOnlyRoute`); this is the same refusal a second time, at the route, so installing a package or deciding an
 * install stays the person's even if a relay's path check were ever bypassed. The marker is only ever a reason to
 * refuse more: its absence proves nothing, since any caller can leave it out.
 */
function cameThroughMachineSurface(request: GatewayRequest): boolean {
  const marker = request.headers[SURFACE_HEADER];
  return marker === "mcp" || marker === "relay";
}

export async function handlePackageRoutes(deps: PackageRouteDeps): Promise<GatewayResponse | undefined> {
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
    const deps = { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: services.conductor.newId };
    const policy = resourceProfilePolicy({ db: runtime.db, principalId: runtime.identity.ownerPrincipalId, now: nowInstant });
    const index = readNodeDirectory(runtime.dataDir);
    return json(200, {
      /*
       * Each with the resource profile it asked for and what this node granted, so package details show the bounds the
       * code runs in or why it does not run. Left out when the node cannot read the package's manifest: an unknown
       * request is not reported as the light profile.
       */
      packages: listInstalledPackages(deps).map((installed) => {
        const manifest = installedManifest(installed, runtime.dataDir, index);
        if (manifest === "unreadable") return installed;
        const grant = packageResourceGrant({
          packageId: installed.packageId,
          request: manifest.resources,
          serviceHost: services.serviceHost,
          policy,
        });
        // And what it reaches beyond its sandbox, from the same manifest, so details show what install consent covered.
        const reach = installedReach(manifest);
        // And its account connection's status, when it declares one: state and scopes, never a credential.
        const connection = installedConnection(manifest);
        const connectionStatus = connection === undefined ? undefined : services.connections?.status(installed.packageId, connection);
        return {
          ...installed,
          resources: packageResourcesView(grant),
          ...(reach === undefined ? {} : { reach }),
          ...(connectionStatus === undefined ? {} : { connection: connectionStatus }),
        };
      }),
      // Uninstalled here and restorable without fetching anything: the generation rows outlive an uninstall.
      restorable: listRestorablePackages(deps),
    });
  }

  /*
   * POST /packages/:id/uninstall | restore | rollback
   *
   * No body and no confirmation step: the request is the person's explicit intent, each of the three is undone by
   * another of them, and none deletes a widget's state or a conversation's snapshots. The id is percent-encoded by
   * the client because a package installed from disk is recorded under its path.
   */
  if (
    segments.length === 3 &&
    segments[0] === "packages" &&
    (segments[2] === "uninstall" || segments[2] === "restore" || segments[2] === "rollback") &&
    request.method === "POST"
  ) {
    let packageId: string;
    try {
      packageId = decodeURIComponent(segments[1] ?? "");
    } catch {
      return fail(400, "INVALID_SCHEMA", "the package id in the path is not valid percent-encoding");
    }
    // An uninstalled package keeps no account: its tokens are revoked at the provider and deleted here.
    const outcome = await changePackageAndConnection(packageInstallDepsOf(services), services.connections, { action: segments[2], packageId, source: "click" });
    if (outcome.kind === "refused") return fail(outcome.status, outcome.code, outcome.message);
    const { kind: _kind, ...changed } = outcome;
    return json(200, changed);
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
    const index = readNodeDirectory(runtime.dataDir);

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
          // A local install is read from the snapshot it runs from, not from the path it was copied from.
          source:
            listed.source.kind === "local"
              ? resolveLocalSource(listed, join(runtime.dataDir, "package-cache"), entry)
              : listed.source,
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
    if (cameThroughMachineSurface(request)) return fail(403, PERSON_ONLY_REFUSAL.code, PERSON_ONLY_REFUSAL.message);
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const packageId = typeof parsed.value.packageId === "string" ? parsed.value.packageId : "";
    const version = typeof parsed.value.version === "string" ? parsed.value.version : "";
    if (packageId === "" || version === "") {
      return fail(400, "INVALID_SCHEMA", "an install request needs the package id and the version it is installing");
    }
    const outcome = await installPackage(
      packageInstallDepsOf(services),
      {
        packageId,
        version,
        ...(typeof parsed.value.localDigest === "string" ? { localDigest: parsed.value.localDigest } : {}),
        // Only ever a reason to refuse: the node digests the files itself and compares, so a forged value installs nothing.
        ...(typeof parsed.value.contentDigest === "string" && parsed.value.contentDigest !== ""
          ? { contentDigest: parsed.value.contentDigest }
          : {}),
        ...(Array.isArray(parsed.value.requestedCapabilityRefs)
          ? {
              requestedCapabilityRefs: parsed.value.requestedCapabilityRefs.filter(
                (reference): reference is string => typeof reference === "string",
              ),
            }
          : {}),
        // `grantedCapabilities` is deliberately not read from the request body: a client declaring its
        // own grants is exactly the authority-boundary violation issue #93 (P1) reported — a manifest
        // request is metadata, not authority, and the public install route has no consent/policy state
        // from which to derive a grant today. `installPackage` fails closed on this (empty grants)
        // rather than trusting whatever JSON arrived here; see the comment there for the seam a later
        // consent implementation fills.
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
      /*
       * A capability the policy would ask about, or refused outright, named in the response rather than folded
       * into "installed" as if it were granted. There is no UI control for a pending capability approval today
       * (AGENTS: no control before its real action exists), so this plain-language note names the route that
       * already resolves one — `POST /packages/approvals/:id/decision` — as the only place a caller can act on it
       * until a UI is built; the structured arrays beside it are what that future UI or a CLI would read instead
       * of parsing prose.
       */
      pendingCapabilities: outcome.pendingCapabilities,
      deniedCapabilities: outcome.deniedCapabilities,
      ...(outcome.pendingCapabilities.length === 0 && outcome.deniedCapabilities.length === 0
        ? {}
        : {
            note: [
              outcome.pendingCapabilities.length === 0
                ? undefined
                : `${String(outcome.pendingCapabilities.length)} capability request(s) need approval before they work: ${outcome.pendingCapabilities.map((pending) => `${pending.ref} (approvalId ${pending.approvalId})`).join(", ")}. Resolve each with POST /packages/approvals/:id/decision.`,
              outcome.deniedCapabilities.length === 0
                ? undefined
                : `${String(outcome.deniedCapabilities.length)} capability request(s) were denied by policy: ${outcome.deniedCapabilities.join(", ")}.`,
            ]
              .filter((line): line is string => line !== undefined)
              .join(" "),
          }),
    });
  }

  /*
   * GET /packages/approvals
   *
   * The capability questions an install left open, for the host's own Settings to put to the person. Read here and
   * answered by the route below; never handed to a widget, which is exactly the party asking.
   */
  if (segments.length === 2 && segments[0] === "packages" && segments[1] === "approvals" && request.method === "GET") {
    return json(200, { approvals: listPendingCapabilityApprovals({ runtime, conductor: services.conductor }) });
  }

  /*
   * POST /packages/approvals/:id/decision
   *
   * Resolving a pending install-capability approval (N1). Node-scoped rather than conversation-scoped, because
   * this approval was never a step in a dispatched task — it is `installPackage`'s own record of a capability the
   * policy asked about. Owner-authenticated the same way the install route above is: the gateway's own token
   * check already ran before this route is reached, and the deciding principal is built from that authenticated
   * identity, never from the request body.
   */
  if (
    segments.length === 4 &&
    segments[0] === "packages" &&
    segments[1] === "approvals" &&
    segments[3] === "decision" &&
    request.method === "POST"
  ) {
    if (cameThroughMachineSurface(request)) return fail(403, PERSON_ONLY_REFUSAL.code, PERSON_ONLY_REFUSAL.message);
    const approvalId = segments[2];
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const decisionValue = parsed.value.decision;
    const decision = decisionValue === "granted" || decisionValue === "denied" ? decisionValue : undefined;
    const digest = typeof parsed.value.digest === "string" ? parsed.value.digest : "";
    if (approvalId === undefined || decision === undefined || digest === "") {
      return fail(400, "INVALID_SCHEMA", "a decision must carry decision: granted|denied and the digest it was shown");
    }

    const decidingPrincipal = { principalId: runtime.identity.ownerPrincipalId, kind: "user" as const, nodeId: runtime.identity.nodeId };

    /*
     * An install the person's policy asked about is decided here too, and approving it installs: the same person-only
     * route, told apart by the record `installPackage` wrote when it asked (`isInstallApproval`).
     */
    if (isInstallApproval({ runtime }, approvalId)) {
      const answered = await decideInstallApproval(packageInstallDepsOf(services), {
        approvalId,
        decision,
        decidingPrincipal,
        seenOperationDigest: digest,
      });
      if (!answered.ok) return fail(answered.status, answered.code, answered.message);
      if (answered.decision === "denied") {
        return json(200, { decision: "denied", packageId: answered.packageId, version: answered.version });
      }
      return json(200, {
        decision: "granted",
        installed: { packageId: answered.packageId, version: answered.version },
        generationId: answered.generationId,
        state: answered.state,
        pendingCapabilities: answered.pendingCapabilities,
        deniedCapabilities: answered.deniedCapabilities,
      });
    }

    const decided = decideInstallCapabilityApproval(
      { runtime, conductor: services.conductor },
      {
        approvalId,
        decision,
        decidingPrincipal,
        seenOperationDigest: digest,
      },
    );
    if (!decided.ok) return fail(decided.status, decided.code, decided.message);

    return json(200, {
      decision: decided.decision,
      ref: decided.ref,
      alreadyDecided: decided.alreadyDecided,
      ...(decided.generationId === undefined ? {} : { generationId: decided.generationId }),
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
    const index = readNodeDirectory(runtime.dataDir);
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

    /*
     * N2: a directory listing is a claim the publisher made, re-read fresh on every request, not proof this node
     * ever installed the thing it now names — the directory could republish `packageId@version` against a
     * different digest (a new source, a compromised registry entry) between install and this request, and the
     * old comment here ("the digest was already verified... so there is nothing more to check") only covered the
     * install that ran once, not every later `files` read of what is, from here, an untrusted listing. What this
     * node actually consented to and fetched is its own `package_generations` row (`installPackage`), so serving
     * checks that generation's digest, not merely that some file exists on disk for the current listing entry.
     */
    const generation = activeGeneration(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: () => "" },
      packageId,
      runtime.identity.nodeId,
    );
    if (generation === undefined || generation.version !== version || generation.digest !== entry.digest) {
      return fail(
        409,
        "NOT_INSTALLED",
        `${packageId}@${version} has no active installed generation on this node matching the directory's current digest`,
      );
    }

    // A local install is served from the snapshot its generation recorded, never from the path, whose files may have
    // changed since they were digested.
    const resolvedSource = resolveLocalSource(entry, join(runtime.dataDir, "package-cache"), generation);
    const entry_ = resolvedSource === entry.source ? entry : { ...entry, source: resolvedSource };

    const file = readPackageFile({ entry: entry_, relativePath: segments.slice(4).join("/") });
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
      // Checked at startup too; this refuses to serve if the variable was changed to something invalid since.
      const frameAncestors = resolveFrameAncestors(process.env["CC_APP_ORIGIN"]);
      if (!frameAncestors.ok) {
        return fail(500, frameAncestors.code, frameAncestors.message);
      }
      const nonce = randomUUID().replaceAll("-", "");
      // The package's own declared reach, not the empty default: a widget that asked in its manifest for a
      // network origin gets that origin in `connect-src`, and a widget that asked for nothing still gets
      // `'none'`, same as before this package's manifest was read here.
      // `readPackageFile` above only succeeds for a `kind: "local"` entry (see its own `NOT_A_LOCAL_PACKAGE`
      // refusal), so `entry_.source` is a local source by the time this line runs.
      const allowedOrigins =
        entry_.source.kind === "local" ? (readPackage(entry_.source.path).manifest.permissions?.networkOrigins ?? []) : [];
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
  return undefined;
}

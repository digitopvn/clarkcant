import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * A local stand-in for the npm registry: builds a real ustar tarball this repository's own `extractUstarTarball`
 * (`packages/core/src/package-fetch.ts`) parses, and serves it (with a real, freshly-computed integrity value)
 * from a packument + tarball endpoint shaped like the real registry's own.
 *
 * Shared between `packages/core/test/package-fetch.spec.ts` (unit-level, one entry per test) and the browser e2e
 * suite (`apps/runtime/src/test-support/npm-fixture-registry.ts`, one whole fixture directory) — both need the
 * exact same tar-building and serving logic; neither should reach the public registry, which is unreachable in a
 * sandboxed CI runner and would make the suite's outcome depend on npmjs.org rather than on this repository's own
 * code.
 */

export type TarEntrySpec = { content: string; type?: "file" | "symlink" | "traversal"; linkTarget?: string };

/** A minimal npm tarball: a gzip'd tar with one `package/` entry per file, built with plain buffers so this has no
 * dependency on a tar-writing library. Extended beyond a plain file to be able to construct the malicious shapes
 * `extractUstarTarball` must refuse: a symlink entry and a path-traversal name. */
export function buildNpmTarballFromFiles(files: Record<string, string | TarEntrySpec>): Buffer {
  const blocks: Buffer[] = [];
  for (const [relativePath, spec] of Object.entries(files)) {
    const normalized: TarEntrySpec = typeof spec === "string" ? { content: spec } : spec;
    const name = normalized.type === "traversal" ? relativePath : `package/${relativePath}`;
    const contentBuffer = Buffer.from(normalized.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8"); // mode
    header.write("0000000\0", 108, "utf8"); // uid
    header.write("0000000\0", 116, "utf8"); // gid
    header.write(contentBuffer.length.toString(8).padStart(11, "0") + "\0", 124, "utf8"); // size, octal
    header.write("00000000000\0", 136, "utf8"); // mtime
    header.write("        ", 148, "utf8"); // checksum placeholder
    header.write(normalized.type === "symlink" ? "2" : "0", 156, "utf8"); // typeflag
    if (normalized.type === "symlink" && normalized.linkTarget !== undefined) {
      header.write(normalized.linkTarget, 157, "utf8"); // linkname field
    }
    // ustar magic + version (N3: extractUstarTarball refuses a header without it), same as a real npm tarball
    // (built by node-tar) always carries.
    header.write("ustar\0", 257, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    const padded = Buffer.concat([contentBuffer, Buffer.alloc((512 - (contentBuffer.length % 512)) % 512)]);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks));
}

/** The same tarball shape as `buildNpmTarballFromFiles`, built from every regular file under a real directory on
 * disk rather than an inline object literal — what the e2e fixture registry uses, since its package is a real
 * checked-in fixture tree (`apps/web/e2e/fixtures/dashboard-widget`) rather than a handful of strings a single
 * test cares about. */
export function buildNpmTarballFromDirectory(rootDir: string): Buffer {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = relative(rootDir, full).split(sep).join("/");
      files[relativePath] = readFileSync(full, "utf8");
    }
  };
  walk(rootDir);
  return buildNpmTarballFromFiles(files);
}

export interface FakeNpmRegistryHandle {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

/** Starts a tiny HTTP server that answers exactly like an npm registry would for one package@version: a packument
 * at `GET /<name>` naming a tarball at `GET /tarball.tgz`, with `dist.integrity` computed for real over the bytes
 * actually served — so `verifyNpmIntegrity` (`packages/core/src/package-fetch.ts`) checks something genuine rather
 * than a value a caller merely trusts. */
export function startFakeNpmRegistry(input: {
  name: string;
  version: string;
  tarball: Buffer;
  /** Fixed port for a caller that needs a deterministic url wired into other processes before this one starts
   * (the e2e suite's Playwright config). Omitted (or 0) picks a free port, which is what a unit test wants. */
  port?: number;
  /** Corrupt the published integrity so a consuming test can prove the mismatch is refused. */
  wrongIntegrity?: boolean;
  /** Lie about the tarball's size in `content-length`, without changing the actual bytes served. */
  declaredContentLength?: number;
}): Promise<FakeNpmRegistryHandle> {
  const integrity = `sha512-${createHash("sha512").update(input.tarball).digest("base64")}`;
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === `/${input.name}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: input.name,
            versions: {
              [input.version]: {
                dist: {
                  tarball: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/tarball.tgz`,
                  integrity: input.wrongIntegrity === true ? `sha512-${"A".repeat(88)}` : integrity,
                },
              },
            },
          }),
        );
        return;
      }
      if (url === "/tarball.tgz") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(input.declaredContentLength === undefined ? {} : { "content-length": String(input.declaredContentLength) }),
        });
        res.end(input.tarball);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolvePromise({
        url: `http://127.0.0.1:${String(port)}`,
        server,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

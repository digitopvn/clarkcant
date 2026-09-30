import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstance, pinInstance } from "@clarkcant/core";
import { TABLE } from "@clarkcant/data-canvas";

import { contentDisposition } from "../src/routes/content-disposition.ts";
import { createNodeServer, type NodeServerOptions } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * File names people actually use, through the server the node boots.
 *
 * A route test calls the handler and reads the headers it returned as plain strings, so it cannot see what Node does
 * when it writes them: `writeHead` throws on a character outside Latin-1, and a Vietnamese file name then left Open,
 * Save As and an attachment's download waiting for an answer that never came. These requests go over a socket, so a
 * header Node would refuse fails here as it failed for a person.
 */

const NAME = "Kế hoạch quý.md";
const ENCODED = "K%E1%BA%BF%20ho%E1%BA%A1ch%20qu%C3%BD.md";
const TEXT = "# Kế hoạch\n\nviệc cần làm\n";

let dir: string;
let services: NodeServices;
let warnings: string[];
let servers: (() => Promise<void>)[];

async function start(extra: Partial<NodeServerOptions> = {}): Promise<string> {
  const server = createNodeServer({
    services,
    origin: "http://127.0.0.1",
    onWarning: (line) => warnings.push(line),
    ...extra,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function send(base: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${services.runtime.identity.localToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A conversation holding one widget instance, and a finalized text artifact that instance wrote under `NAME`. */
async function finalizedArtifact(base: string): Promise<{ conversationId: string; instanceId: string; artifactId: string }> {
  const conversation = await send(base, "POST", "/conversations", { title: "tệp" });
  const { conversationId } = await json<{ conversationId: string }>(conversation);
  const instanceId = createInstance(services.conductor, {
    definition: TABLE,
    packageDigest: "sha256:table",
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
    props: { title: "Tệp", datasetRef: "dataset_none", columns: ["name"] },
  }).instanceId;
  expect(pinInstance(services.conductor, { conversationId, instanceId, displayMode: "compact", maxPins: 64 }).ok).toBe(true);

  const widget = `/conversations/${conversationId}/widgets/${instanceId}/artifacts`;
  const created = await send(base, "POST", widget, { mimeType: "text/markdown", name: NAME });
  expect(created.status).toBe(201);
  const { artifactRef } = await json<{ artifactRef: { artifactId: string; name: string } }>(created);
  expect(artifactRef.name).toBe(NAME);
  const written = await send(base, "POST", `${widget}/${artifactRef.artifactId}/chunks`, {
    offset: 0,
    contentBase64: Buffer.from(TEXT).toString("base64"),
  });
  expect(written.status).toBe(200);
  expect((await send(base, "POST", `${widget}/${artifactRef.artifactId}/finalize`)).status).toBe(200);
  return { conversationId, instanceId, artifactId: artifactRef.artifactId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-artifact-server-"));
  services = bootNodeServices({ dataDir: dir, label: "artifact server test" });
  warnings = [];
  servers = [];
});

afterEach(async () => {
  for (const close of servers) await close();
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a Vietnamese file name over the wire", () => {
  it("opens a widget's file, with the real name for a current reader and an ASCII one for an old one", async () => {
    const base = await start();
    const { artifactId } = await finalizedArtifact(base);

    const opened = await send(base, "GET", `/artifacts/${artifactId}/content`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-disposition")).toBe(`inline; filename="Ke hoach quy.md"; filename*=UTF-8''${ENCODED}`);
    expect(await opened.text()).toBe(TEXT);
    expect(warnings).toEqual([]);
  });

  it("saves it under the name the person was offered, the type's extension kept", async () => {
    const base = await start();
    const { artifactId } = await finalizedArtifact(base);

    const saved = await send(base, "POST", `/artifacts/${artifactId}/export`, { suggestedName: "Báo cáo đầu năm.txt" });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Bao cao dau nam.md\"; filename*=UTF-8''B%C3%A1o%20c%C3%A1o%20%C4%91%E1%BA%A7u%20n%C4%83m.md",
    );
    // The web host reads the name back from the header, so the header has to be readable from the page.
    expect(saved.headers.get("access-control-expose-headers")).toContain("content-disposition");
    expect(await saved.text()).toBe(TEXT);
    expect(warnings).toEqual([]);
  });

  it("downloads an attachment the person sent under the same name", async () => {
    const base = await start();
    const conversation = await send(base, "POST", "/conversations", { title: "tệp" });
    const { conversationId } = await json<{ conversationId: string }>(conversation);
    const uploaded = await send(base, "POST", "/attachments", {
      conversationId,
      filename: NAME,
      mime: "text/markdown",
      contentBase64: Buffer.from(TEXT).toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    const { attachmentRef } = await json<{ attachmentRef: { attachmentId: string; filename: string } }>(uploaded);
    expect(attachmentRef.filename).toBe(NAME);

    const opened = await send(base, "GET", `/attachments/${attachmentRef.attachmentId}/content`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-disposition")).toBe(`inline; filename="Ke hoach quy.md"; filename*=UTF-8''${ENCODED}`);
    expect(await opened.text()).toBe(TEXT);
    expect(warnings).toEqual([]);
  });

  it("builds a header no name can break out of", () => {
    const header = contentDisposition("attachment", 'a"b\\c\r\nSet-Cookie: x=1\u0085.txt');
    expect(header).not.toMatch(/[\r\n\u0085]/u);
    expect(header.startsWith('attachment; filename="ab')).toBe(true);
    // Every character outside printable ASCII is percent-encoded, so Node never has a reason to refuse the header.
    expect(header).toMatch(/^[\x20-\x7e]*$/u);
    expect(contentDisposition("inline", "\u0000\u0007")).toBe(`inline; filename="file"; filename*=UTF-8''file`);
    // Clipped by code point: a name of astral characters is never cut through the middle of one.
    const clipped = contentDisposition("inline", "😀".repeat(200));
    expect(clipped).toContain(`filename*=UTF-8''${"%F0%9F%98%80".repeat(120)}`);
  });

  it("keeps the extension the node decided when a long name is clipped for the header", async () => {
    const base = await start();
    const { artifactId } = await finalizedArtifact(base);
    // 116 characters, then `.bat` and the type's `.md`: a clip at 120 characters used to leave `….bat`.
    const saved = await send(base, "POST", `/artifacts/${artifactId}/export`, { suggestedName: `${"a".repeat(116)}.bat.md` });
    expect(saved.status).toBe(200);
    const header = saved.headers.get("content-disposition") ?? "";
    expect(header).toMatch(/^attachment; filename="a+\.[^"]*\.md"; filename\*=UTF-8''a+\.\S*\.md$/u);
    expect(header).not.toMatch(/\.bat(?:"|$)/u);
    expect(header.length).toBeLessThan(400);
    expect(contentDisposition("attachment", `${"b".repeat(300)}.txt`)).toMatch(/filename\*=UTF-8''b{116}\.txt$/u);
    expect(warnings).toEqual([]);
  });

  it("drops the characters that reverse how a name reads, and keeps a percent sign out of the ASCII name", () => {
    // `invoice‮txt.exe` reads as `invoiceexe.txt` on screen while it is an `.exe`.
    const header = contentDisposition("attachment", "hoa-don‮gpj.txt");
    expect(header).toBe(`attachment; filename="hoa-dongpj.txt"; filename*=UTF-8''hoa-dongpj.txt`);
    for (const control of ["‎", "‏", "؜", "‪", "‫", "‬", "‭", "⁦", "⁧", "⁨", "⁩"]) {
      expect(contentDisposition("inline", `a${control}b.txt`)).toBe(`inline; filename="ab.txt"; filename*=UTF-8''ab.txt`);
    }
    // An old reader percent-decodes the plain `filename` too, so `%2e` there could become a different name.
    expect(contentDisposition("attachment", "100%2e.txt")).toBe(`attachment; filename="100_2e.txt"; filename*=UTF-8''100%252e.txt`);
  });
});

describe("a widget letting go of a file, over the wire", () => {
  it("discards the file it made, after which neither it nor the person can open it", async () => {
    const base = await start();
    const { conversationId, instanceId, artifactId } = await finalizedArtifact(base);
    const widget = `/conversations/${conversationId}/widgets/${instanceId}/artifacts`;

    const discarded = await send(base, "DELETE", `${widget}/${artifactId}`);
    expect(discarded.status).toBe(200);
    expect(await json<unknown>(discarded)).toEqual({ discarded: true, artifactId });

    expect((await send(base, "GET", `${widget}/${artifactId}/content`)).status).toBe(404);
    expect((await send(base, "GET", `/artifacts/${artifactId}/content`)).status).toBe(404);
    const again = await send(base, "DELETE", `${widget}/${artifactId}`);
    expect(again.status).toBe(404);
    expect(await json<{ code: string }>(again)).toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });
});

describe("an answer the transport cannot write", () => {
  it("is answered with a reason instead of leaving the request waiting", async () => {
    const base = await start({
      handle: () =>
        Promise.resolve({
          status: 200,
          body: null,
          binary: { bytes: new Uint8Array([1]), contentType: "text/plain", headers: { "content-disposition": "inline; filename=\"Kế.md\"" } },
        }),
    });

    const response = await send(base, "GET", "/artifacts/art_x/content");
    expect(response.status).toBe(500);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("RESPONSE_NOT_WRITTEN");
    expect(warnings.some((line) => line.includes("could not be written"))).toBe(true);
  });
});

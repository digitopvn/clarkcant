import { describe, expect, it } from "vitest";

import { GatewayClient, GatewayError } from "../src/api.ts";
import { artifactRefusal } from "../src/widget-artifacts.tsx";

/**
 * The client's end of a widget's file requests.
 *
 * What is pinned here is that the client says exactly which instance it speaks for on every call, parses what the node
 * answers instead of trusting it, and carries the node's own refusal to the widget — the three things that keep an
 * artifact reference a pointer the node re-checks rather than something this page could stretch.
 */

const REF = {
  v: 1,
  artifactId: "art_one",
  kind: "working",
  mimeType: "text/plain",
  sizeBytes: 3,
  name: "ghi-chu.txt",
};

function clientAnswering(respond: (url: string, init: RequestInit | undefined) => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const client = new GatewayClient({
    baseUrl: "http://127.0.0.1:8765",
    token: "tok",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return respond(url, init);
    }) as typeof fetch,
  });
  return { client, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the artifact calls a frame's host makes", () => {
  it("names the conversation and instance on every widget call, and parses the reference it gets back", async () => {
    const { client, calls } = clientAnswering(() => json(201, { artifactRef: REF }));

    const ref = await client.createArtifact("conv_1", "winst_1", { mimeType: "text/plain" });
    await client.writeArtifactChunk("conv_1", "winst_1", "art_one", { offset: 0, contentBase64: "YWJj" });

    expect(ref).toEqual(REF);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8765/conversations/conv_1/widgets/winst_1/artifacts",
      "POST http://127.0.0.1:8765/conversations/conv_1/widgets/winst_1/artifacts/art_one/chunks",
    ]);
    expect(calls[1]?.body).toEqual({ offset: 0, contentBase64: "YWJj" });
  });

  it("refuses an answer whose reference is not one, rather than handing the widget a guess", async () => {
    // A path where a name should be is exactly what the contract refuses.
    const { client } = clientAnswering(() => json(200, { artifactRef: { ...REF, name: "C:/Users/me/ghi-chu.txt" } }));

    await expect(client.finalizeArtifact("conv_1", "winst_1", "art_one")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("reads a bounded range and says whether the file ended", async () => {
    const { client, calls } = clientAnswering(() => json(200, { artifactRef: REF, offset: 0, eof: false, contentBase64: "YQ==" }));

    const read = await client.readArtifactRange("conv_1", "winst_1", "art_one", { offset: 4, length: 2 });

    expect(read).toEqual({ artifactRef: REF, contentBase64: "YQ==", eof: false });
    expect(calls[0]?.url).toBe("http://127.0.0.1:8765/conversations/conv_1/widgets/winst_1/artifacts/art_one/content?offset=4&length=2");
  });

  it("attaches through the node and hands back the attachment the composer shows", async () => {
    const attachmentRef = {
      attachmentId: "att_1",
      filename: "ghi-chu.txt",
      mime: "text/plain",
      kind: "text",
      sizeBytes: 3,
      sha256: `sha256:${"a".repeat(64)}`,
      blobRef: `${"a".repeat(32)}.txt`,
    };
    const { client } = clientAnswering(() =>
      json(201, { artifactRef: { ...REF, kind: "finalized", digest: `sha256:${"a".repeat(64)}` }, attachmentRef }),
    );

    const attached = await client.attachArtifact("conv_1", "winst_1", "art_one");

    expect(attached.attachmentRef).toEqual(attachmentRef);
  });

  it("exports as the person and saves under the name the node settled on", async () => {
    const { client, calls } = clientAnswering(
      () =>
        new Response("abc", {
          status: 200,
          headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="bao-cao.txt"' },
        }),
    );

    const exported = await client.exportArtifact("art_one", "bao-cao.txt");

    expect(exported.filename).toBe("bao-cao.txt");
    expect(await exported.blob.text()).toBe("abc");
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8765/artifacts/art_one/export", body: { suggestedName: "bao-cao.txt" } });
  });

  it("carries the node's refusal of an export with its own code", async () => {
    const { client } = clientAnswering(() => json(409, { code: "ARTIFACT_NOT_FINALIZED", message: "finalize it first" }));

    await expect(client.exportArtifact("art_one")).rejects.toMatchObject({ status: 409, code: "ARTIFACT_NOT_FINALIZED" });
  });
});

describe("what the widget is told when the node refuses", () => {
  it("passes the node's code and sentence, without the code repeated in front of it", () => {
    expect(artifactRefusal(new GatewayError(403, "ARTIFACT_NOT_GRANTED", "this instance was not given that file"))).toEqual({
      status: "refused",
      code: "ARTIFACT_NOT_GRANTED",
      message: "this instance was not given that file",
    });
  });

  it("says the node was unreachable when nothing answered", () => {
    expect(artifactRefusal(new TypeError("Failed to fetch"))).toEqual({
      status: "refused",
      code: "ARTIFACT_UNAVAILABLE",
      message: "Failed to fetch",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayClient, GatewayError } from "../src/api.ts";
import { artifactReason, artifactTypesLabel, DesktopFileError, desktopDialogLabels } from "../src/artifact-messages.ts";
import { saveForPerson } from "../src/download.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import { artifactRefusal, exportTitle, pickedFileType, pickTitle, replaceOriginalLabel } from "../src/widget-artifacts.tsx";

const vi_t = (key: MessageKey): string => MESSAGES_VI[key];
const en_t = (key: MessageKey): string => MESSAGES_EN[key];
const HOST_PATH = "C:\\Users\\x\\f.csv";

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
    expect(exported.mimeType).toBe("text/plain");
    expect(await exported.blob.text()).toBe("abc");
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8765/artifacts/art_one/export", body: { suggestedName: "bao-cao.txt" } });
  });

  it("reports the type the node sent the bytes as, not the one the card claimed", async () => {
    const { client } = clientAnswering(
      () =>
        new Response("%PDF-1.7", {
          status: 200,
          headers: { "content-type": "Application/PDF; charset=binary", "content-disposition": 'attachment; filename="bao-cao.pdf"' },
        }),
    );

    const exported = await client.exportArtifact("art_one", "bao-cao.txt");

    expect(exported).toMatchObject({ filename: "bao-cao.pdf", mimeType: "application/pdf" });
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

  it("says the node was unreachable when nothing answered, in a fixed sentence rather than the error's", () => {
    expect(artifactRefusal(new TypeError("Failed to fetch"))).toEqual({
      status: "refused",
      code: "ARTIFACT_UNAVAILABLE",
      message: "the node could not be reached",
    });
  });

  it("never hands the widget the text of an error that names a path on the person's disk", () => {
    const leaks = [
      new Error(`EBUSY: resource busy or locked, open '${HOST_PATH}'`),
      new DesktopFileError("READ_FAILED", "EBUSY"),
      new DesktopFileError(`the file ${HOST_PATH} is gone`),
      HOST_PATH,
    ];
    for (const during of ["request", "pick", "save"] as const) {
      for (const cause of leaks) {
        const refusal = artifactRefusal(cause, during);
        expect(JSON.stringify(refusal)).not.toContain("Users");
        expect(refusal).toMatchObject({ status: "refused" });
      }
    }
    expect(artifactRefusal(new DesktopFileError("READ_FAILED"), "pick")).toMatchObject({ code: "ARTIFACT_PICK_FAILED" });
    expect(artifactRefusal(new DesktopFileError("WRITE_FAILED"), "save")).toMatchObject({ code: "ARTIFACT_SAVE_FAILED" });
  });
});

describe("what the person reads about a widget's files", () => {
  it("names accepted types as a person says them, in either language", () => {
    expect(artifactTypesLabel(["text/*"], vi_t)).toBe("tệp văn bản");
    expect(artifactTypesLabel(["image/png", "application/pdf"], vi_t)).toBe("ảnh PNG, tệp PDF");
    expect(artifactTypesLabel(["image/png", "application/pdf"], en_t)).toBe("PNG images, PDF files");
    expect(artifactTypesLabel(["text/csv", "text/csv"], en_t)).toBe("CSV spreadsheets");
    expect(artifactTypesLabel(["application/zip"], en_t)).toBe("files of type application/zip");
    expect(artifactTypesLabel([], vi_t)).toBe(MESSAGES_VI["widgets.artifacts.anyType"]);
  });

  it("words a refusal by its code in the person's language, never in the node's English or an error's text", () => {
    const quota = new GatewayError(409, "ARTIFACT_INSTANCE_QUOTA_EXCEEDED", "this widget holds 134217728 bytes of files");
    expect(artifactReason(quota, vi_t)).toBe("Widget này đã dùng hết chỗ lưu tệp dành cho nó.");
    expect(artifactReason(quota, en_t)).toBe("This widget has used all the file space it is allowed.");
    // A code this page has no sentence for is said generally, not in the node's words.
    expect(artifactReason(new GatewayError(400, "ARTIFACT_SOMETHING_NEW", "english reason"), vi_t)).toBe("Node đã từ chối yêu cầu này.");
    expect(artifactReason(new DesktopFileError("READ_FAILED", "EBUSY"), vi_t)).toBe("Không đọc được tệp trên máy này. (EBUSY)");
    expect(artifactReason(new Error(`open '${HOST_PATH}'`), en_t)).toBe("The node could not be reached.");
  });

  it("keeps a desktop refusal's codes only in their own shapes", () => {
    const shaped = new DesktopFileError(`gone: ${HOST_PATH}`, HOST_PATH);
    expect(shaped.code).toBe("DESKTOP_FAILED");
    expect(shaped.errorCode).toBeUndefined();
    expect(shaped.message).not.toContain("Users");
  });

  it("drops the characters that reverse how a name reads from the question's first line", () => {
    // Shown as `“Ghi chú” muốn lưu “hoa-donexe.txt”`, while the file is `hoa-don‮txt.exe`.
    expect(exportTitle(vi_t, "Ghi chú\u202e", "hoa-don\u202etxt.exe")).toBe("“Ghi chú” muốn lưu “hoa-dontxt.exe”");
    expect(exportTitle(en_t, " \u2067 ", "a\u200fb.txt")).toBe(MESSAGES_EN["widgets.artifacts.saveTitle"].replace("{name}", "ab.txt"));
    expect(pickTitle(vi_t, "Bảng\u202e tính")).toBe(MESSAGES_VI["widgets.artifacts.pickTitleNamed"].replace("{widget}", "Bảng tính"));
    // A name that looks like a placeholder, or a replacement pattern, is shown as it is.
    expect(exportTitle(en_t, "{name}", "$&.txt")).toBe("“{name}” wants to save “$&.txt”");
  });

  it("offers to write over the picked file only with a file of its type, and names both", () => {
    const original = { name: "so-lieu.csv", handle: "h_1", mimeType: "text/csv" };
    const csv = { ...REF, kind: "finalized", mimeType: "text/csv", name: "ban-sua.csv" } as never;
    expect(replaceOriginalLabel(en_t, original, csv, "ban-sua.csv")).toBe("Replace “so-lieu.csv” with “ban-sua.csv”");
    expect(replaceOriginalLabel(vi_t, original, csv, "ban-sua.csv")).toBe("Ghi đè “so-lieu.csv” bằng “ban-sua.csv”");
    // A file of another type has nothing to do with the one picked, and the desktop would refuse to write it there.
    expect(replaceOriginalLabel(en_t, original, { ...REF, kind: "finalized" } as never, "ghi-chu.txt")).toBeUndefined();
    expect(replaceOriginalLabel(en_t, undefined, csv, "ban-sua.csv")).toBeUndefined();
    expect(replaceOriginalLabel(en_t, { ...original, name: "a\u202e.csv" }, csv, "b\u2066.csv")).toBe("Replace “a.csv” with “b.csv”");
  });

  it("passes the dialogs' words in the person's language", () => {
    expect(desktopDialogLabels(vi_t)).toEqual({
      filterName: "Tệp",
      replaceTitle: "Ghi đè tệp",
      replaceMessage: "Ghi đè “{name}” bằng bản này?",
      replace: "Ghi đè",
      cancel: MESSAGES_VI["widgets.artifacts.cancel"],
    });
  });
});

describe("what a browser pick sends as the file's type", () => {
  it("sends the browser's type as given, and never a binary type for a file the browser could not name", () => {
    expect(pickedFileType({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(pickedFileType({ name: "ghi-chu.md", type: "" })).toBe("text/markdown");
    expect(pickedFileType({ name: "so-lieu.CSV", type: "" })).toBe("text/csv");
    // Empty, so the node reads the bytes: a .log file is text, not application/octet-stream.
    expect(pickedFileType({ name: "nhat-ky.log", type: "" })).toBe("");
    expect(pickedFileType({ name: "README", type: "" })).toBe("");
  });

  it("calls a type by the name the node knows it by, and leaves a generic type for the node to read from the bytes", () => {
    expect(pickedFileType({ name: "so-lieu.csv", type: "application/vnd.ms-excel" })).toBe("text/csv");
    expect(pickedFileType({ name: "ghi-chu.md", type: "text/x-markdown" })).toBe("text/markdown");
    expect(pickedFileType({ name: "anh.jpg", type: "image/jpg" })).toBe("image/jpeg");
    expect(pickedFileType({ name: "ghi-chu.md", type: "application/octet-stream" })).toBe("text/markdown");
    expect(pickedFileType({ name: "nhat-ky.log", type: "application/octet-stream" })).toBe("");
  });
});

describe("what a save reports", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bridge = (answer: Record<string, unknown> | Error) => {
    const saveFile = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    vi.stubGlobal("window", { clarkcant: { pickFile: vi.fn(), saveFile }, setTimeout });
    return saveFile;
  };

  it("says a browser download started, never that it saved", async () => {
    const clicked: string[] = [];
    vi.stubGlobal("window", { setTimeout: () => 0 });
    vi.stubGlobal("document", {
      createElement: () => {
        const link = { download: "", href: "", rel: "", style: {}, click: () => clicked.push(link.download), remove: () => undefined };
        return link;
      },
      body: { append: () => undefined },
    });

    const outcome = await saveForPerson(new Blob(["abc"]), "Kế hoạch.md", { mimeType: "text/markdown" });

    expect(outcome).toEqual({ outcome: "downloaded", name: "Kế hoạch.md" });
    expect(clicked).toEqual(["Kế hoạch.md"]);
  });

  it("hands the desktop the file's type and the dialogs' words, and reports what it did", async () => {
    const saveFile = bridge({ ok: true, canceled: false, saved: true, name: "Kế hoạch.md" });

    const outcome = await saveForPerson(new Blob(["abc"]), "Kế hoạch.md", { mimeType: "text/markdown", labels: desktopDialogLabels(vi_t) });

    expect(outcome).toEqual({ outcome: "saved", name: "Kế hoạch.md" });
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "text/markdown", labels: expect.objectContaining({ filterName: "Tệp" }) }));
    bridge({ ok: true, canceled: true });
    await expect(saveForPerson(new Blob(["abc"]), "a.md", { mimeType: "text/markdown" })).resolves.toEqual({ outcome: "cancelled", name: "a.md" });
  });

  it("throws the desktop's code, not its text, when the save was refused or the bridge threw", async () => {
    bridge({ ok: false, refused: "WRITE_FAILED", errorCode: "EACCES" });
    await expect(saveForPerson(new Blob(["abc"]), "a.md", { mimeType: "text/markdown" })).rejects.toMatchObject({
      code: "WRITE_FAILED",
      errorCode: "EACCES",
    });

    bridge(new Error(`EPERM: operation not permitted, open '${HOST_PATH}'`));
    const thrown = await saveForPerson(new Blob(["abc"]), "a.md", { mimeType: "text/markdown" }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(DesktopFileError);
    expect(String((thrown as Error).message)).not.toContain("Users");
  });
});

import { describe, expect, it, vi } from "vitest";

/**
 * Files attached for the next message, carried into a new conversation after a restart left the one they were stored in.
 *
 * The hook runs against a small stand-in for React's hooks, so the chip list it keeps can be read after each step.
 */

// Refs are kept by the order the hook asks for them, as React keeps them; `next` restarts at each render.
const hooks = { reducer: undefined as { state: unknown } | undefined, refs: [] as { current: unknown }[], next: 0 };

vi.mock("react", () => ({
  useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown) => {
    const slot = (hooks.reducer ??= { state: initial });
    return [slot.state, (action: unknown) => (slot.state = reducer(slot.state, action))];
  },
  useState: (initial: unknown) => [initial, () => undefined],
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => (hooks.refs[hooks.next++] ??= { current: initial }),
}));

const { useAttachmentComposer } = await import("../src/use-attachment-composer.ts");
type Chip = ReturnType<typeof useAttachmentComposer>["chips"][number];

const STORED: Chip = { id: "chip_1", filename: "bao-cao.txt", mime: "text/plain", sizeBytes: 5, state: "ready", attachmentId: "att_old" };

/** A refusal as the client throws it: the node's code beside its English sentence. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function page(
  read: (attachmentId: string) => Promise<Blob>,
  held?: Promise<void>,
  overrides: { create?: () => Promise<{ conversationId: string }>; refuseNew?: unknown } = {},
) {
  hooks.reducer = undefined;
  hooks.refs = [];
  const created: string[] = [];
  const reads: string[] = [];
  const uploads: { conversationId: string; filename: string; contentBase64: string }[] = [];
  const client = {
    createConversation: overrides.create ?? (async () => ({ conversationId: "conv_new" })),
    attachmentBlob: (attachmentId: string) => {
      reads.push(attachmentId);
      return read(attachmentId);
    },
    uploadAttachment: async (input: { conversationId: string; filename: string; contentBase64: string }) => {
      // An upload into the conversation left behind can be held, so the restart lands while it is still on its way.
      if (input.conversationId === "conv_old" && held !== undefined) await held;
      if (input.conversationId === "conv_new" && overrides.refuseNew !== undefined) throw overrides.refuseNew;
      uploads.push(input);
      return { attachmentId: input.conversationId === "conv_old" ? "att_old" : "att_new" };
    },
  };
  const render = () => {
    hooks.next = 0;
    return useAttachmentComposer({
      client: client as never,
      // The restart that carries the files has just set this to nothing; the render it happens in still names the old one.
      conversationId: "conv_old",
      onConversationCreated: (id) => created.push(id),
      onErrorCleared: () => undefined,
      t: (key) => key,
    });
  };
  return { render, created, reads, uploads };
}

const readable = async () => new Blob(["xin chào"], { type: "text/plain" });

describe("carrying files into a new conversation", () => {
  it("stores each ready file again in a new conversation, never the one left behind", async () => {
    const { render, created, uploads } = page(async () => new Blob(["xin chào"], { type: "text/plain" }));
    // A failed one already said why, and stays behind.
    render().carryOver([STORED, { ...STORED, id: "chip_2", state: "failed", reason: "quá lớn" }]);
    // On screen at once, as a file being stored, so a send waits for it.
    expect(render().chips.map((chip) => chip.state)).toEqual(["checking"]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["ready"]));
    expect(created).toEqual(["conv_new"]);
    expect(uploads).toEqual([
      { conversationId: "conv_new", filename: "bao-cao.txt", mime: "text/plain", contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode("xin chào"))) },
    ]);
    expect(render().chips[0]).toMatchObject({ filename: "bao-cao.txt", attachmentId: "att_new" });
  });

  it("leaves a failed chip saying why, in the person's language, when the file cannot be read back", async () => {
    const { render, uploads } = page(async () => {
      throw new Error("that attachment could not be read");
    });
    render().carryOver([STORED]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    // The translator's key, not the client's English refusal.
    expect(render().chips[0]?.reason).toBe("shell.attachment.notReadBack");
    expect(uploads).toEqual([]);
  });

  it("carries a file still uploading when the restart lands, stored again from the same bytes", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { render, created, uploads } = page(async () => {
      throw new Error("nothing is stored yet to read back");
    }, held);
    const file = new File(["đang tải lên"], "ghi-chu.txt", { type: "text/plain" });
    const adding = render().addFiles([file]);
    const uploadingChip = render().chips[0];
    expect(uploadingChip?.state).toBe("checking");

    // The restart clears the composer and carries what was attached since Enter.
    render().dispatchChips({ type: "cleared" });
    render().carryOver(uploadingChip === undefined ? [] : [uploadingChip]);
    expect(render().chips.map((chip) => chip.state)).toEqual(["checking"]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["ready"]));
    expect(created).toEqual(["conv_new"]);
    const content = btoa(String.fromCharCode(...new TextEncoder().encode("đang tải lên")));
    expect(uploads).toEqual([{ conversationId: "conv_new", filename: "ghi-chu.txt", mime: "text/plain", contentBase64: content }]);
    expect(render().chips[0]).toMatchObject({ filename: "ghi-chu.txt", attachmentId: "att_new" });

    // The upload into the conversation left behind ends there; it does not touch the carried chip.
    release();
    await adding;
    expect(render().chips).toHaveLength(1);
    expect(render().chips[0]).toMatchObject({ attachmentId: "att_new", state: "ready" });
  });

  it("says on a chip that a file was not carried when nothing is left to read it from", () => {
    const { render, uploads } = page(async () => new Blob([]));
    const { attachmentId: _none, ...rest } = STORED;
    render().carryOver([{ ...rest, id: "chip_unknown", state: "checking" }]);

    expect(render().chips).toHaveLength(1);
    expect(render().chips[0]).toMatchObject({ filename: "bao-cao.txt", state: "failed", reason: "shell.attachment.notCarried" });
    expect(uploads).toEqual([]);
  });

  it("reads back a file whose upload finished before the restart's chip list caught up", async () => {
    const { render, created, reads, uploads } = page(readable);
    const file = new File(["xin chào"], "bao-cao.txt", { type: "text/plain" });
    const adding = render().addFiles([file]);
    // The list the restart reads was taken while the file was still on its way.
    const stale = render().chips[0];
    expect(stale?.state).toBe("checking");
    // The upload lands and is stored before that list is drawn again, and the restart lands at once.
    await adding;
    render().dispatchChips({ type: "cleared" });
    render().carryOver(stale === undefined ? [] : [stale]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["ready"]));
    expect(reads).toEqual(["att_old"]);
    expect(created).toEqual(["conv_new"]);
    expect(uploads.map((upload) => upload.conversationId)).toEqual(["conv_old", "conv_new"]);
    expect(render().chips[0]).toMatchObject({ filename: "bao-cao.txt", attachmentId: "att_new" });
  });

  it.each([
    ["ATTACHMENT_NAME_NOT_ALLOWED", "shell.attachment.refused.name"],
    ["ATTACHMENT_TYPE_UNSUPPORTED", "shell.attachment.refused.typeUnsupported"],
    ["ATTACHMENT_TYPE_MISMATCH", "shell.attachment.refused.typeMismatch"],
    ["ATTACHMENT_TOO_LARGE", "shell.attachment.refused.tooLarge"],
    ["ATTACHMENT_QUOTA_EXCEEDED", "shell.attachment.refused.quota"],
  ])("says the node's %s refusal in the person's language", async (code, key) => {
    const { render } = page(readable, undefined, { refuseNew: refusal(code, "an English sentence from the node") });
    render().carryOver([STORED]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    expect(render().chips[0]?.reason).toBe(key);
  });

  it.each([
    ["a refusal this client does not know", refusal("RESOURCE_NOT_FOUND", "that conversation is not on this node")],
    ["a connection that failed", new TypeError("Failed to fetch")],
  ])("falls back to a sentence in the person's language for %s", async (_label, cause) => {
    const { render } = page(readable, undefined, { refuseNew: cause });
    render().carryOver([STORED]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    expect(render().chips[0]?.reason).toBe("shell.attachment.notStored");
  });

  it("says in the person's language that the new conversation could not be made", async () => {
    const { render, uploads } = page(readable, undefined, {
      create: async () => {
        throw refusal("NODE_UNREACHABLE", "the node did not answer");
      },
    });
    render().carryOver([STORED]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    expect(render().chips[0]?.reason).toBe("shell.attachment.notStored");
    expect(uploads).toEqual([]);
  });

  it("says in the person's language that a file still uploading could not be read again", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { render, uploads } = page(readable, held);
    // Read once for the upload it is on its way in; the second read, for the carry, fails.
    const arrayBuffer = vi
      .fn<() => Promise<ArrayBuffer>>()
      .mockResolvedValueOnce(new TextEncoder().encode("xin chào").buffer as ArrayBuffer)
      .mockRejectedValueOnce(new DOMException("The file could not be read", "NotReadableError"));
    const file = { name: "bao-cao.txt", type: "text/plain", size: 9, arrayBuffer } as unknown as File;
    const adding = render().addFiles([file]);
    const uploadingChip = render().chips[0];
    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledTimes(1));

    render().dispatchChips({ type: "cleared" });
    render().carryOver(uploadingChip === undefined ? [] : [uploadingChip]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    expect(render().chips[0]?.reason).toBe("shell.attachment.notReadBack");
    release();
    await adding;
    expect(uploads.map((upload) => upload.conversationId)).toEqual(["conv_old"]);
  });
});

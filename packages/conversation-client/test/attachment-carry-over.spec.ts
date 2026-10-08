import { describe, expect, it, vi } from "vitest";

/**
 * Files attached for the next message, carried into a new conversation after a restart left the one they were stored in.
 *
 * The hook runs against a small stand-in for React's hooks, so the chip list it keeps can be read after each step.
 */

const hooks = { reducer: undefined as { state: unknown } | undefined };

vi.mock("react", () => ({
  useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown) => {
    const slot = (hooks.reducer ??= { state: initial });
    return [slot.state, (action: unknown) => (slot.state = reducer(slot.state, action))];
  },
  useState: (initial: unknown) => [initial, () => undefined],
  useCallback: (fn: unknown) => fn,
}));

const { useAttachmentComposer } = await import("../src/use-attachment-composer.ts");
type Chip = ReturnType<typeof useAttachmentComposer>["chips"][number];

const STORED: Chip = { id: "chip_1", filename: "bao-cao.txt", mime: "text/plain", sizeBytes: 5, state: "ready", attachmentId: "att_old" };

function page(read: (attachmentId: string) => Promise<Blob>) {
  hooks.reducer = undefined;
  const created: string[] = [];
  const uploads: { conversationId: string; filename: string; contentBase64: string }[] = [];
  const client = {
    createConversation: async () => ({ conversationId: "conv_new" }),
    attachmentBlob: read,
    uploadAttachment: async (input: { conversationId: string; filename: string; contentBase64: string }) => {
      uploads.push(input);
      return { attachmentId: "att_new" };
    },
  };
  const render = () =>
    useAttachmentComposer({
      client: client as never,
      // The restart that carries the files has just set this to nothing; the render it happens in still names the old one.
      conversationId: "conv_old",
      onConversationCreated: (id) => created.push(id),
      onErrorCleared: () => undefined,
      t: (key) => key,
    });
  return { render, created, uploads };
}

describe("carrying files into a new conversation", () => {
  it("stores each ready file again in a new conversation, never the one left behind", async () => {
    const { render, created, uploads } = page(async () => new Blob(["xin chào"], { type: "text/plain" }));
    // One still uploading has no stored file to read back, so only the ready one travels.
    const { attachmentId: _uploading, ...checking } = STORED;
    render().carryOver([STORED, { ...checking, id: "chip_2", state: "checking" }]);
    // On screen at once, as a file being stored, so a send waits for it.
    expect(render().chips.map((chip) => chip.state)).toEqual(["checking"]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["ready"]));
    expect(created).toEqual(["conv_new"]);
    expect(uploads).toEqual([
      { conversationId: "conv_new", filename: "bao-cao.txt", mime: "text/plain", contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode("xin chào"))) },
    ]);
    expect(render().chips[0]).toMatchObject({ filename: "bao-cao.txt", attachmentId: "att_new" });
  });

  it("leaves a failed chip saying why when the file cannot be read back", async () => {
    const { render, uploads } = page(async () => {
      throw new Error("that attachment could not be read");
    });
    render().carryOver([STORED]);

    await vi.waitFor(() => expect(render().chips.map((chip) => chip.state)).toEqual(["failed"]));
    expect(render().chips[0]?.reason).toBe("that attachment could not be read");
    expect(uploads).toEqual([]);
  });
});

import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react";

import { type ArtifactRef, type AttachmentRef, normalizePickedType, stripBidiControls } from "@clarkcant/contracts";
import type { FrameArtifactBroker, FrameArtifactOutcome } from "@clarkcant/widget-host/session";

import { type GatewayClient, GatewayError } from "./api.ts";
import { artifactReason, artifactTypesLabel, DesktopFileError, desktopDialogLabels } from "./artifact-messages.ts";
import { formatFileSize, toBase64 } from "./attachments.ts";
import { desktopFileBridge, saveForPerson } from "./download.ts";
import { fillMessage } from "./i18n/fill-message.ts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The host's side of a widget's `artifacts@1` requests: the broker the frame session hands them to, and the host
 * chrome a person answers the two that need them in.
 *
 * Reads, writes and finalizing go straight to the node, which checks this instance's grant on every one. Picking a file
 * and saving one are the person's, so they are never done on the widget's word: the widget's request puts a panel in
 * host chrome, outside the frame, and nothing happens until the person presses a button there. On the desktop the
 * buttons open the OS dialogs; in a browser, picking is the browser's own file input and saving is its download.
 *
 * No path reaches the widget or this page: a pick returns a reference, a save returns whether it was saved, and a file
 * written back on the desktop is named by an opaque handle the shell's main process keeps. Nor does an error's text:
 * the widget is told the node's own refusal or a fixed sentence, and the person reads a sentence in their language
 * chosen by the refusal's code (`artifact-messages.ts`).
 */

export interface WidgetArtifactHostInput {
  client: GatewayClient;
  conversationId: string;
  instanceId: string;
  /** The widget's title, so the person knows which widget is asking. */
  widgetTitle?: string | undefined;
  /** A finalized artifact the widget attached: it goes into the composer, where the person decides whether to send it. */
  onAttach?: ((attachment: AttachmentRef) => void) | undefined;
}

type PromptRequest = { kind: "pick"; accept: readonly string[] } | { kind: "export"; ref: ArtifactRef; suggestedName: string };
type Prompt = PromptRequest & { settle: (outcome: FrameArtifactOutcome) => void };

interface Notice {
  tone: "info" | "error";
  text: string;
}

/**
 * A refusal the widget can read: the node's own code and sentence when the node gave one, and otherwise a fixed one.
 *
 * Never the message of any other error. What threw on the way — a fetch, the desktop bridge, the file system behind it —
 * may name a path on the person's disk, and the widget is exactly who must not learn it.
 */
export function artifactRefusal(cause: unknown, during: "request" | "pick" | "save" = "request"): FrameArtifactOutcome {
  if (cause instanceof GatewayError) return { status: "refused", code: cause.code, message: cause.reason };
  if (during === "pick") return { status: "refused", code: "ARTIFACT_PICK_FAILED", message: "the person's file could not be handed over" };
  if (during === "save") return { status: "refused", code: "ARTIFACT_SAVE_FAILED", message: "the file was not saved" };
  return { status: "refused", code: "ARTIFACT_UNAVAILABLE", message: "the node could not be reached" };
}

/** Node refusals that mean the widget has no room left, which the person is told about as well as the widget. */
const OUT_OF_ROOM = new Set(["ARTIFACT_QUOTA_EXCEEDED", "ARTIFACT_INSTANCE_QUOTA_EXCEEDED"]);

/**
 * A browser's own guess at a file's type, under the name the node knows it by (`normalizePickedType`): another name for
 * an allowed type becomes that type, and no guess or a generic one becomes the text type the extension names, or nothing
 * for the node to read from the bytes. Either is only a claim: the node reads the bytes and refuses a file that is not
 * what it says.
 */
export function pickedFileType(file: { name: string; type: string }): string {
  return normalizePickedType(file.type, file.name);
}

export function useWidgetArtifactHost(input: WidgetArtifactHostInput): { broker: FrameArtifactBroker; chrome: ReactElement | null } {
  const t = useT();
  const latest = useRef(input);
  latest.current = input;
  const [prompt, setPrompt] = useState<Prompt | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const pending = useRef<Prompt | undefined>(undefined);
  /** The last file this frame's person picked on the desktop, once the node holds it. */
  const original = useRef<PickedOriginal | undefined>(undefined);
  /** What the polite live region beside the frame says: a question asked while the keyboard was somewhere else. */
  const [announcement, setAnnouncement] = useState("");

  const settle = useCallback((outcome: FrameArtifactOutcome) => {
    const current = pending.current;
    pending.current = undefined;
    setPrompt(undefined);
    setBusy(false);
    setAnnouncement("");
    current?.settle(outcome);
  }, []);

  // A frame that goes away with a question open gets its answer: the person did not choose.
  useEffect(
    () => () => {
      pending.current?.settle({ status: "cancelled" });
      pending.current = undefined;
    },
    [],
  );

  const ask = useCallback((next: PromptRequest): Promise<FrameArtifactOutcome> => {
    if (pending.current !== undefined) {
      return Promise.resolve({ status: "refused", code: "ARTIFACT_BUSY", message: "the person is already answering a file request" });
    }
    return new Promise<FrameArtifactOutcome>((resolve) => {
      const full: Prompt = { ...next, settle: resolve };
      pending.current = full;
      setNotice(undefined);
      setPrompt(full);
    });
  }, []);

  const broker = useCallback<FrameArtifactBroker>(
    async (request) => {
      const { client, conversationId, instanceId } = latest.current;
      try {
        switch (request.op) {
          case "pick":
            return await ask({ kind: "pick", accept: request.accept });
          case "read": {
            const read = await client.readArtifactRange(conversationId, instanceId, request.artifactId, {
              offset: request.offset,
              length: request.length,
            });
            return { status: "ok", ref: read.artifactRef, chunkBase64: read.contentBase64, eof: read.eof };
          }
          case "create":
            return {
              status: "ok",
              ref: await client.createArtifact(conversationId, instanceId, {
                mimeType: request.mimeType,
                ...(request.name === undefined ? {} : { name: request.name }),
              }),
            };
          case "write":
            return {
              status: "ok",
              ref: await client.writeArtifactChunk(conversationId, instanceId, request.artifactId, {
                offset: request.offset,
                contentBase64: request.chunkBase64,
              }),
            };
          case "finalize":
            return { status: "ok", ref: await client.finalizeArtifact(conversationId, instanceId, request.artifactId) };
          case "export": {
            // Through the instance's grant first: a widget may offer to save only a file it was given or made.
            const ref = await client.describeWidgetArtifact(conversationId, instanceId, request.artifactId);
            return await ask({ kind: "export", ref, suggestedName: request.suggestedName });
          }
          case "attach": {
            const attached = await client.attachArtifact(conversationId, instanceId, request.artifactId, { name: request.name });
            latest.current.onAttach?.(attached.attachmentRef);
            setNotice({ tone: "info", text: t("widgets.artifacts.attached").replace("{name}", attached.attachmentRef.filename) });
            return { status: "ok", ref: attached.artifactRef };
          }
          case "discard":
            await client.discardArtifact(conversationId, instanceId, request.artifactId);
            return { status: "ok" };
          default: {
            request satisfies never;
            return { status: "refused", code: "ARTIFACT_UNSUPPORTED", message: "this host does not know that request" };
          }
        }
      } catch (cause) {
        // Out of room is the widget's problem to solve, but the person should know why its files stopped saving.
        if (cause instanceof GatewayError && OUT_OF_ROOM.has(cause.code)) {
          setNotice({ tone: "error", text: t("widgets.artifacts.quotaNotice").replace("{reason}", artifactReason(cause, t)) });
        }
        return artifactRefusal(cause);
      }
    },
    [ask, t],
  );

  /* ---------------- the person's answers ---------------- */

  const storePicked = useCallback(
    async (file: { name: string; mimeType: string; contentBase64: string }): Promise<ArtifactRef | undefined> => {
      const current = pending.current;
      if (current?.kind !== "pick") return undefined;
      const { client, conversationId, instanceId } = latest.current;
      setBusy(true);
      try {
        const ref = await client.pickArtifact({ conversationId, instanceId, accept: current.accept, ...file });
        settle({ status: "ok", ref });
        return ref;
      } catch (cause) {
        setNotice({ tone: "error", text: t("widgets.artifacts.pickFailed").replace("{reason}", artifactReason(cause, t)) });
        settle(artifactRefusal(cause, "pick"));
        return undefined;
      }
    },
    [settle, t],
  );

  const pickInBrowser = useCallback(
    async (file: File) => {
      let contentBase64: string;
      try {
        contentBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
      } catch {
        setNotice({ tone: "error", text: t("widgets.artifacts.pickFailed").replace("{reason}", t("widgets.artifacts.reason.readFailed")) });
        settle(artifactRefusal(undefined, "pick"));
        return;
      }
      // The browser's type as it gave it: an empty one is read from the bytes by the node, never forced to a binary type.
      await storePicked({ name: file.name, mimeType: pickedFileType(file), contentBase64 });
    },
    [settle, storePicked, t],
  );

  const pickOnDesktop = useCallback(async () => {
    const current = pending.current;
    const bridge = desktopFileBridge();
    if (current?.kind !== "pick" || bridge === undefined) return;
    setBusy(true);
    const answer: Awaited<ReturnType<typeof bridge.pickFile>> = await bridge
      .pickFile({ title: pickTitle(t, latest.current.widgetTitle), accept: current.accept, filterName: t("widgets.artifacts.dialog.filterName") })
      // A bridge that threw says nothing this page may repeat: only that the desktop did not finish.
      .catch(() => ({ ok: false, refused: "DESKTOP_FAILED" }));
    if (!answer.ok || answer.file === undefined) {
      if (answer.ok && answer.canceled === true) {
        settle({ status: "cancelled" });
        return;
      }
      const cause = new DesktopFileError(answer.refused ?? "DESKTOP_FAILED", answer.errorCode);
      setNotice({ tone: "error", text: t("widgets.artifacts.pickFailed").replace("{reason}", artifactReason(cause, t)) });
      settle(artifactRefusal(cause, "pick"));
      return;
    }
    const stored = await storePicked({ name: answer.file.name, mimeType: answer.file.mimeType, contentBase64: answer.file.contentBase64 });
    // Remembered as the node typed it, which is what decides whether a later file can be written over it.
    if (stored !== undefined) original.current = { name: answer.file.name, handle: answer.file.handle, mimeType: stored.mimeType };
  }, [settle, storePicked, t]);

  const save = useCallback(
    async (replace: boolean) => {
      const current = pending.current;
      if (current?.kind !== "export") return;
      setBusy(true);
      try {
        const exported = await latest.current.client.exportArtifact(current.ref.artifactId, current.suggestedName);
        const saved = await saveForPerson(exported.blob, exported.filename, {
          // The type the node sent the bytes as, which is what the desktop names and checks the file by.
          mimeType: exported.mimeType === "" ? current.ref.mimeType : exported.mimeType,
          replaceHandle: replace ? original.current?.handle : undefined,
          labels: desktopDialogLabels(t),
        });
        if (saved.outcome === "cancelled") {
          settle({ status: "cancelled" });
          return;
        }
        // A browser download has only started; saying it was saved would claim something this page cannot know.
        const said = saved.outcome === "downloaded" ? "widgets.artifacts.downloaded" : "widgets.artifacts.saved";
        setNotice({ tone: "info", text: t(said).replace("{name}", saved.name) });
        settle({ status: "ok", ref: current.ref });
      } catch (cause) {
        setNotice({ tone: "error", text: t("widgets.artifacts.saveFailed").replace("{reason}", artifactReason(cause, t)) });
        settle(artifactRefusal(cause, "save"));
      }
    },
    [settle, t],
  );

  /*
   * The live region is always there, so a question asked while the person is typing elsewhere is read out rather than
   * taking their keyboard: a region that appears together with its words is not reliably announced.
   */
  const chrome = (
    <>
      <p className="cc-sr-only" role="status" data-artifact-announce="true">
        {announcement}
      </p>
      {prompt === undefined && notice === undefined ? null : (
        <ArtifactChrome
          prompt={prompt}
          busy={busy}
          notice={notice}
          desktop={desktopFileBridge() !== undefined}
          widgetTitle={input.widgetTitle}
          replaceLabel={prompt?.kind === "export" ? replaceOriginalLabel(t, original.current, prompt.ref, prompt.suggestedName) : undefined}
          onPickFile={(file) => void pickInBrowser(file)}
          onPickDesktop={() => void pickOnDesktop()}
          onSave={(replace) => void save(replace)}
          onCancel={() => settle({ status: "cancelled" })}
          onDismiss={() => setNotice(undefined)}
          onAnnounce={setAnnouncement}
        />
      )}
    </>
  );
  return { broker, chrome };
}

type Translate = (key: MessageKey) => string;

/** The file a person picked on the desktop: its name, its type as the node stored it, and the handle the shell keeps its path under. */
export interface PickedOriginal {
  name: string;
  handle: string;
  mimeType: string;
}

/**
 * A name as the person should read it: without the characters that reverse how the text around them reads, so
 * `hoa-don‮txt.exe` cannot pass for `hoa-donexe.txt` in the question the host asks.
 */
function shown(text: string | undefined): string {
  return stripBidiControls(text ?? "").trim();
}

/** Who is asking, in the prompt's first line: the widget by its title when it has one. */
export function pickTitle(t: Translate, widget: string | undefined): string {
  const named = shown(widget);
  return named === "" ? t("widgets.artifacts.pickTitle") : fillMessage(t("widgets.artifacts.pickTitleNamed"), { widget: named });
}

/** The save question's first line: who asks, and the name the file is offered under. */
export function exportTitle(t: Translate, widget: string | undefined, suggestedName: string): string {
  const named = shown(widget);
  const name = shown(suggestedName);
  return named === ""
    ? fillMessage(t("widgets.artifacts.saveTitle"), { name })
    : fillMessage(t("widgets.artifacts.saveTitleNamed"), { widget: named, name });
}

/**
 * The words of "Replace original", or nothing when it is not offered.
 *
 * Nothing proves the widget's file was made from the one the person picked, so the button names both files, and it
 * appears only for a file of the picked one's type: the desktop would refuse to write another type over it anyway.
 */
export function replaceOriginalLabel(
  t: Translate,
  original: PickedOriginal | undefined,
  exported: ArtifactRef,
  suggestedName: string,
): string | undefined {
  if (original === undefined || original.mimeType !== exported.mimeType) return undefined;
  return fillMessage(t("widgets.artifacts.replaceOriginal"), { original: shown(original.name), name: shown(suggestedName) });
}

/**
 * Whether a question may take the keyboard: only when it was already beside the frame — in the frame, in the host's
 * chrome around it — or nowhere at all. A widget that asks again the moment it is answered must not pull the person
 * out of the composer on every ask; the question is announced instead, and waits beside the frame.
 */
function keyboardIsBesideFrame(chrome: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return chrome?.parentElement?.contains(active) ?? false;
}

interface ArtifactChromeProps {
  prompt: Prompt | undefined;
  busy: boolean;
  notice: Notice | undefined;
  desktop: boolean;
  widgetTitle: string | undefined;
  /** "Replace original" on the desktop, when it is offered for this file. */
  replaceLabel: string | undefined;
  onPickFile: (file: File) => void;
  onPickDesktop: () => void;
  onSave: (replace: boolean) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onAnnounce: (text: string) => void;
}

/**
 * The panel a widget's file request opens, drawn by the host beside the frame.
 *
 * The widget cannot draw into it, cannot press its buttons and does not learn what the person chose until the node
 * holds it. Escape cancels, and is kept from also closing the expanded surface around it.
 */
function ArtifactChrome({
  prompt,
  busy,
  notice,
  desktop,
  widgetTitle,
  replaceLabel,
  onPickFile,
  onPickDesktop,
  onSave,
  onCancel,
  onDismiss,
  onAnnounce,
}: ArtifactChromeProps): ReactElement {
  const t = useT();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLParagraphElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);
  const section = useRef<HTMLElement>(null);

  /*
   * A new question takes the keyboard, so a person who did not click in the frame can still answer it — at its title,
   * never its button: the widget chose when to ask, and a key pressed for the widget a moment earlier must not land on
   * Save or Choose. Once answered, the keyboard goes to the line saying what happened, rather than to the page's start.
   * A notice that follows no question (an attach) is announced and leaves the keyboard where it was. Either move is made
   * only while the keyboard is beside the frame (`keyboardIsBesideFrame`); otherwise the question is read out.
   */
  const promptKind = prompt?.kind;
  const askedBefore = useRef(false);
  useEffect(() => {
    if (promptKind !== undefined) {
      askedBefore.current = true;
      if (keyboardIsBesideFrame(section.current)) title.current?.focus();
      else onAnnounce(title.current?.textContent ?? "");
      return;
    }
    if (askedBefore.current && notice !== undefined && keyboardIsBesideFrame(section.current)) noticeLine.current?.focus();
    askedBefore.current = false;
  }, [promptKind, notice, onAnnounce]);

  const types = artifactTypesLabel(prompt?.kind === "pick" ? prompt.accept : [], t);

  return (
    <section
      ref={section}
      className="cc-artifact-prompt"
      data-artifact-prompt={prompt?.kind ?? "notice"}
      aria-labelledby={prompt === undefined ? undefined : titleId}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || prompt === undefined || busy) return;
        event.stopPropagation();
        onCancel();
      }}
    >
      {prompt?.kind === "pick" && (
        <>
          <p ref={title} tabIndex={-1} className="cc-artifact-prompt-title" id={titleId} data-artifact-title="true">
            {pickTitle(t, widgetTitle)}
          </p>
          <p>{t("widgets.artifacts.pickBody")}</p>
          <p className="cc-artifact-prompt-detail" data-artifact-accept="true">
            {t("widgets.artifacts.accepts").replace("{types}", types)}
          </p>
          {!desktop && (
            <input
              ref={input}
              className="cc-artifact-file-input"
              type="file"
              tabIndex={-1}
              aria-hidden="true"
              data-artifact-file-input="true"
              accept={prompt.accept.join(",")}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file !== undefined) onPickFile(file);
              }}
            />
          )}
          <div className="cc-artifact-prompt-actions">
            <button
              type="button"
              className="cc-artifact-button"
              data-primary="true"
              data-artifact-choose="true"
              disabled={busy}
              onClick={() => (desktop ? onPickDesktop() : input.current?.click())}
            >
              {t("widgets.artifacts.choose")}
            </button>
            <button type="button" className="cc-artifact-button" data-artifact-cancel="true" disabled={busy} onClick={onCancel}>
              {t("widgets.artifacts.cancel")}
            </button>
          </div>
        </>
      )}
      {prompt?.kind === "export" && (
        <>
          <p ref={title} tabIndex={-1} className="cc-artifact-prompt-title" id={titleId} data-artifact-title="true">
            {exportTitle(t, widgetTitle, prompt.suggestedName)}
          </p>
          <p className="cc-artifact-prompt-detail">
            {t("widgets.artifacts.saveBody").replace("{size}", formatFileSize(prompt.ref.sizeBytes))}
          </p>
          {!desktop && (
            <p className="cc-artifact-prompt-detail" data-artifact-web-original="true">
              {t("widgets.artifacts.webOriginalNote")}
            </p>
          )}
          <div className="cc-artifact-prompt-actions">
            <button
              type="button"
              className="cc-artifact-button"
              data-primary="true"
              data-artifact-save="true"
              disabled={busy}
              onClick={() => onSave(false)}
            >
              {t("widgets.artifacts.saveAs")}
            </button>
            {desktop && replaceLabel !== undefined && (
              <button type="button" className="cc-artifact-button" data-artifact-replace="true" disabled={busy} onClick={() => onSave(true)}>
                {replaceLabel}
              </button>
            )}
            <button type="button" className="cc-artifact-button" data-artifact-cancel="true" disabled={busy} onClick={onCancel}>
              {t("widgets.artifacts.cancel")}
            </button>
          </div>
        </>
      )}
      {busy && (
        <p className="cc-artifact-prompt-detail" role="status">
          {prompt?.kind === "export" ? t("widgets.artifacts.saving") : t("widgets.artifacts.handing")}
        </p>
      )}
      {prompt === undefined && notice !== undefined && (
        <div className="cc-artifact-notice" data-tone={notice.tone} data-artifact-notice={notice.tone}>
          <p ref={noticeLine} tabIndex={-1} role={notice.tone === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
          <button type="button" className="cc-artifact-button" data-artifact-dismiss="true" onClick={onDismiss}>
            {t("widgets.artifacts.dismiss")}
          </button>
        </div>
      )}
    </section>
  );
}

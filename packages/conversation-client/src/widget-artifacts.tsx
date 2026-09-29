import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from "react";

import type { ArtifactRef, AttachmentRef } from "@clarkcant/contracts";
import type { FrameArtifactBroker, FrameArtifactOutcome } from "@clarkcant/widget-host/session";

import { type GatewayClient, GatewayError } from "./api.ts";
import { formatFileSize, toBase64 } from "./attachments.ts";
import { desktopFileBridge, saveForPerson } from "./download.ts";
import { useT } from "./i18n/locale-context.tsx";

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
 * written back on the desktop is named by an opaque handle the shell's main process keeps.
 */

export interface WidgetArtifactHostInput {
  client: GatewayClient;
  conversationId: string;
  instanceId: string;
  /** A finalized artifact the widget attached: it goes into the composer, where the person decides whether to send it. */
  onAttach?: ((attachment: AttachmentRef) => void) | undefined;
}

type PromptRequest = { kind: "pick"; accept: readonly string[] } | { kind: "export"; ref: ArtifactRef; suggestedName: string };
type Prompt = PromptRequest & { settle: (outcome: FrameArtifactOutcome) => void };

interface Notice {
  tone: "info" | "error";
  text: string;
}

/** A refusal the widget can read: the node's own code and sentence when it gave one. */
export function artifactRefusal(cause: unknown): FrameArtifactOutcome {
  if (cause instanceof GatewayError) return { status: "refused", code: cause.code, message: cause.reason };
  return {
    status: "refused",
    code: "ARTIFACT_UNAVAILABLE",
    message: cause instanceof Error && cause.message !== "" ? cause.message : "the node could not be reached",
  };
}

export function useWidgetArtifactHost(input: WidgetArtifactHostInput): { broker: FrameArtifactBroker; chrome: ReactElement | null } {
  const t = useT();
  const latest = useRef(input);
  latest.current = input;
  const [prompt, setPrompt] = useState<Prompt | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const pending = useRef<Prompt | undefined>(undefined);
  /** The last file this frame's person picked on the desktop: its name, and the handle the shell keeps its path under. */
  const original = useRef<{ name: string; handle: string } | undefined>(undefined);

  const settle = useCallback((outcome: FrameArtifactOutcome) => {
    const current = pending.current;
    pending.current = undefined;
    setPrompt(undefined);
    setBusy(false);
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
            const attached = await client.attachArtifact(conversationId, instanceId, request.artifactId);
            latest.current.onAttach?.(attached.attachmentRef);
            setNotice({ tone: "info", text: t("widgets.artifacts.attached").replace("{name}", attached.attachmentRef.filename) });
            return { status: "ok", ref: attached.artifactRef };
          }
          default: {
            request satisfies never;
            return { status: "refused", code: "ARTIFACT_UNSUPPORTED", message: "this host does not know that request" };
          }
        }
      } catch (cause) {
        return artifactRefusal(cause);
      }
    },
    [ask, t],
  );

  /* ---------------- the person's answers ---------------- */

  const storePicked = useCallback(
    async (file: { name: string; mimeType: string; contentBase64: string }) => {
      const current = pending.current;
      if (current?.kind !== "pick") return;
      const { client, conversationId, instanceId } = latest.current;
      setBusy(true);
      try {
        const ref = await client.pickArtifact({ conversationId, instanceId, accept: current.accept, ...file });
        settle({ status: "ok", ref });
      } catch (cause) {
        const refusal = artifactRefusal(cause);
        setNotice({
          tone: "error",
          text: t("widgets.artifacts.pickFailed").replace("{reason}", refusal.status === "refused" ? refusal.message : ""),
        });
        settle(refusal);
      }
    },
    [settle, t],
  );

  const pickInBrowser = useCallback(
    async (file: File) => {
      await storePicked({
        name: file.name,
        mimeType: file.type === "" ? "application/octet-stream" : file.type,
        contentBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
      });
    },
    [storePicked],
  );

  const pickOnDesktop = useCallback(async () => {
    const current = pending.current;
    const bridge = desktopFileBridge();
    if (current?.kind !== "pick" || bridge === undefined) return;
    setBusy(true);
    const answer: Awaited<ReturnType<typeof bridge.pickFile>> = await bridge
      .pickFile({ title: t("widgets.artifacts.pickTitle"), accept: current.accept })
      .catch((cause: unknown) => ({ ok: false, refused: cause instanceof Error ? cause.message : String(cause) }));
    if (!answer.ok || answer.file === undefined) {
      if (answer.ok && answer.canceled === true) {
        settle({ status: "cancelled" });
        return;
      }
      const reason = answer.refused ?? "";
      setNotice({ tone: "error", text: t("widgets.artifacts.pickFailed").replace("{reason}", reason) });
      settle({ status: "refused", code: "ARTIFACT_PICK_FAILED", message: reason === "" ? "the file could not be read" : reason });
      return;
    }
    original.current = { name: answer.file.name, handle: answer.file.handle };
    await storePicked({ name: answer.file.name, mimeType: answer.file.mimeType, contentBase64: answer.file.contentBase64 });
  }, [settle, storePicked, t]);

  const save = useCallback(
    async (replace: boolean) => {
      const current = pending.current;
      if (current?.kind !== "export") return;
      setBusy(true);
      try {
        const exported = await latest.current.client.exportArtifact(current.ref.artifactId, current.suggestedName);
        const outcome = await saveForPerson(exported.blob, exported.filename, {
          replaceHandle: replace ? original.current?.handle : undefined,
        });
        if (!outcome.saved) {
          settle({ status: "cancelled" });
          return;
        }
        setNotice({ tone: "info", text: t("widgets.artifacts.saved").replace("{name}", outcome.name) });
        settle({ status: "ok", ref: current.ref });
      } catch (cause) {
        const refusal = artifactRefusal(cause);
        setNotice({
          tone: "error",
          text: t("widgets.artifacts.saveFailed").replace("{reason}", refusal.status === "refused" ? refusal.message : ""),
        });
        settle(refusal);
      }
    },
    [settle, t],
  );

  const chrome =
    prompt === undefined && notice === undefined ? null : (
      <ArtifactChrome
        prompt={prompt}
        busy={busy}
        notice={notice}
        desktop={desktopFileBridge() !== undefined}
        originalName={original.current?.name}
        onPickFile={(file) => void pickInBrowser(file)}
        onPickDesktop={() => void pickOnDesktop()}
        onSave={(replace) => void save(replace)}
        onCancel={() => settle({ status: "cancelled" })}
        onDismiss={() => setNotice(undefined)}
      />
    );
  return { broker, chrome };
}

interface ArtifactChromeProps {
  prompt: Prompt | undefined;
  busy: boolean;
  notice: Notice | undefined;
  desktop: boolean;
  originalName: string | undefined;
  onPickFile: (file: File) => void;
  onPickDesktop: () => void;
  onSave: (replace: boolean) => void;
  onCancel: () => void;
  onDismiss: () => void;
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
  originalName,
  onPickFile,
  onPickDesktop,
  onSave,
  onCancel,
  onDismiss,
}: ArtifactChromeProps): ReactElement {
  const t = useT();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const noticeLine = useRef<HTMLParagraphElement>(null);

  /*
   * A new question takes the keyboard, so a person who did not click in the frame can still answer it; once answered,
   * the keyboard goes to the line saying what happened, rather than to the page's start. A notice that follows no
   * question (an attach) is announced and leaves the keyboard where it was.
   */
  const promptKind = prompt?.kind;
  const askedBefore = useRef(false);
  useEffect(() => {
    if (promptKind !== undefined) {
      askedBefore.current = true;
      primary.current?.focus();
      return;
    }
    if (askedBefore.current && notice !== undefined) noticeLine.current?.focus();
    askedBefore.current = false;
  }, [promptKind, notice]);

  const types = prompt?.kind === "pick" && prompt.accept.length > 0 ? prompt.accept.join(", ") : t("widgets.artifacts.anyType");

  return (
    <section
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
          <p className="cc-artifact-prompt-title" id={titleId}>
            {t("widgets.artifacts.pickTitle")}
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
              ref={primary}
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
          <p className="cc-artifact-prompt-title" id={titleId}>
            {t("widgets.artifacts.saveTitle").replace("{name}", prompt.suggestedName)}
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
              ref={primary}
              type="button"
              className="cc-artifact-button"
              data-primary="true"
              data-artifact-save="true"
              disabled={busy}
              onClick={() => onSave(false)}
            >
              {t("widgets.artifacts.saveAs")}
            </button>
            {desktop && originalName !== undefined && (
              <button type="button" className="cc-artifact-button" data-artifact-replace="true" disabled={busy} onClick={() => onSave(true)}>
                {t("widgets.artifacts.replaceOriginal").replace("{name}", originalName)}
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

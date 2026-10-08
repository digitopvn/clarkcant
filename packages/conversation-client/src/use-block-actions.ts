import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CommandCardAction, FeedbackPublishIntent, FeedbackRequestInput, WidgetDevFolderForgetResult, WidgetDevSessionView } from "@clarkcant/contracts";

import { type GatewayClient, GatewayError, type Timeline, type WidgetDevSessionRead } from "./api.ts";
import { canPickFolder, pickFolderOnDesktop } from "./desktop-compact.ts";
import { fillMessage } from "./i18n/fill-message.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { nodeViewRefusalText } from "./node-view-refusal.ts";
import { useProviderSignIns } from "./use-provider-sign-ins.ts";
import { useModelPickerPort } from "./use-model-picker-port.ts";
import type {
  ArtifactOpenState,
  BlockActions,
  CommandActionState,
  ControlSessionActionState,
  FeedbackCardState,
  FolderEntryReason,
  PackageInstallState,
  QuestionOutcome,
  TaskStopState,
} from "./blocks.tsx";

export interface BlockActionsDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  timeline: Timeline | undefined;
  applyTimeline: (next: Timeline) => void;
  setError: (message: string | undefined) => void;
  /** The same path as a question: an answer becomes the user's own next message. */
  send: (text: string) => void;
  /**
   * The translator for the current UI language, passed rather than read via `useT()`: this hook is
   * called directly from `Conversation`'s own body, before `Conversation`'s `<LocaleProvider>` — a
   * child of its return, not an ancestor of it — is mounted.
   */
  t: (key: MessageKey) => string;
  /** Opens the inbox on one waiting item: where an install the execution policy asked about is decided. */
  openInbox?: (target: string) => void;
  /** Opens another conversation, as the inbox does: a command card's `Open`. */
  openConversation?: (conversationId: string) => void;
  /** Starts a new conversation and keeps this one, as `/new` does. */
  newConversation?: () => void;
}

/**
 * What a refused install press leaves on its row.
 *
 * A press that sent the listing's `contentDigest` and was answered `DIGEST_MISMATCH` came from a list made before the
 * files changed: pressing the same row again would send the same digest and be refused the same way, and sending none
 * would install files nobody was shown, so the row goes out of date (`stale`) and offers a new search instead. Any
 * other refusal shows the node's own reason, where it gave one: it is the only thing that can say *why* the install
 * stopped.
 */
export function installRefusalState(
  error: unknown,
  contentDigest: string | undefined,
  t: (key: MessageKey) => string,
): PackageInstallState {
  if (contentDigest !== undefined && error instanceof GatewayError && error.code === "DIGEST_MISMATCH") {
    return { status: "stale", message: t("shell.package.filesChangedSinceListing"), staleContentDigest: contentDigest };
  }
  return { status: "refused", message: error instanceof Error ? error.message : t("shell.package.installFailed") };
}

/**
 * The report a feedback press for these words should act on, when an earlier press already has one: the preview's, or
 * that of a press that did not get through — which the node may already have sent, so preparing a second report for
 * the same words could file it twice. Different words are a different report.
 */
export function feedbackReportToReuse(previous: FeedbackCardState | undefined, requestKey: string): string | undefined {
  if (previous?.status === "prepared" && previous.requestKey === requestKey) return previous.draft.reportId;
  if (previous?.status === "failed" && previous.reportId !== undefined && previous.requestKey === requestKey) return previous.reportId;
  return undefined;
}

/**
 * What a started widget dev session is doing, said beside the `/develop` card's button: running and placed here,
 * waiting for the person's answer in the inbox, built but not run (with the node's reason), or a first build that
 * failed. Read from the session the node answered with, never assumed from the press.
 */
/**
 * What a press on a `/develop` card came to, and, when the person pressed it, whether the folder was kept as one Clark may
 * use: the node keeps a choice only for the folder itself (`pressed` was its own path, not a link to it) and never for a
 * whole drive or the home folder (`chosenByPerson`).
 */
export function developOutcomeMessage(view: WidgetDevSessionRead, t: (key: MessageKey) => string, pressed?: string): string {
  // A newer node sent more than this app reads: said, so the outcome is never taken for all the node answered.
  const outcome = view.unreadFields === undefined ? sessionOutcome(view, t) : `${sessionOutcome(view, t)} ${t("shell.dev.nodeNewer")}`;
  if (pressed === undefined || view.chosenByPerson === true) return outcome;
  const leadsElsewhere = pressed.trim().replace(/[\\/]+$/u, "").toLowerCase() !== view.root.replace(/[\\/]+$/u, "").toLowerCase();
  const kept = fillMessage(t(leadsElsewhere ? "commandCard.develop.notKeptLink" : "commandCard.develop.notKeptBroad"), { folder: view.root });
  return `${outcome} ${kept}`;
}

/**
 * What a `/develop` start that did not come back as a session the app could read settles on.
 *
 * An answer the app cannot read (`NodeViewUnreadable`) only arrives once the node said yes, so the session started and
 * runs on the node: the card says so, and that this app cannot read its state, with the version advice, rather than
 * "failed" with the schema's text. Any other error is a start that did not happen, said as the node's reason.
 */
export function developStartRefused(error: unknown, t: (key: MessageKey) => string): CommandActionState {
  const unread = nodeViewRefusalText(error, t, "commandCard.develop.startedUnread");
  if (unread !== undefined) return { status: "done", message: unread };
  return { status: "failed", message: error instanceof Error ? error.message : t("commandCard.failed") };
}

/**
 * What a Forget press that did not come back as an answer the app could read settles on.
 *
 * An answer the app cannot read (`NodeViewUnreadable`) means the node answered, but what it said cannot be read: it may
 * not have forgotten the folder, or Clark may still reach it through another. Neither is claimed, so the state is
 * `unknown` rather than done, and the row keeps the badge it was drawn with. Any other error is said as the node's reason.
 */
export function forgetRefused(error: unknown, t: (key: MessageKey) => string): CommandActionState {
  const unread = nodeViewRefusalText(error, t, "shell.nodeView.answered");
  if (unread !== undefined) return { status: "unknown", message: unread };
  return { status: "failed", message: error instanceof Error ? error.message : t("commandCard.failed") };
}

/** What a Forget press did, saying so when the folder stays reachable through a folder that holds it. */
export function forgetOutcomeMessage(result: WidgetDevFolderForgetResult, t: (key: MessageKey) => string): string {
  const folder = result.root;
  if (result.stillCoveredBy !== undefined) {
    return fillMessage(t(result.forgotten ? "commandCard.develop.forgottenCovered" : "commandCard.develop.notChosenCovered"), { folder, cover: result.stillCoveredBy });
  }
  return fillMessage(t(result.forgotten ? "commandCard.develop.forgotten" : "commandCard.develop.notChosen"), { folder });
}

function sessionOutcome(view: WidgetDevSessionView, t: (key: MessageKey) => string): string {
  const folder = view.root;
  const { activation } = view;
  if (activation.state === "active") return fillMessage(t("commandCard.develop.running"), { folder });
  if (activation.state === "awaiting-approval") return fillMessage(t("commandCard.develop.awaitingApproval"), { folder });
  if (activation.state === "refused") return fillMessage(t("commandCard.develop.refused"), { folder, reason: activation.message });
  if (view.lastBuild?.ok === false) {
    const reason = view.lastBuild.diagnostics.map((entry) => entry.message).join("; ");
    return fillMessage(t("commandCard.develop.buildFailed"), { folder, reason });
  }
  return fillMessage(t("commandCard.develop.watching"), { folder });
}

/**
 * Every action a card in the transcript can take, as one object.
 *
 * A card is a pure function of the props it is given — asserted directly by its own test file —
 * so every stateful thing a card needs (which approval is deciding, what an install attempt came
 * to, what the node said about a stop request) lives here instead, one state per kind of card,
 * with one handler each. `blocks.tsx` renders the transcript; this hook is what the buttons in it
 * actually do.
 */
export function useBlockActions({
  client,
  conversationId,
  timeline,
  applyTimeline,
  setError,
  send,
  t,
  openInbox,
  openConversation,
  newConversation,
}: BlockActionsDeps): BlockActions {
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | undefined>(undefined);

  const decideApproval = useCallback(
    (input: { approvalId: string; digest: string; decision: "granted" | "denied" }) => {
      if (conversationId === undefined) return;
      setDecidingApprovalId(input.approvalId);
      setError(undefined);
      void client
        .decideApproval(conversationId, input.approvalId, { decision: input.decision, digest: input.digest })
        .then((result) => applyTimeline(result.timeline))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setDecidingApprovalId(undefined));
    },
    [applyTimeline, client, conversationId, setError],
  );

  /**
   * The answer being composed, and the question whose answer is on its way.
   *
   * Both live here rather than in the card because the card is a pure function of what it is
   * given: state inside it would be a second copy of a fact this conversation already tracks, and
   * the two would disagree after a reload. The draft is cleared the moment an answer leaves, so a
   * card never re-offers what was just sent.
   */
  const [questionDraft, setQuestionDraft] = useState<
    { questionId: string; chosen: string[]; text: string } | undefined
  >(undefined);
  const [questionPendingId, setQuestionPendingId] = useState<string | undefined>(undefined);

  const answerQuestion = useCallback(
    (input: { questionId: string; text?: string; optionIds?: string[]; confirmed?: boolean }) => {
      if (conversationId === undefined) return;
      setError(undefined);
      setQuestionPendingId(input.questionId);
      setQuestionDraft(undefined);
      void client
        .answerQuestion(conversationId, input.questionId, input)
        .then((result) => applyTimeline(result.timeline))
        .catch((cause: unknown) => {
          // The answer never reached the node, so the card may be tried again rather than staying disabled.
          setQuestionPendingId(undefined);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [applyTimeline, client, conversationId, setError],
  );

  /**
   * Approvals that already have a receipt in this transcript, and which of them were refused.
   *
   * The card in storage stays `pending` because messages are never rewritten, so the decision is
   * read from the receipt instead: the operation the user approved carries its approval id, and so
   * does the record a refusal leaves.
   */
  const { decidedApprovals, deniedApprovals } = useMemo(() => {
    const decided = new Set<string>();
    const denied = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.approvalId !== "string") continue;
        decided.add(args.approvalId);
        if (args.decision === "denied") denied.add(args.approvalId);
      }
    }
    return { decidedApprovals: [...decided], deniedApprovals: [...denied] };
  }, [timeline]);

  /**
   * Questions this transcript already has an answer for.
   *
   * The same derivation as `decidedApprovals`, for the same reason: a card in storage keeps saying
   * `waiting` because messages are never rewritten, and the record the node wrote when the answer
   * arrived is what says otherwise. Without it a reload would offer the question again.
   */
  const { answeredQuestions, questionOutcomes } = useMemo(() => {
    // The latest record wins: a question that expired and was then asked again reads as asked again.
    const outcomes: Record<string, QuestionOutcome> = {};
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity" || block.name !== "ask_user_question") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.questionId !== "string") continue;
        const decision = args.decision;
        outcomes[args.questionId] =
          decision === "cancelled" || decision === "expired" || decision === "asked-again" ? decision : "answered";
      }
    }
    return { answeredQuestions: Object.keys(outcomes), questionOutcomes: outcomes };
  }, [timeline]);

  /*
   * Once the transcript carries the record of the answer, nothing is in flight any more. The card
   * reads that record rather than a flag of its own, which is what keeps a reload from leaving a
   * card disabled forever.
   */
  useEffect(() => {
    if (questionPendingId === undefined) return;
    if (answeredQuestions.includes(questionPendingId)) setQuestionPendingId(undefined);
  }, [answeredQuestions, questionPendingId]);

  /**
   * What the node said about the last secret submitted through a card.
   *
   * Held here rather than in the card because the card is a message in a transcript: it is
   * re-rendered from stored blocks on every load, and a status that lived inside it would change
   * what history says. This is a fact about now, so it lives with the other facts about now.
   */
  const [credentialStatus, setCredentialStatus] = useState<{ requestId: string; message: string } | undefined>(undefined);

  const submitCredential = useCallback(
    (input: {
      requestId: string;
      fields: { name: string; value: string; description?: string; consumer?: string }[];
    }): void => {
      client
        .putCredential({ fields: input.fields })
        .then((result) =>
          setCredentialStatus({
            requestId: input.requestId,
            message:
              result.names.length === 0
                ? t("shell.credential.sentNoName")
                : t("shell.credential.saved").replace("{names}", result.names.join(", ")),
          }),
        )
        .catch(() =>
          // The failure message says nothing about what was typed. An error that repeated the
          // value would be the leak this card exists to prevent.
          setCredentialStatus({ requestId: input.requestId, message: t("shell.credential.saveFailed") }),
        );
    },
    [client, t],
  );

  /**
   * Cards that may still be answered: a question's or a form's id, while nothing has come after
   * the message that asked. Derived from the transcript rather than tracked as state, because the
   * messages are history and are never rewritten: a card that stayed live would invite a second
   * answer the node would take as a second message.
   */
  const openCardIds = useMemo(() => {
    const messages = timeline?.messages ?? [];
    let lastUserIndex = -1;
    messages.forEach((message, index) => {
      if (message.role === "user") lastUserIndex = index;
    });
    const questions: string[] = [];
    const forms: string[] = [];
    messages.forEach((message, index) => {
      if (index <= lastUserIndex) return;
      for (const block of message.blocks) {
        const record = block as Record<string, unknown>;
        if (record.type === "question-card" && typeof record.questionId === "string") questions.push(record.questionId);
        if (record.type === "form-card" && typeof record.formId === "string") forms.push(record.formId);
      }
    });
    return { questions, forms };
  }, [timeline]);

  /**
   * What the node said about each stop request.
   *
   * Held here rather than in the card because the card is asserted directly by its own test file
   * and has to stay a pure function of its props, and because one place should own the call.
   */
  const [taskStop, setTaskStop] = useState<Record<string, TaskStopState>>({});

  const stopTask = useCallback(
    (taskId: string) => {
      setTaskStop((current) => ({ ...current, [taskId]: { status: "pending" } }));
      void client.cancelTask(taskId).then(
        (result) =>
          setTaskStop((current) => ({
            ...current,
            [taskId]: { status: "requested", state: result.state, confirmed: result.confirmed },
          })),
        (error: unknown) =>
          // Reported beside the control that caused it, and the task is left alone: nothing here
          // pretends the request landed, because a stop that did not reach the node has not stopped
          // anything.
          setTaskStop((current) => ({
            ...current,
            [taskId]: {
              status: "failed",
              message: error instanceof Error ? error.message : t("shell.task.stopFailed"),
            },
          })),
      );
    },
    [client, t],
  );

  /**
   * What the node still holds for each artifact somebody reopened.
   *
   * `opened` carries facts rather than a status, because the interesting answer is not "it worked"
   * but what the node has: an artifact can expire between the message that mentioned it and
   * somebody reading it, and the snapshot in the transcript cannot know that.
   */
  const [artifactOpen, setArtifactOpen] = useState<Record<string, ArtifactOpenState>>({});

  const openArtifact = useCallback(
    (artifactId: string) => {
      setArtifactOpen((current) => ({ ...current, [artifactId]: { status: "pending" } }));
      void client.artifact(artifactId).then(
        (result) => {
          const { artifact } = result;
          setArtifactOpen((current) => ({
            ...current,
            [artifactId]: {
              status: "opened",
              digest: artifact.digest,
              sizeBytes: artifact.sizeBytes,
              mimeType: artifact.mimeType,
              originNodeId: artifact.originNodeId,
              createdAt: artifact.createdAt,
              expiresAt: artifact.expiresAt,
              expired: artifact.expired,
            },
          }));
        },
        (error: unknown) =>
          setArtifactOpen((current) => ({
            ...current,
            [artifactId]: {
              status: "failed",
              message: error instanceof Error ? error.message : t("shell.artifact.openFailed"),
            },
          })),
      );
    },
    [client, t],
  );

  /**
   * What became of each install attempt, keyed by package id.
   *
   * Four outcomes rather than a boolean, because they are four different things to tell someone: it
   * is happening, it happened, a decision is needed before it can happen, or it was refused with a
   * reason. "Not installed" would collapse the middle two, and one of those is waiting on the
   * reader while the other is not.
   */
  const [packageInstall, setPackageInstall] = useState<Record<string, PackageInstallState>>({});

  const installPackage = useCallback(
    ({
      packageId,
      version,
      contentDigest,
      sourceId,
    }: {
      packageId: string;
      version: string;
      contentDigest?: string;
      sourceId?: string;
    }) => {
      setPackageInstall((current) => ({ ...current, [packageId]: { status: "installing" } }));
      void client.installPackage(packageId, version, contentDigest, sourceId).then(
        (answer) => {
          setPackageInstall((current) => ({
            ...current,
            [packageId]:
              answer.code === "APPROVAL_REQUIRED"
                ? {
                    status: "approval-required",
                    // Where to decide it, in the person's language, rather than the policy's own reason in the node's.
                    message: t("shell.package.approvalRequired"),
                    ...(answer.approvalId === undefined ? {} : { approvalId: answer.approvalId }),
                  }
                : {
                    status: "installed",
                    message: t("shell.package.installed"),
                    ...(answer.generationId === undefined ? {} : { generationId: answer.generationId }),
                    ...(answer.verified === undefined ? {} : { verified: answer.verified }),
                  },
          }));
        },
        (error: unknown) => {
          setPackageInstall((current) => ({ ...current, [packageId]: installRefusalState(error, contentDigest, t) }));
        },
      );
    },
    [client, t],
  );

  /**
   * What the node said after a verb was applied to a browser session.
   *
   * `taken-over` carries the epoch, because the epoch is the evidence that the takeover took
   * effect: the agent's already-planned action is refused for having a stale lease. A boolean here
   * would show that a button worked without showing that the browser changed hands.
   */
  const [controlSession, setControlSession] = useState<Record<string, ControlSessionActionState>>({});

  const changeBrowserSession = useCallback(
    (sessionId: string, verb: "takeover" | "stop") => {
      setControlSession((current) => ({ ...current, [sessionId]: { status: "pending" } }));
      const call = verb === "takeover" ? client.controlTakeover(sessionId) : client.controlStop(sessionId);
      void call.then(
        (result) =>
          setControlSession((current) => ({
            ...current,
            [sessionId]:
              verb === "takeover"
                ? { status: "taken-over", leaseEpoch: result.session.leaseEpoch }
                : { status: "stopped" },
          })),
        (error: unknown) =>
          // Refused rather than reported as done: a takeover that silently did nothing would leave
          // the user believing they have the wheel while the agent keeps driving.
          setControlSession((current) => ({
            ...current,
            [sessionId]: {
              status: "failed",
              message: error instanceof Error ? error.message : t("shell.control.sessionChangeFailed"),
            },
          })),
      );
    },
    [client, t],
  );

  /**
   * What a press on a command card came to, keyed `cardId/rowId/actionId`, and the sign-ins a card started, keyed
   * `cardId/rowId`. A sign-in is followed by reading it again while it runs: the provider decides when it moves on — a
   * browser page finishing, a code arriving — so the card asks rather than guesses.
   */
  const [commandAction, setCommandAction] = useState<Record<string, CommandActionState>>({});
  const { signIns, start: startSignIn, answer: answerSignIn, cancel: cancelSignIn, signOut: signOutProvider } = useProviderSignIns(client, setError);

  /** The model picker a `/model` card draws and a sign-in offers next. */
  const modelPicker = useModelPickerPort(client, t);

  /** Rows of a `/develop` card asking for a folder's path in words, and why (`FolderEntryReason`). */
  const [folderEntries, setFolderEntries] = useState<Record<string, FolderEntryReason>>({});

  /**
   * Start a widget dev session for a folder the person named on a card: on the person-only route, as them, placing the
   * widget in this conversation. What the node answered is said beside the button; the node's own reason when it refused.
   */
  const developFolder = useCallback(
    (key: string, root: string) => {
      setFolderEntries((current) => {
        const { [key]: _answered, ...rest } = current;
        return rest;
      });
      const settle = (state: CommandActionState) => setCommandAction((current) => ({ ...current, [key]: state }));
      if (conversationId === undefined) {
        settle({ status: "failed", message: t("commandCard.failed") });
        return;
      }
      settle({ status: "pending" });
      void client.startWidgetDevSession({ root, conversationId }).then(
        (view) => settle({ status: "done", message: developOutcomeMessage(view, t, root) }),
        (error: unknown) => settle(developStartRefused(error, t)),
      );
    },
    [client, conversationId, t],
  );

  const runCommandAction = useCallback(
    ({ cardId, rowId, actionId, action }: { cardId: string; rowId: string; actionId: string; action: CommandCardAction }) => {
      const key = `${cardId}/${rowId}/${actionId}`;
      const settle = (state: CommandActionState) => setCommandAction((current) => ({ ...current, [key]: state }));
      const fail = (error: unknown) =>
        settle({ status: "failed", message: error instanceof Error ? error.message : t("commandCard.failed") });
      switch (action.kind) {
        case "open-conversation":
          openConversation?.(action.conversationId);
          return;
        case "new-conversation":
          newConversation?.();
          return;
        case "set-thinking":
          settle({ status: "pending" });
          void client.writePreference("ai.thinkingLevel", action.level).then(
            () => settle({ status: "done", message: t("commandCard.thinking.set") }),
            fail,
          );
          return;
        case "provider-sign-in":
          settle({ status: "pending" });
          void startSignIn(`${cardId}/${rowId}`, action.providerId, action.method).then(() => {
            setCommandAction((current) => {
              const { [key]: _started, ...rest } = current;
              return rest;
            });
          }, fail);
          return;
        case "provider-sign-out":
          settle({ status: "pending" });
          void signOutProvider(action.providerId).then(() => {
            settle({ status: "done", message: t("commandCard.signOut.done") });
          }, fail);
          return;
        case "develop-folder": {
          if (action.root !== undefined) {
            developFolder(key, action.root);
            return;
          }
          // The OS dialog when it names a folder on the node; the path in words otherwise, and said why.
          const reason: FolderEntryReason | undefined = !canPickFolder() ? "browser" : !client.nodeOnThisMachine() ? "remote-node" : undefined;
          if (reason !== undefined) {
            setFolderEntries((current) => ({ ...current, [key]: reason }));
            return;
          }
          settle({ status: "pending" });
          void pickFolderOnDesktop(t("commandCard.develop.dialogTitle")).then((picked) => {
            if (picked.kind === "picked") {
              developFolder(key, picked.path);
              return;
            }
            setCommandAction((current) => {
              const { [key]: _asked, ...rest } = current;
              return rest;
            });
            if (picked.kind === "failed") setFolderEntries((current) => ({ ...current, [key]: "dialog-failed" }));
          });
          return;
        }
        case "develop-folder-forget":
          settle({ status: "pending" });
          void client.forgetWidgetDevFolder(action.root).then(
            (result) =>
              settle({
                status: "done",
                message: forgetOutcomeMessage(result, t),
              }),
            (error: unknown) => settle(forgetRefused(error, t)),
          );
          return;
      }
    },
    [client, developFolder, newConversation, openConversation, signOutProvider, startSignIn, t],
  );

  /**
   * The Feedback Composer and its results, keyed by card id. Preview prepares the report and keeps the draft beside the
   * words it was made from; Create issue publishes that draft when the words are unchanged, and prepares again when they
   * are not. The outcome is the node's: a result card in the timeline, never a state this hook invents.
   */
  const [feedback, setFeedback] = useState<Record<string, FeedbackCardState>>({});
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const settleFeedback = useCallback(
    (cardId: string, state: FeedbackCardState) => setFeedback((current) => ({ ...current, [cardId]: state })),
    [],
  );
  const failFeedback = useCallback(
    (cardId: string, error: unknown) =>
      settleFeedback(cardId, { status: "failed", message: error instanceof Error ? error.message : t("commandCard.failed") }),
    [settleFeedback, t],
  );

  const previewFeedback = useCallback(
    ({ cardId, request }: { cardId: string; request: FeedbackRequestInput }) => {
      settleFeedback(cardId, { status: "preparing" });
      void client.prepareFeedback(request, conversationId).then(
        (prepared) => settleFeedback(cardId, { status: "prepared", requestKey: JSON.stringify(request), ...prepared }),
        (error: unknown) => failFeedback(cardId, error),
      );
    },
    [client, conversationId, failFeedback, settleFeedback],
  );

  const createFeedback = useCallback(
    ({ cardId, request, reportId, intent = "send" }: { cardId: string; request?: FeedbackRequestInput; reportId?: string; intent?: FeedbackPublishIntent }) => {
      if (conversationId === undefined) return;
      const previous = feedbackRef.current[cardId];
      const requestKey = request === undefined ? undefined : JSON.stringify(request);
      settleFeedback(cardId, { status: "publishing", intent });
      // The report this press is about. A press that did not get through keeps its report, so pressing again for the
      // same words acts on that one — which the node may already have sent — and never prepares a second.
      let acting: string | undefined = reportId;
      const reportOf = async (): Promise<string> => {
        if (reportId !== undefined) return reportId;
        if (request === undefined || requestKey === undefined) throw new Error(t("commandCard.failed"));
        return feedbackReportToReuse(previous, requestKey) ?? (await client.prepareFeedback(request, conversationId)).draft.reportId;
      };
      void reportOf()
        .then((id) => {
          acting = id;
          return client.publishFeedback(id, conversationId, { intent, answers: cardId });
        })
        .then(
          (result) => {
            applyTimeline(result.timeline);
            settleFeedback(cardId, { status: "done", publication: result.publication });
          },
          (error: unknown) =>
            settleFeedback(cardId, {
              status: "failed",
              message: error instanceof Error ? error.message : t("commandCard.failed"),
              ...(acting === undefined ? {} : { reportId: acting }),
              ...(requestKey === undefined ? {} : { requestKey }),
            }),
        );
    },
    [applyTimeline, client, conversationId, settleFeedback, t],
  );

  /** Feedback cards a later result card answers: read from the transcript, which is never rewritten. */
  const answeredFeedbackCards = useMemo(() => {
    const answered = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "feedback-card") continue;
        const answers = (block as { answers?: unknown }).answers;
        if (typeof answers === "string") answered.add(answers);
      }
    }
    return [...answered];
  }, [timeline]);

  return useMemo<BlockActions>(
    () => ({
      onApprovalDecide: decideApproval,
      decidedApprovals,
      deniedApprovals,
      onQuestionAnswer: answerQuestion,
      answeredQuestions,
      questionOutcomes,
      ...(questionDraft === undefined ? {} : { questionDraft }),
      onQuestionDraft: (input) =>
        setQuestionDraft((current) => {
          const sameQuestion = current?.questionId === input.questionId;
          return {
            questionId: input.questionId,
            chosen: input.chosen === undefined ? (sameQuestion ? current.chosen : []) : [...input.chosen],
            text: input.text === undefined ? (sameQuestion ? current.text : "") : input.text,
          };
        }),
      ...(questionPendingId === undefined ? {} : { questionPendingId }),
      ...(decidingApprovalId === undefined ? {} : { decidingApprovalId }),
      onCredentialSubmit: submitCredential,
      ...(credentialStatus === undefined ? {} : { credentialStatus }),
      /*
       * A chosen answer is sent as the user's own message — the same call the composer makes — so a
       * click and a typed reply are one act. Nothing here invents a second route into the agent for
       * a click to take.
       */
      onFormSubmit: ({ summary }) => void send(summary),
      openFormIds: openCardIds.forms,
      onTaskStop: ({ taskId }) => stopTask(taskId),
      taskStop,
      onArtifactOpen: ({ artifactId }) => openArtifact(artifactId),
      artifactOpen,
      onInstallPackage: installPackage,
      packageInstall,
      ...(openInbox === undefined ? {} : { onOpenInbox: openInbox }),
      // The card's own search again, sent the way a typed request is, so the agent lists the files as they are now.
      onSearchAgain: ({ query }) => void send(t("blocks.marketplace.searchAgainMessage").replace("{query}", query)),
      onControlTakeover: ({ sessionId }) => changeBrowserSession(sessionId, "takeover"),
      onControlStop: ({ sessionId }) => changeBrowserSession(sessionId, "stop"),
      controlSession,
      // A terminal's result goes back the way a typed reply does, for the reason forms do.
      onTerminalShare: ({ text }) => void send(text),
      onCommandAction: runCommandAction,
      commandAction,
      signIns,
      onSignInAnswer: answerSignIn,
      onSignInCancel: cancelSignIn,
      ...(conversationId === undefined ? {} : { onFeedbackPreview: previewFeedback, onFeedbackCreate: createFeedback }),
      feedback,
      answeredFeedbackCards,
      folderEntries,
      onFolderEntrySubmit: ({ cardId, rowId, actionId, root }) => developFolder(`${cardId}/${rowId}/${actionId}`, root),
      onFolderEntryCancel: ({ key }) =>
        setFolderEntries((current) => {
          const { [key]: _closed, ...rest } = current;
          return rest;
        }),
      ...modelPicker,
    }),
    [
      modelPicker,
      answeredFeedbackCards,
      conversationId,
      createFeedback,
      feedback,
      previewFeedback,
      answerSignIn,
      cancelSignIn,
      developFolder,
      folderEntries,
      commandAction,
      runCommandAction,
      signIns,
      artifactOpen,
      controlSession,
      changeBrowserSession,
      credentialStatus,
      decideApproval,
      decidedApprovals,
      deniedApprovals,
      decidingApprovalId,
      installPackage,
      openArtifact,
      openCardIds,
      openInbox,
      packageInstall,
      questionDraft,
      questionPendingId,
      send,
      stopTask,
      submitCredential,
      t,
      taskStop,
    ],
  );
}

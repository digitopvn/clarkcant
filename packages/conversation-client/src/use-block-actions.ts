import { useCallback, useEffect, useMemo, useState } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
import type {
  ArtifactOpenState,
  BlockActions,
  ControlSessionActionState,
  PackageInstallState,
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
   * Approvals that already have a receipt in this transcript.
   *
   * The card in storage stays `pending` because messages are never rewritten, so the decision is
   * read from the receipt instead: the operation the user approved carries its approval id.
   */
  const decidedApprovals = useMemo(() => {
    const decided = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.approvalId === "string") decided.add(args.approvalId);
      }
    }
    return [...decided];
  }, [timeline]);

  /**
   * Questions this transcript already has an answer for.
   *
   * The same derivation as `decidedApprovals`, for the same reason: a card in storage keeps saying
   * `waiting` because messages are never rewritten, and the record the node wrote when the answer
   * arrived is what says otherwise. Without it a reload would offer the question again.
   */
  const answeredQuestions = useMemo(() => {
    const answered = new Set<string>();
    for (const message of timeline?.messages ?? []) {
      for (const block of message.blocks) {
        if (block.type !== "tool-activity" || block.name !== "ask_user_question") continue;
        const args = (block.args ?? {}) as Record<string, unknown>;
        if (typeof args.questionId === "string") answered.add(args.questionId);
      }
    }
    return [...answered];
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
    ({ packageId, version }: { packageId: string; version: string }) => {
      setPackageInstall((current) => ({ ...current, [packageId]: { status: "installing" } }));
      void client.installPackage(packageId, version).then(
        (answer) => {
          setPackageInstall((current) => ({
            ...current,
            [packageId]:
              answer.code === "APPROVAL_REQUIRED"
                ? { status: "approval-required", message: answer.message ?? t("shell.package.approvalRequired") }
                : {
                    status: "installed",
                    message: t("shell.package.installed"),
                    ...(answer.generationId === undefined ? {} : { generationId: answer.generationId }),
                    ...(answer.verified === undefined ? {} : { verified: answer.verified }),
                  },
          }));
        },
        (error: unknown) => {
          // The node's own reason, where it gave one: it is the only thing that can say *why* the
          // install stopped.
          setPackageInstall((current) => ({
            ...current,
            [packageId]: {
              status: "refused",
              message: error instanceof Error ? error.message : t("shell.package.installFailed"),
            },
          }));
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

  return useMemo<BlockActions>(
    () => ({
      onApprovalDecide: decideApproval,
      decidedApprovals,
      onQuestionAnswer: answerQuestion,
      answeredQuestions,
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
      onControlTakeover: ({ sessionId }) => changeBrowserSession(sessionId, "takeover"),
      onControlStop: ({ sessionId }) => changeBrowserSession(sessionId, "stop"),
      controlSession,
    }),
    [
      artifactOpen,
      controlSession,
      changeBrowserSession,
      credentialStatus,
      decideApproval,
      decidedApprovals,
      decidingApprovalId,
      installPackage,
      openArtifact,
      openCardIds,
      packageInstall,
      questionDraft,
      questionPendingId,
      send,
      stopTask,
      submitCredential,
      taskStop,
    ],
  );
}

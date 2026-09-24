import type { InboxResponse, WaitingItem } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

/** How many notices the tool reports. The inbox keeps more; a turn needs the recent ones, not the archive. */
const NOTICES_REPORTED = 20;
/** How much of a notice's body goes into the report. The whole body is in the inbox for the person to read. */
const BODY_REPORTED = 240;

/**
 * "Is anything waiting for me? What happened while I was away?" — answered from the inbox, read-only.
 *
 * The tool reads exactly what the inbox panel reads, so the agent and the screen cannot tell the person two different
 * things. It changes nothing: it does not mark a notice read, because the person has not seen it, and it offers no way
 * to decide an approval, because a model is not the person (the same boundary `manage_package` keeps for capability
 * questions). What it can do is point: to the conversation an item belongs to, and to `control_app` `inbox.open` to put
 * the inbox on screen.
 */
export function createReadInboxTool(read: () => InboxResponse): ToolDefinition {
  return {
    name: "read_inbox",
    label: "Đọc hộp thư",
    description:
      "Read the user's inbox: what is waiting for their decision (command approvals, extension capability requests, " +
      "questions you asked) in any conversation, and recent notices from work that ran in the background. Read-only: " +
      "it marks nothing as read and cannot approve anything — only the user can, on the card or in the inbox. Use it " +
      "when the user asks what is waiting, what is new, or how background work went.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    promptSnippet: "read_inbox — what is waiting for the user and what background work reported (read-only)",
    execute: async (): Promise<{ text: string }> => {
      let inbox: InboxResponse;
      try {
        inbox = read();
      } catch (cause) {
        return { text: `Could not read the inbox: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was changed.` };
      }
      return { text: describeInbox(inbox) };
    },
  };
}

/** The inbox as the few lines a model needs to answer from. Exported so the wording can be asserted without a turn. */
export function describeInbox(inbox: InboxResponse): string {
  const lines: string[] = [`Inbox as of ${inbox.readAt}.`];

  if (inbox.waiting.length === 0) {
    lines.push("Nothing is waiting for the user's decision.");
  } else {
    lines.push(`Waiting for the user's decision (${inbox.waiting.length}) — only the user can answer these:`);
    for (const item of inbox.waiting) lines.push(`- ${describeWaiting(item)}`);
  }

  const notices = inbox.notices.slice(0, NOTICES_REPORTED);
  if (notices.length === 0) {
    lines.push("No notices.");
  } else {
    lines.push(`Notices (${inbox.unread} unread; newest first):`);
    for (const notice of notices) {
      const body = notice.body === undefined ? "" : ` — ${clip(notice.body, BODY_REPORTED)}`;
      const where = notice.conversationId === undefined ? "" : ` (conversation ${notice.conversationId})`;
      const state = notice.readAt === undefined ? "unread" : "read";
      lines.push(`- [${state}] ${notice.severity} from ${notice.sourceKind} at ${notice.createdAt}: ${notice.title}${body}${where}`);
    }
    if (inbox.notices.length > notices.length) lines.push(`(${inbox.notices.length - notices.length} older notices not listed.)`);
  }

  lines.push("To show the user, open the inbox with control_app kind inbox.open.");
  return lines.join("\n");
}

function describeWaiting(item: WaitingItem): string {
  switch (item.kind) {
    case "command-approval":
      return (
        `command approval in conversation ${item.conversationId}: ${item.command ?? item.description}` +
        ` (expires ${item.expiresAt})`
      );
    case "capability-approval":
      return `extension ${item.packageId}@${item.version} asks for capability ${item.ref}: ${item.description} (expires ${item.expiresAt})`;
    case "question":
      return (
        `question in conversation ${item.conversationId}: ${item.prompt}` +
        (item.expiresAt === undefined ? "" : ` (expires ${item.expiresAt})`)
      );
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

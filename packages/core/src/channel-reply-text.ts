import type { MessageBlock } from "@clarkcant/contracts";

/**
 * What of Clark's reply is said on an external channel, as text.
 *
 * Only what Clark said to the person who wrote: its words, and the text alternative every view and widget carries.
 * What belongs to the owner's own screen stays there — tool activity, reasoning, the host's system cards, and above all
 * approval cards, which only the owner may answer and never from a channel. Rendering widgets and questions natively
 * on a channel is the rich renderer's job; until then a reply with nothing sayable sends nothing.
 */
export function channelReplyText(blocks: readonly MessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.content);
        break;
      case "surface":
        parts.push(block.snapshot.textAlternative);
        break;
      case "widget-ref":
        parts.push(block.textAlternative);
        break;
      default:
        break;
    }
  }
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}

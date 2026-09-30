import { z } from "zod";
import { appIntentDecisionSchema } from "./app-intents.ts";

export const conversationDeleteRequestSchema = z.strictObject({deletionPermit: z.uuid().optional()});
export const conversationDeleteResultSchema = z.discriminatedUnion("deleted", [
  z.strictObject({
    deleted: z.literal(true),
    conversationId: z.string(),
    attachments: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    pendingFiles: z.number().int().nonnegative(),
    readBack: z.string(),
  }),
  z.strictObject({deleted: z.literal(false), decision: appIntentDecisionSchema}),
]);
export type ConversationDeletionResult = z.infer<typeof conversationDeleteResultSchema>;

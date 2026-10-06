import { z } from "zod";

/**
 * The System One answer shape.
 *
 * Shared by every provider adapter, because the question model is the contract both providers implement: an adapter
 * unwraps whatever envelope its provider puts around the answer, and what it hands to Clark's policy is validated
 * against these schemas and nothing looser.
 */

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().optional(),
});

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number().optional(),
});

export const systemOneAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const systemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), systemOneAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
    })
    .optional(),
});

export type SystemOneAnswer = z.infer<typeof systemOneAnswerSchema>;
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

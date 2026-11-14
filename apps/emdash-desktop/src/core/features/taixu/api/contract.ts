import { pullRequestSchema } from '@emdash/plugins/pull-requests/schemas';
import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const taixuDomain = 'taixu' as const;
export const workOriginSchema = z.object({
  head: z.enum(['product-head', 'marketing-head', 'design-head', 'eng-head']),
  station: z.string().min(1).max(40),
  project: z.string().min(1).max(128).optional(),
  file: z
    .string()
    .regex(/^[a-zA-Z0-9][\w.-]*\.md$/)
    .max(255),
});
export type WorkOrigin = z.infer<typeof workOriginSchema>;
export const workLinkSchema = z.object({
  origin: workOriginSchema,
  taskId: z.string().uuid(),
  projectId: z.string().min(1).max(128),
  name: z.string().max(160),
  error: z.string().max(500).optional(),
});
export const followupInputSchema = z.object({
  taskId: z.string().uuid(),
  projectId: z.string().min(1).max(128),
  conversationId: z.string().uuid(),
  requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(24000),
});
export type WorkFollowup = z.infer<typeof followupInputSchema>;
export const followupReceiptSchema = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'unknown']),
  created: z.boolean(),
});
export const workTargetSchema = z.object({
  taskId: z.string().uuid(),
  projectId: z.string().min(1).max(128),
});
export type WorkTarget = z.infer<typeof workTargetSchema>;
export const mergeReviewSchema = z.object({
  reviewId: z.string().uuid(),
  pr: pullRequestSchema,
  blockedReason: z.string().nullable(),
  warning: z.string().nullable(),
});
export type MergeReview = z.infer<typeof mergeReviewSchema>;
export const mergeApprovalSchema = workTargetSchema.extend({
  reviewId: z.string().uuid(),
  strategy: z.enum(['squash', 'merge', 'rebase']),
  markReady: z.boolean(),
  acceptWarnings: z.boolean(),
});
export type MergeApproval = z.infer<typeof mergeApprovalSchema>;
export const mergeResultSchema = z.object({
  status: z.enum(['merged', 'failed', 'unknown']),
  message: z.string(),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;
export type MergeReceiptInput = WorkTarget & {
  requestId: string;
  url: string;
  head: string;
  strategy: string;
  status: 'pending' | MergeResult['status'];
  message: string;
};
export const mergeReceiptSchema = z.object({
  status: z.enum(['pending', 'merged', 'failed', 'unknown']),
  created: z.boolean(),
});
export const taixuContract = defineContract({
  reviewMerge: procedure({ input: workTargetSchema, output: mergeReviewSchema }),
  approveMerge: procedure({ input: mergeApprovalSchema, output: mergeResultSchema }),
  connect: procedure({
    input: z.object({ chooseFolder: z.boolean().optional() }),
    output: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
  status: procedure({ input: z.object({}), output: z.object({ running: z.boolean() }) }),
  followupWork: procedure({
    input: followupInputSchema,
    output: z.object({ status: z.enum(['sent', 'failed', 'unknown']), message: z.string() }),
  }),
  linkWork: procedure({ input: workLinkSchema, output: z.object({ saved: z.literal(true) }) }),
  projectExists: procedure({ input: z.object({ projectId: z.string() }), output: z.boolean() }),
  taskExists: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.boolean(),
  }),
});

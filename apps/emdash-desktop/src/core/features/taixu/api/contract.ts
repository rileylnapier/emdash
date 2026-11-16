import { pullRequestSchema } from '@emdash/plugins/pull-requests/schemas';
import { defineContract, eventStream, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { appActionSchema, appsStatusSchema } from './apps-contract';

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
/** A Head's request to start a brief. Taixu resolves the brief, name and project, never the model. */
export const headStartInputSchema = z.object({
  origin: workOriginSchema,
  projectId: z.string().min(1).max(128),
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  prompt: z.string().trim().min(1).max(65536),
});
export type HeadStartInput = z.infer<typeof headStartInputSchema>;
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
export const archiveInputSchema = workTargetSchema.extend({
  context: z.string().trim().min(1).max(24000).optional(),
});
export const workArchiveNoteSchema = workTargetSchema.extend({
  name: z.string(),
  context: z.string().max(24000),
  workspacePath: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  urls: z.array(z.string()),
  savedAt: z.string(),
  archived: z.boolean(),
  cleaned: z.boolean(),
  message: z.string(),
});
export type WorkArchiveNote = z.infer<typeof workArchiveNoteSchema>;
export const archiveResultSchema = z.object({
  archived: z.boolean(),
  cleaned: z.boolean(),
  message: z.string(),
});
export type WorkArchiveResult = z.infer<typeof archiveResultSchema>;
export type WorkArchiveInput = z.infer<typeof archiveInputSchema>;
export const taixuContract = defineContract({
  apps: procedure({ input: z.object({}), output: appsStatusSchema }),
  appAction: procedure({ input: appActionSchema, output: appsStatusSchema, callTimeoutMs: 90000 }),
  // Always this Mac, even while Studio is selected, so both Macs' versions can be compared.
  localApps: procedure({ input: z.object({}), output: appsStatusSchema }),
  localAppAction: procedure({
    input: appActionSchema,
    output: appsStatusSchema,
    callTimeoutMs: 90000,
  }),
  readArchive: procedure({ input: workTargetSchema, output: workArchiveNoteSchema.nullable() }),
  listArchives: procedure({
    input: z.object({ offset: z.number().int().min(0).default(0) }),
    output: z.object({ notes: z.array(workArchiveNoteSchema), nextOffset: z.number().nullable() }),
  }),
  archiveWork: procedure({
    input: archiveInputSchema,
    output: archiveResultSchema,
    callTimeoutMs: 0,
  }),
  restoreWork: procedure({
    input: workTargetSchema,
    output: z.object({ restored: z.boolean(), message: z.string() }),
  }),
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
  /** Work a Head started in the main process; the renderer provisions it so its agent starts. */
  workStarted: eventStream({ key: z.void(), event: workTargetSchema }),
  taskExists: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.boolean(),
  }),
});

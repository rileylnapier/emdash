import { z } from 'zod';

// Any app the hub reports (LoveLife's packages/desktop-runtime/mac-services.cjs catalog). The hub validates every action
// against that catalog, so the page doesn't keep a second list that a newly added app would break.
const appIdSchema = z.string().regex(/^[a-z]{1,32}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const singleAppActionSchema = z.object({
  appId: appIdSchema,
  // The laptop never installs past the version its Studio runs.
  ceiling: versionSchema.optional(),
  build: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  action: z.enum(['start', 'open', 'stop', 'check-update', 'update', 'install']),
});
// Update all runs one app at a time on the computer that receives it.
export const appActionSchema = z.union([
  singleAppActionSchema,
  z.object({
    action: z.literal('update-all'),
    ceilings: z.array(z.object({ appId: appIdSchema, version: versionSchema })).optional(),
  }),
]);
export type AppAction = z.infer<typeof appActionSchema>;
export const appsStatusSchema = z.object({
  computer: z.string(),
  updateAll: z
    .object({
      running: z.boolean(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      apps: z.array(
        z.object({
          appId: appIdSchema,
          status: z.enum(['queued', 'working', 'updated', 'current', 'skipped', 'failed']),
          step: z.string().nullable(),
          progress: z.number().min(0).max(1).nullable(),
          message: z.string().nullable(),
        })
      ),
    })
    .nullable()
    .optional(),
  apps: z.array(
    z.object({
      id: appIdSchema,
      name: z.string(),
      detail: z.string(),
      supported: z.boolean(),
      state: z.enum([
        'unavailable',
        'planned',
        'needs-install',
        'stopped',
        'idle',
        'running',
        'updating',
      ]),
      endpoint: z.string().nullable(),
      windowOpen: z.boolean(),
      blockers: z.array(z.string()),
      version: z.string().nullable(),
      // Present only when the app is missing; version is the release this computer published.
      install: z.object({ version: z.string().nullable() }).nullable().optional(),
      updates: z
        .object({
          supported: z.boolean(),
          configured: z.boolean(),
          busy: z.boolean(),
          phase: z.enum([
            'disabled',
            'idle',
            'checking',
            'downloading',
            'ready',
            'current',
            'error',
            'blocked',
            'preparing',
            'restarting',
          ]),
          progress: z.number().min(0).max(1),
          release: z
            .object({ version: z.string(), build: z.string().regex(/^[a-f0-9]{64}$/) })
            .nullable(),
          blockers: z.array(z.string()),
          message: z.string().nullable(),
        })
        .nullable()
        .optional(),
    })
  ),
});
export type AppsStatus = z.infer<typeof appsStatusSchema>;

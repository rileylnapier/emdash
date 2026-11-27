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
  // Restart is only for a service that runs but never answers; the hub checks that before forcing it.
  action: z.enum(['start', 'open', 'stop', 'check-update', 'update', 'install', 'restart']),
});
// Update all runs one app at a time on the computer that receives it.
// Start all starts every stopped app and restarts every stuck one there, leaving answering apps alone.
export const appActionSchema = z.union([
  singleAppActionSchema,
  z.object({
    action: z.literal('update-all'),
    ceilings: z.array(z.object({ appId: appIdSchema, version: versionSchema })).optional(),
  }),
  z.object({ action: z.literal('start-all') }),
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
        'not-responding',
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

// Installing on the laptop from the Studio's published release. The Studio describes and serves it in pieces; this Mac
// reassembles and installs it after the same checks as a local install (checksum, Apple signature, Taixu's team,
// bundle ID, hub marker and version).
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
export const appReleaseSchema = z.object({
  appId: appIdSchema,
  build: hex64,
  sha256: hex64,
  version: versionSchema,
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
});
export type AppRelease = z.infer<typeof appReleaseSchema>;
export const appChunkInputSchema = z.object({
  appId: appIdSchema,
  build: hex64,
  offset: z.number().int().min(0),
});
export const appReceiveInputSchema = appReleaseSchema.extend({
  offset: z.number().int().min(0),
  data: z.string().max(400 * 1024),
});

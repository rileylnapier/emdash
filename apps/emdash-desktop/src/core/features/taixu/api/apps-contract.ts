import { z } from 'zod';

export const appActionSchema = z.object({
  appId: z.enum(['flow', 'bloom', 'taste', 'jam', 'wondercraft', 'scout']),
  build: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  action: z.enum(['start', 'open', 'stop', 'check-update', 'update', 'install']),
});
export type AppAction = z.infer<typeof appActionSchema>;
export const appsStatusSchema = z.object({
  computer: z.string(),
  apps: z.array(
    z.object({
      id: z.enum(['flow', 'bloom', 'taste', 'jam', 'wondercraft', 'scout']),
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

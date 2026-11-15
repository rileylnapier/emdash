import { z } from 'zod';

export const appActionSchema = z.object({
  appId: z.enum(['flow', 'bloom', 'taste', 'jam']),
  action: z.enum(['start', 'open', 'stop']),
});
export type AppAction = z.infer<typeof appActionSchema>;
export const appsStatusSchema = z.object({
  computer: z.string(),
  apps: z.array(
    z.object({
      id: z.enum(['flow', 'bloom', 'taste', 'jam']),
      name: z.string(),
      detail: z.string(),
      supported: z.boolean(),
      state: z.enum(['unavailable', 'planned', 'needs-install', 'stopped', 'idle', 'running']),
      endpoint: z.string().nullable(),
      windowOpen: z.boolean(),
      blockers: z.array(z.string()),
      version: z.string().nullable(),
    })
  ),
});
export type AppsStatus = z.infer<typeof appsStatusSchema>;

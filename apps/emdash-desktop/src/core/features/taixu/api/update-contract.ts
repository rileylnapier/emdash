import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

// Deliberately versioned separately from the full desktop protocol. Keep v1
// readable by older installations: it is their path out of a build mismatch.
export const UPDATE_PREFIX = 'taixuUpdateV1.';
export const buildSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const releaseSchema = z.object({
  protocol: z.literal(1),
  build: buildSchema,
  createdAt: z.string().datetime(),
  arch: z.enum(['arm64', 'x64']),
  size: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  sha256: buildSchema,
  notes: z.string().max(8000),
});
export type TaixuRelease = z.infer<typeof releaseSchema>;
export const updateStateSchema = z.object({
  status: z.enum([
    'idle',
    'checking',
    'downloading',
    'ready',
    'preparing',
    'blocked',
    'installing',
    'error',
  ]),
  current: z.string(),
  hold: z.string().nullable(),
  release: releaseSchema.nullable(),
  progress: z.number(),
  message: z.string(),
  remote: z.boolean(),
  target: z.enum(['this-mac', 'studio', 'both']).optional(),
  diagnostics: z.string().optional(),
});
export type TaixuUpdateState = z.infer<typeof updateStateSchema>;
export const maintenanceContract = defineContract({
  info: procedure({
    input: z.void(),
    output: z.object({
      build: z.string(),
      release: releaseSchema.nullable(),
      installedBuild: z.string().optional(),
    }),
  }),
  chunk: procedure({
    input: z.object({ build: buildSchema, offset: z.number().int().min(0) }),
    output: z.string(),
  }),
  prepare: procedure({ input: z.object({ build: buildSchema }), output: z.string() }),
  cancel: procedure({ input: z.object({ lease: z.string() }), output: z.void() }),
  commit: procedure({
    input: z.object({ lease: z.string() }),
    output: z.object({ accepted: z.boolean(), error: z.string().nullable() }),
  }),
});

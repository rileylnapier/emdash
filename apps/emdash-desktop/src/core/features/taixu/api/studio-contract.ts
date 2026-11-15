import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';
import { updateStateSchema } from './update-contract';

export const STUDIO_CONTROL_CHANNEL = 'taixu-studio-control';
export const STUDIO_DESKTOP_CHANNEL = 'taixu-studio-desktop';
export const studioStatusSchema = z.object({
  selected: z.string().nullable(),
  name: z.string().nullable(),
  connected: z.boolean(),
  sharing: z.boolean(),
  serverMode: z.boolean(),
  version: z.string().min(1),
  build: z.string(),
  uptimeSeconds: z.number(),
  socketPath: z.string(),
  error: z.string().nullable(),
  machines: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type StudioStatus = z.infer<typeof studioStatusSchema>;
// Always reached on a separate, LOCAL Wire connection, even when the desktop is remote.
export const studioControlContract = defineContract({
  acknowledgeUpdate: procedure({
    input: z.object({ hold: z.string(), error: z.string().max(600).nullable() }),
    output: z.void(),
  }),
  updateStatus: procedure({ input: z.void(), output: updateStateSchema }),
  checkUpdate: procedure({ input: z.void(), output: updateStateSchema }),
  installUpdate: procedure({ input: z.void(), output: updateStateSchema }),
  status: procedure({ input: z.void(), output: studioStatusSchema }),
  setServerMode: procedure({ input: z.object({ enabled: z.boolean() }), output: z.void() }),
  connect: procedure({ input: z.object({ id: z.string() }), output: studioStatusSchema }),
  disconnect: procedure({ input: z.void(), output: studioStatusSchema }),
  share: procedure({ input: z.object({ enabled: z.boolean() }), output: studioStatusSchema }),
});

import { defineContract, procedure } from '@emdash/wire/rpc';
import { z } from 'zod';

export const taixuDomain = 'taixu' as const;
export const taixuContract = defineContract({
  connect: procedure({
    input: z.object({ chooseFolder: z.boolean().optional() }),
    output: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
  }),
  status: procedure({ input: z.object({}), output: z.object({ running: z.boolean() }) }),
  taskExists: procedure({
    input: z.object({ projectId: z.string(), taskId: z.string() }),
    output: z.boolean(),
  }),
});

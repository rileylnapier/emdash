import { z } from 'zod';

// Exported by the app's ACP service. Take only the latest settled turn's final
// assistant message, never tool results, reasoning, prompts or an earlier turn.
const transcriptSchema = z.object({
  active: z.unknown().nullable(),
  committed: z.array(
    z.object({
      items: z.array(
        z.object({ kind: z.string(), role: z.string().optional(), text: z.string().optional() })
      ),
      outcome: z.object({ kind: z.string() }).optional(),
    })
  ),
});

export function finalWorkReply(transcript: string): string | undefined {
  try {
    const parsed = transcriptSchema.parse(JSON.parse(transcript));
    if (parsed.active) return;
    const turn = parsed.committed.at(-1);
    if (turn?.outcome?.kind !== 'done') return;
    return [...turn.items]
      .reverse()
      .find((item) => item.kind === 'message' && item.role === 'assistant')
      ?.text?.slice(0, 24000);
  } catch {
    return;
  }
}

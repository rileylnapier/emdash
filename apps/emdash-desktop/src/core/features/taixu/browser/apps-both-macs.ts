import type { AppAction, AppsStatus } from '../api/apps-contract';

// "Update apps on both Macs" from the laptop: Update all on Studio, wait for it to
// finish, then Update all on this Mac capped at Studio's resulting versions. Lives
// outside the Apps page so switching views does not interrupt it; Taixu must stay open.
export interface BothMacsClient {
  apps(input: Record<string, never>): Promise<AppsStatus>;
  appAction(input: AppAction): Promise<unknown>;
  localApps(input: Record<string, never>): Promise<AppsStatus>;
  localAppAction(input: AppAction): Promise<unknown>;
}
export type BothMacsRun =
  | { phase: 'studio' | 'this-mac'; computer: string; error?: undefined }
  | { phase: 'done'; computer: string; error?: undefined }
  | { phase: 'failed'; computer: string; error: string };

let run: BothMacsRun | null = null;
const listeners = new Set<() => void>();
const publish = (next: BothMacsRun | null) => {
  run = next;
  for (const listener of listeners) listener();
};
export const bothMacsRun = () => run;
export function subscribeBothMacs(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const installed = (app: AppsStatus['apps'][number]) =>
  app.state !== 'needs-install' && app.state !== 'planned' ? app.version : null;
export const studioCeilings = (studio: AppsStatus) =>
  studio.apps.flatMap((app) => {
    const version = installed(app);
    return version ? [{ appId: app.id, version }] : [];
  });

// Start a hub's Update all and wait until that run (not an earlier one) finishes.
async function updateAll(
  read: () => Promise<AppsStatus>,
  start: () => Promise<unknown>,
  pollMs: number
): Promise<AppsStatus> {
  const before = (await read()).updateAll;
  if (!before?.running) await start();
  for (;;) {
    const status = await read();
    const job = status.updateAll;
    if (job && !job.running && (before?.running || job.startedAt !== before?.startedAt))
      return status;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function updateBothMacs(client: BothMacsClient, pollMs = 2000) {
  if (run && (run.phase === 'studio' || run.phase === 'this-mac')) return;
  let computer = 'Studio';
  try {
    computer = (await client.apps({})).computer;
    publish({ phase: 'studio', computer });
    const studio = await updateAll(
      () => client.apps({}),
      () => client.appAction({ action: 'update-all' }),
      pollMs
    );
    publish({ phase: 'this-mac', computer });
    await updateAll(
      () => client.localApps({}),
      () => client.localAppAction({ action: 'update-all', ceilings: studioCeilings(studio) }),
      pollMs
    );
    publish({ phase: 'done', computer });
  } catch (cause) {
    publish({
      phase: 'failed',
      computer,
      error: cause instanceof Error ? cause.message : 'Updating both Macs stopped. Refresh.',
    });
  }
}
export function resetBothMacsForTests() {
  run = null;
}

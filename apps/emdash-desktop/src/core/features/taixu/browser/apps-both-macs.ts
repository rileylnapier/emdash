import type { AppAction, AppsStatus } from '../api/apps-contract';
import type { TaixuUpdateState } from '../api/update-contract';

// "Update everything" from the laptop: Update all on Studio, wait for it to finish,
// then Update all on this Mac capped at Studio's resulting versions, then Taixu
// itself, last because it restarts. Lives outside the Apps page so switching views
// does not interrupt it; Taixu must stay open.
export interface BothMacsClient {
  apps(input: Record<string, never>): Promise<AppsStatus>;
  appAction(input: AppAction): Promise<unknown>;
  localApps(input: Record<string, never>): Promise<AppsStatus>;
  localAppAction(input: AppAction): Promise<unknown>;
}
/** The window's Taixu update control: the same calls its primary button makes. */
export interface TaixuUpdater {
  state(): TaixuUpdateState | undefined;
  check(): Promise<void>;
  install(): Promise<void>;
}
export type BothMacsRun =
  | { phase: 'studio'; computer: string; error?: undefined }
  | { phase: 'this-mac'; computer: string; error?: undefined }
  | { phase: 'taixu'; computer: string; error?: undefined }
  | {
      phase: 'done';
      computer: string;
      taixu: 'current' | 'updated' | 'restarting' | 'blocked';
      message: string;
      error?: undefined;
    }
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
export const bothMacsRunning = (current: BothMacsRun | null) =>
  current?.phase === 'studio' || current?.phase === 'this-mac' || current?.phase === 'taixu';

const installed = (app: AppsStatus['apps'][number]) =>
  app.state !== 'needs-install' && app.state !== 'planned' ? app.version : null;
export const studioCeilings = (studio: AppsStatus) =>
  studio.apps.flatMap((app) => {
    const version = installed(app);
    return version ? [{ appId: app.id, version }] : [];
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await sleep(pollMs);
  }
}

async function settle(
  taixu: TaixuUpdater,
  done: (state: TaixuUpdateState) => boolean,
  timeoutMs: number,
  pollMs: number,
  what: string
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = taixu.state();
    if (state && done(state)) return state;
    if (Date.now() >= deadline)
      throw new Error(`Taixu did not finish ${what} in time. See the Taixu card above.`);
    await sleep(pollMs);
  }
}

// A slow SSH download of a large build can take a while; readiness checks and a
// Studio-first restart are quicker.
const CHECK_TIMEOUT_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

async function updateTaixu(
  taixu: TaixuUpdater,
  pollMs: number,
  timeouts: { check: number; install: number }
): Promise<Pick<Extract<BothMacsRun, { phase: 'done' }>, 'taixu' | 'message'>> {
  const before = taixu.state()?.status;
  // A restart already underway (from the card, or the other Mac) is just observed.
  if (before !== 'preparing' && before !== 'installing') {
    await taixu.check();
    const checked = await settle(
      taixu,
      (state) => ['idle', 'ready', 'blocked', 'error'].includes(state.status),
      timeouts.check,
      pollMs,
      'checking for an update'
    );
    if (checked.status === 'error') throw new Error(`Taixu: ${checked.message}`);
    if (checked.status === 'idle') return { taixu: 'current', message: checked.message };
    // Blocked keeps the verified release; retrying is what the card's button offers.
    await taixu.install();
  }
  const outcome = await settle(
    taixu,
    (state) => !['ready', 'preparing'].includes(state.status),
    timeouts.install,
    pollMs,
    'its readiness checks'
  );
  if (outcome.status === 'installing') return { taixu: 'restarting', message: outcome.message };
  // Studio restarted and this Mac was already current.
  if (outcome.status === 'idle') return { taixu: 'updated', message: outcome.message };
  if (outcome.status === 'blocked') return { taixu: 'blocked', message: outcome.message };
  throw new Error(`Taixu: ${outcome.message}`);
}

export async function updateBothMacs(
  client: BothMacsClient,
  {
    taixu,
    pollMs = 2000,
    timeouts = { check: CHECK_TIMEOUT_MS, install: INSTALL_TIMEOUT_MS },
  }: {
    taixu?: TaixuUpdater;
    pollMs?: number;
    timeouts?: { check: number; install: number };
  } = {}
) {
  if (bothMacsRunning(run)) return;
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
    publish({ phase: 'taixu', computer });
    if (!taixu) throw new Error('Taixu updates are unavailable. Restart Taixu, then try again.');
    publish({ phase: 'done', computer, ...(await updateTaixu(taixu, pollMs, timeouts)) });
  } catch (cause) {
    publish({
      phase: 'failed',
      computer,
      error: cause instanceof Error ? cause.message : 'Updating everything stopped. Refresh.',
    });
  }
}
export function resetBothMacsForTests() {
  run = null;
}

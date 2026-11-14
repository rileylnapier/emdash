import { randomUUID } from 'node:crypto';
// Freeze new desktop calls before testing for activity. Shared by the local
// renderer and Studio clients; update control itself has a separate channel.
let locked = false;
let rendererHold: string | null = null;
let acknowledge: ((error: string | null) => void) | undefined;
export const getUpdateHold = () => rendererHold;
export function acknowledgeUpdateHold(id: string, error: string | null) {
  if (id === rendererHold) acknowledge?.(error);
}
async function holdRenderer() {
  rendererHold = randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      acknowledge = undefined;
      reject(new Error('Taixu’s window did not confirm readiness. Reopen it before updating.'));
    }, 10000);
    acknowledge = (error) => {
      clearTimeout(timer);
      acknowledge = undefined;
      if (error) reject(new Error(error));
      else resolve();
    };
  });
}
let calls = 0;
let committed = false;
let quiesceHeads: ((hold: boolean) => Promise<void>) | undefined;
export const isUpdateHeld = () => locked;
export const isTaixuInstallRequested = () => committed;
export const markTaixuInstallRequested = () => {
  committed = true;
};
export function registerHeadUpdateGuard(guard: (hold: boolean) => Promise<void>) {
  quiesceHeads = guard;
  return () => {
    if (quiesceHeads === guard) quiesceHeads = undefined;
  };
}
export async function guardedDesktopCall<T>(method: string, run: () => Promise<T> | T): Promise<T> {
  if (
    method === 'host.ackShutdownFlush' ||
    method === 'host.events' ||
    method === 'host.shutdownReady' ||
    method === 'mementos.memento.save' ||
    method === 'editor.saveBuffer'
  )
    return run();
  if (locked) throw new Error('Taixu is preparing an update. Try again after it restarts.');
  calls++;
  try {
    return await run();
  } finally {
    calls--;
  }
}
export async function holdForUpdate(assertIdle: () => Promise<void>) {
  if (locked) throw new Error('An update is already being prepared.');
  locked = true;
  const release = async () => {
    if (committed) return;
    try {
      await quiesceHeads?.(false);
    } finally {
      rendererHold = null;
      locked = false;
    }
  };
  try {
    // Existing requests must finish; never cancel a user's work for an update.
    for (let i = 0; calls && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    if (calls)
      throw new Error('Work is still starting. Wait for it to finish, then retry the update.');
    await quiesceHeads?.(true);
    await holdRenderer();
    await assertIdle();
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

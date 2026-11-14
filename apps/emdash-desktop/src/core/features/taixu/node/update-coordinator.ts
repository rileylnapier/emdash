import path from 'node:path';
import { client, type Connection } from '@emdash/wire/rpc';
import { maintenanceContract, releaseSchema, type TaixuUpdateState } from '../api/update-contract';
import { downloadRelease, readRelease } from './update-files';
import { getUpdateHold } from './update-guard';
import type { createUpdateHost } from './update-host';
import {
  attemptDirectory,
  readPendingStudioUpdates,
  savePendingStudioUpdates,
  type UpdateAttempt,
} from './update-journal';

export type UpdatePeer = { connection: Connection; close(): void };
const message = (e: unknown) =>
  e instanceof Error ? e.message.slice(0, 600) : 'Could not update Taixu.';
export function createUpdateCoordinator({
  host,
  source,
  openPeer,
}: {
  host: ReturnType<typeof createUpdateHost>;
  source: () => string | null;
  openPeer: (id: string, signal: AbortSignal) => Promise<UpdatePeer>;
}) {
  let state: TaixuUpdateState = {
    status: 'idle',
    hold: null,
    current: host.build,
    release: null,
    progress: 0,
    message: 'Updates come from your Studio over SSH.',
    remote: false,
  };
  let pending: Promise<void> | undefined;
  let abort = new AbortController();
  let disposed = false;
  let readySource: string | null | undefined;
  // A lost commit reply must be reconciled by observing the build, never replayed.
  const unconfirmedStudioBuilds = new Map<string, string>();
  const updateTarget = (local: boolean, studio: boolean): TaixuUpdateState['target'] =>
    local && studio ? 'both' : studio ? 'studio' : 'this-mac';
  const status = () => ({ ...state, hold: getUpdateHold() });
  let recovered = false;
  let localCommitted = false;
  async function diagnostics(attempt: UpdateAttempt | null, signal = abort.signal) {
    if (!attempt) return;
    const installed = await host.installedBuild();
    if (disposed || signal.aborted) return;
    state = {
      ...state,
      diagnostics: [
        `Computer: ${attempt.computer}`,
        `Attempt: ${attempt.id}`,
        `Target: ${attempt.release.build}`,
        `Running: ${host.build}`,
        `Installed: ${installed}`,
        `Phase: ${attempt.phase}`,
        `Updated: ${attempt.updatedAt}`,
        attempt.error ? `Error: ${attempt.error}` : '',
        `Log: ${path.join(attemptDirectory(host.root, attempt.id), 'installer.log')}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  async function restore(signal: AbortSignal) {
    if (recovered) return false;
    const { attempt, ready } = await host.recover();
    const unconfirmed = await readPendingStudioUpdates(host.root);
    signal.throwIfAborted();
    for (const [id, build] of Object.entries(unconfirmed)) unconfirmedStudioBuilds.set(id, build);
    await diagnostics(attempt, signal);
    const id = source();
    await checkInstalled();
    recovered = true;
    if (ready && ready.source === id && ready.release.build !== host.build) {
      state = { ...state, status: 'checking', message: 'Verifying the saved update on this Mac…' };
      await host.stage(
        ready.release,
        ready.cache === 'download' ? path.join(host.root, 'download') : host.root,
        id
      );
      signal.throwIfAborted();
      if (source() !== id)
        throw new Error('The selected computer changed. Check for updates again.');
      readySource = id;
      const interrupted =
        attempt?.release.build === ready.release.build && attempt.phase !== 'confirmed';
      let target: TaixuUpdateState['target'] = id ? undefined : 'this-mac';
      let peer: UpdatePeer | undefined;
      try {
        if (id) {
          peer = await openPeer(id, signal);
          const info = await client(maintenanceContract, peer.connection, {
            pathPrefix: 'taixuUpdateV1',
          }).info();
          target = updateTarget(true, !matches(info, ready.release.build));
        }
      } catch {
        // The verified cache remains usable when SSH is offline. Install always
        // rechecks both fingerprints before preparing either computer.
      } finally {
        peer?.close();
      }
      signal.throwIfAborted();
      state = {
        ...state,
        release: ready.release,
        progress: 100,
        remote: !!id,
        target,
        status: interrupted ? 'blocked' : 'ready',
        message: interrupted
          ? `${attempt.computer}: update stopped at ${attempt.phase}${attempt.error ? ` — ${attempt.error}` : '; the target build has not started'}. The saved update is verified. Retry when resolved.`
          : 'Saved update verified. Retry will check which computers need updating.',
      };
      return true;
    }
    return false;
  }
  async function forgetStudio(id: string) {
    unconfirmedStudioBuilds.delete(id);
    await savePendingStudioUpdates(host.root, unconfirmedStudioBuilds);
  }
  // v1 peers may omit installedBuild. New peers must agree on disk and in memory.
  const matches = (info: { build: string; installedBuild?: string }, build: string) =>
    info.build === build && (info.installedBuild === undefined || info.installedBuild === build);
  const checkInstalled = async () => {
    if ((await host.installedBuild()) !== host.build)
      throw new Error(
        'This Mac’s installed and running builds differ. Finish local work, then reopen /Applications/Taixu.app before retrying.'
      );
  };
  const start = (fn: (signal: AbortSignal) => Promise<void>) => {
    if (pending || disposed) return;
    const operation = abort;
    pending = fn(operation.signal)
      .catch((e) => {
        if (!disposed && operation === abort)
          state = { ...state, status: 'error', message: message(e) };
      })
      .finally(() => {
        pending = undefined;
      });
  };
  async function check(signal: AbortSignal) {
    if (await restore(signal)) return;
    await checkInstalled();
    const id = source();
    state = {
      ...state,
      status: 'checking',
      target: undefined,
      remote: !!id,
      message: 'Checking for a Taixu release…',
    };
    let peer: UpdatePeer | undefined;
    try {
      peer = id ? await openPeer(id, signal) : undefined;
      const remote = peer
        ? client(maintenanceContract, peer.connection, { pathPrefix: 'taixuUpdateV1' })
        : undefined;
      const info = remote
        ? await remote.info()
        : { build: host.build, release: await readRelease(host.root) };
      signal.throwIfAborted();
      if (!info.release || (info.release.build === host.build && matches(info, host.build))) {
        state = {
          ...state,
          status: 'idle',
          release: null,
          message: info.release
            ? id
              ? 'Both installations are current.'
              : 'Taixu is current.'
            : 'No Taixu release has been shared from the Studio yet.',
        };
        return;
      }
      const release = releaseSchema.parse(info.release);
      if (release.arch !== process.arch)
        throw new Error('The Studio release is for a different Mac architecture.');
      state = {
        ...state,
        status: 'downloading',
        release,
        progress: 0,
        message: 'Downloading and verifying Taixu…',
      };
      const cache = remote ? path.join(host.root, 'download') : host.root;
      if (remote && release.build !== host.build)
        await downloadRelease(
          cache,
          release,
          (offset) => remote.chunk({ build: release.build, offset }),
          (progress) => {
            if (!signal.aborted) state = { ...state, progress };
          },
          signal
        );
      signal.throwIfAborted();
      if (release.build !== host.build) await host.stage(release, cache, id);
      signal.throwIfAborted();
      if (source() !== id)
        throw new Error('The selected computer changed. Check for updates again.');
      readySource = id;
      const localUpdate = release.build !== host.build;
      const studioUpdate = !!remote && !matches(info, release.build);
      state = {
        ...state,
        status: 'ready',
        progress: 100,
        target: updateTarget(localUpdate, studioUpdate),
        message: studioUpdate
          ? localUpdate
            ? 'Update ready for Studio and this Mac.'
            : 'Update ready for Studio. This Mac is current.'
          : id
            ? 'Update ready for this Mac. Studio is current and its work will keep running.'
            : 'Update ready for this Mac.',
      };
    } finally {
      peer?.close();
    }
  }
  async function install(signal: AbortSignal) {
    const release = state.release;
    const id = source();
    if (!release || readySource !== id)
      throw new Error('Check for updates on this computer first.');
    localCommitted = false;
    state = { ...state, status: 'preparing', message: 'Checking which computers need updating…' };
    let peer: UpdatePeer | undefined;
    let localLease: string | undefined;
    let remoteLease: string | undefined;
    let remoteCommitted = false;
    let checkingComputer = id ? 'Studio connection' : 'This Mac';
    try {
      peer = id ? await openPeer(id, signal) : undefined;
      const remote = peer
        ? client(maintenanceContract, peer.connection, { pathPrefix: 'taixuUpdateV1' })
        : undefined;
      const info = remote ? await remote.info() : undefined;
      signal.throwIfAborted();
      if (info?.installedBuild !== undefined && info.installedBuild !== info.build)
        throw new Error(
          'Studio’s installed and running builds differ. Finish Studio work, then reopen its installed Taixu before retrying.'
        );
      if (info?.release && info.release.build !== release.build) {
        state = {
          ...state,
          status: 'error',
          release: null,
          message:
            'Studio has a different release now. Check for updates again before restarting either Mac.',
        };
        return;
      }
      await checkInstalled();
      const localUpdate = host.build !== release.build;
      const studioUpdate = !!remote && !!info && !matches(info, release.build);
      state = { ...state, target: updateTarget(localUpdate, studioUpdate) };
      const unconfirmedStudioBuild = id ? unconfirmedStudioBuilds.get(id) : undefined;
      if (unconfirmedStudioBuild) {
        if (!info || !matches(info, unconfirmedStudioBuild))
          throw new Error(
            'The previous Studio restart is not confirmed. Reconnect to Studio, then retry.'
          );
        await forgetStudio(id!);
      }
      if (localUpdate) {
        checkingComputer = 'This Mac';
        state = { ...state, message: 'Checking active work and unsaved files on this Mac…' };
        localLease = await host.prepare(release.build);
      }
      signal.throwIfAborted();
      // A current Studio needs no reservation: its backend and tasks remain untouched.
      if (remote && studioUpdate) {
        checkingComputer = 'Studio';
        state = { ...state, message: 'Checking active work and unsaved files on Studio…' };
        remoteLease = await remote.prepare({ build: release.build }, { timeoutMs: 120000 });
      }
      signal.throwIfAborted();
      if (remote && remoteLease) {
        checkingComputer = 'Studio';
        state = { ...state, message: 'Confirming Studio restart readiness…' };
        // A lost reply can mean the Studio already quit. Never replay commit.
        unconfirmedStudioBuilds.set(id!, release.build);
        await savePendingStudioUpdates(host.root, unconfirmedStudioBuilds);
        signal.throwIfAborted();
        remoteCommitted = true;
        const result = await remote
          .commit({ lease: remoteLease }, { timeoutMs: 120000 })
          .catch(() => undefined);
        if (result && !result.accepted) {
          remoteCommitted = false;
          await forgetStudio(id!);
          throw new Error(result.error ?? 'The Studio could not update.');
        }
        state = {
          ...state,
          status: result?.accepted ? 'installing' : 'preparing',
          message: result?.accepted
            ? 'Restarting Studio. Waiting for it to come back…'
            : 'Confirming the Studio update after losing its reply…',
        };
        peer?.close();
        peer = undefined;
        let confirmed = false;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 2000));
          let probe: UpdatePeer | undefined;
          try {
            probe = await openPeer(id!, signal);
            const next = await client(maintenanceContract, probe.connection, {
              pathPrefix: 'taixuUpdateV1',
            }).info();
            if (matches(next, release.build)) {
              confirmed = true;
              await forgetStudio(id!);
              break;
            }
          } catch {
            /* Only observe the restart; never replay a mutation. */
          } finally {
            probe?.close();
          }
        }
        if (!confirmed)
          throw new Error(
            'The Studio has not confirmed its new build. This Mac was left running. Reopen Taixu on the Studio, then retry the update.'
          );
      }
      signal.throwIfAborted();
      if (localLease) {
        checkingComputer = 'This Mac';
        state = {
          ...state,
          status: 'preparing',
          message: 'Confirming this Mac’s restart readiness…',
        };
        await host.commit(localLease);
        localCommitted = true;
        state = { ...state, status: 'installing', message: 'Restarting this Mac’s Taixu…' };
      } else {
        state = {
          ...state,
          status: 'idle',
          release: null,
          target: undefined,
          message: id ? 'Both installations are current.' : 'Taixu is current.',
        };
      }
    } catch (error) {
      if (!signal.aborted && !disposed)
        state = {
          ...state,
          status: 'blocked',
          message: `${checkingComputer}: ${message(error)} The verified update is still ready. Retry when resolved.`,
        };
    } finally {
      if (remoteLease && !remoteCommitted && peer)
        await client(maintenanceContract, peer.connection, { pathPrefix: 'taixuUpdateV1' })
          .cancel({ lease: remoteLease })
          .catch(() => {});
      if (localLease) await host.cancel(localLease);
      peer?.close();
      await host
        .recover()
        .then(({ attempt }) => diagnostics(attempt, signal))
        .catch(() => {});
    }
  }
  const checkNow = () => {
    if (!['ready', 'blocked', 'preparing', 'installing', 'downloading'].includes(state.status))
      start(check);
    return status();
  };
  let observing = false;
  const progressTimer = setInterval(() => {
    if (observing || disposed || !localCommitted || state.status !== 'installing') return;
    observing = true;
    void host
      .recover()
      .then(async ({ attempt }) => {
        if (!attempt || disposed || state.status !== 'installing') return;
        await diagnostics(attempt);
        if (attempt.error && attempt.release.build === state.release?.build) {
          state = {
            ...state,
            status: 'error',
            message: `${attempt.computer}: update stopped at ${attempt.phase} — ${attempt.error} Finish quitting Taixu and reopen it to retry the saved update.`,
          };
        }
      })
      .catch(() => {})
      .finally(() => {
        observing = false;
      });
  }, 2000);
  const startup = setTimeout(checkNow, 0);
  const timer = setInterval(checkNow, 60 * 60 * 1000);
  return {
    status,
    check: checkNow,
    install() {
      if (!['ready', 'blocked'].includes(state.status))
        throw new Error('Wait for the update to finish downloading.');
      start(install);
      return status();
    },
    invalidate() {
      abort.abort();
      abort = new AbortController();
      readySource = undefined;
      recovered = false;
      localCommitted = false;
      state = {
        ...state,
        status: 'idle',
        release: null,
        target: undefined,
        diagnostics: undefined,
        progress: 0,
        message: 'Computer changed. Check for updates again.',
      };
    },
    async dispose() {
      disposed = true;
      clearTimeout(startup);
      clearInterval(progressTimer);
      clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}

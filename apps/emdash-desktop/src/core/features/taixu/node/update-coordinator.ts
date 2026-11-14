import path from 'node:path';
import { client, type Connection } from '@emdash/wire/rpc';
import { maintenanceContract, releaseSchema, type TaixuUpdateState } from '../api/update-contract';
import { downloadRelease, readRelease } from './update-files';
import { getUpdateHold } from './update-guard';
import type { createUpdateHost } from './update-host';

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
      if (!info.release || (info.release.build === host.build && info.build === host.build)) {
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
      if (release.build !== host.build) await host.stage(release, cache);
      signal.throwIfAborted();
      if (source() !== id)
        throw new Error('The selected computer changed. Check for updates again.');
      readySource = id;
      const localUpdate = release.build !== host.build;
      const studioUpdate = !!remote && info.build !== release.build;
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
      const localUpdate = host.build !== release.build;
      const studioUpdate = !!remote && info?.build !== release.build;
      state = { ...state, target: updateTarget(localUpdate, studioUpdate) };
      const unconfirmedStudioBuild = id ? unconfirmedStudioBuilds.get(id) : undefined;
      if (unconfirmedStudioBuild) {
        if (info?.build !== unconfirmedStudioBuild)
          throw new Error(
            'The previous Studio restart is not confirmed. Reconnect to Studio, then retry.'
          );
        unconfirmedStudioBuilds.delete(id!);
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
        remoteCommitted = true;
        unconfirmedStudioBuilds.set(id!, release.build);
        const result = await remote
          .commit({ lease: remoteLease }, { timeoutMs: 120000 })
          .catch(() => undefined);
        if (result && !result.accepted) {
          remoteCommitted = false;
          unconfirmedStudioBuilds.delete(id!);
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
            if (next.build === release.build) {
              confirmed = true;
              unconfirmedStudioBuilds.delete(id!);
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
    }
  }
  const checkNow = () => {
    if (!['ready', 'blocked', 'preparing', 'installing', 'downloading'].includes(state.status))
      start(check);
    return status();
  };
  const startup = setTimeout(checkNow, 30000);
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
      state = {
        ...state,
        status: 'idle',
        release: null,
        target: undefined,
        progress: 0,
        message: 'Computer changed. Check for updates again.',
      };
    },
    async dispose() {
      disposed = true;
      clearTimeout(startup);
      clearInterval(timer);
      abort.abort();
      await pending;
    },
  };
}

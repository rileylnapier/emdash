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
      state = {
        ...state,
        status: 'ready',
        progress: 100,
        message: 'Update ready. Restart when your team has finished its work.',
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
    state = { ...state, status: 'installing', message: 'Checking active work on both computers…' };
    let peer: UpdatePeer | undefined;
    let localLease: string | undefined;
    let remoteLease: string | undefined;
    let remoteCommitted = false;
    try {
      peer = id ? await openPeer(id, signal) : undefined;
      const remote = peer
        ? client(maintenanceContract, peer.connection, { pathPrefix: 'taixuUpdateV1' })
        : undefined;
      const info = remote ? await remote.info() : undefined;
      signal.throwIfAborted();
      localLease = await host.prepare(release.build);
      if (remote)
        remoteLease = await remote.prepare({ build: release.build }, { timeoutMs: 120000 });
      signal.throwIfAborted();
      if (remote && info?.build !== release.build) {
        state = { ...state, message: 'Restarting the Studio. Waiting for it to come back…' };
        // A lost reply can mean the Studio already quit. Never replay commit.
        remoteCommitted = true;
        const result = await remote
          .commit({ lease: remoteLease! }, { timeoutMs: 120000 })
          .catch(() => undefined);
        if (result && !result.accepted) {
          remoteCommitted = false;
          throw new Error(result.error ?? 'The Studio could not update.');
        }
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
            'The Studio has not confirmed its new build. This Mac was left running. Reopen Taixu on the Studio, then check for updates.'
          );
      } else if (remoteLease && remote) {
        await remote.cancel({ lease: remoteLease });
        remoteLease = undefined;
      }
      signal.throwIfAborted();
      state = {
        ...state,
        message: id ? 'Studio ready. Restarting this Mac’s Taixu…' : 'Restarting Taixu…',
      };
      await host.commit(localLease);
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
    if (!['ready', 'installing', 'downloading'].includes(state.status)) start(check);
    return status();
  };
  const startup = setTimeout(checkNow, 30000);
  const timer = setInterval(checkNow, 60 * 60 * 1000);
  return {
    status,
    check: checkNow,
    install() {
      if (state.status !== 'ready') throw new Error('Wait for the update to finish downloading.');
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

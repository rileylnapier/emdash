import { readFile, rename, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import {
  client,
  connect,
  createController,
  forwardController,
  streamTransport,
  type Controller,
  type Connection,
} from '@emdash/wire/rpc';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import { desktopWireContract } from '@core/manifests/shared/desktop-wire-contract';
import type { Hosts } from '@core/services/hosts/node/hosts';
import { studioControlContract, type StudioStatus } from '../api/studio-contract';
import { proxyStudioHttp } from './studio-http';
import { routeStudioDesktop, studioRoute } from './studio-routing';
import { serveStudioSocket, studioSocketPath } from './studio-socket';
import { createUpdateCoordinator } from './update-coordinator';
import { isUpdateHeld, acknowledgeUpdateHold } from './update-guard';
import type { createUpdateHost } from './update-host';

type RemoteSession = {
  id: string;
  abort: AbortController;
  connection?: Connection;
  channel?: Duplex;
  http?: Awaited<ReturnType<typeof proxyStudioHttp>>;
  gateway?: () => Promise<void>;
};

export async function createStudioService({
  ssh,
  hosts,
  local,
  userData,
  build,
  expose,
  updates,
}: {
  updates?: ReturnType<typeof createUpdateHost>;
  ssh: SshServiceHandle;
  hosts: Pick<Hosts, 'onInvalidate'>;
  local: Controller;
  userData: string;
  build: string;
  expose: (controller: Controller) => () => Promise<void>;
}) {
  const configFile = path.join(userData, 'taixu-studio.json');
  const socketPath = studioSocketPath(userInfo().username);
  let selected: string | null = null;
  let name: string | null = null;
  let sharing = false;
  let error: string | null = null;
  let remote: RemoteSession | undefined;
  let server: Awaited<ReturnType<typeof serveStudioSocket>> | undefined;
  let disposed = false;
  try {
    const saved = JSON.parse(await readFile(configFile, 'utf8'));
    selected = typeof saved.selected === 'string' ? saved.selected : null;
    name = typeof saved.name === 'string' ? saved.name : null;
    sharing = saved.sharing === true;
  } catch {
    /* First launch. */
  }
  async function save() {
    await writeFile(`${configFile}.tmp`, JSON.stringify({ selected, name, sharing }), {
      mode: 0o600,
    });
    await rename(`${configFile}.tmp`, configFile);
  }
  async function status(): Promise<StudioStatus> {
    return {
      selected,
      name,
      connected: !!remote?.gateway && !remote.abort.signal.aborted,
      sharing: !!server,
      socketPath,
      error,
      machines: (await ssh.machines.getMachines()).map(({ id, name }) => ({ id, name })),
    };
  }
  const updater = updates
    ? createUpdateCoordinator({
        host: updates,
        source: () => selected,
        async openPeer(id, signal) {
          signal.throwIfAborted();
          if (selected !== id) throw new Error('The selected computer changed.');
          signal.throwIfAborted();
          const proxy = ssh.manager.getProxy(id);
          if (!proxy?.isConnected) throw new Error('Connect to your Studio over SSH first.');
          const account = await proxy.exec(
            { command: 'id', args: ['-un'] },
            { signal, timeoutMs: 5000, maxStdoutBytes: 1024 }
          );
          if (account.exitCode !== 0 || !account.stdout.trim())
            throw new Error('Could not identify the Studio account.');
          const channel = await proxy.forwardOutStreamLocal(
            studioSocketPath(account.stdout.trim()),
            { signal, timeoutMs: 5000 }
          );
          const connection = connect(streamTransport(channel, channel), {
            callTimeoutMs: 10000,
            maxHeldCalls: 0,
          });
          const close = () => {
            connection.dispose();
            channel.destroy();
            signal.removeEventListener('abort', close);
          };
          signal.addEventListener('abort', close, { once: true });
          if (signal.aborted) {
            close();
            signal.throwIfAborted();
          }
          return { connection, close };
        },
      })
    : undefined;
  const unavailableUpdate = () => ({
    status: 'error' as const,
    hold: null,
    current: build,
    release: null,
    progress: 0,
    remote: !!selected,
    message: 'Install the latest Taixu app to enable updates.',
  });
  let retiring = Promise.resolve();
  function retire() {
    const previous = remote;
    remote = undefined;
    if (!previous) return retiring;
    previous.abort.abort();
    previous.connection?.dispose();
    previous.channel?.destroy();
    // Remove the old IPC handler before another session can expose the channel.
    const gateway = previous.gateway?.();
    retiring = Promise.all([retiring, previous.http?.dispose(), gateway]).then(() => {});
    return retiring;
  }
  // Reconnection is deliberate. Never replay task creation or send queued messages
  // to a replacement SSH identity, even if it kept the same machine record ID.
  const stopInvalidation = hosts.onInvalidate((event) => {
    if (event.connectionId === selected) {
      updater?.invalidate();
      error = 'The Studio connection changed. Reconnect to continue.';
      void retire();
    }
  });
  async function share(enabled: boolean) {
    if (enabled && !server) {
      if (!build) throw new Error('Reinstall Taixu to enable Studio connections.');
      if (process.platform === 'win32')
        throw new Error('Studio hosting currently requires macOS or Linux.');
      // Ordinary desktop clients cannot quit this app, open OS dialogs, or chain another desktop.
      // The separate maintenance protocol allows a guarded, explicit update restart.
      const shared: Controller = {
        call(method, input, meta) {
          if (studioRoute(method) !== 'remote')
            throw new Error('This method belongs to the client computer.');
          if (method === 'taixu.connect') input = {};
          return local.call(method, input, meta);
        },
        resolveLive(topic) {
          if (studioRoute(topic) !== 'remote') return null;
          return local.resolveLive(topic);
        },
        acquireLive(topic) {
          if (studioRoute(topic) !== 'remote') return null;
          return local.acquireLive(topic);
        },
      };
      server = await serveStudioSocket(shared, socketPath, build, updates?.controller);
    } else if (!enabled && server) {
      await server.dispose();
      server = undefined;
    }
    sharing = enabled;
    await save();
    return status();
  }
  async function attach(id: string) {
    await retire();
    if (!build) throw new Error('Reinstall Taixu to enable Studio connections.');
    const machine = (await ssh.machines.getMachines()).find((m) => m.id === id);
    if (!machine) throw new Error('Choose a saved SSH machine.');
    if (selected !== id) updater?.invalidate();
    selected = id;
    name = machine.name;
    error = null;
    await save();
    const session: RemoteSession = { id, abort: new AbortController() };
    remote = session;
    const current = () => {
      if (disposed || remote !== session || session.abort.signal.aborted)
        throw new Error('Studio connection was cancelled.');
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new Error('Studio connection was cancelled.'));
        session.abort.signal.addEventListener('abort', cancel, { once: true });
        void ssh.ssh
          .connect(id)
          .then(() => resolve(), reject)
          .finally(() => session.abort.signal.removeEventListener('abort', cancel));
      });
      current();
      const proxy = ssh.manager.getProxy(id);
      if (!proxy?.isConnected)
        throw new Error('SSH is unavailable. Check the saved machine connection.');
      // SSH aliases can override the saved username. Ask the authenticated host.
      const account = await proxy.exec(
        { command: 'id', args: ['-un'] },
        { signal: session.abort.signal, timeoutMs: 10000, maxStdoutBytes: 1024 }
      );
      current();
      if (account.exitCode !== 0 || !account.stdout.trim())
        throw new Error('Could not identify the Studio account.');
      session.channel = await proxy.forwardOutStreamLocal(studioSocketPath(account.stdout.trim()), {
        signal: session.abort.signal,
      });
      current();
      session.connection = connect(streamTransport(session.channel, session.channel), {
        callTimeoutMs: 30000,
        maxHeldCalls: 0,
      });
      session.connection.onDisconnect(() => {
        if (remote === session) {
          error = 'Connection to the Studio was lost. Reconnect to see its latest state.';
          void retire();
        }
      });
      await session.connection.call('studioHello', build, { timeoutMs: 10000 });
      current();
      const desktop = client(desktopWireContract, session.connection);
      const result = await desktop.taixu.connect({});
      if (!result.url) throw new Error(result.error ?? 'Taixu is unavailable on the Studio.');
      const remoteUrl = new URL(result.url);
      session.http = await proxyStudioHttp(
        result.url,
        (signal) => {
          current();
          return proxy.openTcpChannel(
            {
              sourceHost: '127.0.0.1',
              sourcePort: 0,
              remoteHost: '127.0.0.1',
              remotePort: Number(remoteUrl.port),
            },
            { signal }
          );
        },
        session.abort.signal
      );
      current();
      const forwarded = forwardController(desktopWireContract, desktop);
      const adapted: Controller = {
        ...forwarded,
        call(method, input, meta) {
          current();
          if (method === 'taixu.connect')
            return Promise.resolve({ url: session.http!.url, error: null });
          return forwarded.call(method, input, meta);
        },
      };
      session.gateway = expose(routeStudioDesktop(local, adapted));
    } catch (cause) {
      session.abort.abort();
      session.connection?.dispose();
      session.channel?.destroy();
      await session.http?.dispose();
      if (remote === session) {
        remote = undefined;
        error = cause instanceof Error ? cause.message : 'Could not connect to the Studio.';
      }
    }
    return status();
  }
  // Serialize configuration writes and mode changes. Disconnect still cancels
  // acquisition immediately, so a late SSH channel cannot become the new session.
  let queue = Promise.resolve<unknown>(undefined);
  const serial = <T>(run: () => Promise<T>) => {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
  const controller = createController(studioControlContract, {
    acknowledgeUpdate: ({ hold, error }) => acknowledgeUpdateHold(hold, error),
    updateStatus: () => updater?.status() ?? unavailableUpdate(),
    checkUpdate: () => updater?.check() ?? unavailableUpdate(),
    installUpdate: () => updater?.install() ?? unavailableUpdate(),
    status,
    connect: ({ id }) =>
      serial(() => {
        if (isUpdateHeld()) throw new Error('Wait for the update to finish before reconnecting.');
        return attach(id);
      }),
    share: ({ enabled }) =>
      serial(() => {
        if (isUpdateHeld())
          throw new Error('Wait for the update to finish before changing Studio sharing.');
        return share(enabled);
      }),
    disconnect: () => {
      if (isUpdateHeld())
        throw new Error('Wait for the update to finish before switching computers.');
      updater?.invalidate();
      void retire();
      return serial(async () => {
        await retire();
        updater?.invalidate();
        selected = null;
        name = null;
        error = null;
        await save();
        return status();
      });
    },
  });
  if (sharing)
    await share(true).catch(() => {
      error = 'Could not enable Studio sharing. Another Taixu may already be sharing.';
    });
  return {
    controller,
    async dispose() {
      disposed = true;
      remote?.abort.abort();
      stopInvalidation();
      await updater?.dispose();
      await updates?.dispose();
      await queue;
      await retire();
      await server?.dispose();
    },
  };
}

import { once } from 'node:events';
import { mkdtemp, lstat, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { connect, streamTransport, type Controller } from '@emdash/wire/rpc';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import { studioControlContract } from '../api/studio-contract';
import { proxyStudioHttp } from './studio-http';
import { routeStudioDesktop } from './studio-routing';
import { createStudioService } from './studio-service';
import { serveStudioSocket } from './studio-socket';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function folder() {
  // Short path: macOS UNIX socket paths are limited to 104 bytes.
  const root = await mkdtemp('/tmp/tx-test-');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const controller = (call: Controller['call']): Controller => ({
  call,
  resolveLive: () => null,
  acquireLive: () => null,
});
async function peer(socketPath: string) {
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  const connection = connect(streamTransport(socket, socket), {
    callTimeoutMs: 2000,
    maxHeldCalls: 0,
  });
  cleanups.push(async () => {
    connection.dispose();
    socket.destroy();
  });
  return connection;
}
async function origin() {
  const requests: { url?: string; origin?: string; body: string }[] = [];
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    requests.push({ url: req.url, origin: req.headers.origin, body });
    if (req.url?.endsWith('events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      return;
    }
    res.end(JSON.stringify({ body, origin: req.headers.origin }));
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as net.AddressInfo).port;
  return { port, requests, url: `http://127.0.0.1:${port}/${'a'.repeat(64)}/?desktop=1` };
}

it('private socket requires a matching build and does not replace an active listener', async () => {
  const socketPath = path.join(await folder(), 'desktop.sock');
  const calls = vi.fn(async () => 'shared-project-id');
  const server = await serveStudioSocket(controller(calls), socketPath, 'build-one');
  cleanups.push(() => server.dispose());
  expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
  const c = await peer(socketPath);
  await expect(c.call('projects.list', undefined)).rejects.toThrow(/same Taixu build/);
  await expect(c.call('studioHello', 'build-two')).rejects.toThrow(/same Taixu build/);
  expect(calls).not.toHaveBeenCalled();
  await c.call('studioHello', 'build-one');
  expect(await c.call('projects.list', undefined)).toBe('shared-project-id');
  await expect(serveStudioSocket(controller(calls), socketPath, 'build-one')).rejects.toThrow(
    /already sharing/
  );
  expect(await c.call('projects.list', undefined)).toBe('shared-project-id');
});

it('refuses symlinked socket parents and non-private sharing directories', async () => {
  const root = await folder();
  await mkdir(path.join(root, 'public'), { mode: 0o755 });
  await expect(
    serveStudioSocket(
      controller(async () => null),
      path.join(root, 'public/sock'),
      'x'
    )
  ).rejects.toThrow(/private/);
  await symlink(root, path.join(root, 'alias'));
  await expect(
    serveStudioSocket(
      controller(async () => null),
      path.join(root, 'alias/sock'),
      'x'
    )
  ).rejects.toThrow(/private/);
});

it('HTTP proxy rewrites same-origin posts, streams SSE, rejects foreign requests, and closes on disconnect', async () => {
  const remote = await origin();
  const abort = new AbortController();
  const open = vi.fn(async () => net.createConnection(remote.port, '127.0.0.1'));
  const proxy = await proxyStudioHttp(remote.url, open, abort.signal);
  cleanups.push(() => proxy.dispose());
  const local = new URL(proxy.url);
  const response = await fetch(new URL('api/talk', local), {
    method: 'POST',
    headers: { Origin: local.origin },
    body: 'hello',
  });
  expect(await response.json()).toEqual({ body: 'hello', origin: new URL(remote.url).origin });
  const count = open.mock.calls.length;
  expect(
    (await fetch(new URL('api/talk', local), { headers: { Origin: 'https://other.example' } }))
      .status
  ).toBe(403);
  expect((await fetch(new URL('/wrong/api/talk', local))).status).toBe(403);
  expect(open).toHaveBeenCalledTimes(count);
  const stream = await fetch(new URL('events', local));
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first');
  abort.abort();
  expect(await reader.read().catch(() => ({ done: true }))).toMatchObject({ done: true });
  expect((await fetch(proxy.url)).status).toBe(503);
});

it('keeps window controls local and task calls remote without fallback', async () => {
  const local = vi.fn(async () => 'local');
  const remote = vi.fn(async () => 'studio');
  const routed = routeStudioDesktop(controller(local), controller(remote));
  const wire = await peerForController(routed);
  expect(await wire.call('host.quit', undefined)).toBe('local');
  expect(await wire.call('tasks.getTasks', undefined)).toBe('studio');
  await expect(wire.call('host.openDirectory', undefined)).rejects.toThrow(/Studio window/);
  remote.mockRejectedValueOnce(new Error('disconnected'));
  await expect(wire.call('tasks.create', {})).rejects.toThrow(/disconnected/);
  expect(local).toHaveBeenCalledTimes(1);
});

async function peerForController(c: Controller) {
  const socketPath = path.join(await folder(), 'desktop.sock');
  const server = await serveStudioSocket(c, socketPath, 'test');
  cleanups.push(() => server.dispose());
  const wire = await peer(socketPath);
  await wire.call('studioHello', 'test');
  return wire;
}

it('persists local server mode without forwarding calls or changing sharing', async () => {
  const root = await folder();
  const local = vi.fn(async () => null);
  const applyServerMode = vi.fn();
  const ssh = { machines: { getMachines: async () => [] } } as unknown as SshServiceHandle;
  const options = {
    ssh,
    hosts: { onInvalidate: () => () => {} },
    local: controller(local),
    userData: root,
    build: 'test',
    expose: vi.fn(() => async () => {}),
    applyServerMode,
  };
  await writeFile(
    path.join(root, 'taixu-studio.json'),
    JSON.stringify({ selected: null, sharing: false })
  );
  const service = await createStudioService(options);
  const wire = createTestWire(studioControlContract, service.controller);
  cleanups.push(
    () => service.dispose(),
    () => wire.dispose()
  );
  expect(await wire.client.status()).toMatchObject({ serverMode: false, sharing: false });
  await wire.client.setServerMode({ enabled: true });
  expect(applyServerMode).toHaveBeenLastCalledWith(true);
  expect(await wire.client.status()).toMatchObject({ serverMode: true, sharing: false });
  await expect(wire.client.connect({ id: 'other' })).rejects.toThrow(/Open Taixu/);
  const reopened = await createStudioService(options);
  const restored = createTestWire(studioControlContract, reopened.controller);
  cleanups.push(
    () => reopened.dispose(),
    () => restored.dispose()
  );
  expect(await restored.client.status()).toMatchObject({ serverMode: true, sharing: false });
  await restored.client.setServerMode({ enabled: false });
  expect(JSON.parse(await readFile(path.join(root, 'taixu-studio.json'), 'utf8'))).toMatchObject({
    serverMode: false,
    sharing: false,
    selected: null,
  });
  expect(local).not.toHaveBeenCalled();
  expect(options.expose).not.toHaveBeenCalled();
});

it('does not change the window or preference after a failed server-mode save', async () => {
  const root = await folder();
  const applyServerMode = vi.fn();
  const service = await createStudioService({
    ssh: { machines: { getMachines: async () => [] } } as unknown as SshServiceHandle,
    hosts: { onInvalidate: () => () => {} },
    local: controller(async () => null),
    userData: root,
    build: 'test',
    expose: () => async () => {},
    applyServerMode,
  });
  const wire = createTestWire(studioControlContract, service.controller);
  cleanups.push(
    () => service.dispose(),
    () => wire.dispose()
  );
  await mkdir(path.join(root, 'taixu-studio.json.tmp'));
  await expect(wire.client.setServerMode({ enabled: true })).rejects.toThrow();
  expect(await wire.client.status()).toMatchObject({ serverMode: false });
  expect(applyServerMode).toHaveBeenCalledExactlyOnceWith(false);
});

it('shares Studio IDs and HTTP, fences identity changes, reconnects, and returns explicitly to local', async () => {
  const root = await folder();
  const remoteHttp = await origin();
  const socketPath = path.join(root, 'desktop.sock');
  const remoteCall = vi.fn(async (method: string) =>
    method === 'taixu.connect' ? { url: remoteHttp.url, error: null } : true
  );
  const server = await serveStudioSocket(controller(remoteCall), socketPath, 'test');
  cleanups.push(() => server.dispose());
  const proxy = {
    isConnected: true,
    exec: vi.fn(async () => ({ stdout: 'studio-account\n', stderr: '', exitCode: 0 })),
    forwardOutStreamLocal: vi.fn(async () => {
      const socket = net.createConnection(socketPath);
      await once(socket, 'connect');
      return socket;
    }),
    openTcpChannel: vi.fn(async () => net.createConnection(remoteHttp.port, '127.0.0.1')),
  };
  const ssh = {
    ssh: { connect: vi.fn(async () => {}) },
    machines: {
      getMachines: async () => [{ id: 'studio', name: 'My Studio', username: 'alias-user' }],
    },
    manager: { getProxy: () => proxy },
  } as unknown as SshServiceHandle;
  let invalidate:
    | ((event: { connectionId: string; reason: 'machine-mutation' }) => void)
    | undefined;
  let gateway: Controller | undefined;
  const removed = vi.fn(async () => {
    gateway = undefined;
  });
  const service = await createStudioService({
    ssh,
    hosts: {
      onInvalidate: (cb) => {
        invalidate = cb;
        return () => {};
      },
    },
    local: controller(async () => 'local'),
    userData: root,
    build: 'test',
    expose: (c) => {
      gateway = c;
      return removed;
    },
  });
  cleanups.push(() => service.dispose());
  const wire = createTestWire(studioControlContract, service.controller);
  cleanups.push(() => wire.dispose());
  expect(await wire.client.connect({ id: 'studio' })).toMatchObject({
    connected: true,
    selected: 'studio',
  });
  expect(proxy.exec).toHaveBeenCalledWith({ command: 'id', args: ['-un'] }, expect.anything());
  const desktop = await peerForController(gateway!);
  const result = (await desktop.call('taixu.connect', {})) as { url: string };
  expect(new URL(result.url).port).not.toBe(String(remoteHttp.port));
  expect((await fetch(result.url)).status).toBe(200);
  await desktop.call('taixu.projectExists', { projectId: 'shared-project-id' });
  expect(remoteCall).toHaveBeenCalledWith(
    'taixu.projectExists',
    { projectId: 'shared-project-id' },
    expect.anything()
  );
  invalidate!({ connectionId: 'studio', reason: 'machine-mutation' });
  expect(await wire.client.status()).toMatchObject({ connected: false, selected: 'studio' });
  await expect(
    desktop.call('taixu.projectExists', { projectId: 'shared-project-id' })
  ).rejects.toThrow();
  expect(await wire.client.connect({ id: 'studio' })).toMatchObject({ connected: true });
  expect(removed).toHaveBeenCalledTimes(1);
  expect(await wire.client.disconnect()).toMatchObject({ selected: null, connected: false });
  expect(
    JSON.parse(await readFile(path.join(root, 'taixu-studio.json'), 'utf8')).selected
  ).toBeNull();
});

it('cancels a pending SSH connection without waiting or exposing a late gateway', async () => {
  const root = await folder();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const connectSsh = vi.fn(() => pending);
  const expose = vi.fn(() => async () => {});
  const ssh = {
    ssh: { connect: connectSsh },
    machines: { getMachines: async () => [{ id: 's', name: 'Studio' }] },
  } as unknown as SshServiceHandle;
  const service = await createStudioService({
    ssh,
    hosts: { onInvalidate: () => () => {} },
    local: controller(async () => null),
    userData: root,
    build: 'test',
    expose,
  });
  cleanups.push(() => service.dispose());
  const wire = createTestWire(studioControlContract, service.controller);
  cleanups.push(() => wire.dispose());
  const connecting = wire.client.connect({ id: 's' });
  await vi.waitFor(() => expect(connectSsh).toHaveBeenCalled());
  expect(await wire.client.disconnect()).toMatchObject({ selected: null });
  complete();
  await connecting;
  expect(expose).not.toHaveBeenCalled();
});

it('allows versioned update maintenance across a build mismatch while keeping desktop calls gated', async () => {
  const socketPath = path.join(await folder(), 'desktop.sock');
  const desktop = vi.fn(async () => 'desktop');
  const maintenance = vi.fn(async () => ({ build: 'new', release: null }));
  const server = await serveStudioSocket(
    controller(desktop),
    socketPath,
    'new',
    controller(maintenance)
  );
  cleanups.push(() => server.dispose());
  const connection = await peer(socketPath);
  await expect(connection.call('studioHello', 'old')).rejects.toThrow(/same Taixu build/);
  expect(await connection.call('taixuUpdateV1.info', undefined)).toEqual({
    build: 'new',
    release: null,
  });
  expect(maintenance).toHaveBeenCalledWith('info', undefined, expect.anything());
  await expect(connection.call('tasks.create', {})).rejects.toThrow(/same Taixu build/);
  expect(desktop).not.toHaveBeenCalled();
});

it('reopens the saved Studio with the matching build after laptop replacement while Studio work continues', async () => {
  const root = await folder();
  const remoteHttp = await origin();
  const socketPath = path.join(root, 'desktop.sock');
  // Simulated backend-owned work: no provider, model or child process is invoked.
  const task = { id: 'studio-task', status: 'working', ticks: 0 };
  const running = setInterval(() => {
    task.ticks++;
  }, 10);
  cleanups.push(async () => clearInterval(running));
  const remoteCall = vi.fn(async (method: string) => {
    if (method === 'taixu.connect') return { url: remoteHttp.url, error: null };
    if (method === 'taixu.taskExists') return task.status === 'working';
    throw new Error(`Unexpected backend mutation: ${method}`);
  });
  const server = await serveStudioSocket(controller(remoteCall), socketPath, 'target-build');
  cleanups.push(() => server.dispose());
  const proxy = {
    isConnected: true,
    exec: vi.fn(async () => ({ stdout: 'studio-account\n', stderr: '', exitCode: 0 })),
    forwardOutStreamLocal: vi.fn(async () => {
      const socket = net.createConnection(socketPath);
      await once(socket, 'connect');
      return socket;
    }),
    openTcpChannel: vi.fn(async () => net.createConnection(remoteHttp.port, '127.0.0.1')),
  };
  const ssh = {
    ssh: { connect: vi.fn(async () => {}) },
    machines: { getMachines: async () => [{ id: 'studio', name: 'My Studio' }] },
    manager: { getProxy: () => proxy },
  } as unknown as SshServiceHandle;
  let gateway: Controller | undefined;
  async function laptop(build: string) {
    const service = await createStudioService({
      ssh,
      hosts: { onInvalidate: () => () => {} },
      local: controller(async () => 'local'),
      userData: root,
      build,
      expose: (c) => {
        gateway = c;
        return async () => {
          gateway = undefined;
        };
      },
    });
    const wire = createTestWire(studioControlContract, service.controller);
    cleanups.push(() => service.dispose());
    cleanups.push(() => wire.dispose());
    return { service, wire };
  }
  const old = await laptop('old-build');
  expect(await old.wire.client.connect({ id: 'studio' })).toMatchObject({
    selected: 'studio',
    connected: false,
    error: expect.stringContaining('same Taixu build'),
  });
  expect(gateway).toBeUndefined();
  const saved = await readFile(path.join(root, 'taixu-studio.json'), 'utf8');
  await old.service.dispose();
  expect(await readFile(path.join(root, 'taixu-studio.json'), 'utf8')).toBe(saved);
  const tick = task.ticks;
  await vi.waitFor(() => expect(task.ticks).toBeGreaterThan(tick));
  const updated = await laptop('target-build');
  expect(await updated.wire.client.status()).toMatchObject({
    selected: 'studio',
    connected: false,
    error: null,
  });
  expect(await updated.wire.client.connect({ id: 'studio' })).toMatchObject({
    selected: 'studio',
    connected: true,
  });
  const desktop = await peerForController(gateway!);
  expect(await desktop.call('taixu.taskExists', { projectId: 'project', taskId: task.id })).toBe(
    true
  );
  expect(task.status).toBe('working');
  expect(remoteCall.mock.calls.map(([method]) => method)).toEqual([
    'taixu.connect',
    'taixu.taskExists',
  ]);
  expect(await readFile(path.join(root, 'taixu-studio.json'), 'utf8')).toBe(saved);
});

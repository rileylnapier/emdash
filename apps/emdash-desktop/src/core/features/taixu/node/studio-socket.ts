import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';
import { createWireSessionHub, streamTransport, type Controller } from '@emdash/wire/rpc';
import { UPDATE_PREFIX } from '../api/update-contract';

export function studioSocketPath(username: string) {
  return `/tmp/taixu-${createHash('sha256').update(username).digest('hex').slice(0, 20)}/desktop.sock`;
}

export async function serveStudioSocket(
  controller: Controller,
  socketPath: string,
  build: string,
  updates?: Controller
) {
  const dir = path.dirname(socketPath);
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const parent = await lstat(dir);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error('Taixu sharing folder must be private and owned by this account.');
  const old = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (old) {
    if (!old.isSocket() || old.uid !== process.getuid?.())
      throw new Error('Unsafe Taixu sharing socket.');
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.setTimeout(1000);
      probe.once('connect', () => {
        probe.destroy();
        reject(new Error('Another Taixu is already sharing from this account.'));
      });
      probe.once('timeout', () => {
        probe.destroy();
        reject(new Error('Taixu sharing socket is busy.'));
      });
      probe.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
        else reject(error);
      });
    });
    const now = await lstat(socketPath);
    if (now.ino !== old.ino) throw new Error('Taixu sharing socket changed.');
    await unlink(socketPath);
  }
  const hubs = new Set<ReturnType<typeof createWireSessionHub>>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let verified = false;
    const requireHandshake = () => {
      if (!verified) throw new Error('Connect with the same Taixu build on both Macs.');
    };
    const hub = createWireSessionHub({
      async call(method, input, meta) {
        if (updates && method.startsWith(UPDATE_PREFIX))
          return updates.call(method.slice(UPDATE_PREFIX.length), input, meta);
        if (method === 'studioHello') {
          if (input !== build) throw new Error('Install the same Taixu build on both Macs.');
          verified = true;
          return build;
        }
        requireHandshake();
        return controller.call(method, input, meta);
      },
      resolveLive(topic) {
        requireHandshake();
        return controller.resolveLive(topic);
      },
      acquireLive(topic) {
        requireHandshake();
        return controller.acquireLive(topic);
      },
    });
    hubs.add(hub);
    hub.open(randomUUID(), streamTransport(socket, socket));
    socket.once('close', () => {
      sockets.delete(socket);
      hubs.delete(hub);
      void hub.dispose();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const owned = await lstat(socketPath);
  return {
    async dispose() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([...hubs].map((hub) => hub.dispose()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const current = await lstat(socketPath).catch(() => null);
      if (current?.ino === owned.ino) await unlink(socketPath);
    },
  };
}

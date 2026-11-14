import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  client,
  connect,
  createController,
  defineContract,
  procedure,
  streamTransport,
} from '@emdash/wire/rpc';
import { Client, Server, type Connection } from 'ssh2';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { SshClientProxy } from '@core/services/ssh/node/lifecycle/ssh-client-proxy';
import { proxyStudioHttp } from './studio-http';
import { serveStudioSocket } from './studio-socket';

it('carries desktop calls and a streamed HTTP reply through real SSH streamlocal and TCP channels', async () => {
  const root = await mkdtemp('/tmp/tx-ssh-');
  const socketPath = path.join(root, 'desktop.sock');
  const contract = defineContract({ project: procedure({ input: z.void(), output: z.string() }) });
  const backend = await serveStudioSocket(
    createController(contract, { project: () => 'studio-project-id' }),
    socketPath,
    'same-build'
  );
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: from Studio\n\n');
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const port = (origin.address() as net.AddressInfo).port;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const sshServer = new Server({ hostKeys: [privateKey] });
  const destinations = new Set<net.Socket>();
  const accepted = new Set<Connection>();
  sshServer.on('connection', (c) => {
    accepted.add(c);
    c.on('error', () => {});
    c.on('close', () => accepted.delete(c));
    c.on('authentication', (a) => a.accept());
    c.on('ready', () => {
      c.on('openssh.streamlocal', (accept, reject, info) => {
        if (info.socketPath !== socketPath) {
          reject();
          return;
        }
        const target = net.createConnection(socketPath);
        destinations.add(target);
        target.once('connect', () => {
          const stream = accept();
          target.pipe(stream).pipe(target);
        });
      });
      c.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' || info.destPort !== port) {
          reject();
          return;
        }
        const target = net.createConnection(port, '127.0.0.1');
        destinations.add(target);
        target.once('connect', () => {
          const stream = accept();
          target.pipe(stream).pipe(target);
        });
      });
    });
  });
  sshServer.listen(0, '127.0.0.1');
  await once(sshServer, 'listening');
  const sshClient = new Client();
  const abort = new AbortController();
  let gateway: Awaited<ReturnType<typeof proxyStudioHttp>> | undefined;
  let wire: ReturnType<typeof connect> | undefined;
  try {
    sshClient.connect({
      host: '127.0.0.1',
      port: (sshServer.address() as net.AddressInfo).port,
      username: 'qa',
      password: 'qa',
    });
    await once(sshClient, 'ready');
    const ssh = new SshClientProxy('qa');
    ssh.update(sshClient);
    const channel = await ssh.forwardOutStreamLocal(socketPath);
    wire = connect(streamTransport(channel, channel), { callTimeoutMs: 2000, maxHeldCalls: 0 });
    await wire.call('studioHello', 'same-build');
    expect(await client(contract, wire).project()).toBe('studio-project-id');
    gateway = await proxyStudioHttp(
      `http://127.0.0.1:${port}/${'a'.repeat(64)}/?desktop=1`,
      (signal) =>
        ssh.openTcpChannel(
          { sourceHost: '127.0.0.1', sourcePort: 0, remoteHost: '127.0.0.1', remotePort: port },
          { signal }
        ),
      abort.signal
    );
    const response = await fetch(gateway.url);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('from Studio');
    await reader.cancel();
    const disconnected = new Promise<void>((resolve) => wire!.onDisconnect(resolve));
    sshClient.destroy();
    await disconnected;
    await expect(client(contract, wire).project()).rejects.toThrow();
  } finally {
    abort.abort();
    wire?.dispose();
    sshClient.destroy();
    for (const c of accepted) c.end();
    for (const socket of destinations) socket.destroy();
    await gateway?.dispose();
    await backend.dispose();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await new Promise<void>((resolve) => sshServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

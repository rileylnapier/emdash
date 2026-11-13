import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScope } from '@emdash/shared/concurrency';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Project } from '@core/primitives/projects/api';
import { taixuContract } from '../api/contract';
import { createTaixuWireController } from './wire-controller';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  getPath: vi.fn(),
  choose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    isPackaged: true,
    on: mocks.on,
    removeListener: mocks.removeListener,
  },
  dialog: { showOpenDialog: mocks.choose },
  utilityProcess: { fork: mocks.fork },
}));
class Worker extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => {
    this.emit('exit', 0);
    return true;
  });
}
const url = `http://127.0.0.1:32123/${'a'.repeat(64)}/?desktop=1`;
let root: string;
let scope: ReturnType<typeof createScope>;
let wire: ReturnType<typeof createTestWire<typeof taixuContract>>;
let worker: Worker;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), 'taixu-host-test-'));
  for (const file of [
    'apps/taixu/server/desktop.mjs',
    'apps/taixu/dist/index.html',
    'packages/wuwei/projects.json',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '');
  }
  vi.stubEnv('TAIXU_ROOT', root);
  mocks.getPath.mockReturnValue(root);
  worker = new Worker();
  mocks.fork.mockImplementation(() => {
    setTimeout(() => worker.emit('message', { type: 'ready', url }), 1);
    return worker;
  });
  scope = createScope();
  wire = createTestWire(
    taixuContract,
    createTaixuWireController({
      scope,
      readProjects: async () => [
        {
          id: 'project',
          name: 'Example',
          type: 'local',
          path: '/example',
          secret: 'do not cross',
        } as unknown as Project,
      ],
      readConversations: async () => [
        {
          id: 'conversation',
          projectId: 'project',
          taskId: 'task',
          providerId: 'claude',
          agentStatus: 'working',
          title: 'private transcript',
        } as Conversation,
      ],
      taskService: { getTasks: async () => [] },
    })
  );
});
afterEach(async () => {
  await wire.dispose();
  await scope.dispose();
  worker.emit('exit', 0);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it('shares a single utility process and sends status metadata only', async () => {
  const connections = await Promise.all([wire.client.connect({}), wire.client.connect({})]);
  expect(connections).toEqual([
    { url, error: null },
    { url, error: null },
  ]);
  expect(mocks.fork).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
  const snapshot = worker.postMessage.mock.calls[0][0];
  expect(snapshot.snapshot.conversations[0].agentStatus).toBe('working');
  expect(JSON.stringify(snapshot)).not.toMatch(/do not cross|private transcript/);
  expect(await wire.client.status({})).toEqual({ running: true });
});
it('reports worker failure and allows a fresh connection', async () => {
  await wire.client.connect({});
  worker.emit('exit', 1);
  expect(await wire.client.status({})).toEqual({ running: false });
  worker = new Worker();
  expect(await wire.client.connect({})).toEqual({ url, error: null });
  expect(mocks.fork).toHaveBeenCalledTimes(2);
});
it('does not start a worker for an unbuilt folder', async () => {
  await rm(path.join(root, 'apps/taixu/dist/index.html'));
  expect((await wire.client.connect({})).error).toMatch(/built Taixu/);
  expect(mocks.fork).not.toHaveBeenCalled();
});
it('rejects invalid ready URLs and reports a worker that exits during launch', async () => {
  mocks.fork.mockImplementation(() => {
    setTimeout(() => {
      worker.emit('message', { type: 'ready', url: 'https://example.com' });
      worker.emit('exit', 1);
    }, 1);
    return worker;
  });
  expect((await wire.client.connect({})).url).toBeNull();
  expect(await wire.client.taskExists({ projectId: 'project', taskId: 'unknown' })).toBe(false);
});
it('stops the worker when its owner closes', async () => {
  await wire.client.connect({});
  await scope.dispose();
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'stop' });
  expect(await wire.client.status({})).toEqual({ running: false });
});

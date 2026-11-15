import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScope } from '@emdash/shared/concurrency';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@core/primitives/agents/api/agent-events';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Project } from '@core/primitives/projects/api';
import { taixuContract } from '../api/contract';
import type { MergeApproval, MergeReceiptInput } from '../api/contract';
import { createTaixuWireController } from './wire-controller';
import { WorkFollowupUnavailable } from './work-followup';

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  getPath: vi.fn(),
  choose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  resolveProvider: vi.fn(),
  getTasks: vi.fn(),
  prepareFollowup: vi.fn(),
  readWorkReply: vi.fn(),
  readWorkImageContext: vi.fn(),
  reviewMerge: vi.fn(),
  observeWork: vi.fn(),
  approveMerge: vi.fn(),
  updateGuard: vi.fn(),
  archiveWork: vi.fn(),
  restoreWork: vi.fn(),
}));
vi.mock('./update-guard', () => ({
  registerHeadUpdateGuard: (guard: (hold: boolean) => Promise<void>) => {
    mocks.updateGuard.mockImplementation(guard);
    return () => {};
  },
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
let agentEvent: (event: AgentEvent) => Promise<void>;
const taskId = '11111111-1111-4111-8111-111111111111';
const followup = {
  taskId,
  projectId: 'project',
  conversationId: '22222222-2222-4222-8222-222222222222',
  requestId: '33333333-3333-4333-8333-333333333333',
  text: 'Smaller roofs',
};
async function linkedWork() {
  mocks.getTasks.mockResolvedValue([{ id: taskId, projectId: 'project' }]);
  await wire.client.connect({});
  worker.emit('message', { type: 'ready', url, workTargets: [{ taskId, projectId: 'project' }] });
  const receipts = new Map<string, string>();
  worker.postMessage.mockImplementation((message) => {
    if (message.type !== 'work-followup') return;
    const existing = receipts.get(message.input.requestId);
    const status = existing && existing !== 'pending' ? existing : message.input.status;
    receipts.set(message.input.requestId, status);
    queueMicrotask(() =>
      worker.emit('message', {
        type: 'work-followup-result',
        id: message.id,
        status,
        created: !existing,
      })
    );
  });
  return receipts;
}

it('persists intent before submission and sends concurrent repeated requests only once', async () => {
  const receipts = await linkedWork();
  const send = vi.fn(async () => {
    expect(receipts.get(followup.requestId)).toBe('pending');
  });
  mocks.prepareFollowup.mockResolvedValue(send);
  const results = await Promise.all([
    wire.client.followupWork(followup),
    wire.client.followupWork(followup),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['sent', 'unknown']);
  expect(send).toHaveBeenCalledTimes(1);
  mocks.prepareFollowup.mockRejectedValue(new WorkFollowupUnavailable('Agent now busy'));
  expect((await wire.client.followupWork(followup)).status).toBe('sent');
  expect(mocks.prepareFollowup).toHaveBeenCalledTimes(1);
});

it.each([
  [new WorkFollowupUnavailable('Agent needs permission'), 'failed'],
  [new Error('Connection lost'), 'unknown'],
] as const)(
  'records a readiness refusal or uncertain delivery without replaying it',
  async (error, status) => {
    const receipts = await linkedWork();
    const send = vi.fn(async () => {
      throw error;
    });
    mocks.prepareFollowup.mockResolvedValue(send);
    expect((await wire.client.followupWork(followup)).status).toBe(status);
    expect(receipts.get(followup.requestId)).toBe(status);
    expect((await wire.client.followupWork(followup)).status).toBe(status);
    expect(send).toHaveBeenCalledTimes(1);
  }
);

it('never sends if the pending receipt cannot be saved', async () => {
  await linkedWork();
  const send = vi.fn();
  mocks.prepareFollowup.mockResolvedValue(send);
  worker.postMessage.mockImplementation((message) => {
    if (message.type === 'work-followup')
      queueMicrotask(() =>
        worker.emit('message', {
          type: 'work-followup-result',
          id: message.id,
          error: 'Disk unavailable',
        })
      );
  });
  await expect(wire.client.followupWork(followup)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

it('delivers a native final reply to the linked Head without reading another transcript', async () => {
  await linkedWork();
  mocks.readWorkReply.mockResolvedValue('A stale reply that must not be used');
  const event: AgentEvent = {
    ...followup,
    providerId: 'codex',
    type: 'stop',
    timestamp: Date.now(),
    payload: {
      lastAssistantMessage: 'Built it.\n\n[PR](https://example.com/pr/1)',
      message: 'Finished',
    },
  };
  await agentEvent(event);
  const report = worker.postMessage.mock.calls.find(([m]) => m.type === 'work-event')?.[0];
  expect(report.event).toMatchObject({
    conversationId: followup.conversationId,
    taskId,
    projectId: 'project',
    providerId: 'codex',
    payload: { lastAssistantMessage: event.payload.lastAssistantMessage },
  });
  expect(mocks.readWorkReply).not.toHaveBeenCalled();
  worker.emit('message', { type: 'work-recorded', id: report.id });
});

it('restores linked targets on reconnect and persists only their bounded attributed reports', async () => {
  await linkedWork();
  mocks.readWorkReply.mockResolvedValue('A'.repeat(26000));
  const event: AgentEvent = {
    ...followup,
    providerId: 'codex',
    type: 'stop',
    timestamp: Date.now(),
    payload: {},
  };
  await agentEvent({ ...event, taskId: 'unlinked' });
  expect(mocks.readWorkReply).not.toHaveBeenCalled();
  await agentEvent(event);
  const report = worker.postMessage.mock.calls.find(([m]) => m.type === 'work-event')?.[0];
  expect(report.event.payload.lastAssistantMessage).toHaveLength(24000);
  expect(report.event.conversationId).toBe(followup.conversationId);
  worker.emit('message', { type: 'work-recorded', id: report.id });
  worker.emit('exit', 1);
  worker = new Worker();
  await wire.client.connect({});
  worker.emit('message', { type: 'ready', url, workTargets: [{ taskId, projectId: 'project' }] });
  await agentEvent({ ...event, timestamp: event.timestamp + 1 });
  expect(worker.postMessage.mock.calls.filter(([m]) => m.type === 'work-event')).toHaveLength(1);
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.resolveProvider.mockResolvedValue({
    bin: '/configured/codex',
    env: { OPENAI_API_KEY: 'private-key', NODE_OPTIONS: 'must-not-pass' },
  });
  mocks.getTasks.mockResolvedValue([]);
  mocks.readWorkImageContext.mockResolvedValue(null);
  mocks.observeWork.mockImplementation(async (target) => ({
    ...target,
    status: 'open',
    url: 'https://github.com/example/repo/pull/1',
    at: new Date().toISOString(),
  }));
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
      resolveProvider: mocks.resolveProvider,
      readProjects: async () => [
        {
          id: 'project',
          name: 'Example',
          type: 'local',
          path: root,
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
      taskService: { getTasks: mocks.getTasks },
      prepareFollowup: mocks.prepareFollowup,
      readWorkReply: mocks.readWorkReply,
      readWorkImageContext: mocks.readWorkImageContext,
      archiveWork: Object.assign(mocks.archiveWork, { restore: mocks.restoreWork }),
      workMerge: {
        review: mocks.reviewMerge,
        approve: mocks.approveMerge,
        observe: mocks.observeWork,
      },
      onAgentEvent: (listener) => {
        agentEvent = listener;
        return () => {};
      },
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
  expect(snapshot.snapshot.providers.map((p: { id: string }) => p.id).sort()).toEqual([
    'claude',
    'codex',
  ]);
  expect(snapshot.snapshot.providers.every((p: { models: unknown[] }) => p.models.length > 0)).toBe(
    true
  );
  expect(await wire.client.status({})).toEqual({ running: true });
});
it('resolves launch settings over the private worker channel, separately from renderer data', async () => {
  await wire.client.connect({});
  worker.emit('message', { type: 'provider-request', id: '1', provider: 'codex' });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'provider-response', id: '1' })
    )
  );
  const response = worker.postMessage.mock.calls.find(([m]) => m.type === 'provider-response')?.[0];
  expect(response.context.bin).toBe('/configured/codex');
  expect(response.context.env.OPENAI_API_KEY).toBe('private-key');
  expect(response.context.env.NODE_OPTIONS).toBeUndefined();
  expect(
    JSON.stringify(worker.postMessage.mock.calls.filter(([m]) => m.type === 'snapshot'))
  ).not.toContain('private-key');
  worker.emit('message', { type: 'provider-request', id: '2', provider: 'arbitrary-command' });
  expect(mocks.resolveProvider).toHaveBeenCalledTimes(1);
  mocks.resolveProvider.mockRejectedValue(new Error('sensitive error'));
  worker.emit('message', { type: 'provider-request', id: '3', provider: 'claude' });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'provider-response', id: '3', error: expect.any(String) })
    )
  );
  expect(JSON.stringify(worker.postMessage.mock.calls)).not.toContain('sensitive error');
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

it('reads docs only for registered project IDs over the private channel', async () => {
  await writeFile(path.join(root, 'README.md'), '# Example product');
  await wire.client.connect({});
  worker.emit('message', { type: 'documents-request', id: 'docs', projectId: 'project' });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'documents-response',
        id: 'docs',
        evidence: expect.any(Object),
      })
    )
  );
  const result = worker.postMessage.mock.calls.find(([m]) => m.type === 'documents-response')?.[0];
  expect(result.evidence.candidates[0].documents[0].text).toContain('Example product');
  worker.emit('message', { type: 'documents-request', id: 'unknown', projectId: '/etc' });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'documents-response',
        id: 'unknown',
        error: expect.any(String),
      })
    )
  );
  expect(await wire.client.projectExists({ projectId: 'project' })).toBe(true);
  expect(await wire.client.projectExists({ projectId: 'unknown' })).toBe(false);
  expect(
    JSON.stringify(worker.postMessage.mock.calls.filter(([m]) => m.type === 'snapshot'))
  ).not.toContain('Example product');
});

const mergeApproval: MergeApproval = {
  taskId,
  projectId: 'project',
  reviewId: followup.requestId,
  strategy: 'squash',
  markReady: false,
  acceptWarnings: false,
};
it('requires the exact linked work before opening or approving a merge', async () => {
  await linkedWork();
  await expect(wire.client.reviewMerge({ taskId, projectId: 'other' })).rejects.toThrow();
  await expect(
    wire.client.approveMerge({ ...mergeApproval, taskId: followup.requestId })
  ).rejects.toThrow();
  expect(mocks.reviewMerge).not.toHaveBeenCalled();
  expect(mocks.approveMerge).not.toHaveBeenCalled();
});
it('persists merge receipts through the private worker and prevents updating during submission', async () => {
  await linkedWork();
  const receipt: MergeReceiptInput = {
    taskId,
    projectId: 'project',
    requestId: 'a'.repeat(64),
    url: 'https://github.com/example/repo/pull/1',
    head: 'b'.repeat(40),
    strategy: 'squash',
    status: 'pending',
    message: 'Approved',
  };
  mocks.approveMerge.mockImplementation(async (_input, record) => {
    await expect(mocks.updateGuard(true)).rejects.toThrow('submission is in progress');
    expect(await record(receipt)).toEqual({ status: 'pending', created: true });
    return { status: 'merged', message: 'Merged' };
  });
  worker.postMessage.mockImplementation((message) => {
    if (message.type === 'work-merge') {
      expect(message.input).toEqual(receipt);
      queueMicrotask(() =>
        worker.emit('message', {
          type: 'work-merge-result',
          id: message.id,
          status: 'pending',
          created: true,
        })
      );
    }
  });
  expect(await wire.client.approveMerge(mergeApproval)).toEqual({
    status: 'merged',
    message: 'Merged',
  });
});
it('holds updates during app actions and refuses new actions while an update is reserved', async () => {
  await linkedWork();
  const action = wire.client.appAction({ appId: 'flow', action: 'start' });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'apps-request' })
    )
  );
  await expect(mocks.updateGuard(true)).rejects.toThrow('in progress');
  const request = worker.postMessage.mock.calls.find(([m]) => m.type === 'apps-request')?.[0];
  worker.emit('message', {
    type: 'apps-result',
    id: request.id,
    result: { computer: 'Studio', apps: [] },
  });
  await expect(action).resolves.toEqual({ computer: 'Studio', apps: [] });
  const holding = mocks.updateGuard(true);
  await expect(wire.client.appAction({ appId: 'flow', action: 'stop' })).rejects.toThrow(
    'updating'
  );
  const hold = worker.postMessage.mock.calls.find(([m]) => m.type === 'update-hold')?.[0];
  worker.emit('message', { type: 'update-held', id: hold.id });
  await holding;
  await expect(wire.client.appAction({ appId: 'flow', action: 'open' })).rejects.toThrow(
    'updating'
  );
  expect(worker.postMessage.mock.calls.filter(([m]) => m.type === 'apps-request')).toHaveLength(1);
});

it('blocks approvals while the worker update acknowledgement is pending, and restores access on refusal', async () => {
  await linkedWork();
  const holding = mocks.updateGuard(true);
  await expect(wire.client.approveMerge(mergeApproval)).rejects.toThrow();
  expect(mocks.approveMerge).not.toHaveBeenCalled();
  const request = worker.postMessage.mock.calls.find(([m]) => m.type === 'update-hold')?.[0];
  const rejected = expect(holding).rejects.toThrow('Head is busy');
  worker.emit('message', { type: 'update-held', id: request.id, error: 'Head is busy' });
  await rejected;
  mocks.approveMerge.mockResolvedValue({ status: 'failed', message: 'Test review expired' });
  expect((await wire.client.approveMerge(mergeApproval)).status).toBe('failed');
});
it('fails the receipt if the utility exits before confirming its save', async () => {
  await linkedWork();
  mocks.approveMerge.mockImplementation(async (_input, record) => {
    await expect(record({ ...mergeApproval, status: 'pending' })).rejects.toThrow('disconnected');
    return { status: 'unknown', message: 'Disconnected' };
  });
  worker.postMessage.mockImplementation((message) => {
    if (message.type === 'work-merge') queueMicrotask(() => worker.emit('exit', 1));
  });
  expect((await wire.client.approveMerge(mergeApproval)).status).toBe('unknown');
});

async function headRequest(
  action: 'send' | 'refresh' | 'image-context',
  input: unknown,
  expiresAt = Date.now() + 60000
) {
  const id = followup.requestId;
  worker.emit('message', { type: 'head-work-request', id, action, input, expiresAt });
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'head-work-result', id })
    )
  );
  return worker.postMessage.mock.calls.find(
    ([m]) => m.type === 'head-work-result' && m.id === id
  )![0];
}
it('refreshes only linked targets through the private Head channel', async () => {
  await linkedWork();
  mocks.observeWork.mockImplementation(async (target) => ({
    ...target,
    status: 'merged',
    url: 'https://github.com/example/repo/pull/1',
    at: new Date().toISOString(),
  }));
  const response = await headRequest('refresh', {
    targets: [
      { taskId, projectId: 'project' },
      { taskId, projectId: 'another' },
    ],
  });
  expect(response.result).toEqual([
    expect.objectContaining({ taskId, projectId: 'project', status: 'merged' }),
  ]);
  expect(mocks.observeWork).toHaveBeenCalledTimes(1);
  expect(mocks.prepareFollowup).not.toHaveBeenCalled();
});
it('a Head sends through the same durable receipt path and blocks updates during delivery', async () => {
  const receipts = await linkedWork();
  const send = vi.fn(async () => {
    expect(receipts.get(followup.requestId)).toBe('pending');
    await expect(mocks.updateGuard(true)).rejects.toThrow('in progress');
  });
  mocks.prepareFollowup.mockResolvedValue(send);
  expect((await headRequest('send', followup)).result.status).toBe('sent');
  expect(receipts.get(followup.requestId)).toBe('sent');
  expect(send).toHaveBeenCalledOnce();
});
it.each(['merged', 'unlinked', 'invalid', 'expired'])(
  'refuses Head sends to %s work without dispatch',
  async (scenario) => {
    const receipts = await linkedWork();
    const send = vi.fn();
    mocks.prepareFollowup.mockResolvedValue(send);
    if (scenario === 'merged')
      mocks.observeWork.mockResolvedValue({
        ...followup,
        status: 'merged',
        url: 'https://github.com/example/repo/pull/1',
        at: new Date().toISOString(),
      });
    const input =
      scenario === 'unlinked'
        ? { ...followup, projectId: 'other' }
        : scenario === 'invalid'
          ? { ...followup, text: '' }
          : followup;
    const response = await headRequest(
      'send',
      input,
      scenario === 'expired' ? Date.now() - 1 : Date.now() + 60000
    );
    expect(response.error || response.result.status === 'failed').toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(receipts.size).toBe(0);
  }
);
it.each(['cancelled', 'disconnected'])(
  'does not deliver a %s Head turn after asynchronous preparation',
  async (scenario) => {
    const receipts = await linkedWork();
    const send = vi.fn();
    let prepared!: (send: () => Promise<void>) => void;
    mocks.prepareFollowup.mockImplementation(
      () =>
        new Promise((resolve) => {
          prepared = resolve;
        })
    );
    worker.emit('message', {
      type: 'head-work-request',
      id: followup.requestId,
      action: 'send',
      input: followup,
      expiresAt: Date.now() + 60000,
    });
    await vi.waitFor(() => expect(mocks.prepareFollowup).toHaveBeenCalled());
    if (scenario === 'cancelled')
      worker.emit('message', { type: 'head-work-cancel', id: followup.requestId });
    // Replacing the child invalidates a request that was authorized by the old worker.
    else worker.emit('exit', 1);
    prepared(send);
    if (scenario === 'cancelled') {
      await vi.waitFor(() =>
        expect(worker.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'head-work-result',
            result: expect.objectContaining({ status: 'failed' }),
          })
        )
      );
      expect(receipts.get(followup.requestId)).toBe('failed');
    } else {
      // No result can be sent to a stopped worker; the durable receipt still records the refusal.
      await vi.waitFor(() => expect(receipts.get(followup.requestId)).toBe('failed'));
      expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'head-work-result')).toBe(
        false
      );
    }
    expect(send).not.toHaveBeenCalled();
  }
);

it('persists archive readiness and cleanup outcomes, and lets archived work retry', async () => {
  await linkedWork();
  const receipts: { status: string; message: string }[] = [];
  worker.postMessage.mockImplementation((message) => {
    if (message.type !== 'work-archive') return;
    receipts.push(message.input);
    queueMicrotask(() => worker.emit('message', { type: 'work-archive-result', id: message.id }));
  });
  mocks.archiveWork.mockImplementation(async () => {
    expect(receipts.at(-1)?.status).toBe('pending');
    await expect(mocks.updateGuard(true)).rejects.toThrow('submission is in progress');
    return { archived: true, cleaned: false, message: 'Studio: terminal remains; retry cleanup.' };
  });
  const target = { taskId, projectId: 'project' };
  expect(await wire.client.archiveWork(target)).toMatchObject({ archived: true, cleaned: false });
  expect(receipts.map((r) => r.status)).toEqual(['pending', 'archived']);
  mocks.archiveWork.mockResolvedValue({
    archived: true,
    cleaned: true,
    message: 'Dependencies cleaned.',
  });
  expect(await wire.client.archiveWork(target)).toMatchObject({ cleaned: true });
  mocks.restoreWork.mockResolvedValue({ restored: true, message: 'Restored original work.' });
  await wire.client.restoreWork(target);
  expect(receipts.at(-1)).toMatchObject({ status: 'restored', archived: false });
  expect(mocks.restoreWork).toHaveBeenCalledWith(target);
});

it('does not archive without a durable intent, and records readiness blockers', async () => {
  await linkedWork();
  worker.postMessage.mockImplementation((message) => {
    if (message.type === 'work-archive')
      queueMicrotask(() =>
        worker.emit('message', {
          type: 'work-archive-result',
          id: message.id,
          error: 'Disk unavailable',
        })
      );
  });
  const target = { taskId, projectId: 'project' };
  await expect(wire.client.archiveWork(target)).rejects.toThrow('Disk unavailable');
  expect(mocks.archiveWork).not.toHaveBeenCalled();
  const receipts: { status: string; message: string }[] = [];
  worker.postMessage.mockImplementation((message) => {
    if (message.type !== 'work-archive') return;
    receipts.push(message.input);
    queueMicrotask(() => worker.emit('message', { type: 'work-archive-result', id: message.id }));
  });
  mocks.archiveWork.mockRejectedValue(new Error('Taixu buildings: agent still working on Studio.'));
  await expect(wire.client.archiveWork(target)).rejects.toThrow('agent still working');
  expect(receipts.at(-1)).toMatchObject({
    status: 'blocked',
    message: expect.stringContaining('Studio'),
  });
  await expect(wire.client.archiveWork({ ...target, projectId: 'other' })).rejects.toThrow();
  expect(mocks.archiveWork).toHaveBeenCalledTimes(1);
});

it('resolves screenshot identity privately for linked reports and legacy refreshes only', async () => {
  await linkedWork();
  mocks.readWorkImageContext.mockResolvedValue({ workspacePath: '/trusted/task' });
  const event: AgentEvent = {
    ...followup,
    providerId: 'claude',
    type: 'stop',
    timestamp: Date.now(),
    payload: { lastAssistantMessage: '![screen](/untrusted/secret.png)' },
  };
  await agentEvent({ ...event, projectId: 'unlinked' });
  expect(mocks.readWorkImageContext).not.toHaveBeenCalled();
  await agentEvent(event);
  const report = worker.postMessage.mock.calls.find(([m]) => m.type === 'work-event')?.[0];
  expect(report.event.imageContext).toEqual({ workspacePath: '/trusted/task' });
  expect(mocks.readWorkImageContext).toHaveBeenCalledWith({ taskId, projectId: 'project' });
  mocks.readWorkImageContext.mockClear();
  const response = await headRequest('image-context', {
    targets: [
      { taskId, projectId: 'project' },
      { taskId, projectId: 'unlinked' },
    ],
    workspacePath: '/caller-cannot-choose',
  });
  expect(response.result).toEqual([
    { taskId, projectId: 'project', workspacePath: '/trusted/task' },
  ]);
  expect(mocks.readWorkImageContext).toHaveBeenCalledTimes(1);
  expect(mocks.observeWork).not.toHaveBeenCalled();
});

it('retains a report when image identity is temporarily unavailable', async () => {
  await linkedWork();
  mocks.readWorkImageContext.mockRejectedValue(new Error('offline'));
  await agentEvent({
    ...followup,
    providerId: 'codex',
    type: 'stop',
    timestamp: Date.now(),
    payload: { lastAssistantMessage: './screen.png' },
  });
  const report = worker.postMessage.mock.calls.find(([m]) => m.type === 'work-event')?.[0];
  expect(report.event.imageContext).toBeUndefined();
  expect(report.event.payload.lastAssistantMessage).toBe('./screen.png');
  expect(
    (await headRequest('image-context', { targets: [{ taskId, projectId: 'project' }] })).result
  ).toEqual([]);
});

import { expect, it, vi } from 'vitest';
import { createWorkArchive } from './work-archive';

type Dependencies = Parameters<typeof createWorkArchive>[0];
const input = { taskId: 'task', projectId: 'project' };
function setup() {
  const task = {
    id: 'task',
    name: 'Axo',
    workspaceId: 'workspace',
    archivedAt: null as string | null,
    prs: [{ url: 'https://github.com/example/repo/pull/1' }],
  };
  const record = {
    kind: 'worktree',
    observedStatus: 'present',
    path: '/work/axo',
    git: { dirty: false, branch: 'work/axo', headOid: 'original' },
    runtime: {},
  };
  const acp: Record<string, unknown> = {};
  const tui: Record<string, unknown> = {};
  const agents: Record<string, unknown> = {};
  const terminals: Record<string, unknown> = {};
  const state = (data: unknown) => ({ state: () => ({ snapshot: async () => ({ data }) }) });
  const cleanDependencies = vi.fn(async (_input: unknown) => ({
    success: true,
    data: { removed: ['node_modules'], retained: [] },
  }));
  const retireCheckout = vi.fn(async () => ({ success: true }));
  const host = {
    workspaceRegistry: { records: state({ workspace: record }), cleanDependencies, retireCheckout },
    acp: { sessions: state(acp) },
    tuiAgents: { sessions: state(tui), agentStates: state(agents) },
    terminals: { sessions: state(terminals) },
  };
  const client = vi.fn(async () => ({ success: true, data: host }));
  const tasks = [task];
  const resolve = vi.fn(async () => ({
    projectId: 'project',
    host: { type: 'ssh', key: 'studio' },
    path: '/work/axo',
  }));
  const archive = vi.fn(async () => {
    task.archivedAt = 'now';
  });
  const restore = vi.fn(async () => {
    task.archivedAt = null;
  });
  const notes = {
    read: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    list: vi.fn(),
  };
  const run = createWorkArchive({
    taskService: { getTasks: async () => tasks },
    workspaceIdentity: { resolve },
    runtimes: { client },
    readConversations: async () => [{ id: 'conversation', taskId: 'task', projectId: 'project' }],
    archive,
    restore,
    notes,
  } as unknown as Dependencies);
  return {
    run,
    notes,
    task,
    tasks,
    record,
    archive,
    restore,
    client,
    cleanDependencies,
    retireCheckout,
    acp,
    tui,
    agents,
    terminals,
    resolve,
  };
}

it('archives on the owning host, inspects fresh Git state before closure and cleans without deleting history', async () => {
  const f = setup();
  expect(await f.run(input)).toMatchObject({ archived: true, cleaned: true });
  expect(f.client).toHaveBeenCalledWith({ type: 'ssh', key: 'studio' });
  expect(f.cleanDependencies.mock.calls.map((c) => c[0])).toEqual([
    { workspaceId: 'workspace', checkOnly: true },
    { workspaceId: 'workspace' },
  ]);
  expect(f.cleanDependencies.mock.invocationCallOrder[0]).toBeLessThan(
    f.archive.mock.invocationCallOrder[0]
  );
  expect(f.archive.mock.invocationCallOrder[0]).toBeLessThan(
    f.cleanDependencies.mock.invocationCallOrder[1]
  );
  expect(f.tasks).toHaveLength(1);
  expect(f.task.workspaceId).toBe('workspace');
});

it.each([
  { lifecycle: 'ready', isGenerating: true },
  { lifecycle: 'ready', pendingPermissionCount: 1 },
  { lifecycle: 'ready', queuedPromptCount: 1 },
  { lifecycle: 'ready', backgroundAgentCount: 1 },
  { lifecycle: 'starting' },
])('protects active ACP work %j', async (session) => {
  const f = setup();
  f.acp.session = { ...session, conversationId: 'conversation', cwd: '/work/axo' };
  await expect(f.run(input)).rejects.toThrow(/active or pending/);
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.cleanDependencies).not.toHaveBeenCalled();
});

it('requires a fresh idle hook before closing a terminal agent and rechecks after inspection', async () => {
  const f = setup();
  f.tui.session = {
    conversationId: 'conversation',
    status: 'running',
    startedAt: 10,
    lastInputAt: 20,
  };
  f.agents.conversation = {
    conversationId: 'conversation',
    source: 'hook',
    status: 'completed',
    updatedAt: 19,
  };
  await expect(f.run(input)).rejects.toThrow(/not confirmed it is idle/);
  f.agents.conversation = {
    conversationId: 'conversation',
    source: 'hook',
    status: 'idle',
    updatedAt: 21,
  };
  f.cleanDependencies.mockImplementationOnce(async () => {
    f.agents.conversation = {
      conversationId: 'conversation',
      source: 'hook',
      status: 'working',
      updatedAt: 22,
    };
    return { success: true, data: { removed: [], retained: [] } };
  });
  await expect(f.run(input)).rejects.toThrow(/not confirmed it is idle/);
  expect(f.archive).not.toHaveBeenCalled();
});

it('protects setup, dirty changes, shared workspaces', async () => {
  const f = setup();
  f.record.runtime = { creation: {} };
  await expect(f.run(input)).rejects.toThrow(/scripts/);
  f.record.runtime = {};
  f.record.git.dirty = true;
  await expect(f.run(input)).rejects.toThrow(/uncommitted/);
  f.record.git.dirty = false;
  f.tasks.push({ ...f.task, id: 'other' });
  await expect(f.run(input)).rejects.toThrow(/shares this workspace/);
  f.tasks.pop();

  expect(f.archive).not.toHaveBeenCalled();
});

it('fresh host Git refusal prevents closure even if the cached record says clean', async () => {
  const f = setup();
  f.cleanDependencies.mockRejectedValueOnce(new Error('Nested repository has uncommitted changes'));
  await expect(f.run(input)).rejects.toThrow(/uncommitted changes/);
  expect(f.archive).not.toHaveBeenCalled();
});

it('cleanup failure keeps the archived task and can retry without reaping or rechecking GitHub', async () => {
  const f = setup();
  f.cleanDependencies.mockResolvedValueOnce({ success: true, data: { removed: [], retained: [] } });
  f.cleanDependencies.mockRejectedValueOnce(new Error('Session still present'));
  expect(await f.run(input)).toMatchObject({
    archived: true,
    cleaned: false,
    message: expect.stringContaining('Retry cleanup'),
  });
  expect(await f.run(input)).toMatchObject({ archived: true, cleaned: true });
  expect(f.archive).toHaveBeenCalledTimes(1);
  expect(f.retireCheckout).toHaveBeenCalledTimes(1);
});

it('restores the existing task, conversation mapping and checkout without starting an agent', async () => {
  const f = setup();
  f.task.archivedAt = 'now';
  expect(await f.run.restore(input)).toMatchObject({ restored: true });
  expect(f.restore).toHaveBeenCalledWith('task');
  expect(f.cleanDependencies).not.toHaveBeenCalled();
  f.record.observedStatus = 'missing';
  await expect(f.run.restore(input)).rejects.toThrow(/checkout is unavailable/);
});

it('saves the handoff before closure and retirement, without requiring a PR', async () => {
  const f = setup();
  await f.run({ ...input, context: 'Kept the smaller design. Follow up on keyboard navigation.' });
  expect(f.notes.save.mock.calls[0][0]).toMatchObject({
    context: expect.stringContaining('smaller design'),
    archived: false,
  });
  expect(f.notes.save.mock.invocationCallOrder[0]).toBeLessThan(
    f.archive.mock.invocationCallOrder[0]
  );
  expect(f.archive.mock.invocationCallOrder[0]).toBeLessThan(
    f.retireCheckout.mock.invocationCallOrder[0]
  );
  expect(f.notes.save.mock.calls.at(-1)?.[0]).toMatchObject({ archived: true, cleaned: true });
});
it('refuses to close or clean if saving context fails', async () => {
  const f = setup();
  f.notes.save.mockRejectedValue(new Error('Disk full'));
  await expect(f.run(input)).rejects.toThrow('Disk full');
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.retireCheckout).not.toHaveBeenCalled();
  expect(f.cleanDependencies).toHaveBeenCalledTimes(1);
});
it('retains ignored local files and a readable handoff when retirement is refused', async () => {
  const f = setup();
  f.retireCheckout.mockRejectedValueOnce(new Error('Local ignored files remain: .env'));
  expect(await f.run(input)).toMatchObject({
    archived: true,
    cleaned: false,
    message: expect.stringContaining('.env'),
  });
  expect(f.notes.save.mock.calls.at(-1)?.[0]).toMatchObject({ archived: true, cleaned: false });
});
it('reconciles a missing checkout after a lost successful removal response', async () => {
  const f = setup();
  f.task.archivedAt = 'now';
  f.record.observedStatus = 'missing';
  expect(await f.run(input)).toMatchObject({ archived: true, cleaned: true });
  expect(f.cleanDependencies).not.toHaveBeenCalled();
  expect(f.archive).not.toHaveBeenCalled();
  expect(f.retireCheckout).toHaveBeenCalledOnce();
});
it('refreshes references on cleanup retry but preserves them once the checkout is missing', async () => {
  const f = setup();
  f.retireCheckout.mockRejectedValueOnce(new Error('Local ignored files remain: .env'));
  await f.run({ ...input, context: 'Saved handoff' });
  f.notes.read.mockResolvedValue(f.notes.save.mock.calls.at(-1)?.[0]);
  f.record.git.headOid = 'followup';
  f.task.prs = [{ url: 'https://github.com/example/repo/pull/2' }];
  await f.run(input);
  const saved = f.notes.save.mock.calls.at(-1)?.[0];
  expect(saved).toMatchObject({
    context: 'Saved handoff',
    commit: 'followup',
    branch: 'work/axo',
    urls: ['https://github.com/example/repo/pull/2'],
    cleaned: true,
  });
  f.notes.read.mockResolvedValue(saved);
  f.record.observedStatus = 'missing';
  f.record.git.headOid = '';
  f.task.prs = [];
  await f.run(input);
  expect(f.notes.save.mock.calls.at(-1)?.[0]).toEqual(saved);
  expect(f.archive).toHaveBeenCalledOnce();
});
it('refuses offline hosts and sessions waiting for input', async () => {
  const f = setup();
  f.client.mockRejectedValueOnce(new Error('Host offline'));
  await expect(f.run(input)).rejects.toThrow('Host offline');
  f.tui.session = { conversationId: 'conversation', status: 'running', startedAt: 10 };
  f.agents.conversation = {
    conversationId: 'conversation',
    source: 'hook',
    status: 'idle',
    notificationType: 'permission',
    updatedAt: 20,
  };
  await expect(f.run(input)).rejects.toThrow('not confirmed it is idle');
  expect(f.notes.save).not.toHaveBeenCalled();
});

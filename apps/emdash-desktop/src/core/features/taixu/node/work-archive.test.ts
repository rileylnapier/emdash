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
  };
  const record = {
    kind: 'worktree',
    observedStatus: 'present',
    path: '/work/axo',
    git: { dirty: false },
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
  const host = {
    workspaceRegistry: { records: state({ workspace: record }), cleanDependencies },
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
  const merged = vi.fn(async () => {});
  const run = createWorkArchive({
    taskService: { getTasks: async () => tasks },
    workspaceIdentity: { resolve },
    runtimes: { client },
    readConversations: async () => [{ id: 'conversation', taskId: 'task', projectId: 'project' }],
    archive,
    restore,
  } as unknown as Dependencies);
  return {
    run,
    merged,
    task,
    tasks,
    record,
    archive,
    restore,
    client,
    cleanDependencies,
    acp,
    tui,
    agents,
    terminals,
    resolve,
  };
}

it('archives on the owning host, inspects fresh Git state before closure and cleans without deleting history', async () => {
  const f = setup();
  expect(await f.run(input, f.merged)).toMatchObject({ archived: true, cleaned: true });
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
  await expect(f.run(input, f.merged)).rejects.toThrow(/active or pending/);
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
  f.agents.conversation = { source: 'hook', status: 'completed', updatedAt: 19 };
  await expect(f.run(input, f.merged)).rejects.toThrow(/not confirmed it is idle/);
  f.agents.conversation = { source: 'hook', status: 'idle', updatedAt: 21 };
  f.cleanDependencies.mockImplementationOnce(async () => {
    f.agents.conversation = { source: 'hook', status: 'working', updatedAt: 22 };
    return { success: true, data: { removed: [], retained: [] } };
  });
  await expect(f.run(input, f.merged)).rejects.toThrow(/not confirmed it is idle/);
  expect(f.archive).not.toHaveBeenCalled();
});

it('protects setup, dirty changes, shared workspaces and non-merged work', async () => {
  const f = setup();
  f.record.runtime = { creation: {} };
  await expect(f.run(input, f.merged)).rejects.toThrow(/scripts/);
  f.record.runtime = {};
  f.record.git.dirty = true;
  await expect(f.run(input, f.merged)).rejects.toThrow(/uncommitted/);
  f.record.git.dirty = false;
  f.tasks.push({ ...f.task, id: 'other' });
  await expect(f.run(input, f.merged)).rejects.toThrow(/shares this workspace/);
  f.tasks.pop();
  f.merged.mockRejectedValueOnce(new Error('PR not merged'));
  await expect(f.run(input, f.merged)).rejects.toThrow(/PR not merged/);
  expect(f.archive).not.toHaveBeenCalled();
});

it('fresh host Git refusal prevents closure even if the cached record says clean', async () => {
  const f = setup();
  f.cleanDependencies.mockRejectedValueOnce(new Error('Nested repository has uncommitted changes'));
  await expect(f.run(input, f.merged)).rejects.toThrow(/uncommitted changes/);
  expect(f.archive).not.toHaveBeenCalled();
});

it('cleanup failure keeps the archived task and can retry without reaping or rechecking GitHub', async () => {
  const f = setup();
  f.cleanDependencies.mockResolvedValueOnce({ success: true, data: { removed: [], retained: [] } });
  f.cleanDependencies.mockRejectedValueOnce(new Error('Session still present'));
  expect(await f.run(input, f.merged)).toMatchObject({
    archived: true,
    cleaned: false,
    message: expect.stringContaining('Retry cleanup'),
  });
  expect(await f.run(input, f.merged)).toMatchObject({ archived: true, cleaned: true });
  expect(f.archive).toHaveBeenCalledTimes(1);
  expect(f.merged).toHaveBeenCalledTimes(1);
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

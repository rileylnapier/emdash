import type { HostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { afterEach, expect, it, vi } from 'vitest';
import { assertUpdateActivityIdle } from './update-activity';

const hosts: HostRef[] = [{ type: 'local', id: 'local' }];
function broker(
  runtime: unknown = null,
  terminals: Record<string, unknown> = {},
  activity: {
    acp?: Record<string, unknown>;
    tui?: Record<string, unknown>;
    agents?: Record<string, unknown>;
  } = {}
) {
  const model = (data: unknown) => ({ state: () => ({ snapshot: async () => ({ data }) }) });
  return {
    client: vi.fn(async () => ({
      success: true,
      data: {
        workspaceRegistry: { records: model({ workspace: { runtime } }) },
        terminals: { sessions: model(terminals) },
        acp: { sessions: model(activity.acp ?? {}) },
        tuiAgents: {
          sessions: model(activity.tui ?? {}),
          agentStates: model(activity.agents ?? {}),
        },
      },
    })),
  } as unknown as Pick<RuntimeBroker, 'client'>;
}
afterEach(() => vi.useRealTimers());
it('allows idle workspaces but refuses creation, setup and running lifecycle scripts', async () => {
  await expect(assertUpdateActivityIdle(broker(), hosts)).resolves.toBeUndefined();
  for (const runtime of [
    { creation: { stage: 'copying', startedAt: 1 } },
    { activation: { phase: 'preparing', scripts: {} } },
    { activation: { phase: 'active', scripts: { setup: 'running' } } },
    { lifecycle: [{ status: 'running' }] },
  ])
    await expect(assertUpdateActivityIdle(broker(runtime), hosts)).rejects.toThrow(
      /workspace setup/
    );
});
it('refuses active remote terminals too', async () => {
  await expect(
    assertUpdateActivityIdle(broker(null, { terminal: { status: 'running' } }), hosts)
  ).rejects.toThrow(/active terminals/);
});
it('fails closed when runtime activity is unavailable', async () => {
  const unavailable = broker();
  vi.mocked(unavailable.client).mockRejectedValue(new Error('Offline'));
  await expect(assertUpdateActivityIdle(unavailable, hosts)).rejects.toThrow('Offline');
  vi.useFakeTimers();
  vi.mocked(unavailable.client).mockReturnValue(new Promise(() => {}));
  const checked = expect(assertUpdateActivityIdle(unavailable, hosts)).rejects.toThrow(
    /Could not check/
  );
  await vi.advanceTimersByTimeAsync(5001);
  await checked;
});

const session = {
  conversationId: 'task-1',
  providerId: 'codex',
  cwd: '/repos/worktrees/taixu-updates',
  status: 'running',
  startedAt: 100,
  lastInputAt: 200,
};
const completed = { conversationId: 'task-1', source: 'hook', status: 'completed', updatedAt: 300 };
const ready = {
  conversationId: 'acp-1',
  providerId: 'claude',
  title: 'Building models',
  lifecycle: 'ready',
  isGenerating: false,
  pendingPermissionCount: 0,
  queuedPromptCount: 0,
  backgroundAgentCount: 0,
};

it.each(['idle', 'completed'])(
  'allows a living TUI with a fresh provider %s signal',
  async (status) => {
    await expect(
      assertUpdateActivityIdle(
        broker(
          null,
          {},
          {
            tui: { 'task-1': session },
            agents: { 'task-1': { ...completed, status } },
          }
        ),
        hosts
      )
    ).resolves.toBeUndefined();
  }
);

it.each([
  ['working', { ...completed, status: 'working' }],
  ['permission', { ...completed, status: 'awaiting-input', notificationType: 'permission_prompt' }],
  ['question', { ...completed, status: 'awaiting-input', notificationType: 'elicitation_dialog' }],
  ['unknown notification', { ...completed, status: 'awaiting-input' }],
  ['notification', { ...completed, status: 'idle', notificationType: 'auth_success' }],
  ['error', { ...completed, status: 'error' }],
  ['input inference', { ...completed, source: 'input' }],
  ['restored signal', { ...completed, updatedAt: 50 }],
  ['new input or draft', { ...completed, updatedAt: 199 }],
  ['same-time input', { ...completed, updatedAt: 200 }],
  ['wrong session', { ...completed, conversationId: 'other' }],
  ['unknown', undefined],
])('blocks %s and identifies the work needing attention', async (_name, agent) => {
  const remote: HostRef[] = [{ type: 'remote', id: 'studio' }];
  await expect(
    assertUpdateActivityIdle(
      broker(
        null,
        {},
        {
          tui: { 'task-1': session },
          agents: agent ? { 'task-1': agent } : {},
        }
      ),
      remote
    )
  ).rejects.toThrow(/codex · taixu-updates on remote:studio/);
});

it('blocks a starting TUI even with a completed signal, and allows an exited session', async () => {
  await expect(
    assertUpdateActivityIdle(
      broker(
        null,
        {},
        {
          tui: { 'task-1': { ...session, status: 'starting' } },
          agents: { 'task-1': completed },
        }
      ),
      hosts
    )
  ).rejects.toThrow(/taixu-updates/);
  await expect(
    assertUpdateActivityIdle(
      broker(
        null,
        {},
        {
          tui: { 'task-1': { ...session, status: 'exited' } },
        }
      ),
      hosts
    )
  ).resolves.toBeUndefined();
});

it('allows ready and closed ACP sessions with no outstanding work', async () => {
  for (const lifecycle of ['ready', 'closed']) {
    await expect(
      assertUpdateActivityIdle(
        broker(
          null,
          {},
          {
            acp: { 'acp-1': { ...ready, lifecycle } },
          }
        ),
        hosts
      )
    ).resolves.toBeUndefined();
  }
});

it.each([
  { lifecycle: 'starting' },
  { lifecycle: 'replaying' },
  { lifecycle: 'working' },
  { lifecycle: 'cancelling' },
  { isGenerating: true },
  { pendingPermissionCount: 1 },
  { queuedPromptCount: 1 },
  { backgroundAgentCount: 1 },
])('blocks ACP activity %j, including background work', async (patch) => {
  await expect(
    assertUpdateActivityIdle(
      broker(
        null,
        {},
        {
          acp: { 'acp-1': { ...ready, ...patch } },
        }
      ),
      hosts
    )
  ).rejects.toThrow(/claude · Building models.*active or pending/);
});

it('rechecks provider activity on every call, including after prepare', async () => {
  const activity = { tui: { 'task-1': session }, agents: { 'task-1': { ...completed } } };
  const runtime = broker(null, {}, activity);
  await expect(assertUpdateActivityIdle(runtime, hosts)).resolves.toBeUndefined();
  activity.agents['task-1'].status = 'working';
  await expect(assertUpdateActivityIdle(runtime, hosts)).rejects.toThrow(/taixu-updates/);
});

it('allows Claude completion reminders but refuses input typed after preparation', async () => {
  const activity = {
    tui: { 'task-1': { ...session, providerId: 'claude' } },
    agents: {
      'task-1': {
        ...completed,
        providerId: 'claude',
        message: 'Claude is waiting for your input',
      },
    },
  };
  const runtime = broker(null, {}, activity);
  await expect(assertUpdateActivityIdle(runtime, hosts)).resolves.toBeUndefined();
  activity.tui['task-1'].lastInputAt = 301;
  await expect(assertUpdateActivityIdle(runtime, hosts)).rejects.toThrow(/claude · taixu-updates/);
});

it('refuses a host with unavailable agent state even if its processes appear idle', async () => {
  const runtime = broker();
  const result = await runtime.client(hosts[0]);
  if (!result.success) throw new Error('Fixture failed');
  result.data.tuiAgents.agentStates.state = () => {
    throw new Error('Agent state unavailable');
  };
  vi.mocked(runtime.client).mockResolvedValue(result);
  await expect(assertUpdateActivityIdle(runtime, hosts)).rejects.toThrow('Agent state unavailable');
});

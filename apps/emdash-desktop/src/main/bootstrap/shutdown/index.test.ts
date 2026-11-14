import { LOCAL_HOST_REF, type HostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  assertIdleForTaixuUpdate,
  configureShutdownRuntimeClients,
  configureUpdateActivityCheck,
} from './index';

vi.mock('electron', () => ({ app: {} }));
vi.mock('@core/features/workbench/node', () => ({ desktopHostEvents: { emit: vi.fn() } }));
vi.mock('@main/host/updates/update-service', () => ({ updateService: {} }));
vi.mock('@main/host/sessions/active-session-summary', () => ({ getActiveSessionSummary: vi.fn() }));
vi.mock('./phases', () => ({ runQuitCleanup: vi.fn() }));

const remote: HostRef = { type: 'remote', id: 'studio' };
const ready = {
  lifecycle: 'ready',
  isGenerating: false,
  pendingPermissionCount: 0,
  queuedPromptCount: 0,
  backgroundAgentCount: 0,
};
function installationBroker({ busy = false } = {}) {
  const model = (data: unknown) => ({ state: () => ({ snapshot: async () => ({ data }) }) });
  const client = vi.fn(async (host: HostRef) => {
    if (host.type !== 'local') throw new Error('Studio is busy or unavailable');
    return {
      success: true,
      data: {
        workspaceRegistry: { records: model({}) },
        terminals: { sessions: model({}) },
        acp: {
          sessions: model({
            task: { ...ready, title: 'laptop-owned task', providerId: 'codex', isGenerating: busy },
          }),
        },
        tuiAgents: { sessions: model({}), agentStates: model({}) },
      },
    };
  });
  return { client } as unknown as RuntimeBroker;
}
beforeEach(() => configureUpdateActivityCheck(async () => {}));

it('checks the restarting installation broker even with only attached remote projects', async () => {
  const broker = installationBroker();
  configureShutdownRuntimeClients(broker, () => [remote]);
  await expect(assertIdleForTaixuUpdate()).resolves.toBeUndefined();
  expect(broker.client).toHaveBeenCalledExactlyOnceWith(LOCAL_HOST_REF);
});

it('protects local work independently of the selected Studio and attached projects', async () => {
  const broker = installationBroker({ busy: true });
  configureShutdownRuntimeClients(broker, () => [remote]);
  await expect(assertIdleForTaixuUpdate()).rejects.toThrow(/codex · laptop-owned task/);
  expect(broker.client).toHaveBeenCalledExactlyOnceWith(LOCAL_HOST_REF);
});

it.each(['Unsaved file: notes.ts', 'Pause scheduled automations'])(
  'retains installation-owned readiness checks: %s',
  async (reason) => {
    const broker = installationBroker();
    configureShutdownRuntimeClients(broker, () => [LOCAL_HOST_REF, remote]);
    configureUpdateActivityCheck(async () => {
      throw new Error(reason);
    });
    await expect(assertIdleForTaixuUpdate()).rejects.toThrow(reason);
    expect(broker.client).not.toHaveBeenCalled();
  }
);

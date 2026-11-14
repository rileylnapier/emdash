import '@emdash/ui/style.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { LinkedIssue } from '@core/primitives/linked-issues/api';
import { TaskNameField } from './task-name-field';
import { useCreateTaskState, type CreateTaskState } from './use-create-task-state';

const mocks = vi.hoisted(() => ({ autoGenerateName: true, generate: vi.fn() }));
vi.mock('@core/features/tasks/api/browser/hooks/useTaskSettings', () => ({
  useTaskSettings: () => ({ autoGenerateName: mocks.autoGenerateName }),
}));
vi.mock('@core/features/tasks/api/browser/client', () => ({
  getTasksWireClient: async () => ({ generateTaskName: mocks.generate }),
}));
vi.mock('../issue-context/use-linked-issue-context', () => ({
  useLinkedIssueContext: (issue: LinkedIssue | null) => ({ issue, isLoading: false }),
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: { branchPrefix: 'work', appendRandomBranchSuffix: true } }),
}));
vi.mock('@core/features/source-control/api/browser/stores/source-control-selectors', () => ({
  getGitRepositoryStore: () => ({ localBranches: [] }),
}));
vi.mock('@core/features/tasks/api/browser/create-task-modal/use-workspace-config', async () => {
  const { useBranchName } = await import('./use-branch-name');
  return {
    useWorkspaceConfig: (opts: { taskName: string; projectId: string; resetKey: unknown }) => ({
      branchNameState: useBranchName(opts),
      isValid: true,
    }),
  };
});

let state: CreateTaskState;
function Probe({ name, projectId }: { name?: string; projectId: string }) {
  state = useCreateTaskState(
    projectId,
    undefined,
    false,
    true,
    'main',
    null,
    undefined,
    null,
    undefined,
    name
  );
  return (
    <>
      <TaskNameField state={state.taskName} />
      <output aria-label="Branch name">{state.workspaceConfig.branchNameState.branchName}</output>
      <button disabled={!state.isValid}>Create</button>
    </>
  );
}

let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.autoGenerateName = true;
  mocks.generate.mockReset().mockResolvedValue('random-city');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
async function render(name?: string, projectId = 'repo') {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe name={name} projectId={projectId} />
      </QueryClientProvider>
    )
  );
}

it.each([true, false])(
  'uses the brief name with random naming enabled=%s',
  async (autoGenerate) => {
    mocks.autoGenerateName = autoGenerate;
    await render('taixu-building-models');
    expect(state.taskName.effectiveTaskName).toBe('taixu-building-models');
    await expect
      .element(page.getByRole('textbox', { name: 'Task name' }))
      .toHaveAttribute('placeholder', 'taixu-building-models');
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeEnabled();
    expect(state.workspaceConfig.branchNameState.branchName).toMatch(
      /^work\/taixu-building-models-[a-z0-9]{5}$/
    );
    expect(mocks.generate).not.toHaveBeenCalled();
  }
);

it('lets edits win, keeps the branch suffix stable, and retains the brief after choosing a repository', async () => {
  await render('Taixu building models');
  const suffix = state.workspaceConfig.branchNameState.branchName.slice(-5);
  await page.getByRole('textbox', { name: 'Task name' }).fill('taixu-smaller-roofs');
  expect(state.taskName.effectiveTaskName).toBe('taixu-smaller-roofs');
  expect(state.workspaceConfig.branchNameState.branchName).toBe(
    `work/taixu-smaller-roofs-${suffix}`
  );
  await page.getByRole('textbox', { name: 'Task name' }).fill('');
  expect(state.taskName.effectiveTaskName).toBe('taixu-building-models');
  await render('Taixu building models', 'another-repo');
  expect(state.taskName.effectiveTaskName).toBe('taixu-building-models');
  expect(mocks.generate).not.toHaveBeenCalled();
});

it.each([undefined, '!!!'])(
  'preserves the existing fallback for unusable seed %s',
  async (name) => {
    await render(name);
    await expect.poll(() => state.taskName.effectiveTaskName).toBe('random-city');
    expect(mocks.generate).toHaveBeenCalledWith({});
  }
);

it('uses an explicitly linked issue and restores the brief when it is cleared', async () => {
  await render('taixu-building-models');
  await act(async () => {
    state.setLinkedType('issue');
    state.setLinkedIssue({
      provider: 'linear',
      identifier: 'TAI-12',
      title: 'Fix roofs',
      url: 'https://linear.app/test',
      branchName: 'tai-12-fix-roofs',
    });
  });
  expect(state.taskName.effectiveTaskName).toBe('tai-12-fix-roofs');
  await act(async () => state.setLinkedIssue(null));
  expect(state.taskName.effectiveTaskName).toBe('taixu-building-models');
});

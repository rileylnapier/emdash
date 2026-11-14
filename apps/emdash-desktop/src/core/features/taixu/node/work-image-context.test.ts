import { expect, it, vi } from 'vitest';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { WorkspaceIdentity } from '@core/features/workspaces/api/node/workspace-identity-service';
import { createWorkImageContext } from './work-image-context';

it('resolves the registered task workspace and refuses missing, cross-project and remote identities', async () => {
  const getTasks = vi
    .fn<TaskService['getTasks']>()
    .mockResolvedValue([
      { id: 'task', projectId: 'repo', workspaceId: 'workspace' } as Awaited<
        ReturnType<TaskService['getTasks']>
      >[number],
    ]);
  const identity: WorkspaceIdentity = {
    workspaceId: 'workspace',
    projectId: 'repo',
    path: '/registered/task',
    host: { type: 'local', id: 'local' },
  };
  const resolve = vi
    .fn<(id: string) => Promise<WorkspaceIdentity | null>>()
    .mockResolvedValue(identity);
  const read = createWorkImageContext({
    taskService: { getTasks },
    workspaceIdentity: { resolve },
  });
  expect(await read({ taskId: 'task', projectId: 'repo' })).toEqual({
    workspacePath: '/registered/task',
  });
  expect(resolve).toHaveBeenCalledWith('workspace');
  expect(await read({ taskId: 'missing', projectId: 'repo' })).toBeNull();
  expect(await read({ taskId: 'task', projectId: 'other' })).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(1);
  resolve.mockResolvedValue({ ...identity, projectId: 'other' });
  expect(await read({ taskId: 'task', projectId: 'repo' })).toBeNull();
  resolve.mockResolvedValue({ ...identity, host: { type: 'remote', id: 'ssh' } });
  expect(await read({ taskId: 'task', projectId: 'repo' })).toBeNull();
  resolve.mockResolvedValue(null);
  expect(await read({ taskId: 'task', projectId: 'repo' })).toBeNull();
});

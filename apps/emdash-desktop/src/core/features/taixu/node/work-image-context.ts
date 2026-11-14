import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import type { WorkTarget } from '../api/contract';

export function createWorkImageContext({
  taskService,
  workspaceIdentity,
}: {
  taskService: Pick<TaskService, 'getTasks'>;
  workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve'>;
}) {
  return async (target: WorkTarget): Promise<{ workspacePath: string } | null> => {
    const task = (await taskService.getTasks(target.projectId)).find(
      (t) => t.id === target.taskId && t.projectId === target.projectId
    );
    if (!task?.workspaceId) return null;
    const identity = await workspaceIdentity.resolve(task.workspaceId);
    // The utility process runs on this desktop. An SSH task's identically named
    // local folder must never be used in its place. Studio clients use Studio's
    // desktop and receive its saved bytes through the existing HTTP tunnel.
    if (!identity || identity.projectId !== target.projectId || identity.host.type !== 'local')
      return null;
    return { workspacePath: identity.path };
  };
}

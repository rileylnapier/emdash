import { parseRepositoryRef } from '@emdash/core/primitives/repository/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import {
  requireAttachedProjectOrThrow,
  type ProjectAttachmentAccess,
} from '@core/features/projects/api/node/attached-project';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import { hostPathFromNative } from '@core/primitives/desktop-runtime/api';
import type { WorkTarget } from '../api/contract';
import type { WorkHead } from './work-merge';

export function createWorkHeadReader({
  projects,
  taskService,
  workspaceIdentity,
  runtimes,
}: {
  projects: ProjectAttachmentAccess;
  taskService: Pick<TaskService, 'getTasks'>;
  workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve'>;
  runtimes: Pick<RuntimeBroker, 'client'>;
}) {
  return async (target: WorkTarget): Promise<WorkHead> => {
    const task = (await taskService.getTasks(target.projectId)).find((t) => t.id === target.taskId);
    if (!task?.workspaceId || task.archivedAt) throw new Error('This work is no longer available.');
    const identity = await workspaceIdentity.resolve(task.workspaceId);
    if (!identity || identity.projectId !== target.projectId)
      throw new Error('Work belongs to a different project.');
    const project = requireAttachedProjectOrThrow(projects, target.projectId);
    const runtime = await runtimes.client(identity.host);
    if (!runtime.success) throw new Error('Reconnect to the project computer first.');
    const [{ data: head }, { data: remotes }, effective] = await Promise.all([
      runtime.data.git.checkout.model
        .state({ checkout: hostPathFromNative(identity.path) }, 'head')
        .snapshot(),
      project.git.repository.model.state(project.repository, 'remotes').snapshot(),
      project.gitRepository.getEffectiveRemotes(),
    ]);
    if (head.kind !== 'branch') throw new Error('Open the work on its published branch first.');
    const remoteUrl = (name: string | null) =>
      parseRepositoryRef(remotes.remotes.find((r) => r.name === name)?.url ?? '')?.repositoryUrl;
    const repositoryUrl = remoteUrl(effective.baseRemote);
    const headRepositoryUrl = remoteUrl(effective.pushRemote);
    if (!repositoryUrl || !headRepositoryUrl)
      throw new Error(
        'This project needs a GitHub base and push remote. Open its repository settings.'
      );
    return { repositoryUrl, headRepositoryUrl, headRefName: head.ref.slice('refs/heads/'.length) };
  };
}

import { randomUUID } from 'node:crypto';
import { formatHostRef } from '@emdash/core/primitives/host/api';
import { toBranchRef, type GitBranch, type GitBranchRef } from '@emdash/core/runtimes/git/api';
import type {
  ProviderSettingsKey,
  ProviderSettingsSnapshot,
} from '@core/features/conversations/api/provider-settings';
import type { ProjectAttachmentAccess } from '@core/features/projects/api/node/attached-project';
import { resolveProjectEffectiveSettings } from '@core/features/projects/api/node/settings/effective-settings';
import {
  agentSupportsAcp,
  agentSupportsAutoApprove,
  agentSupportsInitialPromptDelivery,
  type AgentPayload,
} from '@core/primitives/agents/api';
import type { EffectiveDefaultBranch } from '@core/primitives/project-settings/api';
import { projectHostRef } from '@core/primitives/projects/api';
import {
  resolveTaskBranchName,
  type CreateTaskError,
  type CreateTaskParams,
  type TaskConfig,
} from '@core/primitives/tasks/api';
import { buildWorkspaceConfigFromPreset } from '@core/primitives/workspaces/api';
import type { AppSettingsService } from '@core/services/settings/node';

/** A refusal the Head can repeat to Riley; nothing was created. */
export class HeadTaskUnavailable extends Error {}

export type HeadTaskRequest = { taskId: string; projectId: string; name: string; prompt: string };
export type HeadTaskAgent = Pick<AgentPayload, 'id' | 'status' | 'capabilities'>;

const MANUAL = 'Use Review & start work to choose them in the task dialog.';

/**
 * The task dialog's choice of agent, for a dialog nobody touches: the saved default agent when
 * installed, otherwise the first installed agent in registry order. Mirrors the renderer's
 * `resolveConversationProviderSelection` with no override and known availability.
 */
export function chooseHeadAgent(
  agents: HeadTaskAgent[],
  defaultAgent: string | undefined
): HeadTaskAgent {
  const installed = agents.filter((agent) => agent.status === 'available');
  const preferred = installed.find((agent) => agent.id === defaultAgent);
  const agent = preferred ?? installed[0];
  if (!agent)
    throw new HeadTaskUnavailable(
      'No coding agent is installed. Install one in Models & accounts.'
    );
  return agent;
}

/** The dialog's default branch: the effective setting, matched to a ref the repository has. */
export function matchDefaultBranch(
  effective: EffectiveDefaultBranch | null,
  branches: GitBranch[]
): GitBranchRef | undefined {
  if (!effective) return undefined;
  const ref =
    effective.remote === null
      ? `refs/heads/${effective.branch}`
      : `refs/remotes/${effective.remote}/${effective.branch}`;
  const branch = branches.find((b) =>
    effective.remote === null
      ? b.type === 'local' && b.ref === ref
      : b.type === 'remote' && b.ref === ref && b.remote.name === effective.remote
  );
  return branch ? toBranchRef(branch) : undefined;
}

/**
 * The parameters the native task dialog would submit for this brief with nothing changed:
 * a new worktree branched from the project's default branch, the default agent and its saved
 * interface, auto-approve and options. Mirrors `buildInitialConversation` and the dialog's
 * workspace defaults; settings it cannot reproduce safely are refused, not guessed.
 */
export function buildHeadTaskParams(input: {
  request: HeadTaskRequest;
  agent: HeadTaskAgent;
  providerSettings: ProviderSettingsSnapshot;
  preferredConversationType: 'acp' | 'pty' | undefined;
  tasks: { createBranchAndWorktree?: boolean } | undefined;
  project:
    | { branchPrefix?: string; appendRandomBranchSuffix?: boolean; pushOnCreate?: boolean }
    | undefined;
  defaultBranch: GitBranchRef | undefined;
  localBranches: string[];
  conversationId?: string;
  suffix?: string;
}): CreateTaskParams {
  const { request, agent, providerSettings } = input;
  const useChatUi =
    agentSupportsAcp(agent.capabilities) && input.preferredConversationType === 'acp';
  if (!useChatUi && !agentSupportsInitialPromptDelivery(agent.capabilities))
    throw new HeadTaskUnavailable(
      `The default agent cannot receive the brief automatically in a terminal. ${MANUAL}`
    );
  if (input.tasks?.createBranchAndWorktree === false)
    throw new HeadTaskUnavailable(
      `Task settings check out an existing branch instead of creating one. ${MANUAL}`
    );
  if (!input.defaultBranch)
    throw new HeadTaskUnavailable(
      "This project's default branch is unavailable. Set it in the project's settings, or use " +
        'Review & start work to choose a branch.'
    );
  const branchName = resolveTaskBranchName({
    rawBranch: request.name,
    branchPrefix: input.project?.branchPrefix ?? '',
    suffix: input.suffix ?? Math.random().toString(36).slice(2, 7),
    appendRandomSuffix: input.project?.appendRandomBranchSuffix ?? true,
  });
  if (input.localBranches.includes(branchName))
    throw new HeadTaskUnavailable(`Branch ${branchName} already exists. ${MANUAL}`);
  const pushBranch = input.project?.pushOnCreate ?? true;
  const workspaceConfig = buildWorkspaceConfigFromPreset(
    'new-worktree',
    { defaultBranch: input.defaultBranch },
    {
      branchName,
      fromBranch: input.defaultBranch,
      pushBranch,
      createBranch: true,
      taskBranch: branchName,
    }
  );
  const provider = agent.id;
  const transport = useChatUi ? 'acp' : 'pty';
  const initialConversation: NonNullable<TaskConfig['initialConversation']> = {
    id: input.conversationId ?? randomUUID(),
    provider,
    // The dialog names a task's first conversation like nextDefaultConversationTitle(provider, []).
    title: `${provider.charAt(0).toUpperCase()}${provider.slice(1)} (1)`,
    ...(useChatUi
      ? { initialQueue: [{ text: request.prompt }] }
      : { initialPrompt: request.prompt.trim() }),
    autoApprove:
      agentSupportsAutoApprove(agent.capabilities, transport) &&
      providerSettings.pty.autoApprove === true,
    ...(useChatUi ? { options: providerSettings.acp.options } : {}),
    type: transport,
  };
  return {
    id: request.taskId,
    projectId: request.projectId,
    taskConfig: { version: '1', name: request.name, initialConversation },
    workspaceConfig,
  };
}

export function createHeadTaskResolver(deps: {
  projects: ProjectAttachmentAccess;
  appSettings: Pick<AppSettingsService, 'get'>;
  listAgents: () => Promise<HeadTaskAgent[]>;
  readProviderSettings: (key: ProviderSettingsKey) => Promise<ProviderSettingsSnapshot>;
}) {
  return async (request: HeadTaskRequest): Promise<CreateTaskParams> => {
    const attached = deps.projects.requireAttached(request.projectId);
    if (!attached.success)
      throw new HeadTaskUnavailable('This project is unavailable. Reconnect to it, then retry.');
    const project = attached.data;
    // The dialog reads agents and preferences per host; Heads start work in local repositories.
    if (project.project.type !== 'local' || !project.hasRepository)
      throw new HeadTaskUnavailable(`Heads start work only in local Git repositories. ${MANUAL}`);
    const [agents, defaultAgent, preferred, tasks, projectSettings, effective, refs] =
      await Promise.all([
        deps.listAgents(),
        deps.appSettings.get('defaultAgent'),
        deps.appSettings.get('preferredConversationType'),
        deps.appSettings.get('tasks'),
        deps.appSettings.get('project'),
        resolveProjectEffectiveSettings({
          settings: project.settings,
          repoFacts: project.repoFacts,
          projectId: request.projectId,
        }),
        project.git.repository.model.state(project.repository, 'refs').snapshot(),
      ]);
    const agent = chooseHeadAgent(agents, defaultAgent);
    const providerSettings = await deps.readProviderSettings({
      host: formatHostRef(projectHostRef(project.project)),
      providerId: agent.id,
    });
    return buildHeadTaskParams({
      request,
      agent,
      providerSettings,
      preferredConversationType: preferred,
      tasks,
      project: projectSettings,
      defaultBranch: matchDefaultBranch(effective.defaultBranch.value, refs.data.branches),
      localBranches: refs.data.branches
        .filter((b) => b.type === 'local')
        .map((b) => b.ref.slice('refs/heads/'.length)),
    });
  };
}

/** A short, honest reason for a failed creation, for the Head and the work card. */
export function headTaskErrorMessage(error: CreateTaskError): string {
  if ('message' in error && error.message) return `Task creation failed: ${error.message}`;
  if (error.type === 'initial-commit-required')
    return 'Create an initial commit to enable branch-based tasks.';
  if (error.type === 'branch-create-failed')
    return `Could not create branch ${error.branch}. Open Inspect work for details.`;
  return 'Task creation failed. Open Inspect work for details before retrying.';
}

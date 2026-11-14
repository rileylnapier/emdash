import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import type { Conversation } from '@core/primitives/conversations/api';
import type { WorkFollowup } from '../api/contract';

// Only these pre-submission refusals can be reported as definitely not sent.
export class WorkFollowupUnavailable extends Error {}

export function createWorkFollowup({
  readConversations,
  taskService,
  workspaceIdentity,
  runtimes,
}: {
  readConversations: () => Promise<Conversation[]>;
  taskService: Pick<TaskService, 'getTasks'>;
  workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve'>;
  runtimes: Pick<RuntimeBroker, 'client'>;
}) {
  return async (input: WorkFollowup): Promise<() => Promise<void>> => {
    const conversation = (await readConversations()).find(
      (c) =>
        c.id === input.conversationId &&
        c.taskId === input.taskId &&
        c.projectId === input.projectId
    );
    if (!conversation || !['claude', 'codex'].includes(conversation.providerId ?? ''))
      throw new WorkFollowupUnavailable('Choose a Claude or Codex agent in this work item.');
    if (!['completed', 'idle'].includes(conversation.agentStatus ?? ''))
      throw new WorkFollowupUnavailable(
        'Wait for the agent to finish, or open the work to resolve its request first.'
      );
    const task = (await taskService.getTasks(input.projectId)).find((t) => t.id === input.taskId);
    const identity =
      task?.workspaceId && !task.archivedAt
        ? await workspaceIdentity.resolve(task.workspaceId)
        : undefined;
    if (!identity)
      throw new WorkFollowupUnavailable('Open the work to resume its workspace first.');
    const runtime = await runtimes.client(identity.host);
    if (!runtime.success)
      throw new WorkFollowupUnavailable('Reconnect to the project computer first.');
    const client = runtime.data;
    const text = `Follow-up instructions from the Taixu Head conversation:\n\n${input.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')}`;
    if (conversation.type === 'acp') {
      const assertReady = async () => {
        const { data } = await client.acp.sessions.state(undefined, 'list').snapshot();
        const session = data[input.conversationId];
        if (
          !session ||
          session.suspended ||
          session.lifecycle !== 'ready' ||
          session.isGenerating ||
          session.pendingPermissionCount ||
          session.queuedPromptCount ||
          session.backgroundAgentCount
        )
          throw new WorkFollowupUnavailable(
            'Wait for the agent to finish, or open the work to resolve its request first.'
          );
      };
      await assertReady();
      return async () => {
        await assertReady();
        const result = await client.acp.sendPrompt(
          {
            conversationId: input.conversationId,
            promptId: input.requestId,
            prompt: { text },
            placement: 'queue',
          },
          { timeoutMs: 0 }
        );
        if (!result.success) throw new Error('The agent did not confirm the follow-up.');
      };
    }
    if (conversation.type !== 'pty')
      throw new WorkFollowupUnavailable('This conversation cannot receive changes.');
    return async () => {
      // The host checks readiness and conflicting input at the actual PTY write.
      const result = await client.tuiAgents.sendFollowup({
        conversationId: input.conversationId,
        text,
      });
      if (!result.success) throw new Error('The agent did not confirm the follow-up.');
      if (result.data.status === 'not-ready')
        throw new WorkFollowupUnavailable(
          'Not sent: open the work first. Its agent is busy, waiting for input, or has an unfinished draft.'
        );
      if (result.data.status === 'interrupted')
        throw new WorkFollowupUnavailable(
          'Not submitted: the agent or its input changed. Open the work to inspect the pasted instructions before sending again.'
        );
    };
  };
}

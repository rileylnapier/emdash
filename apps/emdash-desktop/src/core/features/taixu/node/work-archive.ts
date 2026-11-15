import {
  containsAbsolute,
  formatAbsolute,
  parseNativeAbsolute,
} from '@emdash/core/primitives/path/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { WorkspaceIdentityService } from '@core/features/workspaces/api/node/workspace-identity-service';
import type { Conversation } from '@core/primitives/conversations/api';
import type { WorkArchiveInput, WorkTarget } from '../api/contract';
import { createWorkArchiveStore, type WorkArchiveStore } from './work-archive-store';

export type ArchiveWork = ReturnType<typeof createWorkArchive>;

export function createWorkArchive({
  taskService,
  workspaceIdentity,
  runtimes,
  readConversations,
  archive,
  restore,
  notes = createWorkArchiveStore(),
}: {
  taskService: Pick<TaskService, 'getTasks'>;
  workspaceIdentity: Pick<WorkspaceIdentityService, 'resolve'>;
  runtimes: Pick<RuntimeBroker, 'client'>;
  readConversations: () => Promise<Conversation[]>;
  archive: (target: WorkTarget) => Promise<void>;
  restore: (taskId: string) => Promise<void>;
  notes?: WorkArchiveStore;
}) {
  const pending = new Set<string>();
  return Object.assign(
    async (input: WorkArchiveInput) => {
      if (pending.has(input.taskId)) throw new Error('This work is already being archived.');
      pending.add(input.taskId);
      try {
        const tasks = await taskService.getTasks(input.projectId);
        const task = tasks.find((t) => t.id === input.taskId);
        if (!task?.workspaceId) throw new Error('This work has no available workspace.');
        const saved = await notes.read(input);
        const identity = await workspaceIdentity.resolve(task.workspaceId);
        if (!identity || identity.projectId !== input.projectId)
          throw new Error('Work belongs to a different project.');
        if (tasks.some((t) => t.id !== task.id && t.workspaceId === task.workspaceId))
          throw new Error('Another task shares this workspace. Open Inspect work to manage it.');
        const result = await runtimes.client(identity.host);
        if (!result.success) throw new Error('Reconnect to the computer running this work.');
        const client = result.data;
        const root = parseNativeAbsolute(identity.path);
        if (!root.success) throw new Error('Workspace path is unavailable.');
        const owns = (cwd?: string) => {
          if (!cwd) return false;
          const candidate = parseNativeAbsolute(cwd);
          return candidate.success && containsAbsolute(root.data, candidate.data);
        };
        const conversations = (await readConversations()).filter(
          (c) => c.taskId === task.id && c.projectId === input.projectId
        );
        const belongs = (s: { conversationId: string; cwd?: string }) =>
          owns(s.cwd) || conversations.some((c) => c.id === s.conversationId);
        const assertIdle = async () => {
          const [records, terminals, acp, tui, agents] = await Promise.all([
            client.workspaceRegistry.records.state(undefined, 'list').snapshot(),
            client.terminals.sessions.state(undefined, 'list').snapshot(),
            client.acp.sessions.state(undefined, 'list').snapshot(),
            client.tuiAgents.sessions.state(undefined, 'list').snapshot(),
            client.tuiAgents.agentStates.state(undefined, 'list').snapshot(),
          ]);
          const record = records.data[task.workspaceId!];
          if (
            !record ||
            record.kind !== 'worktree' ||
            (record.observedStatus === 'missing' && !task.archivedAt)
          )
            throw new Error('Only an available task worktree can be finished here.');
          if (record.git?.dirty)
            throw new Error(
              `${task.name}: commit or save uncommitted workspace changes before archiving.`
            );
          for (const r of Object.values(records.data).filter((r) => owns(r.path))) {
            const runtime = r.runtime;
            if (
              runtime?.creation ||
              runtime?.activation?.phase === 'preparing' ||
              Object.values(runtime?.activation?.scripts ?? {}).some(
                (s) => s === 'running' || s === 'pending'
              ) ||
              runtime?.lifecycle?.some((s) => s.status === 'running')
            )
              throw new Error(`${task.name}: workspace setup or scripts are still running.`);
          }
          if (
            Object.values(terminals.data).some(
              (s) => s.status === 'running' && owns(formatAbsolute(s.key.workspace.path))
            )
          )
            throw new Error(`${task.name}: close its active terminals before archiving.`);
          for (const s of Object.values(acp.data).filter(belongs)) {
            if (
              !['ready', 'closed'].includes(s.lifecycle) ||
              s.isGenerating ||
              s.pendingPermissionCount ||
              s.queuedPromptCount ||
              s.backgroundAgentCount
            )
              throw new Error(
                `${task.name}: ${s.title || s.providerId} still has active or pending work.`
              );
          }
          for (const s of Object.values(tui.data).filter(belongs)) {
            if (s.status === 'exited') continue;
            const a = agents.data[s.conversationId];
            if (
              s.status !== 'running' ||
              a?.source !== 'hook' ||
              a.conversationId !== s.conversationId ||
              !['idle', 'completed'].includes(a.status) ||
              a.notificationType ||
              a.updatedAt < s.startedAt ||
              a.updatedAt <= (s.lastInputAt ?? 0)
            )
              throw new Error(
                `${task.name}: its agent has not confirmed it is idle. Open work to check it.`
              );
          }
        };
        await assertIdle();
        const records = await client.workspaceRegistry.records.state(undefined, 'list').snapshot();
        const missing = records.data[task.workspaceId]?.observedStatus === 'missing';
        if (!missing) {
          // Preflight fresh Git state before closing sessions; unknown hosts fail closed.
          const checked = await client.workspaceRegistry.cleanDependencies({
            workspaceId: task.workspaceId,
            checkOnly: true,
          });
          if (!checked.success)
            throw new Error(
              'message' in checked.error ? checked.error.message : checked.error.type
            );
        }
        const git = records.data[task.workspaceId]?.git;
        let note = saved ?? {
          taskId: task.id,
          projectId: input.projectId,
          name: task.name,
          context: input.context ?? task.name,
          workspacePath: identity.path,
          branch: git?.branch ?? null,
          commit: git?.headOid ?? null,
          urls: (task.prs ?? []).map((pr) => pr.url),
          savedAt: new Date().toISOString(),
          archived: false,
          cleaned: false,
          message: 'Context saved; archive not yet confirmed.',
        };
        // A durable note is required before ending a session or removing any files.
        note = {
          ...note,
          context: input.context ?? note.context,
          // A retained checkout may have changed since the first cleanup attempt.
          // Preserve the saved references only when removal already succeeded.
          ...(!missing && {
            name: task.name,
            workspacePath: identity.path,
            branch: git?.branch ?? note.branch,
            commit: git?.headOid ?? note.commit,
            urls: (task.prs ?? []).map((pr) => pr.url),
          }),
        };
        await notes.save(note);
        await assertIdle();
        if (!task.archivedAt) await archive(input);
        const finish = async (cleaned: boolean, message: string) => {
          await notes.save({ ...note, archived: true, cleaned, message });
          return { archived: true, cleaned, message };
        };
        try {
          // The host checks live sessions again under its workspace claim; failure to
          // close an idle agent must never be reported as successful cleanup.
          if (!missing) {
            const cleaned = await client.workspaceRegistry.cleanDependencies({
              workspaceId: task.workspaceId,
            });
            if (!cleaned.success)
              throw new Error(
                'message' in cleaned.error ? cleaned.error.message : cleaned.error.type
              );
          }
          const retired = await client.workspaceRegistry.retireCheckout({
            workspaceId: task.workspaceId,
          });
          if (!retired.success)
            throw new Error(
              'message' in retired.error ? retired.error.message : retired.error.type
            );
        } catch (error) {
          return finish(
            false,
            `${task.name}: archived; checkout kept at ${identity.path}. ${error instanceof Error ? error.message : String(error)} Retry cleanup when resolved. Saved context and branch are kept.`
          );
        }
        return finish(
          true,
          `${task.name}: archived; checkout removed. Saved context and Git branch are kept. Start new work if you need to revisit it.`
        );
      } finally {
        pending.delete(input.taskId);
      }
    },
    {
      list: (offset: number) => notes.list(offset),
      read: (input: WorkTarget) => notes.read(input),
      restore: async (input: WorkTarget) => {
        if (pending.has(input.taskId))
          throw new Error('Wait for cleanup to finish before restoring this work.');
        pending.add(input.taskId);
        try {
          const task = (await taskService.getTasks(input.projectId)).find(
            (t) => t.id === input.taskId
          );
          if (!task?.workspaceId) throw new Error('This work is unavailable.');
          const identity = await workspaceIdentity.resolve(task.workspaceId);
          if (!identity || identity.projectId !== input.projectId)
            throw new Error('Work belongs to a different project.');
          const host = await runtimes.client(identity.host);
          if (!host.success) throw new Error('Reconnect to the computer owning this work.');
          const records = await host.data.workspaceRegistry.records
            .state(undefined, 'list')
            .snapshot();
          if (records.data[task.workspaceId]?.observedStatus !== 'present')
            throw new Error('The saved checkout is unavailable. Open Inspect work to locate it.');
          await restore(task.id);
          return {
            restored: true,
            message: `${task.name}: restored with its original conversation and branch. Reinstall dependencies with project setup when needed.`,
          };
        } finally {
          pending.delete(input.taskId);
        }
      },
    }
  );
}

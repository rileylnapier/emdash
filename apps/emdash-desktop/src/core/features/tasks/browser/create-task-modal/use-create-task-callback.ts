import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaskManagerStore } from '@core/features/tasks/api/browser/task-state/task-selectors';
import type { InitialConversationState } from '@core/features/tasks/contributions/browser/task-config/initial-conversation-section';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { log } from '@core/primitives/logging/browser/logger';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';
import { buildInitialConversation, deriveInitialStatus } from './build-create-task-params';
import type { CreateTaskState } from './use-create-task-state';

export interface TaskHandoff {
  taskId: string;
  projectId: string;
  name: string;
}
export interface TaskHandoffCallbacks {
  onBeforeCreate?: (task: TaskHandoff) => Promise<void>;
  onCreateFailed?: (task: TaskHandoff, error: string) => Promise<void>;
}
interface UseCreateTaskCallbackParams extends TaskHandoffCallbacks {
  selectedProjectId: string | undefined;
  state: CreateTaskState;
  initialConversation: InitialConversationState;
  navigate: NavigateFnTyped;
  onCreated: () => void;
}

export function useCreateTaskCallback({
  selectedProjectId,
  state,
  initialConversation,
  navigate,
  onCreated,
  onBeforeCreate,
  onCreateFailed,
}: UseCreateTaskCallbackParams): {
  handleCreateTask: () => void;
  canCreate: boolean;
  createError: string | null;
} {
  const submitting = useRef(false);
  const mounted = useRef(true);
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const canCreate = !!selectedProjectId && state.isValid && initialConversation.settingsReady;

  const handleCreateTask = useCallback(async () => {
    if (!selectedProjectId || !canCreate || submitting.current) return;
    const taskManager = getTaskManagerStore(selectedProjectId);
    if (!taskManager) return;

    submitting.current = true;
    setCreateError(null);
    try {
      await initialConversation.flushSettings();
    } catch (error) {
      submitting.current = false;
      log.error('Could not save conversation settings', error);
      setCreateError('Could not save conversation settings. Try again.');
      return;
    }
    const id = crypto.randomUUID();
    const handoff = {
      taskId: id,
      projectId: selectedProjectId,
      name: state.taskName.effectiveTaskName,
    };
    try {
      if (!mounted.current) return;
      await onBeforeCreate?.(handoff);
      if (!mounted.current) {
        await onCreateFailed?.(handoff, 'Task creation was cancelled before work started.');
        return;
      }
    } catch (error) {
      submitting.current = false;
      if (mounted.current)
        setCreateError(
          error instanceof Error ? error.message : 'Could not save the work handoff. Try again.'
        );
      return;
    }
    void taskManager
      .createTask({
        id,
        projectId: selectedProjectId,
        taskConfig: {
          version: '1',
          name: state.taskName.effectiveTaskName,
          linkedIssue: state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined,
          initialStatus: deriveInitialStatus(state.linkedType, state.linkedPR),
          initialConversation: buildInitialConversation(initialConversation),
        },
        workspaceConfig: state.workspaceConfig.resolvedConfig,
      })
      .catch(async (e: unknown) => {
        log.error('create task failed', e);
        try {
          await onCreateFailed?.(
            handoff,
            'Task creation failed. Open Inspect work for details before retrying.'
          );
        } catch (error) {
          log.error('Could not report task creation failure', error);
        }
      });

    navigate(taskViewDef({ projectId: selectedProjectId, taskId: id }));
    onCreated();
  }, [
    selectedProjectId,
    state,
    initialConversation,
    navigate,
    onCreated,
    canCreate,
    onBeforeCreate,
    onCreateFailed,
  ]);

  return { handleCreateTask: () => void handleCreateTask(), canCreate, createError };
}

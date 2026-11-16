import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAllowlistedAgentEnv } from '@emdash/core/primitives/agent-env/api';
import type { Scope } from '@emdash/shared/concurrency';
import { createController } from '@emdash/wire/rpc';
import { app, dialog, utilityProcess, type UtilityProcess } from 'electron';
import { z } from 'zod';
import { listPlugins } from '@core/features/agents/api/node/plugin-registry';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { AgentEvent } from '@core/primitives/agents/api/agent-events';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Project } from '@core/primitives/projects/api';
import {
  taixuContract,
  followupReceiptSchema,
  followupInputSchema,
  workTargetSchema,
  mergeReceiptSchema,
  type WorkFollowup,
  type WorkTarget,
  type MergeReceiptInput,
} from '../api/contract';
import { requestApps } from './apps-channel';
import { prepareDataHome } from './data-home';
import { readProjectDocuments } from './project-documents';
import { registerHeadUpdateGuard } from './update-guard';
import type { ArchiveWork } from './work-archive';
import { WorkFollowupUnavailable } from './work-followup';
import type { createWorkMerge } from './work-merge';

export function createTaixuWireController({
  readProjects,
  readConversations,
  taskService,
  scope,
  resolveProvider,
  onAgentEvent,
  readWorkReply,
  readWorkImageContext,
  prepareFollowup,
  workMerge,
  archiveWork,
}: {
  readProjects: () => Promise<Project[]>;
  readConversations: () => Promise<Conversation[]>;
  taskService: Pick<TaskService, 'getTasks'>;
  scope: Scope;
  onAgentEvent?: (listener: (event: AgentEvent) => Promise<void>) => () => void;
  workMerge?: ReturnType<typeof createWorkMerge>;
  archiveWork?: ArchiveWork;
  prepareFollowup?: (input: WorkFollowup) => Promise<() => Promise<void>>;
  readWorkReply?: (event: AgentEvent) => Promise<string | undefined>;
  readWorkImageContext?: (target: WorkTarget) => Promise<{ workspacePath: string } | null>;
  resolveProvider: (
    provider: 'claude' | 'codex'
  ) => Promise<{ bin: string; env: Record<string, string> }>;
}) {
  let child: UtilityProcess | undefined;
  // While Studio is selected the Heads do not run here; this host reports this Mac's apps.
  let appsWorker: UtilityProcess | undefined;
  let url: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<{ url: string | null; error: string | null }> | undefined;
  let activeSubmissions = 0;
  let updateHeld = false;
  const targets = new Map<string, string>();
  type WorkReport = AgentEvent & { imageContext?: { workspacePath: string } | null };
  const pendingEvents = new Map<string, WorkReport>();
  const targetSchema = z.array(z.object({ taskId: z.string(), projectId: z.string() }));
  function replayEvents(worker: UtilityProcess) {
    for (const [id, event] of pendingEvents) worker.postMessage({ type: 'work-event', id, event });
  }
  if (onAgentEvent)
    scope.add(
      onAgentEvent(async (event) => {
        if (targets.get(event.taskId) !== event.projectId || event.type === 'start') return;
        let reply = event.payload.lastAssistantMessage;
        if (event.type === 'stop' && !reply) {
          try {
            reply = await readWorkReply?.(event);
          } catch {
            /* Show an honest fallback. */
          }
        }
        // Only bounded, attributed reports for explicitly linked tasks cross this channel.
        const report: WorkReport = {
          type: event.type,
          providerId: event.providerId,
          projectId: event.projectId,
          taskId: event.taskId,
          conversationId: event.conversationId,
          timestamp: event.timestamp,
          payload: {
            notificationType: event.payload.notificationType,
            message: event.payload.message?.slice(0, 2000),
            lastAssistantMessage: reply?.slice(0, 24000),
          },
        };
        if (event.type === 'stop' && readWorkImageContext) {
          try {
            report.imageContext = await readWorkImageContext({
              taskId: event.taskId,
              projectId: event.projectId,
            });
          } catch {
            /* A later chat refresh can recover the image context. */
          }
        }
        pendingEvents.set(randomUUID(), report);
        try {
          if (child) replayEvents(child);
        } catch {
          /* Retry after reconnect. */
        }
      })
    );
  const configFile = path.join(app.getPath('userData'), 'taixu.json');
  // The Heads and the laptop-only apps host both hold app actions while Taixu updates itself.
  function holdWorker(worker: UtilityProcess, hold: boolean) {
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const done = (error?: string) => {
        clearTimeout(timeout);
        worker.removeListener('message', onMessage);
        worker.removeListener('exit', onExit);
        if (error) reject(new Error(error));
        else resolve();
      };
      const onExit = () => done('The Heads stopped before update readiness was confirmed.');
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'update-held' &&
          'id' in message &&
          message.id === id
        )
          done('error' in message && typeof message.error === 'string' ? message.error : undefined);
      };
      const timeout = setTimeout(
        () => done('Could not check the Heads. Restart Taixu before updating.'),
        5000
      );
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      try {
        worker.postMessage({ type: 'update-hold', id, hold });
      } catch {
        done('Could not check the Heads. Restart Taixu before updating.');
      }
    });
  }
  scope.add(
    registerHeadUpdateGuard(async (hold) => {
      if (hold && activeSubmissions)
        throw new Error('A work submission is in progress. Wait for its result before updating.');
      if (connecting) throw new Error('The Heads are still starting. Try updating again shortly.');
      const previouslyHeld = updateHeld;
      // Block new approvals before awaiting the utility process acknowledgement.
      if (hold) updateHeld = true;
      // A refusing worker keeps its previous state; release only those that accepted.
      const accepted: UtilityProcess[] = [];
      try {
        for (const worker of [child, appsWorker]) {
          if (!worker) continue;
          await holdWorker(worker, hold);
          accepted.push(worker);
        }
        updateHeld = hold;
      } catch (error) {
        updateHeld = previouslyHeld;
        for (const worker of accepted) await holdWorker(worker, previouslyHeld).catch(() => {});
        throw error;
      }
    })
  );

  function stop() {
    clearTimeout(timer);
    const previous = child;
    child = undefined;
    url = null;
    if (previous) {
      try {
        previous.postMessage({ type: 'stop' });
      } catch {
        /* Already exited. */
      }
      const kill = setTimeout(() => previous.kill(), 2500);
      kill.unref();
      previous.once('exit', () => clearTimeout(kill));
    }
  }
  scope.add(stop);
  app.on('before-quit', stop);
  scope.add(() => {
    app.removeListener('before-quit', stop);
  });

  // Status comes from the app's services; replies travel separately for linked tasks only.
  async function publish(process: UtilityProcess) {
    try {
      replayEvents(process);
      const [projects, tasks, conversations] = await Promise.all([
        readProjects(),
        taskService.getTasks(),
        readConversations(),
      ]);
      if (child !== process) return;
      process.postMessage({
        type: 'snapshot',
        snapshot: {
          at: new Date().toISOString(),
          providers: listPlugins()
            .filter((p) => ['claude', 'codex'].includes(p.metadata.id))
            .map((p) => ({
              id: p.metadata.id,
              label: p.metadata.id === 'codex' ? 'OpenAI / Codex' : 'Claude',
              models:
                p.capabilities.models?.kind === 'selectable'
                  ? Object.entries(p.capabilities.models.modelOptions).map(([id, value]) => ({
                      id,
                      label: value.name,
                    }))
                  : [],
            })),
          projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.path, type: p.type })),
          tasks: tasks.map((t) => ({
            id: t.id,
            projectId: t.projectId,
            name: t.name,
            status: t.status,
            updatedAt: t.updatedAt,
            archivedAt: t.archivedAt,
          })),
          conversations: conversations.map((c) => ({
            id: c.id,
            projectId: c.projectId,
            taskId: c.taskId,
            providerId: c.providerId,
            agentStatus: c.agentStatus,
          })),
        },
      });
    } catch {
      /* The last successful snapshot expires in Taixu after 15 seconds. */
    } finally {
      if (child === process) timer = setTimeout(() => void publish(process), 5000);
    }
  }

  async function connect(chooseFolder?: boolean) {
    if (url && !chooseFolder) return { url, error: null };
    let root: string | undefined = process.env.TAIXU_ROOT;
    if (!root) {
      try {
        const saved: unknown = JSON.parse(await readFile(configFile, 'utf8'));
        if (saved && typeof saved === 'object' && 'root' in saved && typeof saved.root === 'string')
          root = saved.root;
      } catch {
        /* First launch. */
      }
    }
    let dataRoot: string | undefined;
    if (app.isPackaged && !process.env.TAIXU_ROOT) {
      const runtime = path.join(process.resourcesPath, 'taixu-runtime');
      await access(path.join(runtime, 'apps/taixu/server/desktop.mjs'));
      dataRoot = await prepareDataHome(app.getPath('userData'), runtime, root);
      root = runtime;
      chooseFolder = false;
    }
    if (!root && !app.isPackaged) root = path.resolve(app.getAppPath(), '../../../..');
    if (chooseFolder || !root) {
      const selection = await dialog.showOpenDialog({
        title: 'Choose your LoveLife folder',
        properties: ['openDirectory'],
      });
      if (selection.canceled)
        return { url, error: url ? null : 'Choose your LoveLife folder to open Taixu.' };
      root = selection.filePaths[0];
    }
    if (!root) return { url: null, error: 'No LoveLife folder selected.' };
    const entry = path.join(root, 'apps/taixu/server/desktop.mjs');
    try {
      await access(entry);
      await access(path.join(root, 'apps/taixu/dist/index.html'));
      await access(path.join(root, 'packages/wuwei/projects.json'));
    } catch {
      return {
        url,
        error:
          'This folder needs a built Taixu app. Build Taixu in LoveLife, then choose the folder again.',
      };
    }
    stop();
    if (!dataRoot) await writeFile(configFile, JSON.stringify({ root }), { mode: 0o600 });
    const env = { ...process.env };
    env.TAIXU_APP_SERVICES = app.isPackaged && process.platform === 'darwin' ? '1' : '0';
    env.TAIXU_APP_BUNDLE = app.isPackaged ? path.resolve(app.getPath('exe'), '../../..') : '';
    if (dataRoot) env.TAIXU_DATA_ROOT = dataRoot;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.CLAUDECODE;
    const worker = utilityProcess.fork(entry, [], {
      cwd: dataRoot ?? root,
      env,
      stdio: 'ignore',
      serviceName: 'Taixu Heads',
    });
    child = worker;
    const headRequests = new Map<string, { cancelled: boolean }>();
    return await new Promise<{ url: string | null; error: string | null }>((resolve) => {
      let settled = false;
      const finish = (result: { url: string | null; error: string | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      const deadline = setTimeout(() => {
        stop();
        finish({ url: null, error: 'Taixu took too long to start. Try again.' });
      }, 15000);
      worker.on('message', (message: unknown) => {
        if (child !== worker) return;
        if (message && typeof message === 'object') {
          if (
            'type' in message &&
            message.type === 'work-recorded' &&
            'id' in message &&
            typeof message.id === 'string'
          ) {
            pendingEvents.delete(message.id);
            return;
          }
          if ('type' in message && message.type === 'ready' && 'workTargets' in message) {
            const parsed = targetSchema.safeParse(message.workTargets);
            if (parsed.success) {
              targets.clear();
              for (const target of parsed.data) targets.set(target.taskId, target.projectId);
            }
          }
        }
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'head-work-cancel' &&
          'id' in message &&
          typeof message.id === 'string'
        ) {
          const request = headRequests.get(message.id);
          if (request) request.cancelled = true;
          return;
        }
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'head-work-request'
        ) {
          const request = z
            .object({
              id: z.string().uuid(),
              action: z.enum(['refresh', 'send', 'image-context']),
              input: z.unknown(),
              expiresAt: z.number().int().positive(),
            })
            .safeParse(message);
          if (!request.success) return;
          const { id, action, input, expiresAt } = request.data;
          if (headRequests.has(id)) return;
          const pending = { cancelled: false };
          headRequests.set(id, pending);
          const canSubmit = () => child === worker && !pending.cancelled && Date.now() < expiresAt;
          void (async () => {
            if (updateHeld || !canSubmit()) throw new Error('Work request stopped.');
            if (action === 'send') return followupWork(followupInputSchema.parse(input), canSubmit);
            const { targets: requested } = z
              .object({ targets: z.array(workTargetSchema).max(100) })
              .parse(input);
            if (action === 'image-context') {
              const contexts: (WorkTarget & { workspacePath?: string })[] = [];
              for (const target of requested) {
                if (!canSubmit() || updateHeld) break;
                if (targets.get(target.taskId) !== target.projectId || !readWorkImageContext)
                  continue;
                try {
                  const context = await readWorkImageContext(target);
                  contexts.push({ ...target, ...context });
                } catch {
                  /* Leave unresolved reports eligible for a later refresh. */
                }
              }
              return contexts;
            }
            const observations: Awaited<ReturnType<NonNullable<typeof workMerge>['observe']>>[] =
              [];
            // Only explicit linked targets; no background GitHub polling or broad account scan.
            for (const target of requested) {
              if (!canSubmit() || updateHeld) break;
              if (targets.get(target.taskId) !== target.projectId || !workMerge) continue;
              try {
                observations.push(await workMerge.observe(target));
              } catch {
                /* Unknown is not merged. */
              }
            }
            return observations;
          })()
            .then(
              (result) => {
                if (child === worker) worker.postMessage({ type: 'head-work-result', id, result });
              },
              () => {
                if (child === worker)
                  worker.postMessage({
                    type: 'head-work-result',
                    id,
                    error: 'Work request unavailable.',
                  });
              }
            )
            .finally(() => headRequests.delete(id));
          return;
        }
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'documents-request' &&
          'id' in message &&
          typeof message.id === 'string' &&
          'projectId' in message &&
          typeof message.projectId === 'string'
        ) {
          const { id, projectId } = message;
          void readProjects()
            .then(async (projects) => {
              const project = projects.find((p) => p.id === projectId);
              if (!project) throw new Error('Project unavailable');
              return readProjectDocuments(project);
            })
            .then((evidence) => {
              if (child === worker)
                worker.postMessage({ type: 'documents-response', id, evidence });
            })
            .catch(() => {
              if (child === worker)
                worker.postMessage({
                  type: 'documents-response',
                  id,
                  error:
                    'Could not read product documentation. Check that the local project folder is available.',
                });
            });
          return;
        }
        // Launch configuration travels only over the owned parent channel, never HTTP or the renderer.
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'provider-request' &&
          'id' in message &&
          typeof message.id === 'string' &&
          'provider' in message &&
          (message.provider === 'claude' || message.provider === 'codex')
        ) {
          const id = message.id;
          void resolveProvider(message.provider)
            .then((value) => {
              if (child === worker)
                worker.postMessage({
                  type: 'provider-response',
                  id,
                  context: {
                    bin: value.bin,
                    env: buildAllowlistedAgentEnv({ ...process.env, ...value.env }),
                  },
                });
            })
            .catch(() => {
              if (child === worker)
                worker.postMessage({
                  type: 'provider-response',
                  id,
                  error:
                    'Check this provider in Models & accounts. Its configured executable could not be resolved.',
                });
            });
          return;
        }
        if (
          !message ||
          typeof message !== 'object' ||
          !('url' in message) ||
          typeof message.url !== 'string'
        )
          return;
        if (
          !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/\?desktop=1$/.test(message.url) ||
          child !== worker
        )
          return;
        url = message.url;
        void publish(worker);
        finish({ url, error: null });
      });
      worker.once('exit', () => {
        if (child === worker) {
          child = undefined;
          url = null;
          clearTimeout(timer);
        }
        finish({
          url: null,
          error: 'Taixu could not start. Try restarting the app.',
        });
      });
    });
  }

  function requireMerge(target: WorkTarget) {
    if (!workMerge || targets.get(target.taskId) !== target.projectId)
      throw new Error('This work is not linked to a Head conversation.');
    if (!child || !url || updateHeld)
      throw new Error('Reconnect to Taixu after the update before reviewing a merge.');
    return workMerge;
  }
  function recordMerge(input: MergeReceiptInput) {
    const worker = child;
    if (!worker) throw new Error('Taixu disconnected before saving the merge receipt.');
    return new Promise<z.infer<typeof mergeReceiptSchema>>((resolve, reject) => {
      const id = randomUUID();
      const done = (value?: unknown, error?: string) => {
        clearTimeout(timeout);
        worker.removeListener('message', onMessage);
        worker.removeListener('exit', onExit);
        const parsed = mergeReceiptSchema.safeParse(value);
        if (error || !parsed.success) reject(new Error(error ?? 'Merge receipt unavailable.'));
        else resolve(parsed.data);
      };
      const onExit = () => done(undefined, 'Taixu disconnected.');
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'work-merge-result' &&
          'id' in message &&
          message.id === id
        )
          done(
            message,
            'error' in message && typeof message.error === 'string' ? message.error : undefined
          );
      };
      const timeout = setTimeout(() => done(undefined, 'Merge receipt not confirmed.'), 5000);
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      try {
        worker.postMessage({ type: 'work-merge', id, input });
      } catch {
        onExit();
      }
    });
  }

  async function recordArchive(
    input: WorkTarget & { status: string; archived?: boolean; cleaned?: boolean; message: string }
  ) {
    const worker = child;
    if (!worker)
      throw new Error('Taixu disconnected before saving the archive result. Retry to reconcile.');
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const done = (error?: string) => {
        clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('exit', onExit);
        if (error) reject(new Error(error));
        else resolve();
      };
      const onExit = () => done('Taixu disconnected. Retry to reconcile archive status.');
      const onMessage = (data: unknown) => {
        if (
          data &&
          typeof data === 'object' &&
          'type' in data &&
          data.type === 'work-archive-result' &&
          'id' in data &&
          data.id === id
        )
          done('error' in data ? String(data.error) : undefined);
      };
      const timer = setTimeout(
        () => done('Archive result was not confirmed. Retry to reconcile; history is kept.'),
        5000
      );
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      try {
        worker.postMessage({ type: 'work-archive', id, input });
      } catch {
        onExit();
      }
    });
  }

  async function followupWork(input: WorkFollowup, canSubmit = () => true) {
    if (updateHeld) return { status: 'failed' as const, message: 'Not sent: Taixu is updating.' };
    activeSubmissions++;
    try {
      return await submitFollowup(input, canSubmit);
    } finally {
      activeSubmissions--;
    }
  }

  async function submitFollowup(input: WorkFollowup, canSubmit: () => boolean) {
    if (targets.get(input.taskId) !== input.projectId || !prepareFollowup)
      return {
        status: 'failed' as const,
        message: 'Not sent: this work is not linked to a Head conversation.',
      };
    const task = (await taskService.getTasks(input.projectId)).find((t) => t.id === input.taskId);
    if (!task || task.archivedAt)
      return {
        status: 'failed' as const,
        message: 'Not sent: this work is no longer available.',
      };
    const worker = child;
    if (!worker || !url || updateHeld)
      return {
        status: 'failed' as const,
        message: 'Not sent: reconnect after the update before sending changes.',
      };
    if (workMerge) {
      try {
        const observation = await workMerge.observe(input);
        worker.postMessage({ type: 'work-observation', input: observation });
        if (observation.status === 'merged')
          return {
            status: 'failed' as const,
            message: 'This work is merged. Start a new brief for subsequent changes.',
          };
      } catch {
        /* No PR yet or GitHub unavailable; native agent readiness is still checked. */
      }
    }
    const checkConnection = () => {
      if (child !== worker || !url || updateHeld || !canSubmit())
        throw new WorkFollowupUnavailable('Not sent: the request stopped or Taixu disconnected.');
    };
    checkConnection();
    const record = (status: 'pending' | 'sent' | 'failed' | 'unknown') =>
      new Promise<z.infer<typeof followupReceiptSchema>>((resolve, reject) => {
        const id = randomUUID();
        const done = (message?: unknown, error?: string) => {
          clearTimeout(timeout);
          worker.removeListener('message', onMessage);
          worker.removeListener('exit', onExit);
          const parsed = followupReceiptSchema.safeParse(message);
          if (error || !parsed.success)
            reject(new Error(error ?? 'Could not confirm the follow-up receipt.'));
          else resolve(parsed.data);
        };
        const onExit = () => done(undefined, 'Taixu disconnected.');
        const onMessage = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'work-followup-result' &&
            'id' in message &&
            message.id === id
          )
            done(
              message,
              'error' in message && typeof message.error === 'string' ? message.error : undefined
            );
        };
        const timeout = setTimeout(
          () => done(undefined, 'Could not confirm delivery. Check the work before sending again.'),
          5000
        );
        worker.on('message', onMessage);
        worker.once('exit', onExit);
        try {
          worker.postMessage({ type: 'work-followup', id, input: { ...input, status } });
        } catch {
          done(undefined, 'Taixu disconnected.');
        }
      });
    const receipt = await record('pending');
    if (!receipt.created)
      return {
        status: receipt.status === 'pending' ? ('unknown' as const) : receipt.status,
        message:
          receipt.status === 'sent'
            ? 'These changes were already submitted to the agent.'
            : receipt.status === 'failed'
              ? 'This follow-up was not submitted. Open the work before sending again.'
              : 'Delivery was not confirmed. Open the work before sending again.',
      };
    try {
      checkConnection();
      const send = await prepareFollowup(input);
      checkConnection();
      await send();
      await record('sent');
      return {
        status: 'sent' as const,
        message: 'Changes submitted to the same agent. Its next reply will return to your chat.',
      };
    } catch (error) {
      const status =
        error instanceof WorkFollowupUnavailable ? ('failed' as const) : ('unknown' as const);
      try {
        await record(status);
      } catch {
        /* Pending receipt prevents automatic replay. */
      }
      return {
        status,
        message:
          error instanceof WorkFollowupUnavailable
            ? error.message
            : 'Delivery was not confirmed. Open the work before sending again.',
      };
    }
  }

  function localAppsHost(): UtilityProcess {
    // Keep one hub per Mac once started, so an Update all job is never split.
    if (appsWorker) return appsWorker;
    if (child) return child;
    const root =
      app.isPackaged && !process.env.TAIXU_ROOT
        ? path.join(process.resourcesPath, 'taixu-runtime')
        : (process.env.TAIXU_ROOT ?? path.resolve(app.getAppPath(), '../../../..'));
    const env = { ...process.env };
    env.TAIXU_APP_SERVICES = app.isPackaged && process.platform === 'darwin' ? '1' : '0';
    env.TAIXU_APP_BUNDLE = app.isPackaged ? path.resolve(app.getPath('exe'), '../../..') : '';
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const worker = utilityProcess.fork(path.join(root, 'apps/taixu/server/apps-host.mjs'), [], {
      cwd: root,
      env,
      stdio: 'ignore',
      serviceName: 'Taixu Apps',
    });
    appsWorker = worker;
    worker.once('exit', () => {
      if (appsWorker === worker) appsWorker = undefined;
    });
    if (updateHeld) worker.postMessage({ type: 'update-hold', id: randomUUID(), hold: true });
    return worker;
  }
  scope.add(() => {
    appsWorker?.postMessage({ type: 'stop' });
    appsWorker = undefined;
  });

  return createController(taixuContract, {
    apps: () => {
      if (!child || !url) throw new Error('Reconnect to Taixu to check its apps.');
      return requestApps(child);
    },
    appAction: async (input) => {
      if (!child || !url || updateHeld)
        throw new Error('Reconnect after Taixu finishes starting or updating.');
      activeSubmissions++;
      try {
        return await requestApps(child, input);
      } finally {
        activeSubmissions--;
      }
    },
    localApps: () => requestApps(localAppsHost()),
    localAppAction: async (input) => {
      if (updateHeld) throw new Error('Reconnect after Taixu finishes updating.');
      activeSubmissions++;
      try {
        return await requestApps(localAppsHost(), input);
      } finally {
        activeSubmissions--;
      }
    },
    connect: ({ chooseFolder }) => {
      connecting ??= connect(chooseFolder)
        .catch(() => ({
          url: null,
          error:
            'Could not open Taixu. Check the app installation and its saved data, then try again.',
        }))
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    },
    status: () => ({ running: !!child && !!url }),
    readArchive: (input) => archiveWork?.read(input) ?? Promise.resolve(null),
    listArchives: ({ offset }) =>
      archiveWork?.list(offset) ?? Promise.resolve({ notes: [], nextOffset: null }),
    archiveWork: async (input) => {
      if (updateHeld) throw new Error('Wait for the Taixu update before archiving.');
      if (
        !(await taskService.getTasks(input.projectId)).some(
          (task) => task.id === input.taskId && task.projectId === input.projectId
        )
      )
        throw new Error('This work is not in the selected project.');
      const linked = targets.get(input.taskId) === input.projectId;
      const receipt = (value: Parameters<typeof recordArchive>[0]) =>
        linked ? recordArchive(value) : Promise.resolve();
      if (!archiveWork) throw new Error('Archiving is unavailable.');
      activeSubmissions++;
      try {
        await receipt({
          ...input,
          status: 'pending',
          message: 'Checking archive and cleanup readiness.',
        });
        let result;
        try {
          result = await archiveWork(input);
        } catch (error) {
          await receipt({
            ...input,
            status: 'blocked',
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        await receipt({ ...input, ...result, status: 'archived' });
        return result;
      } finally {
        activeSubmissions--;
      }
    },
    restoreWork: async (input) => {
      requireMerge(input);
      if (!archiveWork) throw new Error('Restoring is unavailable.');
      activeSubmissions++;
      try {
        const result = await archiveWork.restore(input);
        await recordArchive({
          ...input,
          status: 'restored',
          archived: false,
          cleaned: false,
          message: result.message,
        });
        return result;
      } finally {
        activeSubmissions--;
      }
    },
    reviewMerge: async (target) => {
      const review = await requireMerge(target).review(target);
      if (review.pr.provider === 'github')
        child?.postMessage({
          type: 'work-observation',
          input: {
            ...target,
            status: review.pr.status,
            url: review.pr.url,
            at: new Date().toISOString(),
          },
        });
      return review;
    },
    approveMerge: async (input) => {
      const service = requireMerge(input);
      activeSubmissions++;
      try {
        return await service.approve(input, recordMerge);
      } finally {
        activeSubmissions--;
      }
    },
    followupWork: (input) => followupWork(input),
    linkWork: async (input) => {
      const worker = child;
      if (!worker || !url) throw new Error('Reconnect to Taixu before starting work.');
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID();
        const done = (error?: string) => {
          clearTimeout(timeout);
          worker.removeListener('message', onMessage);
          worker.removeListener('exit', onExit);
          if (error) reject(new Error(error));
          else resolve();
        };
        const onExit = () => done('Taixu disconnected before the work handoff was saved.');
        const onMessage = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'work-linked' &&
            'id' in message &&
            message.id === id
          ) {
            const error =
              'error' in message && typeof message.error === 'string' ? message.error : undefined;
            if (!error) targets.set(input.taskId, input.projectId);
            done(error);
          }
        };
        const timeout = setTimeout(
          () => done('Could not confirm the work handoff. Reconnect and try again.'),
          5000
        );
        worker.on('message', onMessage);
        worker.once('exit', onExit);
        try {
          worker.postMessage({ type: 'work-link', id, input });
        } catch {
          done('Could not save the work handoff. Reconnect and try again.');
        }
      });
      return { saved: true as const };
    },
    projectExists: async ({ projectId }) => (await readProjects()).some((p) => p.id === projectId),
    taskExists: async ({ projectId, taskId }) =>
      (await taskService.getTasks(projectId)).some((t) => t.id === taskId && !t.archivedAt),
  });
}

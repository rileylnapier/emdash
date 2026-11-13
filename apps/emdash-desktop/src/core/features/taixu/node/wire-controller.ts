import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Scope } from '@emdash/shared/concurrency';
import { createController } from '@emdash/wire/rpc';
import { app, dialog, utilityProcess, type UtilityProcess } from 'electron';
import type { TaskService } from '@core/features/tasks/api/node/task-service';
import type { Conversation } from '@core/primitives/conversations/api';
import type { Project } from '@core/primitives/projects/api';
import { taixuContract } from '../api/contract';

export function createTaixuWireController({
  readProjects,
  readConversations,
  taskService,
  scope,
}: {
  readProjects: () => Promise<Project[]>;
  readConversations: () => Promise<Conversation[]>;
  taskService: Pick<TaskService, 'getTasks'>;
  scope: Scope;
}) {
  let child: UtilityProcess | undefined;
  let url: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<{ url: string | null; error: string | null }> | undefined;
  const configFile = path.join(app.getPath('userData'), 'taixu.json');

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

  // Pull through the app's own services. No database paths, prompts, transcripts or credentials cross this boundary.
  async function publish(process: UtilityProcess) {
    try {
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
    if (!root && app.isPackaged) {
      try {
        const bundled: unknown = JSON.parse(
          await readFile(path.join(process.resourcesPath, 'taixu-root.json'), 'utf8')
        );
        if (
          bundled &&
          typeof bundled === 'object' &&
          'root' in bundled &&
          typeof bundled.root === 'string'
        )
          root = bundled.root;
      } catch {
        /* Generic fork builds ask for the local checkout on first launch. */
      }
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
    await writeFile(configFile, JSON.stringify({ root }), { mode: 0o600 });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.CLAUDECODE;
    const worker = utilityProcess.fork(entry, [], {
      cwd: root,
      env,
      stdio: 'ignore',
      serviceName: 'Taixu Heads',
    });
    child = worker;
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
          error: 'Taixu could not start. Check that your LoveLife checkout is built.',
        });
      });
    });
  }

  return createController(taixuContract, {
    connect: ({ chooseFolder }) => {
      connecting ??= connect(chooseFolder)
        .catch(() => ({
          url: null,
          error: 'Could not open Taixu. Choose your LoveLife folder and try again.',
        }))
        .finally(() => {
          connecting = undefined;
        });
      return connecting;
    },
    status: () => ({ running: !!child && !!url }),
    taskExists: async ({ projectId, taskId }) =>
      (await taskService.getTasks(projectId)).some((t) => t.id === taskId && !t.archivedAt),
  });
}

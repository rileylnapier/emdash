import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { settingsViewDef } from '@core/features/settings/contributions/views';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { confirmOpenExternalLink } from '@core/features/workbench/api/browser/open-external-link';
import { openModal } from '@core/manifests/browser/modal-api';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { getTaixuClient } from '../api/browser/client';
import { getStudioClient } from '../api/browser/studio-client';
import { workOriginSchema, type WorkOrigin } from '../api/contract';
import './taixu-shell.css';
import { AppsPanel } from './apps-panel';
import { ServerMode } from './server-mode';
import { StudioSelector } from './studio-selector';
import { UpdateButton } from './update-button';

const heads = ['Product', 'Marketing', 'Design', 'Eng'];

export function TaixuShell({
  workbench,
  inspecting,
  onInspect,
}: {
  workbench: ReactNode;
  inspecting: boolean;
  onInspect: (value: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasInspected, setHasInspected] = useState(inspecting);
  // Resolve the local preference before mounting WebGL, including on app restart.
  const [serverMode, setServerMode] = useState<boolean | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const loadMode = useCallback(async () => {
    try {
      const status = await (await getStudioClient()).status();
      setServerMode(status.serverMode);
    } catch {
      setError('Could not read the display mode. Retry to open Taixu.');
    }
  }, []);
  useEffect(() => {
    void loadMode();
  }, [loadMode]);
  const inspect = useCallback(
    (value: boolean) => {
      setAppsOpen(false);
      if (value) setHasInspected(true);
      onInspect(value);
    },
    [onInspect]
  );
  const connect = useCallback(async (chooseFolder = false) => {
    setBusy(true);
    try {
      const result = await (await getTaixuClient()).connect({ chooseFolder });
      setUrl(result.url);
      setError(result.error);
    } catch {
      setError('The desktop connection is unavailable. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    if (!url || serverMode) return;
    let disposed = false;
    const timer = setInterval(() => {
      void getTaixuClient()
        .then((client) => client.status({}))
        .then((status) => {
          if (!disposed && !status.running)
            setError('The Heads connection stopped. Retry to reconnect.');
        })
        .catch(() => {
          if (!disposed) setError('The desktop connection is unavailable. Retry to reconnect.');
        });
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [url, serverMode]);

  const changeMode = async (enabled: boolean) => {
    setModeBusy(true);
    try {
      await (await getStudioClient()).setServerMode({ enabled });
      setServerMode(enabled);
      inspect(false);
    } finally {
      setModeBusy(false);
    }
  };

  const createTask = useCallback(
    async (prompt?: string, projectId?: string, origin?: WorkOrigin, name?: string) => {
      // Opening the native review dialog does not launch work. Its Create button owns that action.
      if (projectId && !(await (await getTaixuClient()).projectExists({ projectId })))
        throw new Error('Project unavailable');
      const client = await getTaixuClient();
      await openModal('taskModal', {
        initialPrompt: prompt,
        initialName: name,
        projectId,
        ...(origin
          ? {
              onBeforeCreate: async (task) => {
                await client.linkWork({ ...task, origin });
              },
              onCreateFailed: async (task, error) => {
                await client.linkWork({ ...task, origin, error });
              },
            }
          : {}),
      });
    },
    []
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        !url ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== new URL(url).origin
      )
        return;
      const data: unknown = event.data;
      if (
        !data ||
        typeof data !== 'object' ||
        !('type' in data) ||
        data.type !== 'taixu' ||
        !('action' in data)
      )
        return;
      if (data.action === 'add-project') {
        void openModal('addProjectModal', {
          mode: 'pick',
          strategy: 'local',
          navigateOnCreate: false,
          promptConfigImport: false,
          onCreated: (projectId) =>
            frame.current?.contentWindow?.postMessage(
              { type: 'taixu-repository-added', projectId },
              new URL(url).origin
            ),
        }).catch(() => setError('Could not open the repository picker.'));
      } else if (data.action === 'accounts' || data.action === 'usage') {
        getNavigation().navigate(
          settingsViewDef({ tab: data.action === 'usage' ? 'usage' : 'clis-models' })
        );
        inspect(true);
      } else if (
        data.action === 'create-task' &&
        'prompt' in data &&
        typeof data.prompt === 'string' &&
        data.prompt.length <= 65536
      ) {
        const origin = 'origin' in data ? workOriginSchema.safeParse(data.origin) : undefined;
        if (origin && !origin.success) {
          setError('The originating chat is unavailable. Reopen the brief and try again.');
          return;
        }
        void createTask(
          data.prompt,
          'projectId' in data && typeof data.projectId === 'string' ? data.projectId : undefined,
          origin?.success ? origin.data : undefined,
          'name' in data && typeof data.name === 'string' && data.name.length <= 64
            ? data.name
            : undefined
        ).catch(() => setError('Could not open the task dialog. Try Inspect work.'));
      } else if (
        (data.action === 'review-merge' || data.action === 'archive-work') &&
        'taskId' in data &&
        typeof data.taskId === 'string' &&
        'projectId' in data &&
        typeof data.projectId === 'string'
      ) {
        const target = { taskId: data.taskId, projectId: data.projectId };
        void getTaixuClient()
          .then((client) =>
            data.action === 'archive-work'
              ? openModal('taixuArchiveModal', { ...target, client })
              : openModal('taixuMergeModal', { ...target, client })
          )
          .catch(() => setError('Could not open the work action. Reconnect and try again.'));
      } else if (
        data.action === 'followup-work' &&
        'taskId' in data &&
        typeof data.taskId === 'string' &&
        'projectId' in data &&
        typeof data.projectId === 'string' &&
        'text' in data &&
        typeof data.text === 'string' &&
        data.text.length <= 24000
      ) {
        const target = { taskId: data.taskId, projectId: data.projectId, initialText: data.text };
        void Promise.all([getTaixuClient(), getConversationsClient()])
          .then(async ([client, conversations]) => {
            if (!(await client.taskExists(target))) throw new Error('Work unavailable');
            await openModal('taixuFollowupModal', { ...target, client, conversations });
          })
          .catch(() => setError('Could not open this work for changes. Reconnect and try again.'));
      } else if (
        data.action === 'restore-work' &&
        'taskId' in data &&
        typeof data.taskId === 'string' &&
        'projectId' in data &&
        typeof data.projectId === 'string'
      ) {
        const target = { taskId: data.taskId, projectId: data.projectId };
        void getTaixuClient()
          .then(async (client) => {
            await client.restoreWork(target);
            getNavigation().navigate(taskViewDef(target));
            inspect(true);
          })
          .catch((error) =>
            setError(error instanceof Error ? error.message : 'Could not restore this work.')
          );
      } else if (
        data.action === 'inspect-task' &&
        'taskId' in data &&
        typeof data.taskId === 'string' &&
        'projectId' in data &&
        typeof data.projectId === 'string'
      ) {
        const target = { taskId: data.taskId, projectId: data.projectId };
        void getTaixuClient()
          .then(async (client) => {
            if (await client.taskExists(target)) {
              getNavigation().navigate(taskViewDef(target));
              inspect(true);
            } else setError('That task is no longer available.');
          })
          .catch(() => setError('Could not open that task. Try Inspect work.'));
      } else if (
        data.action === 'open-link' &&
        'url' in data &&
        typeof data.url === 'string' &&
        /^https?:\/\//.test(data.url)
      ) {
        void confirmOpenExternalLink(data.url);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [url, inspect, createTask]);

  const talk = (name: string) => {
    inspect(false);
    if (url)
      frame.current?.contentWindow?.postMessage(
        { type: 'taixu-head', head: `${name.toLowerCase()}-head` },
        new URL(url).origin
      );
  };
  return (
    <div className="taixu-shell">
      <header className="taixu-titlebar">
        <button className="taixu-brand" onClick={() => inspect(false)}>
          Taixu <span>LoveLife</span>
        </button>
        {serverMode !== true && (
          <>
            {serverMode === false && <StudioSelector onServerMode={() => changeMode(true)} />}
            <nav aria-label="The Heads">
              <button
                disabled={!url || serverMode === null}
                onClick={() => {
                  inspect(false);
                  if (url)
                    frame.current?.contentWindow?.postMessage(
                      { type: 'taixu-projects' },
                      new URL(url).origin
                    );
                }}
              >
                Your projects
              </button>
              {heads.map((h) => (
                <button key={h} onClick={() => talk(h)} disabled={!url || serverMode === null}>
                  {h}
                </button>
              ))}
            </nav>
          </>
        )}
        <div className="taixu-actions">
          <UpdateButton />
          {serverMode !== true && (
            <>
              <button
                aria-pressed={appsOpen}
                onClick={() => {
                  onInspect(false);
                  setAppsOpen(!appsOpen);
                }}
              >
                {appsOpen ? 'Back to Taixu' : 'Apps'}
              </button>
              <button
                onClick={() => {
                  getNavigation().navigate(settingsViewDef({ tab: 'clis-models' }));
                  inspect(true);
                }}
              >
                Models &amp; accounts
              </button>
              <button
                onClick={() => {
                  getNavigation().navigate(settingsViewDef({ tab: 'usage' }));
                  inspect(true);
                }}
              >
                Usage
              </button>
              <button onClick={() => inspect(!inspecting)}>
                {inspecting ? 'Back to Taixu' : 'Inspect work'}
              </button>
            </>
          )}
        </div>
      </header>
      {serverMode === true ? (
        <ServerMode
          url={url}
          busy={busy || modeBusy}
          error={error}
          onReconnect={() => void connect()}
          onOpenWorld={() =>
            void changeMode(false).catch(() =>
              setError('Could not change display mode. Try again.')
            )
          }
        />
      ) : (
        <main
          className="taixu-world"
          hidden={inspecting || appsOpen}
          inert={inspecting || appsOpen}
        >
          {url && serverMode === false ? (
            <iframe
              ref={frame}
              src={url}
              title="Taixu and the Heads"
              sandbox="allow-scripts allow-same-origin"
            />
          ) : (
            <div className="taixu-setup">
              <h1>A place for your work.</h1>
              <p>
                {busy || serverMode === null
                  ? 'Opening Taixu…'
                  : 'Open Taixu, then add a repository from Your projects.'}
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  void loadMode();
                  void connect();
                }}
              >
                Open Taixu
              </button>
            </div>
          )}
        </main>
      )}
      {appsOpen && serverMode === false && (
        <main className="taixu-apps-page">
          <AppsPanel />
        </main>
      )}
      {(hasInspected || inspecting) && (
        <div
          className="taixu-workbench"
          hidden={!inspecting || serverMode === true || appsOpen}
          inert={!inspecting || serverMode === true || appsOpen}
        >
          {workbench}
        </div>
      )}
      {error && serverMode !== true && (
        <aside className="taixu-error" role="alert">
          <span>{error}</span>
          <button
            disabled={busy}
            onClick={() => {
              void loadMode();
              void connect();
            }}
          >
            Retry
          </button>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </aside>
      )}
    </div>
  );
}

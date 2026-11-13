import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { taskViewDef } from '@core/features/tasks/contributions/views';
import { confirmOpenExternalLink } from '@core/features/workbench/api/browser/open-external-link';
import { openModal } from '@core/manifests/browser/modal-api';
import { getNavigation } from '@core/primitives/navigation/browser/navigation-selectors';
import { getTaixuClient } from '../api/browser/client';
import './taixu-shell.css';

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
  const inspect = useCallback(
    (value: boolean) => {
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
    if (!url) return;
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
  }, [url]);

  const createTask = useCallback(async (prompt?: string) => {
    // Opening the native review dialog does not launch work. Its Create button owns that action.
    await openModal('taskModal', { initialPrompt: prompt });
  }, []);

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
      if (
        data.action === 'create-task' &&
        'prompt' in data &&
        typeof data.prompt === 'string' &&
        data.prompt.length <= 65536
      ) {
        void createTask(data.prompt).catch(() =>
          setError('Could not open the task dialog. Try Inspect work.')
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
        <nav aria-label="The Heads">
          {heads.map((h) => (
            <button key={h} onClick={() => talk(h)} disabled={!url}>
              {h}
            </button>
          ))}
        </nav>
        <div className="taixu-actions">
          <button
            onClick={() =>
              void createTask().catch(() => setError('Could not open the task dialog.'))
            }
          >
            Start work
          </button>
          <button onClick={() => inspect(!inspecting)}>
            {inspecting ? 'Back to Taixu' : 'Inspect work'}
          </button>
        </div>
      </header>
      <main className="taixu-world" hidden={inspecting} inert={inspecting}>
        {url ? (
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
              {busy
                ? 'Opening Taixu…'
                : 'Connect your LoveLife folder to bring the village and the Heads into your desktop.'}
            </p>
            <button disabled={busy} onClick={() => void connect(true)}>
              Choose LoveLife folder
            </button>
          </div>
        )}
      </main>
      {(hasInspected || inspecting) && (
        <div className="taixu-workbench" hidden={!inspecting} inert={!inspecting}>
          {workbench}
        </div>
      )}
      {error && (
        <aside className="taixu-error" role="alert">
          <span>{error}</span>
          <button disabled={busy} onClick={() => void connect()}>
            Retry
          </button>
          <button disabled={busy} onClick={() => void connect(true)}>
            Choose folder
          </button>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </aside>
      )}
    </div>
  );
}

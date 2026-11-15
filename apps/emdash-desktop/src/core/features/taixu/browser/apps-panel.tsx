import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppAction, AppsStatus } from '../api/apps-contract';
import { getTaixuClient } from '../api/browser/client';

const labels = {
  running: 'Service running',
  idle: 'Needs attention',
  stopped: 'Stopped',
  'needs-install': 'Update required',
  planned: 'Coming later',
  unavailable: 'Unavailable',
};

export function AppsPanel() {
  const [status, setStatus] = useState<AppsStatus | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const generation = useRef({ id: 0 });
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const request = ++generation.current.id;
    setChecking(true);
    try {
      const result = await (await getTaixuClient()).apps({});
      if (mounted.current && request === generation.current.id) {
        setStatus(result);
        setReadError('');
      }
    } catch {
      if (mounted.current && request === generation.current.id) {
        setStatus(null);
        setReadError(
          'App status is unavailable. Reconnect to the selected computer, then refresh.'
        );
      }
    } finally {
      if (mounted.current && request === generation.current.id) setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const requests = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      disposed = true;
      mounted.current = false;
      requests.id++;
      clearTimeout(timer);
    };
  }, [refresh]);
  const act = async (input: AppAction) => {
    setBusy(input.appId);
    setError('');
    try {
      await (await getTaixuClient()).appAction(input);
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'App action was not confirmed. Refresh before trying again.'
        );
    } finally {
      if (mounted.current) {
        setBusy(null);
        await refresh();
      }
    }
  };
  return (
    <section className="taixu-apps" aria-label="Apps on selected computer">
      <div className="taixu-apps-heading">
        <div>
          <h2>Apps</h2>
          <p>
            {status
              ? `On ${status.computer}`
              : readError
                ? 'Selected computer unavailable'
                : 'Checking selected computer…'}
          </p>
        </div>
        <button
          disabled={checking || !!busy}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          Refresh
        </button>
      </div>
      <p className="taixu-apps-intro">
        Run apps on this computer without keeping their windows open. Services keep running when you
        close Taixu. Laptop access depends on each app.
      </p>
      {(error || readError) && (
        <p className="taixu-server-error" role="alert">
          {error || readError}
        </p>
      )}
      {status?.apps.map((app) => {
        const available = ['running', 'idle', 'stopped'].includes(app.state);
        const active = app.state === 'running' || app.state === 'idle';
        const stateLabel =
          app.id === 'flow' && active
            ? app.state === 'running'
              ? 'Sharing library'
              : 'Sharing off'
            : labels[app.state];
        const startLabel = active
          ? app.id === 'flow'
            ? 'Enable sharing'
            : 'Check service'
          : 'Start service';
        return (
          <article className="taixu-app-card" key={app.id} aria-label={app.name}>
            <div className="taixu-app-card-heading">
              <h3>{app.name}</h3>
              <span data-state={app.state}>{busy === app.id ? 'Working…' : stateLabel}</span>
            </div>
            <p>{app.detail}</p>
            {active && (
              <p className="taixu-app-meta">
                {app.windowOpen ? 'App window open' : 'Running without a window'}
                {app.version && ` · ${app.version}`}
              </p>
            )}
            {app.endpoint && (
              <p className="taixu-app-meta">
                Local endpoint: <code>{app.endpoint}</code>
              </p>
            )}
            {app.blockers.length > 0 && (
              <p className="taixu-app-blockers">{app.blockers.join(' ')}</p>
            )}
            {available && (
              <div className="taixu-app-actions">
                {app.state !== 'running' && (
                  <button
                    disabled={!!busy}
                    onClick={() => void act({ appId: app.id, action: 'start' })}
                  >
                    {startLabel}
                  </button>
                )}
                <button
                  disabled={!!busy}
                  onClick={() => void act({ appId: app.id, action: 'open' })}
                >
                  Open on {status.computer}
                </button>
                {active && (
                  <button
                    disabled={!!busy || app.blockers.length > 0}
                    onClick={() => void act({ appId: app.id, action: 'stop' })}
                  >
                    Stop service
                  </button>
                )}
              </div>
            )}
          </article>
        );
      })}
      <p className="taixu-apps-note">
        Flow uses its existing private tunnel or HTTPS connection. Open Flow here to copy its access
        code. Development previews use separate data and ports.
      </p>
    </section>
  );
}

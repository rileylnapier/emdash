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
  updating: 'Updating…',
};

type App = AppsStatus['apps'][number];
type UpdateAll = AppsStatus['updateAll'];
const appNames: Record<App['id'], string> = {
  flow: 'Flow',
  bloom: 'Bloom',
  taste: 'Taste',
  jam: 'Jam',
  wondercraft: 'Wondercraft',
  scout: 'Scout',
};
// Apps whose laptop connects to the Studio's backend need the same version on both.
const matchingRequired = new Set<App['id']>(['flow', 'wondercraft']);

function compareVersions(a: string, b: string) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
const installedVersion = (app?: App) =>
  app && app.state !== 'needs-install' && app.state !== 'planned' ? app.version : null;

function UpdateAllProgress({ job, label }: { job: UpdateAll; label: string }) {
  if (!job) return null;
  return (
    <div className="taixu-app-update" aria-label={`Update all ${label}`} aria-live="polite">
      <p className="taixu-app-meta">
        {job.running
          ? `Updating all ${label}${job.current ? ` · ${appNames[job.current]}…` : '…'}`
          : `Update all ${label} finished`}
      </p>
      {job.results.map((result) => (
        <p className="taixu-app-meta" key={result.appId} data-outcome={result.outcome}>
          {appNames[result.appId]}: {result.message}
        </p>
      ))}
    </div>
  );
}

export function AppsPanel() {
  const [status, setStatus] = useState<AppsStatus | null>(null);
  const [local, setLocal] = useState<AppsStatus | null>(null);
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
      const client = await getTaixuClient();
      const [result, mine] = await Promise.all([
        client.apps({}),
        // Older Studios and source previews may not answer for this Mac.
        Promise.resolve()
          .then(() => client.localApps({}))
          .catch(() => null),
      ]);
      if (mounted.current && request === generation.current.id) {
        setStatus(result);
        setLocal(mine);
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
  // Both lists come from one Mac when Studio is not selected.
  const twoMacs = !!status && !!local && local.computer !== status.computer;
  const act = async (input: AppAction, where: 'selected' | 'local' = 'selected') => {
    setBusy(input.action === 'update-all' ? `all-${where}` : `${where}-${input.appId}`);
    setError('');
    try {
      const client = await getTaixuClient();
      await (where === 'local' ? client.localAppAction(input) : client.appAction(input));
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
      {status && (
        <div className="taixu-app-actions">
          <button
            disabled={!!busy || !!status.updateAll?.running}
            onClick={() => void act({ action: 'update-all' })}
          >
            Update all on {status.computer}
          </button>
          {twoMacs && (
            <button
              disabled={!!busy || !!local?.updateAll?.running}
              onClick={() => void act({ action: 'update-all' }, 'local')}
            >
              Update all on this Mac
            </button>
          )}
        </div>
      )}
      {status && <UpdateAllProgress job={status.updateAll} label={`on ${status.computer}`} />}
      {twoMacs && <UpdateAllProgress job={local?.updateAll} label="on this Mac" />}
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
        const mine = twoMacs ? local?.apps.find((candidate) => candidate.id === app.id) : undefined;
        const here = installedVersion(mine);
        const there = installedVersion(app);
        const order = here && there ? compareVersions(here, there) : 0;
        const localRelease =
          mine?.updates?.release && ['ready', 'blocked'].includes(mine.updates.phase)
            ? mine.updates.release
            : null;
        const update = app.updates;
        const release = update?.release;
        const updating = update?.busy || update?.phase === 'restarting';
        const canInstall = update?.release && ['ready', 'blocked'].includes(update.phase);
        const available = ['running', 'idle', 'stopped'].includes(app.state);
        const active = app.state === 'running' || app.state === 'idle';
        const missing = app.state === 'needs-install' && !!app.install;
        const stateLabel = missing
          ? 'Not installed'
          : app.id === 'flow' && active
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
              <span data-state={app.state}>
                {busy === `selected-${app.id}` || busy === `local-${app.id}`
                  ? 'Working…'
                  : stateLabel}
              </span>
            </div>
            <p>{app.detail}</p>
            {twoMacs && (
              <p className="taixu-app-meta" aria-label={`${app.name} versions`}>
                This Mac {here ?? 'not installed'} · {status.computer} {there ?? 'not installed'}
              </p>
            )}
            {twoMacs && here && there && order !== 0 && (
              <p className="taixu-app-blockers" role="status">
                {order < 0
                  ? `This Mac is behind ${status.computer}.`
                  : `${status.computer} is behind this Mac.`}
                {matchingRequired.has(app.id) && ' They need the same version to connect.'}
              </p>
            )}
            {active && (
              <p className="taixu-app-meta">
                {app.windowOpen ? 'App window open' : 'Running without a window'}
                {app.version && ` · ${app.version}`}
              </p>
            )}
            {!active && app.version && <p className="taixu-app-meta">Installed · {app.version}</p>}
            {app.endpoint && (
              <p className="taixu-app-meta">
                Local endpoint: <code>{app.endpoint}</code>
              </p>
            )}
            {app.blockers.length > 0 && (
              <p className="taixu-app-blockers">{app.blockers.join(' ')}</p>
            )}
            {update && (
              <div
                className="taixu-app-update"
                aria-label={`${app.name} updates`}
                aria-live="polite"
              >
                <p className="taixu-app-meta">
                  {update.phase === 'downloading'
                    ? `Downloading update · ${Math.round(update.progress * 100)}%`
                    : update.phase === 'checking'
                      ? 'Checking for updates…'
                      : update.phase === 'preparing'
                        ? 'Checking saved work and preparing update…'
                        : update.phase === 'restarting'
                          ? 'Restarting to update…'
                          : canInstall
                            ? `Version ${update.release?.version} verified and ready`
                            : update.phase === 'current'
                              ? 'Up to date'
                              : 'Updates'}
                </p>
                {update.message && <p className="taixu-app-meta">{update.message}</p>}
                {update.blockers.length > 0 && (
                  <p className="taixu-app-blockers">{update.blockers.join(' ')}</p>
                )}
              </div>
            )}
            {active && !update && (
              <p className="taixu-app-meta">
                Update once from this app’s Settings → Updates to enable hub updates.
              </p>
            )}
            {missing && app.install?.version && (
              <div className="taixu-app-actions">
                <button
                  disabled={!!busy}
                  onClick={() => void act({ appId: app.id, action: 'install' })}
                >
                  Install {app.install.version} on {status.computer}
                </button>
              </div>
            )}
            {available && (
              <div className="taixu-app-actions">
                {(update?.supported || !active) && (
                  <button
                    disabled={!!busy || !!updating || (active && !update?.configured)}
                    onClick={() => void act({ appId: app.id, action: 'check-update' })}
                  >
                    {active ? 'Check for updates' : 'Start & check updates'}
                  </button>
                )}
                {canInstall && release && (
                  <button
                    disabled={!!busy || !!updating}
                    onClick={() =>
                      void act({ appId: app.id, action: 'update', build: release.build })
                    }
                  >
                    Update to {release.version} on {status.computer}
                  </button>
                )}
                {app.state !== 'running' && (
                  <button
                    disabled={!!busy || !!updating}
                    onClick={() => void act({ appId: app.id, action: 'start' })}
                  >
                    {startLabel}
                  </button>
                )}
                <button
                  disabled={!!busy || !!updating}
                  onClick={() => void act({ appId: app.id, action: 'open' })}
                >
                  Open on {status.computer}
                </button>
                {active && (
                  <button
                    disabled={!!busy || !!updating || app.blockers.length > 0}
                    onClick={() => void act({ appId: app.id, action: 'stop' })}
                  >
                    Stop service
                  </button>
                )}
              </div>
            )}
            {twoMacs && mine && ['running', 'idle', 'stopped'].includes(mine.state) && (
              <div className="taixu-app-actions">
                {localRelease ? (
                  <button
                    disabled={!!busy || !!mine.updates?.busy}
                    onClick={() =>
                      void act(
                        { appId: app.id, action: 'update', build: localRelease.build },
                        'local'
                      )
                    }
                  >
                    Update this Mac to {localRelease.version}
                  </button>
                ) : (
                  <button
                    disabled={!!busy || !!mine.updates?.busy}
                    onClick={() => void act({ appId: app.id, action: 'check-update' }, 'local')}
                  >
                    {mine.state === 'stopped'
                      ? 'Start & check this Mac'
                      : 'Check this Mac for updates'}
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

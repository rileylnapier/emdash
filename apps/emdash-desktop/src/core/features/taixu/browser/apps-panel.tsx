import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppAction, AppsStatus } from '../api/apps-contract';
import { getTaixuClient } from '../api/browser/client';
import {
  bothMacsRun,
  bothMacsRunning,
  studioCeilings,
  subscribeBothMacs,
  updateBothMacs,
  type BothMacsRun,
} from './apps-both-macs';
import { installFromStudio } from './apps-install';
import { TaixuUpdateCard } from './update-card';
import { sharedUpdates } from './update-controls';

function BothMacsProgress({ run, studio }: { run: BothMacsRun | null; studio: AppsStatus | null }) {
  if (!run) return null;
  const job = studio?.updateAll;
  const done = job ? job.apps.filter((e) => !['queued', 'working'].includes(e.status)).length : 0;
  const text =
    run.phase === 'studio'
      ? `Step 1 of 3: updating apps on ${run.computer}${job?.running ? ` · ${done} of ${job.apps.length} done` : '…'}`
      : run.phase === 'this-mac'
        ? `Step 2 of 3: updating apps on this Mac, up to ${run.computer}'s versions…`
        : run.phase === 'taixu'
          ? 'Step 3 of 3: updating Taixu on both Macs…'
          : run.phase === 'failed'
            ? `Stopped: ${run.error}`
            : run.taixu === 'current'
              ? 'Everything is up to date. See each app below for what changed.'
              : run.taixu === 'restarting'
                ? 'Apps finished. Taixu is restarting to finish its update.'
                : run.taixu === 'updated'
                  ? `Everything finished. Taixu: ${run.message}`
                  : `Apps finished. Taixu is waiting: ${run.message}`;
  const problem = run.phase === 'failed' || (run.phase === 'done' && run.taixu === 'blocked');
  return (
    <p className={problem ? 'taixu-app-blockers' : 'taixu-app-meta'} role="status">
      {text}
    </p>
  );
}

const labels = {
  running: 'Service running',
  idle: 'Needs attention',
  stopped: 'Stopped',
  'not-responding': 'Not responding',
  'needs-install': 'Update required',
  planned: 'Coming later',
  unavailable: 'Unavailable',
  updating: 'Updating…',
};

type App = AppsStatus['apps'][number];
type UpdateAll = AppsStatus['updateAll'];
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

type UpdateEntry = NonNullable<UpdateAll>['apps'][number];
const finishedLabels: Record<string, string> = {
  updated: 'updated',
  current: 'up to date',
  skipped: 'skipped',
  failed: 'failed',
};

function UpdateAllSummary({ job, label }: { job: UpdateAll; label: string }) {
  if (!job) return null;
  const done = job.apps.filter((entry) => !['queued', 'working'].includes(entry.status));
  const counts = Object.entries(finishedLabels)
    .map(
      ([status, text]) => [done.filter((entry) => entry.status === status).length, text] as const
    )
    .filter(([count]) => count > 0)
    .map(([count, text]) => `${count} ${text}`)
    .join(', ');
  return (
    <p className="taixu-app-meta" aria-live="polite">
      {job.running
        ? `Updating all ${label} · ${done.length} of ${job.apps.length} done`
        : `Update all ${label} finished${counts ? ` · ${counts}` : ''}`}
    </p>
  );
}

function UpdateStatus({ entry, label }: { entry?: UpdateEntry; label: string | null }) {
  if (!entry) return null;
  const prefix = label ? `${label}: ` : '';
  const text =
    entry.status === 'queued'
      ? 'Waiting to update…'
      : entry.status === 'working'
        ? `${entry.step ?? 'Working…'}${entry.progress != null ? ` ${Math.round(entry.progress * 100)}%` : ''}`
        : (entry.message ?? finishedLabels[entry.status]);
  return (
    <div className="taixu-app-update" data-outcome={entry.status} aria-live="polite">
      <p className={entry.status === 'failed' ? 'taixu-app-blockers' : 'taixu-app-meta'}>
        {prefix}
        {text}
      </p>
      {entry.status === 'working' && entry.progress != null && (
        <progress max={1} value={entry.progress} aria-label={`${prefix}${entry.step ?? ''}`} />
      )}
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
  // This Mac never updates past what the selected Studio runs.
  const ceilings = twoMacs && status ? studioCeilings(status) : [];
  const both = useSyncExternalStore(subscribeBothMacs, bothMacsRun);
  const bothRunning = bothMacsRunning(both);
  const [installing, setInstalling] = useState<{ appId: string; percent: number } | null>(null);
  // Install an app on this Mac from the selected Studio's published release.
  const installHere = async (appId: string) => {
    setBusy(`local-${appId}`);
    setError('');
    setInstalling({ appId, percent: 0 });
    try {
      const client = await getTaixuClient();
      await installFromStudio(client, appId, (percent) => {
        if (mounted.current) setInstalling({ appId, percent });
      });
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'The install did not finish. Try again.');
    } finally {
      if (mounted.current) {
        setInstalling(null);
        setBusy(null);
        await refresh();
      }
    }
  };
  const act = async (input: AppAction, where: 'selected' | 'local' = 'selected') => {
    setBusy(
      input.action === 'update-all'
        ? `all-${where}`
        : input.action === 'start-all'
          ? `start-${where}`
          : `${where}-${input.appId}`
    );
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
      <TaixuUpdateCard />
      {status && twoMacs && (
        <div className="taixu-apps-update-both">
          <button
            disabled={
              !!busy || bothRunning || !!status.updateAll?.running || !!local?.updateAll?.running
            }
            onClick={() => {
              setError('');
              void getTaixuClient().then((client) =>
                updateBothMacs(client, { taixu: sharedUpdates() })
              );
            }}
          >
            Update everything
          </button>
          <p className="taixu-app-meta">
            {status.computer}'s apps, then this Mac's apps up to {status.computer}'s versions, then
            Taixu.
          </p>
          <BothMacsProgress run={both} studio={status} />
        </div>
      )}
      {status && (
        <div className="taixu-app-actions">
          <button
            disabled={!!busy || bothRunning || !!status.updateAll?.running}
            onClick={() => void act({ action: 'start-all' })}
            title="Start every stopped app and restart any that stopped answering. Apps that are fine are left alone."
          >
            {busy === 'start-selected' ? 'Starting apps…' : `Start all apps on ${status.computer}`}
          </button>
          <button
            disabled={!!busy || bothRunning || !!status.updateAll?.running}
            onClick={() => void act({ action: 'update-all' })}
          >
            {twoMacs ? `Only ${status.computer}` : `Update all apps on ${status.computer}`}
          </button>
          {twoMacs && (
            <button
              disabled={!!busy || bothRunning || !!local?.updateAll?.running}
              onClick={() => void act({ action: 'update-all', ceilings }, 'local')}
            >
              Only this Mac
            </button>
          )}
        </div>
      )}
      {status && <UpdateAllSummary job={status.updateAll} label={`on ${status.computer}`} />}
      {twoMacs && <UpdateAllSummary job={local?.updateAll} label="on this Mac" />}
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
        const aheadOfStudio =
          !!localRelease && !!there && compareVersions(localRelease.version, there) > 0;
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
            <UpdateStatus
              entry={status.updateAll?.apps.find((entry) => entry.appId === app.id)}
              label={twoMacs ? status.computer : null}
            />
            {twoMacs && (
              <UpdateStatus
                entry={local?.updateAll?.apps.find((entry) => entry.appId === app.id)}
                label="This Mac"
              />
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
            {app.state === 'not-responding' && (
              <div className="taixu-app-actions">
                <button
                  disabled={!!busy}
                  onClick={() => void act({ appId: app.id, action: 'restart' })}
                >
                  Restart {app.name}
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
            {twoMacs && mine?.state === 'needs-install' && (
              <div className="taixu-app-actions">
                <button disabled={!!busy} onClick={() => void installHere(app.id)}>
                  {installing?.appId === app.id
                    ? installing.percent < 100
                      ? `Copying from ${status.computer} · ${installing.percent}%`
                      : 'Checking and installing…'
                    : 'Install on this Mac'}
                </button>
              </div>
            )}
            {twoMacs && mine && ['running', 'idle', 'stopped'].includes(mine.state) && (
              <div className="taixu-app-actions">
                {localRelease ? (
                  <button
                    disabled={!!busy || !!mine.updates?.busy || aheadOfStudio}
                    onClick={() =>
                      void act(
                        {
                          appId: app.id,
                          action: 'update',
                          build: localRelease.build,
                          ...(there ? { ceiling: there } : {}),
                        },
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
                {aheadOfStudio && localRelease && (
                  <p className="taixu-app-meta">
                    {status.computer} has {there}. Update {status.computer} first so this Mac does
                    not get ahead ({localRelease.version}).
                  </p>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTaixuClient } from '../api/browser/client';
import { getStudioClient } from '../api/browser/studio-client';
import type { StudioStatus } from '../api/studio-contract';

export function ServerMode({
  url,
  busy,
  error,
  onReconnect,
  onOpenWorld,
}: {
  url: string | null;
  busy: boolean;
  error: string | null;
  onReconnect: () => void;
  onOpenWorld: () => void;
}) {
  const [studio, setStudio] = useState<StudioStatus | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [checkError, setCheckError] = useState('');
  const [actionError, setActionError] = useState('');
  const [sharingBusy, setSharingBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef({ id: 0 });
  const refresh = useCallback(async () => {
    const request = ++generation.current.id;
    setChecking(true);
    const [computer, backend] = await Promise.allSettled([
      getStudioClient().then((client) => client.status()),
      getTaixuClient().then((client) => client.status({})),
    ]);
    if (request !== generation.current.id) return;
    setStudio(computer.status === 'fulfilled' ? computer.value : null);
    setRunning(backend.status === 'fulfilled' ? backend.value.running : null);
    setCheckError(
      [
        computer.status === 'rejected' ? 'Computer status is unavailable.' : computer.value.error,
        backend.status === 'rejected' ? 'Backend status is unavailable.' : null,
      ]
        .filter(Boolean)
        .join(' ')
    );
    setChecked(new Date().toLocaleTimeString());
    setChecking(false);
  }, []);
  useEffect(() => {
    const requests = generation.current;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => {
      disposed = true;
      requests.id++;
      clearTimeout(timer);
    };
  }, [refresh, url]);

  const backendLabel = running === null ? 'Unknown' : running ? 'Running' : 'Stopped';
  const sharingLabel = studio ? (studio.sharing ? 'Enabled over SSH' : 'Off') : 'Unknown';
  const uptime = studio
    ? `${Math.floor(studio.uptimeSeconds / 3600)}h ${Math.floor((studio.uptimeSeconds % 3600) / 60)}m`
    : '—';
  // A connect URL contains a secret capability. Show/copy only its loopback origin.
  const endpoint = url ? new URL(url).origin : 'Unavailable';
  const diagnostics = [
    'Taixu · Server mode · This Mac',
    `Backend: ${backendLabel}`,
    `Laptop access: ${sharingLabel}`,
    `App uptime: ${uptime}`,
    `Build: ${studio?.build || 'Unavailable'}`,
    `Local endpoint: ${endpoint}`,
    `Last check: ${checked ?? 'Not yet checked'}`,
    ...[error, checkError, actionError].filter(Boolean).map((message) => `Error: ${message}`),
  ].join('\n');

  return (
    <main className="taixu-server" aria-label="Server mode">
      <div className="taixu-server-heading">
        <span className="taixu-server-eyebrow">This Mac</span>
        <h1>Server mode</h1>
        <p>The world is unloaded. Your Studio’s work stays here.</p>
      </div>
      <dl className="taixu-server-status">
        <div>
          <dt>Backend</dt>
          <dd data-state={running === true ? 'ready' : 'unknown'}>{backendLabel}</dd>
        </div>
        <div>
          <dt>Laptop access</dt>
          <dd>{sharingLabel}</dd>
        </div>
      </dl>
      <label className="taixu-sharing">
        <input
          type="checkbox"
          checked={studio?.sharing ?? false}
          disabled={!studio || sharingBusy}
          onChange={(event) => {
            const enabled = event.target.checked;
            setSharingBusy(true);
            setActionError('');
            void getStudioClient()
              .then((client) => client.share({ enabled }))
              .then(() => refresh())
              .catch((cause) =>
                setActionError(cause instanceof Error ? cause.message : 'Could not change sharing.')
              )
              .finally(() => setSharingBusy(false));
          }}
        />
        Allow my laptop to connect
      </label>
      <dl className="taixu-server-details">
        <div>
          <dt>App uptime</dt>
          <dd>{uptime}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd title={studio?.build}>{studio?.build.slice(0, 12) || 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Local endpoint</dt>
          <dd>{endpoint}</dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>{checked ?? 'Checking…'}</dd>
        </div>
      </dl>
      {(error || checkError || actionError) && (
        <p className="taixu-server-error" role="alert">
          {[error, checkError, actionError].filter(Boolean).join(' ')}
        </p>
      )}
      <div className="taixu-server-tools">
        <button disabled={checking || sharingBusy} onClick={() => void refresh()}>
          Refresh status
        </button>
        <button
          onClick={() => {
            setCopied(false);
            void navigator.clipboard
              .writeText(diagnostics)
              .then(() => setCopied(true))
              .catch(() => setActionError('Could not copy diagnostics.'));
          }}
        >
          Copy diagnostics
        </button>
        {copied && <span role="status">Copied</span>}
        {running !== true && (
          <button disabled={busy} onClick={onReconnect}>
            Retry backend
          </button>
        )}
      </div>
      <footer>
        <p>Keep this Mac awake and Taixu running for laptop access.</p>
        <button className="taixu-server-open" disabled={busy} onClick={onOpenWorld}>
          Open Taixu
        </button>
      </footer>
    </main>
  );
}

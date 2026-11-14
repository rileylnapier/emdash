import { useEffect, useState } from 'react';
import { openModal } from '@core/manifests/browser/modal-api';
import { getStudioClient, isStudioDesktop } from '../api/browser/studio-client';
import type { StudioStatus } from '../api/studio-contract';

export function StudioSelector({ onServerMode }: { onServerMode: () => Promise<void> }) {
  const [status, setStatus] = useState<StudioStatus>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = () =>
    getStudioClient()
      .then((c) => c.status())
      .then(setStatus);
  useEffect(() => {
    void refresh().catch(() => setError('Computer settings are unavailable.'));
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the connection.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="taixu-computers">
      <button
        onClick={() => {
          setOpen(!open);
          void refresh().catch(() => {});
        }}
        aria-expanded={open}
      >
        {isStudioDesktop() ? (status?.name ?? 'Studio') : 'This Mac'} ▾
      </button>
      {open && (
        <section className="taixu-computer-panel" aria-label="Computers">
          <h2>Where your team works</h2>
          <p>Projects, accounts and conversations stay on the computer you choose.</p>
          {isStudioDesktop() ? (
            <>
              <p>Connected to {status?.name ?? 'Studio'} over SSH.</p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await (await getStudioClient()).disconnect();
                    location.reload();
                  })
                }
              >
                Use this Mac
              </button>
            </>
          ) : (
            <>
              <label className="taixu-sharing">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={status?.sharing ?? false}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void action(async () =>
                      setStatus(await (await getStudioClient()).share({ enabled }))
                    );
                  }}
                />{' '}
                Allow my laptop to connect to this Mac
              </label>
              <p>
                Keep Taixu open here. On your laptop, install the same build and add this Mac’s SSH
                connection.
              </p>
              {status?.sharing && (
                <small>Access uses your Mac login over SSH. Repositories stay here.</small>
              )}
              <button disabled={busy} onClick={() => void action(onServerMode)}>
                Use server mode
              </button>
              <small>
                A small status window without the turtle. Local Head replies stop when the world
                closes; coding tasks and laptop sessions keep running.
              </small>
              {status?.machines.map((machine) => (
                <button
                  key={machine.id}
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await (await getStudioClient()).connect({ id: machine.id });
                      location.reload();
                    })
                  }
                >
                  Connect to {machine.name}
                </button>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    setOpen(false);
                    await openModal('addSshConnModal', { dismissControl: 'close' });
                    await refresh();
                    setOpen(true);
                  })
                }
              >
                Add computer…
              </button>
            </>
          )}
          {busy && <p>Updating connection…</p>}
          {busy && (
            <button
              onClick={() => {
                void getStudioClient()
                  .then((c) => c.disconnect())
                  .then(() => location.reload());
              }}
            >
              Cancel · use this Mac
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          <button onClick={() => setOpen(false)}>Close</button>
        </section>
      )}
    </div>
  );
}

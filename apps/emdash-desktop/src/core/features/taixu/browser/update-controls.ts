import { getStudioClient } from '../api/browser/studio-client';
import type { TaixuUpdateState } from '../api/update-contract';
import './update-controls.css';

let preflight: (() => Promise<void>) | undefined;
export function registerUpdatePreflight(check: () => Promise<void>) {
  preflight = check;
  return () => {
    if (preflight === check) preflight = undefined;
  };
}

export interface UpdateControl {
  /** The control's UI. Its listeners survive moving it between hosts. */
  panel: HTMLElement;
  state(): TaixuUpdateState | undefined;
  subscribe(listener: (state: TaixuUpdateState) => void): () => void;
  /** The primary button's check. Rejects when the request fails. */
  check(): Promise<void>;
  /** The primary button's install, including its restart hold and preflight. */
  install(): Promise<void>;
  dispose(): void;
}

const statusLabel = (status: TaixuUpdateState['status'], progress: number) =>
  status === 'ready' || status === 'blocked'
    ? 'Update ready'
    : status === 'downloading'
      ? `Updating · ${progress}%`
      : status === 'installing'
        ? 'Restarting…'
        : status === 'preparing'
          ? 'Checking readiness…'
          : 'Updates';

function createUpdateControl({ inline }: { inline: boolean }): UpdateControl {
  const panel = document.createElement('section');
  panel.className = inline ? 'taixu-update-panel taixu-update-inline' : 'taixu-update-panel';
  panel.setAttribute('aria-label', 'Taixu updates');
  const title = document.createElement('h2');
  title.textContent = 'Taixu updates';
  const versions = document.createElement('p');
  versions.className = 'taixu-update-versions';
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.setAttribute('aria-label', 'Update download');
  const notes = document.createElement('p');
  notes.className = 'taixu-release-notes';
  const explanation = document.createElement('p');
  explanation.className = 'taixu-update-explanation';
  const actions = document.createElement('div');
  actions.className = 'taixu-update-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'taixu-update-primary';
  button.textContent = 'Check for updates';
  const newer = document.createElement('button');
  newer.type = 'button';
  newer.textContent = 'Check for newer release';
  newer.hidden = true;
  actions.append(button, newer);
  // Inline, the host supplies the heading and there is nothing to close.
  if (inline) panel.append(versions, message, progress, notes, explanation, actions);
  else panel.append(title, versions, message, progress, notes, explanation, actions);
  let disposed = false;
  let reading = false;
  let pending = false;
  let revision = 0;
  let state: TaixuUpdateState | undefined;
  let held: string | null = null;
  const listeners = new Set<(state: TaixuUpdateState) => void>();
  const overlay = document.createElement('dialog');
  overlay.className = 'taixu-update-hold';
  overlay.textContent = 'Checking this Mac’s readiness. Saving your place…';
  document.body.append(overlay);
  const keepOpen = (event: Event) => event.preventDefault();
  overlay.addEventListener('cancel', keepOpen);
  async function hold(id: string | null) {
    if (held === id) return;
    held = id;
    if (!id) {
      overlay.close();
      return;
    }
    if (!overlay.open) overlay.showModal();
    let error: string | null = null;
    try {
      await preflight?.();
    } catch (e) {
      error =
        e instanceof Error ? e.message.slice(0, 600) : 'Could not save your place. Try again.';
    }
    if (!disposed && held === id)
      await (await getStudioClient()).acknowledgeUpdate({ hold: id, error });
  }
  function render(next: TaixuUpdateState) {
    if (disposed) return;
    state = next;
    void hold(next.hold).catch(() => {
      message.textContent = 'Could not confirm restart readiness.';
    });
    message.textContent = next.message;
    versions.hidden = !next.currentVersion && !next.release?.version;
    versions.textContent = [
      next.currentVersion ? `Installed Taixu ${next.currentVersion} on this Mac` : '',
      next.release?.version ? `Release ${next.release.version}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    progress.hidden = next.status !== 'downloading';
    progress.value = next.progress;
    notes.hidden = !next.release?.notes;
    notes.textContent = next.release?.notes ?? '';
    explanation.textContent =
      next.target === 'this-mac' && next.remote
        ? 'Only this Mac will restart. Studio’s backend and tasks keep running. Taixu reconnects using your saved Studio connection.'
        : next.target === 'studio'
          ? 'Only Studio needs updating. Its active work must finish before it can restart.'
          : next.remote
            ? 'Downloads use your saved Studio connection. Only computers needing the release will restart, with Studio first. Work and unsaved files on those computers must be resolved.'
            : 'Updates are prepared on this Mac. Finish active work and pause schedules before restarting Taixu.';
    button.disabled =
      pending || ['checking', 'downloading', 'preparing', 'installing'].includes(next.status);
    newer.hidden = !['ready', 'blocked'].includes(next.status);
    newer.disabled = button.disabled;
    const updateLabel =
      next.target === 'this-mac' || !next.remote
        ? 'Update this Mac'
        : next.target === 'studio'
          ? 'Update Studio'
          : 'Update both Macs';
    button.textContent =
      next.status === 'ready'
        ? updateLabel
        : next.status === 'blocked'
          ? `Retry · ${updateLabel}`
          : next.status === 'preparing'
            ? 'Checking readiness…'
            : next.status === 'installing'
              ? 'Restarting…'
              : 'Check for updates';
    for (const listener of listeners) listener(next);
  }
  async function refresh() {
    if (reading || pending || disposed) return;
    reading = true;
    const version = revision;
    try {
      const next = await (await getStudioClient()).updateStatus();
      if (version === revision) render(next);
    } catch {
      if (!disposed && version === revision)
        message.textContent = 'Could not read update status. Try again shortly.';
    } finally {
      reading = false;
    }
  }
  async function request(checkOnly = false) {
    if (pending || disposed) return;
    pending = true;
    revision++;
    button.disabled = true;
    newer.disabled = true;
    try {
      const control = await getStudioClient();
      const next =
        !checkOnly && state && ['ready', 'blocked'].includes(state.status)
          ? await control.installUpdate()
          : await control.checkUpdate();
      pending = false;
      render(next);
    } catch (error) {
      if (!disposed) {
        message.textContent =
          error instanceof Error ? error.message.slice(0, 600) : 'Could not update Taixu.';
        button.disabled = false;
        newer.disabled = false;
      }
      throw error;
    } finally {
      pending = false;
    }
  }
  // The button shows its own failure; only programmatic callers need the rejection.
  button.onclick = () => void request().catch(() => {});
  newer.onclick = () => void request(true).catch(() => {});
  void refresh();
  const timer = setInterval(() => void refresh(), 2000);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    listeners.clear();
    panel.remove();
    overlay.remove();
    window.removeEventListener('beforeunload', dispose);
  };
  window.addEventListener('beforeunload', dispose, { once: true });
  return {
    panel,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    check: () => request(true),
    install: () => request(),
    dispose,
  };
}

/** Also used by recovery before React and the desktop connection are available. */
export function mountUpdateControls(parent: HTMLElement) {
  const control = createUpdateControl({ inline: false });
  const details = document.createElement('details');
  details.className = 'taixu-update';
  const summary = document.createElement('summary');
  summary.textContent = 'Updates';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.onclick = () => {
    details.open = false;
    summary.focus();
  };
  control.panel.querySelector('.taixu-update-actions')!.append(close);
  control.subscribe((next) => {
    summary.textContent = statusLabel(next.status, next.progress);
  });
  details.append(summary, control.panel);
  parent.append(details);
  return () => {
    control.dispose();
    details.remove();
  };
}

// The desktop window keeps exactly one control mounted for its lifetime, so a
// restart hold is acknowledged whichever page is open. The Apps page borrows its
// panel; everything else reads its status from here instead of polling again.
let shared: { control: UpdateControl; host: HTMLElement; users: number } | undefined;
let sharedStatus: TaixuUpdateState['status'] | null = null;
const statusListeners = new Set<() => void>();
const publishStatus = (next: TaixuUpdateState['status'] | null) => {
  if (sharedStatus === next) return;
  sharedStatus = next;
  for (const listener of statusListeners) listener();
};

/** Keep the window's update control mounted while the caller needs it. */
export function retainSharedUpdates() {
  if (!shared) {
    const host = document.createElement('div');
    host.className = 'taixu-update-host';
    host.hidden = true;
    const control = createUpdateControl({ inline: true });
    host.append(control.panel);
    document.body.append(host);
    control.subscribe((next) => publishStatus(next.status));
    shared = { control, host, users: 0 };
  }
  const current = shared;
  current.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--current.users > 0 || shared !== current) return;
    shared = undefined;
    current.control.dispose();
    current.host.remove();
    publishStatus(null);
  };
}

export const sharedUpdates = () => shared?.control;
export const sharedUpdateStatus = () => sharedStatus;
export function subscribeSharedUpdateStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => void statusListeners.delete(listener);
}

/** Show the shared panel inside `slot` until the returned function runs. */
export function showSharedUpdates(slot: HTMLElement) {
  const current = shared;
  if (!current) return () => {};
  slot.append(current.control.panel);
  return () => {
    if (current.control.panel.parentElement === slot) current.host.append(current.control.panel);
  };
}

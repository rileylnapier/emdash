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

/** Also used by recovery before React and the desktop connection are available. */
export function mountUpdateControls(parent: HTMLElement) {
  const details = document.createElement('details');
  details.className = 'taixu-update';
  const summary = document.createElement('summary');
  summary.textContent = 'Updates';
  const panel = document.createElement('section');
  panel.className = 'taixu-update-panel';
  panel.setAttribute('aria-label', 'Taixu updates');
  const title = document.createElement('h2');
  title.textContent = 'Taixu updates';
  const versions = document.createElement('p');
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.setAttribute('aria-label', 'Update download');
  const notes = document.createElement('p');
  notes.className = 'taixu-release-notes';
  const explanation = document.createElement('p');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Check for updates';
  const newer = document.createElement('button');
  newer.type = 'button';
  newer.textContent = 'Check for newer release';
  newer.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.onclick = () => {
    details.open = false;
    summary.focus();
  };
  panel.append(title, versions, message, progress, notes, explanation, button, newer, close);
  details.append(summary, panel);
  parent.append(details);
  let disposed = false;
  let reading = false;
  let pending = false;
  let revision = 0;
  let state: TaixuUpdateState | undefined;
  let held: string | null = null;
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
    summary.textContent =
      next.status === 'ready' || next.status === 'blocked'
        ? 'Update ready'
        : next.status === 'downloading'
          ? `Updating · ${next.progress}%`
          : next.status === 'installing'
            ? 'Restarting…'
            : next.status === 'preparing'
              ? 'Checking readiness…'
              : 'Updates';
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
    } finally {
      pending = false;
    }
  }
  button.onclick = () => void request();
  newer.onclick = () => void request(true);
  void refresh();
  const timer = setInterval(() => void refresh(), 2000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    details.remove();
    overlay.remove();
    window.removeEventListener('beforeunload', dispose);
  };
  window.addEventListener('beforeunload', dispose, { once: true });
  return dispose;
}

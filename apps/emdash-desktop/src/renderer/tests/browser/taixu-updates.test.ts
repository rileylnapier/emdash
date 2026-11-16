import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
  mountUpdateControls,
  registerUpdatePreflight,
  retainSharedUpdates,
  sharedUpdateStatus,
  sharedUpdates,
  showSharedUpdates,
} from '@core/features/taixu/browser/update-controls';
const mock = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  ack: vi.fn(),
}));
vi.mock('@core/features/taixu/api/browser/studio-client', () => ({
  getStudioClient: async () => ({
    updateStatus: mock.status,
    checkUpdate: mock.check,
    installUpdate: mock.install,
    acknowledgeUpdate: mock.ack,
  }),
}));
let dispose: (() => void) | undefined;
let unregister: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  unregister?.();
  vi.resetAllMocks();
});
const idle = {
  status: 'idle',
  hold: null,
  current: 'old',
  release: null,
  progress: 0,
  remote: true,
  message: 'No release yet.',
};
it('shows release notes as text and requires an explicit click to install from recovery', async () => {
  const ready = {
    ...idle,
    status: 'ready',
    message: 'Ready',
    currentVersion: '1.3.0',
    release: { version: '1.3.1', notes: '<img src=x onerror=alert(1)> New buildings' },
  };
  mock.status.mockResolvedValue(ready);
  mock.install.mockResolvedValue({ ...ready, status: 'installing' });
  dispose = mountUpdateControls(document.body);
  await expect.element(page.getByText('Update ready', { exact: true })).toBeVisible();
  await page.getByText('Update ready', { exact: true }).click();
  await expect
    .element(page.getByText('Installed Taixu 1.3.0 on this Mac · Release 1.3.1', { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText(ready.release.notes, { exact: true })).toBeVisible();
  expect(document.querySelector('.taixu-update img')).toBeNull();
  expect(mock.install).not.toHaveBeenCalled();
  await page.getByRole('button', { name: 'Update both Macs', exact: true }).click();
  expect(mock.install).toHaveBeenCalledOnce();
  await expect
    .element(page.getByRole('button', { name: 'Restarting…', exact: true }))
    .toBeDisabled();
});
it('blocks interaction while checking unsaved buffers and sends a refusal to the host', async () => {
  mock.status.mockResolvedValue({ ...idle, hold: 'lease' });
  unregister = registerUpdatePreflight(async () => {
    throw new Error('Unsaved file');
  });
  dispose = mountUpdateControls(document.body);
  await expect
    .poll(() => mock.ack.mock.calls)
    .toEqual([[{ hold: 'lease', error: 'Unsaved file' }]]);
  await expect.element(page.getByRole('dialog')).toBeVisible();
});
it('ignores an older status response after starting a new download', async () => {
  let resolve!: (v: unknown) => void;
  mock.status.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  mock.check.mockResolvedValue({ ...idle, status: 'downloading', progress: 35 });
  dispose = mountUpdateControls(document.body);
  await page.getByText('Updates', { exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  resolve(idle);
  await expect.element(page.getByText('Updating · 35%', { exact: true })).toBeVisible();
});

it('names laptop-only updates, retains a task blocker, and retries without checking or downloading again', async () => {
  const ready = {
    ...idle,
    status: 'ready',
    target: 'this-mac',
    message: 'Studio is current.',
    release: { notes: 'Update notes' },
  };
  const blocked = {
    ...ready,
    status: 'blocked',
    message: 'This Mac: codex · local-task is working. The verified update is still ready.',
  };
  mock.status.mockResolvedValue(ready);
  mock.install.mockImplementationOnce(async () => {
    mock.status.mockResolvedValue(blocked);
    return blocked;
  });
  dispose = mountUpdateControls(document.body);
  await page.getByText('Update ready', { exact: true }).click();
  await expect
    .element(page.getByText('Only this Mac will restart.', { exact: false }))
    .toBeVisible();
  await page.getByRole('button', { name: 'Update this Mac', exact: true }).click();
  await expect.element(page.getByRole('status')).toHaveTextContent('This Mac: codex · local-task');
  const retry = page.getByRole('button', { name: 'Retry · Update this Mac', exact: true });
  await expect.element(retry).toBeEnabled();
  mock.install.mockResolvedValue({
    ...ready,
    status: 'preparing',
    message: 'Checking active work and unsaved files on this Mac…',
  });
  await retry.click();
  expect(mock.install).toHaveBeenCalledTimes(2);
  expect(mock.check).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole('button', { name: 'Checking readiness…', exact: true }))
    .toBeDisabled();
  expect(document.querySelector('.taixu-update')!.textContent).not.toContain('Restarting');
});

it('shows Restarting only after a preparing response advances to a committed restart', async () => {
  const ready = { ...idle, status: 'ready', target: 'this-mac' };
  mock.status.mockResolvedValue(ready);
  mock.install.mockImplementation(async () => {
    const preparing = { ...ready, status: 'preparing' };
    mock.status.mockResolvedValue(preparing);
    return preparing;
  });
  dispose = mountUpdateControls(document.body);
  await page.getByText('Update ready', { exact: true }).click();
  await page.getByRole('button', { name: 'Update this Mac', exact: true }).click();
  await expect
    .element(page.getByRole('button', { name: 'Checking readiness…', exact: true }))
    .toBeDisabled();
  expect(document.querySelector('.taixu-update')!.textContent).not.toContain('Restarting');
  mock.status.mockResolvedValue({ ...ready, status: 'installing' });
  await expect
    .element(page.getByRole('button', { name: 'Restarting…', exact: true }))
    .toBeDisabled();
});

it('lets a waiting update check for a newer release without requesting a restart', async () => {
  const ready = {
    ...idle,
    status: 'blocked',
    currentVersion: '1.4.0',
    release: { version: '1.5.0', notes: 'Older release' },
  };
  mock.status.mockResolvedValue(ready);
  mock.check.mockResolvedValue({ ...ready, status: 'checking' });
  dispose = mountUpdateControls(document.body);
  await page.getByText('Update ready', { exact: true }).click();
  await page.getByRole('button', { name: 'Check for newer release', exact: true }).click();
  expect(mock.check).toHaveBeenCalledOnce();
  expect(mock.install).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole('button', { name: 'Check for updates', exact: true }))
    .toBeDisabled();
});

it('replaces stale-release retry with a fresh check and clears the old version and notes', async () => {
  mock.status.mockResolvedValue({
    ...idle,
    status: 'ready',
    release: { version: '1.5.0', notes: 'Older release' },
  });
  mock.install.mockResolvedValue({
    ...idle,
    status: 'error',
    message: 'The release changed to Taixu 1.6.1. Check for updates.',
  });
  mock.check.mockResolvedValue({ ...idle, status: 'checking' });
  dispose = mountUpdateControls(document.body);
  await page.getByText('Update ready', { exact: true }).click();
  await page.getByRole('button', { name: 'Update both Macs', exact: true }).click();
  await expect.element(page.getByRole('status')).toHaveTextContent('release changed');
  expect(document.querySelector('.taixu-release-notes')!.textContent).toBe('');
  expect(document.querySelector('.taixu-update')!.textContent).not.toContain('1.5.0');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  expect(mock.check).toHaveBeenCalledOnce();
  expect(mock.install).toHaveBeenCalledOnce();
});

it('shares one hidden control per window that the Apps page borrows without a second poller', async () => {
  mock.status.mockResolvedValue({ ...idle, status: 'ready', target: 'this-mac' });
  mock.install.mockResolvedValue({ ...idle, status: 'preparing', target: 'this-mac' });
  const releaseShell = retainSharedUpdates();
  const releaseCard = retainSharedUpdates();
  dispose = () => {
    releaseCard();
    releaseShell();
  };
  expect(document.querySelectorAll('.taixu-update-panel')).toHaveLength(1);
  await expect.poll(sharedUpdateStatus).toBe('ready');
  expect(mock.status).toHaveBeenCalledOnce();
  const host = document.querySelector<HTMLElement>('.taixu-update-host')!;
  expect(host.hidden).toBe(true);
  expect(host.textContent).not.toContain('Close');
  const slot = document.createElement('div');
  document.body.append(slot);
  const hide = showSharedUpdates(slot);
  await page.getByRole('button', { name: 'Update this Mac', exact: true }).click();
  expect(mock.install).toHaveBeenCalledOnce();
  hide();
  slot.remove();
  expect(host.querySelector('.taixu-update-panel')).toBe(sharedUpdates()!.panel);
  // The card letting go leaves the window's control (and its hold handling) running.
  releaseCard();
  expect(sharedUpdates()).toBeDefined();
  mock.status.mockResolvedValue({ ...idle, hold: 'lease' });
  await expect
    .poll(() => mock.ack.mock.calls, { timeout: 4000 })
    .toEqual([[{ hold: 'lease', error: null }]]);
  releaseShell();
  expect(sharedUpdates()).toBeUndefined();
  expect(sharedUpdateStatus()).toBeNull();
  expect(document.querySelector('.taixu-update-host, dialog.taixu-update-hold')).toBeNull();
});

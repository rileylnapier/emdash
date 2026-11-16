import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { AppsStatus } from '../api/apps-contract';
import { AppsPanel } from './apps-panel';
import '@emdash/ui/style.css';
import './taixu-shell.css';

const mocks = vi.hoisted(() => ({ apps: vi.fn(), appAction: vi.fn() }));
vi.mock('../api/browser/client', () => ({ getTaixuClient: async () => mocks }));
let root: Root;
let container: HTMLDivElement;
const status: AppsStatus = {
  computer: 'Studio',
  apps: ['Flow', 'Bloom', 'Taste', 'Jam', 'Wondercraft', 'Scout'].map((name) => ({
    id: name.toLowerCase() as AppsStatus['apps'][number]['id'],
    name,
    detail: `${name} on this computer`,
    supported: true,
    state: 'running',
    endpoint: null,
    windowOpen: false,
    blockers: [],
    version: '0.3.0',
  })),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.apps.mockResolvedValue(structuredClone(status));
  mocks.appAction.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <div className="taixu-apps-page" style={{ minHeight: '100vh' }}>
        <AppsPanel />
      </div>
    )
  );
  await expect
    .element(page.getByRole('article', { name: 'Wondercraft', exact: true }))
    .toBeVisible();
}
it('shows all six services and reserves sharing labels for Flow', async () => {
  await render();
  await expect.element(page.getByText('Sharing library', { exact: true })).toBeVisible();
  expect(container.querySelectorAll('article')).toHaveLength(6);
  expect(
    [...container.querySelectorAll('[data-state]')].filter(
      (el) => el.textContent === 'Service running'
    )
  ).toHaveLength(5);
  await page
    .getByRole('article', { name: 'Wondercraft', exact: true })
    .getByRole('button', { name: 'Open on Studio' })
    .click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: 'wondercraft',
    action: 'open',
  });
});
it('blocks stopping active work and can start a stopped app', async () => {
  const next = structuredClone(status);
  next.apps[1]!.blockers = ['A render is in progress.'];
  next.apps[3]!.state = 'stopped';
  mocks.apps.mockResolvedValue(next);
  await render();
  await expect
    .element(
      page
        .getByRole('article', { name: 'Bloom', exact: true })
        .getByRole('button', { name: 'Stop service' })
    )
    .toBeDisabled();
  await page
    .getByRole('article', { name: 'Jam', exact: true })
    .getByRole('button', { name: 'Start service' })
    .click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: 'jam',
    action: 'start',
  });
});
it('removes stale actions if the selected computer disconnects', async () => {
  await render();
  mocks.apps.mockRejectedValue(Error('Disconnected'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.element(page.getByRole('alert')).toHaveTextContent('App status is unavailable');
  expect(container.querySelectorAll('article')).toHaveLength(0);
  expect(mocks.appAction).not.toHaveBeenCalled();
});

it('sends only the reviewed build and does not repeat an uncertain update', async () => {
  const next = structuredClone(status);
  next.apps[0]!.updates = {
    supported: true,
    configured: true,
    phase: 'ready',
    busy: false,
    progress: 1,
    release: { version: '1.2.0', build: 'a'.repeat(64) },
    blockers: [],
    message: null,
  };
  mocks.apps.mockResolvedValue(next);
  mocks.appAction.mockRejectedValue(Error('Reply lost. Refresh before trying again.'));
  await render();
  if (import.meta.env.VITE_TAIXU_HUB_UPDATES_SCREENSHOT) {
    await page.viewport(900, 1600);
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_HUB_UPDATES_SCREENSHOT });
    await page.viewport(1280, 720);
  }
  await page.getByRole('button', { name: 'Update to 1.2.0 on Studio', exact: true }).click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: 'flow',
    action: 'update',
    build: 'a'.repeat(64),
  });
  await expect.element(page.getByRole('alert')).toHaveTextContent('Reply lost');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(mocks.appAction).toHaveBeenCalledTimes(1);
});

it('shows downloading progress, blocks conflicting actions and starts a stopped app to check', async () => {
  const next = structuredClone(status);
  next.apps[1]!.updates = {
    supported: true,
    configured: true,
    phase: 'downloading',
    busy: true,
    progress: 0.42,
    release: null,
    blockers: [],
    message: null,
  };
  next.apps[5]!.state = 'stopped';
  mocks.apps.mockResolvedValue(next);
  await render();
  const bloom = page.getByRole('article', { name: 'Bloom', exact: true });
  await expect.element(bloom.getByText('Downloading update · 42%', { exact: true })).toBeVisible();
  await expect.element(bloom.getByRole('button', { name: 'Stop service' })).toBeDisabled();
  await expect.element(bloom.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await page
    .getByRole('article', { name: 'Scout', exact: true })
    .getByRole('button', { name: 'Start & check updates' })
    .click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: 'scout',
    action: 'check-update',
  });
});

it('explains busy-work refusal and missing connection setup', async () => {
  const next = structuredClone(status);
  next.apps[0]!.updates = {
    supported: true,
    configured: true,
    phase: 'blocked',
    busy: false,
    progress: 1,
    release: { version: '1.2.0', build: 'a'.repeat(64) },
    blockers: ['A track is playing.'],
    message: null,
  };
  next.apps[1]!.updates = {
    supported: true,
    configured: false,
    phase: 'idle',
    busy: false,
    progress: 0,
    release: null,
    blockers: [],
    message: 'Set up the release connection in this app’s Settings → Updates first.',
  };
  mocks.apps.mockResolvedValue(next);
  await render();
  await expect.element(page.getByText('A track is playing.', { exact: true })).toBeVisible();
  await expect
    .element(
      page
        .getByRole('article', { name: 'Bloom', exact: true })
        .getByRole('button', { name: 'Check for updates' })
    )
    .toBeDisabled();
});
it('installs a missing app from the release this computer published', async () => {
  const next = structuredClone(status);
  const scout = next.apps[5]!;
  Object.assign(scout, {
    state: 'needs-install',
    version: null,
    install: { version: '0.3.1' },
    detail: 'Not installed. Version 0.3.1 is published on this Mac.',
  });
  const jam = next.apps[3]!;
  Object.assign(jam, { state: 'needs-install', version: null, install: { version: null } });
  const taste = next.apps[2]!;
  Object.assign(taste, { state: 'needs-install', version: null, install: null });
  mocks.apps.mockResolvedValue(next);
  await render();
  const card = page.getByRole('article', { name: 'Scout', exact: true });
  await expect.element(card.getByText('Not installed', { exact: true })).toBeVisible();
  expect(container.querySelector('[aria-label="Scout"] .taixu-app-actions')?.textContent).toBe(
    'Install 0.3.1 on Studio'
  );
  await card.getByRole('button', { name: 'Install 0.3.1 on Studio' }).click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({ appId: 'scout', action: 'install' });
  // Nothing published: say so without offering an install.
  await expect
    .element(page.getByRole('article', { name: 'Jam', exact: true }).getByText('Not installed'))
    .toBeVisible();
  expect(container.querySelector('[aria-label="Jam"] button')).toBeNull();
  // An older, non-hub release is still installed: it needs its own update.
  await expect
    .element(page.getByRole('article', { name: 'Taste', exact: true }).getByText('Update required'))
    .toBeVisible();
  expect(container.querySelector('[aria-label="Taste"] button')).toBeNull();
});

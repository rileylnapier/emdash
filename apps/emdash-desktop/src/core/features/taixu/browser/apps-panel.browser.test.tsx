import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { AppsStatus } from '../api/apps-contract';
import { AppsPanel } from './apps-panel';
import '@emdash/ui/style.css';
import './taixu-shell.css';

const mocks = vi.hoisted(() => ({
  apps: vi.fn(),
  appAction: vi.fn(),
  localApps: vi.fn(),
  localAppAction: vi.fn(),
}));
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
  mocks.localApps.mockRejectedValue(new Error('not available'));
  mocks.localAppAction.mockResolvedValue(undefined);
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

it('compares this Mac with Studio and updates either one, or all apps on each', async () => {
  const studio = structuredClone(status);
  studio.apps[0]!.version = '1.2.1';
  studio.apps[4]!.version = '0.4.1';
  studio.updateAll = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    apps: [
      {
        appId: 'flow',
        status: 'updated',
        step: null,
        progress: null,
        message: 'Updated 1.2.0 → 1.2.1.',
      },
      {
        appId: 'jam',
        status: 'working',
        step: 'Downloading 0.5.0…',
        progress: 0.42,
        message: null,
      },
      { appId: 'scout', status: 'queued', step: null, progress: null, message: null },
      {
        appId: 'bloom',
        status: 'failed',
        step: null,
        progress: null,
        message: 'Did not confirm restarting.',
      },
    ],
  };
  const laptop = structuredClone(status);
  laptop.computer = 'Laptop';
  laptop.apps[0]!.version = '1.2.0';
  laptop.apps[0]!.updates = {
    supported: true,
    configured: true,
    busy: false,
    phase: 'ready',
    progress: 1,
    release: { version: '1.2.1', build: 'f'.repeat(64) },
    blockers: [],
    message: null,
  };
  laptop.apps[4]!.version = '0.4.1';
  Object.assign(laptop.apps[5]!, {
    state: 'needs-install',
    version: null,
    install: { version: null },
  });
  mocks.apps.mockResolvedValue(studio);
  mocks.localApps.mockResolvedValue(laptop);
  await render();
  const flow = page.getByRole('article', { name: 'Flow', exact: true });
  await expect.element(flow.getByText('This Mac 1.2.0 · Studio 1.2.1')).toBeVisible();
  await expect
    .element(flow.getByText('This Mac is behind Studio. They need the same version to connect.'))
    .toBeVisible();
  // Same version: no warning.
  expect(container.querySelector('[aria-label="Wondercraft"] [role="status"]')).toBeNull();
  await expect
    .element(
      page
        .getByRole('article', { name: 'Scout', exact: true })
        .getByText('This Mac not installed · Studio 0.3.0')
    )
    .toBeVisible();
  await expect.element(page.getByText('Updating all on Studio · 2 of 4 done')).toBeVisible();
  await expect.element(flow.getByText('Studio: Updated 1.2.0 → 1.2.1.')).toBeVisible();
  const jam = page.getByRole('article', { name: 'Jam', exact: true });
  await expect.element(jam.getByText('Studio: Downloading 0.5.0… 42%')).toBeVisible();
  expect(container.querySelector<HTMLProgressElement>('[aria-label="Jam"] progress')?.value).toBe(
    0.42
  );
  await expect
    .element(
      page
        .getByRole('article', { name: 'Scout', exact: true })
        .getByText('Studio: Waiting to update…')
    )
    .toBeVisible();
  expect(
    container.querySelector('[aria-label="Bloom"] [data-outcome="failed"] .taixu-app-blockers')
      ?.textContent
  ).toBe('Studio: Did not confirm restarting.');
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Update all on Studio')
      ?.disabled
  ).toBe(true);
  if (import.meta.env.VITE_TAIXU_UPDATE_ALL_SCREENSHOT)
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_UPDATE_ALL_SCREENSHOT });
  await flow.getByRole('button', { name: 'Update this Mac to 1.2.1' }).click();
  expect(mocks.localAppAction).toHaveBeenCalledExactlyOnceWith({
    appId: 'flow',
    action: 'update',
    build: 'f'.repeat(64),
    ceiling: '1.2.1',
  });
  await page.getByRole('button', { name: 'Update all on this Mac' }).click();
  // Studio's installed versions cap this Mac; Studio has no Scout version to pass.
  const call = mocks.localAppAction.mock.lastCall![0];
  expect(call.action).toBe('update-all');
  expect(call.ceilings).toContainEqual({ appId: 'flow', version: '1.2.1' });
  expect(call.ceilings).toContainEqual({ appId: 'wondercraft', version: '0.4.1' });
  expect(mocks.appAction).not.toHaveBeenCalled();
});

it('shows one computer when this Mac is the selected one', async () => {
  mocks.localApps.mockResolvedValue(structuredClone(status));
  await render();
  expect(container.textContent).not.toContain('This Mac');
  await page.getByRole('button', { name: 'Update all on Studio' }).click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({ action: 'update-all' });
});

it('summarises a finished Update all and labels each app without a computer name on one Mac', async () => {
  const one = structuredClone(status);
  one.updateAll = {
    running: false,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    apps: [
      {
        appId: 'flow',
        status: 'updated',
        step: null,
        progress: null,
        message: 'Updated 1.2.0 → 1.3.0.',
      },
      {
        appId: 'jam',
        status: 'current',
        step: null,
        progress: null,
        message: 'Up to date (0.5.0).',
      },
      {
        appId: 'taste',
        status: 'skipped',
        step: null,
        progress: null,
        message: 'Set up its Settings → Updates first.',
      },
    ],
  };
  mocks.apps.mockResolvedValue(one);
  await render();
  await expect
    .element(page.getByText('Update all on Studio finished · 1 updated, 1 up to date, 1 skipped'))
    .toBeVisible();
  await expect
    .element(
      page
        .getByRole('article', { name: 'Taste', exact: true })
        .getByText('Set up its Settings → Updates first.', { exact: true })
    )
    .toBeVisible();
  expect(
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Update all on Studio')
      ?.disabled
  ).toBe(false);
});

it('does not let this Mac update past the version Studio runs', async () => {
  const studio = structuredClone(status);
  studio.apps[4]!.version = '0.4.1';
  const laptop = structuredClone(status);
  laptop.computer = 'Laptop';
  laptop.apps[4]!.version = '0.4.1';
  laptop.apps[4]!.updates = {
    supported: true,
    configured: true,
    busy: false,
    phase: 'ready',
    progress: 1,
    release: { version: '0.5.0', build: 'a'.repeat(64) },
    blockers: [],
    message: null,
  };
  mocks.apps.mockResolvedValue(studio);
  mocks.localApps.mockResolvedValue(laptop);
  await render();
  const card = page.getByRole('article', { name: 'Wondercraft', exact: true });
  await expect
    .element(card.getByRole('button', { name: 'Update this Mac to 0.5.0' }))
    .toBeDisabled();
  await expect
    .element(
      card.getByText(
        'Studio has 0.4.1. Update Studio first so this Mac does not get ahead (0.5.0).'
      )
    )
    .toBeVisible();
});

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { UsageOverview } from '@core/features/usage/api/schemas';
import { TaixuShell } from './taixu-shell';
import '@emdash/ui/style.css';

const mocks = vi.hoisted(() => ({
  apps: vi.fn(),
  appAction: vi.fn(),
  connect: vi.fn(),
  taskExists: vi.fn(async () => true),
  navigate: vi.fn(),
  openModal: vi.fn(async () => undefined),
  status: vi.fn(),
  studioStatus: vi.fn(),
  setServerMode: vi.fn(),
  share: vi.fn(),
  usageState: vi.fn(),
  refreshUsage: vi.fn(),
  retryUsage: vi.fn(),
}));
vi.mock('../api/browser/client', () => ({
  getTaixuClient: async () => ({
    apps: mocks.apps,
    appAction: mocks.appAction,
    connect: mocks.connect,
    taskExists: mocks.taskExists,
    status: mocks.status,
  }),
}));
vi.mock('@core/manifests/browser/modal-api', () => ({ openModal: mocks.openModal }));
vi.mock('@core/primitives/navigation/browser/navigation-selectors', () => ({
  getNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock('@core/features/settings/contributions/views', () => ({
  settingsViewDef: (p: unknown) => p,
}));
vi.mock('@core/features/tasks/contributions/views', () => ({ taskViewDef: (p: unknown) => p }));
vi.mock('@core/features/workbench/api/browser/open-external-link', () => ({
  confirmOpenExternalLink: vi.fn(),
}));
vi.mock('../api/browser/studio-client', () => ({
  isStudioDesktop: () => false,
  getStudioClient: async () => ({
    status: mocks.studioStatus,
    setServerMode: mocks.setServerMode,
    share: mocks.share,
  }),
}));
vi.mock('./update-button', () => ({
  UpdateButton: () => <span data-testid="updates">Updates</span>,
}));
vi.mock('@core/primitives/wire/browser/use-remote-model-state', () => ({
  useRemoteModelState: mocks.usageState,
}));
vi.mock('@core/features/usage/api/browser/client', () => ({
  getUsageClient: async () => ({ refresh: mocks.refreshUsage }),
}));
vi.mock('@core/features/agents/contributions/browser/agent-icon', () => ({
  AgentIcon: () => null,
}));

let host: HTMLDivElement;
let root: Root;
const flowApp = {
  id: 'flow',
  name: 'Flow',
  detail: 'Browse and play the Studio library from your laptop.',
  supported: true,
  state: 'stopped',
  endpoint: null,
  windowOpen: false,
  blockers: [],
  version: '1.0.0',
};
const studio = {
  selected: null,
  name: null,
  connected: false,
  sharing: true,
  serverMode: false,
  socketPath: '/tmp/example/desktop.sock',
  error: null,
  machines: [],
  build: '0123456789abcdef',
  uptimeSeconds: 7260,
};
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ url: `${location.origin}/?taixu-test`, error: null });
  mocks.status.mockResolvedValue({ running: true });
  mocks.apps.mockResolvedValue({ computer: 'Studio', apps: [flowApp] });
  mocks.appAction.mockResolvedValue({ computer: 'Studio', apps: [flowApp] });
  mocks.studioStatus.mockResolvedValue({ ...studio });
  mocks.setServerMode.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue({ ...studio });
  mocks.usageState.mockReturnValue({
    value: { accounts: [], machines: [] },
    isLoading: false,
    error: undefined,
    refresh: mocks.retryUsage,
  });
  mocks.refreshUsage.mockResolvedValue(undefined);
  mocks.retryUsage.mockResolvedValue(undefined);
  host = document.createElement('div');
  host.className = 'emdark';
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function Harness({ restored = false }) {
  const [inspecting, setInspecting] = useState(restored);
  return (
    <TaixuShell
      inspecting={inspecting}
      onInspect={setInspecting}
      workbench={<div data-testid="existing-work">Existing task and review surface</div>}
    />
  );
}
async function mount(restored = false) {
  await act(async () => root.render(<Harness restored={restored} />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function message(data: object, trusted = true) {
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: trusted ? host.querySelector('iframe')!.contentWindow : window,
        origin: location.origin,
        data: { type: 'taixu', ...data },
      })
    )
  );
}
it('opens a valid offline home without Start work and retains Inspect work', async () => {
  mocks.connect.mockResolvedValue({ url: null, error: null });
  await mount();
  expect(host.querySelector('header')!.textContent).not.toContain('Start work');
  expect(host.querySelector('main')!.hidden).toBe(false);
  expect(host.textContent).toContain('Open Taixu');
  await click('Inspect work');
  expect(host.querySelector<HTMLElement>('.taixu-workbench')!.hidden).toBe(false);
  await click('Back to Taixu');
  expect(host.querySelector('main')!.hidden).toBe(false);
});
it('retains restored work and its review surface when returning to the world', async () => {
  await mount(true);
  const work = host.querySelector('[data-testid="existing-work"]');
  expect(host.querySelector<HTMLElement>('.taixu-workbench')!.hidden).toBe(false);
  await click('Back to Taixu');
  await click('Inspect work');
  expect(host.querySelector('[data-testid="existing-work"]')).toBe(work);
});
it('opens the native review dialog with the saved brief prompt', async () => {
  await mount();
  await message({ action: 'create-task', prompt: '# Approved saved brief' });
  expect(mocks.openModal).toHaveBeenCalledExactlyOnceWith('taskModal', {
    initialPrompt: '# Approved saved brief',
    initialName: undefined,
    projectId: undefined,
  });
});
it('opens an existing native task through its world link', async () => {
  await mount();
  await message({ action: 'inspect-task', projectId: 'project-1', taskId: 'task-1' });
  expect(mocks.taskExists).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
  expect(mocks.navigate).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
  expect(host.querySelector<HTMLElement>('.taixu-workbench')!.hidden).toBe(false);
});
it('ignores launch requests from outside the embedded world', async () => {
  await mount();
  await message({ action: 'create-task', prompt: 'untrusted' }, false);
  expect(mocks.openModal).not.toHaveBeenCalled();
});

it('unloads the world without restarting the backend, and restores it on request', async () => {
  await mount();
  const previousFrame = host.querySelector('iframe');
  const updates = host.querySelector('[data-testid="updates"]');
  expect(previousFrame).not.toBeNull();
  await click('This Mac ▾');
  await click('Use server mode');
  expect(mocks.setServerMode).toHaveBeenCalledExactlyOnceWith({ enabled: true });
  expect(host.querySelector('iframe')).toBeNull();
  expect(previousFrame!.isConnected).toBe(false);
  expect(host.querySelector('[data-testid="updates"]')).toBe(updates);
  expect(host.querySelector('h1')?.textContent).toBe('Server mode');
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(mocks.share).not.toHaveBeenCalled();
  await click('Open Taixu');
  expect(mocks.setServerMode).toHaveBeenLastCalledWith({ enabled: false });
  expect(host.querySelector('iframe')).not.toBeNull();
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

it('waits for the saved mode before creating any iframe and keeps restored work hidden', async () => {
  let resolve!: (value: typeof studio) => void;
  mocks.studioStatus.mockReturnValue(
    new Promise<typeof studio>((done) => {
      resolve = done;
    })
  );
  const observedFrames: Element[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof Element)
          observedFrames.push(
            ...node.querySelectorAll('iframe'),
            ...(node.matches('iframe') ? [node] : [])
          );
  });
  observer.observe(host, { subtree: true, childList: true });
  try {
    await mount(true);
    expect(host.querySelector('iframe')).toBeNull();
    await act(async () => resolve({ ...studio, serverMode: true }));
    expect(host.querySelector('iframe')).toBeNull();
    expect(observedFrames).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.taixu-workbench')?.hidden).toBe(true);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  } finally {
    observer.disconnect();
  }
});

it('leaves the world mounted when saving server mode fails', async () => {
  await mount();
  const previousFrame = host.querySelector('iframe');
  mocks.setServerMode.mockRejectedValueOnce(new Error('Cannot save display preference.'));
  await click('This Mac ▾');
  await click('Use server mode');
  expect(host.textContent).toContain('Cannot save display preference.');
  expect(host.querySelector('iframe')).toBe(previousFrame);
});

it('shows and refreshes subscription usage without loading the world or restarting the backend', async () => {
  await page.viewport(520, 620);
  document.body.style.margin = '0';
  mocks.studioStatus.mockResolvedValue({ ...studio, serverMode: true });
  const overview: UsageOverview = {
    machines: [],
    accounts: [
      {
        key: 'example-codex',
        providerId: 'codex',
        account: { plan: 'ChatGPT Pro', email: 'studio@example.com' },
        sources: [],
        windows: [
          {
            id: 'five_hour',
            label: '5-hour',
            usedPercent: 25,
            resetsAt: Date.now() + 3_600_000,
            observedAt: Date.now(),
            sourceName: 'Example Studio',
            stale: false,
          },
        ],
      },
    ],
  };
  mocks.usageState.mockReturnValue({ value: overview, isLoading: false });
  await mount();
  expect(mocks.usageState).not.toHaveBeenCalled();
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Status');
  await click('Usage');
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Usage');
  expect(host.textContent).toContain('Codex Pro (studio@example.com)');
  expect(host.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('75');
  const usagePanel = host.querySelector<HTMLElement>('.taixu-server-usage')!;
  expect(usagePanel.scrollWidth).toBeLessThanOrEqual(usagePanel.clientWidth);
  if (import.meta.env.VITE_TAIXU_USAGE_SCREENSHOT) {
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_USAGE_SCREENSHOT });
  }
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!.click()
  );
  expect(mocks.refreshUsage).toHaveBeenCalledExactlyOnceWith(undefined, { timeoutMs: 45_000 });
  expect(host.querySelector('iframe')).toBeNull();
  expect(mocks.connect).toHaveBeenCalledTimes(1);
  expect(mocks.setServerMode).not.toHaveBeenCalled();
  expect(mocks.share).not.toHaveBeenCalled();
  await click('Status');
  expect(host.textContent).toContain('Running');
  await expect.poll(() => host.querySelector('[role="meter"]')).toBeNull();
  await click('Usage');
  await click('Open Taixu');
  expect(mocks.setServerMode).toHaveBeenCalledExactlyOnceWith({ enabled: false });
  expect(host.querySelector('iframe')).not.toBeNull();
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

it('keeps usage failures visible and allows retry from server mode', async () => {
  mocks.studioStatus.mockResolvedValue({ ...studio, serverMode: true });
  mocks.usageState.mockReturnValue({
    value: undefined,
    isLoading: false,
    error: new Error('Disconnected'),
    refresh: mocks.retryUsage,
  });
  mocks.refreshUsage.mockRejectedValueOnce(new Error('Still disconnected'));
  await mount();
  await click('Usage');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load usage.');
  expect(host.querySelector('[role="meter"]')).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!.click()
  );
  expect(mocks.retryUsage).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh usage.');
  expect(host.querySelector('iframe')).toBeNull();
});

it('shows real diagnostics, makes lost status unknown, and omits capability URLs from copies', async () => {
  mocks.studioStatus.mockResolvedValue({ ...studio, serverMode: true });
  mocks.connect.mockResolvedValue({
    url: `${location.origin}/secret-capability/?desktop=1`,
    error: null,
  });
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  try {
    await mount();
    expect(host.textContent).toContain('Running');
    expect(host.textContent).toContain('Enabled over SSH');
    expect(host.textContent).toContain('2h 1m');
    await click('Copy diagnostics');
    expect(writeText.mock.calls[0]![0]).toContain(`Local endpoint: ${location.origin}`);
    expect(writeText.mock.calls[0]![0]).not.toContain('secret-capability');
    mocks.status.mockRejectedValueOnce(new Error('Disconnected'));
    mocks.studioStatus.mockRejectedValueOnce(new Error('Disconnected'));
    await click('Refresh status');
    expect(host.textContent).not.toContain('Running');
    expect(host.textContent).not.toContain('Enabled over SSH');
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Backend status is unavailable.');
  } finally {
    writeText.mockRestore();
  }
});

it('fits server mode in its compact window', async () => {
  await page.viewport(520, 620);
  document.body.style.margin = '0';
  mocks.studioStatus.mockResolvedValue({ ...studio, serverMode: true });
  await mount();
  const main = host.querySelector('main')!;
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  const open = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Open Taixu'
  )!;
  expect(open.getBoundingClientRect().bottom).toBeLessThanOrEqual(620);
  if (import.meta.env.VITE_TAIXU_SCREENSHOT) {
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_SCREENSHOT });
  }
  await click('Usage');
  await page.viewport(440, 500);
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
  expect(open.getBoundingClientRect().bottom).toBeLessThanOrEqual(500);
  expect(host.querySelector('iframe')).toBeNull();
  await page.viewport(1280, 720);
});

it('controls apps on the selected computer and preserves action failures without stale controls', async () => {
  await mount();
  await click('Apps');
  expect(host.textContent).toContain('On Studio');
  expect(host.querySelector('.taixu-world')?.hasAttribute('hidden')).toBe(true);
  mocks.appAction.mockRejectedValueOnce(new Error('Action was not confirmed. Refresh.'));
  await click('Start service');
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({ appId: 'flow', action: 'start' });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('not confirmed');
  mocks.apps.mockRejectedValueOnce(new Error('offline'));
  await click('Refresh');
  expect(host.querySelector('.taixu-app-actions')).toBeNull();
  expect(host.textContent).toContain('Selected computer unavailable');
  await click('Refresh');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Start service');
  if (import.meta.env.VITE_TAIXU_APPS_FULL_SCREENSHOT)
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_APPS_FULL_SCREENSHOT });
  await click('Inspect work');
  expect(host.querySelector('.taixu-apps-page')).toBeNull();
});

it('shows the same Apps panel in compact server mode and disables stopping occupied Flow', async () => {
  await page.viewport(520, 620);
  mocks.studioStatus.mockResolvedValue({ ...studio, serverMode: true });
  mocks.apps.mockResolvedValue({
    computer: 'Studio',
    apps: [
      {
        ...flowApp,
        state: 'running',
        windowOpen: true,
        endpoint: 'http://127.0.0.1:47833',
        blockers: ['Close Flow’s windows before stopping its service.'],
      },
      {
        ...flowApp,
        id: 'bloom',
        name: 'Bloom',
        state: 'planned',
        supported: false,
        detail: 'Remote rendering is the next service to add.',
        version: null,
      },
      {
        ...flowApp,
        id: 'taste',
        name: 'Taste',
        state: 'planned',
        supported: false,
        detail: 'Search and downloads currently run on each Mac.',
        version: null,
      },
      {
        ...flowApp,
        id: 'jam',
        name: 'Jam',
        state: 'planned',
        supported: false,
        detail: 'The music library currently runs on each Mac.',
        version: null,
      },
    ],
  });
  await mount();
  await click('Apps');
  expect(host.querySelector('iframe')).toBeNull();
  const stop = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Stop service')!;
  expect(stop.disabled).toBe(true);
  expect(host.querySelector('[aria-label="Bloom"] button')).toBeNull();
  const panel = host.querySelector<HTMLElement>('.taixu-server-apps')!;
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  if (import.meta.env.VITE_TAIXU_APPS_SCREENSHOT)
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_APPS_SCREENSHOT });
  await click('Open on Studio');
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({ appId: 'flow', action: 'open' });
  await click('Usage');
  await expect.poll(() => !!host.querySelector('.taixu-apps')?.checkVisibility()).toBe(false);
  await page.viewport(1280, 720);
});

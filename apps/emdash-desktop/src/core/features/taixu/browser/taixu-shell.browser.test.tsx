import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TaixuShell } from './taixu-shell';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  taskExists: vi.fn(async () => true),
  navigate: vi.fn(),
  openModal: vi.fn(async () => undefined),
}));
vi.mock('../api/browser/client', () => ({
  getTaixuClient: async () => ({
    connect: mocks.connect,
    taskExists: mocks.taskExists,
    status: async () => ({ running: true }),
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
vi.mock('./studio-selector', () => ({ StudioSelector: () => <span>This Mac</span> }));
vi.mock('./update-button', () => ({ UpdateButton: () => <span>Updates</span> }));

let host: HTMLDivElement;
let root: Root;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ url: `${location.origin}/?taixu-test`, error: null });
  host = document.createElement('div');
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

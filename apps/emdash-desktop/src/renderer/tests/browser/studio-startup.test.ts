import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { seedDesktopWire } from '@renderer/lib/runtime/seed-desktop-wire';

const mock = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  seed: vi.fn(),
  setRemote: vi.fn(),
}));
vi.mock('@core/features/taixu/api/browser/studio-client', () => ({
  getStudioClient: async () => ({ status: mock.status, connect: mock.connect }),
  setStudioDesktop: mock.setRemote,
}));
vi.mock('@core/primitives/wire/browser/connection', () => ({
  seedWireConnection: mock.seed,
  resetWireConnection: vi.fn(),
}));

afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
  document.getElementById('boot-splash')?.remove();
  document.getElementById('taixu-connection-gate')?.remove();
  vi.clearAllMocks();
});

function splash() {
  const element = document.createElement('div');
  element.id = 'boot-splash';
  element.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white';
  document.body.append(element);
  return element;
}

it('makes recovery clickable above the startup splash before initializing desktop stores', async () => {
  splash();
  const offline = { selected: 'studio', name: 'My Studio', connected: false, error: 'Offline' };
  mock.status.mockResolvedValue(offline);
  mock.connect.mockResolvedValue({ ...offline, connected: true, error: null });
  const startup = seedDesktopWire();
  const reconnect = page.getByRole('button', { name: 'Reconnect to Studio', exact: true });
  await expect.element(reconnect).toBeVisible();
  // Recovery keeps its own standalone Updates, for when the desktop builds differ.
  expect(
    document.querySelector('#taixu-connection-gate details.taixu-update summary')?.textContent
  ).toBe('Updates');
  expect(mock.seed).not.toHaveBeenCalled();
  // A real pointer click catches an invisible splash intercepting the button.
  await reconnect.click();
  await startup;
  expect(mock.connect).toHaveBeenCalledWith({ id: 'studio' });
  expect(mock.seed).toHaveBeenCalledOnce();
  expect(mock.setRemote).toHaveBeenCalledWith(true, 'My Studio');
});

it('preserves the normal startup splash when opening this Mac', async () => {
  const element = splash();
  mock.status.mockResolvedValue({ selected: null });
  await seedDesktopWire();
  expect(element.classList.contains('boot-splash-done')).toBe(false);
  expect(mock.seed).toHaveBeenCalledOnce();
  expect(mock.setRemote).toHaveBeenCalledWith(false);
});

it('automatically reconnects the saved Studio after a laptop restart before desktop stores load', async () => {
  splash();
  const saved = { selected: 'studio', name: 'My Studio', connected: false, error: null };
  mock.status.mockResolvedValue(saved);
  mock.connect.mockImplementation(async () => {
    expect(mock.seed).not.toHaveBeenCalled();
    return { ...saved, connected: true };
  });
  await seedDesktopWire();
  expect(mock.connect).toHaveBeenCalledExactlyOnceWith({ id: 'studio' });
  expect(mock.setRemote).toHaveBeenCalledWith(true, 'My Studio');
  expect(mock.seed).toHaveBeenCalledOnce();
  expect(document.getElementById('taixu-connection-gate')).toBeNull();
});

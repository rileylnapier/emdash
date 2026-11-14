import type { Connection } from '@emdash/wire/rpc';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createUpdateCoordinator } from './update-coordinator';
import type { createUpdateHost } from './update-host';
const mock = vi.hoisted(() => ({
  info: vi.fn(),
  chunk: vi.fn(),
  prepare: vi.fn(),
  cancel: vi.fn(),
  commit: vi.fn(),
  download: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@emdash/wire/rpc', async (original) => ({
  ...(await original<object>()),
  client: () => mock,
}));
vi.mock('./update-files', () => ({ downloadRelease: mock.download, readRelease: mock.read }));
const release = {
  protocol: 1,
  build: 'a'.repeat(64),
  arch: process.arch,
  size: 12,
  sha256: 'b'.repeat(64),
  createdAt: new Date().toISOString(),
  notes: 'Buildings and updater',
};
let coordinator: ReturnType<typeof createUpdateCoordinator>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});
afterEach(async () => {
  await coordinator?.dispose();
  vi.useRealTimers();
});
async function setup() {
  const order: string[] = [];
  let source: string | null = 'studio';
  const host = {
    build: 'c'.repeat(64),
    root: '/unused',
    stage: vi.fn(async () => {}),
    prepare: vi.fn(async () => {
      order.push('local prepare');
      return 'local';
    }),
    commit: vi.fn(async () => {
      order.push('local commit');
    }),
    cancel: vi.fn(async () => {}),
  };
  mock.info.mockResolvedValue({ build: 'old', release });
  mock.prepare.mockImplementation(async () => {
    order.push('remote prepare');
    return 'remote';
  });
  mock.commit.mockImplementation(async () => {
    order.push('remote commit');
    mock.info.mockResolvedValue({ build: release.build, release });
    return { accepted: true, error: null };
  });
  mock.cancel.mockResolvedValue(undefined);
  const close = vi.fn();
  coordinator = createUpdateCoordinator({
    host: host as unknown as ReturnType<typeof createUpdateHost>,
    source: () => source,
    openPeer: async () => ({ connection: {} as Connection, close }),
  });
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('ready');
  return {
    host,
    order,
    close,
    switchSource: () => {
      source = null;
      coordinator.invalidate();
    },
  };
}
it('owns a background download, then prepares both Macs and confirms Studio before local commit', async () => {
  const { order, host } = await setup();
  coordinator.check();
  expect(mock.download).toHaveBeenCalledOnce();
  coordinator.install();
  await vi.advanceTimersByTimeAsync(2100);
  expect(order).toEqual(['local prepare', 'remote prepare', 'remote commit', 'local commit']);
  expect(host.cancel).toHaveBeenCalledWith('local');
});
it('leaves both apps alone when the Studio has active work', async () => {
  const { host } = await setup();
  mock.prepare.mockRejectedValueOnce(new Error('Active Head conversation'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'error',
    message: 'Active Head conversation',
  });
  expect(mock.commit).not.toHaveBeenCalled();
  expect(host.commit).not.toHaveBeenCalled();
  expect(host.cancel).toHaveBeenCalledWith('local');
});
it('reports a definitive restart rejection immediately and releases both reservations', async () => {
  const { host } = await setup();
  mock.commit.mockResolvedValueOnce({ accepted: false, error: 'Unsaved changes' });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({ status: 'error', message: 'Unsaved changes' });
  expect(host.commit).not.toHaveBeenCalled();
  expect(mock.cancel).toHaveBeenCalledWith({ lease: 'remote' });
});
it('never retries an ambiguous commit or updates the laptop without confirming the Studio', async () => {
  const { host } = await setup();
  mock.commit.mockRejectedValueOnce(new Error('Lost reply'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(91000);
  expect(coordinator.status()).toMatchObject({
    status: 'error',
    message: expect.stringContaining('not confirmed'),
  });
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(host.commit).not.toHaveBeenCalled();
  expect(host.cancel).toHaveBeenCalledWith('local');
});
it('cancels installation after a source change, without replaying remote restart', async () => {
  const { host, switchSource } = await setup();
  mock.commit.mockRejectedValueOnce(new Error('Lost reply'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  switchSource();
  await vi.advanceTimersByTimeAsync(2100);
  expect(host.commit).not.toHaveBeenCalled();
  expect(host.cancel).toHaveBeenCalledWith('local');
  expect(coordinator.status().status).toBe('idle');
});

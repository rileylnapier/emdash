import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { maintenanceContract } from '../api/update-contract';
import { createUpdateHost } from './update-host';
const mock = vi.hoisted(() => ({
  idle: vi.fn(),
  stage: vi.fn(),
  verify: vi.fn(),
  launch: vi.fn(),
  hold: vi.fn(),
  release: vi.fn(),
  mark: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, quit: mock.quit, relaunch: mock.relaunch },
}));
vi.mock('./update-files', () => ({
  updateRoot: () => '/unused',
  readRelease: vi.fn(),
  readChunk: vi.fn(),
  stageRelease: mock.stage,
  verifyBundle: mock.verify,
  launchInstaller: mock.launch,
  removeUpdateDirectory: vi.fn(),
}));
vi.mock('./update-guard', () => ({
  holdForUpdate: mock.hold,
  markTaixuInstallRequested: mock.mark,
}));
const release = {
  protocol: 1 as const,
  build: 'a'.repeat(64),
  arch: 'arm64' as const,
  size: 12,
  sha256: 'b'.repeat(64),
  createdAt: new Date().toISOString(),
  notes: 'Update',
};
let host: ReturnType<typeof createUpdateHost>;
const resources = process.resourcesPath;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/Applications/Taixu.app/Contents/Resources',
  });
  mock.stage.mockResolvedValue({ directory: '/unused-stage', bundle: '/unused-stage/Taixu.app' });
  mock.hold.mockResolvedValue(mock.release);
  host = createUpdateHost('/unused', 'old', mock.idle);
});
afterEach(async () => {
  await host.dispose();
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
  vi.useRealTimers();
});
it('expires a prepared lease and prevents stale commits', async () => {
  await host.stage(release);
  const lease = await host.prepare(release.build);
  await vi.advanceTimersByTimeAsync(600001);
  await expect(host.commit(lease)).rejects.toThrow(/expired/);
  expect(mock.release).toHaveBeenCalledOnce();
  expect(mock.launch).not.toHaveBeenCalled();
});
it('freezes a lease through commit verification and cancels safely on verification failure', async () => {
  await host.stage(release);
  const lease = await host.prepare(release.build);
  let fail!: (e: Error) => void;
  mock.verify.mockImplementationOnce(
    () =>
      new Promise((_r, reject) => {
        fail = reject;
      })
  );
  const committing = host.commit(lease);
  const rejected = expect(committing).rejects.toThrow('bad signer');
  await vi.advanceTimersByTimeAsync(0);
  await host.cancel(lease);
  await vi.advanceTimersByTimeAsync(600001);
  expect(mock.release).not.toHaveBeenCalled();
  fail(new Error('bad signer'));
  await rejected;
  expect(mock.release).toHaveBeenCalledOnce();
  expect(mock.launch).not.toHaveBeenCalled();
  expect(mock.quit).not.toHaveBeenCalled();
});
it('rejects concurrent stages, and only quits after installer dispatch', async () => {
  let finish!: (v: object) => void;
  mock.stage.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      })
  );
  const staging = host.stage(release);
  await expect(host.stage(release)).rejects.toThrow(/already/);
  finish({ directory: '/unused', bundle: '/unused/Taixu.app' });
  await staging;
  const lease = await host.prepare(release.build);
  await host.commit(lease);
  expect(mock.verify).toHaveBeenCalledOnce();
  expect(mock.launch).toHaveBeenCalledOnce();
  expect(mock.mark).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  await host.cancel(lease);
  expect(mock.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(mock.quit).toHaveBeenCalledOnce();
});
it('returns a definitive refusal over maintenance when activity starts before commit', async () => {
  await host.stage(release);
  const lease = await host.prepare(release.build);
  mock.idle.mockRejectedValue(new Error('Active work'));
  const wire = createTestWire(maintenanceContract, host.controller);
  try {
    expect(await wire.client.commit({ lease })).toEqual({ accepted: false, error: 'Active work' });
  } finally {
    await wire.dispose();
  }
  expect(mock.launch).not.toHaveBeenCalled();
  expect(mock.release).toHaveBeenCalledOnce();
});

it('retains the staged bundle after a readiness refusal and verifies it again on retry', async () => {
  await host.stage(release);
  mock.hold.mockRejectedValueOnce(new Error('codex · local-task is working'));
  await expect(host.prepare(release.build)).rejects.toThrow('local-task');
  expect(mock.launch).not.toHaveBeenCalled();
  expect(mock.quit).not.toHaveBeenCalled();
  const lease = await host.prepare(release.build);
  await host.commit(lease);
  expect(mock.stage).toHaveBeenCalledOnce();
  expect(mock.verify).toHaveBeenCalledWith(
    '/unused-stage/Taixu.app',
    '/Applications/Taixu.app',
    release
  );
  expect(mock.launch).toHaveBeenCalledOnce();
});

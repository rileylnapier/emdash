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
  readPending: vi.fn(),
  savePending: vi.fn(),
}));
vi.mock('@emdash/wire/rpc', async (original) => ({
  ...(await original<object>()),
  client: () => mock,
}));
vi.mock('./update-journal', () => ({
  attemptDirectory: (_root: string, id: string) => `/logs/${id}`,
  readPendingStudioUpdates: mock.readPending,
  savePendingStudioUpdates: mock.savePending,
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
  mock.readPending.mockResolvedValue({});
});
afterEach(async () => {
  await coordinator?.dispose();
  vi.useRealTimers();
});
async function setup({ studioCurrent = false, laptopCurrent = false } = {}) {
  const order: string[] = [];
  let source: string | null = 'studio';
  const host = {
    build: laptopCurrent ? release.build : 'c'.repeat(64),
    root: '/unused',
    recover: vi.fn(
      async (): Promise<{ attempt: unknown; ready: unknown }> => ({ attempt: null, ready: null })
    ),
    installedBuild: vi.fn(async () => (laptopCurrent ? release.build : 'c'.repeat(64))),
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
  mock.info.mockResolvedValue({ build: studioCurrent ? release.build : 'old', release });
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
  const options = {
    host: host as unknown as ReturnType<typeof createUpdateHost>,
    source: () => source,
    openPeer: async () => ({ connection: {} as Connection, close }),
  };
  coordinator = createUpdateCoordinator(options);
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('ready');
  return {
    host,
    options,
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
    status: 'blocked',
    message: expect.stringContaining('Studio: Active Head conversation'),
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
  expect(coordinator.status()).toMatchObject({
    status: 'blocked',
    message: expect.stringContaining('Studio: Unsaved changes'),
  });
  expect(host.commit).not.toHaveBeenCalled();
  expect(mock.cancel).toHaveBeenCalledWith({ lease: 'remote' });
});
it('never retries an ambiguous commit or updates the laptop without confirming the Studio', async () => {
  const { host } = await setup();
  mock.commit.mockRejectedValueOnce(new Error('Lost reply'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(91000);
  expect(coordinator.status()).toMatchObject({
    status: 'blocked',
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

it('updates the laptop while an already-current Studio is busy, without reserving or restarting Studio', async () => {
  const { host } = await setup({ studioCurrent: true });
  mock.prepare.mockRejectedValue(new Error('codex · models is working'));
  expect(coordinator.status()).toMatchObject({ target: 'this-mac' });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.prepare).toHaveBeenCalledWith(release.build);
  expect(host.commit).toHaveBeenCalledWith('local');
  expect(coordinator.status().status).toBe('installing');
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(mock.commit).not.toHaveBeenCalled();
  expect(mock.cancel).not.toHaveBeenCalled();
});

it('checks Studio again at install time and skips a now-current Studio', async () => {
  const { host } = await setup();
  mock.info.mockResolvedValue({ build: release.build, release });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().target).toBe('this-mac');
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.prepare).not.toHaveBeenCalled();
});

it.each(['codex · laptop-task is working', 'Unsaved file: notes.ts'])(
  'protects laptop-owned work and files: %s',
  async (reason) => {
    const { host } = await setup({ studioCurrent: true });
    host.prepare.mockRejectedValue(new Error(reason));
    coordinator.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.status()).toMatchObject({
      status: 'blocked',
      release,
      target: 'this-mac',
      message: expect.stringContaining(`This Mac: ${reason}`),
    });
    expect(host.commit).not.toHaveBeenCalled();
    expect(mock.prepare).not.toHaveBeenCalled();
    expect(mock.commit).not.toHaveBeenCalled();
  }
);

it('retains a verified release through a block and retries directly without downloading or staging again', async () => {
  const { host } = await setup();
  mock.prepare.mockRejectedValueOnce(new Error('claude · studio-task is working'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'blocked',
    release,
    target: 'both',
    progress: 100,
    message: expect.stringContaining('Studio: claude · studio-task'),
  });
  coordinator.check();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(coordinator.status().status).toBe('blocked');
  coordinator.install();
  await vi.advanceTimersByTimeAsync(2100);
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.download).toHaveBeenCalledOnce();
  expect(host.stage).toHaveBeenCalledOnce();
});

it('does not let an unreadable diagnostic journal replace a readiness blocker or prevent retry', async () => {
  const { host } = await setup({ studioCurrent: true });
  host.prepare.mockRejectedValueOnce(new Error('codex · laptop-task is working'));
  host.recover.mockRejectedValueOnce(new Error('Journal is unreadable'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'blocked',
    release,
    message: expect.stringContaining('This Mac: codex · laptop-task is working'),
  });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.download).toHaveBeenCalledOnce();
  expect(mock.prepare).not.toHaveBeenCalled();
});

it('shows readiness until the local restart is committed', async () => {
  const { host } = await setup({ studioCurrent: true });
  let ready!: () => void;
  host.commit.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      })
  );
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'preparing',
    message: expect.not.stringContaining('Restarting'),
  });
  ready();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('installing');
});

it('does not restart or reserve an already-current laptop when only Studio needs updating', async () => {
  const { host } = await setup({ laptopCurrent: true });
  expect(coordinator.status().target).toBe('studio');
  coordinator.install();
  await vi.advanceTimersByTimeAsync(2100);
  expect(mock.prepare).toHaveBeenCalledOnce();
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(host.prepare).not.toHaveBeenCalled();
  expect(host.commit).not.toHaveBeenCalled();
  expect(mock.download).not.toHaveBeenCalled();
  expect(host.stage).not.toHaveBeenCalled();
  expect(coordinator.status()).toMatchObject({
    status: 'idle',
    message: 'Both installations are current.',
  });
});

it('reconciles a lost Studio commit on retry without ever replaying that commit', async () => {
  const { host } = await setup();
  mock.commit.mockRejectedValueOnce(new Error('Lost reply'));
  coordinator.install();
  await vi.advanceTimersByTimeAsync(91000);
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('blocked');
  expect(mock.prepare).toHaveBeenCalledOnce();
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(host.commit).not.toHaveBeenCalled();
  mock.info.mockResolvedValue({ build: release.build, release });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(mock.download).toHaveBeenCalledOnce();
});

it('recovers a staged blocked release after app restart without any network download', async () => {
  const { host, options } = await setup({ studioCurrent: true });
  await coordinator.dispose();
  host.recover.mockResolvedValue({
    ready: { release, cache: 'download', source: 'studio' },
    attempt: {
      id: 'attempt',
      computer: 'Laptop',
      release,
      phase: 'waiting-for-exit',
      updatedAt: new Date().toISOString(),
      error: 'Taixu did not quit',
    },
  });
  mock.download.mockClear();
  mock.info.mockClear();
  coordinator = createUpdateCoordinator(options);
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'blocked',
    release,
    message: expect.stringContaining('Laptop: update stopped at waiting-for-exit'),
    diagnostics: expect.stringContaining('Error: Taixu did not quit'),
  });
  expect(mock.info).toHaveBeenCalledOnce();
  expect(coordinator.status().target).toBe('this-mac');
  expect(mock.download).not.toHaveBeenCalled();
  expect(host.stage).toHaveBeenLastCalledWith(release, '/unused/download', 'studio');
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.prepare).not.toHaveBeenCalled();
});

it('persists uncertain Studio commits before dispatch and reconciles after coordinator recreation', async () => {
  const { options, host } = await setup();
  mock.commit.mockImplementationOnce(async () => {
    expect(mock.savePending).toHaveBeenCalledWith('/unused', new Map([['studio', release.build]]));
    throw new Error('Lost reply');
  });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(91000);
  await coordinator.dispose();
  mock.readPending.mockResolvedValue({ studio: release.build });
  coordinator = createUpdateCoordinator(options);
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('blocked');
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(host.commit).not.toHaveBeenCalled();
  mock.info.mockResolvedValue({ build: release.build, installedBuild: release.build, release });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.commit).toHaveBeenCalledOnce();
  expect(mock.commit).toHaveBeenCalledOnce();
  expect(mock.savePending).toHaveBeenLastCalledWith('/unused', new Map());
});

it('does not claim current when installed and running fingerprints disagree', async () => {
  const { host, options } = await setup({ studioCurrent: true });
  await coordinator.dispose();
  host.installedBuild.mockResolvedValue(release.build);
  coordinator = createUpdateCoordinator(options);
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'error',
    message: expect.stringContaining('installed and running builds differ'),
  });
  expect(host.commit).not.toHaveBeenCalled();
});

it('does not claim both current when a new Studio peer reports a disk mismatch', async () => {
  const { options } = await setup({ laptopCurrent: true });
  await coordinator.dispose();
  mock.info.mockResolvedValue({ build: release.build, installedBuild: 'd'.repeat(64), release });
  coordinator = createUpdateCoordinator(options);
  coordinator.check();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({ status: 'ready', target: 'studio' });
});

it('keeps a stale staged target from downgrading a Studio with a newer release', async () => {
  const { host } = await setup({ studioCurrent: true });
  mock.info.mockResolvedValue({
    build: 'd'.repeat(64),
    release: { ...release, build: 'd'.repeat(64) },
  });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status()).toMatchObject({
    status: 'error',
    message: expect.stringContaining('different release'),
  });
  expect(host.prepare).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(mock.commit).not.toHaveBeenCalled();
});

it('surfaces a helper timeout in the old process instead of displaying Restarting forever', async () => {
  const { host } = await setup({ studioCurrent: true });
  coordinator.install();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.status().status).toBe('installing');
  host.recover.mockResolvedValue({
    ready: null,
    attempt: {
      id: 'attempt',
      computer: 'Laptop',
      release,
      phase: 'waiting-for-exit',
      error: 'Taixu did not quit',
      updatedAt: new Date().toISOString(),
    },
  });
  await vi.advanceTimersByTimeAsync(2100);
  expect(coordinator.status()).toMatchObject({
    status: 'error',
    message: expect.stringContaining('Laptop: update stopped at waiting-for-exit'),
  });
  expect(host.commit).toHaveBeenCalledOnce();
  expect(coordinator.status().diagnostics).toContain('Taixu did not quit');
});

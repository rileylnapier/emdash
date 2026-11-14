import type * as NodeFs from 'node:fs/promises';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { maintenanceContract } from '../api/update-contract';
import { createUpdateHost } from './update-host';
import {
  readReadyUpdate,
  readUpdateAttempt,
  beginUpdateAttempt,
  setUpdatePhase,
} from './update-journal';
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
  diskBuild: vi.fn(),
  diskPath: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof NodeFs>();
  return {
    ...fs,
    realpath: (p: string) => (p === '/Applications/Taixu.app' ? mock.diskPath() : fs.realpath(p)),
    readFile: (p: string, ...args: unknown[]) =>
      p === '/Applications/Taixu.app/Contents/Resources/taixu-build.txt'
        ? mock.diskBuild()
        : Reflect.apply(fs.readFile, fs, [p, ...args]),
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: true, quit: mock.quit, relaunch: mock.relaunch },
}));
vi.mock('./update-files', () => ({
  updateRoot: (root: string) => root,
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
let root: string;
const executable = process.execPath;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mock.diskPath.mockResolvedValue('/Applications/Taixu.app');
  mock.diskBuild.mockResolvedValue('old');
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: '/Applications/Taixu.app/Contents/Resources',
  });
  mock.stage.mockResolvedValue({ directory: '/unused-stage', bundle: '/unused-stage/Taixu.app' });
  mock.hold.mockResolvedValue(mock.release);
  root = await mkdtemp(path.join(os.tmpdir(), 'taixu-host-'));
  host = createUpdateHost(root, 'old', mock.idle);
});
afterEach(async () => {
  await host.dispose();
  await rm(root, { recursive: true, force: true });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
  Object.defineProperty(process, 'execPath', { configurable: true, value: executable });
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
  await vi.waitFor(() => expect(mock.verify).toHaveBeenCalledOnce());
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
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
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

it('persists a readiness failure and restores its release in a new host', async () => {
  await host.stage(release, path.join(root, 'download'), 'studio');
  mock.hold.mockRejectedValueOnce(new Error('codex · local-task is working'));
  await expect(host.prepare(release.build)).rejects.toThrow('local-task');
  expect(await readUpdateAttempt(root)).toMatchObject({
    phase: 'checking-work',
    error: 'codex · local-task is working',
  });
  expect(await readReadyUpdate(root)).toMatchObject({
    release,
    cache: 'download',
    source: 'studio',
  });
  await host.dispose();
  host = createUpdateHost(root, 'old', mock.idle);
  const lease = await host.prepare(release.build);
  expect(mock.stage).toHaveBeenLastCalledWith(
    path.join(root, 'download'),
    '/Applications/Taixu.app',
    release
  );
  await host.commit(lease);
  expect(await readUpdateAttempt(root)).toMatchObject({ phase: 'starting-installer', error: null });
});

it('records the failing verification phase without dispatching or quitting', async () => {
  await host.stage(release);
  const lease = await host.prepare(release.build);
  mock.verify.mockRejectedValue(new Error('bad signer'));
  await expect(host.commit(lease)).rejects.toThrow('bad signer');
  expect(await readUpdateAttempt(root)).toMatchObject({ phase: 'verifying', error: 'bad signer' });
  expect(mock.quit).not.toHaveBeenCalled();
  expect(mock.launch).not.toHaveBeenCalled();
});

it('never treats a legacy success receipt as confirmation of an interrupted attempt', async () => {
  await host.stage(release);
  const id = await beginUpdateAttempt(root, 'old', release);
  await setUpdatePhase(root, id, 'awaiting-startup');
  await writeFile(
    path.join(root, 'install-result.txt'),
    'Update installed. Previous app retained.'
  );
  expect((await host.recover()).attempt).toMatchObject({ id, phase: 'awaiting-startup' });
  expect(await readFile(path.join(root, 'install-result.txt'), 'utf8')).toContain(
    'Update installed'
  );
});

it.each(['matching', 'old-running', 'old-installed', 'different-copy', 'bad-signature'])(
  'confirms startup only for the verified target in /Applications: %s',
  async (kind) => {
    mock.diskBuild.mockResolvedValue(release.build);
    const id = await beginUpdateAttempt(root, 'old', release);
    await setUpdatePhase(root, id, 'awaiting-startup');
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value:
        kind === 'different-copy'
          ? '/tmp/Taixu.app/Contents/MacOS/Taixu'
          : '/Applications/Taixu.app/Contents/MacOS/Taixu',
    });
    if (kind === 'old-installed') mock.diskBuild.mockResolvedValue('old');
    if (kind === 'bad-signature') mock.verify.mockRejectedValue(new Error('bad signer'));
    await host.dispose();
    host = createUpdateHost(root, kind === 'old-running' ? 'old' : release.build, mock.idle);
    if (['old-installed', 'different-copy', 'bad-signature'].includes(kind))
      await expect(host.recover()).rejects.toThrow();
    else await host.recover();
    expect(await readUpdateAttempt(root)).toMatchObject({
      id,
      phase: kind === 'matching' ? 'confirmed' : 'awaiting-startup',
    });
    expect(mock.launch).not.toHaveBeenCalled();
    expect(mock.quit).not.toHaveBeenCalled();
  }
);

it('does not restage or retry while an earlier installer is still alive', async () => {
  const id = await beginUpdateAttempt(root, 'old', release);
  await writeFile(
    path.join(root, 'attempts', id, 'state.json'),
    JSON.stringify({
      phase: 'waiting-for-exit',
      error: null,
      installerPid: process.pid,
      updatedAt: new Date().toISOString(),
    })
  );
  await expect(host.stage(release)).rejects.toThrow('still running');
  await expect(host.prepare(release.build)).rejects.toThrow('still running');
  expect(mock.stage).not.toHaveBeenCalled();
  expect(mock.launch).not.toHaveBeenCalled();
});

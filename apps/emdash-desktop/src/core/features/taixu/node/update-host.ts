import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createController } from '@emdash/wire/rpc';
import { app } from 'electron';
import { maintenanceContract, type TaixuRelease } from '../api/update-contract';
import {
  launchInstaller,
  readChunk,
  readRelease,
  removeUpdateDirectory,
  stageRelease,
  updateRoot,
  verifyBundle,
} from './update-files';
import { holdForUpdate, markTaixuInstallRequested } from './update-guard';

export function createUpdateHost(userData: string, build: string, assertIdle: () => Promise<void>) {
  const root = updateRoot(userData);
  const installed = path.resolve(process.resourcesPath, '../..');
  let staged: { directory: string; bundle: string; release: TaixuRelease } | undefined;
  let reservation:
    | {
        id: string;
        target: string;
        release: () => Promise<void>;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let preparing = false;
  let staging = false;
  let installing = false;
  let disposed = false;
  async function cancel(id?: string) {
    if (!reservation || (id && reservation.id !== id) || installing) return;
    const current = reservation;
    reservation = undefined;
    clearTimeout(current.timer);
    await current.release();
  }
  async function stageInternal(release: TaixuRelease, sourceRoot = root) {
    if (disposed) throw new Error('Taixu is shutting down.');
    if (!app.isPackaged) throw new Error('Updates are available in the installed Taixu app.');
    if (reservation || installing || staging)
      throw new Error('An update is already being prepared.');
    staging = true;
    try {
      if (staged?.release.build === release.build) return;
      if (staged) await removeUpdateDirectory(staged.directory);
      staged = undefined;
      const result = await stageRelease(sourceRoot, installed, release);
      if (disposed) throw new Error('Taixu is shutting down.');
      staged = { ...result, release };
    } finally {
      staging = false;
    }
  }
  async function stage(release: TaixuRelease, sourceRoot = root) {
    if (preparing) throw new Error('An update is already being prepared.');
    return stageInternal(release, sourceRoot);
  }
  async function prepare(target: string) {
    if (disposed) throw new Error('Taixu is shutting down.');
    if (reservation || preparing || staging || installing)
      throw new Error('An update is already being prepared.');
    preparing = true;
    try {
      if (target !== build && staged?.release.build !== target) {
        const release = await readRelease(root);
        if (release?.build !== target)
          throw new Error('The selected release is no longer available.');
        await stageInternal(release);
      }
      const release = await holdForUpdate(assertIdle);
      if (disposed) {
        await release();
        throw new Error('Taixu is shutting down.');
      }
      const id = randomUUID();
      const timer = setTimeout(() => void cancel(id).catch(() => {}), 600000);
      reservation = { id, target, release, timer };
      return id;
    } finally {
      preparing = false;
    }
  }
  async function commit(id: string) {
    if (disposed) throw new Error('Taixu is shutting down.');
    if (!reservation || reservation.id !== id || installing)
      throw new Error('Update reservation expired. Check for updates again.');
    // Freeze the lease throughout verification; cancellation cannot race a commit.
    installing = true;
    const current = reservation;
    clearTimeout(current.timer);
    try {
      await assertIdle();
      if (disposed) throw new Error('Taixu is shutting down.');
      if (current.target !== build) {
        if (!staged || staged.release.build !== current.target)
          throw new Error('The prepared update is unavailable.');
        await verifyBundle(staged.bundle, installed, staged.release);
        if (disposed) throw new Error('Taixu is shutting down.');
        await launchInstaller(root, installed, staged.bundle);
      } else app.relaunch();
      markTaixuInstallRequested();
      setTimeout(() => app.quit(), 500);
    } catch (error) {
      installing = false;
      await cancel(id);
      throw error;
    }
  }

  const controller = createController(maintenanceContract, {
    info: async () => ({ build, release: await readRelease(root) }),
    chunk: async ({ build: requested, offset }) => {
      const release = await readRelease(root);
      if (release?.build !== requested)
        throw new Error('Release changed. Check for updates again.');
      return readChunk(root, release, offset);
    },
    prepare: ({ build: requested }) => prepare(requested),
    cancel: ({ lease }) => cancel(lease),
    commit: async ({ lease }) => {
      try {
        await commit(lease);
        return { accepted: true, error: null };
      } catch (error) {
        return {
          accepted: false,
          error:
            error instanceof Error ? error.message.slice(0, 600) : 'The Studio could not update.',
        };
      }
    },
  });
  return {
    controller,
    root,
    build,
    version: app.getVersion(),
    stage,
    prepare,
    commit,
    cancel,
    async dispose() {
      disposed = true;
      await cancel();
    },
  };
}

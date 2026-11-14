import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
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
import {
  attemptDirectory,
  beginUpdateAttempt,
  installerRunning,
  readReadyUpdate,
  readUpdateAttempt,
  saveReadyUpdate,
  setUpdatePhase,
  type UpdatePhase,
} from './update-journal';

export function createUpdateHost(userData: string, build: string, assertIdle: () => Promise<void>) {
  const root = updateRoot(userData);
  const installed = path.resolve(process.resourcesPath, '../..');
  let staged: { directory: string; bundle: string; release: TaixuRelease } | undefined;
  let reservation:
    | {
        id: string;
        attempt: string | undefined;
        target: string;
        release: () => Promise<void>;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let preparing = false;
  let staging = false;
  let installing = false;
  let disposed = false;
  const installedBuild = async () =>
    !app.isPackaged
      ? build
      : (await readFile(path.join(installed, 'Contents/Resources/taixu-build.txt'), 'utf8')).trim();
  let startup: Promise<void> | undefined;
  const recover = async () => {
    // Only the new process can acknowledge an installation. A legacy text
    // receipt is deliberately never used as evidence.
    startup ??= (async () => {
      const attempt = await readUpdateAttempt(root);
      if (!attempt) return;
      if (
        attempt.phase === 'awaiting-startup' &&
        !attempt.error &&
        build === attempt.release.build
      ) {
        if (
          !app.isPackaged ||
          installed !== '/Applications/Taixu.app' ||
          (await realpath(installed)) !== installed ||
          path.resolve(process.execPath) !== path.join(installed, 'Contents/MacOS/Taixu') ||
          (await installedBuild()) !== build
        )
          throw new Error('The installed and running Taixu builds do not match.');
        await verifyBundle(installed, installed, attempt.release);
        await setUpdatePhase(root, attempt.id, 'confirmed');
      }
    })();
    await startup;
    return { attempt: await readUpdateAttempt(root), ready: await readReadyUpdate(root) };
  };

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
      if ((await installedBuild()) !== build)
        throw new Error(
          'The installed and running Taixu builds differ. Reopen /Applications/Taixu.app before updating.'
        );
      if (installerRunning(await readUpdateAttempt(root)))
        throw new Error(
          'The previous installer is still running. Wait for it to finish before retrying.'
        );
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
  async function stage(release: TaixuRelease, sourceRoot = root, source: string | null = null) {
    if (preparing) throw new Error('An update is already being prepared.');
    await stageInternal(release, sourceRoot);
    await saveReadyUpdate(root, {
      release,
      cache: sourceRoot === root ? 'root' : 'download',
      source,
    });
  }
  async function prepare(target: string) {
    if (disposed) throw new Error('Taixu is shutting down.');
    if (reservation || preparing || staging || installing)
      throw new Error('An update is already being prepared.');
    preparing = true;
    let attempt: string | undefined;
    try {
      if ((await installedBuild()) !== build)
        throw new Error(
          'The installed and running Taixu builds differ. Reopen /Applications/Taixu.app before updating.'
        );
      if (installerRunning(await readUpdateAttempt(root)))
        throw new Error(
          'The previous installer is still running. Wait for it to finish before retrying.'
        );
      if (target !== build && staged?.release.build !== target) {
        const saved = await readReadyUpdate(root);
        const release = saved?.release.build === target ? saved.release : await readRelease(root);
        if (release?.build !== target)
          throw new Error('The selected release is no longer available.');
        await stageInternal(
          release,
          saved?.release.build === target && saved.cache === 'download'
            ? path.join(root, 'download')
            : root
        );
        if (saved?.release.build !== target)
          await saveReadyUpdate(root, { release, cache: 'root', source: null });
      }
      if (target !== build && staged)
        attempt = await beginUpdateAttempt(root, build, staged.release);
      const release = await holdForUpdate(assertIdle);
      if (disposed) {
        await release();
        throw new Error('Taixu is shutting down.');
      }
      const id = randomUUID();
      const timer = setTimeout(() => void cancel(id).catch(() => {}), 600000);
      reservation = { id, attempt, target, release, timer };
      return id;
    } catch (error) {
      if (attempt)
        await setUpdatePhase(
          root,
          attempt,
          'checking-work',
          error instanceof Error ? error.message : 'Readiness check failed.'
        );
      throw error;
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
    let phase: UpdatePhase = 'checking-work';
    try {
      await assertIdle();
      if ((await installedBuild()) !== build)
        throw new Error(
          'The installed app changed during update preparation. Reopen Taixu before retrying.'
        );
      if (disposed) throw new Error('Taixu is shutting down.');
      if (current.target !== build) {
        if (!staged || staged.release.build !== current.target)
          throw new Error('The prepared update is unavailable.');
        phase = 'verifying';
        if (current.attempt) await setUpdatePhase(root, current.attempt, phase);
        await verifyBundle(staged.bundle, installed, staged.release);
        if (disposed) throw new Error('Taixu is shutting down.');
        if (!current.attempt) throw new Error('Update attempt is unavailable.');
        phase = 'starting-installer';
        await setUpdatePhase(root, current.attempt, phase);
        await launchInstaller(root, installed, staged.bundle, {
          id: current.attempt,
          directory: attemptDirectory(root, current.attempt),
          build: staged.release.build,
          fromBuild: build,
        });
      } else app.relaunch();
      markTaixuInstallRequested();
      setTimeout(() => app.quit(), 500);
    } catch (error) {
      installing = false;
      try {
        if (current.attempt)
          await setUpdatePhase(
            root,
            current.attempt,
            phase,
            error instanceof Error ? error.message : 'Installation failed.'
          );
      } finally {
        await cancel(id);
      }
      throw error;
    }
  }

  const controller = createController(maintenanceContract, {
    info: async () => ({
      build,
      installedBuild: await installedBuild(),
      release: await readRelease(root),
    }),
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
    recover,
    installedBuild,
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

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  attemptDirectory,
  beginUpdateAttempt,
  readPendingStudioUpdates,
  readReadyUpdate,
  readUpdateAttempt,
  savePendingStudioUpdates,
  saveReadyUpdate,
  setUpdatePhase,
} from './update-journal';

let root: string;
const release = {
  protocol: 1 as const,
  build: 'a'.repeat(64),
  arch: 'arm64' as const,
  sha256: 'b'.repeat(64),
  size: 12,
  createdAt: new Date().toISOString(),
  notes: 'Test',
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'taixu-journal-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('keeps distinct attempts and recovers the newest even with a stale text success receipt', async () => {
  const previous = await beginUpdateAttempt(root, 'older', release);
  await setUpdatePhase(root, previous, 'confirmed');
  const current = await beginUpdateAttempt(root, 'old', release);
  await setUpdatePhase(root, current, 'checking-work', 'codex · task is working');
  await writeFile(path.join(root, 'install-result.txt'), 'Update installed');
  expect(await readUpdateAttempt(root)).toMatchObject({
    id: current,
    phase: 'checking-work',
    error: 'codex · task is working',
  });
  expect(
    JSON.parse(await readFile(path.join(attemptDirectory(root, previous), 'state.json'), 'utf8'))
      .phase
  ).toBe('confirmed');
});

it('persists release ownership and unresolved remote commits independently of process memory', async () => {
  await saveReadyUpdate(root, { release, cache: 'download', source: 'studio-connection' });
  await savePendingStudioUpdates(root, new Map([['studio-connection', release.build]]));
  expect(await readReadyUpdate(root)).toEqual({
    release,
    cache: 'download',
    source: 'studio-connection',
  });
  expect(await readPendingStudioUpdates(root)).toEqual({ 'studio-connection': release.build });
});

it('rejects journal links, oversized JSON, and paths disguised as attempt IDs', async () => {
  const outside = path.join(root, 'outside');
  await writeFile(outside, '{}');
  await symlink(outside, path.join(root, 'ready.json'));
  await expect(readReadyUpdate(root)).rejects.toThrow();
  expect(() => attemptDirectory(root, '../outside')).toThrow();
  await rm(path.join(root, 'ready.json'));
  await writeFile(path.join(root, 'ready.json'), ' '.repeat(32769), { mode: 0o600 });
  await expect(readReadyUpdate(root)).rejects.toThrow('Invalid update journal');
});

it('rejects state from a different attempt', async () => {
  const id = await beginUpdateAttempt(root, 'old', release);
  const file = path.join(attemptDirectory(root, id), 'attempt.json');
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.id = '11111111-1111-4111-8111-111111111111';
  await writeFile(file, JSON.stringify(metadata));
  await expect(readUpdateAttempt(root)).rejects.toThrow('identity does not match');
});

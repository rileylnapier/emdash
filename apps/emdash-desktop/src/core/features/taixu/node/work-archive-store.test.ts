import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkArchiveNote } from '../api/contract';
import { createWorkArchiveStore } from './work-archive-store';

vi.mock('electron', () => ({ app: {} }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'archive-notes-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const note: WorkArchiveNote = {
  taskId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project',
  name: 'Compact samples',
  context: 'Kept tags accessible. Follow up on keyboard navigation.',
  workspacePath: '/no-longer-present/worktree',
  branch: 'samples',
  commit: 'abc123',
  urls: ['https://github.com/example/repo/pull/1'],
  savedAt: '2026-11-14T00:00:00Z',
  archived: true,
  cleaned: true,
  message: 'Checkout removed.',
};
it('retains readable private context across restart, without needing the checkout', async () => {
  await createWorkArchiveStore(() => directory).save(note);
  const restarted = createWorkArchiveStore(() => directory);
  expect(await restarted.read(note)).toEqual(note);
  expect(await restarted.list(0)).toEqual({ notes: [note], nextOffset: null });
  const filename = path.join(directory, `${note.taskId}.json`);
  expect((await stat(filename)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(filename, 'utf8')).context).toBe(note.context);
});
it('rejects corrupt notes, cross-project reads and paths outside the archive', async () => {
  const store = createWorkArchiveStore(() => directory);
  await store.save(note);
  await expect(store.read({ ...note, projectId: 'other' })).rejects.toThrow('another work item');
  await expect(store.read({ ...note, taskId: '../outside' })).rejects.toThrow();
  await writeFile(path.join(directory, `${note.taskId}.json`), '{bad');
  await expect(store.read(note)).rejects.toThrow();
  await expect(store.list(0)).rejects.toThrow();
});
it('replaces a note without accumulating backup files and bounds context size', async () => {
  const store = createWorkArchiveStore(() => directory);
  await store.save(note);
  await store.save({ ...note, context: 'Revised decision.' });
  await expect(store.save({ ...note, context: 'x'.repeat(24001) })).rejects.toThrow();
  expect((await store.read(note))?.context).toBe('Revised decision.');
  expect((await store.list(0)).notes).toHaveLength(1);
});

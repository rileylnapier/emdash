import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import {
  workArchiveNoteSchema,
  workTargetSchema,
  type WorkArchiveNote,
  type WorkTarget,
} from '../api/contract';

export type WorkArchiveStore = ReturnType<typeof createWorkArchiveStore>;

/** Small, private handoffs live outside disposable checkouts, on the controlling Mac. */
export function createWorkArchiveStore(
  directory = () => path.join(app.getPath('userData'), 'work-archives')
) {
  const file = (target: WorkTarget) =>
    path.join(directory(), `${workTargetSchema.parse(target).taskId}.json`);
  async function read(target: WorkTarget): Promise<WorkArchiveNote | null> {
    try {
      const note = workArchiveNoteSchema.parse(JSON.parse(await readFile(file(target), 'utf8')));
      if (note.taskId !== target.taskId || note.projectId !== target.projectId)
        throw new Error('Archive belongs to another work item.');
      return note;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async function save(value: WorkArchiveNote) {
    const note = workArchiveNoteSchema.parse(value);
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const target = file(note);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(note, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function list(offset: number) {
    const files = await readdir(directory()).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const names = files.filter((name) => /^[\da-f-]{36}\.json$/i.test(name)).sort();
    const notes = await Promise.all(
      names
        .slice(offset, offset + 30)
        .map(async (name) =>
          workArchiveNoteSchema.parse(
            JSON.parse(await readFile(path.join(directory(), name), 'utf8'))
          )
        )
    );
    return { notes, nextOffset: names.length > offset + 30 ? offset + 30 : null };
  }
  return { read, save, list };
}

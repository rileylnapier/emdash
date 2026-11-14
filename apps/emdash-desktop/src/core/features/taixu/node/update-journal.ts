import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { buildSchema, releaseSchema, type TaixuRelease } from '../api/update-contract';

const phaseSchema = z.enum([
  'checking-work',
  'verifying',
  'starting-installer',
  'waiting-for-exit',
  'backing-up',
  'replacing',
  'awaiting-startup',
  'confirmed',
]);
export type UpdatePhase = z.infer<typeof phaseSchema>;
const stateSchema = z.object({
  phase: phaseSchema,
  installerPid: z.number().int().min(2).optional(),
  error: z.string().max(600).nullable(),
  updatedAt: z.string().datetime(),
});
const readySchema = z.object({
  release: releaseSchema,
  cache: z.enum(['root', 'download']),
  source: z.string().nullable(),
});
const attemptSchema = z.object({
  id: z.string().uuid(),
  computer: z.string(),
  fromBuild: z.string(),
  release: releaseSchema,
  createdAt: z.string().datetime(),
});
export type UpdateAttempt = z.infer<typeof attemptSchema> & z.infer<typeof stateSchema>;

// All files are bounded, private, and atomically replaced. Journal paths never
// come from a persisted path string or from a remote computer.
async function directory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('The update journal must be private and owned by this account.');
}
async function readJson(file: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 32768)
      throw new Error('Invalid update journal.');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
async function writeJson(file: string, value: unknown) {
  await directory(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export const attemptDirectory = (root: string, id: string) =>
  path.join(root, 'attempts', z.string().uuid().parse(id));
export async function saveReadyUpdate(root: string, value: z.infer<typeof readySchema>) {
  await writeJson(path.join(root, 'ready.json'), readySchema.parse(value));
}
export async function readReadyUpdate(root: string) {
  await directory(root);
  const value = await readJson(path.join(root, 'ready.json'));
  return value === null ? null : readySchema.parse(value);
}
export async function beginUpdateAttempt(root: string, fromBuild: string, release: TaixuRelease) {
  const metadata = attemptSchema.parse({
    id: randomUUID(),
    computer: hostname(),
    fromBuild,
    release,
    createdAt: new Date().toISOString(),
  });
  await directory(root);
  await directory(path.join(root, 'attempts'));
  await writeJson(path.join(attemptDirectory(root, metadata.id), 'attempt.json'), metadata);
  await setUpdatePhase(root, metadata.id, 'checking-work');
  await writeJson(path.join(root, 'latest-attempt.json'), { id: metadata.id });
  return metadata.id;
}
export async function setUpdatePhase(
  root: string,
  id: string,
  phase: UpdatePhase,
  error: string | null = null
) {
  await writeJson(
    path.join(attemptDirectory(root, id), 'state.json'),
    stateSchema.parse({
      phase,
      error: error?.slice(0, 600) ?? null,
      updatedAt: new Date().toISOString(),
    })
  );
}
export async function readUpdateAttempt(root: string): Promise<UpdateAttempt | null> {
  await directory(root);
  const latest = await readJson(path.join(root, 'latest-attempt.json'));
  if (!latest) return null;
  const { id } = z.object({ id: z.string().uuid() }).parse(latest);
  await directory(path.join(root, 'attempts'));
  const dir = attemptDirectory(root, id);
  await directory(dir);
  const metadata = attemptSchema.parse(await readJson(path.join(dir, 'attempt.json')));
  if (metadata.id !== id) throw new Error('Update attempt identity does not match.');
  return { ...metadata, ...stateSchema.parse(await readJson(path.join(dir, 'state.json'))) };
}

// A lost remote commit must survive a client restart; observing the target build
// is the only automatic way to clear it. Never replay the mutation after a timeout.
const pendingSchema = z.record(z.string(), buildSchema);
export async function readPendingStudioUpdates(root: string) {
  await directory(root);
  return pendingSchema.parse((await readJson(path.join(root, 'pending-studio.json'))) ?? {});
}
export async function savePendingStudioUpdates(root: string, values: Map<string, string>) {
  await writeJson(
    path.join(root, 'pending-studio.json'),
    pendingSchema.parse(Object.fromEntries(values))
  );
}

export function installerRunning(attempt: UpdateAttempt | null) {
  if (!attempt?.installerPid || attempt.phase === 'confirmed') return false;
  try {
    process.kill(attempt.installerPid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

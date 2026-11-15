import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { promises as diskFs } from 'original-fs';
import { releaseSchema, type TaixuRelease } from '../api/update-contract';

const exec = promisify(execFile);
const run = (command: string, args: string[]) =>
  exec(command, args, { timeout: 120000, maxBuffer: 8 * 1024 ** 2 });
export const CHUNK_SIZE = 256 * 1024;
export const updateRoot = (userData: string) => path.join(userData, 'updates');
// Only called for updater-owned paths. Electron's patched fs treats app.asar as
// a directory; remove the physical archive in staged and rollback bundles.
export async function removeUpdateDirectory(directory: string) {
  await diskFs.rm(directory, { recursive: true, force: true });
}
export const archivePath = (root: string, build: string) => {
  if (!/^[a-f0-9]{64}$/.test(build)) throw new Error('Invalid update build.');
  return path.join(root, `${build}.zip`);
};

export async function privateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('The update folder must be private and owned by this account.');
}

// Only updater-owned filenames in the private cache; never traverse user folders.
export async function pruneArchives(root: string, keep: string) {
  for (const name of await readdir(root)) {
    if (/^[a-f0-9]{64}\.zip$/.test(name) && name !== `${keep}.zip`)
      await rm(path.join(root, name), { force: true });
  }
}

export async function readRelease(root: string): Promise<TaixuRelease | null> {
  try {
    const file = path.join(root, 'release.json');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      throw new Error('Invalid update manifest.');
    return releaseSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyArchive(file: string, release: TaixuRelease) {
  const stat = await lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== release.size ||
    (await digest(file)) !== release.sha256
  )
    throw new Error('The downloaded update did not match its checksum. Check for updates again.');
}

export async function readChunk(root: string, release: TaixuRelease, offset: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= release.size ||
    offset % CHUNK_SIZE !== 0
  )
    throw new Error('Invalid update offset.');
  const file = await open(
    archivePath(root, release.build),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, release.size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Update archive changed.');
    return buffer.toString('base64');
  } finally {
    await file.close();
  }
}

export async function downloadRelease(
  root: string,
  release: TaixuRelease,
  chunk: (offset: number) => Promise<string>,
  progress: (n: number) => void,
  signal: AbortSignal
) {
  await privateDirectory(root);
  const destination = archivePath(root, release.build);
  try {
    await verifyArchive(destination, release);
    signal.throwIfAborted();
    await pruneArchives(root, release.build);
    progress(100);
    return destination;
  } catch {
    /* Retry a missing/incomplete download. */
  }
  signal.throwIfAborted();
  const partial = path.join(root, `${randomUUID()}.partial`);
  const file = await open(partial, 'wx', 0o600);
  try {
    for (let offset = 0; offset < release.size; offset += CHUNK_SIZE) {
      signal.throwIfAborted();
      const encoded = await chunk(offset);
      signal.throwIfAborted();
      if (encoded.length > CHUNK_SIZE * 1.4) throw new Error('Invalid update chunk.');
      const buffer = Buffer.from(encoded, 'base64');
      if (buffer.length !== Math.min(CHUNK_SIZE, release.size - offset))
        throw new Error('Incomplete update download.');
      await file.writeFile(buffer);
      progress(Math.floor(((offset + buffer.length) / release.size) * 100));
    }
    await file.sync();
    await file.close();
    await verifyArchive(partial, release);
    signal.throwIfAborted();
    await rename(partial, destination);
    await pruneArchives(root, release.build);
    return destination;
  } finally {
    await file.close();
    await rm(partial, { force: true });
  }
}

async function signature(bundle: string) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const { stdout, stderr } = await run('/usr/bin/codesign', ['-d', '-r-', '--verbose=2', bundle]);
  if (
    !/^Authority=Apple (Development|Distribution):/m.test(stderr) ||
    !/^Identifier=life\.taixu\.desktop$/m.test(stderr)
  )
    throw new Error('Automatic updates require an Apple-signed Taixu installation.');
  const requirement = `${stdout}\n${stderr}`.match(/^designated => (.+)$/m)?.[1];
  if (!requirement || !/^TeamIdentifier=\w+$/m.test(stderr))
    throw new Error('Could not verify the Taixu signer.');
  return requirement;
}

export async function verifyBundle(bundle: string, installed: string, release: TaixuRelease) {
  const requirement = await signature(installed);
  await signature(bundle);
  // A leading '=' tells codesign this is an expression, not a requirement file path.
  await run('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${requirement}`, bundle]);
  const resources = path.join(bundle, 'Contents/Resources');
  if ((await readFile(path.join(resources, 'taixu-build.txt'), 'utf8')).trim() !== release.build)
    throw new Error('Update build fingerprint does not match.');
  if (release.version) {
    const { stdout } = await run('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      path.join(bundle, 'Contents/Info.plist'),
    ]);
    if (stdout.trim() !== release.version) throw new Error('Update app version does not match.');
  }
  // Universal binaries are accepted, but the running machine's architecture must be present.
  // -verify_arch consumes every following argument as an architecture on some Xcode versions.
  await run('/usr/bin/lipo', [
    path.join(bundle, 'Contents/MacOS/Taixu'),
    '-verify_arch',
    release.arch === 'x64' ? 'x86_64' : 'arm64',
  ]);
}

export async function extractRelease(zip: string, directory: string) {
  // macOS libarchive rejects traversal and symlink-parent writes by default.
  // Never use -P or ditto's unrestricted extraction on a downloaded archive.
  const { stdout } = await run('/usr/bin/tar', ['-tf', zip]);
  const entries = stdout.trim().split('\n');
  if (
    entries.some(
      (e) => !e.startsWith('Taixu.app/') || e.split('/').includes('..') || e.includes('\\')
    )
  )
    throw new Error('Unexpected files in update archive.');
  await run('/usr/bin/tar', ['-xf', zip, '-C', directory]);
  const bundle = path.join(directory, 'Taixu.app');
  if ((await realpath(bundle)) !== bundle) throw new Error('Invalid update bundle.');
  return bundle;
}

export async function stageRelease(root: string, installed: string, release: TaixuRelease) {
  if (process.platform !== 'darwin' || release.arch !== process.arch)
    throw new Error('This release is for a different Mac architecture.');
  if (installed !== '/Applications/Taixu.app' || (await realpath(installed)) !== installed)
    throw new Error('Install Taixu in /Applications before using automatic updates.');
  await access('/Applications', constants.W_OK);
  const zip = archivePath(root, release.build);
  await verifyArchive(zip, release);
  const directory = path.join('/Applications', `.Taixu-update-${process.getuid?.()}`);
  await privateDirectory(directory);
  await removeUpdateDirectory(path.join(directory, 'Taixu.app'));
  try {
    const bundle = await extractRelease(zip, directory);
    await verifyBundle(bundle, installed, release);
    return { directory, bundle };
  } catch (error) {
    await removeUpdateDirectory(directory);
    throw error;
  }
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// The helper lives outside the replaced app. It never kills a process, touches
// user data, or elevates privileges. A stalled quit leaves the old app intact.
export function installScript({
  pid,
  installed,
  staged,
  backup,
  receipt,
}: {
  pid: number;
  installed: string;
  staged: string;
  backup: string;
  receipt: string;
}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid app process.');
  return `#!/bin/sh
set -eu
trap '/bin/rm -f -- "$0"' EXIT
installed=${quote(installed)}
staged=${quote(staged)}
backup=${quote(backup)}
receipt=${quote(receipt)}
n=0
while /bin/kill -0 ${pid} 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -ge 60 ]; then echo 'Taixu did not quit. The update was not installed.' > "$receipt"; exit 1; fi
  /bin/sleep 1
done
[ ! -e "$backup" ] || exit 1
/bin/mv "$installed" "$backup"
if ! /bin/mv "$staged" "$installed"; then
  /bin/mv "$backup" "$installed"
  echo 'Installation failed; the previous app was restored.' > "$receipt"
  /usr/bin/open "$installed"
  exit 1
fi
if ! /usr/bin/open "$installed"; then
  /bin/mv "$installed" "$staged"
  /bin/mv "$backup" "$installed"
  echo 'Launch failed; the previous app was restored.' > "$receipt"
  /usr/bin/open "$installed"
  exit 1
fi
/bin/rmdir -- "$(/usr/bin/dirname "$staged")" 2>/dev/null || true
echo 'Update installed. Previous app retained in /Applications/.Taixu-previous.' > "$receipt"
`;
}

export async function launchInstaller(root: string, installed: string, staged: string) {
  const script = path.join(root, `install-${randomUUID()}.sh`);
  const backupDir = path.join('/Applications', '.Taixu-previous');
  await privateDirectory(backupDir);
  await privateDirectory(root);
  const backup = path.join(backupDir, 'Taixu.app');
  // Remove only our previous rollback bundle, after the new bundle has verified.
  await removeUpdateDirectory(backup);
  const receipt = path.join(root, 'install-result.txt');
  await rm(receipt, { force: true });
  await writeFile(receipt, 'Waiting for Taixu to quit.\n', { mode: 0o600, flag: 'wx' });
  await writeFile(script, installScript({ pid: process.pid, installed, staged, backup, receipt }), {
    mode: 0o700,
    flag: 'wx',
  });
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

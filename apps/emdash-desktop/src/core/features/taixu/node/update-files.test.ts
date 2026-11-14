import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  archivePath,
  CHUNK_SIZE,
  downloadRelease,
  extractRelease,
  installScript,
  readChunk,
  readRelease,
  removeUpdateDirectory,
  verifyArchive,
  verifyBundle,
} from './update-files';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tx-update-'));
  roots.push(root);
  return root;
}
const bytes = Buffer.alloc(CHUNK_SIZE + 17, 42);
const release = {
  protocol: 1 as const,
  build: 'a'.repeat(64),
  createdAt: new Date().toISOString(),
  arch: 'arm64' as const,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  notes: 'Test release',
};

it('removes an updater bundle and its archive without following links outside it', async () => {
  const root = await folder();
  const bundle = path.join(root, 'Taixu.app');
  const resources = path.join(bundle, 'Contents/Resources');
  const outside = path.join(root, 'keep');
  await mkdir(resources, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'notes'), 'keep');
  await writeFile(path.join(resources, 'app.asar'), 'archive');
  await symlink(outside, path.join(resources, 'linked'));
  await removeUpdateDirectory(bundle);
  await expect(readdir(bundle)).rejects.toThrow();
  expect(await readFile(path.join(outside, 'notes'), 'utf8')).toBe('keep');
  await removeUpdateDirectory(bundle);
});

// Packaging acceptance uses the real Apple-signed bundle to exercise macOS's
// requirement and architecture parsers; mocks miss native command-line differences.
it.skipIf(process.platform !== 'darwin' || !process.env.TAIXU_TEST_SIGNED_BUNDLE)(
  'accepts a real signed bundle against its designated requirement',
  async () => {
    const bundle = process.env.TAIXU_TEST_SIGNED_BUNDLE!;
    const build = (
      await readFile(path.join(bundle, 'Contents/Resources/taixu-build.txt'), 'utf8')
    ).trim();
    const signedRelease = { ...release, build, arch: process.arch as 'arm64' | 'x64' };
    await verifyBundle(bundle, bundle, signedRelease);
    await expect(
      verifyBundle(bundle, bundle, { ...signedRelease, build: '0'.repeat(64) })
    ).rejects.toThrow(/fingerprint/);
    const { stdout } = await exec('/usr/bin/lipo', [
      path.join(bundle, 'Contents/MacOS/Taixu'),
      '-archs',
    ]);
    // Thin releases must reject the other Mac architecture; universal releases may accept both.
    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
    if (
      !stdout
        .trim()
        .split(/\s+/)
        .includes(otherArch === 'x64' ? 'x86_64' : 'arm64')
    ) {
      await expect(
        verifyBundle(bundle, bundle, { ...signedRelease, arch: otherArch })
      ).rejects.toThrow();
    }
  },
  120000
);

it('verifies streamed bytes and keeps only the current download, including cache hits', async () => {
  const root = await folder();
  await writeFile(archivePath(root, 'b'.repeat(64)), 'old');
  await writeFile(path.join(root, 'my-notes.txt'), 'keep');
  const get = async (offset: number) =>
    bytes.subarray(offset, offset + CHUNK_SIZE).toString('base64');
  await downloadRelease(root, release, get, () => {}, new AbortController().signal);
  expect(await readFile(archivePath(root, release.build))).toEqual(bytes);
  expect(await readdir(root)).toEqual(
    expect.arrayContaining([`${release.build}.zip`, 'my-notes.txt'])
  );
  expect(await readChunk(root, release, CHUNK_SIZE)).toBe(await get(CHUNK_SIZE));
  await writeFile(archivePath(root, 'c'.repeat(64)), 'old');
  await downloadRelease(
    root,
    release,
    async () => {
      throw new Error('cache should be used');
    },
    () => {},
    new AbortController().signal
  );
  expect((await readdir(root)).filter((x) => x.endsWith('.zip'))).toEqual([`${release.build}.zip`]);
  await expect(readChunk(root, release, 1)).rejects.toThrow(/offset/);
  expect(() => archivePath(root, '../escape')).toThrow();
});

it.each(['truncated', 'corrupted', 'cancelled'])(
  'rejects a %s transfer and removes partial files',
  async (kind) => {
    const root = await folder();
    const abort = new AbortController();
    await expect(
      downloadRelease(
        root,
        release,
        async (offset) => {
          if (kind === 'cancelled') abort.abort();
          return (
            kind === 'truncated'
              ? Buffer.alloc(2)
              : kind === 'corrupted'
                ? Buffer.alloc(Math.min(CHUNK_SIZE, bytes.length - offset))
                : bytes.subarray(offset, offset + CHUNK_SIZE)
          ).toString('base64');
        },
        () => {},
        abort.signal
      )
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  }
);

it('rejects symlinked archives and manifests', async () => {
  const root = await folder();
  await writeFile(path.join(root, 'source'), bytes);
  await symlink(path.join(root, 'source'), archivePath(root, release.build));
  await symlink(path.join(root, 'source'), path.join(root, 'release.json'));
  await expect(verifyArchive(archivePath(root, release.build), release)).rejects.toThrow(
    /checksum/
  );
  await expect(readRelease(root)).rejects.toThrow(/manifest/);
});

it.skipIf(process.platform !== 'darwin')(
  'libarchive blocks traversal and symlink-parent writes',
  async () => {
    const root = await folder();
    const target = path.join(root, 'extract');
    await mkdir(target);
    // Python creates malicious ZIPs; every destination is under this test's temporary root.
    for (const kind of ['traversal', 'symlink']) {
      const zip = path.join(root, `${kind}.zip`);
      await exec('/usr/bin/python3', [
        '-c',
        `import zipfile,sys,stat
z=zipfile.ZipFile(sys.argv[1],'w')
if sys.argv[2]=='traversal': z.writestr('Taixu.app/../../escaped','bad')
else:
 i=zipfile.ZipInfo('Taixu.app/link'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16
 z.writestr(i,sys.argv[3]); z.writestr('Taixu.app/link/escaped','bad')
z.close()`,
        zip,
        kind,
        root,
      ]);
      await expect(extractRelease(zip, target)).rejects.toThrow();
      await expect(readFile(path.join(root, 'escaped'))).rejects.toThrow();
    }
  }
);

it.each([
  'success',
  'move-failure',
  'journal-failure-after-backup',
  'launch-failure',
  'still-running',
  'backup-conflict',
  'wrong-build',
  'startup-confirmed',
])('installer preserves the previous app and records the exact attempt: %s', async (kind) => {
  const root = await folder();
  const installed = path.join(root, "Taixu's app");
  const staged = path.join(root, 'stage/next');
  const backup = path.join(root, 'previous');
  const receipt = path.join(root, 'receipt');
  const stateFile = path.join(root, 'state.json');
  for (const [bundle, build] of [
    [installed, 'old'],
    [staged, 'new'],
  ]) {
    await mkdir(path.join(bundle!, 'Contents/Resources'), { recursive: true });
    await writeFile(path.join(bundle!, 'Contents/Resources/taixu-build.txt'), build!);
  }
  if (kind === 'backup-conflict') {
    await mkdir(backup);
    await writeFile(path.join(backup, 'keep'), 'older rollback');
  }
  await writeFile(receipt, 'Update installed: a different, older attempt');
  const script = path.join(root, 'install.sh');
  let source = installScript({
    pid: kind === 'still-running' ? process.pid : 99999999,
    installed,
    staged,
    backup,
    receipt,
    stateFile,
    attempt: 'current-attempt',
    build: kind === 'wrong-build' ? 'wrong' : 'new',
    fromBuild: 'old',
  });
  source = source.replaceAll(
    '/usr/bin/open',
    kind === 'launch-failure' ? '/usr/bin/false' : '/usr/bin/true'
  );
  if (kind === 'still-running') source = source.replace('"$n" -ge 60', '"$n" -ge 1');
  if (kind === 'move-failure')
    source = source.replace(
      'if ! /bin/mv "$staged" "$installed"; then',
      'if ! /usr/bin/false; then'
    );
  if (kind === 'journal-failure-after-backup')
    source = source.replace('record replacing null', 'phase=replacing\n/usr/bin/false');
  if (kind === 'startup-confirmed') {
    // Simulate the new process confirming before open returns.
    source = source.replace(
      'if ! /usr/bin/true "$installed"; then',
      `if ! /usr/bin/printf '{"phase":"confirmed"}\\n' > "$state_file"; then`
    );
  }
  await writeFile(script, source);
  const result = await exec('/bin/sh', [script]).then(
    () => 'ok',
    () => 'failed'
  );
  expect(result).toBe(['success', 'startup-confirmed'].includes(kind) ? 'ok' : 'failed');
  const buildAt = (bundle: string) =>
    readFile(path.join(bundle, 'Contents/Resources/taixu-build.txt'), 'utf8');
  expect(await buildAt(installed)).toBe(
    ['success', 'startup-confirmed'].includes(kind) ? 'new' : 'old'
  );
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const phase =
    kind === 'still-running'
      ? 'waiting-for-exit'
      : ['backup-conflict', 'wrong-build'].includes(kind)
        ? 'backing-up'
        : ['move-failure', 'journal-failure-after-backup'].includes(kind)
          ? 'replacing'
          : kind === 'startup-confirmed'
            ? 'confirmed'
            : 'awaiting-startup';
  expect(state.phase).toBe(phase);
  if (kind === 'success') {
    expect(await buildAt(backup)).toBe('old');
    expect(state.error).toBeNull();
  } else if (kind !== 'startup-confirmed') expect(state.error).toBeTypeOf('string');
  expect(await readFile(receipt, 'utf8')).toContain('current-attempt');
  expect(await readFile(receipt, 'utf8')).not.toContain('Update installed');
  if (kind === 'backup-conflict')
    expect(await readFile(path.join(backup, 'keep'), 'utf8')).toBe('older rollback');
  if (kind === 'still-running') expect(() => process.kill(process.pid, 0)).not.toThrow();
  await expect(readFile(script)).rejects.toThrow();
});

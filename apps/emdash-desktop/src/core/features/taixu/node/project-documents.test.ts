import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Project } from '@core/primitives/projects/api';
import { readProjectDocuments } from './project-documents';

let root: string;
const exec = promisify(execFile);
const project = (folder: string) =>
  ({ id: 'repo', type: 'local', name: 'Suite', path: folder }) as Project;
const put = async (file: string, content: string) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'taixu-docs-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('reads bounded product docs, filtering manifests and avoiding data, code and linked files', async () => {
  await put('repo/README.md', '# Suite');
  await put('repo/apps/player/README.md', '# Player');
  await put(
    'repo/apps/player/package.json',
    JSON.stringify({
      name: 'player',
      description: 'Music',
      scripts: { secret: 'NEVER-SEND' },
      dependencies: { private: 'NEVER-SEND' },
    })
  );
  await put('repo/games/adventure/docs/design.md', 'A game');
  await put('repo/apps/player/index.ts', 'NEVER-SEND');
  await put('repo/data/README.md', 'NEVER-SEND');
  await put('repo/.env', 'NEVER-SEND');
  await put('private.md', 'NEVER-SEND');
  await symlink(path.join(root, 'private.md'), path.join(root, 'repo/overview.md'));
  await link(path.join(root, 'private.md'), path.join(root, 'repo/vision.md'));
  await symlink(path.join(root, 'repo/apps/player'), path.join(root, 'repo/apps/linked'));
  const result = await readProjectDocuments(project(path.join(root, 'repo')));
  expect(result.candidates.map((c) => c.path)).toEqual(['.', 'apps/player', 'games/adventure']);
  expect(JSON.stringify(result)).not.toContain('NEVER-SEND');
  expect(result.candidates[1].documents.find((d) => d.path.endsWith('package.json'))?.text).toBe(
    '{"name":"player","description":"Music"}'
  );
});

it('marks truncated evidence and enforces a total byte budget', async () => {
  await put('repo/README.md', 'A'.repeat(100000));
  for (let i = 0; i < 20; i++) await put(`repo/apps/app-${i}/README.md`, 'B'.repeat(16000));
  const result = await readProjectDocuments(project(path.join(root, 'repo')));
  expect(result.limited).toBe(true);
  expect(
    result.candidates.flatMap((c) => c.documents).reduce((n, d) => n + Buffer.byteLength(d.text), 0)
  ).toBeLessThanOrEqual(160 * 1024);
});

it('gives linked worktrees the same identity without creating any during discovery', async () => {
  const repo = path.join(root, 'repo');
  await put('repo/README.md', 'Suite');
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'add', 'README.md']);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'test',
  ]);
  const worktree = path.join(root, 'checkout');
  await exec('git', ['-C', repo, 'worktree', 'add', '--detach', worktree]);
  const before = (await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout;
  expect((await readProjectDocuments(project(repo))).repositoryKey).toBe(
    (await readProjectDocuments(project(worktree))).repositoryKey
  );
  expect((await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'])).stdout).toBe(before);
});

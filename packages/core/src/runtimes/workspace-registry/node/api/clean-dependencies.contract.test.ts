import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualClock } from '@emdash/shared/testing';
import { createTestWire, type TestWire } from '@emdash/wire/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TempStoreHandle } from '#primitives/sqlite-store/api';
import { workspaceRegistryContract } from '#runtimes/workspace-registry/api';
import {
  workspaceRegistryStore,
  type WorkspaceRegistryDb,
} from '#runtimes/workspace-registry/node/persistence/store';
import { WorkspaceRegistryRuntime } from '#runtimes/workspace-registry/node/runtime';
import { LocalAttachmentStore } from '#services/attachments/node/local-attachment-store';
import { createWorkspaceRegistryController } from './controller';

// Archive cleanup through the real host contract, Git, SQLite and filesystem.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

async function write(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then(
    () => true,
    () => false
  );
}

describe('workspace registry cleanDependencies', () => {
  let root: string;
  let handle: TempStoreHandle<WorkspaceRegistryDb>;
  let runtime: WorkspaceRegistryRuntime;
  let wire: TestWire<typeof workspaceRegistryContract>;
  let liveSessions: Map<string, number>;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-clean-')));
    handle = await workspaceRegistryStore.openTemp();
    liveSessions = new Map();
    runtime = new WorkspaceRegistryRuntime({
      attachments: new LocalAttachmentStore(path.join(root, 'attachments')),
      handle,
      clock: new ManualClock(10_000),
      countSessions: async (workspacePath) => liveSessions.get(workspacePath) ?? 0,
    });
    wire = createTestWire(workspaceRegistryContract, createWorkspaceRegistryController(runtime));
  });

  afterEach(async () => {
    wire.dispose();
    runtime.dispose();
    handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A registered repository whose `.gitignore` covers the usual artifact kinds. */
  async function registerRepository(): Promise<string> {
    const repoPath = path.join(root, 'repo');
    await fs.mkdir(repoPath);
    git(repoPath, 'init', '--initial-branch=main');
    await write(
      path.join(repoPath, '.gitignore'),
      [
        'node_modules/',
        'dist/',
        '*.log',
        '*.db',
        '.env*',
        'config/',
        '.claude/',
        '.emdash.json',
      ].join('\n')
    );
    await write(path.join(repoPath, 'tracked.txt'), 'v1\n');
    await write(path.join(repoPath, 'package.json'), '{}');
    await write(path.join(repoPath, 'package-lock.json'), '{}');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-m', 'initial');
    const created = await wire.client.createWorkspace({ workspaceId: 'ws-repo', path: repoPath });
    if (!created.success) throw new Error(`createWorkspace failed: ${created.error.type}`);
    return repoPath;
  }

  async function createWorktree(name: string): Promise<string> {
    const created = await wire.client.createWorktree({
      workspaceId: `wt-${name}`,
      repositoryId: 'ws-repo',
      branch: name,
      baseRef: 'main',
      path: path.join(root, name),
      preservePatterns: [],
    });
    if (!created.success) throw new Error(`createWorktree failed: ${created.error.type}`);
    await vi.waitFor(async () => {
      const record = (await wire.client.records.state(undefined, 'list').snapshot()).data[
        `wt-${name}`
      ];
      expect(record.runtime?.creation).toBeFalsy();
      expect(record.runtime?.lifecycle?.some((s) => s.status === 'running')).not.toBe(true);
    });
    return created.data.path;
  }

  it('cleans dependencies in a monorepo and nested repo, keeping checkout, branch and all other ignored data', async () => {
    const repo = await registerRepository();
    const worktree = await createWorktree('archive');
    await write(path.join(worktree, 'apps/app/package.json'), '{}');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'app');
    const head = git(worktree, 'rev-parse', 'HEAD');
    for (const name of [
      'node_modules/dep/index.js',
      'apps/app/node_modules/dep/index.js',
      'dist/model.glb',
      'config/snapshot.db',
      '.env.local',
      '.claude/screenshot.png',
    ])
      await write(path.join(worktree, name), 'keep or reinstall');
    const nested = path.join(worktree, 'config/nested');
    await fs.mkdir(nested, { recursive: true });
    git(nested, 'init', '--initial-branch=main');
    await write(path.join(nested, '.gitignore'), 'node_modules/');
    await write(path.join(nested, 'package.json'), '{}');
    await write(path.join(nested, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    git(nested, 'add', '.');
    git(nested, 'commit', '-m', 'nested');
    await write(path.join(nested, 'node_modules/dep/index.js'), 'dependency');
    const result = await wire.client.cleanDependencies({ workspaceId: 'wt-archive' });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.removed.sort()).toEqual([
        'apps/app/node_modules',
        'config/nested/node_modules',
        'node_modules',
      ]);
    for (const name of [
      'dist/model.glb',
      'config/snapshot.db',
      '.env.local',
      '.claude/screenshot.png',
      'config/nested/.git',
    ])
      expect(await exists(path.join(worktree, name))).toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'worktree', 'list')).toContain(worktree);
    // Retry after a lost response is harmless, without a reinstall or model call.
    expect(await wire.client.cleanDependencies({ workspaceId: 'wt-archive' })).toEqual({
      success: true,
      data: { removed: [], retained: [] },
    });
    expect(
      (await wire.client.records.state(undefined, 'list').snapshot()).data['wt-archive']
        .observedStatus
    ).toBe('present');
  }, 20000);

  it('refuses live sessions without stopping them; preflight is read-only and retry works', async () => {
    await registerRepository();
    const worktree = await createWorktree('busy');
    await write(path.join(worktree, 'node_modules/dep/index.js'), 'dependency');
    liveSessions.set(worktree, 1);
    expect(
      (await wire.client.cleanDependencies({ workspaceId: 'wt-busy', checkOnly: true })).success
    ).toBe(true);
    expect(await wire.client.cleanDependencies({ workspaceId: 'wt-busy' })).toEqual({
      success: false,
      error: { type: 'workspace-active', workspaceId: 'wt-busy' },
    });
    expect(await exists(path.join(worktree, 'node_modules'))).toBe(true);
    expect(liveSessions.get(worktree)).toBe(1);
    liveSessions.clear();
    expect((await wire.client.cleanDependencies({ workspaceId: 'wt-busy' })).success).toBe(true);
    expect(await exists(path.join(worktree, 'node_modules'))).toBe(false);
  }, 20000);

  it.each(['tracked.txt', 'new-source.txt'])(
    'refuses fresh uncommitted %s changes despite a previously clean registry',
    async (file) => {
      await registerRepository();
      const worktree = await createWorktree('dirty');
      await write(path.join(worktree, 'node_modules/dep/index.js'), 'dependency');
      await write(path.join(worktree, file), 'unsaved work');
      const result = await wire.client.cleanDependencies({ workspaceId: 'wt-dirty' });
      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('commit changes') },
      });
      expect(await exists(path.join(worktree, 'node_modules'))).toBe(true);
    },
    20000
  );

  it('retains protected dependency files and skips registered children and symlinked paths', async () => {
    await registerRepository();
    const worktree = await createWorktree('protected');
    await write(path.join(worktree, 'node_modules/dep/.env.local'), 'secret');
    await write(path.join(worktree, 'config/protected/package.json'), '{}');
    await write(path.join(worktree, 'config/protected/node_modules/dep/index.js'), 'dependency');
    await wire.client.createWorkspace({
      workspaceId: 'child',
      path: path.join(worktree, 'config/protected'),
    });
    const outside = path.join(root, 'outside');
    await write(path.join(outside, 'node_modules/keep'), 'outside');
    await fs.symlink(outside, path.join(worktree, 'config/link'));
    const result = await wire.client.cleanDependencies({ workspaceId: 'wt-protected' });
    expect(result).toMatchObject({
      success: true,
      data: { removed: [], retained: [expect.stringContaining('.env.local')] },
    });
    expect(await exists(path.join(worktree, 'node_modules/dep/.env.local'))).toBe(true);
    expect(await exists(path.join(worktree, 'config/protected/node_modules'))).toBe(true);
    expect(await exists(path.join(outside, 'node_modules/keep'))).toBe(true);
  }, 20000);

  it('honors preserve patterns and leaves dependency folders without tracked lockfiles', async () => {
    await registerRepository();
    const worktree = await createWorktree('preserve');
    await wire.client.patchPersonalProjectConfig({
      workspaceId: 'ws-repo',
      patch: { preservePatterns: ['node_modules/keep'] },
    });
    await write(path.join(worktree, 'node_modules/keep'), 'local edits');
    const result = await wire.client.cleanDependencies({ workspaceId: 'wt-preserve' });
    expect(result).toMatchObject({
      success: true,
      data: { removed: [], retained: [expect.stringContaining('protected')] },
    });
    await wire.client.patchPersonalProjectConfig({
      workspaceId: 'ws-repo',
      patch: { preservePatterns: [] },
    });
    git(worktree, 'rm', 'package-lock.json');
    git(worktree, 'commit', '-m', 'no lock');
    expect(await wire.client.cleanDependencies({ workspaceId: 'wt-preserve' })).toMatchObject({
      success: true,
      data: { removed: [], retained: [expect.stringContaining('lockfile')] },
    });
    expect(await exists(path.join(worktree, 'node_modules/keep'))).toBe(true);
  }, 20000);

  it('checks ignored nested repositories before deleting any dependencies', async () => {
    await registerRepository();
    const worktree = await createWorktree('nested-dirty');
    await write(path.join(worktree, 'node_modules/dep/index.js'), 'dependency');
    const nested = path.join(worktree, 'config/nested');
    await fs.mkdir(nested, { recursive: true });
    git(nested, 'init', '--initial-branch=main');
    await write(path.join(nested, 'source.txt'), 'original');
    git(nested, 'add', '.');
    git(nested, 'commit', '-m', 'nested');
    await write(path.join(nested, 'source.txt'), 'valuable changes');
    expect(await wire.client.cleanDependencies({ workspaceId: 'wt-nested-dirty' })).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('config/nested') },
    });
    expect(await exists(path.join(worktree, 'node_modules/dep/index.js'))).toBe(true);
  }, 20000);

  it('retains tracked content even inside an ignored dependency folder', async () => {
    await registerRepository();
    const worktree = await createWorktree('tracked-deps');
    await write(path.join(worktree, 'node_modules/custom/index.js'), 'valuable source');
    git(worktree, 'add', '-f', 'node_modules/custom/index.js');
    git(worktree, 'commit', '-m', 'vendored source');
    expect(await wire.client.cleanDependencies({ workspaceId: 'wt-tracked-deps' })).toMatchObject({
      success: true,
      data: { removed: [], retained: [expect.stringContaining('tracked contents')] },
    });
    expect(await exists(path.join(worktree, 'node_modules/custom/index.js'))).toBe(true);
  }, 20000);

  it('refuses repository roots and unknown workspaces', async () => {
    await registerRepository();
    expect(await wire.client.cleanDependencies({ workspaceId: 'ws-repo' })).toMatchObject({
      success: false,
    });
    expect(await wire.client.cleanDependencies({ workspaceId: 'unknown' })).toMatchObject({
      success: false,
      error: { type: 'workspace-not-found' },
    });
  }, 20000);
  it('retires a clean checkout but preserves unpublished commits, its branch and registry record', async () => {
    const repo = await registerRepository();
    const checkout = await createWorktree('finished');
    await write(path.join(checkout, 'tracked.txt'), 'unpublished change');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'unpublished work');
    const commit = git(checkout, 'rev-parse', 'HEAD');
    await write(path.join(checkout, 'node_modules/example/index.js'), 'dependency');
    expect((await wire.client.cleanDependencies({ workspaceId: 'wt-finished' })).success).toBe(
      true
    );
    expect(await wire.client.retireCheckout({ workspaceId: 'wt-finished' })).toMatchObject({
      success: true,
    });
    expect(await exists(checkout)).toBe(false);
    expect(git(repo, 'rev-parse', 'finished')).toBe(commit);
    expect(git(repo, 'show', 'finished:tracked.txt')).toBe('unpublished change');
    expect(
      (await wire.client.records.state(undefined, 'list').snapshot()).data['wt-finished']
    ).toBeDefined();
    expect(await wire.client.retireCheckout({ workspaceId: 'wt-finished' })).toMatchObject({
      success: true,
    });
  });

  it.each(['.env', 'output.db', 'dist/generated-video.mp4', '.context/handoff.md', 'draft.txt'])(
    'keeps unique local data %s and the checkout',
    async (file) => {
      await registerRepository();
      const checkout = await createWorktree('local-data');
      await write(path.join(checkout, file), 'only copy');
      expect((await wire.client.retireCheckout({ workspaceId: 'wt-local-data' })).success).toBe(
        false
      );
      expect(await fs.readFile(path.join(checkout, file), 'utf8')).toBe('only copy');
    }
  );
  it('refuses changed tracked files, detached heads, active sessions and locked checkouts', async () => {
    await registerRepository();
    const checkout = await createWorktree('protected');
    await write(path.join(checkout, 'tracked.txt'), 'unsaved work');
    expect((await wire.client.retireCheckout({ workspaceId: 'wt-protected' })).success).toBe(false);
    git(checkout, 'restore', 'tracked.txt');
    git(checkout, 'checkout', '--detach');
    expect((await wire.client.retireCheckout({ workspaceId: 'wt-protected' })).success).toBe(false);
    git(checkout, 'checkout', 'protected');
    liveSessions.set(checkout, 1);
    expect((await wire.client.retireCheckout({ workspaceId: 'wt-protected' })).success).toBe(false);
    liveSessions.clear();
    git(path.join(root, 'repo'), 'worktree', 'lock', checkout);
    expect((await wire.client.retireCheckout({ workspaceId: 'wt-protected' })).success).toBe(false);
    expect(await exists(checkout)).toBe(true);
    expect((await wire.client.retireCheckout({ workspaceId: 'ws-repo' })).success).toBe(false);
  });
  it('refuses hidden modifications excluded from Git status', async () => {
    await registerRepository();
    const checkout = await createWorktree('hidden-change');
    git(checkout, 'update-index', '--assume-unchanged', 'tracked.txt');
    await write(path.join(checkout, 'tracked.txt'), 'hidden unique content');
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    expect((await wire.client.retireCheckout({ workspaceId: 'wt-hidden-change' })).success).toBe(
      false
    );
    expect(await fs.readFile(path.join(checkout, 'tracked.txt'), 'utf8')).toBe(
      'hidden unique content'
    );
  });
});

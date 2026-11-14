import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultGitExecFactory, type GitExecFactory } from '#services/exec/node/git-exec';
import { resolvePreservedEntries } from './preserve-patterns';

export type DependencyCleanup = { removed: string[]; retained: string[] };
type Options = {
  workspacePath: string;
  preservePatterns: readonly string[];
  nestedWorkspacePaths: readonly string[];
  checkOnly?: boolean;
  createGitExec?: GitExecFactory;
  assertIdle: () => Promise<void>;
};

const locks = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const inside = (root: string, entry: string) =>
  entry === root || entry.startsWith(`${root}${path.sep}`);

/**
 * Archive cleanup is deliberately narrower than Clean Artifacts. Only ignored
 * node_modules belonging to a tracked package with a tracked lockfile qualify.
 * Sources, checkout/branch, nested repositories, attachments and unknown ignored
 * output stay in place. No shell, install command, lifecycle script or git clean.
 */
export async function cleanWorkspaceDependencies(options: Options): Promise<DependencyCleanup> {
  const root = await fs.realpath(options.workspacePath);
  const git = options.createGitExec ?? defaultGitExecFactory;
  const run = async (cwd: string, args: string[]) => (await git(cwd).exec(args)).stdout;
  const top = (await run(root, ['rev-parse', '--show-toplevel'])).trim();
  if ((await fs.realpath(top)) !== root)
    throw new Error('Cleanup requires the exact Git checkout.');
  const protectedPaths = (await resolvePreservedEntries(root, options.preservePatterns)).entries;
  const nested = options.nestedWorkspacePaths.map((p) => path.resolve(p));
  const repositories = new Map<string, Set<string>>();
  const candidates: string[] = [];
  const retained: string[] = [];
  let visited = 0;
  const relative = (p: string) => path.relative(root, p).split(path.sep).join('/');
  async function repository(dir: string) {
    const tracked = new Set((await run(dir, ['ls-files', '-z'])).split('\0').filter(Boolean));
    repositories.set(dir, tracked);
  }
  async function assertClean() {
    for (const dir of repositories.keys()) {
      if (
        (
          await run(dir, [
            'status',
            '--porcelain=v1',
            '--untracked-files=normal',
            '--ignore-submodules=none',
          ])
        ).trim()
      )
        throw new Error(
          `Save and commit changes in ${relative(dir) || 'this workspace'} before cleanup.`
        );
    }
  }
  await repository(root);
  async function walk(dir: string, repo: string) {
    if (++visited > 50000)
      throw new Error('Workspace inspection limit reached; no dependencies were removed.');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (dir !== root && entries.some((e) => e.name === '.git')) {
      // A real nested repository is inspected independently; its .git is never removed.
      if ((await fs.realpath((await run(dir, ['rev-parse', '--show-toplevel'])).trim())) !== dir)
        throw new Error(`Could not verify nested repository ${relative(dir)}.`);
      repo = dir;
      await repository(repo);
    }
    for (const entry of entries) {
      // Never traverse symlinks, hidden personal data or another registered workspace.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const target = path.join(dir, entry.name);
      const rel = relative(target);
      if (
        nested.some(
          (p) => inside(p, target) || (entry.name === 'node_modules' && inside(target, p))
        )
      )
        continue;
      if (
        protectedPaths.some(
          (p) =>
            rel === p ||
            rel.startsWith(`${p}/`) ||
            (entry.name === 'node_modules' && overlaps(rel, p))
        )
      ) {
        if (entry.name === 'node_modules') retained.push(`${rel}: protected by project settings`);
        continue;
      }
      if (entry.name !== 'node_modules') {
        await walk(target, repo);
        continue;
      }
      const tracked = repositories.get(repo)!;
      const packagePath = path
        .relative(repo, path.join(dir, 'package.json'))
        .split(path.sep)
        .join('/');
      const modulePath = path.relative(repo, target).split(path.sep).join('/');
      let hasLock = false;
      for (let ancestor = dir; inside(repo, ancestor); ancestor = path.dirname(ancestor)) {
        const prefix = path.relative(repo, ancestor).split(path.sep).join('/');
        if (locks.some((lock) => tracked.has(prefix ? `${prefix}/${lock}` : lock))) hasLock = true;
        if (ancestor === repo) break;
      }
      if (
        !tracked.has(packagePath) ||
        !hasLock ||
        [...tracked].some((p) => p === modulePath || p.startsWith(`${modulePath}/`))
      ) {
        retained.push(`${rel}: no reproducible tracked package and lockfile, or tracked contents`);
        continue;
      }
      try {
        await run(repo, ['check-ignore', '-q', '--', modulePath]);
      } catch {
        retained.push(`${rel}: not Git-ignored`);
        continue;
      }
      // Secrets and embedded Git repositories are not disposable, even inside dependencies.
      const protectedEntry = await findProtectedDependencyEntry(target);
      if (protectedEntry) retained.push(`${rel}: contains ${relative(protectedEntry)}`);
      else candidates.push(target);
    }
  }
  await walk(root, root);
  await assertClean();
  if (options.checkOnly) return { removed: [], retained };
  const removed: string[] = [];
  for (const target of candidates) {
    await options.assertIdle();
    await assertClean();
    // Recheck containment/identity after inspection. No symlink ancestor may redirect rm.
    if (
      (await fs.realpath(root)) !== root ||
      (await fs.realpath(target)) !== target ||
      !inside(root, target)
    )
      throw new Error(
        `Dependency path changed: ${relative(target)}. Retry after checking the workspace.`
      );
    if (await findProtectedDependencyEntry(target))
      throw new Error(
        `Protected files appeared in ${relative(target)}. Nothing further was removed.`
      );
    await fs.rm(target, { recursive: true });
    removed.push(relative(target));
  }
  return { removed, retained };
}

async function findProtectedDependencyEntry(root: string): Promise<string | undefined> {
  const queue = [root];
  let visited = 0;
  while (queue.length) {
    const dir = queue.pop()!;
    if (++visited > 100000)
      throw new Error('Dependency inspection limit reached; cleanup needs review.');
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (
        entry.name === '.git' ||
        entry.name === '.context' ||
        entry.name === '.env' ||
        entry.name.startsWith('.env.')
      )
        return target;
      if (entry.isDirectory()) queue.push(target);
    }
  }
  return undefined;
}

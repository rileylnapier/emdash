import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { GitExecFactory } from '#services/exec/node/git-exec';
import { validateWorktreePath } from './worktree-path-safety';

/** Remove only a disposable linked checkout. Its branch, registry and attachments survive. */
export async function retireCheckout(options: {
  workspacePath: string;
  repositoryPath: string;
  nestedWorkspacePaths: readonly string[];
  createGitExec: GitExecFactory;
  assertIdle: () => Promise<void>;
}): Promise<void> {
  const { workspacePath, repositoryPath, createGitExec, assertIdle } = options;
  if (options.nestedWorkspacePaths.length)
    throw new Error('A registered workspace is nested inside this checkout. Kept for review.');
  await assertIdle();
  const stat = await lstat(workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return; // A previous successful removal can be retried after a lost response.
  if (!stat.isDirectory() || (await realpath(workspacePath)) !== path.resolve(workspacePath))
    throw new Error('Checkout path changed or contains a symbolic link. Kept for review.');
  const valid = await validateWorktreePath({
    repoPath: repositoryPath,
    targetPath: workspacePath,
    mutation: 'remove',
    createGitExec,
  });
  if (!valid.success) throw new Error(valid.error.message);
  if (!(await lstat(path.join(workspacePath, '.git'))).isFile())
    throw new Error('Only a linked task checkout can be removed.');
  const git = createGitExec(workspacePath);
  const run = async (args: string[]) => (await git.exec(args)).stdout;
  const branch = (await run(['symbolic-ref', '--quiet', 'HEAD'])).trim();
  if (!branch.startsWith('refs/heads/'))
    throw new Error('Checkout needs a branch to preserve its commits.');
  if ((await run(['ls-files', '--stage'])).split('\n').some((line) => line.startsWith('160000 ')))
    throw new Error('Checkout contains submodules. Kept for review.');
  if ((await run(['ls-files', '-v', '-z'])).split('\0').some((entry) => /^[a-zS] /.test(entry)))
    throw new Error('Checkout has files excluded from Git change detection. Kept for review.');
  if (
    (
      await run(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])
    ).trim()
  )
    throw new Error('Checkout has uncommitted or untracked files. Kept for review.');
  const ignored = (
    await run(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  if (ignored.length)
    throw new Error(
      `Local ignored files remain: ${ignored.slice(0, 5).join(', ')}. Kept for review.`
    );
  await assertIdle();
  // Git performs a final dirty/locked-worktree check. Never force, clean, or delete the branch.
  await createGitExec(repositoryPath).exec(['worktree', 'remove', '--', workspacePath]);
}

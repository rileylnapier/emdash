import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Installed code is immutable. Knowledge has a single writable home outside the app. */
export async function prepareDataHome(userData: string, runtime: string, previousRoot?: string) {
  const destination = path.join(userData, 'taixu-home');
  const marker = path.join(destination, '.initialized');
  const initialized = await readFile(marker, 'utf8').catch(() => null);
  if (!initialized) {
    const stage = `${destination}.initializing`;
    await rm(stage, { recursive: true, force: true });
    await mkdir(path.join(stage, 'packages/wuwei'), { recursive: true, mode: 0o700 });
    const source = previousRoot ?? runtime;
    if (previousRoot) await readFile(path.join(previousRoot, 'packages/wuwei/projects.json')); // Never silently discard an unavailable old library.
    for (const name of ['projects.json', 'state', 'notebooks', 'handoffs', 'briefs']) {
      const from = path.join(source, 'packages/wuwei', name);
      try {
        await cp(from, path.join(stage, 'packages/wuwei', name), {
          recursive: true,
          filter: async (file) => {
            if ((await lstat(file)).isSymbolicLink())
              throw new Error('Taixu data contains a symlink.');
            return true;
          },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // Fresh machines receive stations and an empty registry, never the builder's projects.
    await readFile(path.join(stage, 'packages/wuwei/projects.json')).catch(async () => {
      await cp(
        path.join(runtime, 'packages/wuwei/projects.json'),
        path.join(stage, 'packages/wuwei/projects.json')
      );
    });
    if (previousRoot) {
      const configPath = path.join(stage, 'packages/wuwei/projects.json');
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      for (const project of config.projects ?? []) {
        if (Array.isArray(project.docs))
          project.docs = project.docs.map((doc: string) =>
            !path.isAbsolute(doc) && !doc.startsWith('~/') ? path.resolve(previousRoot, doc) : doc
          );
        if (
          typeof project.repo === 'string' &&
          !path.isAbsolute(project.repo) &&
          !project.repo.startsWith('~/')
        )
          project.repo = path.resolve(previousRoot, project.repo);
      }
      await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    await writeFile(path.join(stage, '.initialized'), '1', { mode: 0o600 });
    await rename(stage, destination);
  }
  // Update only shipped Head instructions, never user notebooks or configuration.
  for (const name of ['packages/wuwei/heads', '.claude/agents']) {
    await cp(path.join(runtime, name), path.join(destination, name), { recursive: true });
  }
  return destination;
}

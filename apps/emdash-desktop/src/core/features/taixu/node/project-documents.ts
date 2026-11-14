// Product documentation for repositories explicitly registered with the desktop app.
// This is onboarding evidence, never a source of live task/status claims.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Project } from '@core/primitives/projects/api';

const exec = promisify(execFile);
const containers = new Set(['apps', 'games', 'projects', 'packages']);
const excluded =
  /^(\.|node_modules$|vendor$|dist$|build$|out$|target$|assets$|data$|roms$|samples$|integrations$|coverage$|test|fixtures$|scripts$|tooling$)/i;
const documentName = /^(readme|overview|product|design|vision|roadmap)(\.[\w-]+)?\.md$/i;
const manifests = new Set(['package.json', 'project.json', 'game.json']);
const MAX_FILE = 16 * 1024;
const MAX_TOTAL = 160 * 1024;
export type ProjectEvidence = {
  repositoryKey: string;
  name: string;
  candidates: { path: string; documents: { path: string; text: string }[] }[];
  limited: boolean;
};

export async function readProjectDocuments(project: Project): Promise<ProjectEvidence> {
  if (project.type !== 'local')
    throw new Error('Choose a local repository folder to learn its projects.');
  const root = await realpath(project.path);
  let identity = root;
  try {
    const result = await exec(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 5000, maxBuffer: 8192 }
    );
    identity = await realpath(result.stdout.trim());
  } catch {
    /* Directory projects use their canonical folder identity. */
  }
  let budget = MAX_TOTAL;
  let limited = false;
  // Every path is generated here, never accepted from a model or a renderer.
  async function safe(file: string) {
    let part = root;
    for (const segment of path.relative(root, file).split(path.sep).filter(Boolean)) {
      if (segment === '..') throw new Error('Outside repository');
      part = path.join(part, segment);
      if ((await lstat(part)).isSymbolicLink()) throw new Error('Symlink');
    }
  }
  async function entries(relative: string) {
    try {
      const dir = path.join(root, relative);
      await safe(dir);
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      if (entries.length > 200) limited = true;
      return entries.slice(0, 200);
    } catch {
      return [];
    }
  }
  async function documents(relative: string) {
    const files = (await entries(relative))
      .filter((e) => e.isFile() && (documentName.test(e.name) || manifests.has(e.name)))
      .map((e) => path.join(relative, e.name));
    for (const e of await entries(path.join(relative, 'docs'))) {
      if (e.isFile() && documentName.test(e.name)) files.push(path.join(relative, 'docs', e.name));
    }
    const docs: { path: string; text: string }[] = [];
    if (files.length > 8) limited = true;
    for (const file of files.slice(0, 8)) {
      try {
        const full = path.join(root, file);
        await safe(full);
        const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await fd.stat();
          if (!stat.isFile() || stat.nlink !== 1 || budget <= 0) {
            limited = true;
            continue;
          }
          const bytes = Buffer.alloc(Math.min(MAX_FILE, budget) + 1);
          const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
          const length = Math.min(bytesRead, MAX_FILE, budget);
          if (stat.size > length || bytesRead > length) limited = true;
          let text = bytes
            .subarray(0, length)
            .toString('utf8')
            .replace(/\uFFFD$/, '');
          if (manifests.has(path.basename(file))) {
            const raw: unknown = JSON.parse(text);
            if (!raw || typeof raw !== 'object') continue;
            const fields = Object.fromEntries(
              Object.entries(raw).filter(
                ([k, v]) =>
                  ['name', 'description', 'displayName', 'title'].includes(k) &&
                  typeof v === 'string'
              )
            );
            text = JSON.stringify(fields); // Never send scripts, environment or dependency configuration.
          }
          budget -= length;
          docs.push({ path: file.split(path.sep).join('/'), text });
        } finally {
          await fd.close();
        }
      } catch {
        /* Missing, linked, oversized and invalid documents are not evidence. */
      }
    }
    return docs;
  }
  const candidates = [{ path: '.', documents: await documents('.') }];
  for (const e of await entries('.')) {
    if (!e.isDirectory() || excluded.test(e.name) || e.name === 'docs') continue;
    const folders = containers.has(e.name)
      ? (await entries(e.name))
          .filter((x) => x.isDirectory() && !excluded.test(x.name))
          .map((x) => path.join(e.name, x.name))
      : [e.name];
    for (const folder of folders) {
      if (candidates.length >= 48 || budget <= 0) {
        limited = true;
        break;
      }
      const docs = await documents(folder);
      if (docs.length) candidates.push({ path: folder.split(path.sep).join('/'), documents: docs });
    }
  }
  return {
    repositoryKey: createHash('sha256').update(identity).digest('hex').slice(0, 24),
    name: project.name,
    candidates,
    limited,
  };
}

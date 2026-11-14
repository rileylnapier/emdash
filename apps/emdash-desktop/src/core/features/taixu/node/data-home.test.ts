import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareDataHome } from './data-home';

const folders: string[] = [];
afterEach(async () => {
  for (const f of folders.splice(0)) await rm(f, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'taixu-data-'));
  folders.push(root);
  async function put(file: string, text: string) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await put(
    'runtime/packages/wuwei/projects.json',
    JSON.stringify({ stations: [{ id: 'studio' }], projects: [] })
  );
  await put('runtime/packages/wuwei/heads/instructions.md', 'shipped instructions');
  await put('runtime/.claude/agents/product-head.md', 'product head');
  return { root, put, runtime: path.join(root, 'runtime'), userData: path.join(root, 'user') };
}

it('starts a fresh machine with empty projects and retains personal data across instruction updates', async () => {
  const f = await fixture();
  const home = await prepareDataHome(f.userData, f.runtime);
  expect(
    JSON.parse(await readFile(path.join(home, 'packages/wuwei/projects.json'), 'utf8')).projects
  ).toEqual([]);
  await f.put('user/taixu-home/packages/wuwei/state/project-library.json', 'my knowledge');
  await f.put('runtime/packages/wuwei/heads/instructions.md', 'updated instructions');
  await prepareDataHome(f.userData, f.runtime);
  expect(await readFile(path.join(home, 'packages/wuwei/state/project-library.json'), 'utf8')).toBe(
    'my knowledge'
  );
  expect(await readFile(path.join(home, 'packages/wuwei/heads/instructions.md'), 'utf8')).toBe(
    'updated instructions'
  );
});

it('copies old knowledge once, preserves its original, and keeps relative document links working', async () => {
  const f = await fixture();
  await f.put(
    'old/packages/wuwei/projects.json',
    JSON.stringify({
      stations: [],
      projects: [{ id: 'app', docs: ['docs/design.md', '~/work/README.md'] }],
    })
  );
  await f.put('old/packages/wuwei/state/conversation.json', 'original chat');
  await f.put('old/packages/wuwei/notebooks/product-head/app.md', 'remember this');
  const old = path.join(f.root, 'old');
  const home = await prepareDataHome(f.userData, f.runtime, old);
  const registry = JSON.parse(
    await readFile(path.join(home, 'packages/wuwei/projects.json'), 'utf8')
  );
  expect(registry.projects[0].docs).toEqual([path.join(old, 'docs/design.md'), '~/work/README.md']);
  await f.put('user/taixu-home/packages/wuwei/state/conversation.json', 'new chat');
  await prepareDataHome(f.userData, f.runtime, old);
  expect(await readFile(path.join(home, 'packages/wuwei/state/conversation.json'), 'utf8')).toBe(
    'new chat'
  );
  expect(await readFile(path.join(old, 'packages/wuwei/state/conversation.json'), 'utf8')).toBe(
    'original chat'
  );
});

it('does not silently replace an unavailable old registry or follow personal-data symlinks', async () => {
  const f = await fixture();
  const old = path.join(f.root, 'old');
  await expect(prepareDataHome(f.userData, f.runtime, old)).rejects.toThrow();
  await f.put('old/packages/wuwei/projects.json', '{"stations":[],"projects":[]}');
  await f.put('private.txt', 'private');
  await symlink(path.join(f.root, 'private.txt'), path.join(old, 'packages/wuwei/state'));
  await expect(prepareDataHome(f.userData, f.runtime, old)).rejects.toThrow(/symlink/);
  await expect(readFile(path.join(f.userData, 'taixu-home/.initialized'))).rejects.toThrow();
});

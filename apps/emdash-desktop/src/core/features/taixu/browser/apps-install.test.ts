import { expect, it, vi } from 'vitest';
import { APP_CHUNK_SIZE, installFromStudio } from './apps-install';

const release = {
  appId: 'bonsai',
  build: 'b'.repeat(64),
  sha256: 'c'.repeat(64),
  version: '0.1.0',
  size: APP_CHUNK_SIZE * 2 + 10,
};

it('relays every piece from Studio to this Mac in order, then installs', async () => {
  const received: number[] = [];
  const client = {
    appRelease: vi.fn(async () => release),
    appChunk: vi.fn(async ({ offset }: { offset: number }) => `piece-${offset}`),
    localAppReceive: vi.fn(async ({ offset, data }: { offset: number; data: string }) => {
      expect(data).toBe(`piece-${offset}`);
      received.push(offset);
      return { received: offset };
    }),
    localAppInstall: vi.fn(async () => null),
  };
  const progress: number[] = [];
  await installFromStudio(client as never, 'bonsai', (p) => progress.push(p));
  expect(received).toEqual([0, APP_CHUNK_SIZE, APP_CHUNK_SIZE * 2]);
  expect(progress.at(-1)).toBe(100);
  expect(client.localAppInstall).toHaveBeenCalledWith(release);
});

it('stops without installing when Studio has no release or a piece fails', async () => {
  const none = { appRelease: vi.fn(async () => null), localAppInstall: vi.fn() };
  await expect(installFromStudio(none as never, 'bonsai', () => {})).rejects.toThrow(
    'hasn’t published'
  );
  expect(none.localAppInstall).not.toHaveBeenCalled();
  const broken = {
    appRelease: vi.fn(async () => release),
    appChunk: vi.fn(async () => {
      throw new Error('changed');
    }),
    localAppReceive: vi.fn(),
    localAppInstall: vi.fn(),
  };
  await expect(installFromStudio(broken as never, 'bonsai', () => {})).rejects.toThrow('changed');
  expect(broken.localAppInstall).not.toHaveBeenCalled();
});

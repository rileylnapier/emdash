import type { AppRelease } from '../api/apps-contract';
import type { getTaixuClient } from '../api/browser/client';

type Client = Awaited<ReturnType<typeof getTaixuClient>>;
// Matches the hub's piece size (packages/desktop-runtime/mac-services.cjs).
export const APP_CHUNK_SIZE = 256 * 1024;

// Install an app on this Mac from the selected Studio's published release. Each piece goes from the Studio to this
// Mac's hub over Taixu's existing connection; this Mac's hub verifies everything before placing the app.
// Nothing is retried: a failure starts over from the first piece.
export async function installFromStudio(
  client: Client,
  appId: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<AppRelease> {
  const release = await client.appRelease({ appId });
  if (!release)
    throw new Error('The Studio hasn’t published this app yet. Publish it there first.');
  for (let offset = 0; offset < release.size; offset += APP_CHUNK_SIZE) {
    signal?.throwIfAborted();
    const data = await client.appChunk({ appId, build: release.build, offset });
    await client.localAppReceive({ ...release, offset, data });
    onProgress(Math.floor((Math.min(offset + APP_CHUNK_SIZE, release.size) / release.size) * 100));
  }
  await client.localAppInstall(release);
  return release;
}

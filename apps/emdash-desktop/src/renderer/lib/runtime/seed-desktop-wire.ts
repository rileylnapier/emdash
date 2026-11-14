import { awaitWirePort, connect, domPortTransport, type DomPortLike } from '@emdash/wire/rpc';
import { STUDIO_DESKTOP_CHANNEL } from '@core/features/taixu/api/studio-contract';
import { prepareStudioDesktop } from '@core/features/taixu/browser/studio-gate';
import { DESKTOP_WIRE_CHANNEL } from '@core/manifests/shared/wire-channels';
import { resetWireConnection, seedWireConnection } from '@core/primitives/wire/browser/connection';
import { dismissBootSplash } from '@renderer/lib/boot/boot-splash';

/**
 * The production seed: called once by the renderer bootstrap before React mounts.
 * This is the only host-owned wire code — port acquisition over the Electron
 * preload bridge. Everything downstream reaches the wire through the core seam.
 */
export async function seedDesktopWire(): Promise<void> {
  const channel = (await prepareStudioDesktop(dismissBootSplash))
    ? STUDIO_DESKTOP_CHANNEL
    : DESKTOP_WIRE_CHANNEL;
  seedWireConnection(async () => {
    const portPromise = awaitWirePort(window, { channel });
    await window.electronAPI.requestWirePort(channel);
    return connect(domPortTransport((await portPromise) as DomPortLike), { maxHeldCalls: 0 });
  });
}

// Dev-server edits to seeding modules must not leave a stale connection behind.
import.meta.hot?.dispose(() => resetWireConnection());

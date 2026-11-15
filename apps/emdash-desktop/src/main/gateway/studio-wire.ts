import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exposeWireToWindows, type Controller } from '@emdash/wire/rpc';
import { app, ipcMain, MessageChannelMain } from 'electron';
import {
  STUDIO_CONTROL_CHANNEL,
  STUDIO_DESKTOP_CHANNEL,
} from '@core/features/taixu/api/studio-contract';
import { routeControllers } from '@core/features/taixu/node/studio-routing';
import { createStudioService } from '@core/features/taixu/node/studio-service';
import { createUpdateHost } from '@core/features/taixu/node/update-host';
import type { SshServiceHandle } from '@core/manifests/node/ssh-service-handle';
import type { Hosts } from '@core/services/hosts/node/hosts';
import { appScope } from '@main/bootstrap/core/app-scope';
import { assertIdleForTaixuUpdate } from '@main/bootstrap/shutdown';
import { setServerWindowMode } from '@main/host/window';

let installed = false;
let ready: (controller: Controller) => void;
const controller = new Promise<Controller>((resolve) => {
  ready = resolve;
});
const createMessageChannel = () => new MessageChannelMain();

export function installStudioWire() {
  if (installed) return;
  installed = true;
  appScope.add(
    exposeWireToWindows(
      { ipcMain, createMessageChannel },
      {
        async call(method, input, meta) {
          return (await controller).call(method, input, meta);
        },
        resolveLive: () => null,
        acquireLive: () => null,
      },
      { channel: STUDIO_CONTROL_CHANNEL }
    )
  );
}

export async function configureStudioWire(
  controllers: Record<string, Controller>,
  ssh: SshServiceHandle,
  hosts: Hosts
) {
  // Missing build metadata disables sharing but must not prevent local startup.
  const build = await (
    app.isPackaged
      ? readFile(path.join(process.resourcesPath, 'taixu-build.txt'), 'utf8').then((s) => s.trim())
      : readFile(path.join(app.getAppPath(), 'out/main/index.js')).then((s) =>
          createHash('sha256').update(s).digest('hex')
        )
  ).catch(() => '');
  const service = await createStudioService({
    applyServerMode: setServerWindowMode,
    local: routeControllers(controllers),
    updates: createUpdateHost(app.getPath('userData'), build, assertIdleForTaixuUpdate),
    ssh,
    hosts,
    version: app.getVersion(),
    build,
    userData: app.getPath('userData'),
    expose: (remote) =>
      exposeWireToWindows({ ipcMain, createMessageChannel }, remote, {
        channel: STUDIO_DESKTOP_CHANNEL,
      }),
  });
  appScope.add(() => service.dispose());
  ready(service.controller);
}

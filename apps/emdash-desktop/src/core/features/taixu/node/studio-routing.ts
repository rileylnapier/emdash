import type { Controller } from '@emdash/wire/rpc';
import { guardedDesktopCall } from './update-guard';

const localDomains = new Set(['updates', 'logging', 'telemetry', 'devPerf']);
const localHost = new Set([
  'openExternal',
  'clipboardWriteText',
  'showTerminalContextMenu',
  'setMenuKeybindings',
  'quit',
  'resolveQuitConfirmation',
  'ackShutdownFlush',
  'shutdownReady',
  'checkInstalledApps',
  'listInstalledFonts',
  'saveTextFile',
  'minimizeWindow',
  'toggleMaximizeWindow',
  'closeWindow',
  'isWindowMaximized',
  'getAppVersion',
  'getElectronVersion',
  'getPlatform',
  'getPlatformDisplayName',
  'events',
]);
const remoteHost = new Set(['persistDroppedBlob', 'readAudioFileDataUrl']);
// This Mac's own apps, shown beside the Studio's.
const localTaixu = new Set(['localApps', 'localAppAction', 'localAppReceive', 'localAppInstall']);

export function studioRoute(path: string): 'local' | 'remote' | 'unavailable' {
  const [domain, method] = path.split('.');
  if (localDomains.has(domain)) return 'local';
  if (domain === 'taixu' && localTaixu.has(method)) return 'local';
  if (domain === 'host') {
    if (localHost.has(method)) return 'local';
    if (remoteHost.has(method)) return 'remote';
    return 'unavailable';
  }
  // Native BrowserViews and preview tunnels belong to the Studio window. Do not
  // open invisible windows or return a Studio loopback URL on the laptop.
  if (domain === 'browser' || domain === 'previewServers') return 'unavailable';
  return 'remote';
}

export function routeControllers(controllers: Record<string, Controller>): Controller {
  const target = (path: string) => {
    const [domain, ...tail] = path.split('.');
    if (!controllers[domain] || !tail.length) throw new Error('Unknown desktop method.');
    return { controller: controllers[domain], path: tail.join('.') };
  };
  return {
    call(path, input, meta) {
      const t = target(path);
      return guardedDesktopCall(path, () => t.controller.call(t.path, input, meta));
    },
    resolveLive(path) {
      const t = target(path);
      return t.controller.resolveLive(t.path);
    },
    acquireLive(path) {
      const t = target(path);
      return t.controller.acquireLive(t.path);
    },
  };
}

export function routeStudioDesktop(local: Controller, remote: Controller): Controller {
  const target = (path: string) => {
    const route = studioRoute(path);
    if (route === 'unavailable')
      throw new Error('This desktop feature requires the Studio window.');
    return route === 'local' ? local : remote;
  };
  return {
    call(path, input, meta) {
      return target(path).call(path, input, meta);
    },
    resolveLive(path) {
      return target(path).resolveLive(path);
    },
    acquireLive(path) {
      return target(path).acquireLive(path);
    },
  };
}

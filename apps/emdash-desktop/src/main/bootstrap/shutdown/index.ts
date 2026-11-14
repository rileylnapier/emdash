import { LOCAL_HOST_REF, type HostRef } from '@emdash/core/primitives/host/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';
import { app, type BrowserWindow } from 'electron';
import { assertUpdateActivityIdle } from '@core/features/taixu/node/update-activity';
import { isTaixuInstallRequested } from '@core/features/taixu/node/update-guard';
import { desktopHostEvents } from '@core/features/workbench/node';
import { getActiveSessionSummary } from '@main/host/sessions/active-session-summary';
import { updateService } from '@main/host/updates/update-service';
import { createShutdownCoordinator } from './coordinator';
import { runQuitCleanup } from './phases';

let sessionSummarySource:
  | { runtimes: RuntimeBroker; attachedHosts: () => readonly HostRef[] }
  | undefined;

const shutdownCoordinator = createShutdownCoordinator({
  emit: (event) => desktopHostEvents.emit(undefined, event),
  getActiveSessionSummary: () => {
    if (!sessionSummarySource) {
      throw new Error('Shutdown runtime clients have not been configured');
    }
    return getActiveSessionSummary(
      sessionSummarySource.runtimes,
      sessionSummarySource.attachedHosts()
    );
  },
  isInstallRequested: () => updateService.isInstallRequested || isTaixuInstallRequested(),
  runCleanup: runQuitCleanup,
  exit: (code) => app.exit(code),
});

let assertNoScheduledWork: (() => Promise<void>) | undefined;
export function configureUpdateActivityCheck(check: () => Promise<void>) {
  assertNoScheduledWork = check;
}

let registered = false;

export function configureShutdownRuntimeClients(
  runtimes: RuntimeBroker,
  attachedHosts: () => readonly HostRef[]
): void {
  sessionSummarySource = { runtimes, attachedHosts };
}

export function registerQuitHandler(): void {
  if (registered) return;
  registered = true;
  app.on('before-quit', (event) => {
    event.preventDefault();
    void shutdownCoordinator.handleQuitRequested();
  });
}

export function resolveQuitConfirmation(requestId: string, confirmed: boolean): void {
  shutdownCoordinator.resolveQuitConfirmation(requestId, confirmed);
}

export function ackShutdownFlush(): void {
  shutdownCoordinator.ackShutdownFlush();
}

export function markShutdownReady(): void {
  shutdownCoordinator.markShutdownReady();
}

export function watchWindow(window: BrowserWindow): void {
  shutdownCoordinator.watchWindow(window);
}

export function isShutdownInProgress(): boolean {
  return shutdownCoordinator.isShutdownInProgress();
}

export function shouldAllowWindowClose(): boolean {
  return (
    shutdownCoordinator.state === 'shutting-down' ||
    updateService.isInstallRequested ||
    isTaixuInstallRequested()
  );
}

export { createShutdownCoordinator, runQuitCleanup };
export type {
  QuitState,
  ShutdownCoordinator,
  ShutdownCoordinatorDependencies,
} from './coordinator';

export async function assertIdleForTaixuUpdate() {
  if (!assertNoScheduledWork) throw new Error('Update readiness is not available yet.');
  await assertNoScheduledWork();
  if (!sessionSummarySource)
    throw new Error('Task activity is unavailable. Try again after startup.');
  await assertUpdateActivityIdle(
    sessionSummarySource.runtimes,
    // This is the restarting installation's broker, never a renderer's routed
    // Studio snapshot. Its local host owns the processes disposed by this app.
    // Attached SSH hosts retain their tasks when this desktop disconnects.
    [LOCAL_HOST_REF]
  );
}

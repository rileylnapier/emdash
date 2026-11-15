import { randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import { appsStatusSchema, type AppAction, type AppsStatus } from '../api/apps-contract';

export function requestApps(worker: UtilityProcess, input?: AppAction): Promise<AppsStatus> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const done = (error?: string, result?: AppsStatus) => {
      clearTimeout(timeout);
      worker.removeListener('message', onMessage);
      worker.removeListener('exit', onExit);
      if (error || !result) reject(new Error(error || 'App status is unavailable.'));
      else resolve(result);
    };
    const onExit = () => done('Studio disconnected. Refresh app status before trying again.');
    const onMessage = (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'apps-result' ||
        !('id' in message) ||
        message.id !== id
      )
        return;
      if ('error' in message && typeof message.error === 'string') return done(message.error);
      const parsed = appsStatusSchema.safeParse('result' in message ? message.result : null);
      if (parsed.success) done(undefined, parsed.data);
      else done('Studio returned an unreadable app status.');
    };
    const timeout = setTimeout(
      () => done('App action was not confirmed. Refresh status before trying again.'),
      input ? 85000 : 15000
    );
    worker.on('message', onMessage);
    worker.once('exit', onExit);
    try {
      worker.postMessage({ type: 'apps-request', id, input });
    } catch {
      onExit();
    }
  });
}

import { EventEmitter } from 'node:events';
import type { UtilityProcess } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { callApps, requestApps } from './apps-channel';
class Worker extends EventEmitter {
  postMessage = vi.fn();
  handle() {
    return this as unknown as UtilityProcess;
  }
}
afterEach(() => vi.useRealTimers());
it('matches request IDs, validates status and removes listeners after completion', async () => {
  const worker = new Worker();
  const pending = requestApps(worker.handle());
  const { id } = worker.postMessage.mock.calls[0]![0];
  worker.emit('message', { type: 'apps-result', id: 'other', result: {} });
  expect(worker.listenerCount('message')).toBe(1);
  worker.emit('message', { type: 'apps-result', id, result: { computer: 'Studio', apps: [] } });
  expect(await pending).toEqual({ computer: 'Studio', apps: [] });
  expect(worker.listenerCount('message')).toBe(0);
  expect(worker.listenerCount('exit')).toBe(0);
});
it('accepts apps the page has not seen before, such as a newly added hub app', async () => {
  const worker = new Worker();
  const pending = requestApps(worker.handle());
  const app = {
    id: 'bonsai',
    name: 'Bonsai',
    detail: 'Money',
    supported: true,
    state: 'stopped',
    endpoint: null,
    windowOpen: false,
    blockers: [],
    version: '0.1.0',
  };
  worker.emit('message', {
    type: 'apps-result',
    id: worker.postMessage.mock.calls[0]![0].id,
    result: { computer: 'Studio', apps: [app] },
  });
  await expect(pending).resolves.toMatchObject({ apps: [{ id: 'bonsai' }] });
  const bad = requestApps(worker.handle());
  worker.emit('message', {
    type: 'apps-result',
    id: worker.postMessage.mock.calls[1]![0].id,
    result: { computer: 'Studio', apps: [{ ...app, id: '../Bonsai' }] },
  });
  await expect(bad).rejects.toThrow('unreadable');
});
it('treats malformed status and worker disconnects as failures without retrying actions', async () => {
  const worker = new Worker();
  const malformed = requestApps(worker.handle());
  const rejected = expect(malformed).rejects.toThrow('unreadable');
  worker.emit('message', {
    type: 'apps-result',
    id: worker.postMessage.mock.calls[0]![0].id,
    result: { computer: 'Studio', apps: [{}] },
  });
  await rejected;
  const pending = requestApps(worker.handle(), { appId: 'flow', action: 'start' });
  const disconnected = expect(pending).rejects.toThrow('disconnected');
  worker.emit('exit');
  await disconnected;
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.listenerCount('message')).toBe(0);
});
it('reports uncertainty on timeout and never resubmits a service action', async () => {
  vi.useFakeTimers();
  const worker = new Worker();
  const pending = requestApps(worker.handle(), { appId: 'flow', action: 'open' });
  const rejected = expect(pending).rejects.toThrow('not confirmed');
  await vi.advanceTimersByTimeAsync(85000);
  await rejected;
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(worker.listenerCount('message')).toBe(0);
});

it('sends one transfer step to the hub, matches its reply and reports its errors', async () => {
  const worker = new Worker();
  const pending = callApps(worker.handle(), 'release', { appId: 'bonsai' });
  const sent = worker.postMessage.mock.calls[0]![0];
  expect(sent).toMatchObject({ type: 'apps-call', method: 'release', input: { appId: 'bonsai' } });
  worker.emit('message', { type: 'apps-call-result', id: 'other', result: 1 });
  worker.emit('message', { type: 'apps-call-result', id: sent.id, result: { version: '0.1.0' } });
  await expect(pending).resolves.toEqual({ version: '0.1.0' });
  const failing = callApps(worker.handle(), 'install', {});
  worker.emit('message', {
    type: 'apps-call-result',
    id: worker.postMessage.mock.calls[1]![0].id,
    error: 'same developer',
  });
  await expect(failing).rejects.toThrow('same developer');
  const lost = callApps(worker.handle(), 'chunk', {});
  worker.emit('exit');
  await expect(lost).rejects.toThrow('Try installing again');
  expect(worker.listenerCount('message')).toBe(0);
});

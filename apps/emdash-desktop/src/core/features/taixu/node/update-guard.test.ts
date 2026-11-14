import { afterEach, beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
it('drains requests, freezes new work, requires renderer readiness and unlocks after cancellation', async () => {
  const guard = await import('./update-guard');
  let done!: () => void;
  const call = guard.guardedDesktopCall(
    'tasks.create',
    () =>
      new Promise<void>((r) => {
        done = r;
      })
  );
  const heads = vi.fn(async () => {});
  const idle = vi.fn(async () => {});
  guard.registerHeadUpdateGuard(heads);
  const holding = guard.holdForUpdate(idle);
  await expect(guard.guardedDesktopCall('tasks.create', () => {})).rejects.toThrow(/update/);
  expect(heads).not.toHaveBeenCalled();
  done();
  await call;
  await vi.advanceTimersByTimeAsync(100);
  expect(heads).toHaveBeenCalledWith(true);
  expect(idle).not.toHaveBeenCalled();
  guard.acknowledgeUpdateHold('wrong', null);
  expect(idle).not.toHaveBeenCalled();
  guard.acknowledgeUpdateHold(guard.getUpdateHold()!, null);
  const release = await holding;
  expect(idle).toHaveBeenCalledOnce();
  await guard.guardedDesktopCall('mementos.memento.save', () => {});
  await release();
  expect(heads).toHaveBeenLastCalledWith(false);
  expect(guard.getUpdateHold()).toBeNull();
  await guard.guardedDesktopCall('tasks.create', () => {});
});
it.each(['dirty', 'missing', 'busy'])('refuses %s readiness and unlocks', async (kind) => {
  const guard = await import('./update-guard');
  const heads = vi.fn(async () => {});
  guard.registerHeadUpdateGuard(heads);
  const holding = guard.holdForUpdate(async () => {
    if (kind === 'busy') throw new Error('Active task');
  });
  const rejected = expect(holding).rejects.toThrow(
    kind === 'dirty' ? /Unsaved/ : kind === 'missing' ? /window/ : /Active/
  );
  await vi.advanceTimersByTimeAsync(0);
  if (kind === 'missing') await vi.advanceTimersByTimeAsync(10001);
  else
    guard.acknowledgeUpdateHold(guard.getUpdateHold()!, kind === 'dirty' ? 'Unsaved files' : null);
  await rejected;
  expect(guard.isUpdateHeld()).toBe(false);
  expect(guard.getUpdateHold()).toBeNull();
});

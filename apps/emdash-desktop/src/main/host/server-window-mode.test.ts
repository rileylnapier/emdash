import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { expect, it, vi } from 'vitest';
import { createServerWindowMode } from './server-window-mode';

function windowFixture(fullscreen = false) {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getNormalBounds: () => ({ x: 80, y: 60, width: 1400, height: 900 }),
    getMinimumSize: () => [700, 500],
    isMaximized: () => true,
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn(),
    unmaximize: vi.fn(),
    maximize: vi.fn(),
    setMinimumSize: vi.fn(),
    setBounds: vi.fn(),
  });
  return { window, apply: createServerWindowMode(() => window as unknown as BrowserWindow) };
}

it('shrinks the host window and restores its bounds, minimum and maximized state', () => {
  const { window, apply } = windowFixture();
  apply(false);
  expect(window.setBounds).not.toHaveBeenCalled();
  apply(true);
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(440, 500);
  expect(window.setBounds).toHaveBeenLastCalledWith({ x: 80, y: 60, width: 520, height: 620 });
  apply(true);
  expect(window.setBounds).toHaveBeenCalledTimes(1);
  apply(false);
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(700, 500);
  expect(window.setBounds).toHaveBeenLastCalledWith({ x: 80, y: 60, width: 1400, height: 900 });
  expect(window.maximize).toHaveBeenCalledOnce();
});

it('waits for fullscreen exit before resizing and restores fullscreen on return', () => {
  const { window, apply } = windowFixture(true);
  apply(true);
  expect(window.setFullScreen).toHaveBeenLastCalledWith(false);
  expect(window.setBounds).not.toHaveBeenCalled();
  window.isFullScreen = () => false;
  window.emit('leave-full-screen');
  expect(window.setBounds).toHaveBeenLastCalledWith({ x: 80, y: 60, width: 520, height: 620 });
  apply(false);
  expect(window.setFullScreen).toHaveBeenLastCalledWith(true);
});

it('honors a reversal while macOS is still leaving fullscreen', () => {
  const { window, apply } = windowFixture(true);
  apply(true);
  apply(false);
  window.isFullScreen = () => false;
  window.emit('leave-full-screen');
  expect(window.setBounds).toHaveBeenCalledExactlyOnceWith({
    x: 80,
    y: 60,
    width: 1400,
    height: 900,
  });
  expect(window.setFullScreen).toHaveBeenLastCalledWith(true);
});

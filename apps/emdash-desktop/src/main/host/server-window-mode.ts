import type { BrowserWindow, Rectangle } from 'electron';

type ModeWindow = Pick<
  BrowserWindow,
  | 'isDestroyed'
  | 'getNormalBounds'
  | 'getMinimumSize'
  | 'isMaximized'
  | 'isFullScreen'
  | 'setFullScreen'
  | 'once'
  | 'unmaximize'
  | 'maximize'
  | 'setMinimumSize'
  | 'setBounds'
>;

// Window state is local UI state; resizing must never route to the selected Studio.
export function createServerWindowMode(getWindow: () => ModeWindow | null) {
  let window: ModeWindow | null = null;
  let compact = false;
  let leavingFullscreen = false;
  let saved:
    | { bounds: Rectangle; minimum: number[]; maximized: boolean; fullscreen: boolean }
    | undefined;
  return (enabled: boolean) => {
    const current = getWindow();
    if (!current || current.isDestroyed()) return;
    if (current !== window) {
      window = current;
      compact = false;
      saved = undefined;
      leavingFullscreen = false;
    }
    if (compact === enabled) return;
    compact = enabled;
    if (enabled && !saved) {
      saved = {
        bounds: current.getNormalBounds(),
        minimum: current.getMinimumSize(),
        maximized: current.isMaximized(),
        fullscreen: current.isFullScreen(),
      };
    }
    const resize = () => {
      if (window !== current || current.isDestroyed() || !saved) return;
      leavingFullscreen = false;
      if (compact) {
        current.unmaximize();
        current.setMinimumSize(440, 500);
        current.setBounds({ ...saved.bounds, width: 520, height: 620 });
      } else {
        current.setMinimumSize(saved.minimum[0]!, saved.minimum[1]!);
        current.setBounds(saved.bounds);
        if (saved.maximized) current.maximize();
        if (saved.fullscreen) current.setFullScreen(true);
        saved = undefined;
      }
    };
    if (leavingFullscreen) return;
    if (current.isFullScreen()) {
      leavingFullscreen = true;
      current.once('leave-full-screen', resize);
      current.setFullScreen(false);
    } else resize();
  };
}

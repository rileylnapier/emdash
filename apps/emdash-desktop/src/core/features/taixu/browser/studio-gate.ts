import { getStudioClient, setStudioDesktop } from '../api/browser/studio-client';
import type { StudioStatus } from '../api/studio-contract';
import { mountUpdateControls } from './update-controls';

let removeScreen: (() => void) | undefined;
function screen(message: string, actions: { label: string; run(): void }[] = []) {
  removeScreen?.();
  const element = document.createElement('section');
  element.id = 'taixu-connection-gate';
  element.setAttribute('role', 'alert');
  element.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#0e1328;color:#efe6d2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:48px;text-align:center;font:16px system-ui;-webkit-app-region:no-drag';
  const title = document.createElement('h1');
  title.textContent = 'Taixu · Studio';
  title.style.cssText = 'font:38px Georgia;color:#c9a24b';
  const text = document.createElement('p');
  text.textContent = message;
  text.style.maxWidth = '560px';
  element.append(title, text);
  for (const action of actions) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.style.cssText =
      'padding:12px 24px;border:1px solid #c9a24b;border-radius:8px;cursor:pointer';
    button.onclick = action.run;
    element.append(button);
  }
  document.body.append(element);
  const disposeUpdates = mountUpdateControls(element);
  const remove = () => {
    disposeUpdates();
    element.remove();
    if (removeScreen === remove) removeScreen = undefined;
  };
  removeScreen = remove;
  return remove;
}

function useLocal() {
  void getStudioClient()
    .then((c) => c.disconnect())
    .then(() => location.reload())
    .catch(() => screen('Could not switch computers. Restart Taixu.'));
}

function connecting(name: string | null) {
  return screen(`Connecting to ${name ?? 'Studio'}…`, [
    { label: 'Cancel · use this Mac', run: useLocal },
  ]);
}

async function recovery(status: StudioStatus): Promise<void> {
  return new Promise((resolve) => {
    const show = (message: string) =>
      screen(message, [
        {
          label: 'Reconnect to Studio',
          run: () => {
            connecting(status.name);
            void getStudioClient()
              .then((c) => c.connect({ id: status.selected! }))
              .then((next) => {
                if (next.connected) {
                  removeScreen?.();
                  resolve();
                } else show(next.error ?? 'The Studio is unavailable.');
              })
              .catch(() =>
                show(
                  'Could not reconnect. Check that Taixu is open on the Studio and SSH is reachable.'
                )
              );
          },
        },
        { label: 'Use this Mac instead', run: useLocal },
      ]);
    show(
      `${status.error ?? 'The Studio is offline.'} Keep Taixu open with laptop access enabled on the Studio. Your work stays there; no commands are replayed.`
    );
  });
}

/** Select the backend before stores, mementos and subscriptions are constructed. */
export async function prepareStudioDesktop(showConnectionScreen: () => void) {
  const control = await getStudioClient();
  let status = await control.status();
  if (!status.selected) {
    setStudioDesktop(false);
    return false;
  }
  // Recovery happens before React mounts. Let the host lift its startup splash
  // now, otherwise it covers the reconnect and use-this-Mac controls.
  showConnectionScreen();
  if (!status.connected && !status.error) {
    const remove = connecting(status.name);
    try {
      status = await control.connect({ id: status.selected });
    } catch {
      status = {
        ...status,
        error: 'Could not reach the Studio. Check its connection and try again.',
      };
    } finally {
      remove();
    }
  }
  if (!status.connected) await recovery(status);
  setStudioDesktop(true, status.name);
  let recovering = false;
  const timer = setInterval(() => {
    if (recovering) return;
    void control
      .status()
      .then(async (current) => {
        if (current.connected) return;
        recovering = true;
        await recovery({ ...current, selected: current.selected ?? status.selected });
        location.reload();
      })
      .catch(() => {
        recovering = true;
        screen('The desktop connection stopped. Restart Taixu to reconnect.');
      });
  }, 2500);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  return true;
}

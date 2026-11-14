import '@emdash/ui/style.css';
import { Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';
import type { taixuContract, WorkArchiveResult } from '../api/contract';
import { WorkArchiveModal } from './work-archive-modal';

const mocks = vi.hoisted(() => ({ dirty: vi.fn(), dismiss: vi.fn() }));
vi.mock('@core/features/editor/api/browser/open-file-store/open-file-store', () => ({
  openFileStore: { dirtyEntries: mocks.dirty },
}));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useModalController: () => ({ dismiss: mocks.dismiss }),
}));
const target = { taskId: '11111111-1111-4111-8111-111111111111', projectId: 'project' };
let host: HTMLDivElement;
let root: Root;
let archiveWork: ReturnType<typeof vi.fn<() => Promise<WorkArchiveResult>>>;
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.dirty.mockReturnValue([]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  archiveWork = vi.fn().mockResolvedValue({
    archived: true,
    cleaned: true,
    message: 'Dependencies cleaned. History kept.',
  });
  const client = { archiveWork } as unknown as ContractClient<typeof taixuContract>;
  await act(async () =>
    root.render(
      <ThemeProvider theme="emdark" onThemeChange={() => {}}>
        <Dialog.Root open>
          <WorkArchiveModal {...target} client={client} />
        </Dialog.Root>
      </ThemeProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
it('protects unsaved editor files before touching the backend', async () => {
  mocks.dirty.mockReturnValue([{}]);
  await act(async () => button('Finish & archive').click());
  expect(archiveWork).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Save or discard unsaved files');
  mocks.dirty.mockReturnValue([]);
  await act(async () => button('Finish & archive').click());
  expect(archiveWork).toHaveBeenCalledWith(target);
  expect(button('Archived').disabled).toBe(true);
});
it('keeps a failed cleanup visible and retries the same target without double submission', async () => {
  let finish!: (value: WorkArchiveResult) => void;
  archiveWork.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await act(async () => {
    button('Finish & archive').click();
    button('Finish & archive').click();
  });
  expect(archiveWork).toHaveBeenCalledTimes(1);
  expect(button('Checking & cleaning…').disabled).toBe(true);
  await act(async () =>
    finish({
      archived: true,
      cleaned: false,
      message: 'Studio: terminal still open. Retry cleanup.',
    })
  );
  expect(host.textContent).toContain('Studio: terminal still open');
  expect(button('Retry cleanup').disabled).toBe(false);
  await act(async () => button('Retry cleanup').click());
  expect(archiveWork).toHaveBeenCalledTimes(2);
  expect(button('Archived').disabled).toBe(true);
});

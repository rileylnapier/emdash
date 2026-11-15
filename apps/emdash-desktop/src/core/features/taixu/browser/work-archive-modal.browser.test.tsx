import '@emdash/ui/style.css';
import { Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';
import type { taixuContract, WorkArchiveResult } from '../api/contract';
import { WorkArchiveModal, WorkArchiveListModal } from './work-archive-modal';

const mocks = vi.hoisted(() => ({ dirty: vi.fn(), dismiss: vi.fn(), complete: vi.fn() }));
vi.mock('@core/features/editor/api/browser/open-file-store/open-file-store', () => ({
  openFileStore: { dirtyEntries: mocks.dirty },
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getRegisteredTaskData: () => ({ name: 'Flow · Tidy samples' }),
}));
vi.mock('@core/primitives/modals/react/use-close-guard', () => ({ useCloseGuard: () => {} }));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useOpenModal: () => vi.fn(),
  useModalController: () => ({ dismiss: mocks.dismiss, complete: mocks.complete }),
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
  host.style.cssText =
    'width:640px;margin:32px auto;background:#171923;color:#eee;font:14px system-ui';
  document.body.append(host);
  root = createRoot(host);
  archiveWork = vi.fn().mockResolvedValue({
    archived: true,
    cleaned: true,
    message: 'Dependencies cleaned. History kept.',
  });
  const client = { archiveWork, readArchive: async () => null } as unknown as ContractClient<
    typeof taixuContract
  >;
  await act(async () =>
    root.render(
      <ThemeProvider theme="emdark" onThemeChange={() => {}}>
        <Dialog.Root open>
          <Dialog.Content>
            <WorkArchiveModal
              {...target}
              client={client}
              initialContext="Use compact tags. Follow up on keyboard navigation."
            />
          </Dialog.Content>
        </Dialog.Root>
      </ThemeProvider>
    )
  );
});
it('shows the reviewed handoff before archiving', async () => {
  expect(document.body.querySelector('textarea')?.value).toContain(
    'Follow up on keyboard navigation.'
  );
  expect(archiveWork).not.toHaveBeenCalled();
  if (import.meta.env.VITE_TAIXU_ARCHIVE_SCREENSHOT) {
    await page.viewport(900, 720);
    await page.screenshot({ path: import.meta.env.VITE_TAIXU_ARCHIVE_SCREENSHOT });
  }
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function button(text: string) {
  const result = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text
  );
  if (!result) throw new Error(`Missing ${text}`);
  return result;
}
it('protects unsaved editor files before touching the backend', async () => {
  mocks.dirty.mockReturnValue([{}]);
  await act(async () => button('Archive work').click());
  expect(archiveWork).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Save or discard unsaved files');
  mocks.dirty.mockReturnValue([]);
  await act(async () => button('Archive work').click());
  expect(archiveWork).toHaveBeenCalledWith({
    ...target,
    context: 'Use compact tags. Follow up on keyboard navigation.',
  });
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
    button('Archive work').click();
    button('Archive work').click();
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
  expect(document.body.textContent).toContain('Studio: terminal still open');
  expect(button('Retry cleanup').disabled).toBe(false);
  await act(async () => button('Retry cleanup').click());
  expect(archiveWork).toHaveBeenCalledTimes(2);
  expect(button('Archived').disabled).toBe(true);
});

it('shows saved context and cleanup state without offering workspace restore', async () => {
  const client = {
    listArchives: async () => ({
      notes: [
        {
          ...target,
          name: 'Compact tags',
          context: 'Keep tags easy to reach.',
          branch: 'tags',
          commit: 'abc',
          workspacePath: '/removed/checkout',
          urls: ['https://github.com/example/repo/pull/1'],
          savedAt: '2026-11-14T00:00:00Z',
          archived: true,
          cleaned: true,
          message: 'Checkout removed.',
        },
      ],
      nextOffset: null,
    }),
  } as unknown as ContractClient<typeof taixuContract>;
  await act(async () =>
    root.render(
      <ThemeProvider theme="emdark" onThemeChange={() => {}}>
        <Dialog.Root open>
          <Dialog.Content>
            <WorkArchiveListModal client={client} />
          </Dialog.Content>
        </Dialog.Root>
      </ThemeProvider>
    )
  );
  expect(document.body.textContent).toContain('Compact tags · Checkout removed');
  await act(async () => document.body.querySelector('summary')!.click());
  expect(document.body.textContent).toContain('Keep tags easy to reach.');
  expect(document.body.textContent).not.toContain('Restore');
  expect(document.body.querySelector('a')?.href).toBe('https://github.com/example/repo/pull/1');
});

import '@emdash/ui/style.css';
import { Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ThemeProvider } from '@core/primitives/theme/browser/theme-provider';
import type { MergeReview, MergeResult, taixuContract } from '../api/contract';
import { WorkMergeModal } from './work-merge-modal';

const mocks = vi.hoisted(() => ({ dismiss: vi.fn(), closeGuard: vi.fn() }));
vi.mock('@core/manifests/browser/modal-api', () => ({
  useModalController: () => ({ dismiss: mocks.dismiss }),
}));
vi.mock('@core/primitives/modals/react/use-close-guard', () => ({
  useCloseGuard: mocks.closeGuard,
}));
const target = { taskId: '11111111-1111-4111-8111-111111111111', projectId: 'project' };
const initial: MergeReview = {
  reviewId: '22222222-2222-4222-8222-222222222222',
  blockedReason: null,
  warning: 'Checks are not passing.',
  pr: {
    url: 'https://github.com/example/project/pull/38',
    provider: 'github',
    repositoryUrl: 'https://github.com/example/project',
    headRepositoryUrl: 'https://github.com/example/project',
    headRefName: 'image-support',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    identifier: '#38',
    title: 'Support chat images (test fixture)',
    description: '<script>untrusted()</script>',
    status: 'open',
    isDraft: true,
    additions: 20,
    deletions: 2,
    changedFiles: 3,
    commitCount: 1,
    mergeableStatus: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: null,
    checkSummary: 'FAILURE',
    createdAt: '2026-11-13',
    updatedAt: '2026-11-13',
    author: null,
    labels: [],
    assignees: [],
    checks: [],
  },
};
let host: HTMLDivElement;
let root: Root;
let reviewMerge: ReturnType<typeof vi.fn>;
let approveMerge: ReturnType<typeof vi.fn<() => Promise<MergeResult>>>;
beforeAll(async () => {
  await page.viewport(960, 800);
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  host.style.cssText =
    'width:640px;margin:32px auto;padding:24px;background:#171923;color:#eee;font:14px system-ui';
  reviewMerge = vi.fn().mockResolvedValue(structuredClone(initial));
  approveMerge = vi
    .fn()
    .mockResolvedValue({ status: 'merged', message: 'Merged #38. Saved in your chat.' });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render() {
  const client = { reviewMerge, approveMerge } as unknown as ContractClient<typeof taixuContract>;
  await act(async () =>
    root.render(
      <ThemeProvider theme="emdark" onThemeChange={() => {}}>
        <Dialog.Root open>
          <WorkMergeModal {...target} client={client} />
        </Dialog.Root>
      </ThemeProvider>
    )
  );
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
it('requires the warning and draft acknowledgements, submits once, and locks close until a result', async () => {
  await render();
  expect(reviewMerge).toHaveBeenCalledWith(target, { timeoutMs: 120000 });
  expect(button('Approve merge').disabled).toBe(true);
  expect(host.querySelector('script')).toBeNull();
  const checkboxes = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
  await act(async () => checkboxes[0].click());
  expect(button('Approve merge').disabled).toBe(true);
  await act(async () => checkboxes[1].click());
  expect(button('Approve merge').disabled).toBe(false);
  await page.screenshot({ path: '.context/merge-review.png' });
  let finish!: (result: MergeResult) => void;
  approveMerge.mockImplementation(
    () =>
      new Promise<MergeResult>((resolve) => {
        finish = resolve;
      })
  );
  await act(async () => {
    button('Approve merge').click();
    button('Approve merge').click();
  });
  expect(approveMerge).toHaveBeenCalledOnce();
  expect(approveMerge).toHaveBeenCalledWith(
    {
      ...target,
      reviewId: initial.reviewId,
      strategy: 'squash',
      markReady: true,
      acceptWarnings: true,
    },
    { timeoutMs: 120000 }
  );
  expect(button('Cancel').disabled).toBe(true);
  expect(mocks.closeGuard).toHaveBeenLastCalledWith(true);
  await act(async () => finish({ status: 'merged', message: 'Merged #38. Saved in your chat.' }));
  expect(host.textContent).toContain('Merged #38. Saved in your chat.');
  expect(button('Approve merge').disabled).toBe(true);
  expect(mocks.closeGuard).toHaveBeenLastCalledWith(false);
  await act(async () => button('Close').click());
  expect(mocks.dismiss).toHaveBeenCalledOnce();
});
it('keeps blocked PRs disabled and leaves a disconnected review without an approval action', async () => {
  reviewMerge.mockResolvedValue({
    ...initial,
    blockedReason: 'This pull request is already merged.',
    warning: null,
    pr: { ...initial.pr, isDraft: false, status: 'merged' },
  });
  await render();
  expect(host.textContent).toContain('already merged');
  expect(button('Approve merge').disabled).toBe(true);
  expect(approveMerge).not.toHaveBeenCalled();
});
it('reports a lost response as uncertain and prevents resubmission', async () => {
  reviewMerge.mockResolvedValue({
    ...initial,
    warning: null,
    pr: { ...initial.pr, isDraft: false },
  });
  approveMerge.mockRejectedValue(new Error('Connection lost'));
  await render();
  await act(async () => button('Approve merge').click());
  expect(host.textContent).toContain('Merge outcome not confirmed');
  expect(button('Approve merge').disabled).toBe(true);
});

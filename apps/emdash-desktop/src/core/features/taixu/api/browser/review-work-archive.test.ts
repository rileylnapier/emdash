import { beforeEach, expect, it, vi } from 'vitest';
import { reviewWorkArchives } from './review-work-archive';

const mocks = vi.hoisted(() => ({ open: vi.fn(), client: vi.fn(), error: vi.fn() }));
vi.mock('@core/manifests/browser/modal-api', () => ({ openModal: mocks.open }));
vi.mock('@emdash/ui/react/primitives', () => ({ toast: { error: mocks.error } }));
vi.mock('./client', () => ({ getTaixuClient: mocks.client }));
const targets = [
  { taskId: 'one', projectId: 'project' },
  { taskId: 'two', projectId: 'project' },
  { taskId: 'three', projectId: 'project' },
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.client.mockResolvedValue({});
  mocks.open.mockResolvedValue({ success: true });
});
it('reviews selected tasks sequentially and stops on cancel', async () => {
  mocks.open.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
  await reviewWorkArchives(targets);
  expect(mocks.open.mock.calls).toEqual([
    ['taixuArchiveModal', { ...targets[0], client: {} }],
    ['taixuArchiveModal', { ...targets[1], client: {} }],
  ]);
});
it('does not stack reviews when another archive button is clicked', async () => {
  let finish!: (result: { success: boolean }) => void;
  mocks.open.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const first = reviewWorkArchives(targets.slice(0, 1));
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
  await reviewWorkArchives(targets.slice(1));
  expect(mocks.open).toHaveBeenCalledOnce();
  finish({ success: true });
  await first;
  await reviewWorkArchives(targets.slice(1));
  expect(mocks.open).toHaveBeenCalledTimes(3);
});
it('reports an unavailable connection and permits a later retry', async () => {
  mocks.client.mockRejectedValueOnce(new Error('disconnected'));
  await reviewWorkArchives(targets);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledOnce();
  await reviewWorkArchives(targets.slice(0, 1));
  expect(mocks.open).toHaveBeenCalledOnce();
});

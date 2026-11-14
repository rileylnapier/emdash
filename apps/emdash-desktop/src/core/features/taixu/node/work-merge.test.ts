import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import type { ContractClient } from '@emdash/wire/rpc';
import { expect, it, vi } from 'vitest';
import type { pullRequestsContract } from '@core/services/pull-requests/api/contract';
import type { MergeApproval, MergeReceiptInput } from '../api/contract';
import { createWorkMerge } from './work-merge';

const target = { taskId: '11111111-1111-4111-8111-111111111111', projectId: 'project' };
const repositoryUrl = 'https://github.com/example/project';
const initial: PullRequest = {
  url: `${repositoryUrl}/pull/38`,
  provider: 'github',
  repositoryUrl,
  headRepositoryUrl: 'https://github.com/fork/project',
  headRefName: 'feature',
  headRefOid: 'a'.repeat(40),
  baseRefName: 'main',
  baseRefOid: 'b'.repeat(40),
  identifier: '#38',
  title: 'Add images',
  description: 'Reviewed change',
  status: 'open',
  isDraft: false,
  additions: 20,
  deletions: 2,
  changedFiles: 3,
  commitCount: 1,
  mergeableStatus: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  checkSummary: 'SUCCESS',
  createdAt: '2026-11-13',
  updatedAt: '2026-11-13',
  author: null,
  labels: [],
  assignees: [],
  checks: [],
};
function setup() {
  let pr = structuredClone(initial);
  const readHead = vi.fn(async () => ({
    repositoryUrl,
    headRepositoryUrl: initial.headRepositoryUrl,
    headRefName: initial.headRefName,
  }));
  const ok = { success: true, data: undefined };
  const client = {
    registerRepository: vi.fn(async () => ok),
    refreshRepository: vi.fn(async () => ok),
    refreshHistory: vi.fn(async () => ok),
    getPullRequestsForHead: vi.fn(async () => ({ success: true, data: { prs: [pr] } })),
    refreshPullRequest: vi.fn(async () => ok),
    getPullRequestByUrl: vi.fn(async () => ({ success: true, data: { pr } })),
    markReadyForReview: vi.fn(async () => {
      pr = { ...pr, isDraft: false, mergeStateStatus: 'CLEAN' };
      return ok;
    }),
    mergePullRequest: vi.fn(async () => ({
      success: true,
      data: { merged: true, sha: 'c'.repeat(40) },
    })),
  };
  const receipts = new Map<string, MergeReceiptInput>();
  const record = vi.fn(async (input: MergeReceiptInput) => {
    const existing = receipts.get(input.requestId);
    if (!existing || (existing.status === 'pending' && input.status !== 'pending'))
      receipts.set(input.requestId, input);
    return { status: receipts.get(input.requestId)!.status, created: !existing };
  });
  const deps = {
    readHead,
    getClient: async () => client as unknown as ContractClient<typeof pullRequestsContract>,
  };
  const service = createWorkMerge(deps);
  const approval = async (): Promise<MergeApproval> => ({
    ...target,
    reviewId: (await service.review(target)).reviewId,
    strategy: 'squash',
    markReady: false,
    acceptWarnings: false,
  });
  return {
    service,
    client,
    receipts,
    record,
    deps,
    approval,
    change: (patch: Partial<PullRequest>) => {
      pr = { ...pr, ...patch };
    },
  };
}
it('resolves the fork and saves approval before merging the reviewed commit without bypass', async () => {
  const s = setup();
  const approval = await s.approval();
  s.client.mergePullRequest.mockImplementation(async () => {
    expect([...s.receipts.values()][0].status).toBe('pending');
    return { success: true, data: { merged: true, sha: 'c'.repeat(40) } };
  });
  expect(await s.service.approve(approval, s.record)).toMatchObject({ status: 'merged' });
  expect(s.client.getPullRequestsForHead).toHaveBeenCalledWith({
    repositoryUrl,
    headRepositoryUrl: initial.headRepositoryUrl,
    headRefName: 'feature',
  });
  expect(s.client.mergePullRequest).toHaveBeenCalledWith({
    repositoryUrl,
    number: 38,
    options: { strategy: 'squash', commitHeadOid: initial.headRefOid, bypassRequirements: false },
  });
  expect([...s.receipts.values()][0].status).toBe('merged');
});
it.each([
  { headRefOid: 'd'.repeat(40) },
  { baseRefOid: 'd'.repeat(40) },
  { baseRefName: 'release' },
  { checkSummary: 'FAILURE' as const },
  { reviewDecision: 'CHANGES_REQUESTED' },
  { headRepositoryUrl: 'https://github.com/another/project' },
])('requires a fresh approval when reviewed details change: %j', async (patch) => {
  const s = setup();
  const approval = await s.approval();
  s.change(patch);
  expect((await s.service.approve(approval, s.record)).status).toBe('failed');
  expect(s.record).not.toHaveBeenCalled();
  expect(s.client.mergePullRequest).not.toHaveBeenCalled();
});
it.each([
  { status: 'merged' as const },
  { status: 'closed' as const },
  { mergeableStatus: 'CONFLICTING' as const },
  { mergeStateStatus: 'BLOCKED' as const },
  { reviewDecision: 'REVIEW_REQUIRED' },
  { provider: 'gitlab' },
])('blocks unavailable or protected PRs: %j', async (patch) => {
  const s = setup();
  s.change(patch);
  expect((await s.service.review(target)).blockedReason).toBeTruthy();
  expect((await s.service.approve(await s.approval(), s.record)).status).toBe('failed');
  expect(s.client.mergePullRequest).not.toHaveBeenCalled();
});
it('requires explicit check warning and draft approval, then rereads after marking ready', async () => {
  const s = setup();
  s.change({ isDraft: true, mergeStateStatus: 'BLOCKED', checkSummary: 'FAILURE' });
  expect((await s.service.approve(await s.approval(), s.record)).status).toBe('failed');
  expect(
    (await s.service.approve({ ...(await s.approval()), markReady: true }, s.record)).status
  ).toBe('failed');
  expect(s.client.markReadyForReview).not.toHaveBeenCalled();
  expect(
    (
      await s.service.approve(
        { ...(await s.approval()), markReady: true, acceptWarnings: true },
        s.record
      )
    ).status
  ).toBe('merged');
  expect(s.client.markReadyForReview).toHaveBeenCalledOnce();
});
it('does not replay a concurrent approval, a second dialog or a restarted service', async () => {
  const s = setup();
  const approval = await s.approval();
  await Promise.all([s.service.approve(approval, s.record), s.service.approve(approval, s.record)]);
  await s.service.approve(await s.approval(), s.record);
  const restarted = createWorkMerge(s.deps);
  await restarted.approve(
    { ...approval, reviewId: (await restarted.review(target)).reviewId },
    s.record
  );
  expect(s.client.mergePullRequest).toHaveBeenCalledOnce();
});
it('never merges without saving intent, and records an uncertain response without replay', async () => {
  const s = setup();
  expect(
    (
      await s.service.approve(await s.approval(), async () => {
        throw new Error('Disk unavailable');
      })
    ).status
  ).toBe('failed');
  expect(s.client.mergePullRequest).not.toHaveBeenCalled();
  s.client.mergePullRequest.mockRejectedValue(new Error('Connection lost'));
  expect((await s.service.approve(await s.approval(), s.record)).status).toBe('unknown');
  expect([...s.receipts.values()][0].status).toBe('unknown');
  expect((await s.service.approve(await s.approval(), s.record)).status).toBe('unknown');
  expect(s.client.mergePullRequest).toHaveBeenCalledOnce();
});
it('refuses missing or ambiguous PRs and mismatched task approvals', async () => {
  const s = setup();
  const approval = await s.approval();
  expect((await s.service.approve({ ...approval, projectId: 'other' }, s.record)).status).toBe(
    'failed'
  );
  s.client.getPullRequestsForHead.mockResolvedValue({ success: true, data: { prs: [] } });
  await expect(s.service.review(target)).rejects.toThrow('No pull request');
  s.client.getPullRequestsForHead.mockResolvedValue({
    success: true,
    data: { prs: [initial, initial] },
  });
  await expect(s.service.review(target)).rejects.toThrow('More than one');
  expect(s.client.mergePullRequest).not.toHaveBeenCalled();
});

it('discovers an externally merged PR in history without approving or merging anything', async () => {
  const s = setup();
  s.change({ status: 'merged' });
  s.client.getPullRequestsForHead.mockResolvedValueOnce({ success: true, data: { prs: [] } });
  expect(await s.service.observe(target)).toMatchObject({
    ...target,
    status: 'merged',
    url: initial.url,
  });
  expect(s.client.refreshHistory).toHaveBeenCalledWith({ repositoryUrl });
  expect(s.client.refreshPullRequest).toHaveBeenCalledWith({
    repositoryUrl,
    number: 38,
    policy: 'force',
  });
  expect(s.record).not.toHaveBeenCalled();
  expect(s.client.mergePullRequest).not.toHaveBeenCalled();
});

it('refreshes cached open status and refuses ambiguous or unavailable observations', async () => {
  const s = setup();
  expect((await s.service.observe(target)).status).toBe('open');
  s.change({ status: 'merged' });
  expect((await s.service.observe(target)).status).toBe('merged');
  expect(s.client.refreshPullRequest).toHaveBeenCalledTimes(2);
  s.client.getPullRequestsForHead.mockResolvedValue({
    success: true,
    data: { prs: [initial, initial] },
  });
  await expect(s.service.observe(target)).rejects.toThrow('More than one');
  s.client.refreshRepository.mockRejectedValue(new Error('Offline'));
  await expect(s.service.observe(target)).rejects.toThrow('Offline');
});

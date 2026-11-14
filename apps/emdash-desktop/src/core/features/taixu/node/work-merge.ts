import { createHash, randomUUID } from 'node:crypto';
import type { PullRequest } from '@emdash/plugins/pull-requests/schemas';
import type { ContractClient } from '@emdash/wire/rpc';
import type { pullRequestsContract } from '@core/services/pull-requests/api/contract';
import { pullRequestErrorMessage } from '@core/services/pull-requests/api/errors';
import type {
  MergeApproval,
  MergeReceiptInput,
  MergeResult,
  MergeReview,
  WorkTarget,
} from '../api/contract';

type Client = ContractClient<typeof pullRequestsContract>;
export type WorkHead = { repositoryUrl: string; headRepositoryUrl: string; headRefName: string };
type RecordReceipt = (
  input: MergeReceiptInput
) => Promise<{ status: 'pending' | MergeResult['status']; created: boolean }>;
const fingerprint = (pr: PullRequest) =>
  JSON.stringify([
    pr.url,
    pr.headRepositoryUrl,
    pr.headRefName,
    pr.headRefOid,
    pr.baseRefName,
    pr.baseRefOid,
    pr.status,
    pr.isDraft,
    pr.reviewDecision,
    pr.checkSummary,
    pr.checks
      .map((c) => [c.id, c.commitSha, c.status, c.conclusion])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
export function mergeBlock(pr: PullRequest): string | null {
  if (pr.provider !== 'github')
    return 'Head chat currently supports GitHub pull requests. Open the work for this provider.';
  if (pr.status !== 'open')
    return pr.status === 'merged'
      ? 'This pull request is already merged.'
      : 'This pull request is closed.';
  if (!pr.headRefOid || pr.mergeableStatus !== 'MERGEABLE')
    return 'GitHub has not confirmed this branch can merge without conflicts. Refresh after resolving it.';
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED')
    return 'Required review is not complete. Open the pull request to resolve it.';
  if (!pr.isDraft && !['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus ?? ''))
    return 'GitHub reports a branch rule or merge status that needs attention. Open the work to resolve it.';
  return null;
}
function warning(pr: PullRequest): string | null {
  const passing =
    pr.checks.length &&
    pr.checks.every(
      (c) =>
        c.status.toUpperCase() === 'COMPLETED' &&
        ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion?.toUpperCase() ?? '')
    );
  return pr.checkSummary === 'SUCCESS' || (pr.checkSummary == null && passing)
    ? null
    : 'Checks are missing, pending or not passing. Review the listed checks before approving. GitHub branch rules still apply.';
}
export function createWorkMerge({
  readHead,
  getClient,
}: {
  readHead: (target: WorkTarget) => Promise<WorkHead>;
  getClient: () => Promise<Client>;
}) {
  const reviews = new Map<
    string,
    { target: WorkTarget; pr: PullRequest; at: number; used: boolean }
  >();
  async function read(target: WorkTarget, policy: 'force' | 'if-stale' = 'force') {
    const head = await readHead(target);
    const client = await getClient();
    const registered = await client.registerRepository({ repositoryUrl: head.repositoryUrl });
    if (!registered.success) throw new Error(pullRequestErrorMessage(registered.error));
    const refreshedRepository = await client.refreshRepository({
      repositoryUrl: head.repositoryUrl,
      policy,
    });
    if (!refreshedRepository.success)
      throw new Error(pullRequestErrorMessage(refreshedRepository.error));
    let found = await client.getPullRequestsForHead(head);
    if (!found.success) throw new Error(pullRequestErrorMessage(found.error));
    // A PR merged outside Taixu may no longer be in the open inventory.
    if (!found.data.prs.length) {
      const history = await client.refreshHistory({ repositoryUrl: head.repositoryUrl });
      if (!history.success) throw new Error(pullRequestErrorMessage(history.error));
      found = await client.getPullRequestsForHead(head);
      if (!found.success) throw new Error(pullRequestErrorMessage(found.error));
    }
    const open = found.data.prs.filter((pr) => pr.status === 'open');
    const candidates = open.length ? open : found.data.prs;
    if (candidates.length !== 1)
      throw new Error(
        candidates.length
          ? 'More than one pull request matches this work. Open work to choose it.'
          : 'No pull request found for this work’s published branch. Ask the agent to open one first.'
      );
    const candidate = candidates[0];
    const number = Number(candidate.identifier?.replace(/^#/, ''));
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error('Pull request number unavailable. Open the work.');
    const refreshed = await client.refreshPullRequest({
      repositoryUrl: head.repositoryUrl,
      number,
      policy,
    });
    if (!refreshed.success) throw new Error(pullRequestErrorMessage(refreshed.error));
    const latest = await client.getPullRequestByUrl({
      repositoryUrl: head.repositoryUrl,
      url: candidate.url,
    });
    if (!latest.success) throw new Error(pullRequestErrorMessage(latest.error));
    const pr = latest.data.pr;
    if (
      !pr ||
      pr.headRepositoryUrl !== head.headRepositoryUrl ||
      pr.headRefName !== head.headRefName
    )
      throw new Error('The work’s pull request changed. Reopen the review.');
    return { pr, number, client };
  }
  return {
    async observe(target: WorkTarget) {
      const { pr } = await read(target);
      if (pr.provider !== 'github') throw new Error('GitHub status unavailable.');
      return { ...target, status: pr.status, url: pr.url, at: new Date().toISOString() };
    },
    async review(target: WorkTarget): Promise<MergeReview> {
      const { pr } = await read(target);
      for (const [id, r] of reviews) if (Date.now() - r.at > 600000) reviews.delete(id);
      const reviewId = randomUUID();
      reviews.set(reviewId, { target, pr, at: Date.now(), used: false });
      return { reviewId, pr, blockedReason: mergeBlock(pr), warning: warning(pr) };
    },
    async approve(input: MergeApproval, record: RecordReceipt): Promise<MergeResult> {
      const review = reviews.get(input.reviewId);
      if (
        !review ||
        review.target.taskId !== input.taskId ||
        review.target.projectId !== input.projectId ||
        Date.now() - review.at > 600000
      )
        return {
          status: 'failed',
          message: 'This review expired. Reopen Review merge for current details.',
        };
      if (review.used)
        return {
          status: 'unknown',
          message:
            'This approval was already handled. Check the saved result in your chat; it will not be sent again.',
        };
      review.used = true;
      let receipt: MergeReceiptInput | undefined;
      let dispatched = false;
      try {
        const { pr, number, client } = await read(input);
        if (fingerprint(pr) !== fingerprint(review.pr))
          throw new Error(
            'The pull request, base branch, checks or reviews changed. Reopen Review merge before approving.'
          );
        const blocked = mergeBlock(pr);
        if (blocked) throw new Error(blocked);
        if (pr.isDraft && !input.markReady)
          throw new Error('Confirm marking this draft ready before merging.');
        if (warning(pr) && !input.acceptWarnings)
          throw new Error('Review and acknowledge the check warnings before merging.');
        // Stable per-commit identity prevents a new dialog/device/restart from replaying an uncertain merge.
        const requestId = createHash('sha256')
          .update(JSON.stringify([pr.url, pr.headRefOid]))
          .digest('hex');
        receipt = {
          taskId: input.taskId,
          projectId: input.projectId,
          requestId,
          url: pr.url,
          head: pr.headRefOid,
          strategy: input.strategy,
          status: 'pending',
          message: `Merge approval saved for ${pr.url} at ${pr.headRefOid}. Outcome not yet confirmed.`,
        };
        const saved = await record(receipt);
        if (!saved.created)
          return {
            status: saved.status === 'pending' ? 'unknown' : saved.status,
            message:
              saved.status === 'merged'
                ? 'This commit was already merged. The result is saved in your chat.'
                : 'A previous approval for this commit was recorded. Check the chat and GitHub before trying again in Inspect work.',
          };
        if (pr.isDraft) {
          // The checkbox explicitly authorizes this separate GitHub write.
          dispatched = true;
          const ready = await client.markReadyForReview({
            repositoryUrl: pr.repositoryUrl,
            number,
          });
          if (!ready.success) throw new Error(pullRequestErrorMessage(ready.error));
          const current = await read(input);
          if (
            fingerprint({ ...current.pr, isDraft: true }) !== fingerprint(pr) ||
            mergeBlock(current.pr)
          )
            throw new Error(
              'Draft marked ready, but merge conditions changed. Review the pull request again in Inspect work.'
            );
        }
        dispatched = true;
        const result = await client.mergePullRequest({
          repositoryUrl: pr.repositoryUrl,
          number,
          options: {
            strategy: input.strategy,
            commitHeadOid: pr.headRefOid,
            bypassRequirements: false,
          },
        });
        if (!result.success) throw new Error(pullRequestErrorMessage(result.error));
        if (!result.data.merged) throw new Error('GitHub did not confirm a completed merge.');
        const message = `Merged ${pr.url} (${input.strategy}).${result.data.sha ? ` Merge commit: ${result.data.sha}.` : ''}`;
        await record({ ...receipt, status: 'merged', message });
        return { status: 'merged', message };
      } catch (error) {
        const status = dispatched ? 'unknown' : 'failed';
        const reason = error instanceof Error ? error.message : 'Merge could not be completed.';
        const message = dispatched
          ? `Merge not confirmed. Check GitHub before retrying. ${reason}`
          : reason;
        if (receipt) {
          try {
            await record({ ...receipt, status, message });
          } catch {
            /* Durable pending receipt prevents replay. */
          }
        }
        return { status, message };
      }
    },
  };
}

import { Button, Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { useEffect, useRef, useState } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import type { MergeReview, WorkTarget, taixuContract } from '../api/contract';

export function WorkMergeModal({
  taskId,
  projectId,
  client,
}: WorkTarget & { client: ContractClient<typeof taixuContract> }) {
  const { dismiss } = useModalController('taixuMergeModal');
  const [review, setReview] = useState<MergeReview | null>(null);
  const [notice, setNotice] = useState('Checking this work’s pull request on GitHub…');
  const [strategy, setStrategy] = useState<'squash' | 'merge' | 'rebase'>('squash');
  const [markReady, setMarkReady] = useState(false);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const sending = useRef(false);
  useCloseGuard(busy);
  useEffect(() => {
    let disposed = false;
    void client
      .reviewMerge({ taskId, projectId }, { timeoutMs: 120000 })
      .then((value) => {
        if (disposed) return;
        setReview(value);
        setNotice(
          value.blockedReason ??
            'Review the branch, checks and PR before approving. The result will be saved in your Head chat.'
        );
      })
      .catch((error) => {
        if (!disposed)
          setNotice(
            error instanceof Error
              ? error.message
              : 'Could not load the pull request. Reconnect and reopen this review.'
          );
      });
    return () => {
      disposed = true;
    };
  }, [client, taskId, projectId]);
  async function approve() {
    if (!review || sending.current || settled) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = await client.approveMerge(
        { taskId, projectId, reviewId: review.reviewId, strategy, markReady, acceptWarnings },
        { timeoutMs: 120000 }
      );
      setNotice(result.message);
    } catch {
      setNotice(
        'Merge outcome not confirmed. Check the saved chat receipt and GitHub before trying again.'
      );
    } finally {
      sending.current = false;
      setBusy(false);
      setSettled(true);
    }
  }
  const pr = review?.pr;
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Review merge</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <p role="status">{notice}</p>
          {pr && (
            <>
              <a href={pr.url} target="_blank" rel="noreferrer" className="underline">
                {pr.identifier} · {pr.title}
              </a>
              <p>
                {pr.headRepositoryUrl} · {pr.headRefName} → {pr.baseRefName}
                <br />
                Commit {pr.headRefOid.slice(0, 12)} · {pr.status}
                {pr.isDraft ? ' · Draft' : ''}
                <br />
                Review: {pr.reviewDecision ?? 'No review decision'} · GitHub:{' '}
                {pr.mergeStateStatus ?? 'Unknown'}
              </p>
              <p>
                {pr.changedFiles ?? '?'} files · +{pr.additions ?? '?'} / −{pr.deletions ?? '?'}
              </p>
              <details>
                <summary>PR description</summary>
                <p className="whitespace-pre-wrap">
                  {pr.description || 'No description supplied.'}
                </p>
              </details>
              <ul>
                {pr.checks.map((check) => (
                  <li key={check.id}>
                    {check.name}: {check.conclusion ?? check.status}
                  </li>
                ))}
              </ul>
              {!pr.checks.length && <p>No checks reported.</p>}
              {review.warning && (
                <label>
                  <input
                    type="checkbox"
                    checked={acceptWarnings}
                    disabled={busy || settled}
                    onChange={(e) => setAcceptWarnings(e.target.checked)}
                  />{' '}
                  I reviewed the check warnings: {review.warning}
                </label>
              )}
              {pr.isDraft && (
                <label>
                  <input
                    type="checkbox"
                    checked={markReady}
                    disabled={busy || settled}
                    onChange={(e) => setMarkReady(e.target.checked)}
                  />{' '}
                  Mark this draft ready for review, then merge if GitHub permits it.
                </label>
              )}
              <label>
                Merge method
                <select
                  aria-label="Merge method"
                  className="w-full rounded border border-border bg-background p-2"
                  value={strategy}
                  disabled={busy || settled}
                  onChange={(e) => setStrategy(e.target.value as typeof strategy)}
                >
                  <option value="squash">Squash</option>
                  <option value="merge">Merge commit</option>
                  <option value="rebase">Rebase</option>
                </select>
              </label>
            </>
          )}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" disabled={busy} onClick={() => dismiss()}>
          {settled ? 'Close' : 'Cancel'}
        </Button>
        <Button
          disabled={
            !review ||
            !!review.blockedReason ||
            busy ||
            settled ||
            (!!pr?.isDraft && !markReady) ||
            (!!review?.warning && !acceptWarnings)
          }
          onClick={() => void approve()}
        >
          {busy ? 'Merging…' : 'Approve merge'}
        </Button>
      </Dialog.Footer>
    </>
  );
}
export const taixuMergeModal = defineModal<void>()({
  id: 'taixuMergeModal',
  component: WorkMergeModal,
});

import { Button, Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { useRef, useState } from 'react';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import type { taixuContract, WorkTarget } from '../api/contract';

export function WorkArchiveModal({
  taskId,
  projectId,
  client,
}: WorkTarget & { client: ContractClient<typeof taixuContract> }) {
  const { dismiss } = useModalController('taixuArchiveModal');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState(
    'Finish this merged work by closing its idle agent sessions and moving the task to the archive. Installed dependencies are cleaned automatically. Your chat, reports, images, PR link, source checkout and branch stay available.'
  );
  const sending = useRef(false);
  async function finish() {
    if (sending.current || done) return;
    if (openFileStore.dirtyEntries().length) {
      setNotice('Save or discard unsaved files in Inspect work before archiving.');
      return;
    }
    sending.current = true;
    setBusy(true);
    setAttempted(true);
    try {
      const result = await client.archiveWork({ taskId, projectId });
      setNotice(result.message);
      setDone(result.archived && result.cleaned);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Archiving was not confirmed. Reconnect and retry; history is kept.'
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Finish &amp; archive</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <p role="status">{notice}</p>
          <p>
            Active agents, terminals, setup scripts and uncommitted changes block this action. Use
            Restore work in chat when you need the saved workspace again. Dependencies may need
            reinstalling.
          </p>
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" disabled={busy} onClick={() => dismiss()}>
          {done ? 'Close' : 'Cancel'}
        </Button>
        <Button disabled={busy || done} onClick={() => void finish()}>
          {busy
            ? 'Checking & cleaning…'
            : done
              ? 'Archived'
              : attempted
                ? 'Retry cleanup'
                : 'Finish & archive'}
        </Button>
      </Dialog.Footer>
    </>
  );
}
export const taixuArchiveModal = defineModal<void>()({
  id: 'taixuArchiveModal',
  component: WorkArchiveModal,
});

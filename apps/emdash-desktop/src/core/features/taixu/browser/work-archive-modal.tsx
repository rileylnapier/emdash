import { Box, Button, Dialog, Label, Text, Textarea } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useRef, useState } from 'react';
import { openFileStore } from '@core/features/editor/api/browser/open-file-store/open-file-store';
import { getRegisteredTaskData } from '@core/features/tasks/api/browser/task-state/task-selectors';
import { useOpenModal, useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import type { taixuContract, WorkArchiveNote, WorkTarget } from '../api/contract';

export const WorkArchiveModal = observer(function WorkArchiveModal({
  taskId,
  projectId,
  client,
  initialContext = '',
}: WorkTarget & { client: ContractClient<typeof taixuContract>; initialContext?: string }) {
  const { dismiss, complete } = useModalController('taixuArchiveModal');
  const contextId = useId();
  const taskName = getRegisteredTaskData(projectId, taskId)?.name ?? taskId;
  const [context, setContext] = useState(initialContext);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState(
    'Save a short handoff, close idle sessions and remove the clean checkout and its dependencies. Your Git branch and commits stay in the repository.'
  );
  const sending = useRef(false);
  useCloseGuard(busy);
  useEffect(() => {
    let current = true;
    void client
      .readArchive({ taskId, projectId })
      .then((note) => {
        if (!current) return;
        if (note) {
          setContext(note.context);
          setNotice(note.message);
          setDone(note.cleaned);
          setAttempted(note.archived);
        }
      })
      .catch(() => {
        if (current) {
          setLoadFailed(true);
          setNotice('Could not read saved context. Close this dialog and try again.');
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [client, taskId, projectId]);
  async function finish() {
    if (sending.current || done || loading || loadFailed || !context.trim()) return;
    if (openFileStore.dirtyEntries().length) {
      setNotice('Save or discard unsaved files in Inspect work before archiving.');
      return;
    }
    sending.current = true;
    setBusy(true);
    setAttempted(true);
    try {
      const result = await client.archiveWork({ taskId, projectId, context: context.trim() });
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
        <Dialog.Title>{done ? 'Archived work' : 'Archive work'}</Dialog.Title>
        <Dialog.Description>{taskName}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Body>
        <Box display="flex" flexDirection="column" gap="4">
          <Text as="p" role="status">
            {notice}
          </Text>
          <Box display="flex" flexDirection="column" gap="2">
            <Label htmlFor={contextId}>Context to keep</Label>
            <Textarea
              id={contextId}
              rows={8}
              style={{ minHeight: 160 }}
              value={context}
              onChange={(event) => setContext(event.target.value)}
              maxLength={24000}
              disabled={loading || busy || done || loadFailed}
              placeholder="What changed, key decisions, unfinished work, and useful links…"
            />
          </Box>
          <Text as="p" tone="muted">
            Active work and uncommitted changes block archiving. Unique ignored files keep the
            checkout in place for review. Saved notes are available in Work archive on this Mac; a
            complete workspace restore is not provided.
          </Text>
        </Box>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" disabled={busy} onClick={() => (done ? complete() : dismiss())}>
          {done ? 'Close' : 'Cancel'}
        </Button>
        <Button
          variant="primary"
          disabled={loading || loadFailed || !context.trim() || busy || done}
          onClick={() => void finish()}
        >
          {busy
            ? 'Checking & cleaning…'
            : done
              ? 'Archived'
              : attempted
                ? 'Retry cleanup'
                : loading
                  ? 'Loading…'
                  : 'Archive work'}
        </Button>
      </Dialog.Footer>
    </>
  );
});
export const taixuArchiveModal = defineModal<void>()({
  id: 'taixuArchiveModal',
  component: WorkArchiveModal,
});

export function WorkArchiveListModal({ client }: { client: ContractClient<typeof taixuContract> }) {
  const { dismiss } = useModalController('taixuArchiveListModal');
  const openArchive = useOpenModal('taixuArchiveModal');
  const [notes, setNotes] = useState<WorkArchiveNote[]>([]);
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setBusy(true);
    void client
      .listArchives({ offset })
      .then((result) => {
        if (!current) return;
        setNotes(result.notes);
        setNextOffset(result.nextOffset);
        setError('');
      })
      .catch(() => {
        if (current) setError('Could not load the archive. Close and try again.');
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [client, offset]);
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Work archive</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Box display="flex" flexDirection="column" gap="4">
          <Text as="p" tone="muted">
            Saved context on this Mac. Use it to brief a new task whenever you revisit the work.
          </Text>
          <p role="status">
            {busy ? 'Loading…' : error || (!notes.length ? 'No saved work yet.' : '')}
          </p>
          {!busy &&
            !error &&
            notes.map((note) => (
              <Box as="details" key={note.taskId} surface="base" borderRadius="md" padding="3">
                <summary style={{ cursor: 'pointer' }}>
                  {note.name} ·{' '}
                  {note.cleaned
                    ? 'Checkout removed'
                    : note.archived
                      ? 'Cleanup needed'
                      : 'Context saved'}
                </summary>
                <Box display="flex" flexDirection="column" gap="3" marginTop="3">
                  <Text as="p" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
                    {note.context}
                  </Text>
                  <Text
                    as="p"
                    tone="muted"
                    style={{ overflowWrap: 'anywhere', userSelect: 'text' }}
                  >
                    {note.branch || 'Branch unknown'} · {note.commit || 'Commit unknown'}
                  </Text>
                  {note.urls
                    .filter((url) => /^https?:\/\//.test(url))
                    .map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {url}
                      </a>
                    ))}
                  <Text as="p">{note.message}</Text>
                  {!note.cleaned && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        dismiss();
                        void openArchive({
                          taskId: note.taskId,
                          projectId: note.projectId,
                          client,
                        });
                      }}
                    >
                      {note.archived ? 'Retry cleanup' : 'Finish archiving'}
                    </Button>
                  )}
                </Box>
              </Box>
            ))}
        </Box>
      </Dialog.Body>
      <Dialog.Footer>
        {offset > 0 && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Previous
          </Button>
        )}
        {nextOffset !== null && (
          <Button variant="secondary" disabled={busy} onClick={() => setOffset(nextOffset)}>
            Next
          </Button>
        )}
        <Button onClick={() => dismiss()}>Close</Button>
      </Dialog.Footer>
    </>
  );
}
export const taixuArchiveListModal = defineModal<void>()({
  id: 'taixuArchiveListModal',
  component: WorkArchiveListModal,
});

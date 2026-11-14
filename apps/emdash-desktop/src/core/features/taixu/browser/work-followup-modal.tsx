import { Button, Dialog } from '@emdash/ui/react/primitives';
import type { ContractClient } from '@emdash/wire/rpc';
import { useEffect, useRef, useState } from 'react';
import type { ConversationsClient } from '@core/features/conversations/api/browser/client';
import { useModalController } from '@core/manifests/browser/modal-api';
import type { Conversation } from '@core/primitives/conversations/api';
import { defineModal } from '@core/primitives/modals/react';
import type { taixuContract } from '../api/contract';

function WorkFollowupModal({
  taskId,
  projectId,
  initialText,
  client,
  conversations,
}: {
  taskId: string;
  projectId: string;
  initialText: string;
  client: ContractClient<typeof taixuContract>;
  conversations: ConversationsClient;
}) {
  const { dismiss } = useModalController('taixuFollowupModal');
  const [text, setText] = useState(initialText);
  const [agents, setAgents] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [notice, setNotice] = useState('Loading this work’s agents…');
  const sending = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let disposed = false;
    void conversations
      .getConversationsForTask({ taskId, projectId })
      .then((items) => {
        if (disposed) return;
        const choices = items.filter((c) => ['claude', 'codex'].includes(c.providerId ?? ''));
        setAgents(choices);
        if (choices.length === 1) setConversationId(choices[0].id);
        setNotice(
          choices.length
            ? 'Review these instructions. They will go to the existing agent and its next reply will return to your Head chat.'
            : 'No Claude or Codex agent is available in this work. Open the work to resume it.'
        );
      })
      .catch(() => {
        if (!disposed) setNotice('Could not load agents. Reconnect and reopen this dialog.');
      });
    return () => {
      disposed = true;
    };
  }, [conversations, taskId, projectId]);
  async function send() {
    if (sending.current || settled || !conversationId || !text.trim()) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = await client.followupWork({
        taskId,
        projectId,
        conversationId,
        requestId: requestId.current,
        text,
      });
      setNotice(result.message);
      setSettled(true);
    } catch {
      // A lost acknowledgement may mean the agent received it. Never retry silently.
      setNotice('Could not confirm delivery. Open the work to check before sending again.');
      setSettled(true);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Send changes to the agent</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <p role="status">{notice}</p>
          <label>
            Agent
            <select
              aria-label="Agent receiving changes"
              value={conversationId}
              disabled={busy || settled}
              onChange={(e) => setConversationId(e.target.value)}
              className="w-full rounded border border-border bg-background p-2"
            >
              <option value="">Choose the agent</option>
              {agents.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || c.providerId} · {c.agentStatus}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Instructions for the agent"
            value={text}
            maxLength={24000}
            rows={12}
            disabled={busy || settled}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded border border-border bg-background p-3"
          />
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="secondary" onClick={() => dismiss()}>
          {settled ? 'Close' : 'Cancel'}
        </Button>
        <Button
          disabled={busy || settled || !conversationId || !text.trim()}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send changes'}
        </Button>
      </Dialog.Footer>
    </>
  );
}
export const taixuFollowupModal = defineModal<void>()({
  id: 'taixuFollowupModal',
  component: WorkFollowupModal,
});

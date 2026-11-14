import { expect, it, vi } from 'vitest';
import { createWorkFollowup, WorkFollowupUnavailable } from './work-followup';

type Dependencies = Parameters<typeof createWorkFollowup>[0];
const input = {
  taskId: 'task',
  projectId: 'project',
  conversationId: 'conversation',
  requestId: 'request',
  text: 'Make the roof smaller',
};

function setup(type = 'acp') {
  const conversation = {
    id: 'conversation',
    taskId: 'task',
    projectId: 'project',
    providerId: 'codex',
    agentStatus: 'completed',
    type,
  };
  const task = { id: 'task', workspaceId: 'workspace', archivedAt: null as string | null };
  const session = {
    lifecycle: 'ready',
    suspended: false,
    isGenerating: false,
    pendingPermissionCount: 0,
    queuedPromptCount: 0,
    backgroundAgentCount: 0,
  };
  const snapshot = vi.fn(async () => ({ data: { conversation: session } }));
  const sendPrompt = vi.fn(async () => ({ success: true, data: undefined }));
  const sendFollowup = vi.fn(async () => ({ success: true, data: { status: 'sent' } }));
  const client = vi.fn(async () => ({
    success: true,
    data: {
      acp: { sessions: { state: () => ({ snapshot }) }, sendPrompt },
      tuiAgents: { sendFollowup },
    },
  }));
  const resolve = vi.fn(async () => ({ host: 'studio' }));
  // Minimal service fixtures: unused methods and fields do not participate in delivery.
  const prepare = createWorkFollowup({
    readConversations: async () => [conversation],
    taskService: { getTasks: async () => [task] },
    workspaceIdentity: { resolve },
    runtimes: { client },
  } as unknown as Dependencies);
  return {
    prepare,
    conversation,
    task,
    session,
    snapshot,
    sendPrompt,
    sendFollowup,
    client,
    resolve,
  };
}

it('routes changes to the existing ACP conversation on its owning host, with a stable prompt ID', async () => {
  const { prepare, sendPrompt, sendFollowup, client, resolve } = setup();
  const send = await prepare(input);
  expect(sendPrompt).not.toHaveBeenCalled();
  await send();
  expect(resolve).toHaveBeenCalledWith('workspace');
  expect(client).toHaveBeenCalledWith('studio');
  expect(sendPrompt).toHaveBeenCalledWith(
    {
      conversationId: 'conversation',
      promptId: 'request',
      prompt: { text: expect.stringContaining(input.text) },
      placement: 'queue',
    },
    { timeoutMs: 0 }
  );
  expect(sendFollowup).not.toHaveBeenCalled();
});

it.each(['taskId', 'projectId', 'conversationId'] as const)(
  'refuses a mismatched %s before connecting to a runtime',
  async (field) => {
    const { prepare, client } = setup();
    await expect(prepare({ ...input, [field]: 'other' })).rejects.toBeInstanceOf(
      WorkFollowupUnavailable
    );
    expect(client).not.toHaveBeenCalled();
  }
);

it.each([
  'isGenerating',
  'pendingPermissionCount',
  'queuedPromptCount',
  'backgroundAgentCount',
  'suspended',
  'lifecycle',
] as const)('rechecks live ACP %s after preparation and before sending', async (field) => {
  const { prepare, session, sendPrompt } = setup();
  const send = await prepare(input);
  Object.assign(session, {
    [field]: field === 'lifecycle' ? 'starting' : field.endsWith('Count') ? 1 : true,
  });
  await expect(send()).rejects.toBeInstanceOf(WorkFollowupUnavailable);
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('rejects archived work and cached permission requests without contacting the host', async () => {
  const { prepare, task, conversation, client } = setup();
  task.archivedAt = '2026-11-13';
  await expect(prepare(input)).rejects.toBeInstanceOf(WorkFollowupUnavailable);
  task.archivedAt = null;
  conversation.agentStatus = 'awaiting-input';
  await expect(prepare(input)).rejects.toBeInstanceOf(WorkFollowupUnavailable);
  expect(client).not.toHaveBeenCalled();
});

it.each(['not-ready', 'interrupted'])(
  'uses guarded host delivery for PTY and distinguishes %s from transport uncertainty',
  async (status) => {
    const { prepare, sendFollowup, sendPrompt } = setup('pty');
    sendFollowup.mockResolvedValue({ success: true, data: { status } });
    const send = await prepare({ ...input, text: 'Smaller\r\nroof\x1b[201~' });
    await expect(send()).rejects.toBeInstanceOf(WorkFollowupUnavailable);
    expect(sendFollowup).toHaveBeenCalledWith({
      conversationId: 'conversation',
      text: 'Follow-up instructions from the Taixu Head conversation:\n\nSmaller\nroof[201~',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
  }
);

it('leaves transport failures uncertain because submission may have succeeded', async () => {
  const { prepare, sendPrompt } = setup();
  sendPrompt.mockRejectedValue(new Error('Connection lost'));
  const send = await prepare(input);
  await expect(send()).rejects.not.toBeInstanceOf(WorkFollowupUnavailable);
});

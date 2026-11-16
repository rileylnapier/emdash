import type { GitBranch } from '@emdash/core/runtimes/git/api';
import { describe, expect, it } from 'vitest';
import { emptyProviderSettings } from '@core/features/conversations/api/provider-settings';
import {
  buildHeadTaskParams,
  chooseHeadAgent,
  HeadTaskUnavailable,
  matchDefaultBranch,
  type HeadTaskAgent,
} from './head-task';

const capabilities = (overrides: Record<string, unknown> = {}) =>
  ({
    acp: { kind: 'supported' },
    prompt: { kind: 'argv' },
    autoApprove: { kind: 'supported' },
    ...overrides,
  }) as unknown as HeadTaskAgent['capabilities'];
const agent = (id: string, status = 'available', caps = capabilities()) =>
  ({ id, status, capabilities: caps }) as HeadTaskAgent;
const origin = { name: 'origin', url: 'git@github.com:o/r.git' };
const branches = [
  { type: 'local', ref: 'refs/heads/main', oid: 'a' },
  { type: 'remote', ref: 'refs/remotes/origin/main', remote: origin, oid: 'a' },
] as GitBranch[];
const request = {
  taskId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project',
  name: 'taixu-fix-roofs',
  prompt: 'Work brief:\n# Fix roofs\n',
};
const base = {
  request,
  agent: agent('claude'),
  providerSettings: { ...emptyProviderSettings, pty: { version: '1' as const, autoApprove: true } },
  preferredConversationType: 'pty' as const,
  tasks: { createBranchAndWorktree: true },
  project: { branchPrefix: 'emdash', appendRandomBranchSuffix: true, pushOnCreate: true },
  defaultBranch: { type: 'remote' as const, branch: 'main', remote: origin },
  localBranches: ['main'],
  conversationId: '22222222-2222-4222-8222-222222222222',
  suffix: 'ab12c',
};

describe('the task dialog defaults for Head-started work', () => {
  it('uses the default agent when installed, else the first installed agent', () => {
    const agents = [agent('codex'), agent('claude', 'missing'), agent('gemini')];
    expect(chooseHeadAgent(agents, 'gemini').id).toBe('gemini');
    expect(chooseHeadAgent(agents, 'claude').id).toBe('codex');
    expect(() => chooseHeadAgent([agent('claude', 'missing')], 'claude')).toThrow(
      HeadTaskUnavailable
    );
  });

  it('matches the effective default branch to a real ref', () => {
    expect(matchDefaultBranch({ remote: 'origin', branch: 'main' }, branches)).toEqual({
      type: 'remote',
      branch: 'main',
      remote: origin,
    });
    expect(matchDefaultBranch({ remote: null, branch: 'main' }, branches)).toEqual({
      type: 'local',
      branch: 'main',
    });
    expect(matchDefaultBranch({ remote: 'upstream', branch: 'main' }, branches)).toBeUndefined();
    expect(matchDefaultBranch(null, branches)).toBeUndefined();
  });

  it('builds a new worktree branch and a terminal conversation carrying the brief', () => {
    expect(buildHeadTaskParams(base)).toEqual({
      id: request.taskId,
      projectId: 'project',
      taskConfig: {
        version: '1',
        name: 'taixu-fix-roofs',
        initialConversation: {
          id: base.conversationId,
          provider: 'claude',
          title: 'Claude (1)',
          initialPrompt: 'Work brief:\n# Fix roofs',
          autoApprove: true,
          type: 'pty',
        },
      },
      workspaceConfig: {
        version: '2',
        git: {
          kind: 'create-branch',
          branchName: 'emdash/taixu-fix-roofs-ab12c',
          fromBranch: base.defaultBranch,
          pushBranch: true,
        },
        workspace: { kind: 'new-worktree' },
      },
    });
  });

  it('follows the saved chat interface, provider options and branch settings', () => {
    const params = buildHeadTaskParams({
      ...base,
      preferredConversationType: 'acp',
      providerSettings: {
        ...base.providerSettings,
        acp: { version: '1', options: { mode: 'plan' } },
      },
      project: { branchPrefix: '', appendRandomBranchSuffix: false, pushOnCreate: false },
    });
    expect(params.taskConfig.initialConversation).toEqual({
      id: base.conversationId,
      provider: 'claude',
      title: 'Claude (1)',
      initialQueue: [{ text: request.prompt }],
      // The dialog never auto-approves chat conversations.
      autoApprove: false,
      options: { mode: 'plan' },
      type: 'acp',
    });
    expect(params.workspaceConfig.git).toMatchObject({
      branchName: 'taixu-fix-roofs',
      pushBranch: false,
    });
    // Without chat support, the saved chat preference falls back to the terminal.
    const terminal = buildHeadTaskParams({
      ...base,
      agent: agent('codex', 'available', capabilities({ acp: { kind: 'unsupported' } })),
      preferredConversationType: 'acp',
    });
    expect(terminal.taskConfig.initialConversation).toMatchObject({
      type: 'pty',
      provider: 'codex',
    });
  });

  it('refuses defaults it cannot reproduce instead of guessing', () => {
    for (const change of [
      { defaultBranch: undefined },
      { tasks: { createBranchAndWorktree: false } },
      { localBranches: ['emdash/taixu-fix-roofs-ab12c'] },
      {
        agent: agent(
          'amp',
          'available',
          capabilities({ acp: { kind: 'unsupported' }, prompt: { kind: 'none' } })
        ),
      },
    ])
      expect(() => buildHeadTaskParams({ ...base, ...change })).toThrow(HeadTaskUnavailable);
  });
});

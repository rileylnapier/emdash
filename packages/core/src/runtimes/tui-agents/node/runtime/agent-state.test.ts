import { peek } from '@emdash/wire/state';
import { describe, expect, it, vi } from 'vitest';
import {
  createTuiAgentStatesLiveModel,
  createTuiAgentStatesListModel,
  createTuiSessionsLiveModel,
  createTuiSessionsListModel,
  produceCell,
} from '#runtimes/tui-agents/node/state/live-models';
import { TuiAgentStates } from './agent-state';

function createTracker(now = () => 1_000) {
  const sessionsLiveModel = createTuiSessionsLiveModel();
  const agentStatesLiveModel = createTuiAgentStatesLiveModel();
  const sessions = createTuiSessionsListModel(sessionsLiveModel);
  const agentStates = createTuiAgentStatesListModel(agentStatesLiveModel);
  const onSessionIdChanged = vi.fn();
  const onAgentStateChanged = vi.fn();
  const tracker = new TuiAgentStates(
    sessions,
    agentStates,
    now,
    onSessionIdChanged,
    onAgentStateChanged
  );
  return { tracker, sessions, agentStates, onSessionIdChanged, onAgentStateChanged };
}

describe('TuiAgentStates', () => {
  it('maps canonical status hook events to agent state', () => {
    const { tracker, agentStates } = createTracker();

    tracker.applyCanonicalEvent('conv-1', 'codex', {
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
      message: 'approve command',
    });

    expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
      conversationId: 'conv-1',
      providerId: 'codex',
      status: 'awaiting-input',
      source: 'hook',
      notificationType: 'permission_prompt',
      message: 'approve command',
      updatedAt: expect.any(Number),
    });
  });

  it('marks input submitted as working only when the provider lacks a start hook', () => {
    const { tracker, agentStates } = createTracker();

    tracker.markInputSubmitted('conv-1', { hooks: { kind: 'none' } }, '\r');
    expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');

    tracker.markInputSubmitted(
      'conv-2',
      { hooks: { kind: 'config', scope: 'workspace', supportedEvents: ['start'] } },
      '\r'
    );
    expect(peek(agentStates.states.list)['conv-2']).toBeUndefined();
  });

  it.each(['permission_prompt', 'elicitation_dialog', undefined] as const)(
    'requires attention for %s notifications, including unknown types',
    (notificationType) => {
      const { tracker } = createTracker();
      tracker.applyCanonicalEvent('conv-1', 'claude', { kind: 'status', type: 'stop' });
      tracker.applyCanonicalEvent('conv-1', 'claude', {
        kind: 'status',
        type: 'notification',
        notificationType,
      });
      expect(tracker.current('conv-1')).toMatchObject({ status: 'awaiting-input' });
    }
  );

  it('refreshes repeated completion evidence after newer input', () => {
    let now = 100;
    const { tracker, sessions, onAgentStateChanged } = createTracker(() => now);
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'claude',
        sessionId: 'conv-1',
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
        lastInputAt: 1,
      };
    });
    const stopped = { kind: 'status', type: 'stop' } as const;
    tracker.applyCanonicalEvent('conv-1', 'claude', stopped);

    now = 200;
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'].lastInputAt = now;
    });
    tracker.markInputSubmitted(
      'conv-1',
      { hooks: { kind: 'config', scope: 'global', supportedEvents: ['start', 'stop'] } },
      '\r'
    );
    // Input alone cannot freshen the provider's old completion signal.
    expect(tracker.current('conv-1')?.updatedAt).toBe(100);

    now = 300;
    tracker.applyCanonicalEvent('conv-1', 'claude', stopped);
    expect(tracker.current('conv-1')).toMatchObject({
      status: 'completed',
      source: 'hook',
      updatedAt: 300,
    });
    expect(onAgentStateChanged).toHaveBeenLastCalledWith(
      'conv-1',
      expect.objectContaining({ updatedAt: 300 })
    );
  });

  it('does not freshen restored hook evidence', () => {
    const { tracker } = createTracker();
    tracker.restore({
      conversationId: 'conv-1',
      providerId: 'claude',
      status: 'completed',
      source: 'hook',
      updatedAt: 1,
    });
    expect(tracker.current('conv-1')?.updatedAt).toBe(1);
  });

  it('keeps Enter→working when start hooks are declared but not active', () => {
    const { tracker, agentStates } = createTracker();
    const provider = {
      hooks: {
        kind: 'config' as const,
        scope: 'global' as const,
        supportedEvents: ['start' as const],
      },
    };

    tracker.markInputSubmitted('conv-1', provider, '\r', false);
    expect(peek(agentStates.states.list)['conv-1']).toMatchObject({
      status: 'working',
      source: 'input',
    });

    tracker.markInitialPromptSubmitted('conv-2', 'cursor', provider, 'hello', false);
    expect(peek(agentStates.states.list)['conv-2']).toMatchObject({
      status: 'working',
      source: 'input',
      providerId: 'cursor',
    });
  });

  it('publishes valid provider session ids through the sessions model', () => {
    const { tracker, sessions, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'amp',
        sessionId: null,
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'amp', {
      kind: 'session',
      providerSessionId: 'T-123',
    });

    expect(peek(sessions.states.list)['conv-1']?.sessionId).toBe('T-123');
    expect(onSessionIdChanged).toHaveBeenCalledWith('conv-1', 'T-123');
  });

  it('adopts a provider session id carried on a status event', () => {
    const { tracker, sessions, agentStates, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'claude',
        sessionId: 'conv-1',
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'start',
      providerSessionId: 'resumed-session',
    });

    expect(peek(sessions.states.list)['conv-1']?.sessionId).toBe('resumed-session');
    expect(onSessionIdChanged).toHaveBeenCalledWith('conv-1', 'resumed-session');
    expect(peek(agentStates.states.list)['conv-1']?.status).toBe('working');
  });

  it('does not re-publish an unchanged session id carried on status events', () => {
    const { tracker, sessions, onSessionIdChanged } = createTracker();
    produceCell(sessions.states.list, (draft) => {
      draft['conv-1'] = {
        conversationId: 'conv-1',
        providerId: 'claude',
        sessionId: 'conv-1',
        status: 'running',
        cols: 120,
        rows: 30,
        resume: null,
        startedAt: 1,
      };
    });

    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'start',
      providerSessionId: 'conv-1',
    });
    tracker.applyCanonicalEvent('conv-1', 'claude', {
      kind: 'status',
      type: 'stop',
      providerSessionId: 'conv-1',
    });

    expect(onSessionIdChanged).not.toHaveBeenCalled();
  });

  it('does not restore input-inferred working status across session resume', () => {
    const { tracker, agentStates } = createTracker();

    tracker.restore({
      conversationId: 'conv-1',
      providerId: 'cursor',
      status: 'working',
      source: 'input',
      updatedAt: 1,
    });
    expect(peek(agentStates.states.list)['conv-1']?.status).toBe('idle');

    tracker.restore({
      conversationId: 'conv-2',
      providerId: 'cursor',
      status: 'working',
      source: 'hook',
      updatedAt: 1,
    });
    expect(peek(agentStates.states.list)['conv-2']?.status).toBe('working');
  });
});

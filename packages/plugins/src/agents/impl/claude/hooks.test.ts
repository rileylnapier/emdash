import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { makeStdinHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { CLAUDE_SETTINGS_PATH } from './hooks';
import { provider } from './index';

const RESUMED_SESSION_ID = 'b637979b-a4b6-43b5-90c2-a2fbe61321d8';

function createMemoryFs(files = new Map<string, string>()): PluginFs {
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => {
      files.set(path, content);
    },
    delete: async (path) => {
      files.delete(path);
    },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

describe('claude hooks', () => {
  const parse = provider.behavior.hooks!.parseHookEvent!;

  it('carries the session id on start events so an in-session /resume is tracked', () => {
    expect(
      parse('start', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue with the plan',
      })
    ).toEqual({
      kind: 'status',
      type: 'start',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('carries the session id on stop events', () => {
    expect(parse('stop', { session_id: RESUMED_SESSION_ID, hook_event_name: 'Stop' })).toEqual({
      kind: 'status',
      type: 'stop',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('recognizes an older Claude idle reminder and adds the session id', () => {
    expect(
      parse('notification', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'Notification',
        message: 'Claude is waiting for your input',
      })
    ).toEqual({
      kind: 'status',
      type: 'stop',
      message: 'Claude is waiting for your input',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it('treats an explicit idle reminder as completion regardless of its wording', () => {
    expect(
      parse('notification', {
        notification_type: 'idle_prompt',
        message: 'Waiting for another message',
        session_id: RESUMED_SESSION_ID,
      })
    ).toMatchObject({
      kind: 'status',
      type: 'stop',
      providerSessionId: RESUMED_SESSION_ID,
    });
  });

  it.each(['permission_prompt', 'elicitation_dialog', 'auth_success'])(
    'honors the explicit %s type over legacy idle wording',
    (notificationType) => {
      expect(
        parse('notification', {
          notification_type: notificationType,
          message: 'Claude is waiting for your input',
        })
      ).toMatchObject({ kind: 'status', type: 'notification', notificationType });
    }
  );

  it('still recognizes legacy permission messages', () => {
    expect(parse('notification', { message: 'Claude needs your approval' })).toMatchObject({
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
    });
  });

  it.each([
    {},
    { message: 'Please answer a question' },
    { notification_type: 'future_prompt', message: 'Claude is waiting for your input' },
    { notificationType: 'future_prompt', message: 'Claude is waiting for your input' },
    { notification_type: null, message: 'Claude is waiting for your input' },
  ])('does not mistake an unknown notification for completion: %j', (body) => {
    expect(parse('notification', body)).toMatchObject({
      kind: 'status',
      type: 'notification',
      notificationType: undefined,
    });
  });

  it('omits the session id when the payload has none', () => {
    const event = parse('stop', { hook_event_name: 'Stop' });
    expect(event).toEqual({ kind: 'status', type: 'stop' });
    expect(event).not.toHaveProperty('providerSessionId');
  });

  it('maps SessionStart payloads to a session event', () => {
    expect(
      parse('session-start', {
        session_id: RESUMED_SESSION_ID,
        hook_event_name: 'SessionStart',
        source: 'resume',
      })
    ).toEqual({ kind: 'session', providerSessionId: RESUMED_SESSION_ID });
  });

  it('resumes the tracked provider session id instead of the conversation id', () => {
    const command = provider.behavior.prompt!.buildCommand({
      cli: 'claude',
      autoApprove: false,
      initialPrompt: undefined,
      sessionId: 'conversation-1',
      providerSessionId: RESUMED_SESSION_ID,
      isResuming: true,
      model: '',
    });

    expect(command.args).toEqual(['--resume', RESUMED_SESSION_ID]);
  });

  it('declares session as a supported hook event', () => {
    expect(provider.capabilities.hooks).toEqual({
      kind: 'config',
      scope: 'global',
      supportedEvents: ['start', 'notification', 'stop', 'session'],
    });
  });

  it('installs a SessionStart hook that reports the Claude session id', async () => {
    const files = new Map<string, string>();
    const fs = createMemoryFs(files);

    await provider.behavior.hooks!.writeHooks(fs, []);

    const settings = JSON.parse(files.get(CLAUDE_SETTINGS_PATH)!);
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: makeStdinHookCommand('session-start') }] },
    ]);
  });
});

import type { CanonicalHookEvent } from '@emdash/core/services/agent-plugins/api/plugins';
import {
  buildNestedJsonHookConfig,
  configRoots,
  defaultHookEventParser,
  envConfigRoot,
  extractProviderSessionId,
  makeStdinHookCommand,
} from '@emdash/core/services/agent-plugins/api/plugins/helpers';

export const CLAUDE_SETTINGS_PATH = 'settings.json';

/**
 * Honor Claude's notification_type. Older versions omitted it: recognize their
 * permission and idle messages, but never guess that an unknown dialog is idle.
 *
 * Every Claude hook payload includes `session_id`, and it changes when the user
 * switches sessions inside the TUI (`/resume`). Status events carry it so the
 * runtime resumes the session Claude is actually in, not the one it launched with.
 */
function parseClaudeHookEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  const event =
    eventType === 'notification'
      ? parseClaudeNotification(body)
      : defaultHookEventParser(eventType, body);
  if (event.kind !== 'status') return event;
  const providerSessionId = extractProviderSessionId(body);
  const notification =
    event.type === 'notification' &&
    (event.notificationType === 'idle_prompt' || event.notificationType === 'auth_success')
      ? { ...event, informational: true }
      : event;
  return providerSessionId ? { ...notification, providerSessionId } : notification;
}

function parseClaudeNotification(body: Record<string, unknown>): CanonicalHookEvent {
  const event = defaultHookEventParser('notification', body);
  if (event.kind !== 'status') return event;
  // A newer, unknown explicit type must stay unknown rather than being guessed
  // from prose that happens to mention waiting or completion.
  if (body.notification_type != null || body.notificationType != null) return event;
  const message = typeof body.message === 'string' ? body.message : '';
  const notificationType = /permission|approval/i.test(message)
    ? ('permission_prompt' as const)
    : /^Claude(?: Code)? is waiting for your input[.!]?$/i.test(message.trim())
      ? ('idle_prompt' as const)
      : undefined;
  return {
    ...event,
    notificationType,
  };
}

export function buildClaudeHookConfig() {
  return {
    ...buildNestedJsonHookConfig(CLAUDE_SETTINGS_PATH, [
      { hookKey: 'SessionStart', command: makeStdinHookCommand('session-start') },
      { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
      { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
      { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
    ]),
    resolveConfigRoots: configRoots(envConfigRoot('CLAUDE_CONFIG_DIR', '.claude')),
    parseHookEvent: parseClaudeHookEvent,
  };
}

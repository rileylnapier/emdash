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
  return providerSessionId ? { ...event, providerSessionId } : event;
}

function parseClaudeNotification(body: Record<string, unknown>): CanonicalHookEvent {
  const message = typeof body.message === 'string' ? body.message : '';
  // Current Claude supplies notification_type. Keep the narrow text fallback
  // for older versions, but never use it to reinterpret a new/unknown type.
  const legacyType = /permission|approval/i.test(message)
    ? 'permission_prompt'
    : /^Claude is waiting for your input\.?$/i.test(message.trim())
      ? 'idle_prompt'
      : undefined;
  const payload =
    Object.hasOwn(body, 'notification_type') || Object.hasOwn(body, 'notificationType')
      ? body
      : { ...body, notification_type: legacyType };
  const event = defaultHookEventParser('notification', payload);
  if (event.kind !== 'status' || event.notificationType !== 'idle_prompt') return event;

  // Claude emits this reminder after finishing a turn, while waiting for the
  // next message. It confirms completion, not a permission or elicitation request.
  // Use the same state as Stop so a reminder does not reopen attention or emit
  // a second completion notification for an already completed turn.
  return defaultHookEventParser('stop', body);
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

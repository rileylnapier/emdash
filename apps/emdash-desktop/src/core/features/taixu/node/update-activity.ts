import { formatHostRef, type HostRef } from '@emdash/core/primitives/host/api';
import type { TuiAgentState, TuiSessionState } from '@emdash/core/runtimes/tui-agents/api';
import type { RuntimeBroker } from '@emdash/core/services/runtime-broker/api';

// Run under the update hold, and again before commit. A living process is not
// necessarily working: use live provider state, never cached conversation status.
export async function assertUpdateActivityIdle(
  runtimes: Pick<RuntimeBroker, 'client'>,
  hosts: readonly HostRef[]
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        hosts.map(async (host) => {
          const result = await runtimes.client(host);
          if (!result.success) throw new Error('Reconnect all project computers before updating.');
          const [records, terminals, acp, tui, agents] = await Promise.all([
            result.data.workspaceRegistry.records.state(undefined, 'list').snapshot(),
            result.data.terminals.sessions.state(undefined, 'list').snapshot(),
            result.data.acp.sessions.state(undefined, 'list').snapshot(),
            result.data.tuiAgents.sessions.state(undefined, 'list').snapshot(),
            result.data.tuiAgents.agentStates.state(undefined, 'list').snapshot(),
          ]);
          for (const { runtime } of Object.values(records.data)) {
            if (
              runtime?.creation ||
              runtime?.activation?.phase === 'preparing' ||
              Object.values(runtime?.activation?.scripts ?? {}).some(
                (status) => status === 'running' || status === 'pending'
              ) ||
              runtime?.lifecycle?.some((step) => step.status === 'running')
            )
              throw new Error(
                'Wait for workspace setup and running scripts to finish before updating Taixu.'
              );
          }
          if (Object.values(terminals.data).some((session) => session.status === 'running'))
            throw new Error(
              `Close active terminals on ${formatHostRef(host)} before updating Taixu.`
            );
          for (const session of Object.values(acp.data)) {
            if (
              !['ready', 'closed'].includes(session.lifecycle) ||
              session.isGenerating ||
              session.pendingPermissionCount ||
              session.queuedPromptCount ||
              session.backgroundAgentCount
            )
              throw new Error(
                `Finish or stop ${sessionLabel(session)} on ${formatHostRef(host)} before updating Taixu. It has active or pending work.`
              );
          }
          for (const session of Object.values(tui.data)) {
            if (session.status === 'exited') continue;
            if (!isConfirmedIdle(session, agents.data[session.conversationId]))
              throw new Error(
                `Open ${sessionLabel(session)} on ${formatHostRef(host)} and finish or stop its agent before updating Taixu. It is busy, has input to resolve, or has not confirmed it is idle.`
              );
          }
        })
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Could not check workspace activity. Reconnect before updating.')),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isConfirmedIdle(session: TuiSessionState, agent: TuiAgentState | undefined) {
  return (
    session.status === 'running' &&
    agent?.conversationId === session.conversationId &&
    agent.source === 'hook' &&
    ['idle', 'completed'].includes(agent.status) &&
    !agent.notificationType &&
    agent.updatedAt >= session.startedAt &&
    // Any input after the provider signal may be a new turn or an unsent draft.
    agent.updatedAt > (session.lastInputAt ?? 0)
  );
}

function sessionLabel(session: {
  conversationId: string;
  providerId?: string;
  title?: string | null;
  cwd?: string;
}) {
  const name =
    session.title || session.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || session.conversationId;
  return `${session.providerId ?? 'Agent'} · ${name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 100)}`;
}

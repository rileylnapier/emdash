import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginFs } from '@emdash/core/services/agent-plugins/api/plugins';
import { makeNotificationHookCommand } from '@emdash/core/services/agent-plugins/api/plugins/helpers';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { CODEX_CONFIG_PATH, CODEX_LEGACY_HOOKS_PATH, buildCodexHookConfig } from './hooks';

function createMemoryFs(initial: Record<string, string> = {}): PluginFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));

  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

describe('buildCodexHookConfig', () => {
  it.each([
    ['stop', { last_assistant_message: 'Built it.\nTests pass.' }],
    [
      'notification',
      { notification_type: 'idle_prompt', lastAssistantMessage: 'Built it.\nTests pass.' },
    ],
    [
      'notification',
      { type: 'agent-turn-complete', 'last-assistant-message': 'Built it.\nTests pass.' },
    ],
  ])('preserves the final reply from %s', (eventType, body) => {
    expect(buildCodexHookConfig().parseHookEvent(eventType, body)).toMatchObject({
      kind: 'status',
      type: 'stop',
      lastAssistantMessage: 'Built it.\nTests pass.',
    });
  });

  it('keeps status-only completions honest and permission notifications separate', () => {
    const hooks = buildCodexHookConfig();
    for (const value of [undefined, null, 42, { text: 'not a reply' }]) {
      expect(hooks.parseHookEvent('stop', { last_assistant_message: value })).toMatchObject({
        kind: 'status',
        type: 'stop',
        lastAssistantMessage: undefined,
      });
    }
    expect(
      hooks.parseHookEvent('notification', { notification_type: 'idle_prompt' })
    ).toMatchObject({ kind: 'status', type: 'stop', lastAssistantMessage: undefined });
    expect(
      hooks.parseHookEvent('notification', { notification_type: 'permission_prompt' })
    ).toEqual({ kind: 'status', type: 'notification', notificationType: 'permission_prompt' });
  });

  it('replaces the old fixed-body Stop hook while preserving user hooks and settings', async () => {
    const hooks = buildCodexHookConfig();
    const fs = createMemoryFs();
    await hooks.writeHooks(fs, []);
    const installed = await fs.read(CODEX_CONFIG_PATH);
    const config = parseToml(installed!) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    const currentCommand = config.hooks.Stop[0]!.hooks[0]!.command;
    // Construct the previous installed shape, retaining all other managed hooks.
    const oldCommand = makeNotificationHookCommand('idle_prompt');
    const stale = installed!.replace(JSON.stringify(currentCommand), JSON.stringify(oldCommand));
    expect(stale).not.toBe(installed);
    await fs.write(
      CODEX_CONFIG_PATH,
      stale + '\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "echo user-stop" }]\n'
    );
    expect(await hooks.getHooksInstalled(fs)).toBe(false);
    await hooks.writeHooks(fs, []);
    expect(await hooks.getHooksInstalled(fs)).toBe(true);
    expect(await fs.read(CODEX_CONFIG_PATH)).toContain('echo user-stop');
    expect(await fs.read(CODEX_CONFIG_PATH)).not.toContain(JSON.stringify(oldCommand));
  });

  it.skipIf(process.platform === 'win32')(
    'forwards a native Stop body intact and emits JSON even when delivery fails',
    async () => {
      const fs = createMemoryFs();
      const hooks = buildCodexHookConfig();
      await hooks.writeHooks(fs, []);
      const config = parseToml((await fs.read(CODEX_CONFIG_PATH))!) as {
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = config.hooks.Stop[0]!.hooks[0]!.command;
      const dir = await mkdtemp(path.join(tmpdir(), 'codex-stop-'));
      try {
        const capture = path.join(dir, 'payload.json');
        const body = {
          session_id: 'session-1',
          turn_id: 'turn-1',
          hook_event_name: 'Stop',
          last_assistant_message:
            'Built it.\n\n[PR](https://example.com/pr/1) — $HOME `literal` "quoted" 🐢',
        };
        for (const code of [0, 7]) {
          const result = spawnSync(
            '/bin/sh',
            [
              '-c',
              `curl() { cat > "$CAPTURE_FILE"; printf 'server response'; return ${code}; }; ${command}`,
            ],
            {
              encoding: 'utf8',
              input: JSON.stringify(body),
              env: {
                PATH: process.env.PATH ?? '',
                CAPTURE_FILE: capture,
                EMDASH_HOOK_PORT: '1234',
                EMDASH_HOOK_NONCE: 'nonce',
                EMDASH_PTY_ID: 'pty-1',
              },
            }
          );
          expect(result.status).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({});
          const delivered = JSON.parse(await readFile(capture, 'utf8'));
          expect(delivered).toEqual(body);
          expect(hooks.parseHookEvent('stop', delivered)).toMatchObject({
            kind: 'status',
            type: 'stop',
            lastAssistantMessage: body.last_assistant_message,
          });
        }
        const unrelated = spawnSync(
          '/bin/sh',
          ['-c', `curl() { printf 'must not send'; }; ${command}`],
          { encoding: 'utf8', input: '{}', env: { PATH: process.env.PATH ?? '' } }
        );
        expect(unrelated.status).toBe(0);
        expect(JSON.parse(unrelated.stdout)).toEqual({});
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('writes Codex hooks to config.toml and removes legacy hooks.json', async () => {
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: 'model = "gpt-5"\n',
      [CODEX_LEGACY_HOOKS_PATH]: JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook',
                  },
                ],
              },
              {
                hooks: [{ type: 'command', command: 'echo user-stop' }],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [{ type: 'command', command: 'echo user-prompt' }],
              },
            ],
          },
        },
        null,
        2
      ),
    });
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).resolves.toEqual([CODEX_CONFIG_PATH]);

    await expect(fs.exists(CODEX_LEGACY_HOOKS_PATH)).resolves.toBe(false);
    const config = await fs.read(CODEX_CONFIG_PATH);
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('echo user-stop');
    expect(config).toContain('echo user-prompt');
    expect(config).toContain('notification_type');
    expect(config).toContain('session-start');
  });

  it('keeps legacy hooks.json when writing config.toml fails', async () => {
    const legacyHooks = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo user-stop' }],
          },
        ],
      },
    });
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: 'model = "gpt-5"\n',
      [CODEX_LEGACY_HOOKS_PATH]: legacyHooks,
    });
    const write = fs.write.bind(fs);
    fs.write = async (path, content) => {
      if (path === CODEX_CONFIG_PATH) {
        throw new Error('permission denied');
      }
      await write(path, content);
    };
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).rejects.toThrow('permission denied');

    await expect(fs.read(CODEX_LEGACY_HOOKS_PATH)).resolves.toBe(legacyHooks);
  });

  it('preserves Codex hook trust state while installing and deleting Emdash hooks', async () => {
    const trustKey = '/home/user/.codex/config.toml:stop:0:0';
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[hooks.state."${trustKey}"]
enabled = true
trusted_hash = "sha256:trusted"
`,
    });
    const hooks = buildCodexHookConfig();

    await expect(hooks.writeHooks(fs, [])).resolves.toEqual([CODEX_CONFIG_PATH]);
    await expect(hooks.getHooksInstalled(fs)).resolves.toBe(true);

    const installed = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
      hooks: {
        state: Record<string, { enabled?: boolean; trusted_hash?: string }>;
      };
    };
    expect(installed.hooks.state[trustKey]).toEqual({
      enabled: true,
      trusted_hash: 'sha256:trusted',
    });

    await hooks.deleteHooks(fs);

    const deleted = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
      hooks: {
        state: Record<string, { enabled?: boolean; trusted_hash?: string }>;
      };
    };
    expect(deleted.hooks.state[trustKey]).toEqual({
      enabled: true,
      trusted_hash: 'sha256:trusted',
    });
    expect(await hooks.getHooksInstalled(fs)).toBe(false);
  });

  it('still validates Codex event hooks after separating trust state', async () => {
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[hooks.state."config.toml:stop:0:0"]
enabled = true

[hooks.Stop]
invalid = true
`,
    });

    await expect(buildCodexHookConfig().getHooksInstalled(fs)).rejects.toThrow(
      'expected "hooks.Stop" to be an array of objects'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'pipes the Codex session argument through to the hook request body',
    async () => {
      const fs = createMemoryFs();
      const hooks = buildCodexHookConfig();
      await hooks.writeHooks(fs, []);

      const config = parseToml((await fs.read(CODEX_CONFIG_PATH)) ?? '') as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
      };
      const command = config.hooks.SessionStart[0]?.hooks[0]?.command;
      expect(command).toBeDefined();

      const payload = '{"session_id":"session-1"}';
      const result = spawnSync(
        '/bin/sh',
        ['-c', `curl() { cat; }; ${command}`, 'codex-hook', payload],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '',
            EMDASH_HOOK_PORT: '1234',
            EMDASH_HOOK_NONCE: 'nonce',
            EMDASH_PTY_ID: 'pty-1',
          },
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(payload);
    }
  );

  it('deletes Emdash hooks from both current and legacy Codex hook config', async () => {
    const emdashHook = {
      hooks: [
        {
          type: 'command',
          command: 'curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook',
        },
      ],
    };
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user-stop' }],
    };
    const fs = createMemoryFs({
      [CODEX_CONFIG_PATH]: `[[hooks.Stop]]
hooks = [{ type = "command", command = "curl http://127.0.0.1:$EMDASH_HOOK_PORT/hook" }]

[[hooks.Stop]]
hooks = [{ type = "command", command = "echo user-toml" }]
`,
      [CODEX_LEGACY_HOOKS_PATH]: JSON.stringify({
        hooks: {
          Stop: [emdashHook, userHook],
        },
      }),
    });
    const hooks = buildCodexHookConfig();

    await hooks.deleteHooks(fs);

    const config = await fs.read(CODEX_CONFIG_PATH);
    expect(config).not.toContain('EMDASH_HOOK_PORT');
    expect(config).toContain('echo user-toml');
    const legacy = await fs.read(CODEX_LEGACY_HOOKS_PATH);
    expect(legacy).toContain('echo user-stop');
    expect(legacy).not.toContain('EMDASH_HOOK_PORT');
  });
});

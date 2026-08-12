import { describe, expect, test } from 'vitest';

import type { FleetTelemetryProjection } from '../../core/src/fleetTelemetry.js';
import { buildFleetSceneModel, type FleetSceneInput } from '../src/fleet/model.js';
import {
  readDefaultScenePreference,
  readPersistedScenePreference,
  readScenePreference,
  SCENE_DEFAULT_STORAGE_KEY,
  SCENE_PREFERENCE_VERSION,
  SCENE_PREFERENCE_VERSION_KEY,
  SCENE_STORAGE_KEY,
  writeDefaultScenePreference,
  writeScenePreference,
} from '../src/fleet/scene.js';

function input(overrides: Partial<FleetSceneInput> = {}): FleetSceneInput {
  return {
    agents: [1],
    selectedAgent: 1,
    agentTools: {},
    agentStatuses: {},
    agentFolders: {},
    characters: {},
    ...overrides,
  };
}

describe('Fleet Command scene model', () => {
  test('uses the minimal control center as the product default and rejects unknown preferences', () => {
    expect(readScenePreference(null)).toBe('control-center');
    expect(readScenePreference('unknown')).toBe('control-center');
    expect(readScenePreference('pixel-office')).toBe('pixel-office');
  });

  test('persists and reads the separate default frontend preference', () => {
    const values = new Map<string, string>();
    writeDefaultScenePreference(
      {
        setItem(key, value) {
          values.set(key, value);
        },
      },
      'fleet-command',
    );
    expect(values.get(SCENE_DEFAULT_STORAGE_KEY)).toBe('fleet-command');
    expect(readDefaultScenePreference({ getItem: (key) => values.get(key) ?? null })).toBe(
      'fleet-command',
    );
  });

  test('persists only the explicit Scene selection under the Claude Fleet key', () => {
    const values = new Map<string, string>();
    writeScenePreference(
      {
        setItem(key, value) {
          values.set(key, value);
        },
      },
      'pixel-office',
    );
    expect(values.get(SCENE_STORAGE_KEY)).toBe('pixel-office');
  });

  test('migrates a legacy persisted scene to the control center once', () => {
    const values = new Map<string, string>([[SCENE_STORAGE_KEY, 'pixel-office']]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readPersistedScenePreference(storage)).toBe('control-center');
    expect(values.get(SCENE_PREFERENCE_VERSION_KEY)).toBe(SCENE_PREFERENCE_VERSION);
    expect(values.get(SCENE_STORAGE_KEY)).toBe('control-center');
    expect(values.get(SCENE_DEFAULT_STORAGE_KEY)).toBe('control-center');
  });

  test('keeps an explicit current-version Pixel Office selection', () => {
    const values = new Map<string, string>([
      [SCENE_STORAGE_KEY, 'pixel-office'],
      [SCENE_PREFERENCE_VERSION_KEY, SCENE_PREFERENCE_VERSION],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readPersistedScenePreference(storage)).toBe('pixel-office');
  });

  test('classifies real team metadata into the requested vessel roles', () => {
    const model = buildFleetSceneModel(
      input({
        agents: [1, 2, 3, 4],
        characters: {
          1: { isTeamLead: true },
          2: { agentName: 'reviewer' },
          3: { agentName: 'debugger' },
          4: { isSubagent: true, parentAgentId: 1 },
        },
      }),
    );
    expect(model.agents.map((agent) => [agent.role, agent.vesselLabel])).toEqual([
      ['coordinator', 'Flagship'],
      ['reviewer', 'Recon Vessel'],
      ['debugger', 'Debug Vessel'],
      ['subagent', 'Drone'],
    ]);
  });

  test('uses normalized telemetry for status and metadata without inventing missing fields', () => {
    const telemetry: FleetTelemetryProjection = {
      snapshots: [
        {
          instanceId: 'agent-1',
          agentId: 1,
          runtime: 'claude-code',
          repo: 'fleet-repo',
          cwd: 'F:/work/fleet-repo',
          providerDisplayName: 'Anthropic',
          modelId: 'claude-sonnet',
          displayName: 'astrid',
          sessionId: 'session-1',
          status: 'working',
          currentTool: 'Read',
          recentEvents: [
            {
              eventId: 'event-1',
              eventType: 'tool_started',
              observedAt: 100,
              source: 'agent-state',
            },
          ],
        },
      ],
      recentEvents: [],
    };
    const agent = buildFleetSceneModel(input({ telemetry })).agents[0];
    expect(agent).toMatchObject({
      status: 'Working',
      repo: 'fleet-repo',
      cwd: 'F:/work/fleet-repo',
      currentTool: 'Read',
      provider: 'Anthropic',
      model: 'claude-sonnet',
      displayName: 'astrid',
      session: 'session-1',
    });
    expect(agent.currentTask).toBe('—');
    expect(agent.context).toBe('—');
    expect(agent.recentEvents[0]?.label).toBe('tool started');
  });

  test('projects live usage counters and connection state into the control model', () => {
    const agent = buildFleetSceneModel(
      input({
        agentStatuses: { 1: 'working' },
        characters: {
          1: {
            usageTokens: {
              inputTokens: 120,
              cachedInputTokens: 30,
              outputTokens: 45,
              totalTokens: 195,
            },
          },
        },
        telemetry: {
          snapshots: [
            {
              instanceId: 'agent-1',
              agentId: 1,
              runtime: 'claude-code',
              terminalId: 'terminal-1',
              status: 'working',
              recentEvents: [],
            },
          ],
          recentEvents: [],
        },
      }),
    ).agents[0];
    expect(agent).toMatchObject({
      usage: '195',
      inputTokens: '120',
      cachedTokens: '30',
      outputTokens: '45',
      connection: 'connected',
    });
  });

  test('groups vessels by real Repo and reports live status counts', () => {
    const model = buildFleetSceneModel(
      input({
        agents: [1, 2, 3],
        agentStatuses: { 1: 'working', 2: 'waiting', 3: 'idle' },
        agentFolders: {
          1: { name: 'repo-a', path: '/work/repo-a' },
          2: { name: 'repo-a', path: '/work/repo-a' },
          3: { name: 'repo-b', path: '/work/repo-b' },
        },
      }),
    );
    expect(model.groups.map((group) => [group.repo, group.agents.length])).toEqual([
      ['repo-a', 2],
      ['repo-b', 1],
    ]);
    expect(model.workingCount).toBe(1);
    expect(model.waitingCount).toBe(1);
  });

  test('keeps absolute cwd for details but shows only the repo basename in the scene', () => {
    const model = buildFleetSceneModel(
      input({
        agentFolders: {
          1: { name: 'C:/Users/test/AppData/Local/Temp/workspace', path: 'C:/workspace' },
        },
      }),
    );
    expect(model.agents[0]).toMatchObject({
      repo: 'workspace',
      cwd: 'C:/workspace',
    });
  });

  test('click behavior focuses a Subagent through its real parent terminal', () => {
    const model = buildFleetSceneModel(
      input({
        agents: [7],
        characters: { 7: { isSubagent: true, parentAgentId: 3 } },
      }),
    );
    expect(model.agents[0]?.focusAgentId).toBe(3);
    expect(model.agents[0]?.commandAgentId).toBe(3);
  });

  test('supports an empty roster without creating a fake vessel', () => {
    const model = buildFleetSceneModel(input({ agents: [], selectedAgent: null }));
    expect(model.agents).toEqual([]);
    expect(model.groups).toEqual([]);
    expect(model.selectedAgent).toBeNull();
  });

  test('projects distinct attention states instead of collapsing them into Waiting', () => {
    const model = buildFleetSceneModel(
      input({
        agents: [1, 2, 3, 4, 5, 6],
        agentStatuses: { 1: 'waiting', 2: 'waiting', 3: 'error', 4: 'idle', 5: 'stopped' },
        agentTools: {
          1: [{ toolId: 'permission', status: 'shell', done: false, permissionWait: true }],
        },
        characters: {
          2: { waitingAwaitingInput: true },
          4: { completionUnread: true },
        },
        telemetry: {
          snapshots: [
            {
              instanceId: 'agent-5',
              agentId: 5,
              runtime: 'claude-code',
              terminalId: 'terminal-5',
              status: 'stopped',
              recentEvents: [],
            },
          ],
          recentEvents: [],
        },
      }),
    );

    expect(model.agents.map((agent) => agent.attention.kind)).toEqual([
      'needs-permission',
      'needs-input',
      'error',
      'completion-unread',
      'disconnected',
      'none',
    ]);
    expect(model.agents.map((agent) => agent.attention.actionLabel)).toEqual([
      '查看请求',
      '回复',
      '重新启动',
      '查看结果',
      '重新启动',
      '',
    ]);
    expect(model.attentionCount).toBe(5);
  });

  test('marks an untyped waiting state as waiting for interaction', () => {
    const agent = buildFleetSceneModel(input({ agentStatuses: { 1: 'waiting' } })).agents[0];
    expect(agent.attention).toMatchObject({
      kind: 'waiting-unknown',
      label: '等待交互',
      actionLabel: '打开终端',
    });
  });

  test('formats compact usage while preserving the exact total for the inspector', () => {
    const agent = buildFleetSceneModel(
      input({
        characters: { 1: { usageTokens: { totalTokens: 205666 } } },
      }),
    ).agents[0];
    expect(agent.usage).toBe('205,666');
    expect(agent.usageCompact).toBe('205.7k');
  });

  test('treats a live terminal as connected before the first Claude prompt', () => {
    const agent = buildFleetSceneModel(
      input({
        agentStatuses: { 1: 'starting' },
        telemetry: {
          snapshots: [
            {
              instanceId: 'agent-1',
              agentId: 1,
              runtime: 'claude-code',
              terminalId: 'terminal-1',
              terminalName: 'Claude Code #1',
              sessionId: 'session-1',
              status: 'starting',
              recentEvents: [],
            },
          ],
          recentEvents: [],
        },
      }),
    ).agents[0];

    expect(agent.connection).toBe('connected');
    expect(agent.connectionStack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Terminal', state: 'connected' }),
        expect.objectContaining({ label: 'CLI', state: 'connecting' }),
        expect.objectContaining({ label: 'Hook', state: 'connecting' }),
      ]),
    );
  });

  test('shows the same first-input state for a live terminal with no runtime activity', () => {
    const agent = buildFleetSceneModel(
      input({
        agentStatuses: { 1: 'starting' },
        telemetry: {
          snapshots: [
            {
              instanceId: 'agent-1',
              agentId: 1,
              runtime: 'claude-code',
              terminalId: 'terminal-1',
              status: 'starting',
              recentEvents: [
                {
                  eventId: 'started',
                  eventType: 'agent_started',
                  observedAt: 100,
                  source: 'agent-state',
                },
              ],
            },
          ],
          recentEvents: [],
        },
      }),
    ).agents[0];

    expect(agent).toMatchObject({
      awaitingFirstInput: true,
      executionLabel: '等待首条消息',
      attention: {
        kind: 'needs-input',
        label: '等待用户输入',
        detail: '终端已启动，等待首条消息',
        actionLabel: '回复',
      },
    });
  });

  test('projects runtime bootstrap interaction separately from a normal first prompt', () => {
    const agent = buildFleetSceneModel(
      input({
        agentStatuses: { 1: 'starting' },
        telemetry: {
          snapshots: [
            {
              instanceId: 'agent-1',
              agentId: 1,
              runtime: 'claude-code',
              terminalId: 'terminal-1',
              terminalName: 'Claude Code #1',
              status: 'starting',
              bootstrap: {
                state: 'needs_user_interaction',
                reason: 'startup_interaction',
                observedAt: 100,
              },
              recentEvents: [],
            },
          ],
          recentEvents: [],
        },
      }),
    ).agents[0];

    expect(agent).toMatchObject({
      executionLabel: '等待启动确认',
      attention: {
        kind: 'needs-startup-interaction',
        label: '等待启动确认',
        action: 'focus-terminal',
        actionLabel: '聚焦终端',
      },
    });
    expect(agent.connectionStack).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'CLI', state: 'connected', detail: '进程已启动' }),
        expect.objectContaining({ label: 'Hook', state: 'connecting' }),
      ]),
    );
  });
});

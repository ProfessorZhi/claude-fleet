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
});

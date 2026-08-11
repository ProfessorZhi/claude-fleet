/**
 * Spec 003 — tests for the user-facing status normalization layer.
 *
 * Covers every UserFacingStatus, the priority ordering, legacy inputs and the
 * time-injected error heuristics. The order of `normalizeAgentStatus` rules is
 * part of the contract: these tests lock it.
 */

import { describe, expect, it } from 'vitest';

import {
  agentStateToUserStatus,
  agentStateToUserStatusWithError,
  countActiveTools,
  JSONL_ERROR_GRACE_MS,
  normalizeAgentStatus,
} from '../src/agentStatus.js';
import type { AgentState } from '../src/types.js';

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session-1',
    isExternal: false,
    projectDir: '/repo',
    jsonlFile: '/repo/session-1.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 100_000,
    ...overrides,
  };
}

describe('normalizeAgentStatus — priority order', () => {
  it('stopped short-circuits everything', () => {
    expect(normalizeAgentStatus({ stopped: true, error: true, isWaiting: true })).toBe('stopped');
  });

  it('error short-circuits waiting / working signals', () => {
    expect(normalizeAgentStatus({ error: true, isWaiting: true, activeToolCount: 3 })).toBe(
      'error',
    );
  });

  it('waiting beats working (permission request)', () => {
    expect(
      normalizeAgentStatus({ permissionSent: true, activeToolCount: 2, linesProcessed: 10 }),
    ).toBe('waiting');
  });

  it('waiting from isWaiting beats working', () => {
    expect(normalizeAgentStatus({ isWaiting: true, activeToolCount: 1 })).toBe('waiting');
  });

  it('waitingForInput beats working', () => {
    expect(normalizeAgentStatus({ waitingForInput: true, activeToolCount: 1 })).toBe('waiting');
  });

  it('active tools → working', () => {
    expect(normalizeAgentStatus({ activeToolCount: 1, linesProcessed: 42 })).toBe('working');
  });

  it('history without activity → idle', () => {
    expect(normalizeAgentStatus({ linesProcessed: 5 })).toBe('idle');
  });

  it('no data at all → starting', () => {
    expect(normalizeAgentStatus({})).toBe('starting');
  });

  it('hooks delivered but no transcript yet → starting (not working)', () => {
    expect(normalizeAgentStatus({ hookDelivered: true, linesProcessed: 0 })).toBe('starting');
  });
});

describe('normalizeAgentStatus — legacy / defensive inputs', () => {
  it('empty input → starting (never crashes)', () => {
    expect(normalizeAgentStatus({})).toBe('starting');
  });

  it('unknown extra fields are ignored', () => {
    const input = { linesProcessed: 3, whatever: 'x' } as unknown as Parameters<
      typeof normalizeAgentStatus
    >[0];
    expect(normalizeAgentStatus(input)).toBe('idle');
  });

  it('zero counts behave like absent counts', () => {
    expect(normalizeAgentStatus({ activeToolCount: 0, linesProcessed: 0 })).toBe('starting');
    expect(normalizeAgentStatus({ activeToolCount: 0, linesProcessed: 10 })).toBe('idle');
  });
});

describe('agentStateToUserStatus — AgentState projection', () => {
  it('fresh agent → starting', () => {
    expect(agentStateToUserStatus(makeAgent())).toBe('starting');
  });

  it('agent with live tools → working', () => {
    const agent = makeAgent();
    agent.activeToolIds.add('tool-1');
    agent.activeToolStatuses.set('tool-1', 'Bash(bash command)');
    expect(agentStateToUserStatus(agent)).toBe('working');
  });

  it('agent waiting for input → waiting', () => {
    expect(agentStateToUserStatus(makeAgent({ isWaiting: true }))).toBe('waiting');
  });

  it('permission in flight → waiting even with tools', () => {
    const agent = makeAgent({ permissionSent: true });
    agent.activeToolIds.add('tool-1');
    expect(agentStateToUserStatus(agent)).toBe('waiting');
  });

  it('agent with transcript history and no activity → idle', () => {
    expect(agentStateToUserStatus(makeAgent({ linesProcessed: 100 }))).toBe('idle');
  });

  it('countActiveTools counts only live tools', () => {
    const agent = makeAgent();
    agent.activeToolIds.add('a');
    agent.activeToolIds.add('b');
    expect(countActiveTools(agent)).toBe(2);
    agent.activeToolIds.delete('a');
    expect(countActiveTools(agent)).toBe(1);
  });
});

describe('agentStateToUserStatusWithError — time-injected heuristics', () => {
  const NOW = 1_000_000;

  it('transcript delivered data but file vanished → error', () => {
    const agent = makeAgent({ linesProcessed: 50, createdAt: NOW - 1_000 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - 1_000,
        now: NOW,
      }),
    ).toBe('error');
  });

  it('no transcript within grace period → error (launch failure)', () => {
    const agent = makeAgent({ createdAt: NOW - JSONL_ERROR_GRACE_MS - 1 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - JSONL_ERROR_GRACE_MS - 1,
        now: NOW,
      }),
    ).toBe('error');
  });

  it('live terminal with no transcript remains starting after grace period', () => {
    const agent = makeAgent({
      createdAt: NOW - JSONL_ERROR_GRACE_MS - 1,
      terminalRef: { exitStatus: undefined } as never,
    });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - JSONL_ERROR_GRACE_MS - 1,
        now: NOW,
      }),
    ).toBe('starting');
  });

  it('exited terminal with no transcript still reports launch error', () => {
    const agent = makeAgent({
      createdAt: NOW - JSONL_ERROR_GRACE_MS - 1,
      terminalRef: { exitStatus: { code: 1, reason: 1 } } as never,
    });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - JSONL_ERROR_GRACE_MS - 1,
        now: NOW,
      }),
    ).toBe('error');
  });

  it('within grace period with no transcript → starting (not yet error)', () => {
    const agent = makeAgent({ createdAt: NOW - 1_000 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - 1_000,
        now: NOW,
      }),
    ).toBe('starting');
  });

  it('no createdAt (restored agent) never triggers the timeout rule', () => {
    const agent = makeAgent();
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: undefined,
        now: NOW,
      }),
    ).toBe('starting');
  });

  it('hooksOnly agent with no JSONL never errors on timeout', () => {
    const agent = makeAgent({ hooksOnly: true, createdAt: NOW - JSONL_ERROR_GRACE_MS - 10 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - JSONL_ERROR_GRACE_MS - 10,
        now: NOW,
      }),
    ).toBe('starting');
  });

  it('external agent with no JSONL never errors on timeout', () => {
    const agent = makeAgent({ isExternal: true, createdAt: NOW - JSONL_ERROR_GRACE_MS - 10 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: false,
        createdAt: NOW - JSONL_ERROR_GRACE_MS - 10,
        now: NOW,
      }),
    ).toBe('starting');
  });

  it('healthy agent with live JSONL → normal projection', () => {
    const agent = makeAgent({ linesProcessed: 5, createdAt: NOW - 1_000 });
    expect(
      agentStateToUserStatusWithError(agent, {
        jsonlExists: true,
        createdAt: NOW - 1_000,
        now: NOW,
      }),
    ).toBe('idle');
  });
});

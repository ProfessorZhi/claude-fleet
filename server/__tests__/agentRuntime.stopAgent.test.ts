/**
 * Spec 004 — stopAgent isolation tests.
 *
 * Proves the core Stop contract:
 *   - the agent's Terminal is REALLY disposed (process closed);
 *   - runtime state (watchers / timers / store / JSONL dismissal) is cleaned;
 *   - stopping A never touches B;
 *   - repeated stop is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: undefined,
    isExternal: false,
    projectDir: `/repo-${id}`,
    jsonlFile: `/repo-${id}/${id}.jsonl`,
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
  } as AgentState;
}

function fakeTerminal(name: string) {
  return { name, dispose: vi.fn() };
}

function fakeWatcher() {
  return { close: vi.fn() };
}

describe('AgentRuntime.stopAgent — Spec 004', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
  });

  afterEach(() => {
    runtime.dispose();
  });

  it('disposes the terminal, cleans runtime state, and removes the agent', () => {
    const terminalA = fakeTerminal('Claude Code #1');
    const watcherA = fakeWatcher();
    const agentA = createTestAgent(1, { terminalRef: terminalA as never });
    store.set(1, agentA);
    runtime.fileWatchers.set(1, watcherA as never);
    runtime.pollingTimers.set(
      1,
      setInterval(() => {}, 60_000),
    );
    runtime.jsonlPollTimers.set(
      1,
      setInterval(() => {}, 60_000),
    );

    runtime.stopAgent(1);

    expect(terminalA.dispose).toHaveBeenCalledTimes(1);
    expect(watcherA.close).toHaveBeenCalledTimes(1);
    expect(runtime.fileWatchers.has(1)).toBe(false);
    expect(runtime.pollingTimers.has(1)).toBe(false);
    expect(runtime.jsonlPollTimers.has(1)).toBe(false);
    expect(store.get(1)).toBeUndefined();
    // JSONL dismissed so the external scanner won't re-adopt the file
    expect(runtime.dismissalTracker.isDismissed(agentA.jsonlFile)).toBe(true);
  });

  it('stopping A does NOT affect B', () => {
    const terminalA = fakeTerminal('Claude Code #1');
    const terminalB = fakeTerminal('Claude Code #2');
    const watcherA = fakeWatcher();
    const watcherB = fakeWatcher();
    store.set(1, createTestAgent(1, { terminalRef: terminalA as never }));
    store.set(2, createTestAgent(2, { terminalRef: terminalB as never }));
    runtime.fileWatchers.set(1, watcherA as never);
    runtime.fileWatchers.set(2, watcherB as never);
    runtime.pollingTimers.set(
      2,
      setInterval(() => {}, 60_000),
    );

    runtime.stopAgent(1);

    // A is gone
    expect(store.get(1)).toBeUndefined();
    expect(terminalA.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.fileWatchers.has(1)).toBe(false);
    // B untouched
    expect(store.get(2)).toBeDefined();
    expect(terminalB.dispose).not.toHaveBeenCalled();
    expect(runtime.fileWatchers.get(2)).toBe(watcherB);
    expect(runtime.pollingTimers.has(2)).toBe(true);
    expect(runtime.dismissalTracker.isDismissed(store.get(2)!.jsonlFile)).toBe(false);
  });

  it('stop is idempotent (onDidCloseTerminal replay is a no-op)', () => {
    const terminalA = fakeTerminal('Claude Code #1');
    store.set(1, createTestAgent(1, { terminalRef: terminalA as never }));

    runtime.stopAgent(1);
    runtime.stopAgent(1);

    expect(terminalA.dispose).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it('stop without a terminal (external agent) still cleans up state', () => {
    const agentA = createTestAgent(1, { isExternal: true, terminalRef: undefined });
    store.set(1, agentA);
    runtime.jsonlPollTimers.set(
      1,
      setInterval(() => {}, 60_000),
    );

    runtime.stopAgent(1);

    expect(store.get(1)).toBeUndefined();
    expect(runtime.jsonlPollTimers.has(1)).toBe(false);
    expect(runtime.dismissalTracker.isDismissed(agentA.jsonlFile)).toBe(true);
  });

  it('stopAgent on unknown id is a safe no-op', () => {
    expect(() => runtime.stopAgent(999)).not.toThrow();
    expect(store.size).toBe(0);
  });
});

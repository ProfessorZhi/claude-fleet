import { describe, expect, it } from 'vitest';

import type { TokenUsage, UsageRecord } from '../../core/src/ledgerContracts.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../src/constants.js';
import { extractContextTokens, updateContextUsage } from '../src/contextUsage.js';
import { FleetLedgerStore } from '../src/fleetLedgerStore.js';
import type { AgentState } from '../src/types.js';

function createAgent(): AgentState {
  return {
    id: 1,
    sessionId: 'session-1',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  } as AgentState;
}

function assistantRecord(
  input: number,
  cacheCreation: number,
  cacheRead: number,
  output: number,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  };
}

function usageRecord(tokens: TokenUsage, usageId = 'usage-1'): UsageRecord {
  return {
    usageId,
    instanceId: 'agent-1',
    sessionId: 'session-1',
    capturedAt: 1_000,
    tokens,
    source: 'runtime',
    availability: 'available',
    confidence: 'exact',
    estimateOrActual: 'actual',
  };
}

describe('token usage contract', () => {
  it('keeps cached input as a retained detail without double-counting it in total', () => {
    const tokens: TokenUsage = {
      inputTokens: 1_000,
      cachedInputTokens: 640,
      outputTokens: 120,
      totalTokens: 1_120,
    };

    expect(tokens.cachedInputTokens).toBe(640);
    expect(tokens.totalTokens).toBe(tokens.inputTokens! + tokens.outputTokens!);
    expect(tokens.totalTokens).not.toBe(
      tokens.inputTokens! + tokens.cachedInputTokens! + tokens.outputTokens!,
    );
  });

  it('preserves all token fields when a usage record is stored', () => {
    const tokens: TokenUsage = {
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 30,
      totalTokens: 130,
    };
    const store = new FleetLedgerStore();

    store.recordUsage(usageRecord(tokens));

    expect(store.listUsage()[0].tokens).toEqual(tokens);
  });
});

describe('context usage snapshot contract', () => {
  it('retains cache creation and cache read tokens in the context snapshot', () => {
    expect(extractContextTokens(assistantRecord(20, 300, 4_000, 80))).toBe(4_400);
  });

  it('does not accumulate repeated snapshots or incremental turns', () => {
    const agents = new AgentStateStore();
    const agent = createAgent();
    agents.set(agent.id, agent);

    updateContextUsage(1, agent, agents, assistantRecord(20, 300, 4_000, 80));
    updateContextUsage(1, agent, agents, assistantRecord(20, 300, 4_000, 80));
    expect(agent.contextTokens).toBe(4_400);

    updateContextUsage(1, agent, agents, assistantRecord(10, 0, 600, 40));
    expect(agent.contextTokens).toBe(650);
  });
});

describe('usage ledger idempotency', () => {
  it('replaces a repeated usage snapshot with the same usage id', () => {
    const store = new FleetLedgerStore();

    store.recordUsage(usageRecord({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }));
    store.recordUsage(
      usageRecord(
        { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, totalTokens: 120 },
        'usage-1',
      ),
    );

    expect(store.listUsage()).toHaveLength(1);
    expect(store.listUsage()[0].tokens).toEqual({
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      totalTokens: 120,
    });
  });
});

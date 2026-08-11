/**
 * agentStatus — Spec 003 user-facing status normalization.
 *
 * Maps the scattered internal AgentState signals (isWaiting / permissionSent /
 * hookDelivered / linesProcessed / active tools) into a small set of
 * user-readable statuses:
 *
 *   starting | working | waiting | idle | error | stopped
 *
 * All functions here are PURE: no vscode, no fs, no time (the caller injects
 * `now` when time matters). The only caller that needs time is the VS Code
 * adapter's `requestDiagnostics` poll path, which computes the error signal
 * via `agentStateToUserStatusWithError`.
 *
 * See:
 *   docs/specs/003-instance-status/design.md § 状态映射
 */

import type { AgentState } from './types.js';

export type UserFacingStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'error' | 'stopped';

export interface AgentStatusInput {
  /** Hook-driven wait (Stop hook fired / awaiting user input). */
  isWaiting?: boolean;
  /** Permission request currently in flight. */
  permissionSent?: boolean;
  /** Hook Stop event carried awaitingInput=true (user must type). */
  waitingForInput?: boolean;
  /** Hooks have delivered at least one event for this agent (sticky). */
  hookDelivered?: boolean;
  /** Agent has no transcript (hooks-only provider). */
  hooksOnly?: boolean;
  /** Number of JSONL lines processed; 0 = no transcript data yet. */
  linesProcessed?: number;
  /** Number of currently active (non-done) tools. */
  activeToolCount?: number;
  /** Explicit error signal from the caller (vanished transcript, launch timeout). */
  error?: boolean;
  /** Explicit stopped signal. */
  stopped?: boolean;
}

/**
 * Priority-ordered mapping (first match wins). The order is part of the
 * contract — it is locked by tests in server/__tests__/agentStatus.test.ts.
 *
 * 1. stopped / error are terminal signals and short-circuit everything.
 * 2. waiting beats working: a permission request or awaiting-input state is
 *    what the user must react to.
 * 3. active tools prove the agent is doing something right now.
 * 4. any transcript history (even if quiet) means the agent started
 *    successfully → idle.
 * 5. hooks alive but no transcript yet → still starting.
 * 6. anything else (including all-empty input) → starting.
 */
export function normalizeAgentStatus(input: AgentStatusInput): UserFacingStatus {
  if (input.stopped) return 'stopped';
  if (input.error) return 'error';
  if (input.isWaiting || input.permissionSent || input.waitingForInput) return 'waiting';
  if (input.activeToolCount !== undefined && input.activeToolCount > 0) return 'working';
  if (input.linesProcessed !== undefined && input.linesProcessed > 0) return 'idle';
  if (input.hookDelivered && !input.hooksOnly) return 'starting';
  return 'starting';
}

/**
 * Count of live tools: transcriptParser / hookEventHandler / timerManager
 * DELETE tool entries on completion, so `activeToolIds` only ever holds tools
 * that are still running (status map has the same lifecycle).
 */
export function countActiveTools(agent: AgentState): number {
  return agent.activeToolIds.size;
}

/**
 * Derive the user-facing status from the AgentState fields alone (no fs /
 * time). Use this on the poll path when you have no error signal; otherwise
 * prefer `agentStateToUserStatusWithError`.
 */
export function agentStateToUserStatus(agent: AgentState): UserFacingStatus {
  return normalizeAgentStatus({
    isWaiting: agent.isWaiting,
    permissionSent: agent.permissionSent,
    hookDelivered: agent.hookDelivered,
    hooksOnly: agent.hooksOnly,
    linesProcessed: agent.linesProcessed,
    activeToolCount: countActiveTools(agent),
  });
}

/**
 * Error-aware variant used by the VS Code adapter's `requestDiagnostics` poll
 * path — the only place with access to fs (jsonlExists) and time.
 *
 * Error rules (see design.md § error 判定):
 * - the transcript delivered data before (`linesProcessed > 0`) but the file
 *   is now gone → error;
 * - a terminal-launched (non-external, non-hooksOnly) agent never produced a
 *   transcript and `now - createdAt > JSONL_ERROR_GRACE_MS`, after its
 *   terminal has exited → error (launch failure). A live terminal is still
 *   waiting for its first user input, so it remains starting. Without
 *   `createdAt` (restored agents) this rule is skipped.
 */
export const JSONL_ERROR_GRACE_MS = 30_000;

export function agentStateToUserStatusWithError(
  agent: AgentState,
  opts: { jsonlExists: boolean; createdAt: number | undefined; now: number },
): UserFacingStatus {
  const terminalAlive =
    agent.terminalRef !== undefined && agent.terminalRef.exitStatus === undefined;
  if (agent.linesProcessed > 0 && !opts.jsonlExists) {
    return normalizeAgentStatus({ error: true });
  }
  if (
    !agent.isExternal &&
    !agent.hooksOnly &&
    !opts.jsonlExists &&
    opts.createdAt !== undefined &&
    opts.now - opts.createdAt > JSONL_ERROR_GRACE_MS &&
    !terminalAlive
  ) {
    return normalizeAgentStatus({ error: true });
  }
  return agentStateToUserStatus(agent);
}

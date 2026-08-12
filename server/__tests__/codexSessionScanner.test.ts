import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findManagedCodexAgentCandidate,
  scanCodexSessions,
} from '../src/providers/codex/codexSessionScanner.js';

describe('Codex session scanner', () => {
  it('discovers a recent Codex session from session_meta without exposing transcript content', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '09');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-test.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: '2026-08-09T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            session_id: 'codex-session-1',
            cwd: 'F:/funny_project/Agent Fleet',
            model_provider: 'openai',
            cli_version: '0.147.0-alpha.6.5',
            context_window: 400000,
          },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.6-luna', context_window: 400000 },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 120,
                cached_input_tokens: 30,
                output_tokens: 45,
                total_tokens: 195,
              },
              model_context_window: 400000,
            },
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'turn_completed', duration_ms: 1250 },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const sessions = scanCodexSessions({
      homeDir: home,
      workspaceRoots: ['F:/funny_project/Agent Fleet'],
      maxAgeMs: Number.POSITIVE_INFINITY,
      now: () => Date.now(),
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'codex-session-1',
      cwd: 'F:/funny_project/Agent Fleet',
      modelId: 'gpt-5.6-luna',
      providerId: 'openai',
      cliVersion: '0.147.0-alpha.6.5',
      contextWindow: 400000,
      status: 'working',
      tokens: { inputTokens: 120, cachedInputTokens: 30, outputTokens: 45, totalTokens: 195 },
      durationMs: 1250,
    });
    expect(JSON.stringify(sessions[0])).not.toContain('transcript');
  });

  it('filters sessions from other workspaces and ignores stale files', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '09');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'rollout-other.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'other', cwd: 'F:/other-repo', model_provider: 'openai' },
      }) + '\n',
    );

    expect(
      scanCodexSessions({
        homeDir: home,
        workspaceRoots: ['F:/funny_project/Agent Fleet'],
        maxAgeMs: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([]);
  });

  it('does not project Codex Desktop sessions as Worker Agents', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '09');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'rollout-desktop.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: 'desktop-thread-1',
          cwd: 'F:/funny_project/Agent Fleet',
          originator: 'Codex Desktop',
          source: 'vscode',
        },
      }) + '\n',
    );

    expect(
      scanCodexSessions({
        homeDir: home,
        workspaceRoots: ['F:/funny_project/Agent Fleet'],
        maxAgeMs: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([]);
  });

  it('keeps a session_meta-only session in starting until the first turn exists', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '09');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'rollout-first-input.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'first-input', cwd: 'F:/funny_project/Agent Fleet' },
      }) + '\n',
    );

    const sessions = scanCodexSessions({
      homeDir: home,
      workspaceRoots: ['F:/funny_project/Agent Fleet'],
      maxAgeMs: Number.POSITIVE_INFINITY,
    });

    expect(sessions[0]?.status).toBe('starting');
  });

  it('does not resurrect a session whose projection was dismissed', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'claude-fleet-codex-'));
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '09');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-dismissed.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: 'dismissed', cwd: 'F:/funny_project/Agent Fleet' },
      }) + '\n',
    );

    expect(
      scanCodexSessions({
        homeDir: home,
        workspaceRoots: ['F:/funny_project/Agent Fleet'],
        maxAgeMs: Number.POSITIVE_INFINITY,
        isDismissed: (filePath) => filePath === file,
      }),
    ).toEqual([]);
  });

  it('adopts the native Codex session for a nearby Fleet-managed terminal', () => {
    expect(
      findManagedCodexAgentCandidate(
        [
          {
            instanceId: 'agent-2',
            runtime: 'codex-cli',
            managedByFleet: true,
            isExternal: false,
            cwd: 'F:/funny_project/Agent Fleet',
            createdAt: 10_000,
            sessionId: 'fleet-placeholder',
            jsonlFile: 'F:/funny_project/Agent Fleet/.claude-fleet/codex/fleet-placeholder.jsonl',
          },
          {
            instanceId: 'agent-3',
            runtime: 'codex-cli',
            managedByFleet: false,
            isExternal: true,
            cwd: 'F:/funny_project/Agent Fleet',
            createdAt: 10_100,
            jsonlFile: 'F:/codex/external.jsonl',
          },
        ],
        {
          cwd: 'F:/funny_project/Agent Fleet',
          sessionId: 'native-codex-session',
          lastActivityAt: 10_900,
        },
      ),
    ).toBe('agent-2');
    expect(
      findManagedCodexAgentCandidate(
        [
          {
            instanceId: 'agent-2',
            runtime: 'codex-cli',
            managedByFleet: true,
            isExternal: false,
            cwd: 'F:/other-repo',
            createdAt: 10_000,
            jsonlFile: 'F:/other-repo/.claude-fleet/codex/native.jsonl',
          },
        ],
        { cwd: 'F:/funny_project/Agent Fleet', sessionId: 'native', lastActivityAt: 10_900 },
      ),
    ).toBeUndefined();
  });

  it('keeps a later session on the sole live managed terminal', () => {
    expect(
      findManagedCodexAgentCandidate(
        [
          {
            instanceId: 'agent-7',
            runtime: 'codex-cli',
            managedByFleet: true,
            isExternal: false,
            terminalAttached: true,
            cwd: 'F:/funny_project/Agent Fleet',
            createdAt: 10_000,
            jsonlFile: 'F:/funny_project/Agent Fleet/.claude-fleet/codex/old.jsonl',
          },
        ],
        {
          cwd: 'F:/funny_project/Agent Fleet',
          sessionId: 'later-session',
          lastActivityAt: 60 * 60 * 1_000,
        },
      ),
    ).toBe('agent-7');
  });
});

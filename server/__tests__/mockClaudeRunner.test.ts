import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MOCK_CLAUDE_RUNNER = path.join(__dirname, '../../e2e/fixtures/mock-claude-runner.cjs');

let tmpBase: string;
let tmpHome: string;
let workspaceDir: string;

function makeNodeCommand(scriptPath: string): string {
  // Mirror the product's settings.json hook command exactly
  // (claudeHookInstaller.ts makeHookCommand): bare `node` + quoted path.
  // JSON.stringify-ing the path here would double-escape Windows backslashes
  // (the settings.json serialization already adds one escape level), breaking
  // the runner's path match. The runner prepends the running node's dir to
  // PATH (see runHookCommand), so bare `node` resolves on every platform.
  return `node "${scriptPath}"`;
}

function writeHookScript(scriptPath: string, outputPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      'let input = "";',
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      `process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(outputPath)}, input));`,
    ].join('\n'),
  );
}

function writeScenarioQueue(homeDir: string, queue: unknown[]): void {
  const queuePath = path.join(homeDir, '.claude-mock', 'scenario-queue.json');
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function writeSettings(
  homeDir: string,
  hooks: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
  >,
): void {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
}

function runMockClaude(
  sessionId = 'test-session',
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // The runner resolves its state dir via os.homedir(), which on Windows
    // reads USERPROFILE (HOME is ignored) — pin it like the e2e harness does
    // (applyMockHomeEnv in e2e/helpers/mock-claude.ts) or the runner falls
    // back to the real user profile and the scenario queue is never found.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmpHome };
    if (process.platform === 'win32') {
      env.USERPROFILE = tmpHome;
      delete env.HOMEDRIVE;
      delete env.HOMEPATH;
    }
    const child = spawn(process.execPath, [MOCK_CLAUDE_RUNNER, '--session-id', sessionId], {
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('mock-claude-runner hook execution', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-mock-runner-'));
    tmpHome = path.join(tmpBase, 'home');
    workspaceDir = path.join(tmpBase, 'workspace');

    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // macOS /var → /private/var symlink: the runner sees the resolved cwd via
    // process.cwd(), so its project hash and our expected paths must use the
    // same realpath. Without this, fs.existsSync below sometimes returns false
    // on the symlinked path even though the file exists on the resolved path.
    tmpHome = fs.realpathSync.native(tmpHome);
    workspaceDir = fs.realpathSync.native(workspaceDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('executes only Claude Fleet hooks from ~/.claude/settings.json', async () => {
    const pixelOutput = path.join(tmpBase, 'pixel-hook.json');
    const thirdPartyOutput = path.join(tmpBase, 'third-party-hook.json');
    // Spec 006 state-dir migration: the product installs its hook at
    // ~/.claude-fleet/hooks/claude-hook.js (see claudeHookInstaller.ts).
    const pixelHookPath = path.join(tmpHome, '.claude-fleet', 'hooks', 'claude-hook.js');
    const thirdPartyHookPath = path.join(tmpHome, '.claude', 'third-party-hook.js');

    writeHookScript(pixelHookPath, pixelOutput);
    writeHookScript(thirdPartyHookPath, thirdPartyOutput);
    writeSettings(tmpHome, {
      Notification: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: makeNodeCommand(thirdPartyHookPath),
            },
            {
              type: 'command',
              command: makeNodeCommand(pixelHookPath),
            },
          ],
        },
      ],
    });
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'emitHook',
            atMs: 0,
            payload: {
              session_id: 'test-session',
              hook_event_name: 'Notification',
              notification_type: 'idle_prompt',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude();

    expect(code, stderr).toBe(0);
    expect(fs.existsSync(pixelOutput)).toBe(true);
    expect(fs.existsSync(thirdPartyOutput)).toBe(false);
    expect(JSON.parse(fs.readFileSync(pixelOutput, 'utf8'))).toMatchObject({
      session_id: 'test-session',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
  });

  it('writes configured sidecar metadata next to custom transcript paths', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [
          {
            alias: 'teammate',
            sessionIdTemplate: 'agent-web-researcher',
            transcriptPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.jsonl',
            sidecarPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.meta.json',
            sidecarJson: {
              agentType: 'web-researcher',
            },
          },
        ],
        actions: [
          {
            kind: 'appendJsonl',
            atMs: 0,
            session: 'teammate',
            record: {
              type: 'system',
              teamName: 'research',
              agentName: 'web-researcher',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);

    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'lead-session',
      'subagents',
      'agent-web-researcher.jsonl',
    );
    const sidecarPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');

    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))).toEqual({
      agentType: 'web-researcher',
    });
  });

  it('writes timed JSON files with template paths', async () => {
    const configPath = path.join(tmpHome, '.claude', 'teams', 'research', 'config.json');

    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'writeJson',
            atMs: 0,
            filePath: configPath,
            value: {
              members: [{ name: 'lead' }],
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      members: [{ name: 'lead' }],
    });
  });

  it('deletes configured paths with template values', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: true,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'deletePath',
            atMs: 0,
            filePath: '{{transcriptPath}}',
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('delete-session');

    expect(code, stderr).toBe(0);
    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'delete-session.jsonl',
    );
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});

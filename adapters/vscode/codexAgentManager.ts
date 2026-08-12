import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { FleetRuntime } from '../../core/src/runtimeContracts.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../server/src/constants.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import type { AgentState } from '../../server/src/types.js';
import { detectShellKind, renderLaunchCommand } from './launchCommandRender.js';

export interface CodexTerminalLaunchOptions {
  cwd: string;
  command: string;
  displayName?: string;
  args?: string[];
  modelId?: string;
  sessionMode?: 'new' | 'resume';
  sessionId?: string;
  suppressShow?: boolean;
  launchSource?: string;
  requestedBy?: string;
  /** External Fleet control-plane instance id, when launched by the coordinator. */
  fleetInstanceId?: string;
}

/**
 * Launch a managed Codex Worker in an isolated VS Code terminal.
 *
 * This function deliberately does not accept a secret or environment object.
 * Codex authentication remains owned by the user's local Codex installation.
 */
export function launchCodexTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  activeAgentIdRef: { current: number | null },
  store: AgentStateStore,
  persistAgents: () => void,
  options: CodexTerminalLaunchOptions,
): AgentState {
  const cwd =
    options.cwd.trim() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  if (!cwd) throw new Error('Codex launch requires a workspace cwd.');
  if (!options.command.trim()) throw new Error('Codex launch requires a CLI command.');

  const sessionMode = options.sessionMode ?? 'new';
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const terminalIndex = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `Codex CLI #${terminalIndex}`,
    cwd,
  });
  if (!options.suppressShow) terminal.show();
  terminal.sendText(
    renderLaunchCommand(options.command, options.args ?? [], {
      platform: process.platform,
      shellKind: detectShellKind(vscode.env.shell, process.platform),
    }),
  );

  const id = nextAgentIdRef.current++;
  const now = Date.now();
  const agent: AgentState = {
    id,
    sessionId,
    runtime: 'codex-cli' satisfies FleetRuntime,
    terminalRef: terminal,
    isExternal: false,
    projectDir: cwd,
    cwd,
    hostId: 'codex-cli-host',
    workspaceId: cwd,
    terminalId: `terminal-agent-${id}`,
    fleetInstanceId: options.fleetInstanceId,
    launchSource: options.launchSource ?? (sessionMode === 'resume' ? 'resume' : 'fleet-ui'),
    requestedBy: options.requestedBy ?? 'user',
    displayName: options.displayName,
    // Codex does not currently emit Claude JSONL. Keep a deterministic,
    // non-existent path so the shared lifecycle can dismiss it without
    // making the Office projection depend on a transcript.
    jsonlFile: path.join(cwd, '.claude-fleet', 'codex', `${sessionId}.jsonl`),
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
    lastDataAt: now,
    // Do not synthesize transcript history here. A newly launched Codex CLI is
    // waiting for its first user message, not idle after a completed turn.
    // The native session scanner advances this once real session data appears.
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    hooksOnly: true,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    providerId: 'codex-cli',
    providerDisplayName: 'Codex CLI · 本机登录',
    modelId: options.modelId,
    createdAt: now,
    managedByFleet: true,
  };

  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  return agent;
}

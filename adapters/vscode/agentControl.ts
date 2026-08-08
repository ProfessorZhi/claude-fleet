/**
 * agentControl — Spec 004 Focus / Stop / Restart commands.
 *
 * Command implementations share one QuickPick helper (`pickAgent`) and one
 * restart-config projection (`restartConfigFromAgent`, pure and unit-tested).
 * The actual lifecycle operations delegate to AgentRuntime (stopAgent /
 * removeAgent) and the provider-owned launcher, so there is exactly ONE
 * cleanup path and ONE launch path.
 */

import * as vscode from 'vscode';

import type { InstanceLaunchConfig } from '../../core/src/providerProfiles.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import type { AgentRuntime } from '../../server/src/agentRuntime.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import type { AgentState } from '../../server/src/types.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';
import {
  CLAUDE_CLI_NOT_FOUND_MESSAGE,
  type CliCheckResult,
  ensureClaudeCliAvailable,
} from './cliCheck.js';

/**
 * Project the launch intent of a running agent for Restart (Spec 004
 * FR-006). Pure — no vscode / fs — unit-tested.
 *
 * `cwd` approximation: AgentState has no original cwd; `projectDir` is the
 * Claude transcript directory, which for a single-workspace launch matches
 * the cwd Claude derives from it. Legacy agents (001-era, no provider/model)
 * fall back to the built-in Inherit profile.
 */
export function restartConfigFromAgent(agent: AgentState): InstanceLaunchConfig {
  return {
    cwd: agent.projectDir,
    providerProfileId: agent.providerProfileId ?? INHERIT_PROVIDER_PROFILE_ID,
    modelId: agent.modelId,
  };
}

/**
 * QuickPick over the current agents. Returns the picked agent id, or
 * undefined if cancelled / nothing to pick. Shows an info message when no
 * agents exist.
 */
export async function pickAgent(store: AgentStateStore): Promise<number | undefined> {
  const ids = [...store.keys()].sort((a, b) => a - b);
  if (ids.length === 0) {
    void vscode.window.showInformationMessage('Claude Fleet: No agents are running.');
    return undefined;
  }
  if (ids.length === 1) {
    return ids[0];
  }
  const picked = await vscode.window.showQuickPick(
    ids.map((id) => {
      const agent = store.get(id);
      const label = `Agent #${id}`;
      const description = agent
        ? [agent.providerDisplayName, agent.modelId].filter(Boolean).join(' · ')
        : undefined;
      return { label, description };
    }),
    { title: 'Claude Fleet: Choose Agent', ignoreFocusOut: true },
  );
  return picked ? parseInt(picked.label.replace('Agent #', ''), 10) : undefined;
}

/** Focus an agent: show its Terminal (a teammate focuses the lead's terminal). */
export function focusAgent(store: AgentStateStore, id: number): void {
  const agent = store.get(id);
  if (!agent) return;
  if (agent.terminalRef) {
    agent.terminalRef.show();
  } else if (agent.leadAgentId !== undefined) {
    const lead = store.get(agent.leadAgentId);
    lead?.terminalRef?.show();
  }
}

/** Run the `focusAgent` command: pick, then focus. */
export async function runFocusAgentCommand(
  store: AgentStateStore,
  picker: () => Promise<number | undefined> = () => pickAgent(store),
): Promise<void> {
  const id = await picker();
  if (id === undefined) return;
  focusAgent(store, id);
}

/** Run the `stopAgent` command: pick, then stop for real (Spec 004 FR-003). */
export async function runStopAgentCommand(
  runtime: AgentRuntime,
  picker: () => Promise<number | undefined> = () => pickAgent(runtime.store),
): Promise<void> {
  const id = await picker();
  if (id === undefined) return;
  runtime.stopAgent(id);
}

/** Dependencies of runRestartAgentCommand (injectable for tests). */
export interface RestartAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  /** Re-launch a stopped agent with the given config (provider-owned wiring). */
  launcher: (options: LaunchNewTerminalOptions) => Promise<void>;
  /** Base options for the launcher (store / secrets), minus launchConfig. */
  baseLaunchOptions: Omit<LaunchNewTerminalOptions, 'launchConfig' | 'suppressShow'>;
  /** CLI availability check; defaults to the real `claude --version` probe. */
  cliCheck?: () => Promise<CliCheckResult>;
  /** Error surfacing; defaults to vscode.window.showErrorMessage. */
  showError?: (message: string) => void;
  picker?: () => Promise<number | undefined>;
}

/**
 * Run the `restartAgent` command (Spec 004 FR-006 ~ FR-008):
 *
 *   pick → project restart config → stop old instance → CLI check →
 *   relaunch with the SAME Repo / Provider / Model (secret re-fetched from
 *   SecretStorage inside the launcher; missing secret fails closed).
 *
 * A fresh Session is created — Restart never resumes the old one.
 */
export async function runRestartAgentCommand(deps: RestartAgentDeps): Promise<void> {
  const { store, runtime } = deps;
  const picker = deps.picker ?? (() => pickAgent(store));
  const cliCheck = deps.cliCheck ?? ensureClaudeCliAvailable;
  const showError = deps.showError ?? ((m: string) => void vscode.window.showErrorMessage(m));

  const id = await picker();
  if (id === undefined) return;

  const agent = store.get(id);
  if (!agent) return;
  const restartConfig = restartConfigFromAgent(agent);

  // Stop the old instance first (closes its terminal / process).
  runtime.stopAgent(id);

  // Re-check the CLI before launching a fresh terminal.
  const cli = await cliCheck();
  if (!cli.ok) {
    showError(CLAUDE_CLI_NOT_FOUND_MESSAGE);
    return;
  }

  await deps.launcher({
    ...deps.baseLaunchOptions,
    launchConfig: restartConfig,
    suppressShow: false,
  });
}

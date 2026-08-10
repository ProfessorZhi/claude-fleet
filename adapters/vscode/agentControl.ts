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

import type { InstanceLaunchConfig, ProviderProfile } from '../../core/src/providerProfiles.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import type { AgentRuntime } from '../../server/src/agentRuntime.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import type { AgentState } from '../../server/src/types.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';
import {
  claudeCliNotFoundMessage,
  type CliCheckResult,
  ensureClaudeCliAvailable,
} from './cliCheck.js';
import type { VscodeFleetRuntimeHost } from './fleetRuntimeHost.js';
import { pickModel } from './launchAgentFlow.js';
import type { ProviderProfileStore } from './providerProfileStore.js';

/**
 * Project the launch intent of a running agent for Restart (Spec 004
 * FR-006 + Spec 005 FR-009/FR-010). Pure — no vscode / fs — unit-tested.
 *
 * `cwd` is the exact repo the user picked at launch (AgentState.cwd,
 * persisted via PersistedAgent.cwd). `projectDir` is the Claude transcript
 * directory derived from cwd and is NOT guaranteed to equal it — using it as
 * cwd would restart the agent in the wrong directory. The projectDir
 * fallback applies ONLY to legacy agents persisted before `cwd` existed
 * (001-era) and scan-discovered agents that never went through a launch.
 * Legacy agents (no provider/model) also fall back to the built-in Inherit
 * profile.
 *
 * Spec 005 Session Continuity: Restart RESUMES the SAME Claude native
 * session (`sessionMode: 'resume'`, `sessionId` preserved) instead of
 * creating a fresh one. `sessionId` exists on every agent (launched ones
 * carry the generated UUID; discovered ones derive it from the jsonl
 * basename), so the projection is always well-defined.
 */
export function restartConfigFromAgent(agent: AgentState): InstanceLaunchConfig {
  return {
    // New agents always carry the original launch cwd; legacy fallback only.
    cwd: agent.cwd ?? agent.projectDir,
    providerProfileId: agent.providerProfileId ?? INHERIT_PROVIDER_PROFILE_ID,
    modelId: agent.modelId,
    displayName: agent.displayName,
    // Resume the same Claude native conversation on Restart.
    sessionId: agent.sessionId,
    sessionMode: 'resume',
  };
}

/**
 * Project the launch intent for "New Session" (Spec 005 FR-010): SAME
 * Repo / Provider / Model, but a FRESH conversation (new sessionId).
 */
export function newSessionConfigFromAgent(agent: AgentState): InstanceLaunchConfig {
  return {
    cwd: agent.cwd ?? agent.projectDir,
    providerProfileId: agent.providerProfileId ?? INHERIT_PROVIDER_PROFILE_ID,
    modelId: agent.modelId,
    displayName: agent.displayName,
    // sessionMode defaults to 'new'; no sessionId → fresh UUID at launch.
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
export function focusAgent(
  store: AgentStateStore,
  id: number,
  runtimeHost?: VscodeFleetRuntimeHost,
): void {
  const agent = store.get(id);
  if (!agent) return;
  if (runtimeHost && !agent.isExternal) {
    void runtimeHost.focus(`agent-${id}`);
    return;
  }
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
  runtimeHost?: VscodeFleetRuntimeHost,
): Promise<void> {
  const id = await picker();
  if (id === undefined) return;
  focusAgent(store, id, runtimeHost);
}

/** Run the `stopAgent` command: pick, then stop for real (Spec 004 FR-003). */
export async function runStopAgentCommand(
  runtime: AgentRuntime,
  picker: () => Promise<number | undefined> = () => pickAgent(runtime.store),
  runtimeHost?: VscodeFleetRuntimeHost,
): Promise<void> {
  const id = await picker();
  if (id === undefined) return;
  const agent = runtime.store.get(id);
  if (runtimeHost && agent && !agent.isExternal) {
    await runtimeHost.stop(`agent-${id}`);
  } else {
    runtime.stopAgent(id);
  }
}

/** Dependencies of runRestartAgentCommand (injectable for tests). */
export interface RestartAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  /** Re-launch a stopped agent with the given config (provider-owned wiring). */
  launcher: (options: LaunchNewTerminalOptions) => Promise<void>;
  /** Base options for the launcher (store / secrets), minus launchConfig. */
  baseLaunchOptions: Omit<LaunchNewTerminalOptions, 'launchConfig' | 'suppressShow'>;
  /** Optional host boundary; legacy tests and callers use runtime fallback. */
  runtimeHost?: VscodeFleetRuntimeHost;
  /** CLI availability check; defaults to the real `claude --version` probe. */
  cliCheck?: () => Promise<CliCheckResult>;
  /** Error surfacing; defaults to vscode.window.showErrorMessage. */
  showError?: (message: string) => void;
  picker?: () => Promise<number | undefined>;
}

async function stopAgentThroughHostOrRuntime(
  deps: Pick<RestartAgentDeps, 'runtime' | 'runtimeHost'>,
  id: number,
): Promise<void> {
  const agent = deps.runtime.store.get(id);
  if (deps.runtimeHost && agent && !agent.isExternal) {
    await deps.runtimeHost.stop(`agent-${id}`);
    return;
  }
  deps.runtime.stopAgent(id);
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
  const { store } = deps;
  const picker = deps.picker ?? (() => pickAgent(store));
  const cliCheck = deps.cliCheck ?? ensureClaudeCliAvailable;
  const showError = deps.showError ?? ((m: string) => void vscode.window.showErrorMessage(m));

  const id = await picker();
  if (id === undefined) return;

  const agent = store.get(id);
  if (!agent) return;
  const restartConfig = restartConfigFromAgent(agent);

  // Stop the old instance first (closes its terminal / process).
  await stopAgentThroughHostOrRuntime(deps, id);

  // Re-check the CLI before launching a fresh terminal.
  const cli = await cliCheck();
  if (!cli.ok) {
    showError(claudeCliNotFoundMessage(cli.diagnostics));
    return;
  }

  await deps.launcher({
    ...deps.baseLaunchOptions,
    launchConfig: restartConfig,
    suppressShow: false,
    launchSource: 'restart',
    requestedBy: 'user',
  });
}

/**
 * Run the `newSession` command (Spec 005 FR-010): SAME Repo / Provider /
 * Model, but a FRESH Claude session (new sessionId, empty conversation).
 */
export async function runNewSessionCommand(deps: RestartAgentDeps): Promise<void> {
  const { store } = deps;
  const picker = deps.picker ?? (() => pickAgent(store));
  const cliCheck = deps.cliCheck ?? ensureClaudeCliAvailable;
  const showError = deps.showError ?? ((m: string) => void vscode.window.showErrorMessage(m));

  const id = await picker();
  if (id === undefined) return;

  const agent = store.get(id);
  if (!agent) return;
  const config = newSessionConfigFromAgent(agent);

  await stopAgentThroughHostOrRuntime(deps, id);

  const cli = await cliCheck();
  if (!cli.ok) {
    showError(claudeCliNotFoundMessage(cli.diagnostics));
    return;
  }

  await deps.launcher({
    ...deps.baseLaunchOptions,
    launchConfig: config,
    suppressShow: false,
    launchSource: 'new-session',
    requestedBy: 'user',
  });
}

/** Dependencies of runSwitchProviderCommand (extends RestartAgentDeps). */
export interface SwitchProviderDeps extends RestartAgentDeps {
  providerProfileStore: ProviderProfileStore;
}

/**
 * Run the `switchProvider` command (Spec 005 FR-011/FR-012): pick a new
 * configured Provider Profile (+ optional Model), then Stop the current
 * Claude process and relaunch with the SAME cwd + sessionId + native
 * transcript via Claude Code native resume. The conversation is preserved —
 * Fleet NEVER copies chat content into a prompt.
 *
 * If the profile is missing / disabled at resolve time, we fail closed with
 * a clear error (no silent fallback). If Claude Code later refuses the
 * resume, the user is asked explicitly before starting a new session.
 */
export async function runSwitchProviderCommand(deps: SwitchProviderDeps): Promise<void> {
  const { store, providerProfileStore } = deps;
  const picker = deps.picker ?? (() => pickAgent(store));
  const cliCheck = deps.cliCheck ?? ensureClaudeCliAvailable;
  const showError = deps.showError ?? ((m: string) => void vscode.window.showErrorMessage(m));

  const id = await picker();
  if (id === undefined) return;

  const agent = store.get(id);
  if (!agent) return;

  // Only configured + enabled profiles (Spec 005 FR-003).
  const profiles = providerProfileStore.list().filter((p) => p.enabled !== false);
  if (profiles.length === 0) {
    showError(
      'Claude Fleet: No Provider Profiles configured. Add one via Manage Providers before switching.',
    );
    return;
  }
  const provider = await pickProfileForSwitch(profiles, agent);
  if (!provider) return;
  const modelId = await pickModel(provider);
  if (modelId === undefined) return;

  // Remember the previous provider for diagnostics (not a secret).
  if (agent.providerProfileId && agent.providerProfileId !== provider.id) {
    agent.lastProviderProfileId = agent.providerProfileId;
  }

  await stopAgentThroughHostOrRuntime(deps, id);

  const cli = await cliCheck();
  if (!cli.ok) {
    showError(claudeCliNotFoundMessage(cli.diagnostics));
    return;
  }

  // Resume the SAME native session with the NEW provider env.
  await deps.launcher({
    ...deps.baseLaunchOptions,
    launchConfig: {
      cwd: agent.cwd ?? agent.projectDir,
      providerProfileId: provider.id,
      modelId,
      sessionId: agent.sessionId,
      sessionMode: 'resume',
    },
    suppressShow: false,
    launchSource: 'switch-provider',
    requestedBy: 'user',
  });
}

async function pickProfileForSwitch(
  profiles: ProviderProfile[],
  agent: AgentState,
): Promise<ProviderProfile | undefined> {
  const items = profiles.map((p) => ({
    label: p.name,
    description: p.baseUrl ?? p.presetId ?? undefined,
    detail: p.id === agent.providerProfileId ? 'Current provider' : (p.defaultModelId ?? undefined),
    profile: p,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Claude Fleet: Switch Provider',
    ignoreFocusOut: true,
  });
  return picked?.profile;
}

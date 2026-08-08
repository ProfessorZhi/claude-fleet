import * as vscode from 'vscode';

import { FileStateAdapter } from '../../server/src/fileStateAdapter.js';
import { migrateStateDir } from '../../server/src/migrateStateDir.js';
import {
  runFocusAgentCommand,
  runNewSessionCommand,
  runRestartAgentCommand,
  runStopAgentCommand,
  runSwitchProviderCommand,
} from './agentControl.js';
import { ClaudeFleetViewProvider } from './ClaudeFleetViewProvider.js';
import {
  COMMAND_EXPORT_DEFAULT_LAYOUT,
  COMMAND_FOCUS_AGENT,
  COMMAND_MANAGE_PROVIDERS,
  COMMAND_NEW_AGENT,
  COMMAND_NEW_SESSION,
  COMMAND_RESTART_AGENT,
  COMMAND_SHOW_PANEL,
  COMMAND_STOP_AGENT,
  COMMAND_SWITCH_PROVIDER,
  CONFIG_KEY_AUTO_SHOW_PANEL,
  VIEW_ID,
} from './constants.js';
import { runLaunchAgentFlowWithLauncher } from './launchAgentFlow.js';
import { runManageProvidersFlow } from './manageProvidersFlow.js';
import { migrateVsCodeState } from './migrateVsCodeState.js';

let providerInstance: ClaudeFleetViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  // CLAUDE_FLEET_DEBUG 优先；PIXEL_AGENTS_DEBUG 为 legacy fallback（Spec 006）。
  const debugEnv = process.env.CLAUDE_FLEET_DEBUG ?? process.env.PIXEL_AGENTS_DEBUG ?? 'not set';
  console.log(`[Claude Fleet] CLAUDE_FLEET_DEBUG=${debugEnv}`);

  // Spec 006 — migrate Fleet-owned state from ~/.pixel-agents to
  // ~/.claude-fleet (idempotent, failure-safe, legacy dir preserved).
  migrateStateDir();

  // Shared file-backed state adapter (VS Code namespace in ~/.claude-fleet/config.json).
  const adapter = new FileStateAdapter({ namespace: 'vscode' });

  // One-time migration from legacy workspaceState/globalState. Idempotent; runs every
  // activate. Warns until all keys are cleared (e.g. if a disk error blocks writes).
  migrateVsCodeState(context, adapter);

  const provider = new ClaudeFleetViewProvider(context, adapter);
  providerInstance = provider;

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SHOW_PANEL, () => {
      vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_EXPORT_DEFAULT_LAYOUT, () => {
      provider.exportDefaultLayout();
    }),
  );

  // Spec 002 — `+ Agent` Launch Flow. Lets the user pick Repo / Provider /
  // Model before spawning a Claude Code terminal.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_NEW_AGENT, async () => {
      await runLaunchAgentFlowWithLauncher(
        {
          providerProfileStore: provider.providerProfileStore,
          secretStorageProvider: provider.secretStorageProvider,
          baseLaunchOptions: {
            providerProfileStore: provider.providerProfileStore,
            secretStorageProvider: provider.secretStorageProvider,
          },
        },
        async (options) => {
          await provider.launchFromFlow(options);
        },
      );
    }),
  );

  // Spec 004 — Manage Providers (List / Create / Delete).
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_MANAGE_PROVIDERS, async () => {
      await runManageProvidersFlow({
        providerProfileStore: provider.providerProfileStore,
        secretStorageProvider: provider.secretStorageProvider,
        baseLaunchOptions: {
          providerProfileStore: provider.providerProfileStore,
          secretStorageProvider: provider.secretStorageProvider,
        },
      });
    }),
  );

  // Spec 004 — Focus the terminal of a chosen agent.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_FOCUS_AGENT, async () => {
      await runFocusAgentCommand(provider.store);
    }),
  );

  // Spec 004 — Stop a chosen agent for real (terminal + runtime state).
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_STOP_AGENT, async () => {
      await runStopAgentCommand(provider.runtime);
    }),
  );

  // Spec 004 — Restart a chosen agent preserving Repo / Provider / Model.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_RESTART_AGENT, async () => {
      await runRestartAgentCommand({
        store: provider.store,
        runtime: provider.runtime,
        baseLaunchOptions: {
          providerProfileStore: provider.providerProfileStore,
          secretStorageProvider: provider.secretStorageProvider,
        },
        launcher: async (options) => {
          await provider.launchFromFlow(options);
        },
      });
    }),
  );

  // Spec 005 — New Session: same Repo/Provider/Model, fresh conversation.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_NEW_SESSION, async () => {
      await runNewSessionCommand({
        store: provider.store,
        runtime: provider.runtime,
        baseLaunchOptions: {
          providerProfileStore: provider.providerProfileStore,
          secretStorageProvider: provider.secretStorageProvider,
        },
        launcher: async (options) => {
          await provider.launchFromFlow(options);
        },
      });
    }),
  );

  // Spec 005 — Switch Provider: same Session/Repo, new Provider env via
  // Claude Code native resume.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_SWITCH_PROVIDER, async () => {
      await runSwitchProviderCommand({
        store: provider.store,
        runtime: provider.runtime,
        providerProfileStore: provider.providerProfileStore,
        baseLaunchOptions: {
          providerProfileStore: provider.providerProfileStore,
          secretStorageProvider: provider.secretStorageProvider,
        },
        launcher: async (options) => {
          await provider.launchFromFlow(options);
        },
      });
    }),
  );

  // Auto-show panel: focus the Claude Fleet panel on startup if the user has
  // opted in via the claudeFleet.autoShowPanel setting.
  const config = vscode.workspace.getConfiguration();
  if (config.get<boolean>(CONFIG_KEY_AUTO_SHOW_PANEL, false)) {
    vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }
}

export function deactivate() {
  providerInstance?.dispose();
}

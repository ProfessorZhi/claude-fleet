import { randomUUID } from 'node:crypto';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { FleetControlPolicy, FleetLaunchTemplate } from '../../core/src/controlContracts.js';
import {
  type FleetEvent,
  type FleetTelemetrySnapshot,
  FleetTelemetryStore,
  normalizeAgentBroadcast,
} from '../../core/src/fleetTelemetry.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import type {
  FleetInstance,
  FleetRuntimeHost,
  RuntimeBootstrapSnapshot,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
} from '../../core/src/runtimeContracts.js';
import { buildAgentDiagnostics } from '../../server/src/agentDiagnostics.js';
import { AgentRuntime } from '../../server/src/agentRuntime.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import {
  agentStateToUserStatus,
  agentStateToUserStatusWithError,
  type UserFacingStatus,
} from '../../server/src/agentStatus.js';
import type {
  LoadedAssets,
  LoadedCharacterSprites,
  LoadedPetSprites,
} from '../../server/src/assetLoader.js';
import {
  loadCarpetTiles,
  loadDefaultLayout,
  loadFloorTiles,
  loadWallTiles,
  sendAssetsToWebview,
  sendCarpetTilesToWebview,
  sendCharacterSpritesToWebview,
  sendFloorTilesToWebview,
  sendPetSpritesToWebview,
  sendWallTilesToWebview,
} from '../../server/src/assetLoader.js';
import { loadAllCharacters, loadAllFurniture, loadAllPets } from '../../server/src/assetReload.js';
import { readConfig, writeConfig } from '../../server/src/configPersistence.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../../server/src/constants.js';
import { CoordinatorScheduler } from '../../server/src/coordinatorScheduler.js';
import { CoordinatorSession } from '../../server/src/coordinatorSession.js';
import { setFolderNameResolver, setTerminalAdapter } from '../../server/src/fileWatcher.js';
import { FleetControlService } from '../../server/src/fleetControlService.js';
import { FleetLedgerStore } from '../../server/src/fleetLedgerStore.js';
import type { LayoutWatcher } from '../../server/src/layoutPersistence.js';
import {
  readLayoutFromFile,
  watchLayoutFile,
  writeLayoutToFile,
} from '../../server/src/layoutPersistence.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { PathSet } from '../../server/src/pathKey.js';
import { JsonFileFleetSnapshotPersistence } from '../../server/src/persistence/fleetSnapshotPersistence.js';
import { CodexFleetRuntimeHost } from '../../server/src/providers/codex/codexFleetRuntimeHost.js';
import { CodexRuntimeAdapter } from '../../server/src/providers/codex/codexRuntimeAdapter.js';
import {
  type CodexDiscoveredStatus,
  type CodexSessionMetadata,
  findManagedCodexAgentCandidate,
  isCodexDesktopSessionFile,
  scanCodexSessions,
} from '../../server/src/providers/codex/codexSessionScanner.js';
import { getClaudeConfigDir } from '../../server/src/providers/hook/claude/claudeConfigPath.js';
import { findReadyClaudeNativeSession } from '../../server/src/providers/hook/claude/claudeNativeSession.js';
import { claudeProvider, copyHookScript } from '../../server/src/providers/index.js';
import { ClaudeFleetServer } from '../../server/src/server.js';
import type { AgentState } from '../../server/src/types.js';
import { WorkItemResultCorrelator } from '../../server/src/workItemResultCorrelator.js';
import { runRestartAgentCommand, runSwitchProviderCommand } from './agentControl.js';
import type { LaunchNewTerminalOptions } from './agentManager.js';
import {
  getProjectDirPath,
  launchNewTerminal,
  restoreAgents,
  sendCurrentAgentStatuses,
  sendExistingAgents,
  sendLayout,
} from './agentManager.js';
import { ClaudeOwnedRuntime } from './claudeOwnedRuntime.js';
import { ClaudeCodeRuntimeAdapter } from './claudeRuntimeAdapter.js';
import { launchCodexTerminal } from './codexAgentManager.js';
import {
  COMMAND_NEW_AGENT,
  CONFIG_KEY_AUTO_SHOW_PANEL,
  CONFIG_KEY_AUTO_SPAWN_AGENT,
  GLOBAL_KEY_ALWAYS_SHOW_LABELS,
  GLOBAL_KEY_GHOST_HEADLESS_AGENTS,
  GLOBAL_KEY_HOOKS_ENABLED,
  GLOBAL_KEY_HOOKS_INFO_SHOWN,
  GLOBAL_KEY_LAST_SEEN_VERSION,
  GLOBAL_KEY_SHOW_AREAS,
  GLOBAL_KEY_SOUND_ENABLED,
  GLOBAL_KEY_WATCH_ALL_SESSIONS,
  LAYOUT_REVISION_KEY,
} from './constants.js';
import {
  makeClaudeFleetInstance,
  VscodeFleetRuntimeHost,
  type VscodeRuntimeLaunchRequest,
} from './fleetRuntimeHost.js';
import type { CodexLaunchAgentOptions } from './launchAgentFlow.js';
import { OwnedClaudeRuntimeHost } from './ownedClaudeRuntimeHost.js';
import { createProviderProfileStore, type ProviderProfileStore } from './providerProfileStore.js';
import {
  createSecretStorageProvider,
  type SecretStorageProvider,
} from './secretStorageProvider.js';
import { VscodeTerminalAdapter } from './vscodeTerminalAdapter.js';

/** Cap on the pending-broadcast queue. If we exceed this, something has gone
 *  wrong (webviewReady never arriving) — log and drop the oldest. */
const MAX_PENDING_BROADCASTS = 1_000;

function parseAgentInstanceId(instanceId: string): number {
  const match = /^agent-(\d+)$/.exec(instanceId);
  if (!match) throw new Error(`Invalid managed instance id: ${instanceId}`);
  return Number(match[1]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedOwnedText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().slice(0, 500) || undefined;
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => boundedOwnedText(item))
      .filter((item): item is string => Boolean(item))
      .join('');
    return text.slice(0, 500) || undefined;
  }
  const record = value as Record<string, unknown>;
  return boundedOwnedText(record.text ?? record.content ?? record.result ?? record.message);
}

function normalizeOwnedUsage(value: unknown): FleetEvent['usage'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const result: NonNullable<FleetEvent['usage']> = {};
  const read = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
        return candidate;
      }
    }
    return undefined;
  };
  const inputTokens = read(['input_tokens', 'inputTokens']);
  const cachedInputTokens = read([
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cachedInputTokens',
  ]);
  const outputTokens = read(['output_tokens', 'outputTokens']);
  const totalTokens = read(['total_tokens', 'totalTokens']);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  if (result.totalTokens === undefined) {
    const total = (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (outputTokens ?? 0);
    if (total > 0) result.totalTokens = total;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export class ClaudeFleetViewProvider implements vscode.WebviewViewProvider {
  store = new AgentStateStore();
  /** Bounded, normalized telemetry projection shared by future scenes. */
  readonly telemetryStore = new FleetTelemetryStore(50);
  webviewView: vscode.WebviewView | undefined;

  // Webview iframe takes ~hundreds of ms to load the React app and attach
  // message handlers. Broadcasts that fire in this window are otherwise lost
  // (webview.postMessage delivers to a window without an active listener).
  // Buffer them here and flush on `webviewReady`. Without this, on slow CI
  // runners hook events that arrive during iframe init (mock-claude scenarios
  // start writing within ~3 s of agent spawn) silently never reach the UI.
  private isWebviewReady = false;
  private pendingBroadcasts: Array<Record<string, unknown>> = [];

  // Shared agent lifecycle core (timer Maps, scanners, hook handler, dismissal tracker).
  // Public so the Spec 004 control commands (extension.ts) can stop / focus agents.
  runtime: AgentRuntime;
  /** Managed launch boundary; initialized when the webview/terminal context is ready. */
  runtimeHost: VscodeFleetRuntimeHost | undefined;
  private ownedClaudeRuntimeHost: OwnedClaudeRuntimeHost | undefined;
  private readonly ownedClaudeRuntime = new ClaudeOwnedRuntime();
  /** Local management API used by the primary Coordinator through the embedded server. */
  readonly controlService: FleetControlService;
  readonly resultCorrelator: WorkItemResultCorrelator;
  readonly coordinatorSession: CoordinatorSession;
  private readonly claudeRuntimeAdapter = new ClaudeCodeRuntimeAdapter();
  private readonly codexRuntimeAdapter: CodexRuntimeAdapter;
  private readonly codexRuntimeHost: CodexFleetRuntimeHost;

  // Global session scanning dismissal tracking
  private globalDismissedFiles = new Set<string>();

  // Runtime hosts use the numeric AgentState id internally, while the
  // coordinator may assign a stable external Fleet instance id. Keep the
  // reverse lookup in memory for lifecycle calls and restore it from
  // AgentState.fleetInstanceId on the next extension activation.
  private readonly fleetInstanceIds = new Map<number, string>();
  private readonly ownedUiAgentIds = new Map<string, number>();
  private readonly ownedInstanceByUiAgentId = new Map<number, string>();

  // Codex CLI has no Claude-compatible hooks. Its JSONL session files are
  // discovered by a small runtime-specific scanner instead of being sent
  // through the Claude transcript parser.
  private codexDiscoveryTimer: ReturnType<typeof setInterval> | null = null;

  // Bundled default layout (loaded from assets/default-layout.json)
  defaultLayout: Record<string, unknown> | null = null;

  // Root path of bundled assets (set once on first load)
  private assetsRoot: string | null = null;

  // Cross-window layout sync
  layoutWatcher: LayoutWatcher | null = null;

  // Claude Fleet Server (hook event reception)
  private claudeFleetServer: ClaudeFleetServer | null = null;
  private adapter: StateAdapter;

  // Spec 002 — Provider / Model storage + secrets.
  providerProfileStore: ProviderProfileStore;
  secretStorageProvider: SecretStorageProvider;

  /**
   * Spec 002 — Launch Flow entry point. Bound in `resolveWebviewView` to a
   * closure that has access to `this.store` and `this.runtime`. Declared here
   * so callers (extension.ts `claude-fleet.newAgent`) can call it without
   * knowing about the webview lifecycle.
   */
  launchFromFlow: (options: LaunchNewTerminalOptions) => Promise<void> = async () => {
    throw new Error(
      'ClaudeFleetViewProvider.launchFromFlow not yet bound (resolveWebviewView not called).',
    );
  };

  /** New Agent Codex branch: reuse the local Codex login and create a Worker. */
  launchCodexFromFlow: (options: CodexLaunchAgentOptions) => Promise<void> = async (options) => {
    const cwd = options.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    const instanceId = `agent-${this.store.nextAgentId.current}`;
    const now = Date.now();
    await this.codexRuntimeHost.launch({
      cwd,
      sessionMode: 'new',
      launchSource: options.launchSource ?? 'fleet-ui',
      requestedBy: options.requestedBy ?? 'user',
      instance: {
        instanceId,
        runtime: 'codex-cli',
        role: 'worker',
        managedByFleet: true,
        displayName: options.displayName,
        workspaceId: cwd,
        repo: cwd,
        hostId: this.codexRuntimeHost.hostId,
        terminalId: `terminal-${instanceId}`,
        status: 'starting',
        launchSource: options.launchSource ?? 'fleet-ui',
        requestedBy: options.requestedBy ?? 'user',
        createdAt: now,
        lastActivityAt: now,
      },
    });
  };

  checkCodexCli() {
    return this.codexRuntimeAdapter.resolveExecutable();
  }

  // Auto-spawn guard: ensures the startup spawn fires at most once per VS Code
  // session, even though webviewReady fires on every panel focus.
  private autoSpawnAttempted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    adapter: StateAdapter,
  ) {
    this.adapter = adapter;
    this.store.setAdapter(this.adapter);
    const ledgerPath = path.join(this.context.globalStorageUri.fsPath, 'fleet-ledger.json');
    try {
      this.controlService = new FleetControlService({
        ledger: new FleetLedgerStore({
          persistence: new JsonFileFleetSnapshotPersistence(ledgerPath),
        }),
      });
    } catch (error) {
      // A corrupt snapshot must never prevent the extension from opening. Do
      // not overwrite it; keep this session in memory and expose the failure
      // in the Extension Host log for recovery instead.
      console.error('[Claude Fleet] Fleet ledger recovery failed; using memory ledger.', error);
      this.controlService = new FleetControlService();
    }
    this.resultCorrelator = new WorkItemResultCorrelator(this.controlService);
    const coordinatorPolicy: FleetControlPolicy = {
      mode: 'approve',
      maxConcurrentInstances: 8,
    };
    this.coordinatorSession = new CoordinatorSession({
      sessionId: 'codex-primary-session',
      scheduler: new CoordinatorScheduler({
        control: this.controlService,
        requestedBy: 'codex-primary',
        workItems: () => this.controlService.listWorkItems(),
        policy: coordinatorPolicy,
        launchTemplates: this.defaultCoordinatorLaunchTemplates(coordinatorPolicy),
      }),
    });
    this.controlService.registerCoordinatorSession(this.coordinatorSession);
    this.providerProfileStore = createProviderProfileStore(this.context);
    this.secretStorageProvider = createSecretStorageProvider(this.context);
    this.store.on('agentAdded', (id, agent) => {
      this.syncControlInstance(agent);
      const message = {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
        // Spec 002 — Provider / Model metadata. Safe to send to webview
        // (no secrets here).
        providerProfileId: agent.providerProfileId,
        providerDisplayName: agent.providerDisplayName,
        modelId: agent.modelId,
        requestedProviderProfileId: agent.requestedProviderProfileId,
        resolvedProviderProfileId: agent.resolvedProviderProfileId,
        requestedModelId: agent.requestedModelId,
        resolvedModelId: agent.resolvedModelId,
        credential: agent.credential,
        refPresent: agent.refPresent,
        refResolution: agent.refResolution,
        authConfigured: agent.authConfigured,
        authInjected: agent.authInjected,
        authVariableNames: agent.authVariableNames,
        baseUrlHost: agent.baseUrlHost,
        runtime: agent.runtime ?? 'claude-code',
        displayName: agent.displayName,
        createdAt: agent.createdAt,
        managedByFleet: agent.managedByFleet,
      };
      this.consumeTelemetry(message, this.telemetrySeed(agent));
      this.sendOrBuffer(message);
    });
    this.store.on('agentRemoved', (id) => {
      const instanceId = this.fleetInstanceIds.get(id) ?? `agent-${id}`;
      this.controlService.markInstanceStopped(instanceId);
      const message = { type: 'agentClosed', id };
      this.consumeTelemetry(message, { instanceId, agentId: id });
      this.fleetInstanceIds.delete(id);
      this.sendOrBuffer(message);
    });
    this.store.on('broadcast', (message) => {
      const id = typeof message.id === 'number' ? message.id : undefined;
      if (id !== undefined) this.syncControlInstance(this.store.get(id));
      this.consumeTelemetry(
        message,
        id === undefined ? {} : this.telemetrySeed(this.store.get(id)),
      );
      this.sendOrBuffer(message);
    });

    setTerminalAdapter(new VscodeTerminalAdapter());

    // Map an external agent's cwd/projectDir to its WorkspaceFolder.name — the
    // identity areaMappings is keyed on — so in-area seat placement works. Multi-root only.
    setFolderNameResolver(({ cwd, projectDir }) => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length <= 1) return undefined;
      // Prefer a real cwd: most specific containing folder wins (nested folders).
      if (cwd) {
        const owning = folders
          .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
          .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
        if (owning) return owning.name;
      }
      // External sessions expose only the hashed projectDir. Match a folder's own hash,
      // allowing a `<hash>-<subpath>` prefix so subdirectory sessions still resolve.
      if (projectDir) {
        const target = path.basename(projectDir);
        const hashOf = (fsPath: string): string => {
          try {
            return path.basename(getProjectDirPath(fsPath));
          } catch {
            return '';
          }
        };
        const owning = folders
          .map((f) => ({ f, hash: hashOf(f.uri.fsPath) }))
          .filter(
            ({ hash }) => hash.length > 0 && (target === hash || target.startsWith(`${hash}-`)),
          )
          .sort((a, b) => b.hash.length - a.hash.length)[0];
        if (owning) return owning.f.name;
      }
      return undefined;
    });

    // Create shared runtime (owns timer Maps, scanners, hook handler, dismissal tracker)
    this.runtime = new AgentRuntime(this.store, claudeProvider);
    this.runtime.setLifecycleCallbacks({
      onAgentStateChanged: (id, agent) => {
        // SessionStart is runtime evidence, not a UI-only event. Reuse the
        // existing store broadcast path so the ControlService projection,
        // bootstrap host, telemetry, and webview converge immediately.
        this.store.broadcast({
          type: 'agentStatus',
          id,
          status: agentStateToUserStatus(agent),
        });
      },
      onPromptSubmitted: (id, sessionId) => {
        const agent = this.store.get(id);
        if (!agent || agent.runtime !== 'claude-code') return;
        void this.resultCorrelator
          .acceptPrompt(this.controlInstanceId(agent), sessionId)
          .catch((error) => console.warn('[Claude Fleet] Prompt ACK unavailable:', error));
      },
      onTurnEnd: (id, sessionId, awaitingInput, eventId) => {
        if (awaitingInput) return;
        const agent = this.store.get(id);
        if (!agent || agent.runtime !== 'claude-code') return;
        const instanceId = this.controlInstanceId(agent);
        void this.resultCorrelator
          .consume({
            eventId: eventId ?? `claude-stop-${instanceId}-${sessionId}`,
            eventType: 'task_finished',
            observedAt: Date.now(),
            source: 'claude-hook',
            instanceId,
            agentId: id,
            runtime: 'claude-code',
            managedByFleet: agent.managedByFleet,
            sessionId,
          })
          .catch((error) =>
            console.warn('[Claude Fleet] Claude turn completion correlation unavailable:', error),
          );
      },
    });

    // Codex authentication stays outside Fleet. The adapter only resolves the
    // local executable and the injected host creates an isolated VS Code
    // terminal without receiving a secret.
    this.codexRuntimeAdapter = new CodexRuntimeAdapter({
      launch: async (request, spec) => {
        const agent = launchCodexTerminal(
          this.store.nextAgentId,
          this.store.nextTerminalIndex,
          this.runtime.activeAgentId,
          this.store,
          () => this.store.persist(),
          {
            cwd: request.cwd,
            command: spec.command,
            args: spec.args,
            modelId: request.modelId,
            displayName: request.instance.displayName,
            sessionMode: request.sessionMode,
            sessionId: request.sessionId,
            launchSource: request.launchSource,
            requestedBy: request.requestedBy,
            fleetInstanceId: request.instance.instanceId,
          },
        );
        return {
          instanceId: this.controlInstanceId(agent),
          sessionId: agent.sessionId,
          terminalId: agent.terminalId,
          terminalName: agent.terminalRef?.name,
          hostId: agent.hostId,
          workspaceId: agent.workspaceId,
          launchSource: agent.launchSource,
          requestedBy: agent.requestedBy,
          requestedProviderProfileId: agent.requestedProviderProfileId,
          resolvedProviderProfileId: agent.resolvedProviderProfileId,
          requestedModelId: agent.requestedModelId,
          resolvedModelId: agent.resolvedModelId,
          credential: agent.credential,
          refPresent: agent.refPresent,
          refResolution: agent.refResolution,
          authConfigured: agent.authConfigured,
          authInjected: agent.authInjected,
          authVariableNames: agent.authVariableNames,
          baseUrlHost: agent.baseUrlHost,
          startedAt: agent.createdAt ?? Date.now(),
        };
      },
    });
    this.codexRuntimeHost = new CodexFleetRuntimeHost(this.codexRuntimeAdapter, {
      stop: async (instanceId) => {
        const id = this.resolveLocalAgentId(instanceId);
        if (this.store.has(id)) this.runtime.stopAgent(id);
      },
      focus: async (instanceId) => {
        const agent = this.store.get(this.resolveLocalAgentId(instanceId));
        agent?.terminalRef?.show();
      },
      sendText: async (instanceId, text) => {
        const agent = this.store.get(this.resolveLocalAgentId(instanceId));
        if (!agent?.terminalRef) throw new Error('Managed Codex terminal is unavailable.');
        // WorkItem delivery must submit the bounded brief, not leave it sitting
        // in the integrated terminal input buffer awaiting a manual Enter.
        agent.terminalRef.sendText(text, true);
      },
    });
    this.controlService.registerRuntime({
      adapter: this.codexRuntimeAdapter,
      host: this.codexRuntimeHost,
    });

    // Coordinator-driven Claude launches must not depend on the webview having
    // been resolved first.
    this.ensureClaudeRuntimeHost();
    this.ensureOwnedClaudeRuntimeHost();

    this.initServer();
  }

  private get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  private get webview(): vscode.Webview | undefined {
    return this.webviewView?.webview;
  }

  /** Post a message to the webview, or buffer it if the iframe isn't ready
   *  yet. Drops silently when no view exists at all (matches prior behavior).
   *  Flushed by the `webviewReady` handler in resolveWebviewView. */
  private sendOrBuffer(message: Record<string, unknown>): void {
    const wv = this.webview;
    if (!wv) return;
    if (this.isWebviewReady) {
      wv.postMessage(message);
      return;
    }
    if (this.pendingBroadcasts.length >= MAX_PENDING_BROADCASTS) {
      console.warn(
        `[Claude Fleet] Webview buffer overflow (${MAX_PENDING_BROADCASTS}). webviewReady never arrived — dropping oldest message.`,
      );
      this.pendingBroadcasts.shift();
    }
    this.pendingBroadcasts.push(message);
  }

  private telemetrySeed(agent?: AgentState): Partial<FleetTelemetrySnapshot> {
    if (!agent) return {};
    return {
      instanceId: this.controlInstanceId(agent),
      agentId: agent.id,
      runtime: agent.runtime ?? 'claude-code',
      managedByFleet: agent.managedByFleet,
      repo: agent.cwd ?? agent.projectDir,
      cwd: agent.cwd,
      hostId: agent.hostId,
      workspaceId: agent.workspaceId,
      terminalId: agent.terminalId,
      terminalName: agent.terminalRef?.name,
      displayName: agent.displayName,
      launchSource: agent.launchSource,
      requestedBy: agent.requestedBy,
      sessionId: agent.sessionId,
      providerProfileId: agent.providerProfileId,
      providerDisplayName: agent.providerDisplayName,
      modelId: agent.modelId,
      fleet: agent.fleet,
      // Current topology: every Fleet-managed Claude Code instance is a worker;
      // the external Codex client remains the coordinator.
      role: 'worker',
      parentAgentId: agent.leadAgentId === undefined ? undefined : String(agent.leadAgentId),
      leadAgentId: agent.leadAgentId === undefined ? undefined : String(agent.leadAgentId),
      bootstrap: this.bootstrapSnapshot(agent),
    };
  }

  private bootstrapSnapshot(
    agent: AgentState,
    status?: UserFacingStatus,
  ): RuntimeBootstrapSnapshot {
    const observedAt = agent.lastDataAt || agent.createdAt || Date.now();
    if (status === 'stopped') return { state: 'stopped', observedAt };
    if (agent.terminalRef?.exitStatus !== undefined || status === 'error') {
      return {
        state: 'failed',
        reason: 'unknown',
        detail: 'Claude CLI exited before runtime readiness was observed.',
        observedAt,
      };
    }
    if (agent.nativeSessionReady) {
      return {
        state: 'ready',
        readinessSource: 'native_session',
        confidence: 'exact',
        observedAt,
      };
    }
    if (agent.sessionStartReceived) {
      return {
        state: 'ready',
        readinessSource: 'hook_session_start',
        confidence: 'exact',
        observedAt,
      };
    }
    if (agent.linesProcessed > 0) {
      return {
        state: 'ready',
        readinessSource: 'transcript',
        confidence: 'high',
        observedAt,
      };
    }
    if (agent.terminalRef) {
      return {
        state: 'needs_user_interaction',
        reason: 'startup_interaction',
        detail: 'Claude Code is waiting for startup confirmation or another interactive prompt.',
        observedAt,
      };
    }
    return { state: 'starting', reason: 'startup_interaction', observedAt };
  }

  /** Keep the local ControlService candidate pool aligned with real AgentState. */
  private syncControlInstance(agent?: AgentState, statusOverride?: UserFacingStatus): void {
    if (!agent) return;
    this.refreshNativeSessionReadiness(agent);
    const status = statusOverride ?? agentStateToUserStatus(agent);
    const bootstrap = this.bootstrapSnapshot(agent, status);
    const instance: FleetInstance = {
      instanceId: this.controlInstanceId(agent),
      runtime: agent.runtime ?? 'claude-code',
      role: agent.leadAgentId === undefined ? 'worker' : 'subagent',
      managedByFleet: agent.managedByFleet ?? !agent.isExternal,
      sessionId: agent.sessionId,
      hostId: agent.hostId,
      workspaceId: agent.workspaceId,
      repo: agent.cwd ?? agent.projectDir,
      terminalId: agent.terminalId,
      terminalName: agent.terminalRef?.name,
      launchSource: agent.launchSource,
      requestedBy: agent.requestedBy,
      providerProfileId: agent.providerProfileId,
      providerDisplayName: agent.providerDisplayName,
      modelId: agent.modelId,
      requestedProviderProfileId: agent.requestedProviderProfileId,
      resolvedProviderProfileId: agent.resolvedProviderProfileId,
      requestedModelId: agent.requestedModelId,
      resolvedModelId: agent.resolvedModelId,
      credential: agent.credential,
      refPresent: agent.refPresent,
      refResolution: agent.refResolution,
      authConfigured: agent.authConfigured,
      authInjected: agent.authInjected,
      authVariableNames: agent.authVariableNames,
      baseUrlHost: agent.baseUrlHost,
      automationMode: 'interactive',
      permissionMode: 'default',
      displayName: agent.displayName,
      fleet: agent.fleet,
      bootstrap,
      status,
      parentAgentId: agent.leadAgentId === undefined ? undefined : `agent-${agent.leadAgentId}`,
      leadAgentId: agent.leadAgentId === undefined ? undefined : `agent-${agent.leadAgentId}`,
      createdAt: agent.createdAt ?? agent.lastDataAt ?? Date.now(),
      lastActivityAt: agent.lastDataAt || undefined,
    };
    this.runtimeHost?.setBootstrapStatus(instance.instanceId, bootstrap);
    this.controlService.observeRuntimeInstance(instance);
    if (agent.usageTokens) {
      this.controlService.recordLiveUsage(
        instance.instanceId,
        instance.runtime,
        instance.providerDisplayName,
        instance.modelId,
        agent.usageTokens,
        agent.lastDataAt || Date.now(),
      );
    }
  }

  /**
   * Read Claude's process-owned session record as a readiness evidence source.
   * This is intentionally separate from hook delivery: some Claude versions
   * do not emit SessionStart until the first user turn, while the interactive
   * runtime is already ready for a Fleet task.
   */
  private refreshNativeSessionReadiness(agent: AgentState): void {
    if (agent.runtime !== 'claude-code' || !agent.terminalRef || !agent.sessionId) return;
    if (agent.terminalRef.exitStatus !== undefined) {
      agent.nativeSessionReady = false;
      return;
    }
    const evidence = findReadyClaudeNativeSession(
      agent.runtimeConfigDir ?? getClaudeConfigDir(),
      agent.sessionId,
      agent.cwd ?? agent.projectDir,
    );
    agent.nativeSessionReady = evidence !== undefined;
  }

  /** Return the stable external id, or the legacy local id for non-coordinator agents. */
  private controlInstanceId(agent: AgentState): string {
    const instanceId = agent.fleetInstanceId ?? `agent-${agent.id}`;
    this.fleetInstanceIds.set(agent.id, instanceId);
    return instanceId;
  }

  /** Resolve both coordinator-assigned ids and legacy agent-N ids. */
  private resolveLocalAgentId(instanceId: string): number {
    for (const [id, mapped] of this.fleetInstanceIds) {
      if (mapped === instanceId) return id;
    }
    return parseAgentInstanceId(instanceId);
  }

  private consumeTelemetry(
    message: Record<string, unknown>,
    seed: Partial<FleetTelemetrySnapshot>,
  ): void {
    const event = normalizeAgentBroadcast(message, seed);
    if (!event) return;
    const usage = message.type === 'agentContextUsage' ? message.usage : undefined;
    if (typeof seed.instanceId === 'string' && usage && typeof usage === 'object') {
      this.controlService.recordLiveUsage(
        seed.instanceId,
        seed.runtime,
        seed.providerDisplayName,
        seed.modelId,
        usage,
        event.observedAt,
      );
    }
    const previous = event.instanceId
      ? this.telemetryStore.getSnapshot(event.instanceId)
      : undefined;
    this.telemetryStore.consume(event);
    void this.resultCorrelator.consume(event).catch((error) => {
      console.warn('[Claude Fleet] WorkItem result correlation unavailable:', error);
    });
    // Non-Claude legacy providers may still expose only an idle transition.
    // Fleet-managed Claude completion is driven by the normalized Stop hook,
    // which is session-correlated and requires a prompt ACK.
    if (
      event.eventType === 'idle' &&
      previous?.status === 'working' &&
      event.instanceId &&
      seed.runtime !== 'claude-code'
    ) {
      void this.resultCorrelator
        .consume({
          ...event,
          eventId: event.eventId + '-task-finished',
          eventType: 'task_finished',
        })
        .catch((error) => {
          console.warn('[Claude Fleet] WorkItem completion correlation unavailable:', error);
        });
    }
    this.sendOrBuffer({ type: 'fleetTelemetry', projection: this.telemetryStore.getProjection() });
  }

  private defaultCoordinatorLaunchTemplates(policy: FleetControlPolicy): FleetLaunchTemplate[] {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
    return [
      {
        runtime: 'claude-code',
        role: 'worker',
        repo: cwd,
        cwd,
        providerProfileId: INHERIT_PROVIDER_PROFILE_ID,
        requestedBy: 'codex-primary',
        policy,
      },
      {
        runtime: 'codex-cli',
        role: 'worker',
        repo: cwd,
        cwd,
        requestedBy: 'codex-primary',
        policy,
      },
    ];
  }

  private initServer(): void {
    this.claudeFleetServer = new ClaudeFleetServer();
    this.claudeFleetServer.onHookEvent((providerId, event) => {
      this.runtime.handleHookEvent(providerId, event);
    });

    this.claudeFleetServer
      .start({
        store: this.store,
        embedded: true,
        workspaceId:
          vscode.workspace.workspaceFile?.fsPath ??
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        controlApi: this.controlService,
        coordinatorSession: this.coordinatorSession,
      })
      .then((config) => {
        // Server always starts regardless of hooks-enabled state.
        // It's the foundation for WebSocket transport and health monitoring.
        // Only hook installation/script-copy is gated by the toggle.
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        this.runtime.hooksEnabled.current = hooksEnabled;
        if (hooksEnabled) {
          void claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
          if (!copyHookScript(this.context.extensionPath)) {
            console.warn('[Claude Fleet] Hook script not copied, hooks may not fire');
          }
        }
        console.log(`[Claude Fleet] Server: ready on port ${config.port}`);
      })
      .catch((e) => {
        console.error(`[Claude Fleet] Failed to start server: ${e}`);
      });
  }

  /**
   * Register the Claude terminal boundary once per extension activation.
   * Webview resolution only wires the UI; it must not be a prerequisite for
   * coordinator-driven launches in the current workspace.
   */
  private ensureClaudeRuntimeHost(): VscodeFleetRuntimeHost {
    if (this.runtimeHost) return this.runtimeHost;

    this.runtimeHost = new VscodeFleetRuntimeHost({
      launch: async (request) => {
        const agent = await launchNewTerminal(
          this.store.nextAgentId,
          this.store.nextTerminalIndex,
          this.store,
          this.runtime.activeAgentId,
          this.runtime.knownJsonlFiles,
          this.runtime.fileWatchers,
          this.runtime.pollingTimers,
          this.runtime.waitingTimers,
          this.runtime.permissionTimers,
          this.runtime.jsonlPollTimers,
          this.runtime.projectScanTimer,
          () => this.store.persist(),
          request.launchOptions,
        );
        if (!agent) {
          throw new Error('Fleet runtime launch did not create a Claude Code instance.');
        }
        this.runtime.registerAgent(agent.sessionId, agent.id);
        return {
          instanceId: this.controlInstanceId(agent),
          sessionId: agent.sessionId,
          terminalName: agent.terminalRef?.name,
          hostId: agent.hostId,
          workspaceId: agent.workspaceId,
          launchSource: agent.launchSource,
          requestedBy: agent.requestedBy,
          requestedProviderProfileId: agent.requestedProviderProfileId,
          resolvedProviderProfileId: agent.resolvedProviderProfileId,
          requestedModelId: agent.requestedModelId,
          resolvedModelId: agent.resolvedModelId,
          credential: agent.credential,
          refPresent: agent.refPresent,
          refResolution: agent.refResolution,
          authConfigured: agent.authConfigured,
          authInjected: agent.authInjected,
          authVariableNames: agent.authVariableNames,
          baseUrlHost: agent.baseUrlHost,
          startedAt: agent.createdAt ?? Date.now(),
        };
      },
      focus: async (instanceId) => {
        const agent = this.store.get(this.resolveLocalAgentId(instanceId));
        if (agent?.terminalRef) agent.terminalRef.show();
      },
      stop: async (instanceId) => {
        const id = this.resolveLocalAgentId(instanceId);
        if (this.store.has(id)) this.runtime.stopAgent(id);
      },
      sendText: async (instanceId, text) => {
        const agent = this.store.get(this.resolveLocalAgentId(instanceId));
        if (!agent?.terminalRef) throw new Error('Managed Claude terminal is unavailable.');
        // WorkItem delivery must submit the bounded brief, not leave it sitting
        // in the integrated terminal input buffer awaiting a manual Enter.
        agent.terminalRef.sendText(text, true);
      },
      getSendTextDiagnostics: (instanceId) => {
        const id = this.resolveLocalAgentId(instanceId);
        const agent = this.store.get(id);
        return {
          resolvedLocalAgentId: `agent-${id}`,
          terminalRef: agent?.terminalRef ? 'present' : 'absent',
          terminalExitStatus: agent?.terminalRef?.exitStatus === undefined ? 'running' : 'exited',
          addNewLine: 'yes',
        };
      },
    });
    this.controlService.registerRuntime({
      adapter: this.claudeRuntimeAdapter,
      host: this.makeControlHost(this.runtimeHost),
      transport: 'terminal',
    });
    return this.runtimeHost;
  }

  private ensureOwnedClaudeRuntimeHost(): OwnedClaudeRuntimeHost {
    if (this.ownedClaudeRuntimeHost) return this.ownedClaudeRuntimeHost;
    this.ownedClaudeRuntimeHost = new OwnedClaudeRuntimeHost(
      this.ownedClaudeRuntime,
      this.providerProfileStore,
      this.secretStorageProvider,
      {
        onEvent: (instanceId, sessionId, event) => {
          void this.handleOwnedRuntimeEvent(instanceId, sessionId, event);
        },
        onExit: (instanceId, sessionId, exitCode) => {
          void this.handleOwnedRuntimeExit(instanceId, sessionId, exitCode);
        },
        onLaunch: (instanceId, result) => {
          this.publishOwnedAgentCreated(instanceId, result);
        },
      },
    );
    this.controlService.registerRuntime({
      adapter: this.claudeRuntimeAdapter,
      host: this.ownedClaudeRuntimeHost,
      transport: 'owned',
    });
    return this.ownedClaudeRuntimeHost;
  }

  private ownedUiAgentId(instanceId: string): number {
    const existing = this.ownedUiAgentIds.get(instanceId);
    if (existing !== undefined) return existing;
    const id = this.store.nextAgentId.current;
    this.store.nextAgentId.current += 1;
    this.ownedUiAgentIds.set(instanceId, id);
    this.ownedInstanceByUiAgentId.set(id, instanceId);
    return id;
  }

  private publishOwnedAgentCreated(instanceId: string, result: RuntimeLaunchResult): void {
    const id = this.ownedUiAgentId(instanceId);
    // The control snapshot supplies the display name once launch metadata has
    // been merged; never put a Promise in the webview protocol.
    void this.controlService.getInstance(instanceId).then((instance) => {
      this.sendOrBuffer({
        type: 'agentCreated',
        id,
        displayName: instance?.displayName,
        providerProfileId: result.resolvedProviderProfileId,
        providerDisplayName: result.providerDisplayName,
        modelId: result.resolvedModelId,
        runtime: 'claude-code',
        createdAt: result.startedAt,
        managedByFleet: true,
      });
    });
  }

  private async handleOwnedRuntimeEvent(
    instanceId: string,
    sessionId: string,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const instance = await this.controlService.getInstance(instanceId);
    const uiAgentId = this.ownedUiAgentId(instanceId);
    const rawType = typeof raw.type === 'string' ? raw.type : 'unknown';
    const rawSessionId = stringValue(raw.session_id) ?? stringValue(raw.sessionId) ?? sessionId;
    const usage = normalizeOwnedUsage(raw.usage);
    const resultSummary = rawType === 'result' ? boundedOwnedText(raw.result) : undefined;
    const isError =
      rawType === 'error' ||
      (rawType === 'result' && (raw.is_error === true || raw.subtype === 'error'));
    const text = boundedOwnedText(raw.message ?? raw.content ?? raw.result);

    let eventType: FleetEvent['eventType'];
    let status: string;
    let bootstrap = instance?.bootstrap;
    if (rawType === 'system') {
      eventType = 'runtime_ready';
      status = 'idle';
      bootstrap = {
        state: 'ready',
        readinessSource: 'native_session',
        confidence: 'exact',
        observedAt: Date.now(),
      };
      this.ownedClaudeRuntimeHost?.setBootstrapStatus(instanceId, bootstrap);
    } else if (rawType === 'user') {
      eventType = 'prompt_accepted';
      status = 'working';
    } else if (rawType === 'assistant') {
      eventType = 'assistant_message';
      status = 'working';
    } else if (isError) {
      eventType = 'error';
      status = 'error';
      bootstrap = {
        state: 'failed',
        reason: 'unknown',
        detail: 'Claude owned runtime reported an error.',
        observedAt: Date.now(),
      };
      this.ownedClaudeRuntimeHost?.setBootstrapStatus(instanceId, bootstrap);
    } else if (rawType === 'result') {
      eventType = 'task_finished';
      status = 'idle';
    } else {
      return;
    }

    const event: FleetEvent = {
      eventId: `owned-${instanceId}-${rawType}-${randomUUID()}`,
      eventType,
      observedAt: Date.now(),
      source: 'claude-jsonl',
      instanceId,
      agentId: uiAgentId,
      runtime: 'claude-code',
      managedByFleet: true,
      repo: instance?.repo,
      cwd: instance?.workspaceId ?? instance?.repo,
      hostId: this.ownedClaudeRuntimeHost?.hostId,
      workspaceId: instance?.workspaceId,
      terminalId: instance?.terminalId ?? `terminal-${instanceId}`,
      terminalName: instance?.terminalName,
      displayName: instance?.displayName,
      sessionId: rawSessionId,
      providerProfileId: instance?.providerProfileId,
      providerDisplayName: instance?.providerDisplayName,
      modelId: instance?.modelId,
      role: 'worker',
      status,
      bootstrap,
      workItemId: instance?.workItemId,
      ...(text ? { currentTask: text } : {}),
      ...(resultSummary ? { resultSummary } : {}),
      ...(usage ? { usage } : {}),
      ...(typeof raw.total_cost_usd === 'number' && Number.isFinite(raw.total_cost_usd)
        ? { costUsd: raw.total_cost_usd }
        : {}),
      ...(eventType === 'error'
        ? {
            error: {
              message: text || 'Claude owned runtime error.',
              timestamp: Date.now(),
              source: 'claude-jsonl',
            },
          }
        : {}),
    };

    if (instance) {
      this.controlService.observeRuntimeInstance({
        ...instance,
        transport: 'owned',
        sessionId: rawSessionId,
        status: status as FleetInstance['status'],
        bootstrap,
        lastActivityAt: event.observedAt,
      });
    }
    if (usage) {
      this.controlService.recordLiveUsage(
        instanceId,
        'claude-code',
        instance?.providerDisplayName,
        instance?.modelId,
        usage,
        event.observedAt,
      );
      this.sendOrBuffer({
        type: 'agentContextUsage',
        id: uiAgentId,
        contextTokens: undefined,
        maxContextTokens: undefined,
        usage,
      });
    }
    this.telemetryStore.consume(event);
    this.sendOrBuffer({ type: 'agentStatus', id: uiAgentId, status });
    if (eventType === 'task_finished') {
      this.sendOrBuffer({ type: 'agentCompletionUnread', id: uiAgentId });
    }
    void this.resultCorrelator
      .consume(event)
      .then((response) => {
        if (response?.instance) this.controlService.observeRuntimeInstance(response.instance);
        this.sendOrBuffer({
          type: 'fleetTelemetry',
          projection: this.telemetryStore.getProjection(),
        });
      })
      .catch((error) =>
        console.warn('[Claude Fleet] Owned result correlation unavailable:', error),
      );
    this.sendOrBuffer({ type: 'fleetTelemetry', projection: this.telemetryStore.getProjection() });
  }

  private async handleOwnedRuntimeExit(
    instanceId: string,
    sessionId: string,
    exitCode: number | null,
  ): Promise<void> {
    const instance = await this.controlService.getInstance(instanceId);
    if (!instance || instance.status === 'stopped') return;
    const uiAgentId = this.ownedUiAgentId(instanceId);
    const stopped = exitCode === 0;
    const event: FleetEvent = {
      eventId: `owned-${instanceId}-exit-${randomUUID()}`,
      eventType: stopped ? 'agent_stopped' : 'error',
      observedAt: Date.now(),
      source: 'claude-jsonl',
      instanceId,
      agentId: uiAgentId,
      runtime: 'claude-code',
      managedByFleet: true,
      sessionId,
      status: stopped ? 'stopped' : 'error',
      error: stopped
        ? undefined
        : {
            message: 'Claude owned runtime exited before completion.',
            timestamp: Date.now(),
            source: 'process',
          },
    };
    this.controlService.markInstanceStopped(instanceId, event.observedAt);
    this.telemetryStore.consume(event);
    this.sendOrBuffer({ type: 'agentStatus', id: uiAgentId, status: event.status });
    this.sendOrBuffer({ type: 'fleetTelemetry', projection: this.telemetryStore.getProjection() });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    // Fresh iframe; any prior buffer is for the destroyed iframe and obsolete
    // (the `webviewReady` handler resends current state via restoreAgents +
    // sendCurrentAgentStatuses + asset loaders).
    this.isWebviewReady = false;
    this.pendingBroadcasts = [];
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    /**
     * Spec 002 — entry point invoked by the `claude-fleet.newAgent` Launch
     * Flow (QuickPick / InputBox). All Fleet-managed launches now cross the
     * VS Code Integrated Terminal host boundary before reaching the existing
     * Agent Manager implementation.
     */
    this.ensureClaudeRuntimeHost();

    this.launchFromFlow = async (options: LaunchNewTerminalOptions): Promise<void> => {
      const cwd =
        options.folderPath ||
        options.launchConfig?.cwd ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        os.homedir();
      const instanceId = `agent-${this.store.nextAgentId.current}`;
      const request: VscodeRuntimeLaunchRequest = {
        runtime: 'claude-code',
        cwd,
        sessionMode: options.launchConfig?.sessionMode ?? 'new',
        sessionId: options.launchConfig?.sessionId,
        providerProfileId: options.launchConfig?.providerProfileId,
        modelId: options.launchConfig?.modelId,
        automationMode: options.automationMode ?? 'interactive',
        permissionMode: options.permissionMode ?? 'default',
        launchSource: options.launchSource ?? 'fleet-ui',
        requestedBy: options.requestedBy ?? 'user',
        instance: makeClaudeFleetInstance({
          instanceId,
          cwd,
          sessionId: options.launchConfig?.sessionId,
          providerProfileId: options.launchConfig?.providerProfileId,
          modelId: options.launchConfig?.modelId,
          displayName: options.launchConfig?.displayName,
          launchSource: options.launchSource ?? 'fleet-ui',
          requestedBy: options.requestedBy ?? 'user',
          fleet: options.launchConfig?.fleet,
        }),
        launchOptions: options,
      };
      const runtimeHost = this.runtimeHost;
      if (!runtimeHost) throw new Error('Fleet runtime host is not initialized.');
      await runtimeHost.launch(request);
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'launchAgent') {
        // Spec 005 (FR-003/FR-005): the webview +Agent button routes through
        // the full New Agent flow — Provider/Model must come from configured
        // profiles; the built-in Inherit profile is no longer auto-injected.
        await vscode.commands.executeCommand(COMMAND_NEW_AGENT);
      } else if (message.type === 'focusAgent') {
        const ownedInstanceId = this.ownedInstanceByUiAgentId.get(message.id as number);
        if (ownedInstanceId && this.ownedClaudeRuntimeHost) {
          await this.ownedClaudeRuntimeHost.focus(ownedInstanceId);
          return;
        }
        const agent = this.store.get(message.id);
        if (agent) {
          if (!agent.isExternal && this.runtimeHost) {
            await this.runtimeHost.focus(this.controlInstanceId(agent));
          } else if (agent.terminalRef) {
            agent.terminalRef.show();
          } else if (agent.leadAgentId !== undefined) {
            // Teammate (tmux): focus the lead's terminal instead
            const lead = this.store.get(agent.leadAgentId);
            if (lead?.terminalRef) {
              lead.terminalRef.show();
            }
          }
        }
      } else if (message.type === 'closeAgent' || message.type === 'stopAgent') {
        // Spec 004 — the webview ✕ button and the Stop command share ONE
        // cleanup path: stopAgent really closes the terminal/process and
        // clears runtime state (dismissal / unregister / watchers / store).
        const ownedInstanceId = this.ownedInstanceByUiAgentId.get(message.id as number);
        if (ownedInstanceId && this.ownedClaudeRuntimeHost) {
          await this.ownedClaudeRuntimeHost.stop(ownedInstanceId);
          return;
        }
        const agent = this.store.get(message.id as number);
        if (agent && !agent.isExternal && this.runtimeHost) {
          await this.runtimeHost.stop(this.controlInstanceId(agent));
        } else {
          this.runtime.stopAgent(message.id as number);
        }
      } else if (message.type === 'newAgent') {
        // Spec 004 — empty-state [+ New Agent] button.
        await vscode.commands.executeCommand(COMMAND_NEW_AGENT);
      } else if (message.type === 'restartAgent') {
        // Spec 004 — Debug View Restart button. Reuses the command flow so
        // Repo / Provider / Model are preserved; the button targets the
        // clicked agent directly (no second QuickPick). Spec 005: resumes
        // the SAME Claude native session.
        await runRestartAgentCommand({
          store: this.store,
          runtime: this.runtime,
          baseLaunchOptions: {
            providerProfileStore: this.providerProfileStore,
            secretStorageProvider: this.secretStorageProvider,
          },
          runtimeHost: this.runtimeHost,
          launcher: async (options) => {
            await this.launchFromFlow(options);
          },
          picker: async () => message.id as number,
        });
      } else if (message.type === 'switchProvider') {
        // Spec 005 — Debug View Switch button: new Provider env + SAME
        // session via Claude Code native resume.
        await runSwitchProviderCommand({
          store: this.store,
          runtime: this.runtime,
          providerProfileStore: this.providerProfileStore,
          baseLaunchOptions: {
            providerProfileStore: this.providerProfileStore,
            secretStorageProvider: this.secretStorageProvider,
          },
          runtimeHost: this.runtimeHost,
          launcher: async (options) => {
            await this.launchFromFlow(options);
          },
          picker: async () => message.id as number,
        });
      } else if (message.type === 'saveAgentSeats') {
        // Store seat assignments in a separate key (never touched by persistAgents)
        console.log(`[Claude Fleet] State: saveAgentSeats:`, JSON.stringify(message.seats));
        this.adapter.saveSeats(message.seats);
      } else if (message.type === 'saveLayout') {
        this.layoutWatcher?.markOwnWrite();
        writeLayoutToFile(message.layout as Record<string, unknown>);
      } else if (message.type === 'setSoundEnabled') {
        this.adapter.setSetting(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
      } else if (message.type === 'setLastSeenVersion') {
        this.adapter.setSetting(GLOBAL_KEY_LAST_SEEN_VERSION, message.version as string);
      } else if (message.type === 'setAlwaysShowLabels') {
        this.adapter.setSetting(GLOBAL_KEY_ALWAYS_SHOW_LABELS, message.enabled);
      } else if (message.type === 'setGhostHeadlessAgents') {
        this.adapter.setSetting(GLOBAL_KEY_GHOST_HEADLESS_AGENTS, message.enabled);
      } else if (message.type === 'setHooksEnabled') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_ENABLED, enabled);
        this.runtime.hooksEnabled.current = enabled;
        if (enabled) {
          const serverConfig = this.claudeFleetServer?.getConfig();
          void claudeProvider.installHooks(
            serverConfig ? `http://127.0.0.1:${serverConfig.port}` : '',
            serverConfig?.token ?? '',
          );
          const copied = copyHookScript(this.context.extensionPath);
          console.log(
            copied
              ? '[Claude Fleet] Hooks enabled by user'
              : '[Claude Fleet] Hooks NOT fully enabled, hook script missing',
          );
        } else {
          void claudeProvider.uninstallHooks();
          console.log('[Claude Fleet] Hooks disabled by user');
        }
      } else if (message.type === 'setHooksInfoShown') {
        this.adapter.setSetting(GLOBAL_KEY_HOOKS_INFO_SHOWN, true);
      } else if (message.type === 'setShowAreas') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_SHOW_AREAS, enabled);
      } else if (message.type === 'saveAreaMappings') {
        const mappings = message.mappings as Record<string, string[]>;
        const cfg = readConfig();
        cfg.vscode.areaMappings = mappings;
        writeConfig(cfg);
      } else if (message.type === 'setWatchAllSessions') {
        const enabled = message.enabled as boolean;
        this.adapter.setSetting(GLOBAL_KEY_WATCH_ALL_SESSIONS, enabled);
        this.runtime.watchAllSessions.current = enabled;
        if (enabled) {
          // Clear only toggle-specific dismissals so global agents can be re-adopted
          for (const file of this.globalDismissedFiles) {
            this.runtime.dismissalTracker.clearDismissal(file);
          }
          this.globalDismissedFiles.clear();
        } else {
          // Remove all external agents not from the current workspace folders.
          // PathSet: an agent adopted via hooks carries Claude's spelling of the
          // project dir, which differs from VS Code's by drive-letter case on Windows.
          const workspaceDirs = new PathSet();
          for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const dir = getProjectDirPath(folder.uri.fsPath);
            if (dir) workspaceDirs.add(dir);
          }
          const toRemove: number[] = [];
          for (const [id, agent] of this.store) {
            if (agent.isExternal && !workspaceDirs.has(agent.projectDir)) {
              toRemove.push(id);
            }
          }
          for (const id of toRemove) {
            const agent = this.store.get(id);
            if (agent) {
              this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
              this.globalDismissedFiles.add(agent.jsonlFile);
              this.runtime.knownJsonlFiles.delete(agent.jsonlFile);
            }
            this.runtime.removeAgent(id);
          }
        }
      } else if (message.type === 'webviewReady') {
        // Flush any messages buffered while the iframe was loading. Mark
        // ready BEFORE flush so re-entrant broadcasts (triggered by handlers
        // below) go directly. Order is preserved: buffered first, new second.
        this.isWebviewReady = true;
        const buffered = this.pendingBroadcasts;
        this.pendingBroadcasts = [];
        for (const msg of buffered) {
          this.webview?.postMessage(msg);
        }
        // Provider capabilities: tool taxonomy for webview animation + subagent rendering.
        // Sent once before restoreAgents so characters render with correct animations
        // from the first frame.
        this.webview?.postMessage({
          type: 'providerCapabilities',
          readingTools: [...claudeProvider.readingTools],
          subagentToolNames: [...claudeProvider.subagentToolNames],
        });

        // Settings + folder→Area mappings MUST be dispatched BEFORE restoreAgents
        // and the auto-spawn path. Both paths emit `agentCreated` postMessages via
        // AgentStateStore events; the webview's handler routes each agent through
        // OfficeState.findFreeSeat(folderName), which depends on `areaMappings`.
        // If we restore agents first, Stage-1 (in-Area) is silently skipped for
        // restored / auto-spawned agents and their preferred Area placement is lost.
        const soundEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
        const lastSeenVersion = this.adapter.getSetting<string>(GLOBAL_KEY_LAST_SEEN_VERSION, '');
        const extensionVersion =
          (this.context.extension.packageJSON as { version?: string }).version ?? '';
        const watchAllSessions = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_WATCH_ALL_SESSIONS,
          false,
        );
        const alwaysShowLabels = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_ALWAYS_SHOW_LABELS,
          false,
        );
        const ghostHeadlessAgents = this.adapter.getSetting<boolean>(
          GLOBAL_KEY_GHOST_HEADLESS_AGENTS,
          false,
        );
        this.runtime.watchAllSessions.current = watchAllSessions;
        const hooksEnabled = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_ENABLED, true);
        const hooksInfoShown = this.adapter.getSetting<boolean>(GLOBAL_KEY_HOOKS_INFO_SHOWN, false);
        const showAreas = this.adapter.getSetting<boolean>(GLOBAL_KEY_SHOW_AREAS, false);
        const config = readConfig();
        this.webview?.postMessage({
          type: 'settingsLoaded',
          soundEnabled,
          lastSeenVersion,
          extensionVersion,
          watchAllSessions,
          alwaysShowLabels,
          ghostHeadlessAgents,
          hooksEnabled,
          hooksInfoShown,
          externalAssetDirectories: config.externalAssetDirectories,
          showAreas,
        });

        // Folder→Area mappings (must arrive before any agentCreated/existingAgents
        // so OfficeState.findFreeSeat has the dict when characters are placed).
        this.webview?.postMessage({
          type: 'areaMappingsLoaded',
          mappings: config.vscode.areaMappings ?? {},
        });

        restoreAgents(
          this.adapter,
          this.store.nextAgentId,
          this.store.nextTerminalIndex,
          this.store,
          this.runtime.knownJsonlFiles,
          this.runtime.fileWatchers,
          this.runtime.pollingTimers,
          this.runtime.waitingTimers,
          this.runtime.permissionTimers,
          this.runtime.jsonlPollTimers,
          this.runtime.projectScanTimer,
          this.runtime.activeAgentId,
        );
        // Register all restored agents with hook handler
        for (const agent of this.store.values()) {
          this.runtime.registerAgent(agent.sessionId, agent.id);
        }
        this.sendOrBuffer({
          type: 'fleetTelemetry',
          projection: this.telemetryStore.getProjection(),
        });

        // Auto-spawn: launch one agent on first webviewReady if the setting is
        // enabled and no agents are currently running.
        if (
          !this.autoSpawnAttempted &&
          vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY_AUTO_SPAWN_AGENT, false) &&
          this.store.size === 0
        ) {
          this.autoSpawnAttempted = true;
          console.log('[Claude Fleet] Auto-spawning agent on startup');
          // When the user also opted into autoShowPanel, skip terminal.show()
          // so the panel view stays on Claude Fleet. The terminal still runs;
          // clicking the character focuses it via the focusAgent handler.
          const autoShowPanel = vscode.workspace
            .getConfiguration()
            .get<boolean>(CONFIG_KEY_AUTO_SHOW_PANEL, false);
          // Spec 005: auto-spawn uses the first configured + enabled profile;
          // with none configured it is skipped (no silent Inherit fallback).
          const autoProfiles = this.providerProfileStore.list().filter((p) => p.enabled !== false);
          if (autoProfiles.length === 0) {
            console.warn('[Claude Fleet] Auto-spawn skipped: no Provider Profiles configured.');
          } else {
            await this.launchFromFlow({
              launchConfig: { cwd: '', providerProfileId: autoProfiles[0].id },
              suppressShow: autoShowPanel,
              launchSource: 'auto-spawn',
              requestedBy: 'agent-fleet',
              providerProfileStore: this.providerProfileStore,
              secretStorageProvider: this.secretStorageProvider,
            });
          }
        } else {
          // Mark as attempted even when skipping, so subsequent panel focuses
          // (which retrigger webviewReady) never auto-spawn unexpectedly.
          this.autoSpawnAttempted = true;
        }

        // Send workspace folders to webview (only when multi-root)
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 1) {
          this.webview?.postMessage({
            type: 'workspaceFolders',
            folders: wsFolders.map((f) => ({ name: f.name, path: f.uri.fsPath })),
          });
        }

        // Ensure project scan runs even with no restored agents (to adopt external terminals)
        const projectDir = getProjectDirPath();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        console.log(`[Claude Fleet] Debug: Platform: ${process.platform}, arch: ${process.arch}`);
        console.log('[Extension] workspaceRoot:', workspaceRoot);
        console.log('[Extension] projectDir:', projectDir);
        this.runtime.startProjectScan(projectDir);

        // Start external session scanning (detects VS Code extension panel sessions)
        this.runtime.startExternalScanning(projectDir);

        // Codex Desktop/CLI writes session_meta JSONL under ~/.codex/sessions,
        // not ~/.claude/projects. Keep this independent from Claude hooks so a
        // user-created Codex coordinator is visible without launching it from
        // Fleet. The scanner is workspace-scoped and secret-free.
        this.startCodexSessionDiscovery((wsFolders ?? []).map((folder) => folder.uri.fsPath));

        // In multi-root workspaces, also scan project dirs for all other folders
        // so agents running in any workspace folder are discovered
        if (wsFolders && wsFolders.length > 1) {
          for (const folder of wsFolders) {
            const folderProjectDir = getProjectDirPath(folder.uri.fsPath);
            if (folderProjectDir && folderProjectDir !== projectDir) {
              console.log(`[Claude Fleet] Registering additional project dir: ${folderProjectDir}`);
              this.runtime.startProjectScan(folderProjectDir);
            }
          }
        }

        this.runtime.startStaleCheck();

        // Load furniture assets BEFORE sending layout
        (async () => {
          try {
            console.log('[Extension] Loading furniture assets...');
            const extensionPath = this.extensionUri.fsPath;
            console.log('[Extension] extensionPath:', extensionPath);

            // Check bundled location first: extensionPath/dist/assets/
            const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
            let assetsRoot: string | null = null;
            if (fs.existsSync(bundledAssetsDir)) {
              console.log('[Extension] Found bundled assets at dist/');
              assetsRoot = path.join(extensionPath, 'dist');
            } else if (workspaceRoot) {
              // Fall back to workspace root (development or external assets)
              console.log('[Extension] Trying workspace for assets...');
              assetsRoot = workspaceRoot;
            }

            if (!assetsRoot) {
              console.log('[Extension] ⚠️  No assets directory found');
              if (this.webview) {
                sendLayout(this.webview, this.defaultLayout);
                // Send agent statuses AFTER layoutLoaded so characters exist when messages arrive
                sendCurrentAgentStatuses(this.store, this.webview);
                this.startLayoutWatcher();
              }
              return;
            }

            console.log('[Extension] Using assetsRoot:', assetsRoot);
            this.assetsRoot = assetsRoot;

            // Load bundled default layout
            this.defaultLayout = loadDefaultLayout(assetsRoot);

            // Load character sprites (bundled + external)
            const charSprites = await this.loadAllCharacterSprites();
            if (charSprites && this.webview) {
              console.log(
                `[Extension] ${charSprites.characters.length} character sprites loaded, sending to webview`,
              );
              sendCharacterSpritesToWebview(this.webview, charSprites);
            }

            // Load pet sprites (bundled + external)
            const petSprites = await this.loadAllPetSprites();
            if (petSprites && this.webview) {
              console.log(
                `[Extension] ${petSprites.pets.length} pet sprites loaded, sending to webview`,
              );
              sendPetSpritesToWebview(this.webview, petSprites);
            }

            // Load floor tiles
            const floorTiles = await loadFloorTiles(assetsRoot);
            if (floorTiles && this.webview) {
              console.log('[Extension] Floor tiles loaded, sending to webview');
              sendFloorTilesToWebview(this.webview, floorTiles);
            }

            // Load wall tiles
            const wallTiles = await loadWallTiles(assetsRoot);
            if (wallTiles && this.webview) {
              console.log('[Extension] Wall tiles loaded, sending to webview');
              sendWallTilesToWebview(this.webview, wallTiles);
            }

            // Load carpet tiles (auto-tile sprite sets, 3 demo variants by default)
            const carpetTiles = await loadCarpetTiles(assetsRoot);
            if (carpetTiles && this.webview) {
              console.log('[Extension] Carpet tiles loaded, sending to webview');
              sendCarpetTilesToWebview(this.webview, carpetTiles);
            }

            const assets = await this.loadAllFurnitureAssets();
            if (assets && this.webview) {
              console.log('[Extension] ✅ Assets loaded, sending to webview');
              sendAssetsToWebview(this.webview, assets);
            }
          } catch (err) {
            console.error('[Extension] ❌ Error loading assets:', err);
          }
          // Always send saved layout (or null for default)
          if (this.webview) {
            console.log('[Extension] Sending saved layout');
            sendLayout(this.webview, this.defaultLayout);
            // Send agent statuses AFTER layoutLoaded so characters exist when messages arrive
            sendCurrentAgentStatuses(this.store, this.webview);
            this.startLayoutWatcher();
          }
        })();
        sendExistingAgents(this.store, this.adapter, this.webview);
      } else if (message.type === 'requestDiagnostics') {
        // Send connection diagnostics for all agents to the Debug View
        this.webview?.postMessage({
          type: 'agentDiagnostics',
          agents: buildAgentDiagnostics(this.store),
        });
        // Spec 003 — poll-driven status refresh. The webview polls every 2s;
        // this path is the only one with fs + time access, so it computes the
        // error-aware user status (transcript vanished / launch timeout) and
        // broadcasts it over the existing agentStatus channel. Keeps the
        // webview's single source of truth (agentStatuses dict) fresh for
        // transitions hooks never emit (starting → idle, → error).
        const now = Date.now();
        for (const [id, agent] of this.store) {
          this.refreshNativeSessionReadiness(agent);
          let jsonlExists = false;
          try {
            jsonlExists = fs.existsSync(agent.jsonlFile);
          } catch {
            /* treat as missing */
          }
          const statusMessage = {
            type: 'agentStatus',
            id,
            status: agentStateToUserStatusWithError(agent, {
              jsonlExists,
              createdAt: agent.createdAt,
              now,
              // An interactive Fleet terminal can be healthy before the
              // first prompt creates its JSONL session. Use VS Code's
              // authoritative terminal lifecycle signal so the timeout
              // heuristic only reports a real launch failure.
              processAlive:
                agent.terminalRef !== undefined
                  ? agent.terminalRef.exitStatus === undefined
                  : undefined,
            }),
          };
          // Keep the ControlService projection aligned with the error-aware
          // diagnostic result as well. Without this, the Webview could show a
          // dead terminal as disconnected while /api/control/instances still
          // reported the old "starting" state.
          this.syncControlInstance(agent, statusMessage.status);
          // Diagnostics run on a timer. Re-ingesting an unchanged status on
          // every tick turns the activity feed into a heartbeat log and hides
          // meaningful events. Only publish a telemetry event when the
          // user-facing status actually changes (or when this is the first
          // snapshot for the agent).
          const instanceId = this.controlInstanceId(agent);
          const previousSnapshot = this.telemetryStore.getSnapshot(instanceId);
          const statusChanged =
            !previousSnapshot || previousSnapshot.status !== statusMessage.status;
          if (statusChanged) {
            this.consumeTelemetry(statusMessage, this.telemetrySeed(agent));
            this.webview?.postMessage(statusMessage);
          }
        }
      } else if (message.type === 'openSessionsFolder') {
        const projectDir = getProjectDirPath();
        if (projectDir && fs.existsSync(projectDir)) {
          vscode.env.openExternal(vscode.Uri.file(projectDir));
        }
      } else if (message.type === 'exportLayout') {
        const layout = readLayoutFromFile();
        if (!layout) {
          vscode.window.showWarningMessage('Claude Fleet: No saved layout to export.');
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          filters: { 'JSON Files': ['json'] },
          defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-fleet-layout.json')),
        });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
          vscode.window.showInformationMessage('Claude Fleet: Layout exported successfully.');
        }
      } else if (message.type === 'addExternalAssetDirectory') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select Asset Directory',
        });
        if (!uris || uris.length === 0) return;
        const newPath = uris[0].fsPath;
        const cfg = readConfig();
        if (!cfg.externalAssetDirectories.includes(newPath)) {
          cfg.externalAssetDirectories.push(newPath);
          writeConfig(cfg);
        }
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'removeExternalAssetDirectory') {
        const cfg = readConfig();
        cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter(
          (d) => d !== (message.path as string),
        );
        writeConfig(cfg);
        await this.reloadAndSendCharacters();
        await this.reloadAndSendPets();
        await this.reloadAndSendFurniture();
        this.webview?.postMessage({
          type: 'externalAssetDirectoriesUpdated',
          dirs: cfg.externalAssetDirectories,
        });
      } else if (message.type === 'importLayout') {
        const uris = await vscode.window.showOpenDialog({
          filters: { 'JSON Files': ['json'] },
          canSelectMany: false,
        });
        if (!uris || uris.length === 0) return;
        try {
          const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
          const imported = JSON.parse(raw) as Record<string, unknown>;
          if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
            vscode.window.showErrorMessage('Claude Fleet: Invalid layout file.');
            return;
          }
          this.layoutWatcher?.markOwnWrite();
          writeLayoutToFile(imported);
          this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
          vscode.window.showInformationMessage('Claude Fleet: Layout imported successfully.');
        } catch {
          vscode.window.showErrorMessage('Claude Fleet: Failed to read or parse layout file.');
        }
      }
    });

    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;
      this.runtime.activeAgentId.current = null;
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === terminal) {
          this.runtime.activeAgentId.current = id;
          webviewView.webview.postMessage({ type: 'agentSelected', id });
          break;
        }
      }
    });

    vscode.window.onDidCloseTerminal((closed) => {
      for (const [id, agent] of this.store) {
        if (agent.terminalRef && agent.terminalRef === closed) {
          if (this.runtime.activeAgentId.current === id) {
            this.runtime.activeAgentId.current = null;
          }
          // If this is a team lead, remove its teammates
          if (agent.isTeamLead) {
            this.runtime.removeTeammates(id);
          }
          // Dismiss JSONL so external scanner doesn't re-adopt it
          this.runtime.dismissalTracker.dismiss(agent.jsonlFile);
          this.runtime.unregisterAgent(agent.sessionId);
          this.runtime.removeAgent(id);
        }
      }
    });
  }

  private makeControlHost(host: VscodeFleetRuntimeHost): FleetRuntimeHost {
    return {
      hostId: host.hostId,
      hostType: host.hostType,
      launch: (request: RuntimeLaunchRequest) => {
        if (request.instance.runtime === 'claude-code' && !request.providerProfileId) {
          throw new Error(
            'PROVIDER_PROFILE_REQUIRED: Claude Code API launches require an explicit providerProfileId.',
          );
        }
        const providerProfileId = request.providerProfileId as string;
        const launchOptions: LaunchNewTerminalOptions = {
          folderPath: request.cwd,
          launchConfig: {
            cwd: request.cwd,
            providerProfileId,
            modelId: request.modelId,
            displayName: request.instance.displayName,
            sessionMode: request.sessionMode,
            sessionId: request.sessionId,
            fleet: request.instance.fleet,
          },
          automationMode: request.automationMode ?? 'interactive',
          permissionMode: request.permissionMode ?? 'default',
          bypassPermissions: request.permissionMode === 'bypassPermissions',
          launchSource: request.launchSource ?? 'fleet-control-api',
          requestedBy: request.requestedBy ?? 'control-api',
          fleetInstanceId: request.instance.instanceId,
          providerProfileStore: this.providerProfileStore,
          secretStorageProvider: this.secretStorageProvider,
        };
        return host.launch({
          ...request,
          runtime: 'claude-code',
          launchOptions,
        });
      },
      stop: (instanceId) => host.stop(instanceId),
      focus: (instanceId) => host.focus(instanceId),
      sendTask: host.sendTask,
      getBootstrapStatus: (instanceId) => host.getBootstrapStatus(instanceId),
      subscribeBootstrap: (listener) => host.subscribeBootstrap(listener),
      getDeliveryDiagnostics: (instanceId, workItemId) =>
        host.getDeliveryDiagnostics(instanceId, workItemId),
    };
  }

  /** Export current saved layout as a versioned default-layout-{N}.json (dev utility) */
  exportDefaultLayout(): void {
    const layout = readLayoutFromFile();
    if (!layout) {
      vscode.window.showWarningMessage('Claude Fleet: No saved layout found.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('Claude Fleet: No workspace folder found.');
      return;
    }
    const assetsDir = path.join(workspaceRoot, 'webview-ui', 'public', 'assets');

    // Find the next revision number
    let maxRevision = 0;
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          maxRevision = Math.max(maxRevision, parseInt(match[1], 10));
        }
      }
    }
    const nextRevision = maxRevision + 1;
    layout[LAYOUT_REVISION_KEY] = nextRevision;

    const targetPath = path.join(assetsDir, `default-layout-${nextRevision}.json`);
    const json = JSON.stringify(layout, null, 2);
    fs.writeFileSync(targetPath, json, 'utf-8');
    vscode.window.showInformationMessage(
      `Claude Fleet: Default layout exported as revision ${nextRevision} to ${targetPath}`,
    );
  }

  private async loadAllFurnitureAssets(): Promise<LoadedAssets | null> {
    if (!this.assetsRoot) return null;
    return loadAllFurniture(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllCharacterSprites(): Promise<LoadedCharacterSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllCharacters(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async loadAllPetSprites(): Promise<LoadedPetSprites | null> {
    if (!this.assetsRoot) return null;
    return loadAllPets(this.assetsRoot, readConfig().externalAssetDirectories);
  }

  private async reloadAndSendFurniture(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const assets = await this.loadAllFurnitureAssets();
      if (assets) {
        sendAssetsToWebview(this.webview, assets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading furniture assets:', err);
    }
  }

  private async reloadAndSendCharacters(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const chars = await this.loadAllCharacterSprites();
      if (chars) {
        sendCharacterSpritesToWebview(this.webview, chars);
      }
    } catch (err) {
      console.error('[Extension] Error reloading character sprites:', err);
    }
  }

  private async reloadAndSendPets(): Promise<void> {
    if (!this.assetsRoot || !this.webview) return;
    try {
      const pets = await this.loadAllPetSprites();
      if (pets) {
        sendPetSpritesToWebview(this.webview, pets);
      }
    } catch (err) {
      console.error('[Extension] Error reloading pet sprites:', err);
    }
  }

  private startLayoutWatcher(): void {
    if (this.layoutWatcher) return;
    this.layoutWatcher = watchLayoutFile((layout) => {
      console.log('[Claude Fleet] External layout change — pushing to webview');
      this.webview?.postMessage({ type: 'layoutLoaded', layout });
    });
  }

  private startCodexSessionDiscovery(workspaceRoots: readonly string[]): void {
    if (this.codexDiscoveryTimer) return;

    // Older builds projected Codex Desktop threads as external Worker Agents.
    // Remove those stale projections once; the scanner below excludes Desktop
    // sessions from future Worker discovery while keeping their JSONL intact.
    for (const candidate of [...this.store.values()]) {
      if (
        candidate.runtime === 'codex-cli' &&
        candidate.isExternal &&
        isCodexDesktopSessionFile(candidate.jsonlFile)
      ) {
        this.runtime.removeAgent(candidate.id);
        console.log(
          `[Claude Fleet] Codex: removed stale Desktop session projection Agent ${candidate.id}`,
        );
      }
    }

    const scan = (): void => {
      const sessions = scanCodexSessions({
        workspaceRoots,
        // An external Codex session remains on disk after the user closes its
        // Fleet projection. Reuse the shared dismissal cooldown so the next
        // 2-second scan does not immediately resurrect the closed vessel.
        isDismissed: (filePath) => this.runtime.dismissalTracker.isDismissed(filePath),
      });
      for (const session of sessions) this.upsertDiscoveredCodexSession(session);
    };

    scan();
    this.codexDiscoveryTimer = setInterval(scan, 2_000);
  }

  private upsertDiscoveredCodexSession(session: CodexSessionMetadata): void {
    let agent: AgentState | undefined;
    for (const candidate of this.store.values()) {
      if (
        candidate.runtime === 'codex-cli' &&
        (candidate.sessionId === session.sessionId || candidate.jsonlFile === session.filePath)
      ) {
        agent = candidate;
        break;
      }
    }

    // A Fleet-launched Codex terminal starts with a placeholder session id.
    // Adopt the native JSONL session once Codex creates it instead of adding a
    // second external vessel for the same terminal.
    if (!agent) {
      const managedInstanceId = findManagedCodexAgentCandidate(
        [...this.store.values()]
          .filter((candidate) => candidate.runtime === 'codex-cli')
          .map((candidate) => ({
            instanceId: `agent-${candidate.id}`,
            runtime: 'codex-cli' as const,
            managedByFleet: candidate.managedByFleet,
            isExternal: candidate.isExternal,
            cwd: candidate.cwd ?? candidate.projectDir,
            createdAt: candidate.createdAt,
            sessionId: candidate.sessionId,
            jsonlFile: candidate.jsonlFile,
            terminalAttached: candidate.terminalRef !== undefined,
          })),
        session,
      );
      if (managedInstanceId) {
        const id = parseAgentInstanceId(managedInstanceId);
        agent = this.store.get(id);
        if (agent) {
          agent.sessionId = session.sessionId;
          agent.jsonlFile = session.filePath;
          agent.isExternal = false;
          agent.managedByFleet = true;
          agent.hooksOnly = true;
          agent.hostId = agent.hostId ?? this.codexRuntimeHost.hostId;
          this.store.persist();
          this.syncControlInstance(agent);
        }
      }
    }

    if (!agent) {
      const id = this.store.nextAgentId.current++;
      agent = {
        id,
        sessionId: session.sessionId,
        runtime: 'codex-cli',
        terminalRef: undefined,
        isExternal: true,
        projectDir: session.cwd,
        cwd: session.cwd,
        hostId: 'codex-cli-external',
        workspaceId: session.cwd,
        terminalId: undefined,
        launchSource: 'auto-discovery',
        requestedBy: 'external',
        jsonlFile: session.filePath,
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
        hookDelivered: false,
        hooksOnly: true,
        lastDataAt: session.lastActivityAt,
        linesProcessed: 1,
        seenUnknownRecordTypes: new Set(),
        contextTokens: 0,
        maxContextTokens: session.contextWindow ?? DEFAULT_MAX_CONTEXT_TOKENS,
        providerId: 'codex-cli',
        providerDisplayName: 'Codex CLI · 本机登录',
        modelId: session.modelId,
        managedByFleet: false,
        createdAt: session.lastActivityAt,
      };
      assignPaletteIfNeeded(agent, this.store);
      this.applyCodexVisualStatus(agent, session.status);
      agent.usageTokens = session.tokens;
      this.store.set(id, agent);
      this.store.persist();
      this.store.broadcast({ type: 'agentStatus', id, status: session.status });
      this.publishCodexUsage(agent, session);
      console.log(
        `[Claude Fleet] Codex: auto-discovered external session ${session.sessionId.slice(0, 8)}...`,
      );
      return;
    }

    const previousStatus = agentStateToUserStatus(agent);
    const previousActivity = agent.lastDataAt;
    agent.cwd = session.cwd;
    agent.projectDir = session.cwd;
    agent.workspaceId = session.cwd;
    agent.jsonlFile = session.filePath;
    agent.lastDataAt = session.lastActivityAt;
    agent.linesProcessed = Math.max(agent.linesProcessed, 1);
    agent.modelId = session.modelId ?? agent.modelId;
    agent.maxContextTokens = session.contextWindow ?? agent.maxContextTokens;
    agent.usageTokens = session.tokens ?? agent.usageTokens;
    this.applyCodexVisualStatus(agent, session.status);
    // Refresh the control-plane session id before recording usage. Without
    // this, the first native token snapshot would remain attached to the
    // launch placeholder session.
    this.syncControlInstance(agent);
    if (session.tokens) this.store.persist();

    if (previousStatus !== session.status || previousActivity !== session.lastActivityAt) {
      this.store.broadcast({ type: 'agentStatus', id: agent.id, status: session.status });
    }
    this.publishCodexUsage(agent, session);
  }

  private publishCodexUsage(agent: AgentState, session: CodexSessionMetadata): void {
    if (!session.tokens) return;
    this.store.broadcast({
      type: 'agentContextUsage',
      id: agent.id,
      contextTokens: agent.contextTokens,
      maxContextTokens: agent.maxContextTokens,
      usage: session.tokens,
    });
    this.controlService.recordLiveUsage(
      this.controlInstanceId(agent),
      'codex-cli',
      agent.providerDisplayName ?? 'Codex CLI · 本机登录',
      session.modelId ?? agent.modelId,
      session.tokens,
      session.lastActivityAt,
      session.durationMs,
    );
  }

  private applyCodexVisualStatus(agent: AgentState, status: CodexDiscoveredStatus): void {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.isWaiting = status === 'waiting';
    if (status === 'working') {
      // The shared status projection uses activeToolIds as its working signal;
      // keep the synthetic id out of activeToolStatuses so no fake tool appears.
      agent.activeToolIds.add('codex-session-active');
    }
  }

  dispose() {
    this.claudeFleetServer?.stop();
    this.claudeFleetServer = null;
    if (this.codexDiscoveryTimer) clearInterval(this.codexDiscoveryTimer);
    this.codexDiscoveryTimer = null;
    void this.ownedClaudeRuntime.dispose();
    this.runtime.dispose();
    this.layoutWatcher?.dispose();
    this.layoutWatcher = null;
    this.store.dispose();
  }
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

  let html = fs.readFileSync(indexPath, 'utf-8');

  html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
    const fileUri = vscode.Uri.joinPath(distPath, filePath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return `${attr}="${webviewUri}"`;
  });

  return html;
}

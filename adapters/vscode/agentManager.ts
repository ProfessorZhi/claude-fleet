import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { InstanceLaunchConfig } from '../../core/src/providerProfiles.js';
import { INHERIT_PROVIDER_PROFILE_ID } from '../../core/src/providerProfiles.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { agentStateToUserStatus } from '../../server/src/agentStatus.js';
import { resolveClaudeCli } from '../../server/src/cliResolver.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import {
  ensureProjectScan,
  readNewLines,
  reassignAgentToFile,
  startFileWatching,
} from '../../server/src/fileWatcher.js';
import { resolveClaudeLaunchConfig } from '../../server/src/launchConfig.js';
import { MissingSecretError } from '../../server/src/launchConfig.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from '../../server/src/providers/hook/claude/constants.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { AgentState, PersistedAgent } from '../../server/src/types.js';
import { detectShellKind, renderLaunchCommand } from './launchCommandRender.js';
import type { ProviderProfileStore } from './providerProfileStore.js';
import type { SecretStorageProvider } from './secretStorageProvider.js';

/**
 * Options accepted by `launchNewTerminal` (Spec 002 — collapsed positional args
 * into an object to keep call sites readable).
 *
 * `providerProfileStore` and `secretStorageProvider` are required for Spec 002
 * even when using the built-in "Inherit" profile (the resolver still needs to
 * call `secretLookup` even if no secret will be set).
 */
export interface LaunchNewTerminalOptions {
  /** Optional explicit cwd override; defaults to launchConfig.cwd or first workspace. */
  folderPath?: string;
  /** Per-instance Provider / Model / cwd intent (Spec 002). */
  launchConfig?: InstanceLaunchConfig;
  /** When true, pass `--dangerously-skip-permissions`. */
  bypassPermissions?: boolean;
  /** When true, do not call `terminal.show()` (used by auto-spawn). */
  suppressShow?: boolean;
  /** Safe lifecycle provenance recorded with the managed instance. */
  launchSource?: string;
  /** Safe requester identity recorded with the managed instance. */
  requestedBy?: string;
  providerProfileStore: ProviderProfileStore;
  secretStorageProvider: SecretStorageProvider;
}

/**
 * Adapter-layer glue: pull a Profile from the store, look up its secret via
 * SecretStorage, and run the pure `resolveClaudeLaunchConfig` function.
 *
 * Async because SecretStorage.get is async. We resolve the secret once here
 * and pass a sync closure into the pure resolver.
 *
 * Never logs the secret value; if the secret is missing for a non-inherit
 * profile, the resolver deliberately omits the env var (Claude Code will
 * fall back to its other auth sources; the UI surfaces the missing-secret
 * condition via AgentState fields elsewhere).
 */
async function resolveLaunchConfigFromStore(args: {
  launchConfig: InstanceLaunchConfig;
  providerProfileStore: ProviderProfileStore;
  secretStorageProvider: SecretStorageProvider;
  bypassPermissions?: boolean;
}): Promise<ReturnType<typeof resolveClaudeLaunchConfig>> {
  const profile = args.providerProfileStore.get(args.launchConfig.providerProfileId);
  if (!profile) {
    throw new Error(
      `launchNewTerminal: provider profile "${args.launchConfig.providerProfileId}" not found.`,
    );
  }

  let secret: string | undefined;
  if (profile.secretRef) {
    try {
      secret = await args.secretStorageProvider.get(profile.secretRef);
    } catch (e) {
      // Deliberately do NOT log e.message if it might contain the secret.
      // The store layer throws Error instances with the ref name (not the
      // secret) so this is safe.
      console.error(
        `[Claude Fleet] launchNewTerminal: failed to read secret for profile "${profile.id}".`,
      );
      throw e;
    }
  }

  // sessionId is generated inside launchNewTerminal AFTER this resolver runs;
  // we pass a placeholder here. The resolver's args still include it for
  // completeness, but the canonical args source is `buildLaunchCommand` in
  // launchNewTerminal, which appends the real session id.
  return resolveClaudeLaunchConfig(
    profile,
    args.launchConfig.modelId,
    args.launchConfig.cwd ?? '',
    '00000000-0000-0000-0000-000000000000',
    (_ref) => secret,
    { bypassPermissions: args.bypassPermissions, fleet: args.launchConfig.fleet },
  );
}

export function getProjectDirPath(cwd?: string): string {
  // Fall back to home directory when no workspace folder is open (common on Linux/macOS
  // when VS Code is launched without a folder). The provider's getSessionDirs already
  // implements the Windows case-insensitive fallback for drive-letter casing.
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirs = claudeProvider.getSessionDirs?.(workspacePath) ?? [];
  if (dirs.length === 0) {
    throw new Error('claudeProvider.getSessionDirs returned no directories');
  }
  const projectDir = dirs[0];
  console.log(`[Claude Fleet] Terminal: Project dir: ${workspacePath} → ${projectDir}`);
  return projectDir;
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  persistAgents: () => void,
  options: LaunchNewTerminalOptions,
): Promise<AgentState | undefined> {
  const {
    folderPath,
    launchConfig,
    bypassPermissions,
    suppressShow,
    providerProfileStore,
    secretStorageProvider,
  } = options;
  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location that matches the project
  // dir hash Claude Code will use for JSONL transcript files.
  const cwd = folderPath || launchConfig?.cwd || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;

  // ── Resolve Provider Profile + secret → env + safeMetadata (Spec 002) ──
  // Fail-closed (FR-004 + FR-010): if the Custom Provider has a missing or
  // empty Secret, MissingSecretError is thrown BEFORE we touch
  // vscode.window.createTerminal. We surface the error message via
  // showErrorMessage and return early — no Terminal is created, no Agent
  // is registered. The Launch Flow caller simply sees a clean abort.
  let resolved: Awaited<ReturnType<typeof resolveLaunchConfigFromStore>>;
  try {
    resolved = await resolveLaunchConfigFromStore({
      launchConfig: launchConfig ?? {
        cwd,
        providerProfileId: INHERIT_PROVIDER_PROFILE_ID,
      },
      providerProfileStore,
      secretStorageProvider,
      bypassPermissions,
    });
  } catch (e) {
    if (e instanceof MissingSecretError) {
      console.error(`[Claude Fleet] launch aborted: ${e.message}`);
      void vscode.window.showErrorMessage(e.message);
      // Roll back the terminal-index increment so the next launch uses
      // the same number — avoids leaving a "gap" in #N labels.
      nextTerminalIndexRef.current = idx;
      return;
    }
    throw e;
  }

  const terminal = vscode.window.createTerminal({
    name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
    env: resolved.env,
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  // Spec 005 Session Continuity: explicit sessionId (Restart/Switch resume)
  // or a fresh UUID for a new session.
  const sessionMode = launchConfig?.sessionMode ?? 'new';
  const sessionId = launchConfig?.sessionId ?? crypto.randomUUID();
  const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions,
    modelId: resolved.safeMetadata.modelId,
    sessionMode,
  });
  if (!launch) {
    throw new Error('claudeProvider.buildLaunchCommand is not implemented');
  }
  // Runtime launch goes through the CLI resolver: PATH + npm global bin,
  // Windows claude.cmd/claude.exe support, no env mutation (Spec 005 FR-008).
  const cliResolution = await resolveClaudeCli();
  const command = cliResolution.ok ? cliResolution.command : launch.command;
  // Shell-aware rendering: a resolved absolute path may contain spaces, and
  // the integrated terminal's shell (cmd.exe / PowerShell / sh) has
  // different quoting grammar — detect it via vscode.env.shell and render
  // accordingly (see launchCommandRender.ts).
  terminal.sendText(
    renderLaunchCommand(command, launch.args, {
      platform: process.platform,
      shellKind: detectShellKind(vscode.env.shell, process.platform),
    }),
  );

  const projectDir = getProjectDirPath(cwd);

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  const id = nextAgentIdRef.current++;
  // areaMappings is keyed by WorkspaceFolder.name, which can differ from the dir
  // basename, so seat placement needs that name. Pick the most specific containing
  // folder (longest path wins for nested folders).
  const owningFolder = (folders ?? [])
    .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  const folderName = isMultiRoot
    ? (owningFolder?.name ?? (cwd ? path.basename(cwd) : undefined))
    : undefined;
  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    // Exact repo the user picked at launch — Restart must reuse THIS, not the
    // derived transcript projectDir (Spec: preserve repo cwd across restart).
    cwd,
    hostId: 'vscode-integrated-terminal',
    workspaceId: cwd,
    terminalId: `terminal-agent-${id}`,
    launchSource: options.launchSource ?? (sessionMode === 'resume' ? 'resume' : 'fleet-ui'),
    requestedBy: options.requestedBy ?? 'user',
    jsonlFile: expectedFile,
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
    folderName,
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    // Spec 002 — Provider / Model metadata (non-secret).
    providerProfileId: resolved.safeMetadata.providerProfileId,
    providerDisplayName: resolved.safeMetadata.providerDisplayName,
    modelId: resolved.safeMetadata.modelId,
    fleet: resolved.safeMetadata.fleet,
    // Spec 003 — launch timestamp (transient; drives the "transcript never
    // appeared" error heuristic in agentStatus.ts).
    createdAt: Date.now(),
    // Spec 005 — Fleet 启动的实例；Auto Discovery 重发现时据此恢复
    // Provider / Model（外部 agent 无此标记 → External / Unknown）。
    managedByFleet: true,
  };

  assignPaletteIfNeeded(agent, agents);
  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Claude Fleet] Terminal: Agent ${id} - created for terminal ${terminal.name}`);

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimerRef,
    activeAgentIdRef,
    nextAgentIdRef,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    persistAgents,
  );

  // Poll for the specific JSONL file to appear
  const createdAt = Date.now();
  let pollCount = 0;
  console.log(`[Claude Fleet] Terminal: Agent ${id} - waiting for JSONL at ${agent.jsonlFile}`);
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        console.log(
          `[Claude Fleet] Terminal: Agent ${id} - found JSONL file ${path.basename(agent.jsonlFile)} (after ${pollCount}s)`,
        );
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
        readNewLines(id, agents, waitingTimers, permissionTimers);
      } else if (pollCount === 10) {
        // After 10s of polling, warn with path details to help diagnose path encoding mismatches
        const dirExists = fs.existsSync(projectDir);
        let dirContents = '';
        if (dirExists) {
          try {
            const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
            dirContents =
              files.length > 0
                ? `Dir has ${files.length} JSONL file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
                : 'Dir exists but has no JSONL files';
          } catch {
            dirContents = 'Dir exists but unreadable';
          }
        } else {
          dirContents = 'Dir does not exist';
        }
        console.warn(
          `[Claude Fleet] Terminal: Agent ${id} - JSONL file not found after 10s. ` +
            `Expected: ${agent.jsonlFile}. ${dirContents}`,
        );
      } else if (pollCount > 10) {
        // Possible /resume: terminal started a different session than expected.
        // Check every tick for a file modified after the agent was created.
        try {
          const trackedFiles = new Set([...agents.values()].map((a) => path.resolve(a.jsonlFile)));
          const candidates = fs
            .readdirSync(projectDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const full = path.join(projectDir, f);
              return { file: full, mtime: fs.statSync(full).mtimeMs };
            })
            .filter((c) => !trackedFiles.has(path.resolve(c.file)) && c.mtime > createdAt)
            .sort((a, b) => b.mtime - a.mtime); // newest first

          if (candidates.length > 0) {
            console.log(
              `[Claude Fleet] Terminal: Agent ${id} - /resume detected, reassigning to ${path.basename(candidates[0].file)}`,
            );
            clearInterval(pollTimer);
            jsonlPollTimers.delete(id);
            reassignAgentToFile(
              id,
              candidates[0].file,
              agents,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
            );
          }
        } catch {
          /* ignore scan errors */
        }
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
  return agent;
}

export function removeAgent(
  agentId: number,
  store: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
  const agent = store.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from store (fires agentRemoved event) and persist
  store.delete(agentId);
  store.persist();
}

/**
 * Reference implementation of the AgentState → PersistedAgent projection: it shows
 * exactly which fields survive a reload. Kept as the worked example for adapters that
 * persist through a StateAdapter directly; AgentStateStore.persist() is what the
 * VS Code surface calls at runtime.
 *
 * @public
 */
export function persistAgents(agents: AgentStateStore, adapter: StateAdapter): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    // Background-spawn children are derived state — never persisted (the 1s
    // scan re-materializes them from sidecars after a restore).
    if (agent.spawnToolUseId) continue;
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      // Original launch cwd — persists the exact repo for Restart (legacy
      // agents have none; restore keeps it undefined).
      cwd: agent.cwd,
      hostId: agent.hostId,
      workspaceId: agent.workspaceId,
      terminalId: agent.terminalId,
      launchSource: agent.launchSource,
      requestedBy: agent.requestedBy,
      folderName: agent.folderName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
      backgroundAgentToolIds:
        agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
      // Spec 002 — Provider / Model. NOT secrets, safe to persist (mirrors
      // AgentStateStore.persist, which is the runtime path).
      providerProfileId: agent.providerProfileId,
      providerDisplayName: agent.providerDisplayName,
      modelId: agent.modelId,
      fleet: agent.fleet,
      // Spec 005 — managed flag + pre-switch provider (NOT secrets).
      managedByFleet: agent.managedByFleet,
      lastProviderProfileId: agent.lastProviderProfileId,
    });
  }
  adapter.saveAgents(persisted);
}

export function restoreAgents(
  adapter: StateAdapter,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  store: AgentStateStore,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
): void {
  const persisted = adapter.loadAgents();
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  // IDs of agents we ACTUALLY restored in this call (newly added to the store).
  // The cleanup pass below targets only these; pre-existing agents (e.g., a
  // freshly launched one whose webview just remounted and re-fired
  // webviewReady) must not be culled by this restore-time grace period, since
  // their JSONL may still be on its way (heuristic /resume path waits ~11s).
  const justRestoredTerminalIds: number[] = [];

  for (const p of persisted) {
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (store.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    // Background-spawn children (a leadAgentId but no teamName) are derived
    // state re-materialized by the 1s scan — never restored directly (also
    // skips stale entries written by older builds that persisted them).
    if (p.leadAgentId !== undefined && !p.teamName) continue;

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

    if (isExternal) {
      // External agents — restore if JSONL file still exists on disk
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
    } else {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent: AgentState = {
      id: p.id,
      sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      // Restore the original launch cwd for Restart; undefined on legacy state.
      cwd: p.cwd,
      hostId: p.hostId,
      workspaceId: p.workspaceId,
      terminalId: p.terminalId,
      launchSource: p.launchSource,
      requestedBy: p.requestedBy,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      // Live spawn ids survive the reload so the 1s scan can re-adopt the
      // spawns' transcripts and the completion queue-op still matches.
      backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: p.folderName,
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      teamName: p.teamName,
      agentName: p.agentName,
      // A named agent is a teammate; never restore it as a lead (guards against
      // state persisted before linkTeammates stopped promoting teammates).
      isTeamLead: p.agentName ? undefined : p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
      palette: p.palette,
      hueShift: p.hueShift,
      // Spec 002 — Provider / Model restored from persistence. NOT secrets.
      providerProfileId: p.providerProfileId,
      providerDisplayName: p.providerDisplayName,
      modelId: p.modelId,
      fleet: p.fleet,
      // Spec 005 — managed flag + pre-switch provider restored. Absent on
      // legacy / external agents.
      managedByFleet: p.managedByFleet,
      lastProviderProfileId: p.lastProviderProfileId,
    };

    assignPaletteIfNeeded(agent, store);
    store.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    if (isExternal) {
      console.log(
        `[Claude Fleet] Terminal: Agent ${p.id} - restored external → ${path.basename(p.jsonlFile)}`,
      );
    } else {
      console.log(
        `[Claude Fleet] Terminal: Agent ${p.id} - restored → terminal "${p.terminalName}"`,
      );
      justRestoredTerminalIds.push(p.id);
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          store,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Claude Fleet] Terminal: Agent ${p.id} - found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                store,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // After a short delay, remove terminal agents that we JUST restored from
  // workspaceState and which never received data. These are dead terminals
  // restored by VS Code (e.g., after a window reload) where Claude is no
  // longer running. Only target the IDs the loop above actually added — never
  // pre-existing agents from launchNewTerminal in the same session whose
  // expected JSONL may still be on its way (heuristic /resume waits ~11s).
  if (justRestoredTerminalIds.length > 0) {
    setTimeout(() => {
      for (const id of justRestoredTerminalIds) {
        const agent = store.get(id);
        if (agent && !agent.isExternal && agent.linesProcessed === 0) {
          console.log(
            `[Claude Fleet] Terminal: Agent ${id} - removing restored agent, no data received`,
          );
          agent.terminalRef?.dispose();
          removeAgent(
            id,
            store,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
          );
        }
      }
    }, 10_000); // 10 seconds grace period
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  store.persist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      store,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => store.persist(),
    );
  }
}

export function sendExistingAgents(
  agents: AgentStateStore,
  adapter: StateAdapter,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = adapter.loadSeats();

  // Include folderName and isExternal per agent
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Claude Fleet] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: AgentStateStore,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      const toolName = agent.activeToolNames.get(toolId) ?? '';
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName,
      });
    }
    // Re-send current user-facing status (Spec 003). The webview re-requests
    // state after remounts, so push the derived status as an upsert; the
    // webview treats agentStatus as "record current user status".
    webview.postMessage({
      type: 'agentStatus',
      id: agentId,
      status: agentStateToUserStatus(agent),
    });
    // Re-send team metadata. Derived teams (named background spawns) have a
    // name and a lead link but NO teamName, so gate on any team field.
    if (agent.teamName || agent.agentName || agent.isTeamLead) {
      webview.postMessage({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }
    // Re-send context usage
    if (agent.contextTokens > 0) {
      webview.postMessage({
        type: 'agentContextUsage',
        id: agentId,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }
  }
}

export function sendLayout(
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = loadLayout(defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}

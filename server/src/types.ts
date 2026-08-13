import type * as vscode from 'vscode';

import type { FleetIdentity } from '../../core/src/fleetContracts.js';
import type { TokenUsage } from '../../core/src/ledgerContracts.js';
import type { FleetRuntime } from '../../core/src/runtimeContracts.js';

export interface AgentState {
  id: number;
  sessionId: string;
  /** Runtime selected for this managed Worker. Legacy agents default to Claude Code. */
  runtime?: FleetRuntime;
  /** Terminal reference — undefined for extension panel sessions */
  terminalRef?: vscode.Terminal;
  /** Whether this agent was detected from an external source (VS Code extension panel, etc.) */
  isExternal: boolean;
  projectDir: string;
  /** Original repo cwd at launch (Spec: Restart uses THIS, not projectDir).
   *  projectDir is the Claude transcript directory derived from cwd and is NOT
   *  guaranteed to equal the user's chosen repo. Absent on legacy (001-era)
   *  and scan-discovered agents — Restart falls back to projectDir only then. */
  cwd?: string;
  /** Fleet management host that owns this runtime instance. */
  hostId?: string;
  /** Stable workspace identity used by Fleet ownership/accounting. */
  workspaceId?: string;
  /** Fleet terminal identity; distinct from the human-readable terminal name. */
  terminalId?: string;
  /** Stable Fleet control-plane instance id, distinct from the local numeric id. */
  fleetInstanceId?: string;
  /** Safe lifecycle provenance such as fleet-ui, restart, or auto-spawn. */
  launchSource?: string;
  /** Safe requester identity; never a credential or transcript. */
  requestedBy?: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  backgroundAgentToolIds: Set<string>; // tool IDs for run_in_background Agent calls (stay alive until queue-operation)
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** User-facing Fleet label; independent from the Claude Team role name. */
  displayName?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Whether a hook event has been delivered for this agent (suppresses heuristic timers) */
  hookDelivered: boolean;
  /** True only when the runtime emitted a SessionStart for this exact session. */
  sessionStartReceived?: boolean;
  /** True when Claude's native session metadata proves this exact session is ready. */
  nativeSessionReady?: boolean;
  /** Effective CLAUDE_CONFIG_DIR injected into this managed terminal. */
  runtimeConfigDir?: string;
  /** True when agent has no transcript file (provider doesn't use JSONL). All state from hooks. */
  hooksOnly?: boolean;
  /** Provider that created this agent (defaults to 'claude') */
  providerId?: string;
  /** Set when SessionEnd(reason=clear) fires; cleared when SessionStart(source=clear) reassigns */
  pendingClear?: boolean;
  /** Hook-generated tool ID for PreToolUse/PostToolUse correlation */
  currentHookToolId?: string;
  /** Tool name from the most recent PreToolUse, used to correlate a later SubagentStart
   *  event with the parent tool that launched it. */
  currentHookToolName?: string;
  /** Synthetic transcript activity id while Claude is emitting thinking blocks. */
  reasoningToolId?: string;
  /** True if the CURRENT PreToolUse tool call is a teammate spawn (per the provider's
   *  `team.isTeammateSpawnCall`). Authoritative source for teammate vs basic-subagent
   *  routing in SubagentStart. Set in PreToolUse, NOT cleared in PostToolUse (survives
   *  the PostToolUse-before-SubagentStart race); overwritten on the next PreToolUse. */
  currentHookIsTeammateSpawn?: boolean;

  // -- Context window usage (server/src/contextUsage.ts) --
  /** Tokens in the agent's context as of its newest turn; 0 until one is seen.
   *  A snapshot, not a running total -- it falls on compaction and /clear. */
  contextTokens: number;
  /** Observational estimate of the window `contextTokens` fits in. Widens as
   *  larger contexts appear, never shrinks. */
  maxContextTokens: number;
  /** True once this transcript produced a main-chain turn, after which
   *  sidechain records belong to sub-agents and stop moving the gauge. */
  sawMainChainUsage?: boolean;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  /** True when teamName was read from the session's own record tags (tmux/
   *  inline teams, teammate sessions). Tag identity is authoritative: spawn-
   *  result re-latching (implicit-team generations on resume) only applies to
   *  tag-less leads. Transient — not persisted. */
  teamNameFromTags?: boolean;
  isTeamLead?: boolean;
  leadAgentId?: number;
  /** True when lead spawns teammates via tmux (run_in_background Agent calls) */
  teamUsesTmux?: boolean;
  /** For a promoted anonymous background agent (teams OFF): the lead's Agent
   *  tool_use id that spawned it. Links this character to the lead's
   *  backgroundAgentToolIds entry so the queue-operation completion removes it. */
  spawnToolUseId?: string;
  /** Tool ids of spawn calls whose input carried a `name` — teammates-to-be.
   *  Every agentToolStart (re-)broadcast for these carries isTeammateSpawn so
   *  the webview never creates a Subtask ghost for them. Transient, lazily
   *  created, never persisted. */
  teammateSpawnToolIds?: Set<string>;

  // -- Avatar customization --
  /** Preferred character palette (0-5). If undefined, auto-assigned for diversity. */
  palette?: number;
  /** Hue shift in degrees (0-360). Rotates the base palette colors. */
  hueShift?: number;

  // -- Provider / Model (Spec 002) --
  /** Provider profile id used at launch. Persisted so the UI can show the
   *  source of an agent even after restart. NOT a secret. */
  providerProfileId?: string;
  /** Display name of the provider profile (for UI). Persisted alongside id. */
  providerDisplayName?: string;
  /** Model id passed as `claude --model <id>` at launch. Persisted. */
  modelId?: string;
  /** Provider/model request and resolution evidence. Never a secret. */
  requestedProviderProfileId?: string;
  resolvedProviderProfileId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  credential?: 'present' | 'absent';
  refPresent?: boolean;
  refResolution?: 'success' | 'not_required';
  authConfigured?: boolean;
  authInjected?: boolean;
  authVariableNames?: string[];
  baseUrlHost?: string;
  /** Secret-free Coordinator/Worker correlation metadata. */
  fleet?: FleetIdentity;

  // -- Spec 005 Session Continuity / Managed flag --
  /** True when this agent was launched by Fleet (vs. discovered externally).
   *  Persisted so Auto Discovery can restore Provider/Model after a reload. */
  managedByFleet?: boolean;
  /** Provider profile id used BEFORE a Switch Provider (for diagnostics /
   *  potential revert). NOT a secret. Transient-ish; persisted for parity. */
  lastProviderProfileId?: string;

  // -- Spec 003 status --
  /** Launch timestamp (ms since epoch). TRANSIENT — never persisted; used by
   *  the error heuristic ("transcript never appeared within N seconds after
   *  launch") in server/src/agentStatus.ts. Restored agents keep undefined
   *  and skip the timeout rule. */
  createdAt?: number;
  /** Cumulative token usage observed from the native runtime transcript. */
  usageTokens?: TokenUsage;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  /** Runtime selected for this managed Worker. */
  runtime?: FleetRuntime;
  /** Terminal name — empty string for extension panel sessions */
  terminalName: string;
  /** Whether this agent was detected from an external source */
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  /** Original repo cwd at launch. Persisted so Restart reuses the exact repo
   *  instead of re-deriving it from projectDir. Absent on legacy persisted
   *  state (cwd added in 0.1.0). */
  cwd?: string;
  hostId?: string;
  workspaceId?: string;
  terminalId?: string;
  /** Stable Fleet control-plane instance id, distinct from the local numeric id. */
  fleetInstanceId?: string;
  launchSource?: string;
  requestedBy?: string;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** User-facing Fleet label; independent from the Claude Team role name. */
  displayName?: string;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  /** Live background-spawn tool ids on a lead. Persisted so the spawns'
   *  transcripts are re-adopted after a reload; the spawned children
   *  themselves are derived state and never persisted. */
  backgroundAgentToolIds?: string[];
  /** Preferred character palette (0-5). Persisted so colors stay stable
   *  across server restarts; assignPaletteIfNeeded is a no-op on restore. */
  palette?: number;
  /** Hue shift in degrees (0-360). Persisted alongside palette. */
  hueShift?: number;

  // -- Provider / Model (Spec 002) --
  /** Provider profile id used at launch. NOT a secret. */
  providerProfileId?: string;
  providerDisplayName?: string;
  /** Model id passed as `claude --model <id>` at launch. */
  modelId?: string;
  requestedProviderProfileId?: string;
  resolvedProviderProfileId?: string;
  requestedModelId?: string;
  resolvedModelId?: string;
  credential?: 'present' | 'absent';
  refPresent?: boolean;
  refResolution?: 'success' | 'not_required';
  authConfigured?: boolean;
  authInjected?: boolean;
  authVariableNames?: string[];
  baseUrlHost?: string;
  /** Secret-free Coordinator/Worker correlation metadata. */
  fleet?: FleetIdentity;

  // -- Spec 005 Session Continuity / Managed flag --
  /** True when launched by Fleet (vs discovered externally). Persisted so
   *  Auto Discovery restores Provider/Model after a reload. */
  managedByFleet?: boolean;
  /** Launch timestamp used for elapsed-time display after reload. */
  createdAt?: number;
  /** Cumulative, secret-free token counters observed for this session. */
  usageTokens?: TokenUsage;
  /** Provider profile id used before a Switch Provider. NOT a secret. */
  lastProviderProfileId?: string;
}

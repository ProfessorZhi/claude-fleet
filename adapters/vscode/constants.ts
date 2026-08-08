// ── User-Level Layout Persistence (re-exports from server/) ──
// The user-level persistence contract, surfaced as one adapter-facing barrel so
// VS Code code never reaches into server/src/constants.js directly. Only
// LAYOUT_REVISION_KEY has an adapter consumer today (ClaudeFleetViewProvider);
// the rest travel with it because they describe the same ~/.pixel-agents
// file layout, and splitting the set would leave the next caller guessing which
// half to import from where.
//
// NOTE: persistence namespace ("pixel-agents") is intentionally preserved on
// disk to keep compatibility with the upstream baseline. Branding at the
// adapter layer (commands, view id, config keys) uses "claude-fleet".
/** @public */
export {
  CONFIG_FILE_NAME,
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_NAME,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  LAYOUT_REVISION_KEY,
} from '../../server/src/constants.js';

// ── Settings Persistence (VS Code globalState keys) ─────────
// NOTE: persistence keys intentionally kept as upstream "pixel-agents.*" so
// Claude Fleet shares the same on-disk state shape with the upstream baseline.
// (See 001 design "命名空间策略" — Persistence namespace 保留上游值。)
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
export const GLOBAL_KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
export const GLOBAL_KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
export const GLOBAL_KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
export const GLOBAL_KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
export const GLOBAL_KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
export const GLOBAL_KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
export const GLOBAL_KEY_SHOW_AREAS = 'pixel-agents.showAreas';

/**
 * Folder→Area mappings live inside the shared ~/.pixel-agents/config.json
 * (vscode.areaMappings), not in VS Code globalState. Kept here as a key
 * constant for callers that need to reference it symbolically.
 *
 * @public
 */
export const SETTING_KEY_AREA_MAPPINGS = 'pixel-agents.areaMappings';

// ── VS Code Settings (contributes.configuration keys) ───────
// User-facing config keys are renamed to the Claude Fleet namespace.
export const CONFIG_KEY_AUTO_SHOW_PANEL = 'claudeFleet.autoShowPanel';
export const CONFIG_KEY_AUTO_SPAWN_AGENT = 'claudeFleet.autoSpawnAgent';

// ── VS Code Identifiers ─────────────────────────────────────
// User-facing command / view ids are renamed to the Claude Fleet namespace.
// Internal persistence keys (above) and provider-side namespaces (in server/)
// keep the upstream values for compatibility — see the design decision in
// docs/specs/001-multi-instance-runtime/design.md.
export const VIEW_ID = 'claude-fleet.panelView';
export const COMMAND_SHOW_PANEL = 'claude-fleet.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'claude-fleet.exportDefaultLayout';

// Spec 002 — commands introduced with Provider / Model isolation.
export const COMMAND_NEW_AGENT = 'claude-fleet.newAgent';
export const COMMAND_MANAGE_PROVIDERS = 'claude-fleet.manageProviders';

// Spec 004 — instance control commands.
export const COMMAND_FOCUS_AGENT = 'claude-fleet.focusAgent';
export const COMMAND_STOP_AGENT = 'claude-fleet.stopAgent';
export const COMMAND_RESTART_AGENT = 'claude-fleet.restartAgent';

// Spec 005 — session continuity commands.
export const COMMAND_NEW_SESSION = 'claude-fleet.newSession';
export const COMMAND_SWITCH_PROVIDER = 'claude-fleet.switchProvider';

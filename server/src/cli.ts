#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx claude-fleet`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * Loads all assets (PNGs -> SpriteData) on startup and caches in memory.
 * Each connecting WebSocket client receives the full state on webviewReady.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

import { getProviderDefinition } from '../../core/src/providerRegistry.js';
import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import {
  buildAssetCache,
  loadAllCharacters,
  loadAllFurniture,
  loadAllPets,
} from './assetReload.js';
import type { AssetCache, ReloadAssetsSideEffect } from './clientMessageHandler.js';
import { createCliProviderStore } from './cliProviderStore.js';
import { resolveClaudeCli } from './cliResolver.js';
import { readConfig } from './configPersistence.js';
import { MAX_PORT, MIN_PORT } from './constants.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { resolveClaudeLaunchConfig } from './launchConfig.js';
import { migrateStateDir } from './migrateStateDir.js';
import { claudeProvider, copyHookScript } from './providers/index.js';
import { ClaudeFleetServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

export interface CliArgs {
  /** Spec 005 subcommand: 'providers' | 'launch' | undefined (standalone server). */
  command?: 'providers' | 'launch';
  /** Unset -> ephemeral (OS-assigned) port, so multiple standalone instances
   *  can run at once without a collision. --port picks a fixed one. */
  port?: number;
  host: string;
}

/** Thrown by parseArgs on an invalid --port. Kept separate from process.exit so
 *  the parsing logic stays a pure, unit-testable function -- main() is the only
 *  place that turns a bad argument into an exit code. */
export class CliArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'providers' || arg === 'launch') {
      args.command = arg;
      continue;
    }
    if (arg === '--port' || arg === '-p') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        throw new CliArgsError(
          `Missing value for ${arg}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
        throw new CliArgsError(
          `Invalid --port "${raw}": must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        );
      }
      args.port = parsed;
      i++;
    } else if (arg === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (arg === '--help') {
      console.log(`Usage: claude-fleet [command] [options]

Commands:
  providers              List configured Provider Profiles
  launch                 Interactively launch a native Claude Code session

Options (standalone server):
  --port, -p <number>   Port to listen on (default: OS-assigned ephemeral port)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Spec 005 CLI: providers / launch ─────────────────────────

/** List configured Provider Profiles (never prints secrets). */
export function runProvidersCommand(): void {
  migrateStateDir();
  const store = createCliProviderStore();
  const profiles = store.list();
  if (profiles.length === 0) {
    console.log('No Provider Profiles configured.');
    console.log('Use "claude-fleet launch" to create one interactively.');
    return;
  }
  console.log('Configured Provider Profiles:');
  for (const p of profiles) {
    const def = p.presetId ? getProviderDefinition(p.presetId) : undefined;
    const type = def?.displayName ?? p.providerType ?? 'Custom';
    const status = p.enabled === false ? 'disabled' : 'enabled';
    console.log(`  [${status}] ${p.name} (${type})`);
    if (p.baseUrl) console.log(`        endpoint: ${p.baseUrl}`);
    console.log(
      `        auth: ${p.authMode === 'inherit' ? 'native login' : p.authMode}${p.defaultModelId ? ` · default model: ${p.defaultModelId}` : ''}`,
    );
  }
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

/**
 * Interactively launch a native `claude` session (Spec 005 FR-014):
 * Repo(cwd) → Provider Profile → Model → New/Resume → resolve → spawn claude.
 * Uses the SAME ProviderRegistry + resolver as the VS Code adapter.
 */
export async function runLaunchCommand(): Promise<void> {
  migrateStateDir();
  const store = createCliProviderStore();

  // 1. Repo = current working directory (documented behavior).
  const cwd = process.cwd();
  console.log(`Repo: ${cwd}`);

  // 2. Provider Profile (configured + enabled only — same rule as VS Code).
  const profiles = store.list().filter((p) => p.enabled !== false);
  if (profiles.length === 0) {
    console.log('\nNo Provider Profiles configured.');
    console.log('Configure one first — e.g. add a profile to ~/.claude-fleet/profiles.json,');
    console.log('or create it via the Claude Fleet VS Code extension (Manage Providers).');
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nProvider Profiles:');
    profiles.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.name} (${p.baseUrl ?? p.presetId ?? 'native'})`);
    });
    const pick = await ask(rl, `Choose profile [1-${profiles.length}]: `);
    const idx = Number(pick.trim()) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= profiles.length) {
      console.error('Invalid choice.');
      return;
    }
    const profile = profiles[idx];

    // 3. Model.
    const modelPresets: string[] = (profile.modelIds ?? []).filter((m) => m !== '');
    if (profile.defaultModelId && !modelPresets.includes(profile.defaultModelId)) {
      modelPresets.unshift(profile.defaultModelId);
    }
    console.log('\nModels:');
    modelPresets.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    console.log(`  ${modelPresets.length + 1}. <enter a model id>`);
    const modelPick = await ask(rl, `Choose model [1-${modelPresets.length + 1}]: `);
    let modelId: string | undefined;
    const mIdx = Number(modelPick.trim()) - 1;
    if (Number.isInteger(mIdx) && mIdx >= 0 && mIdx < modelPresets.length) {
      modelId = modelPresets[mIdx];
    } else {
      modelId = (await ask(rl, 'Model id: ')).trim() || undefined;
    }

    // 4. Session: new or resume.
    const sessionPick = await ask(rl, '\nSession: (n)ew / (r)esume [n]: ');
    const resume = sessionPick.trim().toLowerCase().startsWith('r');

    // 5. Resolve launch config (same resolver as VS Code path).
    const sessionId = resume
      ? (await ask(rl, 'Session id to resume: ')).trim()
      : crypto.randomUUID();
    if (resume && !sessionId) {
      console.error('Resume requires a session id.');
      return;
    }
    const resolved = resolveClaudeLaunchConfig(
      profile,
      modelId,
      cwd,
      sessionId,
      (ref) => store.getSecret(ref),
      {},
    );

    // 6. Spawn native claude (never re-implement Claude Code). The binary
    // goes through the CLI resolver (PATH + npm global bin, Windows
    // claude.cmd/claude.exe, no env mutation — Spec 005 FR-008).
    const build = claudeProvider.buildLaunchCommand?.(sessionId, cwd, {
      modelId,
      sessionMode: resume ? 'resume' : 'new',
    });
    const cliResolution = await resolveClaudeCli();
    const cmd = cliResolution.ok ? cliResolution.command : (build?.command ?? 'claude');
    const args = build?.args ?? [];
    console.log(`\nLaunching: ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...resolved.env },
      stdio: 'inherit',
    });
    child.on('exit', (code) => process.exit(code ?? 0));
  } finally {
    rl.close();
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[Claude Fleet] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Spec 005 — subcommands route BEFORE the standalone server boots.
  if (args.command === 'providers') {
    runProvidersCommand();
    return;
  }
  if (args.command === 'launch') {
    await runLaunchCommand();
    return;
  }

  // dist/ contains both the CLI bundle and the assets/ + webview/ directories
  const distRoot = __dirname;
  const packageRoot = path.dirname(distRoot);
  const staticDir = path.join(distRoot, 'webview');

  // ── Load assets on startup (same pipeline as VS Code extension) ──
  // External asset directories are merged at startup too, so directories added
  // in a previous session survive a restart. buildAssetCache is the shared
  // loader used by both the standalone server and the VS Code adapter.
  console.log('[Claude Fleet] Loading assets...');
  const assetCache: AssetCache = await buildAssetCache(
    distRoot,
    readConfig().externalAssetDirectories,
  );
  const charCount = assetCache.characters?.characters.length ?? 0;
  const petCount = assetCache.pets?.pets.length ?? 0;
  const furnitureCount = assetCache.furniture?.catalog.length ?? 0;
  console.log(
    `[Claude Fleet] Assets loaded: ${charCount} characters, ${petCount} pets, ${furnitureCount} furniture items`,
  );

  // ── Store + adapter (shared settings + standalone-scoped agents/seats) ──
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  // ── Create server ──
  const server = new ClaudeFleetServer();

  try {
    // Create runtime first (before server.start, so we can pass it in)
    const runtime = new AgentRuntime(store, claudeProvider);

    // Wire hook events: HTTP POST -> runtime -> hookEventHandler -> agents
    server.onHookEvent((providerId, event) => {
      runtime.handleHookEvent(providerId, event);
    });

    // onSetHooksEnabled side effect: install/uninstall hooks when user toggles in UI.
    // Captures config from the outer scope after server.start().
    let currentConfig: { port: number; token: string } | null = null;
    const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
      if (!currentConfig) return;
      if (enabled) {
        await claudeProvider.installHooks(
          `http://127.0.0.1:${currentConfig.port}`,
          currentConfig.token,
        );
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Claude Fleet] Hooks installed (user toggle)'
            : '[Claude Fleet] Hooks NOT installed (user toggle), hook script missing',
        );
      } else {
        await claudeProvider.uninstallHooks();
        console.log('[Claude Fleet] Hooks uninstalled (user toggle)');
      }
    };

    // onReloadAssets side effect: re-run the shared loaders (bundled + external
    // dirs) after an external-asset-directory change, then re-broadcast the
    // updated sprites to the requesting client. Mutates the assetCache object in
    // place so already-open sockets (which captured the same reference) and
    // future webviewReady handshakes both observe the new assets. Only
    // characters/pets/furniture can come from external dirs, so only those three
    // are reloaded and re-sent (mirrors the VS Code reload path).
    const onReloadAssets: ReloadAssetsSideEffect = async (send): Promise<void> => {
      const externalDirs = readConfig().externalAssetDirectories;
      const [characters, pets, furniture] = await Promise.all([
        loadAllCharacters(distRoot, externalDirs),
        loadAllPets(distRoot, externalDirs),
        loadAllFurniture(distRoot, externalDirs),
      ]);
      assetCache.characters = characters;
      assetCache.pets = pets;
      assetCache.furniture = furniture;
      if (characters) {
        send({ type: 'characterSpritesLoaded', characters: characters.characters });
      }
      if (pets) {
        send({
          type: 'petSpritesLoaded',
          pets: pets.pets,
          petNames: pets.manifests.map((m) => m.name),
        });
      }
      if (furniture) {
        send({
          type: 'furnitureAssetsLoaded',
          catalog: furniture.catalog,
          sprites: Object.fromEntries(furniture.sprites),
        });
      }
      console.log('[Claude Fleet] Assets reloaded (external directory change)');
    };

    const config = await server.start({
      store,
      runtime,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
      assetCache,
      onSetHooksEnabled,
      onReloadAssets,
    });
    currentConfig = { port: config.port, token: config.token };

    // Sync runtime refs with persisted settings BEFORE first scan tick
    runtime.hooksEnabled.current = adapter.getSetting('pixel-agents.hooksEnabled', true);
    runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

    // Install hooks on startup if the persisted setting says so
    if (runtime.hooksEnabled.current) {
      try {
        await claudeProvider.installHooks(`http://127.0.0.1:${config.port}`, config.token);
        const copied = copyHookScript(packageRoot);
        console.log(
          copied
            ? '[Claude Fleet] Hooks installed'
            : '[Claude Fleet] Hooks NOT installed, hook script missing',
        );
      } catch (err) {
        console.error('[Claude Fleet] Failed to install hooks:', err);
      }
    }

    // Start scanning for external sessions (Claude running in user's terminal)
    const cwd = process.cwd();
    const dirs = claudeProvider.getSessionDirs?.(cwd);
    if (dirs && dirs[0]) {
      const projectDir = dirs[0];
      console.log(`[Claude Fleet] Scanning project dir: ${projectDir}`);
      runtime.startProjectScan(projectDir);
      runtime.startExternalScanning(projectDir);
      runtime.startStaleCheck();
    }

    console.log(`\n  Claude Fleet server running at http://${args.host}:${config.port}\n`);

    // ── Graceful shutdown ──
    function shutdown(): void {
      console.log('\nShutting down...');
      runtime.dispose();
      server.stop();
      process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Only auto-run when this file is executed directly (`node dist/cli.js`), not
// when it's imported for its exports (e.g. `parseArgs` in tests) -- importing
// it unconditionally used to start a real server and install real Claude
// hooks as a side effect of module load.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

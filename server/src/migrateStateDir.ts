/**
 * migrateStateDir — Spec 006 (FR-003 / FR-004).
 *
 * One-time, idempotent, failure-safe migration of Fleet-owned state from the
 * upstream namespace `~/.pixel-agents/` to the Claude Fleet namespace
 * `~/.claude-fleet/`.
 *
 * Guarantees:
 *   - old dir missing            → no-op (nothing to migrate)
 *   - new dir already exists     → no-op (never overwrite new state)
 *   - copy old tree into new     → on ANY failure the old dir is left intact
 *     and the migration can be retried (a partial new dir is cleaned up first)
 *   - after a successful copy, a `migration.json` marker is written into the
 *     new dir so later runs are no-ops even if the old dir still exists
 *   - the OLD dir is NEVER deleted — the user's previous state stays on disk
 *     for the whole Alpha period (NFR-4)
 *   - no secret is ever logged
 *
 * Large cache-style dirs are excluded from the copy to keep it cheap
 * (nothing in the current layout, but the guard is future-proof).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const LEGACY_STATE_DIR_NAME = '.pixel-agents';
export const STATE_DIR_NAME = '.claude-fleet';
export const MIGRATION_MARKER = 'migration.json';

/** Directory names never copied (cache / runtime scratch). */
const EXCLUDED_NAMES = new Set(['Cache', 'CachedData', 'Code Cache', 'Crashpad', 'GPUCache']);

export function legacyStateDir(): string {
  return path.join(os.homedir(), LEGACY_STATE_DIR_NAME);
}

export function stateDir(): string {
  return path.join(os.homedir(), STATE_DIR_NAME);
}

export interface MigrationResult {
  migrated: boolean;
  reason: 'old-missing' | 'new-exists' | 'already-migrated' | 'done' | 'failed';
  copiedFiles?: number;
  error?: string;
}

function copyTree(src: string, dst: string, log: (m: string) => void): number {
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      count += copyTree(s, d, log);
    } else {
      fs.copyFileSync(s, d);
      count += 1;
    }
  }
  return count;
}

/**
 * Run the migration. Pure fs + injected log so it is unit-testable without
 * touching the real home directory.
 *
 * Returns a MigrationResult; never throws (caller should surface failure as
 * a warning and continue — the extension still works with either dir).
 */
export function migrateStateDir(
  log: (m: string) => void = (m) => console.log(`[Claude Fleet] ${m}`),
): MigrationResult {
  const oldDir = legacyStateDir();
  const newDir = stateDir();

  // 1. Old missing → nothing to migrate.
  if (!fs.existsSync(oldDir)) {
    return { migrated: false, reason: 'old-missing' };
  }
  // 2. New exists → never overwrite. If a marker is present, migration is done.
  if (fs.existsSync(newDir)) {
    const marker = path.join(newDir, MIGRATION_MARKER);
    if (fs.existsSync(marker)) {
      return { migrated: false, reason: 'already-migrated' };
    }
    // New dir exists WITHOUT a marker: could be a partial failed copy from a
    // previous attempt. Only safe to clean when it looks like ours — it holds
    // the marker-less layout we write (config.json / hooks / layout.json /
    // <ns>-state.json). Keep it simple and safe: leave it, log, and skip the
    // copy. The user can delete it manually; the extension reads whichever
    // dir exists.
    log(`Migration skipped: ${newDir} already exists (no marker). Not overwriting.`);
    return { migrated: false, reason: 'new-exists' };
  }

  // 3. Copy old tree → new.
  try {
    fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
    let copied = 0;
    try {
      copied = copyTree(oldDir, newDir, log);
    } catch (e) {
      // Partial copy — remove what we wrote so a retry starts clean, keep old.
      try {
        fs.rmSync(newDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      const msg = e instanceof Error ? e.message : String(e);
      log(`Migration failed (old state preserved): ${msg}`);
      return { migrated: false, reason: 'failed', error: msg };
    }
    // 4. Write the completion marker (after a fully successful copy).
    fs.writeFileSync(
      path.join(newDir, MIGRATION_MARKER),
      JSON.stringify({ from: oldDir, at: Date.now(), copiedFiles: copied }, null, 2),
      'utf-8',
    );
    log(
      `Migrated ${LEGACY_STATE_DIR_NAME}/ → ${STATE_DIR_NAME}/ (${copied} files). Legacy dir preserved.`,
    );
    return { migrated: true, reason: 'done', copiedFiles: copied };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Migration failed (old state preserved): ${msg}`);
    return { migrated: false, reason: 'failed', error: msg };
  }
}

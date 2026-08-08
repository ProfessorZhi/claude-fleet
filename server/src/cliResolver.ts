/**
 * cliResolver — Claude Code CLI resolver.
 *
 * Resolves the `claude` CLI binary WITHOUT assuming it is on PATH:
 *   1. scan every PATH entry (Windows: claude.cmd / claude.exe / claude;
 *      POSIX: claude)
 *   2. probe the npm global bin directory (`npm bin -g`, with documented
 *      platform fallbacks when npm is unavailable)
 *   3. verify the candidate actually answers `--version`
 *
 * Never mutates the user's environment; never hardcodes a user-named path
 * (home dirs come from os.homedir / env vars). On failure it returns a
 * diagnostic block: current PATH, every searched path, and an install
 * suggestion.
 *
 * Both the VS Code adapter (cliCheck.ts) and the standalone CLI (cli.ts)
 * go through this resolver so runtime launch is unified (Spec 005 FR-008).
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliResolverOptions {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  homeDir?: string;
  appData?: string;
  /** Executor used to verify a candidate answers `--version`. */
  verify?: (command: string) => Promise<string>;
  /** Query the npm global bin directory; undefined → built-in probing. */
  npmBinDir?: () => Promise<string | undefined>;
}

export type CliResolutionSource = 'path' | 'npm-global' | 'not-found';

export interface CliResolution {
  ok: boolean;
  /** Absolute path to the resolved binary, or 'claude' when only PATH matched. */
  command: string;
  version?: string;
  source: CliResolutionSource;
  /** Every directory searched, in order (diagnostics). */
  searchedPaths: string[];
  /** Candidate file names tried, in order. */
  candidateNames: string[];
  /** Human-readable diagnostics (PATH / searched paths / install hint). */
  diagnostics: string;
}

const INSTALL_HINT =
  'npm install -g @anthropic-ai/claude-code   (see https://docs.anthropic.com/en/docs/claude-code/setup)';

export function claudeCandidateNames(platform: NodeJS.Platform): string[] {
  // Windows ships `claude.cmd` (+ `claude.exe` shim); execFile can resolve
  // `.cmd` only via an explicit full path, hence the ordered candidates.
  return platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
}

/**
 * Documented npm global bin candidates (no user-named paths; home/appdata
 * come from os.homedir / env). Exported for tests.
 */
export function defaultNpmBinCandidates(
  platform: NodeJS.Platform,
  homeDir: string,
  appData: string | undefined,
): string[] {
  const candidates: string[] = [];
  if (platform === 'win32' && appData) {
    candidates.push(path.join(appData, 'npm'));
  }
  candidates.push('/usr/local/bin', path.join(homeDir, '.local', 'bin'));
  return candidates;
}

/** Built-in `npm bin -g` probe with documented platform fallbacks. */
export async function probeNpmGlobalBin(
  platform: NodeJS.Platform,
  homeDir: string,
  appData: string | undefined,
): Promise<string | undefined> {
  // 1. Ask npm itself (most reliable — respects custom npm prefix).
  try {
    const npmCmd = platform === 'win32' ? 'npm.cmd' : 'npm';
    const out = await new Promise<string>((resolve, reject) => {
      execFile(npmCmd, ['bin', '-g'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout ?? '').trim());
      });
    });
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* fall through to documented defaults */
  }

  // 2. Documented platform defaults.
  for (const c of defaultNpmBinCandidates(platform, homeDir, appData)) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Resolve the Claude Code CLI.
 *
 * Pure-ish: platform / PATH / homedir / verify are injectable for tests.
 * The verify step runs `--version` on the FIRST matching candidate only
 * (a broken install falls through to the next candidate, then to the next
 * search dir).
 */
export async function resolveClaudeCli(opts: CliResolverOptions = {}): Promise<CliResolution> {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const homeDir = opts.homeDir ?? os.homedir();
  const appData = opts.appData ?? (platform === 'win32' ? process.env.APPDATA : undefined);
  const verify =
    opts.verify ??
    ((command: string) =>
      new Promise<string>((resolve, reject) => {
        execFile(command, ['--version'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
          if (err) reject(err);
          else resolve((stdout ?? '').trim());
        });
      }));
  const npmBinDir = opts.npmBinDir ?? (() => probeNpmGlobalBin(platform, homeDir, appData));

  const candidateNames = claudeCandidateNames(platform);
  const searchDirs: string[] = [];

  // 1. PATH entries (in order, empty entries ignored).
  for (const entry of pathEnv.split(path.delimiter)) {
    if (entry.trim() !== '') searchDirs.push(entry);
  }

  // 2. npm global bin (deduped, appended after PATH).
  try {
    const npmBin = await npmBinDir();
    if (npmBin && !searchDirs.some((d) => path.resolve(d) === path.resolve(npmBin))) {
      searchDirs.push(npmBin);
    }
  } catch {
    /* diagnostics only */
  }

  // 3. Probe each dir × candidate, verifying the first match.
  let version: string | undefined;
  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) continue;
      try {
        const raw = await verify(full);
        if (!raw) continue; // answers nothing → broken install, keep probing
        version = raw;
        return {
          ok: true,
          command: full,
          version,
          source: pathEnv
            .split(path.delimiter)
            .some((d) => d && path.resolve(d) === path.resolve(dir))
            ? 'path'
            : 'npm-global',
          searchedPaths: searchDirs,
          candidateNames,
          diagnostics: `Claude Code CLI resolved: ${full} (${version})`,
        };
      } catch {
        /* broken candidate — try the next one */
      }
    }
  }

  // 4. Not found → diagnostics.
  const pathLines = pathEnv
    .split(path.delimiter)
    .filter((p) => p.trim() !== '')
    .map((p) => `    - ${p}`)
    .join('\n');
  const searchedLines = searchDirs.map((d) => `    - ${d}`).join('\n');
  const diagnostics = [
    `Claude Code CLI not found.`,
    ``,
    `Searched candidates: ${candidateNames.join(', ')}`,
    ``,
    `Current PATH:`,
    pathLines || '    (empty)',
    ``,
    `Searched directories (PATH + npm global bin):`,
    searchedLines || '    (none)',
    ``,
    `Install: ${INSTALL_HINT}`,
  ].join('\n');

  return {
    ok: false,
    command: 'claude',
    source: 'not-found',
    searchedPaths: searchDirs,
    candidateNames,
    diagnostics,
  };
}

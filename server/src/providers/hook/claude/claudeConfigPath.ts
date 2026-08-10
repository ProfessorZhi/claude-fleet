import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';

/** Resolve Claude Code's optional config directory exactly as the CLI does. */
export function getClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) return path.join(os.homedir(), '.claude');
  const expanded = expandWindowsEnvironmentVariables(configured);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(os.homedir(), expanded);
}

/**
 * Windows terminals commonly receive values such as
 * `%USERPROFILE%\\.claude-deepseek`. Node does not expand cmd.exe-style
 * variables when reading process.env, so normalize them before deriving any
 * transcript path. Unknown variables are kept unchanged rather than silently
 * redirecting a session to an unrelated profile.
 */
export function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return value;
  return value.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match);
}

/**
 * Return config roots in preference order. The explicit environment value wins;
 * the default root remains a compatibility fallback for existing installations.
 * Sibling `.claude-*` roots are discovery candidates; the hook installer may
 * target existing profiles but never creates empty sibling profiles.
 */
export function getClaudeConfigDirs(): string[] {
  const preferred = getClaudeConfigDir();
  const defaults = path.join(os.homedir(), '.claude');
  const candidates = [preferred, defaults];
  try {
    for (const entry of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.claude-')) continue;
      candidates.push(path.join(os.homedir(), entry.name));
    }
  } catch {
    // A missing/unreadable home directory is handled by the caller's fallback.
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Session project dirs for a workspace, using the same path key as Claude. */
export function getClaudeSessionDirs(workspacePath: string): string[] {
  const dirName = normalizeProjectPath(workspacePath);
  const configDirs = getClaudeConfigDirs();
  const preferred = path.join(configDirs[0], 'projects', dirName);
  const matches: string[] = [preferred];

  for (const configDir of configDirs.slice(1)) {
    const projectsRoot = path.join(configDir, 'projects');
    const expected = path.join(projectsRoot, dirName);
    if (fs.existsSync(expected)) {
      matches.push(expected);
      continue;
    }
    try {
      const lowerDirName = dirName.toLowerCase();
      const match = fs
        .readdirSync(projectsRoot)
        .find((entry) => entry.toLowerCase() === lowerDirName);
      if (match) matches.push(path.join(projectsRoot, match));
    } catch {
      // The expected path is still returned below when no candidate exists.
    }
  }

  return [...new Set(matches.map((entry) => path.normalize(entry)))];
}

/** All project roots that may contain Claude transcripts. */
export function getClaudeSessionRoots(): string[] {
  return getClaudeConfigDirs().map((configDir) => path.join(configDir, 'projects'));
}

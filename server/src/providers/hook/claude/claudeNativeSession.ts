import * as fs from 'fs';
import * as path from 'path';

export interface ClaudeNativeSessionEvidence {
  configDir: string;
  filePath: string;
  sessionId: string;
  cwd: string;
  pid: number;
  status: string;
  kind?: string;
}

interface NativeSessionRecord {
  sessionId?: unknown;
  cwd?: unknown;
  pid?: unknown;
  status?: unknown;
  kind?: unknown;
}

/**
 * Claude Code writes a small process-owned record under <config>/sessions.
 * This is deliberately an evidence reader, not a second runtime: it only
 * accepts an exact session/cwd match, an interactive record, and a live pid.
 * A process being alive by itself is never sufficient for readiness.
 */
export function findReadyClaudeNativeSession(
  configDir: string,
  sessionId: string,
  cwd: string,
): ClaudeNativeSessionEvidence | undefined {
  if (!configDir || !sessionId || !cwd) return undefined;
  const sessionsDir = path.join(configDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((file) => file.endsWith('.json'));
  } catch {
    return undefined;
  }

  const expectedCwd = normalizePath(cwd);
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    let record: NativeSessionRecord;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as NativeSessionRecord;
    } catch {
      continue;
    }
    if (record.sessionId !== sessionId || typeof record.cwd !== 'string') continue;
    if (normalizePath(record.cwd) !== expectedCwd) continue;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
      continue;
    }
    if (typeof record.status !== 'string' || !isReadyStatus(record.status)) continue;
    if (record.kind !== undefined && record.kind !== 'interactive') continue;
    if (!isProcessAlive(record.pid)) continue;
    return {
      configDir: path.normalize(configDir),
      filePath: path.normalize(filePath),
      sessionId,
      cwd: record.cwd,
      pid: record.pid,
      status: record.status,
      kind: typeof record.kind === 'string' ? record.kind : undefined,
    };
  }
  return undefined;
}

function isReadyStatus(status: string): boolean {
  return ['idle', 'ready', 'active', 'working'].includes(status.toLowerCase());
}

function normalizePath(value: string): string {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TokenUsage } from '../../../../core/src/ledgerContracts.js';
import { GLOBAL_SCAN_ACTIVE_MAX_AGE_MS } from '../../constants.js';

export type CodexDiscoveredStatus = 'starting' | 'working' | 'waiting' | 'idle' | 'error';

export interface CodexSessionMetadata {
  sessionId: string;
  cwd: string;
  filePath: string;
  /** Codex runtime origin, e.g. `Codex Desktop`, `codex-tui`, or `codex_vscode`. */
  originator?: string;
  /** Native source marker when Codex provides one (`cli`, `vscode`, ...). */
  source?: string;
  modelId?: string;
  providerId?: string;
  cliVersion?: string;
  contextWindow?: number;
  /** Cumulative token snapshot from the latest Codex token_count event. */
  tokens?: TokenUsage;
  /** Duration of the latest completed turn when Codex reports it. */
  durationMs?: number;
  status: CodexDiscoveredStatus;
  lastActivityAt: number;
}

export interface CodexSessionScannerOptions {
  homeDir?: string;
  workspaceRoots?: readonly string[];
  now?: () => number;
  maxAgeMs?: number;
  maxSessions?: number;
  /** Skip sessions the host has explicitly dismissed from the projection. */
  isDismissed?: (filePath: string) => boolean;
}

export interface CodexManagedAgentCandidate {
  instanceId: string;
  runtime: 'codex-cli';
  managedByFleet?: boolean;
  isExternal?: boolean;
  cwd?: string;
  createdAt?: number;
  sessionId?: string;
  jsonlFile?: string;
  /** True when this candidate still owns a live VS Code terminal. */
  terminalAttached?: boolean;
}

const CODEX_SESSIONS_DIR = ['.codex', 'sessions'];
const MAX_FIRST_LINE_BYTES = 256 * 1024;
const CODEX_TAIL_BYTES = 128 * 1024;
const MANAGED_SESSION_CORRELATION_WINDOW_MS = 5 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

function recordOf(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(record: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function numberValue(record: JsonRecord | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function nonNegativeInteger(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readFirstLine(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const end = text.indexOf('\n');
    return end >= 0 ? text.slice(0, end) : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* file may have disappeared between scan and read */
      }
    }
  }
}

function readInitialRecords(filePath: string): JsonRecord[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(MAX_FIRST_LINE_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/);
    const records: JsonRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = recordOf(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        /* the final chunk can end in a partial line */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failures */
      }
    }
  }
}

function readTailRecords(filePath: string): JsonRecord[] {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, stat.size - CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    const lines = text.split(/\r?\n/);
    // The first line may be a partial JSON record when the tail starts in the
    // middle of a line. It is safer to discard it than to guess its contents.
    if (start > 0) lines.shift();
    const records: JsonRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = recordOf(JSON.parse(line));
        if (record) records.push(record);
      } catch {
        /* a concurrently-written final line is expected to be incomplete */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore close failures */
      }
    }
  }
}

function sessionRoot(homeDir: string): string {
  return path.join(homeDir, ...CODEX_SESSIONS_DIR);
}

function listJsonlFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
  };
  visit(root);
  return files;
}

function pathsEqualOrInside(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const candidateForCompare =
    process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const rootForCompare = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const relative = path.relative(rootForCompare, candidateForCompare);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Match a newly discovered Codex JSONL session to a Fleet-launched terminal.
 * Codex creates its native session id itself, so the launch-side placeholder
 * id cannot be used as the primary key. Matching is restricted to managed
 * Codex agents in the same cwd and a short launch-time window; otherwise the
 * session remains an external projection instead of being guessed.
 */
export function findManagedCodexAgentCandidate(
  candidates: readonly CodexManagedAgentCandidate[],
  session: Pick<CodexSessionMetadata, 'cwd' | 'sessionId' | 'lastActivityAt'>,
): string | undefined {
  const exact = candidates.find(
    (candidate) =>
      candidate.runtime === 'codex-cli' &&
      candidate.managedByFleet !== false &&
      candidate.isExternal !== true &&
      candidate.sessionId === session.sessionId,
  );
  if (exact) return exact.instanceId;

  // A single live Fleet-created terminal is a stronger identity signal than
  // launch time. This lets one terminal keep ownership when Codex starts a
  // later session after the five-minute adoption window. Never apply this
  // shortcut when multiple terminals share the same cwd; guessing there would
  // attach a session to the wrong terminal.
  const attachedMatches = candidates.filter(
    (candidate) =>
      candidate.runtime === 'codex-cli' &&
      candidate.managedByFleet !== false &&
      candidate.isExternal !== true &&
      candidate.terminalAttached === true &&
      typeof candidate.cwd === 'string' &&
      pathsEqualOrInside(session.cwd, candidate.cwd),
  );
  if (attachedMatches.length === 1) return attachedMatches[0].instanceId;

  const matches = candidates
    .filter(
      (candidate) =>
        candidate.runtime === 'codex-cli' &&
        candidate.managedByFleet !== false &&
        candidate.isExternal !== true &&
        typeof candidate.cwd === 'string' &&
        pathsEqualOrInside(session.cwd, candidate.cwd) &&
        typeof candidate.createdAt === 'number' &&
        Math.abs(session.lastActivityAt - candidate.createdAt) <=
          MANAGED_SESSION_CORRELATION_WINDOW_MS &&
        Boolean(candidate.jsonlFile),
    )
    .sort(
      (left, right) =>
        Math.abs(session.lastActivityAt - (left.createdAt ?? 0)) -
        Math.abs(session.lastActivityAt - (right.createdAt ?? 0)),
    );
  return matches[0]?.instanceId;
}

function parseSessionMeta(
  filePath: string,
): Omit<CodexSessionMetadata, 'status' | 'lastActivityAt'> | undefined {
  const line = readFirstLine(filePath);
  if (!line) return undefined;
  try {
    const record = recordOf(JSON.parse(line));
    const payload = recordOf(record?.payload);
    if (stringValue(record, 'type') !== 'session_meta' || !payload) return undefined;
    const sessionId = stringValue(payload, 'session_id', 'sessionId', 'id');
    const cwd = stringValue(payload, 'cwd', 'working_directory', 'workingDirectory');
    if (!sessionId || !cwd) return undefined;
    const contextWindow = numberValue(payload, 'context_window', 'contextWindow');
    return {
      sessionId,
      cwd,
      filePath,
      ...(stringValue(payload, 'originator')
        ? { originator: stringValue(payload, 'originator') }
        : {}),
      ...(stringValue(payload, 'source') ? { source: stringValue(payload, 'source') } : {}),
      modelId: stringValue(payload, 'model', 'model_id', 'modelId'),
      providerId: stringValue(payload, 'model_provider', 'modelProvider', 'provider'),
      cliVersion: stringValue(payload, 'cli_version', 'cliVersion'),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    };
  } catch {
    return undefined;
  }
}

/** Read whether a persisted session belongs to Codex Desktop. */
export function isCodexDesktopSessionFile(filePath: string): boolean {
  return parseSessionMeta(filePath)?.originator?.toLowerCase() === 'codex desktop';
}

function statusFromTail(
  records: JsonRecord[],
  initialModelId: string | undefined,
  initialContextWindow: number | undefined,
): Pick<CodexSessionMetadata, 'status' | 'modelId' | 'contextWindow' | 'tokens' | 'durationMs'> {
  // A session_meta-only file means Codex has created a session but has not
  // received the first user message yet. Do not call that idle: idle means a
  // real turn completed and the runtime is ready for the next one.
  let status: CodexDiscoveredStatus = 'starting';
  let modelId = initialModelId;
  let contextWindow = initialContextWindow;
  let tokens: TokenUsage | undefined;
  let durationMs: number | undefined;

  for (const record of records) {
    const payload = recordOf(record.payload);
    const outerType = stringValue(record, 'type');
    const payloadType = stringValue(payload, 'type');
    const eventType = outerType === 'event_msg' ? payloadType : outerType;
    if (eventType === 'task_started' || eventType === 'turn_started') status = 'working';
    else if (
      eventType === 'task_complete' ||
      eventType === 'turn_completed' ||
      eventType === 'turn_aborted'
    )
      status = 'idle';
    else if (eventType === 'error') status = 'error';
    else if (eventType === 'user_message') status = 'waiting';

    modelId = stringValue(payload, 'model', 'model_id', 'modelId') ?? modelId;
    contextWindow = numberValue(payload, 'context_window', 'contextWindow') ?? contextWindow;

    if (eventType === 'token_count') {
      const info = recordOf(payload?.info);
      const total = recordOf(info?.total_token_usage);
      if (total) {
        const next: TokenUsage = {};
        const inputTokens = nonNegativeInteger(total, 'input_tokens');
        const cachedInputTokens = nonNegativeInteger(total, 'cached_input_tokens');
        const outputTokens = nonNegativeInteger(total, 'output_tokens');
        const totalTokens = nonNegativeInteger(total, 'total_tokens');
        if (inputTokens !== undefined) next.inputTokens = inputTokens;
        if (cachedInputTokens !== undefined) next.cachedInputTokens = cachedInputTokens;
        if (outputTokens !== undefined) next.outputTokens = outputTokens;
        if (totalTokens !== undefined) next.totalTokens = totalTokens;
        if (Object.keys(next).length > 0) tokens = next;
      }
      contextWindow = numberValue(info, 'model_context_window') ?? contextWindow;
    }
    if (eventType === 'turn_completed') {
      durationMs = numberValue(payload, 'duration_ms');
    }
  }

  return { status, modelId, contextWindow, tokens, durationMs };
}

export function scanCodexSessions(
  options: CodexSessionScannerOptions = {},
): CodexSessionMetadata[] {
  const homeDir = options.homeDir ?? process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  if (!homeDir) return [];
  const roots = options.workspaceRoots?.filter((root) => root.trim() !== '') ?? [];
  const now = options.now?.() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? GLOBAL_SCAN_ACTIVE_MAX_AGE_MS;
  const maxSessions = options.maxSessions ?? 100;
  const result: CodexSessionMetadata[] = [];

  for (const filePath of listJsonlFiles(sessionRoot(homeDir))) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (maxAgeMs >= 0 && now - stat.mtimeMs > maxAgeMs) continue;
    if (options.isDismissed?.(filePath)) continue;
    const meta = parseSessionMeta(filePath);
    if (
      !meta ||
      meta.originator?.toLowerCase() === 'codex desktop' ||
      (roots.length > 0 && !roots.some((root) => pathsEqualOrInside(meta.cwd, root)))
    ) {
      continue;
    }
    const initial = readInitialRecords(filePath);
    const tail = statusFromTail(
      [...initial, ...readTailRecords(filePath)],
      meta.modelId,
      meta.contextWindow,
    );
    result.push({ ...meta, ...tail, lastActivityAt: stat.mtimeMs });
  }

  return result
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, Math.max(0, maxSessions));
}

#!/usr/bin/env node

/**
 * Deterministic Claude/Codex process fixture for Production Closure smoke tests.
 *
 * This is intentionally not a fake "agent". It has exactly two supported
 * boundaries:
 *   - --version: print a deterministic version and exit;
 *   - stdin: accept a rendered Fleet task brief or a stop control event.
 *
 * It never performs network I/O, reads credentials, executes commands, writes
 * transcripts, or echoes arbitrary stdin. The test harness uses its stdout as
 * a small, allowlisted event stream.
 */

const path = require('node:path');

const executableName = path.basename(process.argv[1] || '').toLowerCase();
const runtime = executableName.includes('codex') ? 'codex-cli' : 'claude-code';
const version = runtime === 'codex-cli' ? 'codex-fleet-fake 1.0.0' : 'claude-fleet-fake 1.0.0';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : undefined;
}

const sessionId =
  valueAfter('--session-id') ||
  valueAfter('--resume') ||
  valueAfter('resume') ||
  `${runtime}-session`;
const sessionMode = args.includes('--resume') || args.includes('resume') ? 'resume' : 'new';
const modelId = valueAfter('--model');
let acceptedTask = false;

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function taskIdFromRenderedBrief(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const match = /^\[Claude Fleet WorkItem ([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]$/.exec(firstLine);
  return match ? match[1] : undefined;
}

function emitStarted() {
  if (runtime === 'codex-cli') {
    emit({
      type: 'session.started',
      event_id: `fake-${runtime}-session-started`,
      session_id: sessionId,
      status: 'working',
      model_id: modelId,
      session_mode: sessionMode,
    });
    return;
  }

  emit({
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: sessionMode === 'resume' ? 'resume' : 'startup',
  });
}

function emitStopped() {
  if (runtime === 'codex-cli') {
    emit({
      type: 'session.ended',
      event_id: `fake-${runtime}-session-ended`,
      session_id: sessionId,
      status: 'stopped',
    });
  } else {
    emit({
      hook_event_name: 'SessionEnd',
      session_id: sessionId,
      reason: 'control_stop',
    });
  }
}

function emitTaskResult(workItemId) {
  if (runtime === 'codex-cli') {
    emit({
      type: 'turn.started',
      event_id: `fake-${workItemId}-turn-started`,
      session_id: sessionId,
      current_task: workItemId,
    });
  } else {
    emit({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_name: 'Task',
    });
  }

  // Bounded result metadata only. Do not include the task objective, raw
  // stdin, environment variables, or transcript content in this envelope.
  emit({
    type: 'fleet.result',
    work_item_id: workItemId,
    instance_id: `${runtime}-smoke-instance`,
    outcome: 'completed',
    summary: 'deterministic smoke result',
    artifact_refs: [`fake://work-item/${workItemId}`],
    captured_at: 1700000000000,
    source: 'runtime',
    availability: 'available',
    confidence: 'exact',
  });

  if (runtime === 'codex-cli') {
    emit({
      type: 'turn.completed',
      event_id: `fake-${workItemId}-turn-completed`,
      session_id: sessionId,
      status: 'idle',
      current_task: workItemId,
    });
  } else {
    emit({ hook_event_name: 'Stop', session_id: sessionId });
  }
}

emitStarted();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newlineIndex = input.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = input.slice(0, newlineIndex).replace(/\r$/, '');
    input = input.slice(newlineIndex + 1);
    newlineIndex = input.indexOf('\n');

    if (!line.trim()) continue;
    try {
      const control = JSON.parse(line);
      if (control && control.type === 'fleet.control' && control.action === 'stop') {
        emitStopped();
        process.exit(0);
      }
      // Reject structured input other than the one control event without
      // serializing it back to the caller.
      emit({ type: 'fleet.input.rejected', reason: 'unsupported_event' });
      continue;
    } catch {
      // The host sends the validated human-readable bounded brief. The fake
      // accepts its stable header only; the rest is intentionally discarded.
      if (acceptedTask) continue;
      const workItemId = taskIdFromRenderedBrief(line);
      if (workItemId) {
        acceptedTask = true;
        emitTaskResult(workItemId);
      } else emit({ type: 'fleet.input.rejected', reason: 'invalid_task_brief' });
    }
  }
});

process.stdin.on('end', () => {
  // Keep the process alive until the host exercises stop().
});

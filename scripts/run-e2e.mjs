import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ATTACH_VIDEOS_ON_SUCCESS_FLAG = '--attach-videos-on-success';
const ATTACH_VIDEOS_ON_SUCCESS_ENV = 'PIXEL_AGENTS_E2E_ATTACH_VIDEOS_ON_SUCCESS';
const RUN_ID_FLAG = '--run-id';
const RUN_ID_ENV = 'PIXEL_AGENTS_E2E_RUN_ID';
const AREA_FLAG = '--area';
const FILE_FLAG = '--file';
const RUN_TIMEOUT_FLAG = '--run-timeout';
const RUN_TIMEOUT_ENV = 'PIXEL_AGENTS_E2E_RUN_TIMEOUT_MS';
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = path.join(repoRoot, 'node_modules', 'playwright', 'cli.js');

function printHelp() {
  console.log(`Usage: node scripts/run-e2e.mjs [runner options] [playwright options] [spec files]

Runner options:
  --area <name>           Run tests tagged with @area:<name> (repeatable)
  --file <path>           Run a spec file (repeatable; also accepts a bare path)
  --run-id <id>           Namespace artifacts for concurrent runs
  --run-timeout <time>    Kill the Playwright process tree after this time (default: 30m)
  --attach-videos-on-success

All other options are passed to Playwright. Examples:
  npm run e2e -- --area spawn
  npm run e2e -- --file e2e/tests/claude/hooks-on/lifecycle.spec.ts
  npm run e2e -- --area standalone --workers=2
  npm run e2e -- --shard=1/3 --run-id=ci-1

Duration accepts ms, s, m, or h (for example 90s, 30m, 1h). Use 0 to disable
the runner timeout. The Playwright test timeout is still controlled by its own
--timeout option.
`);
}

function requireOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDuration(value, source) {
  const match = /^([0-9]+)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match) {
    throw new Error(`${source} must be a duration such as 90s, 30m, or 1h`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration)) {
    throw new Error(`${source} is too large`);
  }
  return duration;
}

function parseRunTimeout(argv) {
  const configured = process.env[RUN_TIMEOUT_ENV];
  let timeoutMs = configured ? parseDuration(configured, RUN_TIMEOUT_ENV) : DEFAULT_RUN_TIMEOUT_MS;
  const forwardedArgs = [];
  const areas = [];
  const files = [];
  let attachVideosOnSuccess = false;
  let runId = process.env[RUN_ID_ENV];
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      showHelp = true;
      continue;
    }

    if (arg === ATTACH_VIDEOS_ON_SUCCESS_FLAG) {
      attachVideosOnSuccess = true;
      continue;
    }

    if (arg === RUN_ID_FLAG) {
      runId = requireOptionValue(argv, index, RUN_ID_FLAG);
      index += 1;
      continue;
    }

    if (arg.startsWith(`${RUN_ID_FLAG}=`)) {
      runId = arg.slice(`${RUN_ID_FLAG}=`.length);
      continue;
    }

    if (arg === AREA_FLAG) {
      areas.push(requireOptionValue(argv, index, AREA_FLAG));
      index += 1;
      continue;
    }

    if (arg.startsWith(`${AREA_FLAG}=`)) {
      areas.push(arg.slice(`${AREA_FLAG}=`.length));
      continue;
    }

    if (arg === FILE_FLAG) {
      files.push(requireOptionValue(argv, index, FILE_FLAG));
      index += 1;
      continue;
    }

    if (arg.startsWith(`${FILE_FLAG}=`)) {
      files.push(arg.slice(`${FILE_FLAG}=`.length));
      continue;
    }

    if (arg === RUN_TIMEOUT_FLAG) {
      timeoutMs = parseDuration(
        requireOptionValue(argv, index, RUN_TIMEOUT_FLAG),
        RUN_TIMEOUT_FLAG,
      );
      index += 1;
      continue;
    }

    if (arg.startsWith(`${RUN_TIMEOUT_FLAG}=`)) {
      timeoutMs = parseDuration(arg.slice(`${RUN_TIMEOUT_FLAG}=`.length), RUN_TIMEOUT_FLAG);
      continue;
    }

    forwardedArgs.push(arg);
  }

  if (areas.length > 0) {
    const areaPattern = areas
      .map((area) => {
        if (!/^[a-z0-9_-]+$/i.test(area)) {
          throw new Error(`${AREA_FLAG} accepts letters, numbers, "_", and "-" only`);
        }
        return `@area:${area}`;
      })
      .join('|');
    forwardedArgs.push('--grep', areas.length === 1 ? areaPattern : `(?:${areaPattern})`);
  }

  forwardedArgs.push(...files);

  return {
    attachVideosOnSuccess,
    forwardedArgs,
    runId,
    showHelp,
    timeoutMs,
  };
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child, timeoutMs) {
  if (!isRunning(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function killUnixProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the two kill attempts.
      }
    }
  }
}

function killWindowsProcessTree(child) {
  if (!child.pid) return;
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  killer.on('error', () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may have exited already.
    }
  });
}

async function terminateProcessTree(child, reason, force = false) {
  if (!force && !isRunning(child)) return;

  console.error(`[e2e] ${reason}; terminating Playwright and its child process tree`);
  if (process.platform === 'win32') {
    killWindowsProcessTree(child);
  } else {
    killUnixProcessGroup(child, 'SIGTERM');
  }

  if (await waitForExit(child, 5_000)) return;

  if (process.platform === 'win32') {
    killWindowsProcessTree(child);
  } else {
    killUnixProcessGroup(child, 'SIGKILL');
  }
  await waitForExit(child, 2_000);
}

async function main() {
  const options = parseRunTimeout(process.argv.slice(2));
  if (options.showHelp) {
    printHelp();
    return 0;
  }

  const child = spawn(
    process.execPath,
    [playwrightCli, 'test', '--config', 'e2e/playwright.config.ts', ...options.forwardedArgs],
    {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...(options.attachVideosOnSuccess ? { [ATTACH_VIDEOS_ON_SUCCESS_ENV]: '1' } : {}),
        ...(options.runId ? { [RUN_ID_ENV]: options.runId } : {}),
      },
      stdio: 'inherit',
      windowsHide: false,
    },
  );

  let timedOut = false;
  let requestedSignal = null;
  let terminating = null;
  let forceCleanup = false;

  const requestTermination = (reason, force = false) => {
    if (!terminating || (force && !terminating.force)) {
      terminating = {
        force,
        promise: terminateProcessTree(child, reason, force),
      };
    }
    return terminating.promise;
  };

  const onSignal = (signal) => {
    requestedSignal = signal;
    forceCleanup = true;
    void requestTermination(`received ${signal}`, true);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const timeout =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          forceCleanup = true;
          void requestTermination(`run timeout reached after ${options.timeoutMs}ms`, true);
        }, options.timeoutMs)
      : undefined;

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', (error) => {
        forceCleanup = true;
        reject(error);
      });
      child.once('close', (code, signal) => {
        forceCleanup = code !== 0 || signal !== null;
        resolve({ code, signal });
      });
    });

    if (timedOut) {
      forceCleanup = true;
      return 124;
    }
    if (requestedSignal) return 128 + (requestedSignal === 'SIGINT' ? 2 : 15);
    if (result.code !== null) return result.code;
    return 1;
  } finally {
    if (timeout) clearTimeout(timeout);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await requestTermination('runner cleanup', forceCleanup);
  }
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);

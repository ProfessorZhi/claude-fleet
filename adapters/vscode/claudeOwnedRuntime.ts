import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import * as vscode from 'vscode';

export type OwnedRuntimeStream = 'stdout' | 'stderr';
export type OwnedRuntimeInputFormat = 'text' | 'stream-json';

export interface ClaudeOwnedRuntimeLaunchRequest {
  externalInstanceId: string;
  sessionId: string;
  cwd: string;
  command: string;
  args: readonly string[];
  terminalName: string;
  inputFormat?: OwnedRuntimeInputFormat;
  env?: NodeJS.ProcessEnv;
  showTerminal?: boolean;
  onOutput?: (stream: OwnedRuntimeStream, chunk: string) => void;
  onEvent?: (event: Record<string, unknown>) => void;
  onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ClaudeOwnedRuntimeProcess {
  readonly externalInstanceId: string;
  readonly sessionId: string;
  readonly terminalName: string;
  readonly terminal: vscode.Terminal;
  readonly pid: number | undefined;
  readonly exitCode: number | null | undefined;
  readonly alive: boolean;
  /** Write bytes without adding a submit character. */
  write(text: string): void;
  /** Write one logical prompt and submit it through the owned stream. */
  submit(text: string): void;
  focus(): void;
  stop(): Promise<void>;
}

export interface ClaudeOwnedRuntimeDependencies {
  createTerminal?: typeof vscode.window.createTerminal;
  spawn?: typeof spawn;
}

interface SpawnedProcess extends ChildProcessWithoutNullStreams {
  stdin: ChildProcessWithoutNullStreams['stdin'];
}

/**
 * A VS Code terminal surface backed by a Fleet-owned child process.
 *
 * The terminal is deliberately only a projection: the process stdin/stdout
 * streams are the control boundary. This avoids treating Terminal.sendText as
 * the runtime protocol while preserving a visible terminal for humans.
 */
class OwnedRuntimePseudoterminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void | number>();
  private readonly pendingOutput: string[] = [];
  private opened = false;
  private inputHandler: ((data: string) => void) | undefined;

  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  attachInputHandler(handler: (data: string) => void): void {
    this.inputHandler = handler;
  }

  open(): void {
    this.opened = true;
    for (const chunk of this.pendingOutput.splice(0)) {
      this.writeEmitter.fire(chunk);
    }
  }

  close(): void {
    this.opened = false;
  }

  handleInput(data: string): void {
    this.inputHandler?.(data);
  }

  write(chunk: string): void {
    if (this.opened) {
      this.writeEmitter.fire(chunk);
    } else {
      this.pendingOutput.push(chunk);
    }
  }

  closeTerminal(exitCode: number | null): void {
    this.closeEmitter.fire(exitCode === null ? undefined : exitCode);
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

class OwnedRuntimeProcess implements ClaudeOwnedRuntimeProcess {
  private stopped = false;
  private currentExitCode: number | null | undefined;

  constructor(
    private readonly child: SpawnedProcess,
    private readonly pty: OwnedRuntimePseudoterminal,
    readonly externalInstanceId: string,
    readonly sessionId: string,
    readonly terminalName: string,
    readonly terminal: vscode.Terminal,
    private readonly onRemoved: () => void,
    private readonly inputFormat: OwnedRuntimeInputFormat,
    private readonly onOutput?: (stream: OwnedRuntimeStream, chunk: string) => void,
    private readonly onEvent?: (event: Record<string, unknown>) => void,
    private readonly onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ) {
    let structuredBuffer = '';
    let inputBuffer = '';
    this.pid = child.pid;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (this.inputFormat === 'stream-json') {
        structuredBuffer += text;
        const lines = structuredBuffer.split(/\r?\n/);
        structuredBuffer = lines.pop() ?? '';
        for (const line of lines) this.renderStructuredLine(line);
      } else {
        this.forward('stdout', text);
        return;
      }
      this.onOutput?.('stdout', text);
    });
    child.stderr.on('data', (chunk: string | Buffer) => this.forward('stderr', chunk));
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.forward('stderr', `${message}\r\n`);
    });
    child.once('exit', (code, signal) => {
      if (this.inputFormat === 'stream-json' && structuredBuffer.trim()) {
        this.renderStructuredLine(structuredBuffer);
        structuredBuffer = '';
      }
      this.currentExitCode = code;
      this.pty.closeTerminal(code);
      this.onExit?.(code, signal);
      this.onRemoved();
    });
    pty.attachInputHandler((data) => {
      if (this.inputFormat !== 'stream-json') {
        this.write(data);
        return;
      }
      if (data === '\r' || data === '\n') {
        if (inputBuffer.length > 0) {
          this.submit(inputBuffer);
          this.pty.write('\r\n');
          inputBuffer = '';
        }
        return;
      }
      if (data === '\b' || data === '\x7f') {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          this.pty.write('\b \b');
        }
        return;
      }
      inputBuffer += data;
      this.pty.write(data);
    });
  }

  readonly pid: number | undefined;

  get exitCode(): number | null | undefined {
    return this.currentExitCode;
  }

  get alive(): boolean {
    return !this.stopped && this.currentExitCode === undefined;
  }

  write(text: string): void {
    if (!this.alive) throw new Error(`Owned runtime ${this.externalInstanceId} is not running.`);
    this.child.stdin.write(text);
  }

  submit(text: string): void {
    const payload =
      this.inputFormat === 'stream-json'
        ? JSON.stringify({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
          })
        : text;
    this.write(`${payload}\n`);
  }

  focus(): void {
    this.terminal.show(true);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.child.stdin.end();
    if (this.currentExitCode === undefined) {
      this.child.kill();
    }
    this.pty.closeTerminal(this.currentExitCode ?? null);
    this.pty.dispose();
    this.terminal.dispose();
    this.onRemoved();
  }

  private forward(stream: OwnedRuntimeStream, chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.pty.write(text);
    this.onOutput?.(stream, text);
  }

  private renderStructuredLine(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      this.pty.write(`${line}\r\n`);
      return;
    }
    this.onEvent?.(event);
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (type === 'system') {
      this.pty.write('[Claude started]\r\n');
    } else if (type === 'user') {
      this.pty.write(`\r\n> ${extractText(event.message ?? event.content)}\r\n`);
    } else if (type === 'assistant') {
      this.pty.write(`Claude:\r\n${extractText(event.message ?? event.content)}\r\n`);
    } else if (type === 'result') {
      this.pty.write('\r\n[completed]\r\n');
    } else if (type === 'error') {
      this.pty.write('\r\n[error]\r\n');
    }
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return extractText(record.content ?? record.text ?? record.result);
    }
    return '';
  }
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, unknown>;
      return record.type === 'text' ? extractText(record.text) : extractText(record.content);
    })
    .join('');
}

/**
 * Feature-gated process owner for a single Claude runtime.
 *
 * The existing integrated-terminal transport remains the default. Consumers
 * must explicitly register/select `transport: 'owned'`, which keeps legacy
 * terminal behavior unchanged while this process boundary is used.
 */
export class ClaudeOwnedRuntime {
  private readonly processes = new Map<string, OwnedRuntimeProcess>();
  private readonly createTerminal: typeof vscode.window.createTerminal;
  private readonly spawnProcess: typeof spawn;

  constructor(dependencies: ClaudeOwnedRuntimeDependencies = {}) {
    this.createTerminal = dependencies.createTerminal ?? vscode.window.createTerminal;
    this.spawnProcess = dependencies.spawn ?? spawn;
  }

  launch(request: ClaudeOwnedRuntimeLaunchRequest): ClaudeOwnedRuntimeProcess {
    if (this.processes.has(request.externalInstanceId)) {
      throw new Error(`Owned runtime already exists: ${request.externalInstanceId}`);
    }

    const pty = new OwnedRuntimePseudoterminal();
    const child = this.spawnProcess(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(request.command),
      windowsHide: true,
    }) as SpawnedProcess;
    const terminal = this.createTerminal({ name: request.terminalName, pty });
    const ownedProcess = new OwnedRuntimeProcess(
      child,
      pty,
      request.externalInstanceId,
      request.sessionId,
      request.terminalName,
      terminal,
      () => this.processes.delete(request.externalInstanceId),
      request.inputFormat ?? 'text',
      request.onOutput,
      request.onEvent,
      request.onExit,
    );
    this.processes.set(request.externalInstanceId, ownedProcess);
    if (request.showTerminal !== false) terminal.show(true);
    return ownedProcess;
  }

  get(externalInstanceId: string): ClaudeOwnedRuntimeProcess | undefined {
    return this.processes.get(externalInstanceId);
  }

  async stop(externalInstanceId: string): Promise<void> {
    await this.processes.get(externalInstanceId)?.stop();
  }

  async dispose(): Promise<void> {
    for (const process of [...this.processes.values()]) {
      await process.stop();
    }
  }
}

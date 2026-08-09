/**
 * launchCommandRender — shell-aware rendering of the terminal launch command.
 *
 * `terminal.sendText` feeds the string straight to the integrated terminal's
 * shell, so the rendered command must survive that shell when the resolved
 * CLI path contains whitespace (e.g. `C:\Users\John Doe\AppData\Roaming\npm\
 * claude.cmd`). The shell is knowable at render time via `vscode.env.shell`,
 * and each shell needs a different form for a quoted path + args (all
 * verified on Windows 11):
 *
 *   - cmd.exe        `"C:\path with space\claude.cmd" args`   ✅
 *   - PowerShell     `"C:\path with space\claude.cmd" args`   ❌ (string
 *                    expression — parse error)
 *   - PowerShell     `& "C:\path with space\claude.cmd" args` ✅ (call
 *                    operator)
 *   - cmd.exe        `& "..." args`                           ❌ (`&` is the
 *                    command separator)
 *   - POSIX sh       `"/path with space/claude" args`         ✅
 *
 * There is NO single rendering valid in every shell, so the renderer picks
 * the form by the detected shell kind; space-free commands pass through
 * unchanged on every shell (a bare absolute path executes in cmd.exe,
 * PowerShell and sh alike).
 *
 * Args are fixed product tokens (flags + session ids + model ids — see
 * claudeProvider.buildLaunchCommand); they never contain shell
 * metacharacters, so no argument escaping is performed.
 */

/** Integrated-terminal shell families with different command-line grammar. */
export type LaunchShellKind = 'powershell' | 'cmd' | 'posix';

/** Map a terminal shell path to its command-line grammar family. */
export function detectShellKind(
  shellPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): LaunchShellKind {
  if (platform !== 'win32') return 'posix';
  if (!shellPath) return 'powershell';
  const base = shellPath.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  if (base === 'cmd.exe') return 'cmd';
  if (
    base === 'powershell.exe' ||
    base === 'pwsh.exe' ||
    base === 'powershell' ||
    base === 'pwsh'
  ) {
    return 'powershell';
  }
  // Unknown Windows shell: assume the VS Code default (PowerShell).
  return 'powershell';
}

export interface RenderLaunchCommandOptions {
  platform?: NodeJS.Platform;
  shellKind?: LaunchShellKind;
}

/**
 * Render `command args...` as one sendText line. `platform` and `shellKind`
 * are injectable for tests.
 */
export function renderLaunchCommand(
  command: string,
  args: string[],
  opts: RenderLaunchCommandOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  const shellKind = opts.shellKind ?? (platform === 'win32' ? 'powershell' : 'posix');
  const needsQuoting = /[\s"]/.test(command);
  const renderedCommand = needsQuoting ? `"${command}"` : command;
  if (platform === 'win32' && needsQuoting && shellKind === 'powershell') {
    return `& ${renderedCommand} ${args.join(' ')}`;
  }
  return [renderedCommand, ...args].join(' ');
}

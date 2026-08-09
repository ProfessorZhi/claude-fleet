[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkPackage,

    [string]$Repository = "",

    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [string]$CodexCommand = "codex",

    [string]$ConfiguredModel = "",

    [string]$FleetRunId = "",
    [string]$FleetTaskId = "",
    [string]$FleetWorkerId = "",
    [string]$FleetCoordinatorId = "",
    [string]$ParentWorkerId = "",
    [string]$WorkerRole = "",
    [string]$WorktreeId = "",
    [int]$Attempt = 0,

    [string]$CodexArgsJson = "",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CodexArgs
)

# ----------------------------------------------------------------------------
# Codex-with-Metrics Runner
#
# Wraps an arbitrary Codex CLI invocation with `agent-metrics start` and
# `agent-metrics finish`. The wrapper MUST:
#   * Validate WorkPackage and Worktree up front.
#   * Call `agent-metrics start` BEFORE invoking Codex.
#   * Invoke the Codex command with all remaining args verbatim.
#   * Capture the original Codex process exit code.
#   * Always call `agent-metrics finish` (even when Codex fails).
#   * Emit Run ID and Summary path on stdout.
#   * Exit with the original Codex exit code when Codex itself ran.
#   * If `agent-metrics start` failed: DO NOT run Codex and propagate the
#     start failure exit code instead.
#   * If Codex succeeded but finish failed: exit with the finish exit code.
#   * If both Codex and finish failed: exit with the original Codex exit
#     code and write a Finish Failure note to stderr.
#
# This script MUST NOT:
#   * Echo prompt bodies or arguments that may contain secrets.
#   * Modify Codex or Cockpit configuration.
#   * Auto-enable any API gateway.
#   * Mask the original Codex exit code.
# ----------------------------------------------------------------------------

$ErrorActionPreference = "Continue"

function Write-StderrLine([string]$msg) {
    [Console]::Error.WriteLine($msg)
}

function Get-RunIdFromOutput([string]$output) {
    if ([string]::IsNullOrWhiteSpace($output)) { return $null }

    # Prefer the JSON object emitted by `--json`.
    $jsonStart = $output.IndexOf("{")
    $jsonEnd = $output.LastIndexOf("}")
    if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) {
        try {
            $j = $output.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json -ErrorAction Stop
            if ($j.run_id) { return [string]$j.run_id }
        } catch {
            # fall through to text parsing
        }
    }

    # Non-JSON output uses lines starting with 'RUN_ID=' and the PowerShell hint.
    foreach ($line in ($output -split "`r?`n")) {
        if ($line -like "RUN_ID=*") {
            $value = $line.Substring("RUN_ID=".Length).Trim()
            if ($value -match "^[A-Za-z0-9_\-]+$") { return $value }
        }
    }

    foreach ($line in ($output -split "`r?`n")) {
        if ($line -match 'ZUNO_AGENT_RUN_ID\s*=\s*"([A-Za-z0-9_\-]+)"') {
            return $Matches[1]
        }
    }

    return $null
}

function Get-UniqueCodexThreadIdFromJsonl([string]$Path) {
    $threads = @{}
    if (-not (Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)) { return $null }
    try {
        foreach ($rawLine in (Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop)) {
            $line = $rawLine.Trim()
            if (-not $line.StartsWith("{")) { continue }
            try {
                $obj = $line | ConvertFrom-Json -ErrorAction Stop
                $tid = $null
                if ($obj.thread_id) { $tid = [string]$obj.thread_id }
                elseif ($obj.threadId) { $tid = [string]$obj.threadId }
                elseif ($obj.thread -and $obj.thread.id) { $tid = [string]$obj.thread.id }
                if ($tid -and $tid -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
                    $threads[$tid] = $true
                }
            } catch {}
        }
    } catch {}
    if ($threads.Count -eq 1) {
        foreach ($key in $threads.Keys) { return [string]$key }
    }
    return $null
}

# --- 1. Pre-flight validation ------------------------------------------------

if ([string]::IsNullOrWhiteSpace($WorkPackage)) {
    Write-StderrLine "ERROR: -WorkPackage is required and must not be empty."
    exit 4
}

if (-not (Test-Path -LiteralPath $Worktree -ErrorAction SilentlyContinue)) {
    Write-StderrLine "ERROR: -Worktree '$Worktree' does not exist."
    exit 4
}

if (-not [string]::IsNullOrWhiteSpace($CodexArgsJson)) {
    try {
        $parsedCodexArgs = $CodexArgsJson | ConvertFrom-Json -ErrorAction Stop
        if ($parsedCodexArgs -isnot [array]) {
            Write-StderrLine "ERROR: -CodexArgsJson must be a JSON array of strings."
            exit 4
        }
        $CodexArgs = @($parsedCodexArgs | ForEach-Object { [string]$_ })
    } catch {
        Write-StderrLine "ERROR: -CodexArgsJson must be valid JSON."
        exit 4
    }
}

# --- 2. Locate agent-metrics CLI --------------------------------------------

# $PSCommandPath points to this script (.../scripts/run-codex-with-metrics.ps1),
# so the repository root is one level up.
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$amPs1 = Join-Path $repoRoot "agent-metrics.ps1"
$amSrcDir = Join-Path $repoRoot "src"

# Pick the runner. Prefer the repo-local launcher; fall back to the installed
# console script if the launcher is missing. The function takes the args as
# an explicit parameter to avoid scoping bugs with scriptblock `@args`.
$amUseLauncher = Test-Path -LiteralPath $amPs1

function Invoke-Am {
    # Capture the call-site args via $args automatic variable. Naming a
    # parameter as $Args caused binding issues with PowerShell arrays where
    # the parameter ended up empty. $args is the standard PowerShell way to
    # receive un-named positional arguments inside a function.
    [string[]]$AmArgs = @($args)
    $env:PYTHONPATH = $amSrcDir + [IO.Path]::PathSeparator + $env:PYTHONPATH
    if ($amUseLauncher) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $amPs1 @AmArgs
    } else {
        & agent-metrics @AmArgs
    }
    return $LASTEXITCODE
}

# --- 3. start (BEFORE Codex) ------------------------------------------------

$startArgs = @(
    "start"
    "--agent-shell", "Codex"
    "--provider", "OpenAI"
    "--work-package", $WorkPackage
    "--worktree", $Worktree
    "--json"
)

if (-not [string]::IsNullOrWhiteSpace($Repository)) {
    $startArgs += @("--repository", $Repository)
}
if (-not [string]::IsNullOrWhiteSpace($ConfiguredModel)) {
    $startArgs += @("--configured-model", $ConfiguredModel)
}
if (-not [string]::IsNullOrWhiteSpace($FleetRunId)) { $startArgs += @("--fleet-run-id", $FleetRunId) }
if (-not [string]::IsNullOrWhiteSpace($FleetTaskId)) { $startArgs += @("--fleet-task-id", $FleetTaskId) }
if (-not [string]::IsNullOrWhiteSpace($FleetWorkerId)) { $startArgs += @("--fleet-worker-id", $FleetWorkerId) }
if (-not [string]::IsNullOrWhiteSpace($FleetCoordinatorId)) { $startArgs += @("--fleet-coordinator-id", $FleetCoordinatorId) }
if (-not [string]::IsNullOrWhiteSpace($ParentWorkerId)) { $startArgs += @("--parent-worker-id", $ParentWorkerId) }
if (-not [string]::IsNullOrWhiteSpace($WorkerRole)) { $startArgs += @("--worker-role", $WorkerRole) }
if (-not [string]::IsNullOrWhiteSpace($WorktreeId)) { $startArgs += @("--worktree-id", $WorktreeId) }
if ($Attempt -gt 0) { $startArgs += @("--attempt", ([string]$Attempt)) }

$startOutput = ""
$startExit = $null
try {
    # Splat the array explicitly to ensure each element becomes a separate
    # token. Calling Invoke-Am with an array literal can lead to PowerShell
    # binding the array as a single positional argument under some hosts.
    $startOutput = (Invoke-Am @startArgs) | Out-String
    $startExit = $LASTEXITCODE
} catch {
    Write-StderrLine "ERROR: agent-metrics start threw an exception: $($_.Exception.Message)"
    exit 7
}

if ($startExit -ne 0) {
    Write-StderrLine "ERROR: agent-metrics start failed with exit code $startExit. Codex will NOT be invoked."
    if (-not [string]::IsNullOrWhiteSpace($startOutput)) {
        Write-StderrLine $startOutput
    }
    exit $startExit
}

$runId = Get-RunIdFromOutput $startOutput
if (-not $runId) {
    Write-StderrLine "ERROR: agent-metrics start did not return a run_id. Codex will NOT be invoked."
    exit 7
}

Write-Output ("RUN_ID=$runId")

$runPrivateDir = Join-Path $repoRoot ".local/runs/$runId/private"
New-Item -ItemType Directory -Force -Path $runPrivateDir | Out-Null
$codexJsonLog = Join-Path $runPrivateDir "codex-exec.jsonl"

# --- 4. Codex invocation ----------------------------------------------------

$codexExit = 0
$codexInvoked = $false
$codexFailure = $false

try {
    $codexInvoked = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $CodexCommand exec --json @CodexArgs *> $codexJsonLog
    $codexExit = $LASTEXITCODE
    $sw.Stop()
    if ($codexExit -ne 0) {
        $codexFailure = $true
    }
} catch {
    if ($sw) { $sw.Stop() }
    Write-StderrLine "ERROR: Codex invocation threw an exception: $($_.Exception.Message)"
    $codexExit = 1
    $codexFailure = $true
}

# --- 5. finish (always run; never crash the host process) -------------------

$summaryPath = ""
$finishExit = 0
$finishFailed = $false

try {
    $processSeconds = if ($sw) { [Math]::Round($sw.Elapsed.TotalSeconds, 3) } else { $null }
    $codexThreadId = Get-UniqueCodexThreadIdFromJsonl $codexJsonLog
    if ($codexThreadId) {
        $bindArgs = @(
            "bind-session",
            "--run-id", $runId,
            "--agent-session-id", $codexThreadId,
            "--binding-source", "codex_exec_json_thread"
        )
        Invoke-Am @bindArgs | Out-Null
    }
    $finishArgs = @("finish", "--run-id", $runId, "--codex-json-log", $codexJsonLog)
    if ($null -ne $processSeconds) {
        $finishArgs += @("--agent-process-seconds", ([string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0}", $processSeconds)))
    }
    $finishOutput = (Invoke-Am @finishArgs) | Out-String
    $finishExit = $LASTEXITCODE

    if ($finishExit -ne 0) {
        $finishFailed = $true
    }

    # Best-effort summary path extraction. The StorageManager computes its
    # base_dir relative to the agent_metrics package, so the summary lives
    # under <repo_root>/.local/runs/<run_id>/sanitized-summary.json — NOT
    # necessarily under the worktree. Search both candidate roots so the
    # runner remains useful regardless of where the run was started.
    $candidateRoots = @(
        (Join-Path $repoRoot ".local/runs/$runId"),
        (Join-Path $Worktree ".local/runs/$runId")
    )
    foreach ($root in $candidateRoots) {
        $candidate = Join-Path $root "sanitized-summary.json"
        if (Test-Path -LiteralPath $candidate) {
            $summaryPath = $candidate
            break
        }
    }
} catch {
    Write-StderrLine "ERROR: agent-metrics finish threw an exception: $($_.Exception.Message)"
    $finishFailed = $true
    $finishExit = 1
}

try {
    if (Test-Path -LiteralPath $codexJsonLog) {
        Remove-Item -LiteralPath $codexJsonLog -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Best-effort cleanup only. The file is in the run-private directory.
}

if ($summaryPath) {
    Write-Output ("SUMMARY_PATH=$summaryPath")
}
Write-Output ("AGENT_EXIT_CODE=$codexExit")

# --- 6. Final exit code propagation -----------------------------------------
# Priority:
#   * start failed (handled above; never reached here).
#   * Codex succeeded, finish failed: exit with finish exit code.
#   * Codex failed: exit with Codex exit code. Also report finish failure if any.
#   * Both succeeded: exit 0.

if (-not $codexFailure) {
    if ($finishFailed) {
        exit $finishExit
    }
    exit 0
}

# Codex failed
if ($finishFailed) {
    Write-StderrLine "WARNING: agent-metrics finish failed (exit $finishExit); Codex exit code $codexExit takes precedence."
}
exit $codexExit

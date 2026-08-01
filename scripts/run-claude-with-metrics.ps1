[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("DeepSeek", "MiniMax")]
    [string]$Provider,

    [string]$ConfiguredModel = "",

    [string]$ClaudeConfigDir = "",

    [Parameter(Mandatory = $true)]
    [string]$WorkPackage,

    [int]$PRNumber = 0,

    [string]$Repository = "",

    [Parameter(Mandatory = $true)]
    [string]$Worktree,

    [string]$ClaudeCommand = "claude",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Continue"

function Write-StderrLine([string]$msg) {
    [Console]::Error.WriteLine($msg)
}

function Get-RunIdFromOutput([string]$output) {
    $jsonStart = $output.IndexOf("{")
    $jsonEnd = $output.LastIndexOf("}")
    if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) {
        try {
            $j = $output.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json -ErrorAction Stop
            if ($j.run_id) { return [string]$j.run_id }
        } catch {}
    }
    foreach ($line in ($output -split "`r?`n")) {
        if ($line -like "RUN_ID=*") {
            $value = $line.Substring("RUN_ID=".Length).Trim()
            if ($value -match "^[A-Za-z0-9_\-]+$") { return $value }
        }
    }
    return $null
}

if ([string]::IsNullOrWhiteSpace($WorkPackage)) {
    Write-StderrLine "ERROR: -WorkPackage is required."
    exit 4
}
if (-not (Test-Path -LiteralPath $Worktree -ErrorAction SilentlyContinue)) {
    Write-StderrLine "ERROR: -Worktree does not exist."
    exit 4
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$amPs1 = Join-Path $repoRoot "agent-metrics.ps1"
$amSrcDir = Join-Path $repoRoot "src"
$amUseLauncher = Test-Path -LiteralPath $amPs1

function Invoke-Am {
    [string[]]$AmArgs = @($args)
    $env:PYTHONPATH = $amSrcDir + [IO.Path]::PathSeparator + $env:PYTHONPATH
    if ($amUseLauncher) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $amPs1 @AmArgs
    } else {
        & agent-metrics @AmArgs
    }
    return $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($ClaudeConfigDir)) {
    if ($Provider -eq "DeepSeek") {
        $ClaudeConfigDir = Join-Path $HOME ".claude-deepseek"
    } else {
        $ClaudeConfigDir = Join-Path $HOME ".claude-minimax"
    }
}

$oldClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
$env:CLAUDE_CONFIG_DIR = $ClaudeConfigDir

$startArgs = @(
    "start",
    "--agent-shell", "Claude-Code",
    "--provider", $Provider,
    "--work-package", $WorkPackage,
    "--worktree", $Worktree,
    "--json"
)
if ($PRNumber -gt 0) { $startArgs += @("--pr-number", ([string]$PRNumber)) }
if (-not [string]::IsNullOrWhiteSpace($Repository)) { $startArgs += @("--repository", $Repository) }
if (-not [string]::IsNullOrWhiteSpace($ConfiguredModel)) { $startArgs += @("--configured-model", $ConfiguredModel) }

$startOutput = (Invoke-Am @startArgs) | Out-String
$startExit = $LASTEXITCODE
if ($startExit -ne 0) {
    Write-StderrLine "ERROR: agent-metrics start failed with exit code $startExit. Claude will NOT be invoked."
    exit $startExit
}

$runId = Get-RunIdFromOutput $startOutput
if (-not $runId) {
    Write-StderrLine "ERROR: agent-metrics start did not return a run_id. Claude will NOT be invoked."
    exit 7
}
Write-Output ("RUN_ID=$runId")

$claudeExit = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    & $ClaudeCommand @ClaudeArgs
    $claudeExit = $LASTEXITCODE
} catch {
    Write-StderrLine "ERROR: Claude invocation threw an exception: $($_.Exception.Message)"
    $claudeExit = 1
} finally {
    $sw.Stop()
}

$finishExit = 0
$summaryPath = ""
try {
    $finishArgs = @(
        "finish",
        "--run-id", $runId,
        "--agent-process-seconds", ([string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0}", [Math]::Round($sw.Elapsed.TotalSeconds, 3)))
    )
    $finishOutput = (Invoke-Am @finishArgs) | Out-String
    $finishExit = $LASTEXITCODE
    $candidate = Join-Path $repoRoot ".local/runs/$runId/sanitized-summary.json"
    if (Test-Path -LiteralPath $candidate) { $summaryPath = $candidate }
} catch {
    Write-StderrLine "ERROR: agent-metrics finish threw an exception: $($_.Exception.Message)"
    $finishExit = 1
}

if ($summaryPath) { Write-Output ("SUMMARY_PATH=$summaryPath") }
Write-Output ("AGENT_EXIT_CODE=$claudeExit")

$env:CLAUDE_CONFIG_DIR = $oldClaudeConfigDir

if ($claudeExit -ne 0) {
    if ($finishExit -ne 0) {
        Write-StderrLine "WARNING: agent-metrics finish failed (exit $finishExit); Claude exit code $claudeExit takes precedence."
    }
    exit $claudeExit
}
if ($finishExit -ne 0) { exit $finishExit }
exit 0
